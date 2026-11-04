import {
  decrypt,
  signTypedData as signTypedDataUtil,
  TypedMessage,
  SignTypedDataVersion,
  TypedDataV1,
  getEncryptionPublicKey,
  recoverPersonalSignature,
  recoverTypedSignature,
  EthEncryptedData,
} from '@metamask/eth-sig-util';
import { INetwork, INetworkType } from '@sidhujag/sysweb3-network';
import {
  createContractUsingAbi,
  getErc20Abi,
  getErc21Abi,
  getErc55Abi,
} from '@sidhujag/sysweb3-utils';
import { Transaction } from 'ethers/transaction';
import omit from 'lodash/omit';

import {
  BigNumber,
  Contract,
  Deferrable,
  TransactionRequest,
  TransactionResponse,
  Zero,
  formatEther,
  formatUnits,
  isHexString,
  normalizeTransactionRequest,
  normalizeTxValue,
  parseUnits,
  resolveProperties,
  serializeTransaction,
} from '../ethers-v6';
import { getEvmFeeData, parseEvmFeeQuantity } from '../evm-fees';
import { CustomJsonRpcProvider, wrapTransactionResponse } from '../providers';
import {
  IResponseFromSendErcSignedTransaction,
  ISendSignedErcTransactionProps,
  IEthereumTransactions,
  IEvmCancellationOptions,
  IEvmReplacementOptions,
  IEvmSendOptions,
  SimpleTransactionRequest,
  KeyringAccountType,
  accountType,
  IGasParams,
} from '../types';
import {
  deriveEvmAccountFromMnemonic,
  parsePersonalMessage as parseLocalPersonalMessage,
  privateKeyToAccount,
  sendLocalEvmTransaction,
  signDigestHex,
  signPersonalMessage as signLocalPersonalMessage,
} from './evm-local-signer';
import { getAddressDerivationPath } from '../utils/derivation-paths';

import type { LedgerKeyring } from '../ledger';
import type { TrezorKeyring } from '../trezor';
import type { EthereumTransactionEIP1559 } from '@trezor/connect-webextension';

/** Minimal trusted device capabilities used by EVM transaction routing. */
export interface EthereumLedgerSigner {
  evm: Pick<
    LedgerKeyring['evm'],
    'signTypedData' | 'signPersonalMessage' | 'signEVMTransaction'
  >;
  verifyUtxoAddress: LedgerKeyring['verifyUtxoAddress'];
}

export type EthereumTrezorSigner = Pick<
  TrezorKeyring,
  'signTypedData' | 'signMessage' | 'signEthTransaction' | 'verifyUtxoAddress'
>;

const hardwareSignerUnavailable = (hardware: string) =>
  Object.assign(new Error(`${hardware} signer is unavailable in this host`), {
    code: 'HARDWARE_SIGNER_UNAVAILABLE',
  });

const assertHardwareTransactionSender = (
  signedTx: string,
  expectedAddress: string
) => {
  if (
    Transaction.from(signedTx).from?.toLowerCase() !==
    expectedAddress.toLowerCase()
  ) {
    throw Object.assign(
      new Error('Hardware signature does not match the approved account'),
      {
        code: 'HARDWARE_ACCOUNT_MISMATCH',
      }
    );
  }
};

const stripHexPrefix = (value: string) => {
  return value.startsWith('0x') || value.startsWith('0X')
    ? value.slice(2)
    : value;
};

// Connect returns hexadecimal signature fields; normalize their encoding
// without mutating the response or reparsing an already numeric recovery v.
const trezorSignature = (signature: {
  r: string;
  s: string;
  v: string | number;
}) => {
  const { r, s, v } = signature;
  if (![r, s].every((value) => /^(?:0x)?[0-9a-f]{64}$/i.test(value))) {
    throw new Error('Invalid Trezor signature scalar encoding');
  }
  if (typeof v === 'string' && !/^(?:0x)?[0-9a-f]+$/i.test(v)) {
    throw new Error('Invalid Trezor signature recovery value');
  }
  const recovery = typeof v === 'number' ? v : Number.parseInt(v, 16);
  if (!Number.isSafeInteger(recovery) || recovery < 0) {
    throw new Error('Invalid Trezor signature recovery value');
  }
  return {
    r: `0x${stripHexPrefix(r)}`,
    s: `0x${stripHexPrefix(s)}`,
    v: recovery,
  };
};

const normalizeEthersOverrideValue = (value: any) => normalizeTxValue(value);

const nonNegativeFeeQuantity = (value: unknown, label: string): BigNumber =>
  BigNumber.from(parseEvmFeeQuantity(value, label));

const normalizeEthersOverrides = (overrides: Record<string, any>) => {
  const normalized = { ...overrides };
  for (const field of [
    'gasLimit',
    'gasPrice',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
  ]) {
    if (normalized[field] != null) {
      normalized[field] = normalizeEthersOverrideValue(normalized[field]);
    }
  }
  return normalized;
};

/** Bind all replacement input fields to the requested signed transaction. */
const authenticateReplacementOriginal = (
  transaction: TransactionResponse,
  requestedHash: string,
  expectedSender: string,
  chainId: number
): TransactionResponse => {
  const fields = normalizeTransactionRequest(transaction);
  if (fields.hash != null) fields.hash = fields.hash.toLowerCase();
  const type =
    fields.type ??
    (fields.maxFeePerGas != null ? 2 : fields.accessList != null ? 1 : 0);
  if (![0, 1, 2].includes(type)) {
    throw new Error('Unsupported replacement transaction type');
  }
  fields.signature = fields.signature ?? {
    r: fields.r,
    s: fields.s,
    v: fields.v ?? fields.yParity,
  };
  fields.type = type;
  fields.data = fields.data ?? fields.input ?? '0x';
  if (type === 2) delete fields.gasPrice; // Not signed in type 2.
  const original = Transaction.from(fields);
  if (
    !original.signature ||
    original.hash !== requestedHash ||
    original.from?.toLowerCase() !== expectedSender ||
    original.chainId !== BigInt(chainId)
  ) {
    throw new Error('Original transaction is not authenticated');
  }
  // Do not retain mutable RPC fields across subsequent asynchronous work.
  return wrapTransactionResponse({
    ...original.toJSON(),
    hash: original.hash,
    from: original.from,
    gasPrice: original.gasPrice ?? 0,
    maxFeePerGas: original.maxFeePerGas ?? 0,
    maxPriorityFeePerGas: original.maxPriorityFeePerGas ?? 0,
    signature: original.signature,
    blockNumber: transaction.blockNumber,
  });
};

const assertSynchronousOriginalValidation = (
  result: unknown,
  message = 'Original transaction validator must be synchronous'
): void => {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as PromiseLike<unknown>).then === 'function'
  ) {
    // A void callback type also accepts async functions. Decline their pending
    // decision and consume a later rejection without allowing signing to start.
    void Promise.resolve(result).catch(() => undefined);
    throw new Error(message);
  }
};

export class EthereumTransactions<
  TLedger extends EthereumLedgerSigner | undefined = LedgerKeyring,
  TTrezor extends EthereumTrezorSigner | undefined = TrezorKeyring
> implements IEthereumTransactions
{
  private _web3Provider: CustomJsonRpcProvider;
  private _web3ProviderKey?: string;
  public trezorSigner: TTrezor;
  public ledgerSigner: TLedger;
  private getNetwork: () => INetwork;
  private captureSigningContext?: () => () => void;
  private abortController: AbortController;
  private getDecryptedPrivateKey: (
    targetAccount?: IEvmReplacementOptions['targetAccount']
  ) => {
    address: string;
    decryptedPrivateKey: string;
  };

  // Allow manual override of gas parameters when automatic estimation fails
  private gasOverrides: {
    minGasLimit?: BigNumber;
    minPriorityFee?: BigNumber;
    feeMultiplier?: number;
  } = {};

  private getState: () => {
    accounts: {
      HDAccount: accountType;
      Imported: accountType;
      Ledger: accountType;
      Trezor: accountType;
    };
    activeAccountId: number;
    activeAccountType: KeyringAccountType;
    activeNetwork: INetwork;
  };

  constructor(
    getNetwork: () => INetwork,
    getDecryptedPrivateKey: (
      targetAccount?: IEvmReplacementOptions['targetAccount']
    ) => {
      address: string;
      decryptedPrivateKey: string;
    },
    getState: () => {
      accounts: {
        HDAccount: accountType;
        Imported: accountType;
        Ledger: accountType;
        Trezor: accountType;
      };
      activeAccountId: number;
      activeAccountType: KeyringAccountType;
      activeNetwork: INetwork;
    },
    ledgerSigner: TLedger,
    trezorSigner: TTrezor,
    captureSigningContext?: () => () => void
  ) {
    this.getNetwork = getNetwork;
    this.getDecryptedPrivateKey = (targetAccount) => {
      this.assertHardwareSignerAvailable(targetAccount);
      return getDecryptedPrivateKey(targetAccount);
    };
    this.abortController = new AbortController();

    // NOTE: Defer network access until vault state getter is initialized
    // The web3Provider will be created lazily when first accessed via getters

    this.getState = getState;
    this.trezorSigner = trezorSigner;
    this.ledgerSigner = ledgerSigner;
    this.captureSigningContext = captureSigningContext;
  }

  private requireLedgerSigner = (): EthereumLedgerSigner => {
    if (!this.ledgerSigner) throw hardwareSignerUnavailable('Ledger');
    return this.ledgerSigner;
  };

  private requireTrezorSigner = (): EthereumTrezorSigner => {
    if (!this.trezorSigner) throw hardwareSignerUnavailable('Trezor');
    return this.trezorSigner;
  };

  private assertHardwareSignerAvailable = (
    targetAccount?: IEvmReplacementOptions['targetAccount']
  ) => {
    const state = this.getState();
    const type = targetAccount?.type ?? state.activeAccountType;
    const id = targetAccount?.id ?? state.activeAccountId;
    const account = state.accounts[type]?.[id];
    if (type === KeyringAccountType.Ledger || account?.isLedgerWallet)
      this.requireLedgerSigner();
    if (type === KeyringAccountType.Trezor || account?.isTrezorWallet)
      this.requireTrezorSigner();
  };

  private captureEvmSigningContext = () => {
    this.assertHardwareSignerAvailable();
    const { activeAccountType, activeAccountId, accounts, activeNetwork } =
      this.getState();
    const selectedAccount = accounts[activeAccountType]?.[activeAccountId];
    if (!selectedAccount) throw new Error('Active account not found');
    const account = { address: selectedAccount.address };
    const network = { ...activeNetwork };
    const assertSession = this.captureSigningContext?.();
    const provider = this.web3Provider;
    const assertCurrent = () => {
      assertSession?.();
      const current = this.getState();
      const currentAccount =
        current.accounts[current.activeAccountType]?.[current.activeAccountId];
      if (
        current.activeAccountId !== activeAccountId ||
        current.activeAccountType !== activeAccountType ||
        currentAccount?.address?.toLowerCase() !==
          account.address.toLowerCase() ||
        [current.activeNetwork, this.getNetwork()].some(
          (selected) =>
            selected.kind !== network.kind ||
            selected.chainId !== network.chainId ||
            selected.slip44 !== network.slip44 ||
            selected.url !== network.url
        ) ||
        this.web3Provider !== provider
      )
        throw new Error('Wallet signing context changed');
    };
    assertCurrent();
    return {
      activeAccount: account,
      activeAccountType,
      activeAccountId,
      activeNetwork: network,
      provider,
      assertCurrent,
    };
  };

  // Getter that automatically ensures providers are initialized when accessed
  public get web3Provider(): CustomJsonRpcProvider {
    this.ensureProvidersInitialized();
    return this._web3Provider;
  }

  // Helper method to ensure providers are initialized when first needed
  private ensureProvidersInitialized() {
    // Keep provider in sync with current network selection.
    // Hardware-wallet signing (e.g., Trezor) commits to a chainId; if the provider points at a different
    // RPC/network than `activeNetwork`, nodes will reject broadcasts with chain-id mismatch errors.
    try {
      const currentNetwork = this.getNetwork();
      const currentUrl = currentNetwork?.url;
      const currentKey = `${currentNetwork?.chainId ?? 'unknown'}|${
        currentUrl ?? ''
      }`;
      const needsInit =
        !this._web3Provider ||
        !this._web3ProviderKey ||
        (currentUrl && this._web3ProviderKey !== currentKey);
      if (needsInit) {
        this.setWeb3Provider(currentNetwork);
      }
    } catch (error: any) {
      // If vault state not available yet, providers will be initialized later
      // when setWeb3Provider is called explicitly
      console.log(
        '[EthereumTransactions] Deferring provider initialization:',
        error?.message || error
      );
    }
  }

  // Helper method to detect UTXO networks
  private isUtxoNetwork(network: INetwork): boolean {
    // Generic UTXO network detection patterns:
    // 1. URL contains blockbook or trezor (most reliable)
    // 2. Network kind is explicitly set to 'syscoin'
    const hasBlockbookUrl = !!(
      network.url?.includes('blockbook') || network.url?.includes('trezor')
    );
    const hasUtxoKind = (network as any).kind === INetworkType.Syscoin;

    return hasBlockbookUrl || hasUtxoKind;
  }

  signTypedData = async (
    addr: string,
    typedData: TypedDataV1 | TypedMessage<any>,
    version: SignTypedDataVersion
  ) => {
    const { address, decryptedPrivateKey } = this.getDecryptedPrivateKey();
    const { activeAccountType, accounts, activeAccountId } = this.getState();
    const activeAccount = accounts[activeAccountType][activeAccountId];

    // Validate that the derived address matches the active account to prevent race conditions
    if (address.toLowerCase() !== activeAccount.address.toLowerCase()) {
      throw {
        message: `Account state mismatch detected. Expected ${activeAccount.address} but got ${address}. Please try again after account switching completes.`,
      };
    }

    const signTypedDataLocal = () => {
      if (addr.toLowerCase() !== address.toLowerCase())
        throw {
          message: 'Decrypting for wrong address, change activeAccount maybe',
        };

      const privKey = Buffer.from(stripHexPrefix(decryptedPrivateKey), 'hex');
      return signTypedDataUtil({
        privateKey: privKey,
        data: typedData as any,
        version,
      });
    };

    const signTypedDataWithLedger = async () => {
      if (addr.toLowerCase() !== activeAccount.address.toLowerCase())
        throw {
          message: 'Decrypting for wrong address, change activeAccount maybe',
        };
      return await this.requireLedgerSigner().evm.signTypedData({
        version,
        accountIndex: activeAccountId,
        expectedAddress: activeAccount.address,
        data: typedData,
      });
    };

    const signTypedDataWithTrezor = async () => {
      if (addr.toLowerCase() !== activeAccount.address.toLowerCase())
        throw {
          message: 'Decrypting for wrong address, change activeAccount maybe',
        };
      return await this.requireTrezorSigner().signTypedData({
        version,
        address: addr,
        data: typedData,
        index: activeAccountId,
      });
    };

    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await signTypedDataWithTrezor();
      case KeyringAccountType.Ledger:
        return await signTypedDataWithLedger();
      default:
        return signTypedDataLocal();
    }
  };

  // Verify a UTXO address on the connected hardware wallet (Ledger or Trezor)
  // Routes to the appropriate device based on activeAccountType
  verifyUtxoAddress = async (
    accountIndex: number,
    currency: string,
    slip44: number
  ): Promise<string | undefined> => {
    const { activeAccountType } = this.getState();

    switch (activeAccountType) {
      case KeyringAccountType.Ledger:
        return await this.requireLedgerSigner().verifyUtxoAddress(
          accountIndex,
          currency,
          slip44
        );
      case KeyringAccountType.Trezor:
        return await this.requireTrezorSigner().verifyUtxoAddress(
          accountIndex,
          currency,
          slip44
        );
      default:
        throw new Error(
          'verifyUtxoAddress is only available for hardware wallet accounts'
        );
    }
  };

  verifyTypedSignature = (
    data: TypedDataV1 | TypedMessage<any>,
    signature: string,
    version: SignTypedDataVersion
  ) => {
    try {
      return recoverTypedSignature({ data: data as any, signature, version });
    } catch (error) {
      throw error;
    }
  };

  ethSign = async (params: string[]) => {
    const { address, decryptedPrivateKey } = this.getDecryptedPrivateKey();
    const { accounts, activeAccountId, activeAccountType, activeNetwork } =
      this.getState();
    const activeAccount = accounts[activeAccountType][activeAccountId];

    // Validate that the derived address matches the active account to prevent race conditions
    if (address.toLowerCase() !== activeAccount.address.toLowerCase()) {
      throw {
        message: `Account state mismatch detected. Expected ${activeAccount.address} but got ${address}. Please try again after account switching completes.`,
      };
    }

    let msg = '';
    //Comparisions do not need to care for checksum address
    if (params[0].toLowerCase() === address.toLowerCase()) {
      msg = stripHexPrefix(params[1]);
    } else if (params[1].toLowerCase() === address.toLowerCase()) {
      msg = stripHexPrefix(params[0]);
    } else {
      throw new Error('Signing for wrong address');
    }

    const sign = () => {
      try {
        // Validate and prepare the message for eth_sign
        let msgHash: Buffer;

        // Check if message is a valid 32-byte hex string
        if (msg.length === 64 && /^[0-9a-fA-F]+$/.test(msg)) {
          // Message is already a 32-byte hex string
          msgHash = Buffer.from(msg, 'hex');
        } else {
          // Message is not a proper hash - provide helpful error
          throw new Error(
            `Expected message to be an Uint8Array with length 32. ` +
              `Got message of length ${msg.length}: "${msg.substring(0, 50)}${
                msg.length > 50 ? '...' : ''
              }". ` +
              `For signing arbitrary text, use personal_sign instead of eth_sign.`
          );
        }

        return signDigestHex(msgHash, decryptedPrivateKey);
      } catch (error) {
        throw error;
      }
    };

    const signWithLedger = async () => {
      try {
        const response =
          await this.requireLedgerSigner().evm.signPersonalMessage({
            accountIndex: activeAccountId,
            expectedAddress: activeAccount.address,
            message: msg,
          });
        return response;
      } catch (error) {
        throw error;
      }
    };

    const signWithTrezor = async () => {
      try {
        // For EVM networks, Trezor expects 'eth' regardless of the network's currency
        const trezorCoin =
          activeNetwork.slip44 === 60 ? 'eth' : activeNetwork.currency;
        const response: any = await this.requireTrezorSigner().signMessage({
          coin: trezorCoin,
          address: activeAccount.address,
          index: activeAccountId,
          message: msg,
          slip44: activeNetwork.slip44,
        });
        return response.signature as string;
      } catch (error) {
        throw error;
      }
    };

    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await signWithTrezor();
      case KeyringAccountType.Ledger:
        return await signWithLedger();
      default:
        return sign();
    }
  };

  signPersonalMessage = async (params: string[]) => {
    const { address, decryptedPrivateKey } = this.getDecryptedPrivateKey();
    const { accounts, activeAccountId, activeAccountType, activeNetwork } =
      this.getState();
    const activeAccount = accounts[activeAccountType][activeAccountId];

    // Validate that the derived address matches the active account to prevent race conditions
    if (address.toLowerCase() !== activeAccount.address.toLowerCase()) {
      throw {
        message: `Account state mismatch detected. Expected ${activeAccount.address} but got ${address}. Please try again after account switching completes.`,
      };
    }

    let msg = '';

    if (params[0].toLowerCase() === address.toLowerCase()) {
      msg = params[1];
    } else if (params[1].toLowerCase() === address.toLowerCase()) {
      msg = params[0];
    } else {
      throw new Error('Signing for wrong address');
    }

    const signPersonalMessageWithDefaultWallet = () => {
      try {
        // Handle both hex-encoded and plain text messages for personal_sign
        let message: Buffer;
        if (msg.startsWith('0x')) {
          const rawHex = stripHexPrefix(msg);
          if (rawHex.length % 2 === 0 && isHexString(msg)) {
            // Message is valid hex-encoded bytes.
            message = Buffer.from(rawHex, 'hex');
          } else {
            // Malformed 0x-prefixed strings are literal text, not lossy hex.
            message = Buffer.from(msg, 'utf8');
          }
        } else {
          // Message is plain text
          message = Buffer.from(msg, 'utf8');
        }

        return signLocalPersonalMessage(message, decryptedPrivateKey);
      } catch (error) {
        throw error;
      }
    };

    const signPersonalMessageWithLedger = async () => {
      try {
        // Handle both hex-encoded and plain text messages for personal_sign
        let messageForLedger: string;
        if (msg.startsWith('0x')) {
          // Message is hex-encoded, remove 0x prefix
          messageForLedger = msg.replace('0x', '');
        } else {
          // Message is plain text, convert to hex
          messageForLedger = Buffer.from(msg, 'utf8').toString('hex');
        }

        const response =
          await this.requireLedgerSigner().evm.signPersonalMessage({
            accountIndex: activeAccountId,
            expectedAddress: activeAccount.address,
            message: messageForLedger,
          });
        return response;
      } catch (error) {
        throw error;
      }
    };

    const signPersonalMessageWithTrezor = async () => {
      try {
        // Handle both hex-encoded and plain text messages for personal_sign
        let messageForTrezor: string;
        if (msg.startsWith('0x')) {
          // Message is hex-encoded, keep as is
          messageForTrezor = msg;
        } else {
          // Message is plain text, convert to hex with 0x prefix
          messageForTrezor = '0x' + Buffer.from(msg, 'utf8').toString('hex');
        }

        // For EVM networks, Trezor expects 'eth' regardless of the network's currency
        const trezorCoin =
          activeNetwork.slip44 === 60 ? 'eth' : activeNetwork.currency;
        const response: any = await this.requireTrezorSigner().signMessage({
          coin: trezorCoin,
          address: activeAccount.address,
          index: activeAccountId,
          message: messageForTrezor,
          slip44: activeNetwork.slip44,
        });
        return response.signature as string;
      } catch (error) {
        throw error;
      }
    };

    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await signPersonalMessageWithTrezor();
      case KeyringAccountType.Ledger:
        return await signPersonalMessageWithLedger();
      default:
        return signPersonalMessageWithDefaultWallet();
    }
  };

  parsePersonalMessage = (hexMsg: string) => {
    try {
      return parseLocalPersonalMessage(hexMsg);
    } catch (error) {
      throw error;
    }
  };

  verifyPersonalMessage = (message: string, sign: string) => {
    try {
      const msgParams = {
        data: message,
        signature: sign,
      };
      return recoverPersonalSignature(msgParams as any);
    } catch (error) {
      throw error;
    }
  };

  getEncryptedPubKey = () => {
    const { activeAccountType } = this.getState();

    // Hardware wallets don't support encryption public key generation
    if (
      activeAccountType === KeyringAccountType.Trezor ||
      activeAccountType === KeyringAccountType.Ledger
    ) {
      throw new Error(
        'Hardware wallets do not support eth_getEncryptionPublicKey'
      );
    }

    const { decryptedPrivateKey } = this.getDecryptedPrivateKey();

    try {
      return getEncryptionPublicKey(stripHexPrefix(decryptedPrivateKey));
    } catch (error) {
      throw error;
    }
  };

  // eth_decryptMessage
  decryptMessage = (msgParams: string[]) => {
    const { activeAccountType } = this.getState();

    // Hardware wallets don't support message decryption
    if (
      activeAccountType === KeyringAccountType.Trezor ||
      activeAccountType === KeyringAccountType.Ledger
    ) {
      throw new Error('Hardware wallets do not support eth_decrypt');
    }

    const { address, decryptedPrivateKey } = this.getDecryptedPrivateKey();

    let encryptedData = '';

    if (msgParams[0].toLowerCase() === address.toLowerCase()) {
      encryptedData = msgParams[1];
    } else if (msgParams[1].toLowerCase() === address.toLowerCase()) {
      encryptedData = msgParams[0];
    } else {
      throw new Error('Decrypting for wrong receiver');
    }
    encryptedData = stripHexPrefix(encryptedData);

    try {
      const buff = Buffer.from(encryptedData, 'hex');
      const cleanData: EthEncryptedData = JSON.parse(buff.toString('utf8'));
      const sig = decrypt({
        encryptedData: cleanData,
        privateKey: stripHexPrefix(decryptedPrivateKey),
      });
      return sig;
    } catch (error) {
      throw error;
    }
  };

  toBigNumber = (aBigNumberish: string | number) =>
    BigNumber.from(String(aBigNumberish));

  private toHex0x = (value: any, fieldName: string): string => {
    if (value === undefined || value === null) return '0x0';
    if (typeof value === 'string') {
      const v = value.trim();
      if (v === '') return '0x0';
      if (v.startsWith('0x')) return v;
      return BigNumber.from(v).toHexString();
    }
    if (typeof value === 'number') return BigNumber.from(value).toHexString();
    if (BigNumber.isBigNumber(value)) return value.toHexString();
    const maybeHex = (value as any)?._hex ?? (value as any)?.hex ?? value;
    try {
      return BigNumber.from(maybeHex).toHexString();
    } catch (_e) {
      throw new Error(
        `Invalid numeric field "${fieldName}" for EVM tx: ${String(value)}`
      );
    }
  };

  private resolveEvmFeeParams = async (
    {
      gasPrice,
      isLegacy = false,
      maxFeePerGas,
      maxPriorityFeePerGas,
    }: {
      gasPrice?: any;
      isLegacy?: boolean;
      maxFeePerGas?: any;
      maxPriorityFeePerGas?: any;
    },
    provider = this.web3Provider
  ) => {
    if (isLegacy) {
      return {
        gasPrice: gasPrice || (await provider.getGasPrice()),
        isLegacy: true,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      };
    }

    if (!maxFeePerGas || maxPriorityFeePerGas == null) {
      const feeData = await provider.getFeeData();
      maxFeePerGas = maxFeePerGas || feeData.maxFeePerGas || feeData.gasPrice;
      maxPriorityFeePerGas =
        maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas;

      if (!maxFeePerGas || maxPriorityFeePerGas == null) {
        return {
          gasPrice: feeData.gasPrice || (await provider.getGasPrice()),
          isLegacy: true,
          maxFeePerGas: undefined,
          maxPriorityFeePerGas: undefined,
        };
      }
    }

    return {
      gasPrice: undefined,
      isLegacy: false,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  };

  getData = ({
    contractAddress,
    receivingAddress,
    value,
  }: {
    contractAddress: string;
    receivingAddress: string;
    value: any;
  }) => {
    const abi = getErc20Abi() as any;
    try {
      const contract = createContractUsingAbi(
        abi,
        contractAddress,
        this.web3Provider
      );
      const data = contract.interface.encodeFunctionData('transfer', [
        receivingAddress,
        value,
      ]);

      return data;
    } catch (error) {
      throw error;
    }
  };

  getFeeDataWithDynamicMaxPriorityFeePerGas = async (
    provider = this.web3Provider
  ) => {
    const fee = await getEvmFeeData(provider, {
      signal: this.abortController.signal,
      minPriorityFee: this.gasOverrides.minPriorityFee,
      feeMultiplier: this.gasOverrides.feeMultiplier,
    });
    return {
      gasPrice: BigNumber.from(fee.gasPrice),
      ...(fee.baseFeePerGas === undefined
        ? {}
        : {
            baseFeePerGas: BigNumber.from(fee.baseFeePerGas),
          }),
      maxFeePerGas: BigNumber.from(fee.maxFeePerGas),
      maxPriorityFeePerGas: BigNumber.from(fee.maxPriorityFeePerGas),
    };
  };
  calculateNewGasValues = (
    oldTxsParams: IGasParams,
    isForCancel: boolean,
    isLegacy: boolean
  ): IGasParams => {
    const newGasValues: IGasParams = {
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
      gasPrice: undefined,
      gasLimit: undefined,
    };

    const { maxFeePerGas, maxPriorityFeePerGas, gasLimit, gasPrice } =
      oldTxsParams;

    const calculateAndConvertNewValue = (feeValue: number) => {
      // Apply multiplier for replacement transaction (cancel or speedup)
      const newValue = feeValue * multiplierToUse;

      const calculateValue = String(newValue);

      const convertValueToHex =
        '0x' + parseInt(calculateValue, 10).toString(16);

      return BigNumber.from(convertValueToHex);
    };

    const maxFeePerGasToNumber = maxFeePerGas?.toNumber();
    const maxPriorityFeePerGasToNumber = maxPriorityFeePerGas?.toNumber();
    const gasLimitToNumber = gasLimit?.toNumber();
    const gasPriceToNumber = gasPrice?.toNumber();

    const multiplierToUse = 1.2; //The same calculation we used in the edit fee modal, always using the 0.2 multiplier

    if (!isLegacy) {
      // For EIP-1559 transactions
      newGasValues.maxFeePerGas = calculateAndConvertNewValue(
        maxFeePerGasToNumber as number
      );
      newGasValues.maxPriorityFeePerGas = calculateAndConvertNewValue(
        maxPriorityFeePerGasToNumber as number
      );
    }

    if (isLegacy) {
      newGasValues.gasPrice = calculateAndConvertNewValue(
        gasPriceToNumber as number
      );
    }

    if (isForCancel) {
      const DEFAULT_GAS_LIMIT_VALUE = '42000';

      const convertToHex =
        '0x' + parseInt(DEFAULT_GAS_LIMIT_VALUE, 10).toString(16);

      newGasValues.gasLimit = BigNumber.from(convertToHex);
    }

    if (!isForCancel) {
      newGasValues.gasLimit = calculateAndConvertNewValue(
        gasLimitToNumber as number
      );
    }

    return newGasValues;
  };
  cancelSentTransaction = async (
    txHash: string,
    isLegacy: boolean | undefined,
    fallbackNonce: number | undefined,
    options: IEvmCancellationOptions
  ): Promise<{
    error?: boolean;
    isCanceled: boolean;
    maximumFee?: string;
    transaction?: TransactionResponse;
  }> => {
    // Cancellation is a signing operation too. Keep its account, network and
    // provider fixed across RPC requests and hardware approval.
    if (typeof options?.assertCurrentContext !== 'function') {
      throw new Error('Cancellation context required');
    }
    if (typeof options.validateOriginal !== 'function') {
      throw new Error('Cancellation original validator required');
    }
    if (
      fallbackNonce !== undefined &&
      (!Number.isSafeInteger(fallbackNonce) || fallbackNonce < 0)
    ) {
      throw new Error('Invalid cancellation fallback nonce');
    }
    const previewOnly = options.previewOnly === true;
    const approvedMaximumFee = options.approvedMaximumFee;
    if (
      !previewOnly &&
      (typeof approvedMaximumFee !== 'string' ||
        !/^(0|[1-9][0-9]{0,77})$/.test(approvedMaximumFee))
    ) {
      throw new Error('Cancellation fee approval required');
    }
    const assertHostContext = options.assertCurrentContext;
    assertHostContext();
    const state = this.getState();
    const selectedType = state.activeAccountType;
    const selectedId = state.activeAccountId;
    const selectedAddress =
      state.accounts?.[selectedType]?.[selectedId]?.address;
    const activeAccountType = options.targetAccount?.type ?? selectedType;
    const activeAccountId = options.targetAccount?.id ?? selectedId;
    const targetAccount = options.targetAccount
      ? { type: activeAccountType, id: activeAccountId }
      : undefined;
    const activeAccount = {
      ...state.accounts?.[activeAccountType]?.[activeAccountId],
    };
    const activeNetwork = { ...state.activeNetwork };
    if (
      !selectedAddress ||
      !activeAccount.address ||
      (targetAccount && activeAccountType === KeyringAccountType.SmartAccount)
    ) {
      throw new Error('Cancellation signing account is unavailable');
    }
    if (!previewOnly) this.assertHardwareSignerAvailable(targetAccount);
    const provider = this.web3Provider;
    const assertSession = this.captureSigningContext?.();
    const assertKeyringContext = () => {
      assertSession?.();
      const current = this.getState();
      if (
        current.activeAccountType !== selectedType ||
        current.activeAccountId !== selectedId ||
        current.accounts?.[selectedType]?.[
          selectedId
        ]?.address?.toLowerCase() !== selectedAddress.toLowerCase() ||
        current.accounts?.[activeAccountType]?.[
          activeAccountId
        ]?.address?.toLowerCase() !== activeAccount.address.toLowerCase() ||
        [current.activeNetwork, this.getNetwork()].some(
          (selected) =>
            selected.kind !== activeNetwork.kind ||
            selected.chainId !== activeNetwork.chainId ||
            selected.slip44 !== activeNetwork.slip44 ||
            selected.url !== activeNetwork.url
        ) ||
        this.web3Provider !== provider
      ) {
        throw new Error('Wallet signing context changed');
      }
    };
    const assertCurrent = () => {
      assertHostContext();
      assertKeyringContext();
    };
    assertCurrent();
    const currentEip1559Fees = async () => {
      const feeData = await this.getFeeDataWithDynamicMaxPriorityFeePerGas(
        provider
      );
      assertCurrent();
      const maxFeePerGas = nonNegativeFeeQuantity(
        feeData.maxFeePerGas,
        'cancellation maximum fee'
      );
      const maxPriorityFeePerGas = nonNegativeFeeQuantity(
        feeData.maxPriorityFeePerGas,
        'cancellation priority fee'
      );
      if (maxFeePerGas.isZero() || maxPriorityFeePerGas.gt(maxFeePerGas)) {
        throw new Error('Invalid cancellation EIP-1559 fees');
      }
      return { maxFeePerGas, maxPriorityFeePerGas };
    };

    const response = await provider.getTransaction(txHash);
    assertCurrent();
    if (response?.blockNumber != null || response?.blockHash != null) {
      throw new Error('Original transaction is already mined');
    }
    let tx: Deferrable<TransactionResponse> | null =
      response === null
        ? null
        : authenticateReplacementOriginal(
            response,
            txHash.toLowerCase(),
            activeAccount.address.toLowerCase(),
            activeNetwork.chainId
          );
    assertSynchronousOriginalValidation(
      options.validateOriginal(tx as TransactionResponse | null)
    );
    assertCurrent();

    // If transaction not found, create a minimal tx object with current gas prices
    // This handles cases where tx with 0 gas never made it to the mempool
    if (!tx && fallbackNonce !== undefined) {
      // Fetch current network gas prices for the cancellation
      if (isLegacy) {
        const currentGasPrice = nonNegativeFeeQuantity(
          await provider.getGasPrice(),
          'cancellation gas price'
        );
        assertCurrent();
        tx = {
          from: activeAccount.address,
          to: activeAccount.address,
          value: Zero,
          nonce: fallbackNonce,
          gasPrice: currentGasPrice,
          gasLimit: BigNumber.from(42000),
          data: '0x',
        } as Deferrable<TransactionResponse>;
      } else {
        const feeData = await currentEip1559Fees();
        tx = {
          from: activeAccount.address,
          to: activeAccount.address,
          value: Zero,
          nonce: fallbackNonce,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
          gasLimit: BigNumber.from(42000),
          data: '0x',
        } as Deferrable<TransactionResponse>;
      }
    } else if (!tx) {
      // No fallback nonce provided and tx not found
      return {
        isCanceled: false,
        error: true,
      };
    }

    // If the original tx has 0 or very low gas price, fetch current network gas prices
    const oldTxsGasValues: IGasParams = {
      maxFeePerGas: tx.maxFeePerGas as BigNumber,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas as BigNumber,
      gasPrice: tx.gasPrice as BigNumber,
      gasLimit: tx.gasLimit as BigNumber,
    };

    if (isLegacy) {
      const currentGasPrice = nonNegativeFeeQuantity(
        await provider.getGasPrice(),
        'cancellation gas price'
      );
      assertCurrent();
      if (oldTxsGasValues.gasPrice != null) {
        oldTxsGasValues.gasPrice = nonNegativeFeeQuantity(
          oldTxsGasValues.gasPrice,
          'original gas price'
        );
      }

      if (
        !oldTxsGasValues.gasPrice ||
        oldTxsGasValues.gasPrice.isZero() ||
        oldTxsGasValues.gasPrice.lt(currentGasPrice)
      ) {
        oldTxsGasValues.gasPrice = currentGasPrice;
      }
    } else {
      const {
        maxFeePerGas: currentMaxFeePerGas,
        maxPriorityFeePerGas: currentMaxPriorityFeePerGas,
      } = await currentEip1559Fees();
      if (oldTxsGasValues.maxFeePerGas != null) {
        oldTxsGasValues.maxFeePerGas = nonNegativeFeeQuantity(
          oldTxsGasValues.maxFeePerGas,
          'original maximum fee'
        );
      }
      if (oldTxsGasValues.maxPriorityFeePerGas != null) {
        oldTxsGasValues.maxPriorityFeePerGas = nonNegativeFeeQuantity(
          oldTxsGasValues.maxPriorityFeePerGas,
          'original priority fee'
        );
      }

      if (
        !oldTxsGasValues.maxFeePerGas ||
        oldTxsGasValues.maxFeePerGas.isZero() ||
        oldTxsGasValues.maxFeePerGas.lt(currentMaxFeePerGas)
      ) {
        oldTxsGasValues.maxFeePerGas = currentMaxFeePerGas;
      }

      if (
        !oldTxsGasValues.maxPriorityFeePerGas ||
        oldTxsGasValues.maxPriorityFeePerGas.lt(currentMaxPriorityFeePerGas)
      ) {
        oldTxsGasValues.maxPriorityFeePerGas = currentMaxPriorityFeePerGas;
      }

      if (
        oldTxsGasValues.maxFeePerGas.lt(oldTxsGasValues.maxPriorityFeePerGas)
      ) {
        oldTxsGasValues.maxFeePerGas = oldTxsGasValues.maxPriorityFeePerGas;
      }
    }

    // Preserve the existing 20% replacement policy with exact integer math.
    // Nodes also require a strictly larger cap and tip than an old pending
    // transaction; zero/small fees therefore need at least a one-wei bump.
    // This is a replacement bump, not a fabricated network priority floor.
    const bumpCancelFee = (fee: BigNumber) => {
      const percentageBump = fee.mul(120).div(100);
      const strictBump = fee.add(1);
      return percentageBump.gt(strictBump) ? percentageBump : strictBump;
    };
    const newGasValues: IGasParams = {
      gasLimit: BigNumber.from(42000),
      ...(isLegacy
        ? { gasPrice: bumpCancelFee(oldTxsGasValues.gasPrice!) }
        : {
            maxFeePerGas: bumpCancelFee(oldTxsGasValues.maxFeePerGas!),
            maxPriorityFeePerGas: bumpCancelFee(
              oldTxsGasValues.maxPriorityFeePerGas!
            ),
          }),
    };

    const maximumFee = newGasValues.gasLimit!.mul(
      isLegacy ? newGasValues.gasPrice! : newGasValues.maxFeePerGas!
    );
    assertCurrent();
    if (previewOnly)
      return {
        isCanceled: false,
        error: false,
        maximumFee: maximumFee.toString(),
      };
    if (maximumFee.gt(approvedMaximumFee!))
      throw new Error('Cancellation fee exceeds approval');
    const assertApprovedEnvelope = (transaction: TransactionRequest) => {
      const gas = nonNegativeFeeQuantity(
        transaction.gasLimit,
        'cancellation gas limit'
      );
      const cap = nonNegativeFeeQuantity(
        isLegacy ? transaction.gasPrice : transaction.maxFeePerGas,
        'cancellation maximum fee'
      );
      if (!gas.eq(42000) || gas.mul(cap).gt(approvedMaximumFee!))
        throw new Error('Cancellation fee exceeds approval');
    };

    // Base cancel transaction parameters (same for all wallet types)
    const baseCancelTx = {
      nonce: tx.nonce,
      from: activeAccount.address,
      to: activeAccount.address,
      value: Zero,
      gasLimit: newGasValues.gasLimit,
    };

    const changedTxToCancel: Deferrable<TransactionRequest> = isLegacy
      ? {
          ...baseCancelTx,
          gasPrice: newGasValues.gasPrice,
          type: 0, // Force Type 0 for legacy cancel
        }
      : {
          ...baseCancelTx,
          maxFeePerGas: newGasValues.maxFeePerGas,
          maxPriorityFeePerGas: newGasValues.maxPriorityFeePerGas,
          // Don't set type - let ethers auto-detect
        };

    // Ledger cancel handler
    const cancelWithLedger = async () => {
      try {
        assertCurrent();
        const resolvedParams = await resolveProperties(
          omit(changedTxToCancel, 'from')
        );
        assertCurrent();
        const formatParams = {
          ...resolvedParams,
          nonce: resolvedParams.nonce
            ? Number(resolvedParams.nonce.toString())
            : undefined,
        };
        const txFormattedForEthers = isLegacy
          ? {
              ...formatParams,
              chainId: activeNetwork.chainId,
              type: 0, // Need explicit type for hardware wallet serialization
            }
          : {
              ...formatParams,
              chainId: activeNetwork.chainId,
              type: 2, // Need explicit type for hardware wallet serialization
            };

        assertApprovedEnvelope(txFormattedForEthers);
        const rawTx = serializeTransaction(txFormattedForEthers);
        const signature =
          await this.requireLedgerSigner().evm.signEVMTransaction({
            rawTx: rawTx.replace('0x', ''),
            accountIndex: activeAccountId,
            expectedAddress: activeAccount.address,
          });
        assertCurrent();

        const formattedSignature = {
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: parseInt(signature.v, 16),
        };

        if (signature) {
          const signedTx = serializeTransaction(
            txFormattedForEthers,
            formattedSignature
          );
          assertCurrent();
          assertHardwareTransactionSender(signedTx, activeAccount.address);
          const transactionResponse = await provider.sendTransaction(signedTx);

          return {
            isCanceled: true,
            transaction: transactionResponse,
          };
        } else {
          return {
            isCanceled: false,
            error: true,
          };
        }
      } catch (error) {
        return {
          isCanceled: false,
          error: true,
        };
      }
    };

    // Trezor cancel handler
    const cancelWithTrezor = async () => {
      try {
        assertCurrent();
        const trezorCoin =
          activeNetwork.slip44 === 60 ? 'eth' : activeNetwork.currency;
        const formattedTx = await resolveProperties(
          omit(changedTxToCancel, 'from')
        );
        assertCurrent();

        const txFormattedForTrezor: any = {
          ...formattedTx,
          gasLimit:
            typeof formattedTx.gasLimit === 'string'
              ? formattedTx.gasLimit
              : this.toHex0x(formattedTx.gasLimit, 'gasLimit'),
          value: '0x0',
          nonce: this.toHex0x(formattedTx.nonce, 'nonce'),
          chainId: activeNetwork.chainId,
          type: isLegacy ? 0 : 2, // Need explicit type for hardware wallet serialization
        };

        if (isLegacy) {
          txFormattedForTrezor.gasPrice =
            typeof formattedTx.gasPrice === 'string'
              ? formattedTx.gasPrice
              : this.toHex0x(formattedTx.gasPrice, 'gasPrice');
        } else {
          txFormattedForTrezor.maxFeePerGas =
            typeof (formattedTx as any).maxFeePerGas === 'string'
              ? (formattedTx as any).maxFeePerGas
              : this.toHex0x((formattedTx as any).maxFeePerGas, 'maxFeePerGas');
          txFormattedForTrezor.maxPriorityFeePerGas =
            typeof (formattedTx as any).maxPriorityFeePerGas === 'string'
              ? (formattedTx as any).maxPriorityFeePerGas
              : this.toHex0x(
                  (formattedTx as any).maxPriorityFeePerGas,
                  'maxPriorityFeePerGas'
                );
        }

        assertApprovedEnvelope(txFormattedForTrezor);
        const signature = await this.requireTrezorSigner().signEthTransaction({
          coin: trezorCoin,
          tx: txFormattedForTrezor,
          index: activeAccountId.toString(),
          slip44: activeNetwork.slip44,
        });
        assertCurrent();

        if (signature.success) {
          const signedTx = serializeTransaction(
            txFormattedForTrezor,
            trezorSignature(signature.payload)
          );
          assertCurrent();
          assertHardwareTransactionSender(signedTx, activeAccount.address);
          const transactionResponse = await provider.sendTransaction(signedTx);

          return {
            isCanceled: true,
            transaction: transactionResponse,
          };
        } else {
          return {
            isCanceled: false,
            error: true,
          };
        }
      } catch (error) {
        return {
          isCanceled: false,
          error: true,
        };
      }
    };

    // Regular wallet cancel handler
    const cancelWithPrivateKey = async () => {
      try {
        assertCurrent();
        const { address, decryptedPrivateKey } =
          this.getDecryptedPrivateKey(targetAccount);
        if (address?.toLowerCase() !== activeAccount.address.toLowerCase()) {
          throw new Error('Wallet signing context changed');
        }
        const transactionResponse = await sendLocalEvmTransaction(
          provider,
          decryptedPrivateKey,
          changedTxToCancel,
          assertCurrent,
          assertCurrent,
          assertApprovedEnvelope
        );

        if (transactionResponse) {
          return {
            isCanceled: true,
            transaction: transactionResponse,
          };
        } else {
          return {
            isCanceled: false,
          };
        }
      } catch (error) {
        return {
          isCanceled: false,
          error: true,
        };
      }
    };

    // Route based on account type
    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await cancelWithTrezor();
      case KeyringAccountType.Ledger:
        return await cancelWithLedger();
      default:
        return await cancelWithPrivateKey();
    }
  };
  //TODO: This function needs to be refactored
  sendFormattedTransaction = async (
    params: SimpleTransactionRequest,
    isLegacy?: boolean,
    options?: IEvmSendOptions
  ) => {
    let broadcastAttempted = false;
    try {
      if (
        options !== undefined &&
        (!options || typeof options !== 'object' || Array.isArray(options))
      )
        throw new Error('Invalid transaction context options');
      // Capture once; later caller mutations cannot replace this invocation's
      // admission decision while chain checks or device approval are pending.
      const assertHostCurrent = options?.assertCurrent;
      if (
        assertHostCurrent !== undefined &&
        typeof assertHostCurrent !== 'function'
      )
        throw new Error('Invalid transaction context guard');
      return await this.sendFormattedTransactionInternal(
        params,
        isLegacy,
        () => {
          broadcastAttempted = true;
        },
        assertHostCurrent
      );
    } catch (error) {
      // A broadcast transport error may mean the node accepted the signed
      // transaction. Derive this marker from this invocation, never RPC data.
      const submissionError = Object.assign(
        new Error(error instanceof Error ? error.message : String(error)),
        error,
        { transactionNotBroadcast: !broadcastAttempted }
      );
      if (error instanceof Error) {
        submissionError.name = error.name;
        submissionError.stack = error.stack;
      }
      throw submissionError;
    }
  };

  private sendFormattedTransactionInternal = async (
    params: SimpleTransactionRequest,
    isLegacy: boolean | undefined,
    beforeBroadcast: () => void,
    assertHostCurrent?: () => void
  ) => {
    // Hardware approval may outlive the selected account, network or unlocked
    // session. Keep immutable identities and one provider for this invocation.
    const {
      activeAccount,
      activeAccountType,
      activeAccountId,
      activeNetwork,
      provider,
      assertCurrent: assertKeyringCurrent,
    } = this.captureEvmSigningContext();
    const assertCurrent = () => {
      const result: unknown = assertHostCurrent?.();
      if (result !== undefined) {
        assertSynchronousOriginalValidation(
          result,
          'Transaction context guard must be synchronous'
        );
        throw new Error('Transaction context guard must return undefined');
      }
      assertKeyringCurrent();
    };
    const assertBeforeBroadcast = () => {
      assertCurrent();
      beforeBroadcast();
    };
    assertCurrent();

    const explicitEip1559 =
      params.type != null && BigNumber.from(params.type).eq(2);
    const requestedEip1559 =
      explicitEip1559 ||
      params.maxFeePerGas != null ||
      params.maxPriorityFeePerGas != null;
    if (isLegacy && requestedEip1559)
      throw new Error('EIP-1559 fees conflict with legacy pricing');
    const validateEip1559Fees = () => {
      const maximum = nonNegativeFeeQuantity(
        params.maxFeePerGas,
        'maximum fee'
      );
      const priority = nonNegativeFeeQuantity(
        params.maxPriorityFeePerGas,
        'priority fee'
      );
      if (maximum.isZero() || priority.gt(maximum))
        throw new Error('Invalid EIP-1559 fees');
      params.maxFeePerGas = maximum;
      params.maxPriorityFeePerGas = priority;
    };
    if (
      !isLegacy &&
      params.maxFeePerGas != null &&
      params.maxPriorityFeePerGas != null
    )
      validateEip1559Fees();

    // Only apply a minimum gas limit when a network-specific override is set.
    // Otherwise keep the user/dapp-approved gas limit unchanged.
    if (params.gasLimit && this.gasOverrides.minGasLimit) {
      const minGasLimit = this.gasOverrides.minGasLimit;
      const currentGasLimit = BigNumber.from(params.gasLimit);
      if (currentGasLimit.lt(minGasLimit)) {
        params.gasLimit = minGasLimit;
      }
    }

    const txForEstimation = isLegacy
      ? omit(
          {
            ...params,
            from: params.from || activeAccount.address,
          },
          ['maxFeePerGas', 'maxPriorityFeePerGas', 'type']
        )
      : omit(
          {
            ...params,
            from: params.from || activeAccount.address,
          },
          ['gasPrice']
        );
    if (!params.gasLimit) {
      params.gasLimit = await provider.estimateGas(txForEstimation);
      assertCurrent();
    }
    if (isLegacy) {
      if (!params.gasPrice) {
        params.gasPrice = await provider.getGasPrice();
        assertCurrent();
      }
    } else if (
      params.maxFeePerGas == null ||
      params.maxPriorityFeePerGas == null
    ) {
      const feeData = await provider.getFeeData();
      assertCurrent();
      params.maxFeePerGas = params.maxFeePerGas ?? feeData.maxFeePerGas;
      params.maxPriorityFeePerGas =
        params.maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas;
      if (params.maxFeePerGas == null || params.maxPriorityFeePerGas == null) {
        if (requestedEip1559) throw new Error('EIP-1559 fee data unavailable');
        isLegacy = true;
        params.gasPrice = feeData.gasPrice ?? (await provider.getGasPrice());
        assertCurrent();
        delete (params as any).maxFeePerGas;
        delete (params as any).maxPriorityFeePerGas;
      }
    }
    if (!isLegacy) validateEip1559Fees();

    const sendEVMLedgerTransaction = async () => {
      assertCurrent();
      const transactionNonce = await provider.getTransactionCount(
        activeAccount.address,
        'pending'
      );
      assertCurrent();
      const formatParams = isLegacy
        ? omit(params, 'from')
        : omit(params, ['from', 'gasPrice']); // Strip gasPrice for EIP-1559
      const txFormattedForEthers = isLegacy
        ? {
            ...formatParams,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 0, // Force Type 0 for legacy
          }
        : {
            ...formatParams,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 2, // Need explicit type for hardware wallet serialization
          };
      const rawTx = serializeTransaction(txFormattedForEthers);

      const signature = await this.requireLedgerSigner().evm.signEVMTransaction(
        {
          rawTx: rawTx.replace('0x', ''),
          accountIndex: activeAccountId,
          expectedAddress: activeAccount.address,
        }
      );
      assertCurrent();

      const formattedSignature = {
        r: `0x${signature.r}`,
        s: `0x${signature.s}`,
        v: parseInt(signature.v, 16),
      };

      if (signature) {
        try {
          const signedTx = serializeTransaction(
            txFormattedForEthers,
            formattedSignature
          );
          assertHardwareTransactionSender(signedTx, activeAccount.address);
          assertBeforeBroadcast();
          const finalTx = await provider.sendTransaction(signedTx);

          return finalTx;
        } catch (error) {
          throw error;
        }
      } else {
        throw new Error(`Transaction Signature Failed. Error: ${signature}`);
      }
    };

    const sendEVMTrezorTransaction = async () => {
      assertCurrent();
      const transactionNonce = await provider.getTransactionCount(
        activeAccount.address,
        'pending'
      );
      assertCurrent();
      let txFormattedForTrezor = {};
      const formatParams = isLegacy
        ? omit(params, 'from')
        : omit(params, ['from', 'gasPrice']); // Strip gasPrice for EIP-1559
      switch (isLegacy) {
        case true:
          txFormattedForTrezor = {
            ...formatParams,
            gasLimit: this.toHex0x(
              (formatParams as any).gasLimit ?? (params as any).gasLimit,
              'gasLimit'
            ),
            value: this.toHex0x(
              (formatParams as any).value ?? (params as any).value,
              'value'
            ),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: (formatParams as any).data ?? '0x',
          };
          break;
        case false:
          txFormattedForTrezor = {
            ...formatParams,
            gasLimit: this.toHex0x(
              (formatParams as any).gasLimit ?? (params as any).gasLimit,
              'gasLimit'
            ),
            maxFeePerGas: this.toHex0x(
              (formatParams as any).maxFeePerGas ??
                (params as any).maxFeePerGas,
              'maxFeePerGas'
            ),
            maxPriorityFeePerGas: this.toHex0x(
              (formatParams as any).maxPriorityFeePerGas ??
                (params as any).maxPriorityFeePerGas,
              'maxPriorityFeePerGas'
            ),
            value: this.toHex0x(
              (formatParams as any).value ?? (params as any).value,
              'value'
            ),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: (formatParams as any).data ?? '0x',
          };
          break;
        default:
          txFormattedForTrezor = {
            ...formatParams,
            gasLimit: this.toHex0x(
              (formatParams as any).gasLimit ?? (params as any).gasLimit,
              'gasLimit'
            ),
            maxFeePerGas: this.toHex0x(
              (formatParams as any).maxFeePerGas ??
                (params as any).maxFeePerGas,
              'maxFeePerGas'
            ),
            maxPriorityFeePerGas: this.toHex0x(
              (formatParams as any).maxPriorityFeePerGas ??
                (params as any).maxPriorityFeePerGas,
              'maxPriorityFeePerGas'
            ),
            value: this.toHex0x(
              (formatParams as any).value ?? (params as any).value,
              'value'
            ),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: (formatParams as any).data ?? '0x',
          };
          break;
      }

      const signature = await this.requireTrezorSigner().signEthTransaction({
        index: `${activeAccountId}`,
        tx: txFormattedForTrezor as EthereumTransactionEIP1559,
        coin: activeNetwork.currency,
        slip44: activeNetwork.slip44,
      });
      assertCurrent();
      if (signature.success) {
        try {
          const txFormattedForEthers = isLegacy
            ? {
                ...formatParams,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 0, // Force Type 0 for legacy
              }
            : {
                ...formatParams,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 2, // Need explicit type for hardware wallet serialization
              };
          const signedTx = serializeTransaction(
            txFormattedForEthers,
            trezorSignature(signature.payload)
          );
          assertHardwareTransactionSender(signedTx, activeAccount.address);
          assertBeforeBroadcast();
          const finalTx = await provider.sendTransaction(signedTx);

          return finalTx;
        } catch (error) {
          throw error;
        }
      } else {
        throw new Error(`Transaction Signature Failed. Error: ${signature}`);
      }
    };

    const sendEVMTransaction = async () => {
      assertCurrent();
      const { address, decryptedPrivateKey } = this.getDecryptedPrivateKey();

      // Validate that we have the correct private key for the active account to prevent race conditions
      // This is critical for transaction security during account switches
      if (address.toLowerCase() !== activeAccount.address.toLowerCase()) {
        throw new Error(
          `Account state mismatch detected during transaction. Expected ${activeAccount.address} but got ${address}. Please wait for account switching to complete and try again.`
        );
      }

      // Explicitly set transaction type based on isLegacy flag
      // For EIP-1559, ensure gasPrice is not present to avoid ethers throwing
      const tx: Deferrable<TransactionRequest> = isLegacy
        ? { ...params, type: 0 } // Force Type 0 for legacy transactions
        : (omit(params, ['gasPrice']) as Deferrable<TransactionRequest>); // Strip gasPrice for EIP-1559

      try {
        const transaction = await sendLocalEvmTransaction(
          provider,
          decryptedPrivateKey,
          tx,
          assertBeforeBroadcast,
          assertCurrent
        );
        // The broadcast response already has the hash. Pending transactions
        // have no block number, so a block lookup can fail after a successful
        // broadcast and incorrectly report the send as failed.
        return transaction;
      } catch (error) {
        throw error;
      }
    };
    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await sendEVMTrezorTransaction();
      case KeyringAccountType.Ledger:
        return await sendEVMLedgerTransaction();
      default:
        return await sendEVMTransaction();
    }
  };
  sendTransactionWithEditedFee = async (
    txHash: string,
    isLegacy = false,
    options: IEvmReplacementOptions = {}
  ): Promise<{
    maximumFee?: string;
    error?: boolean;
    isSpeedUp: boolean;
    transaction?: TransactionResponse;
    code?: string;
    message?: string;
  }> => {
    const {
      assertCurrentContext,
      validateOriginal,
      beforeBroadcast,
      approvedMaximumFee,
    } = options;
    const previewOnly = options.previewOnly === true;
    if (!previewOnly) this.assertHardwareSignerAvailable(options.targetAccount);
    if (
      !previewOnly &&
      (typeof approvedMaximumFee !== 'string' ||
        !/^\d{1,78}$/.test(approvedMaximumFee))
    ) {
      throw new Error('Replacement fee approval required');
    }
    const assertCurrent = () => assertCurrentContext?.();
    const assertBeforeBroadcast = () => {
      assertCurrent();
      beforeBroadcast?.();
      assertCurrent();
    };
    const assertSignedSender = (signedTx: string) => {
      if (Transaction.from(signedTx).from?.toLowerCase() !== expectedSender) {
        throw new Error('Replacement signature does not match account');
      }
    };
    assertCurrent();
    const state = this.getState();
    const activeAccountType =
      options.targetAccount?.type ?? state.activeAccountType;
    const activeAccountId = options.targetAccount?.id ?? state.activeAccountId;
    const targetAccount = options.targetAccount
      ? { type: activeAccountType, id: activeAccountId }
      : undefined;
    const activeAccount = {
      ...state.accounts?.[activeAccountType]?.[activeAccountId],
    };
    const activeNetwork = { ...state.activeNetwork };
    if (
      !activeAccount.address ||
      (targetAccount && activeAccountType === KeyringAccountType.SmartAccount)
    ) {
      throw new Error('Replacement signing account is unavailable');
    }
    const expectedSender = activeAccount.address.toLowerCase();
    const requestedHash = txHash.toLowerCase();
    const provider = this.web3Provider;
    assertCurrent();
    const validateLookup = (transaction: TransactionResponse | null) => {
      assertCurrent();
      if (!transaction) return null;
      const authenticated = authenticateReplacementOriginal(
        transaction,
        requestedHash,
        expectedSender,
        activeNetwork.chainId
      );
      const type = authenticated.type;
      if (type !== 1) isLegacy = type === 0;
      if (
        isLegacy &&
        type === 1 &&
        activeAccountType === KeyringAccountType.Trezor
      ) {
        throw new Error('Trezor does not support type 1 replacement signing');
      }
      assertSynchronousOriginalValidation(validateOriginal?.(authenticated));
      assertCurrent();
      return authenticated;
    };
    let tx = validateLookup(await provider.getTransaction(txHash));
    if (!tx) {
      // Retry a couple of times in case the node hasn't indexed the pending tx yet
      for (let attempt = 0; attempt < 2 && !tx; attempt++) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * (attempt + 1))
        );
        assertCurrent();
        tx = validateLookup(await provider.getTransaction(txHash));
      }
      if (!tx) {
        return {
          isSpeedUp: false,
          error: true,
          code: 'TX_NOT_FOUND',
          message: 'Original transaction not yet available from RPC provider',
        };
      }
    }
    // Check if this might be a max send transaction by comparing total cost to balance
    const currentBalance = await provider.getBalance(activeAccount.address);
    assertCurrent();
    // Ensure all transaction values are resolved from promises
    const gasLimit = await Promise.resolve(tx.gasLimit);
    const gasPrice = await Promise.resolve(tx.gasPrice || 0);
    const maxFeePerGas = await Promise.resolve(
      tx.type === 1 ? tx.gasPrice : tx.maxFeePerGas
    );
    const maxPriorityFeePerGas = await Promise.resolve(
      tx.type === 1 ? tx.gasPrice : tx.maxPriorityFeePerGas
    );
    const txValue = await Promise.resolve(tx.value);
    const txData = await Promise.resolve(tx.data || '0x');
    assertCurrent();
    // Check if this is a contract call (has data)
    const isContractCall = txData && txData !== '0x' && txData.length > 2;
    const originalGasCost = isLegacy
      ? gasLimit.mul(gasPrice || 0)
      : gasLimit.mul(maxFeePerGas || 0);
    const originalTotalCost = txValue.add(originalGasCost);
    // If original transaction used >95% of balance, it's likely a max send
    const balanceThreshold = currentBalance.mul(95).div(100);
    const isLikelyMaxSend = originalTotalCost.gt(balanceThreshold);
    const oldTxsGasValues = {
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFeePerGas,
      gasPrice: gasPrice,
      gasLimit: gasLimit,
    };
    // A zero-fee original may need a current estimate; the preview shows it
    // and the final candidate must stay within the user's approved ceiling.
    if (isLegacy && oldTxsGasValues.gasPrice.isZero()) {
      oldTxsGasValues.gasPrice = await provider.getGasPrice();
      assertCurrent();
    } else if (!isLegacy && oldTxsGasValues.maxFeePerGas.isZero()) {
      const feeData = await this.getFeeDataWithDynamicMaxPriorityFeePerGas(
        provider
      );
      assertCurrent();
      oldTxsGasValues.maxFeePerGas = BigNumber.from(feeData.maxFeePerGas || 0);
      oldTxsGasValues.maxPriorityFeePerGas = BigNumber.from(
        feeData.maxPriorityFeePerGas || 0
      );
    }
    const newGasValues = this.calculateNewGasValues(
      oldTxsGasValues,
      false,
      isLegacy
    );
    if (!newGasValues.gasLimit!.gt(0))
      throw new Error('Invalid replacement gas limit');
    if (
      !isLegacy &&
      newGasValues.maxPriorityFeePerGas!.gt(newGasValues.maxFeePerGas!)
    )
      throw new Error('Invalid replacement fee');
    const maximumFee = newGasValues.gasLimit!.mul(
      isLegacy ? newGasValues.gasPrice! : newGasValues.maxFeePerGas!
    );
    if (isLikelyMaxSend && txValue.add(maximumFee).gt(currentBalance)) {
      if (isContractCall) {
        console.error(
          '[SpeedUp] Cannot adjust value for contract call - rejecting speedup'
        );
        return {
          isSpeedUp: false,
          error: true,
          code: 'CONTRACT_CALL_MAX_SEND',
          message:
            'Cannot speed up a likely max-send contract call; value cannot be adjusted to fit new gas',
        };
      }
      return {
        isSpeedUp: false,
        error: true,
        code: 'REPLACEMENT_VALUE_WOULD_CHANGE',
        message:
          'Add funds before speeding up this transaction; the original amount will not be changed',
      };
    }
    const txWithEditedFee: TransactionRequest = {
      chainId: activeNetwork.chainId,
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
      value: txValue,
      data: txData,
      gasLimit: newGasValues.gasLimit,
      ...(tx.accessList != null ? { accessList: tx.accessList } : {}),
      ...(isLegacy
        ? { gasPrice: newGasValues.gasPrice, type: tx.type === 1 ? 1 : 0 }
        : {
            maxFeePerGas: newGasValues.maxFeePerGas,
            maxPriorityFeePerGas: newGasValues.maxPriorityFeePerGas,
          }),
    };
    if (previewOnly)
      return { isSpeedUp: false, maximumFee: maximumFee.toString() };
    if (maximumFee.gt(approvedMaximumFee!))
      throw new Error('Replacement fee exceeds approval');
    // Ledger speedup handler
    const speedUpWithLedger = async () => {
      try {
        const resolvedParams = await resolveProperties(
          omit(txWithEditedFee, 'from')
        );
        const formatParams = {
          ...resolvedParams,
          nonce:
            resolvedParams.nonce != null
              ? Number(resolvedParams.nonce.toString())
              : undefined,
        };
        const txFormattedForEthers = isLegacy
          ? {
              ...formatParams,
              chainId: activeNetwork.chainId,
              type: txWithEditedFee.type,
            }
          : {
              ...formatParams,
              chainId: activeNetwork.chainId,
              type: 2, // Need explicit type for hardware wallet serialization
            };
        const rawTx = serializeTransaction(txFormattedForEthers);
        assertCurrent();
        const signature =
          await this.requireLedgerSigner().evm.signEVMTransaction({
            rawTx: rawTx.replace('0x', ''),
            accountIndex: activeAccountId,
            expectedAddress: activeAccount.address,
          });
        const formattedSignature = {
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: parseInt(signature.v, 16),
        };
        if (signature) {
          const signedTx = serializeTransaction(
            txFormattedForEthers,
            formattedSignature
          );
          assertSignedSender(signedTx);
          assertHardwareTransactionSender(signedTx, activeAccount.address);
          assertBeforeBroadcast();
          const transactionResponse = await provider.sendTransaction(signedTx);
          return {
            isSpeedUp: true,
            transaction: transactionResponse,
          };
        } else {
          return {
            isSpeedUp: false,
            error: true,
          };
        }
      } catch (error) {
        console.error(
          '[SpeedUp] Failed to send replacement transaction with Ledger:',
          error
        );
        const message = error?.message || String(error);
        const lower = message.toLowerCase();
        const code = lower.includes('underpriced')
          ? 'REPLACEMENT_UNDERPRICED'
          : lower.includes('known transaction') ||
            lower.includes('already known')
          ? 'REPLACEMENT_ALREADY_KNOWN'
          : 'REPLACEMENT_SEND_FAILED';
        return {
          isSpeedUp: false,
          error: true,
          code,
          message,
        };
      }
    };
    // Trezor speedup handler
    const speedUpWithTrezor = async () => {
      try {
        const trezorCoin =
          activeNetwork.slip44 === 60 ? 'eth' : activeNetwork.currency;
        const formattedTx = await resolveProperties(
          omit(txWithEditedFee, 'from')
        );
        const txFormattedForTrezor: any = {
          ...formattedTx,
          gasLimit:
            typeof formattedTx.gasLimit === 'string'
              ? formattedTx.gasLimit
              : this.toHex0x(formattedTx.gasLimit, 'gasLimit'),
          value:
            typeof formattedTx.value === 'string'
              ? formattedTx.value
              : this.toHex0x(formattedTx.value, 'value'),
          nonce: this.toHex0x(formattedTx.nonce, 'nonce'),
          chainId: activeNetwork.chainId,
          type: isLegacy ? txWithEditedFee.type : 2,
        };
        if (formattedTx.data && formattedTx.data !== '0x') {
          txFormattedForTrezor.data = formattedTx.data;
        }
        if (isLegacy) {
          txFormattedForTrezor.gasPrice =
            typeof formattedTx.gasPrice === 'string'
              ? formattedTx.gasPrice
              : this.toHex0x(formattedTx.gasPrice, 'gasPrice');
        } else {
          txFormattedForTrezor.maxFeePerGas =
            typeof formattedTx.maxFeePerGas === 'string'
              ? formattedTx.maxFeePerGas
              : this.toHex0x(formattedTx.maxFeePerGas, 'maxFeePerGas');
          txFormattedForTrezor.maxPriorityFeePerGas =
            typeof formattedTx.maxPriorityFeePerGas === 'string'
              ? formattedTx.maxPriorityFeePerGas
              : this.toHex0x(
                  formattedTx.maxPriorityFeePerGas,
                  'maxPriorityFeePerGas'
                );
        }
        assertCurrent();
        const signature = await this.requireTrezorSigner().signEthTransaction({
          coin: trezorCoin,
          tx: txFormattedForTrezor,
          index: activeAccountId.toString(),
          slip44: activeNetwork.slip44,
        });
        if (signature.success) {
          const signedTx = serializeTransaction(
            txFormattedForTrezor,
            trezorSignature(signature.payload)
          );
          assertSignedSender(signedTx);
          assertHardwareTransactionSender(signedTx, activeAccount.address);
          assertBeforeBroadcast();
          const transactionResponse = await provider.sendTransaction(signedTx);
          return {
            isSpeedUp: true,
            transaction: transactionResponse,
          };
        } else {
          return {
            isSpeedUp: false,
            error: true,
          };
        }
      } catch (error) {
        console.error(
          '[SpeedUp] Failed to send replacement transaction with Trezor:',
          error
        );
        const message = error?.message || String(error);
        const lower = message.toLowerCase();
        const code = lower.includes('underpriced')
          ? 'REPLACEMENT_UNDERPRICED'
          : lower.includes('known transaction') ||
            lower.includes('already known')
          ? 'REPLACEMENT_ALREADY_KNOWN'
          : 'REPLACEMENT_SEND_FAILED';
        return {
          isSpeedUp: false,
          error: true,
          code,
          message,
        };
      }
    };
    // Regular wallet speedup handler
    const speedUpWithPrivateKey = async () => {
      try {
        assertCurrent();
        const { address, decryptedPrivateKey } =
          this.getDecryptedPrivateKey(targetAccount);
        assertCurrent();
        if (address.toLowerCase() !== expectedSender) {
          throw new Error('Replacement signing account changed');
        }
        const transactionResponse = await sendLocalEvmTransaction(
          provider,
          decryptedPrivateKey,
          txWithEditedFee,
          assertBeforeBroadcast,
          assertCurrent
        );
        if (transactionResponse) {
          return {
            isSpeedUp: true,
            transaction: transactionResponse,
          };
        } else {
          return {
            isSpeedUp: false,
          };
        }
      } catch (error) {
        console.error(
          '[SpeedUp] Failed to send replacement transaction:',
          error
        );
        const message = error?.message || String(error);
        const lower = message.toLowerCase();
        const code = lower.includes('underpriced')
          ? 'REPLACEMENT_UNDERPRICED'
          : lower.includes('known transaction') ||
            lower.includes('already known')
          ? 'REPLACEMENT_ALREADY_KNOWN'
          : lower.includes('insufficient funds')
          ? 'INSUFFICIENT_FUNDS_REPLACEMENT'
          : 'REPLACEMENT_SEND_FAILED';
        return {
          isSpeedUp: false,
          error: true,
          code,
          message,
        };
      }
    };
    // Route based on account type
    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await speedUpWithTrezor();
      case KeyringAccountType.Ledger:
        return await speedUpWithLedger();
      default:
        return await speedUpWithPrivateKey();
    }
  };
  sendSignedErc20Transaction = async ({
    receiver,
    tokenAddress,
    tokenAmount,
    isLegacy = false,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasPrice,
    decimals,
    gasLimit,
    saveTrezorTx,
  }: ISendSignedErcTransactionProps): Promise<IResponseFromSendErcSignedTransaction> => {
    const {
      activeAccount,
      activeAccountType,
      activeAccountId,
      activeNetwork,
      provider,
      assertCurrent,
    } = this.captureEvmSigningContext();
    const activeAccountAddress = activeAccount.address;
    ({ gasPrice, isLegacy, maxFeePerGas, maxPriorityFeePerGas } =
      await this.resolveEvmFeeParams(
        {
          gasPrice,
          isLegacy,
          maxFeePerGas,
          maxPriorityFeePerGas,
        },
        provider
      ));
    assertCurrent();

    const sendERC20Token = async () => {
      assertCurrent();
      const { decryptedPrivateKey } = this.getDecryptedPrivateKey();
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc20Abi(),
          provider as any
        );
        // Preserve zero-decimal tokens: use provided decimals when defined (including 0).
        const resolvedDecimals =
          decimals === undefined || decimals === null ? 18 : Number(decimals);
        const calculatedTokenAmount = parseUnits(
          tokenAmount as string,
          resolvedDecimals
        ).toBigInt();
        let transferMethod;
        if (isLegacy) {
          const overrides = {
            nonce: await provider.getTransactionCount(
              activeAccountAddress,
              'pending'
            ),
            gasPrice,
            ...(gasLimit && { gasLimit }),
            type: 0, // Explicitly set Type 0 for legacy token transfers
          };
          transferMethod = await _contract.transfer.populateTransaction(
            receiver,
            calculatedTokenAmount,
            normalizeEthersOverrides(overrides)
          );
        } else {
          const overrides = {
            nonce: await provider.getTransactionCount(
              activeAccountAddress,
              'pending'
            ),
            maxPriorityFeePerGas,
            maxFeePerGas,
            ...(gasLimit && { gasLimit }),
          };

          transferMethod = await _contract.transfer.populateTransaction(
            receiver,
            calculatedTokenAmount,
            normalizeEthersOverrides(overrides)
          );
        }

        return await sendLocalEvmTransaction(
          provider,
          decryptedPrivateKey,
          {
            ...transferMethod,
            chainId: activeNetwork.chainId,
            from: activeAccountAddress,
            value: '0x0',
          },
          assertCurrent,
          assertCurrent
        );
      } catch (error) {
        throw error;
      }
    };

    const sendERC20TokenOnLedger = async () => {
      assertCurrent();
      const transactionNonce = await provider.getTransactionCount(
        activeAccountAddress,
        'pending'
      );
      assertCurrent();
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc20Abi(),
          provider as any
        );

        const resolvedDecimals =
          decimals === undefined || decimals === null ? 18 : Number(decimals);
        const calculatedTokenAmount = parseUnits(
          tokenAmount as string,
          resolvedDecimals
        ).toBigInt();

        const txData = _contract.interface.encodeFunctionData('transfer', [
          receiver,
          calculatedTokenAmount,
        ]);

        // Use fallback gas limit if not provided (for auto-estimation)
        const effectiveGasLimit = gasLimit || this.toBigNumber('100000'); // ERC20 fallback

        let txFormattedForEthers;
        if (isLegacy) {
          txFormattedForEthers = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: effectiveGasLimit,
            gasPrice,
            data: txData,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 0,
          };
        } else {
          txFormattedForEthers = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: effectiveGasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            data: txData,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 2, // Need explicit type for hardware wallet serialization
          };
        }

        const rawTx = serializeTransaction(txFormattedForEthers);

        const signature =
          await this.requireLedgerSigner().evm.signEVMTransaction({
            rawTx: rawTx.replace('0x', ''),
            accountIndex: activeAccountId,
            expectedAddress: activeAccount.address,
          });

        assertCurrent();
        const formattedSignature = {
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: parseInt(signature.v, 16),
        };
        if (signature) {
          try {
            const signedTx = serializeTransaction(
              txFormattedForEthers,
              formattedSignature
            );
            assertCurrent();
            assertHardwareTransactionSender(signedTx, activeAccount.address);
            const finalTx = await provider.sendTransaction(signedTx);

            saveTrezorTx && saveTrezorTx(finalTx);

            return finalTx as any;
          } catch (error) {
            throw error;
          }
        } else {
          throw new Error(`Transaction Signature Failed. Error: ${signature}`);
        }
      } catch (error) {
        throw error;
      }
    };

    const sendERC20TokenOnTrezor = async () => {
      assertCurrent();
      const transactionNonce = await provider.getTransactionCount(
        activeAccountAddress,
        'pending'
      );
      assertCurrent();
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc20Abi(),
          provider as any
        );

        const resolvedDecimals =
          decimals === undefined || decimals === null ? 18 : Number(decimals);
        const calculatedTokenAmount = parseUnits(
          tokenAmount as string,
          resolvedDecimals
        ).toBigInt();

        const txData = _contract.interface.encodeFunctionData('transfer', [
          receiver,
          calculatedTokenAmount,
        ]);

        // Use fallback gas limit if not provided (for auto-estimation)
        const effectiveGasLimit = gasLimit || this.toBigNumber('100000'); // ERC20 fallback

        let txToBeSignedByTrezor;
        if (isLegacy) {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: this.toHex0x(effectiveGasLimit, 'gasLimit'),
            gasPrice: this.toHex0x(gasPrice, 'gasPrice'),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        } else {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: this.toHex0x(effectiveGasLimit, 'gasLimit'),
            maxFeePerGas: this.toHex0x(maxFeePerGas, 'maxFeePerGas'),
            maxPriorityFeePerGas: this.toHex0x(
              maxPriorityFeePerGas,
              'maxPriorityFeePerGas'
            ),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        }

        const signature = await this.requireTrezorSigner().signEthTransaction({
          index: `${activeAccountId}`,
          tx: txToBeSignedByTrezor,
          coin: activeNetwork.currency,
          slip44: activeNetwork.slip44,
        });

        assertCurrent();
        if (signature.success) {
          try {
            let txFormattedForEthers;
            if (isLegacy) {
              txFormattedForEthers = {
                to: tokenAddress,
                value: '0x0',
                gasLimit: effectiveGasLimit,
                gasPrice,
                data: txData,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 0,
              };
            } else {
              txFormattedForEthers = {
                to: tokenAddress,
                value: '0x0',
                gasLimit: effectiveGasLimit,
                maxFeePerGas,
                maxPriorityFeePerGas,
                data: txData,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 2, // Need explicit type for hardware wallet serialization
              };
            }
            const signedTx = serializeTransaction(
              txFormattedForEthers,
              trezorSignature(signature.payload)
            );
            assertCurrent();
            assertHardwareTransactionSender(signedTx, activeAccount.address);
            const finalTx = await provider.sendTransaction(signedTx);

            saveTrezorTx && saveTrezorTx(finalTx);

            return finalTx as any;
          } catch (error) {
            throw error;
          }
        } else {
          throw new Error(`Transaction Signature Failed. Error: ${signature}`);
        }
      } catch (error) {
        throw error;
      }
    };

    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await sendERC20TokenOnTrezor();
      case KeyringAccountType.Ledger:
        return await sendERC20TokenOnLedger();
      default:
        return (await sendERC20Token()) as any;
    }
  };

  sendSignedErc721Transaction = async ({
    receiver,
    tokenAddress,
    tokenId,
    isLegacy,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasPrice,
    gasLimit,
  }: ISendSignedErcTransactionProps): Promise<IResponseFromSendErcSignedTransaction> => {
    const {
      activeAccount,
      activeAccountType,
      activeAccountId,
      activeNetwork,
      provider,
      assertCurrent,
    } = this.captureEvmSigningContext();
    const activeAccountAddress = activeAccount.address;
    if (tokenId === undefined || tokenId === null) {
      throw new Error('ERC721 tokenId is required');
    }
    ({ gasPrice, isLegacy, maxFeePerGas, maxPriorityFeePerGas } =
      await this.resolveEvmFeeParams(
        {
          gasPrice,
          isLegacy,
          maxFeePerGas,
          maxPriorityFeePerGas,
        },
        provider
      ));
    assertCurrent();
    const normalizedTokenId = BigNumber.from(tokenId).toBigInt();

    const sendERC721Token = async () => {
      assertCurrent();
      const { decryptedPrivateKey } = this.getDecryptedPrivateKey();
      let transferMethod;
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc21Abi(),
          provider as any
        );

        if (isLegacy) {
          const overrides = {
            nonce: await provider.getTransactionCount(
              activeAccountAddress,
              'pending'
            ),
            gasPrice,
            ...(gasLimit && { gasLimit }),
            type: 0, // Explicitly set Type 0 for legacy NFT transfers
          };
          transferMethod = await _contract.transferFrom.populateTransaction(
            activeAccountAddress,
            receiver,
            normalizedTokenId,
            normalizeEthersOverrides(overrides)
          );
        } else {
          const overrides = {
            nonce: await provider.getTransactionCount(
              activeAccountAddress,
              'pending'
            ),
            maxPriorityFeePerGas,
            maxFeePerGas,
            ...(gasLimit && { gasLimit }),
          };
          transferMethod = await _contract.transferFrom.populateTransaction(
            activeAccountAddress,
            receiver,
            normalizedTokenId,
            normalizeEthersOverrides(overrides)
          );
        }

        return await sendLocalEvmTransaction(
          provider,
          decryptedPrivateKey,
          {
            ...transferMethod,
            chainId: activeNetwork.chainId,
            from: activeAccountAddress,
            value: '0x0',
          },
          assertCurrent,
          assertCurrent
        );
      } catch (error) {
        throw error;
      }
    };

    const sendERC721TokenOnLedger = async () => {
      assertCurrent();
      const transactionNonce = await provider.getTransactionCount(
        activeAccountAddress,
        'pending'
      );
      assertCurrent();
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc21Abi(),
          provider as any
        );
        const txData = _contract.interface.encodeFunctionData('transferFrom', [
          activeAccountAddress,
          receiver,
          normalizedTokenId,
        ]);

        // Use fallback gas limit if not provided (for auto-estimation)
        const effectiveGasLimit = gasLimit || this.toBigNumber('150000'); // ERC721 fallback

        let txFormattedForEthers;
        if (isLegacy) {
          txFormattedForEthers = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: effectiveGasLimit,
            gasPrice,
            data: txData,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 0,
          };
        } else {
          txFormattedForEthers = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: effectiveGasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            data: txData,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 2, // Need explicit type for hardware wallet serialization
          };
        }

        const rawTx = serializeTransaction(txFormattedForEthers);

        const signature =
          await this.requireLedgerSigner().evm.signEVMTransaction({
            rawTx: rawTx.replace('0x', ''),
            accountIndex: activeAccountId,
            expectedAddress: activeAccount.address,
          });

        assertCurrent();
        const formattedSignature = {
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: parseInt(signature.v, 16),
        };

        if (signature) {
          try {
            const signedTx = serializeTransaction(
              txFormattedForEthers,
              formattedSignature
            );
            assertCurrent();
            assertHardwareTransactionSender(signedTx, activeAccount.address);
            const finalTx = await provider.sendTransaction(signedTx);

            return finalTx as any;
          } catch (error) {
            throw error;
          }
        } else {
          throw new Error(`Transaction Signature Failed. Error: ${signature}`);
        }
      } catch (error) {
        throw error;
      }
    };

    const sendERC721TokenOnTrezor = async () => {
      assertCurrent();
      const transactionNonce = await provider.getTransactionCount(
        activeAccountAddress,
        'pending'
      );
      assertCurrent();
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc21Abi(),
          provider as any
        );
        const txData = _contract.interface.encodeFunctionData('transferFrom', [
          activeAccountAddress,
          receiver,
          normalizedTokenId,
        ]);

        // Use fallback gas limit if not provided (for auto-estimation)
        const effectiveGasLimit = gasLimit || this.toBigNumber('150000'); // ERC721 fallback

        let txToBeSignedByTrezor;
        if (isLegacy) {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: this.toHex0x(effectiveGasLimit, 'gasLimit'),
            gasPrice: this.toHex0x(gasPrice, 'gasPrice'),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
          console.log({ txToBeSignedByTrezor });
        } else {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: this.toHex0x(effectiveGasLimit, 'gasLimit'),
            maxFeePerGas: this.toHex0x(maxFeePerGas, 'maxFeePerGas'),
            maxPriorityFeePerGas: this.toHex0x(
              maxPriorityFeePerGas,
              'maxPriorityFeePerGas'
            ),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        }

        // For EVM networks, Trezor expects 'eth' regardless of the network's currency
        const trezorCoin =
          activeNetwork.slip44 === 60 ? 'eth' : activeNetwork.currency;
        const signature = await this.requireTrezorSigner().signEthTransaction({
          index: `${activeAccountId}`,
          tx: txToBeSignedByTrezor,
          coin: trezorCoin,
          slip44: activeNetwork.slip44,
        });

        assertCurrent();
        if (signature.success) {
          try {
            let txFormattedForEthers;
            if (isLegacy) {
              txFormattedForEthers = {
                to: tokenAddress,
                value: '0x0',
                gasLimit: effectiveGasLimit,
                gasPrice,
                data: txData,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 0,
              };
            } else {
              txFormattedForEthers = {
                to: tokenAddress,
                value: '0x0',
                gasLimit: effectiveGasLimit,
                maxFeePerGas,
                maxPriorityFeePerGas,
                data: txData,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 2, // Need explicit type for hardware wallet serialization
              };
            }
            const signedTx = serializeTransaction(
              txFormattedForEthers,
              trezorSignature(signature.payload)
            );
            assertCurrent();
            assertHardwareTransactionSender(signedTx, activeAccount.address);
            const finalTx = await provider.sendTransaction(signedTx);

            return finalTx as any;
          } catch (error) {
            console.log({ error });
            throw error;
          }
        } else {
          throw new Error(`Transaction Signature Failed. Error: ${signature}`);
        }
      } catch (error) {
        console.log({ errorDois: error });
        throw error;
      }
    };

    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await sendERC721TokenOnTrezor();
      case KeyringAccountType.Ledger:
        return await sendERC721TokenOnLedger();
      default:
        return (await sendERC721Token()) as any;
    }
  };

  sendSignedErc1155Transaction = async ({
    receiver,
    tokenAddress,
    tokenId,
    tokenAmount,
    isLegacy,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasPrice,
    gasLimit,
  }: ISendSignedErcTransactionProps): Promise<IResponseFromSendErcSignedTransaction> => {
    const {
      activeAccount,
      activeAccountType,
      activeAccountId,
      activeNetwork,
      provider,
      assertCurrent,
    } = this.captureEvmSigningContext();
    const activeAccountAddress = activeAccount.address;
    ({ gasPrice, isLegacy, maxFeePerGas, maxPriorityFeePerGas } =
      await this.resolveEvmFeeParams(
        {
          gasPrice,
          isLegacy,
          maxFeePerGas,
          maxPriorityFeePerGas,
        },
        provider
      ));
    assertCurrent();

    const sendERC1155Token = async () => {
      assertCurrent();
      const { decryptedPrivateKey } = this.getDecryptedPrivateKey();
      let transferMethod;
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc55Abi(),
          provider as any
        );

        // Use BigNumber to avoid JS number overflow/precision loss
        const amount = BigNumber.from(tokenAmount ?? '1');

        let overrides;
        if (isLegacy) {
          overrides = {
            nonce: await provider.getTransactionCount(
              activeAccountAddress,
              'pending'
            ),
            gasPrice,
            ...(gasLimit && { gasLimit }),
            type: 0, // Explicitly set Type 0 for legacy ERC1155 transfers
          };
        } else {
          overrides = {
            nonce: await provider.getTransactionCount(
              activeAccountAddress,
              'pending'
            ),
            maxPriorityFeePerGas,
            maxFeePerGas,
            ...(gasLimit && { gasLimit }),
          };
        }

        transferMethod = await _contract.safeTransferFrom.populateTransaction(
          activeAccountAddress,
          receiver,
          tokenId as number,
          amount.toBigInt(),
          '0x',
          normalizeEthersOverrides(overrides)
        );
        return await sendLocalEvmTransaction(
          provider,
          decryptedPrivateKey,
          {
            ...transferMethod,
            chainId: activeNetwork.chainId,
            from: activeAccountAddress,
            value: '0x0',
          },
          assertCurrent,
          assertCurrent
        );
      } catch (error) {
        throw error;
      }
    };

    const sendERC1155TokenOnLedger = async () => {
      assertCurrent();
      const transactionNonce = await provider.getTransactionCount(
        activeAccountAddress,
        'pending'
      );
      assertCurrent();
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc55Abi(),
          provider as any
        );

        const amount = BigNumber.from(tokenAmount ?? '1');

        const txData = _contract.interface.encodeFunctionData(
          'safeTransferFrom',
          [activeAccountAddress, receiver, tokenId, amount.toBigInt(), '0x']
        );

        // Use fallback gas limit if not provided (for auto-estimation)
        const effectiveGasLimit = gasLimit || this.toBigNumber('200000'); // ERC1155 fallback

        let txFormattedForEthers;
        if (isLegacy) {
          txFormattedForEthers = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: effectiveGasLimit,
            gasPrice,
            data: txData,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 0,
          };
        } else {
          txFormattedForEthers = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: effectiveGasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            data: txData,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 2, // Need explicit type for hardware wallet serialization
          };
        }

        const rawTx = serializeTransaction(txFormattedForEthers);

        const signature =
          await this.requireLedgerSigner().evm.signEVMTransaction({
            rawTx: rawTx.replace('0x', ''),
            accountIndex: activeAccountId,
            expectedAddress: activeAccount.address,
          });

        assertCurrent();
        const formattedSignature = {
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: parseInt(signature.v, 16),
        };

        if (signature) {
          try {
            const signedTx = serializeTransaction(
              txFormattedForEthers,
              formattedSignature
            );
            assertCurrent();
            assertHardwareTransactionSender(signedTx, activeAccount.address);
            const finalTx = await provider.sendTransaction(signedTx);

            return finalTx as any;
          } catch (error) {
            throw error;
          }
        } else {
          throw new Error(`Transaction Signature Failed. Error: ${signature}`);
        }
      } catch (error) {
        throw error;
      }
    };

    const sendERC1155TokenOnTrezor = async () => {
      assertCurrent();
      const transactionNonce = await provider.getTransactionCount(
        activeAccountAddress,
        'pending'
      );
      assertCurrent();
      try {
        const _contract = new Contract(
          tokenAddress,
          getErc55Abi(),
          provider as any
        );

        const amount = BigNumber.from(tokenAmount ?? '1');

        const txData = _contract.interface.encodeFunctionData(
          'safeTransferFrom',
          [activeAccountAddress, receiver, tokenId, amount.toBigInt(), '0x']
        );

        // Use fallback gas limit if not provided (for auto-estimation)
        const effectiveGasLimit = gasLimit || this.toBigNumber('200000'); // ERC1155 fallback

        let txToBeSignedByTrezor;
        if (isLegacy) {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: this.toHex0x(effectiveGasLimit, 'gasLimit'),
            gasPrice: this.toHex0x(gasPrice, 'gasPrice'),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        } else {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            gasLimit: this.toHex0x(effectiveGasLimit, 'gasLimit'),
            maxFeePerGas: this.toHex0x(maxFeePerGas, 'maxFeePerGas'),
            maxPriorityFeePerGas: this.toHex0x(
              maxPriorityFeePerGas,
              'maxPriorityFeePerGas'
            ),
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        }

        const signature = await this.requireTrezorSigner().signEthTransaction({
          index: `${activeAccountId}`,
          tx: txToBeSignedByTrezor,
          coin: activeNetwork.currency,
          slip44: activeNetwork.slip44,
        });

        assertCurrent();
        if (signature.success) {
          try {
            let txFormattedForEthers;
            if (isLegacy) {
              txFormattedForEthers = {
                to: tokenAddress,
                value: '0x0',
                gasLimit: effectiveGasLimit,
                gasPrice,
                data: txData,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 0,
              };
            } else {
              txFormattedForEthers = {
                to: tokenAddress,
                value: '0x0',
                gasLimit: effectiveGasLimit,
                maxFeePerGas,
                maxPriorityFeePerGas,
                data: txData,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 2, // Need explicit type for hardware wallet serialization
              };
            }
            const signedTx = serializeTransaction(
              txFormattedForEthers,
              trezorSignature(signature.payload)
            );
            assertCurrent();
            assertHardwareTransactionSender(signedTx, activeAccount.address);
            const finalTx = await provider.sendTransaction(signedTx);

            return finalTx as any;
          } catch (error) {
            console.log({ error });
            throw error;
          }
        } else {
          throw new Error(`Transaction Signature Failed. Error: ${signature}`);
        }
      } catch (error) {
        console.log({ error });
        throw error;
      }
    };

    switch (activeAccountType) {
      case KeyringAccountType.Trezor:
        return await sendERC1155TokenOnTrezor();
      case KeyringAccountType.Ledger:
        return await sendERC1155TokenOnLedger();
      default:
        return (await sendERC1155Token()) as any;
    }
  };

  getRecommendedNonce = async (address: string) => {
    try {
      return await this.web3Provider.getTransactionCount(address, 'pending');
    } catch (error) {
      throw error;
    }
  };

  getFeeByType = async (type: string) => {
    const gasPrice = (await this.getRecommendedGasPrice(false)) as string;

    const low = this.toBigNumber(gasPrice)
      .mul(BigNumber.from('8'))
      .div(BigNumber.from('10'))
      .toString();

    const high = this.toBigNumber(gasPrice)
      .mul(BigNumber.from('11'))
      .div(BigNumber.from('10'))
      .toString();

    if (type === 'low') return low;
    if (type === 'high') return high;

    return gasPrice;
  };

  getGasLimit = async (toAddress: string) => {
    try {
      const estimated = await this.web3Provider.estimateGas({
        to: toAddress,
      });

      return Number(BigNumber.from(estimated).toString());
    } catch (error) {
      throw error;
    }
  };

  getTxGasLimit = async (tx: SimpleTransactionRequest) => {
    const hasCalldata = Boolean(
      tx.data && tx.data !== '0x' && tx.data !== '0x0'
    );

    try {
      // First attempt: standard estimation
      const estimated = await this.web3Provider.estimateGas(tx);

      // Add 20% buffer to the estimated gas
      const withBuffer = estimated.mul(120).div(100);

      // Apply an explicit per-network floor only when configured.
      if (
        this.gasOverrides.minGasLimit &&
        withBuffer.lt(this.gasOverrides.minGasLimit)
      ) {
        return this.gasOverrides.minGasLimit;
      }

      return withBuffer;
    } catch (error) {
      if (
        error?.code === 'SYSWEB3_RPC_RESPONSE_INVALID' ||
        error?.name === 'AbortError' ||
        this.abortController.signal.aborted
      )
        throw error;
      console.warn('Gas estimation failed:', error);

      if (hasCalldata) {
        const calldataFallback = BigNumber.from('100000');
        if (
          this.gasOverrides.minGasLimit &&
          calldataFallback.lt(this.gasOverrides.minGasLimit)
        ) {
          return this.gasOverrides.minGasLimit;
        }

        return calldataFallback;
      }

      // Try a simpler estimation for basic transfers
      try {
        const simpleEstimate = await this.web3Provider.estimateGas({
          to: tx.to,
          from: tx.from,
          value: tx.value || '0x0',
        });

        const withBuffer = simpleEstimate.mul(150).div(100); // 50% buffer for failed estimations
        if (
          this.gasOverrides.minGasLimit &&
          withBuffer.lt(this.gasOverrides.minGasLimit)
        ) {
          return this.gasOverrides.minGasLimit;
        }

        return withBuffer;
      } catch (secondError) {
        if (
          secondError?.code === 'SYSWEB3_RPC_RESPONSE_INVALID' ||
          secondError?.name === 'AbortError' ||
          this.abortController.signal.aborted
        ) {
          throw secondError;
        }
        // Ultimate fallback
        console.warn(
          'Simple estimation also failed, using default',
          secondError
        );
        return this.gasOverrides.minGasLimit || BigNumber.from('100000');
      }
    }
  };

  getRecommendedGasPrice = async (formatted?: boolean) => {
    try {
      const gasPriceBN = await this.web3Provider.getGasPrice();

      if (formatted) {
        return {
          gwei: Number(formatUnits(gasPriceBN, 'gwei')).toFixed(2),
          ethers: formatEther(gasPriceBN),
        };
      }

      return gasPriceBN.toString();
    } catch (error) {
      throw error;
    }
  };

  getBalance = async (address: string) => {
    try {
      const balance = await this.web3Provider.getBalance(address);
      const formattedBalance = formatEther(balance);

      return parseFloat(formattedBalance); // Return full precision
    } catch (error) {
      throw error;
    }
  };

  public setWeb3Provider(network: INetwork) {
    this.abortController.abort();
    this.abortController = new AbortController();

    // Check if network is a UTXO network to avoid creating web3 providers for blockbook URLs
    const isUtxoNetwork = this.isUtxoNetwork(network);

    if (isUtxoNetwork) {
      // For UTXO networks, don't create web3 providers at all since they won't be used
      console.log(
        '[EthereumTransactions] setWeb3Provider: Skipping web3Provider creation for UTXO network:',
        network.url
      );
      // Clear any existing providers for UTXO networks
      this._web3Provider = undefined as any;
      this._web3ProviderKey = undefined;
    } else {
      this._web3Provider = new CustomJsonRpcProvider(
        this.abortController.signal,
        network.url,
        network.chainId
      );
      this._web3ProviderKey = `${network.chainId}|${network.url ?? ''}`;
    }
  }

  public importAccount = (mnemonicOrPrivKey: string) => {
    if (isHexString(mnemonicOrPrivKey)) {
      return privateKeyToAccount(mnemonicOrPrivKey);
    }

    return deriveEvmAccountFromMnemonic(
      mnemonicOrPrivKey,
      getAddressDerivationPath('eth', 60, 0, false, 0)
    );
  };

  // Method to configure gas overrides for networks with validation issues
  public setGasOverrides(overrides: {
    minGasLimit?: string | BigNumber;
    minPriorityFee?: string | BigNumber;
    feeMultiplier?: number;
  }) {
    this.gasOverrides = {
      minGasLimit: overrides.minGasLimit
        ? BigNumber.from(overrides.minGasLimit)
        : undefined,
      minPriorityFee: overrides.minPriorityFee
        ? BigNumber.from(overrides.minPriorityFee)
        : undefined,
      feeMultiplier: overrides.feeMultiplier,
    };
  }

  // Get the current gas overrides
  public getGasOverrides() {
    return this.gasOverrides;
  }

  // Method to get safe fee data that works around network-specific validation issues
  public getSafeFeeData = async (forceLegacy: boolean = false) => {
    if (forceLegacy) {
      // For legacy transactions, just return gas price
      const gasPrice = await this.web3Provider.getGasPrice();
      const bufferedGasPrice = gasPrice.mul(110).div(100); // 10% buffer
      return {
        gasPrice: bufferedGasPrice,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      };
    }

    const feeData = await this.getFeeDataWithDynamicMaxPriorityFeePerGas();
    if (feeData.baseFeePerGas === undefined) {
      // Only an actual pre-London header authorizes legacy selection.
      const bufferedGasPrice = feeData.gasPrice.mul(110).div(100);
      return {
        gasPrice: bufferedGasPrice,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      };
    }
    return {
      gasPrice: undefined,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    };
  };
}

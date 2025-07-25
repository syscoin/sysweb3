import { TransactionResponse } from '@ethersproject/abstract-provider';
import { EthereumTransactionEIP1559 } from '@trezor/connect-web';
import {
  concatSig,
  decrypt,
  SignedMsgParams,
  signTypedMessage,
  TypedMessage,
  Version,
  TypedData,
  getEncryptionPublicKey,
  recoverPersonalSignature,
  recoverTypedMessage,
  EthEncryptedData,
} from 'eth-sig-util';
import {
  ecsign,
  toBuffer,
  stripHexPrefix,
  hashPersonalMessage,
  toAscii,
} from 'ethereumjs-util';
import { BigNumber, ethers } from 'ethers';
import { Deferrable } from 'ethers/lib/utils';
import floor from 'lodash/floor';
import omit from 'lodash/omit';

import { LedgerKeyring } from '../ledger';
import { CustomJsonRpcProvider, CustomL2JsonRpcProvider } from '../providers';
import { TrezorKeyring } from '../trezor';
import {
  IResponseFromSendErcSignedTransaction,
  ISendSignedErcTransactionProps,
  ISendTransaction,
  IEthereumTransactions,
  SimpleTransactionRequest,
  KeyringAccountType,
  accountType,
  IGasParams,
} from '../types';
import { INetwork, INetworkType } from '@pollum-io/sysweb3-network';
import {
  createContractUsingAbi,
  getErc20Abi,
  getErc21Abi,
  getErc55Abi,
} from '@pollum-io/sysweb3-utils';

/**
 * Chain IDs for zkSync Era networks that require specialized L2 provider functionality.
 * These networks use CustomL2JsonRpcProvider (which extends zksync-ethers.Provider)
 * instead of CustomJsonRpcProvider.
 *
 * zkSync Era networks:
 * - 324: zkSync Era Mainnet
 * - 300: zkSync Era Sepolia Testnet
 */
const L2_NETWORK_CHAIN_IDS = [324, 300];

export class EthereumTransactions implements IEthereumTransactions {
  private _web3Provider: CustomJsonRpcProvider | CustomL2JsonRpcProvider;
  public trezorSigner: TrezorKeyring;
  public ledgerSigner: LedgerKeyring;
  private getNetwork: () => INetwork;
  private abortController: AbortController;
  private getDecryptedPrivateKey: () => {
    address: string;
    decryptedPrivateKey: string;
  };

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
    getDecryptedPrivateKey: () => {
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
    ledgerSigner: LedgerKeyring,
    trezorSigner: TrezorKeyring
  ) {
    this.getNetwork = getNetwork;
    this.getDecryptedPrivateKey = getDecryptedPrivateKey;
    this.abortController = new AbortController();

    // NOTE: Defer network access until vault state getter is initialized
    // The web3Provider will be created lazily when first accessed via getters

    this.getState = getState;
    this.trezorSigner = trezorSigner;
    this.ledgerSigner = ledgerSigner;
  }

  // Getter that automatically ensures providers are initialized when accessed
  public get web3Provider(): CustomJsonRpcProvider | CustomL2JsonRpcProvider {
    this.ensureProvidersInitialized();
    return this._web3Provider;
  }

  // Helper method to ensure providers are initialized when first needed
  private ensureProvidersInitialized() {
    if (!this._web3Provider) {
      // Providers not initialized yet, initialize them now
      try {
        const currentNetwork = this.getNetwork();
        this.setWeb3Provider(currentNetwork);
      } catch (error) {
        // If vault state not available yet, providers will be initialized later
        // when setWeb3Provider is called explicitly
        console.log(
          '[EthereumTransactions] Deferring provider initialization:',
          error.message
        );
      }
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
    typedData: TypedData | TypedMessage<any>,
    version: Version
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

    const signTypedData = () => {
      if (addr.toLowerCase() !== address.toLowerCase())
        throw {
          message: 'Decrypting for wrong address, change activeAccount maybe',
        };

      const privKey = Buffer.from(stripHexPrefix(decryptedPrivateKey), 'hex');
      return signTypedMessage(privKey, { data: typedData }, version);
    };

    const signTypedDataWithLedger = async () => {
      if (addr.toLowerCase() !== activeAccount.address.toLowerCase())
        throw {
          message: 'Decrypting for wrong address, change activeAccount maybe',
        };
      return await this.ledgerSigner.evm.signTypedData({
        version,
        accountIndex: activeAccountId,
        data: typedData,
      });
    };

    const signTypedDataWithTrezor = async () => {
      if (addr.toLowerCase() !== activeAccount.address.toLowerCase())
        throw {
          message: 'Decrypting for wrong address, change activeAccount maybe',
        };
      return await this.trezorSigner.signTypedData({
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
        return signTypedData();
    }
  };

  verifyTypedSignature = (
    data: TypedData | TypedMessage<any>,
    signature: string,
    version: Version
  ) => {
    try {
      const msgParams: SignedMsgParams<TypedData | TypedMessage<any>> = {
        data,
        sig: signature,
      };
      return recoverTypedMessage(msgParams, version);
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
        const bufPriv = toBuffer(decryptedPrivateKey);

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

        const sig = ecsign(msgHash, bufPriv);
        const resp = concatSig(toBuffer(sig.v), sig.r, sig.s);
        return resp;
      } catch (error) {
        throw error;
      }
    };

    const signWithLedger = async () => {
      try {
        const response = await this.ledgerSigner.evm.signPersonalMessage({
          accountIndex: activeAccountId,
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
        const response: any = await this.trezorSigner.signMessage({
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
        const privateKey = toBuffer(decryptedPrivateKey);

        // Handle both hex-encoded and plain text messages for personal_sign
        let message: Buffer;
        if (msg.startsWith('0x')) {
          // Message is hex-encoded
          try {
            message = toBuffer(msg);
          } catch (error) {
            // If hex parsing fails, treat as plain text
            message = Buffer.from(msg, 'utf8');
          }
        } else {
          // Message is plain text
          message = Buffer.from(msg, 'utf8');
        }

        const msgHash = hashPersonalMessage(message);
        const sig = ecsign(msgHash, privateKey);
        const serialized = concatSig(toBuffer(sig.v), sig.r, sig.s);
        return serialized;
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

        const response = await this.ledgerSigner.evm.signPersonalMessage({
          accountIndex: activeAccountId,
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
        const response: any = await this.trezorSigner.signMessage({
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
      return toAscii(hexMsg);
    } catch (error) {
      throw error;
    }
  };

  verifyPersonalMessage = (message: string, sign: string) => {
    try {
      const msgParams: SignedMsgParams<string> = {
        data: message,
        sig: sign,
      };
      return recoverPersonalSignature(msgParams);
    } catch (error) {
      throw error;
    }
  };

  getEncryptedPubKey = () => {
    const { decryptedPrivateKey } = this.getDecryptedPrivateKey();

    try {
      return getEncryptionPublicKey(stripHexPrefix(decryptedPrivateKey));
    } catch (error) {
      throw error;
    }
  };

  // eth_decryptMessage
  decryptMessage = (msgParams: string[]) => {
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
      const sig = decrypt(cleanData, stripHexPrefix(decryptedPrivateKey));
      return sig;
    } catch (error) {
      throw error;
    }
  };

  toBigNumber = (aBigNumberish: string | number) =>
    ethers.BigNumber.from(String(aBigNumberish));

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
      const data = contract.methods
        .transfer(receivingAddress, value)
        .encodeABI();

      return data;
    } catch (error) {
      throw error;
    }
  };

  getFeeDataWithDynamicMaxPriorityFeePerGas = async () => {
    let maxFeePerGas = this.toBigNumber(0);
    let maxPriorityFeePerGas = this.toBigNumber(0);

    try {
      const block = await this.web3Provider.getBlock('latest');
      if (block && block.baseFeePerGas) {
        try {
          const ethMaxPriorityFee = await this.web3Provider.send(
            'eth_maxPriorityFeePerGas',
            []
          );
          maxPriorityFeePerGas = ethers.BigNumber.from(ethMaxPriorityFee);
          maxFeePerGas = block.baseFeePerGas.mul(2).add(maxPriorityFeePerGas);
        } catch (e) {
          maxPriorityFeePerGas = ethers.BigNumber.from('1500000000');
          maxFeePerGas = block.baseFeePerGas.mul(2).add(maxPriorityFeePerGas);
        }
        return { maxFeePerGas, maxPriorityFeePerGas };
      } else if (block && !block.baseFeePerGas) {
        console.error('Chain doesnt support EIP1559');
        return { maxFeePerGas, maxPriorityFeePerGas };
      } else if (!block) throw new Error('Block not found');

      return { maxFeePerGas, maxPriorityFeePerGas };
    } catch (error) {
      console.error(error);
      return { maxFeePerGas, maxPriorityFeePerGas };
    }
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
      const calculateValue = String(feeValue * multiplierToUse);

      const convertValueToHex =
        '0x' + parseInt(calculateValue, 10).toString(16);

      return ethers.BigNumber.from(convertValueToHex);
    };

    const maxFeePerGasToNumber = maxFeePerGas?.toNumber();
    const maxPriorityFeePerGasToNumber = maxPriorityFeePerGas?.toNumber();
    const gasLimitToNumber = gasLimit?.toNumber();
    const gasPriceToNumber = gasPrice?.toNumber();

    const multiplierToUse = 1.2; //The same calculation we used in the edit fee modal, always using the 0.2 multiplier

    if (!isLegacy) {
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
      const DEFAULT_GAS_LIMIT_VALUE = '21000';

      const convertToHex =
        '0x' + parseInt(DEFAULT_GAS_LIMIT_VALUE, 10).toString(16);

      newGasValues.gasLimit = ethers.BigNumber.from(convertToHex);
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
    isLegacy?: boolean
  ): Promise<{
    error?: boolean;
    isCanceled: boolean;
    transaction?: TransactionResponse;
  }> => {
    const tx = (await this.web3Provider.getTransaction(
      txHash
    )) as Deferrable<ethers.providers.TransactionResponse>;

    if (!tx) {
      //If we don't find the TX or is already confirmed we send as error true to show this message
      //in the alert at Pali
      return {
        isCanceled: false,
        error: true,
      };
    }

    const { decryptedPrivateKey } = this.getDecryptedPrivateKey();
    const wallet = new ethers.Wallet(decryptedPrivateKey, this.web3Provider);

    let changedTxToCancel: Deferrable<ethers.providers.TransactionRequest>;

    const oldTxsGasValues: IGasParams = {
      maxFeePerGas: tx.maxFeePerGas as BigNumber,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas as BigNumber,
      gasPrice: tx.gasPrice as BigNumber,
      gasLimit: tx.gasLimit as BigNumber,
    };

    if (!isLegacy) {
      const newGasValues = this.calculateNewGasValues(
        oldTxsGasValues,
        true,
        false
      );

      //We have to send another TX using the same nonce but we can use the From and To for the same address and also
      //the value as 0
      changedTxToCancel = {
        nonce: tx.nonce,
        from: wallet.address,
        to: wallet.address,
        value: ethers.constants.Zero,
        maxFeePerGas: newGasValues.maxFeePerGas,
        maxPriorityFeePerGas: newGasValues.maxPriorityFeePerGas,
        gasLimit: newGasValues.gasLimit,
      };
    } else {
      const newGasValues = this.calculateNewGasValues(
        oldTxsGasValues,
        true,
        true
      );
      //We have to send another TX using the same nonce but we can use the From and To for the same address and also
      //the value as 0
      changedTxToCancel = {
        nonce: tx.nonce,
        from: wallet.address,
        to: wallet.address,
        value: ethers.constants.Zero,
        gasLimit: newGasValues.gasLimit,
        gasPrice: newGasValues.gasPrice,
      };
    }

    const cancelTransaction = async () => {
      try {
        const transactionResponse = await wallet.sendTransaction(
          changedTxToCancel
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
        //If we don't find the TX or is already confirmed we send as error true to show this message
        //in the alert at Pali
        return {
          isCanceled: false,
          error: true,
        };
      }
    };

    return await cancelTransaction();
  };
  //TODO: This function needs to be refactored
  sendFormattedTransaction = async (
    params: SimpleTransactionRequest,
    isLegacy?: boolean
  ) => {
    const { activeAccountType, activeAccountId, accounts, activeNetwork } =
      this.getState();
    const activeAccount = accounts[activeAccountType][activeAccountId];

    const sendEVMLedgerTransaction = async () => {
      const transactionNonce = await this.getRecommendedNonce(
        activeAccount.address
      );
      const formatParams = omit(params, 'from'); //From is not needed we're already passing in the HD derivation path so it can be inferred
      const txFormattedForEthers = isLegacy
        ? {
            ...formatParams,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
          }
        : {
            ...formatParams,
            nonce: transactionNonce,
            chainId: activeNetwork.chainId,
            type: 2,
          };
      const rawTx = ethers.utils.serializeTransaction(txFormattedForEthers);

      const signature = await this.ledgerSigner.evm.signEVMTransaction({
        rawTx: rawTx.replace('0x', ''),
        accountIndex: activeAccountId,
      });

      const formattedSignature = {
        r: `0x${signature.r}`,
        s: `0x${signature.s}`,
        v: parseInt(signature.v, 16),
      };

      if (signature) {
        try {
          const signedTx = ethers.utils.serializeTransaction(
            txFormattedForEthers,
            formattedSignature
          );
          const finalTx = await this.web3Provider.sendTransaction(signedTx);

          return finalTx;
        } catch (error) {
          throw error;
        }
      } else {
        throw new Error(`Transaction Signature Failed. Error: ${signature}`);
      }
    };

    const sendEVMTrezorTransaction = async () => {
      const transactionNonce = await this.getRecommendedNonce(
        activeAccount.address
      );
      let txFormattedForTrezor = {};
      const formatParams = omit(params, 'from'); //From is not needed we're already passing in the HD derivation path so it can be inferred
      switch (isLegacy) {
        case true:
          txFormattedForTrezor = {
            ...formatParams,
            gasLimit:
              typeof formatParams.gasLimit === 'string'
                ? formatParams.gasLimit
                : // @ts-ignore
                  `${params.gasLimit.hex}`,
            value:
              typeof formatParams.value === 'string' ||
              typeof formatParams.value === 'number'
                ? `${formatParams.value}`
                : // @ts-ignore
                  `${params.value.hex}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
          };
          break;
        case false:
          txFormattedForTrezor = {
            ...formatParams,
            gasLimit:
              typeof formatParams.gasLimit === 'string'
                ? formatParams.gasLimit
                : // @ts-ignore
                  `${params.gasLimit.hex}`,
            maxFeePerGas:
              typeof formatParams.maxFeePerGas === 'string'
                ? formatParams.maxFeePerGas
                : // @ts-ignore
                  `${params.maxFeePerGas.hex}`,
            maxPriorityFeePerGas:
              typeof formatParams.maxPriorityFeePerGas === 'string'
                ? formatParams.maxPriorityFeePerGas
                : // @ts-ignore
                  `${params.maxPriorityFeePerGas.hex}`,
            value:
              typeof formatParams.value === 'string' ||
              typeof formatParams.value === 'number'
                ? `${formatParams.value}`
                : // @ts-ignore
                  `${params.value.hex}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
          };
          break;
        default:
          txFormattedForTrezor = {
            ...formatParams,
            gasLimit:
              typeof formatParams.gasLimit === 'string'
                ? formatParams.gasLimit
                : // @ts-ignore
                  `${params.gasLimit.hex}`,
            maxFeePerGas:
              typeof formatParams.maxFeePerGas === 'string'
                ? formatParams.maxFeePerGas
                : // @ts-ignore
                  `${params.maxFeePerGas.hex}`,
            maxPriorityFeePerGas:
              typeof formatParams.maxPriorityFeePerGas === 'string'
                ? formatParams.maxPriorityFeePerGas
                : // @ts-ignore
                  `${params.maxPriorityFeePerGas.hex}`,
            value:
              typeof formatParams.value === 'string' ||
              typeof formatParams.value === 'number'
                ? `${formatParams.value}`
                : // @ts-ignore
                  `${params.value.hex}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
          };
          break;
      }

      const signature = await this.trezorSigner.signEthTransaction({
        index: `${activeAccountId}`,
        tx: txFormattedForTrezor as EthereumTransactionEIP1559,
        coin: activeNetwork.currency,
        slip44: activeNetwork.slip44,
      });
      if (signature.success) {
        try {
          const txFormattedForEthers = isLegacy
            ? {
                ...formatParams,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
              }
            : {
                ...formatParams,
                nonce: transactionNonce,
                chainId: activeNetwork.chainId,
                type: 2,
              };
          signature.payload.v = parseInt(signature.payload.v, 16); //v parameter must be a number by ethers standards
          const signedTx = ethers.utils.serializeTransaction(
            txFormattedForEthers,
            signature.payload
          );
          const finalTx = await this.web3Provider.sendTransaction(signedTx);

          return finalTx;
        } catch (error) {
          throw error;
        }
      } else {
        throw new Error(`Transaction Signature Failed. Error: ${signature}`);
      }
    };

    const sendEVMTransaction = async () => {
      const { address, decryptedPrivateKey } = this.getDecryptedPrivateKey();

      // Validate that we have the correct private key for the active account to prevent race conditions
      // This is critical for transaction security during account switches
      if (address.toLowerCase() !== activeAccount.address.toLowerCase()) {
        throw new Error(
          `Account state mismatch detected during transaction. Expected ${activeAccount.address} but got ${address}. Please wait for account switching to complete and try again.`
        );
      }

      const tx: Deferrable<ethers.providers.TransactionRequest> = params;
      const wallet = new ethers.Wallet(decryptedPrivateKey, this.web3Provider);
      try {
        const transaction = await wallet.sendTransaction(tx);
        const response = await this.web3Provider.getTransaction(
          transaction.hash
        );
        //TODO: more precisely on this lines
        if (!response) {
          return await this.getTransactionTimestamp(transaction);
        } else {
          return await this.getTransactionTimestamp(response);
        }
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
    isLegacy?: boolean
  ): Promise<{
    error?: boolean;
    isSpeedUp: boolean;
    transaction?: TransactionResponse;
  }> => {
    const tx = (await this.web3Provider.getTransaction(
      txHash
    )) as Deferrable<ethers.providers.TransactionResponse>;

    if (!tx) {
      return {
        isSpeedUp: false,
        error: true,
      };
    }

    const { decryptedPrivateKey, address } = this.getDecryptedPrivateKey();
    const wallet = new ethers.Wallet(decryptedPrivateKey, this.web3Provider);

    // Check if this might be a max send transaction by comparing total cost to balance
    const currentBalance = await this.web3Provider.getBalance(address);

    // Ensure all transaction values are resolved from promises
    const gasLimit = await Promise.resolve(tx.gasLimit);
    const gasPrice = await Promise.resolve(tx.gasPrice || 0);
    const maxFeePerGas = await Promise.resolve(tx.maxFeePerGas || 0);
    const maxPriorityFeePerGas = await Promise.resolve(
      tx.maxPriorityFeePerGas || 0
    );
    const txValue = await Promise.resolve(tx.value);
    const txData = await Promise.resolve(tx.data || '0x');

    // Check if this is a contract call (has data)
    const isContractCall = txData && txData !== '0x' && txData.length > 2;

    const originalGasCost = isLegacy
      ? gasLimit.mul(gasPrice || 0)
      : gasLimit.mul(maxFeePerGas || 0);
    const originalTotalCost = txValue.add(originalGasCost);

    // If original transaction used >95% of balance, it's likely a max send
    const balanceThreshold = currentBalance.mul(95).div(100);
    const isLikelyMaxSend = originalTotalCost.gt(balanceThreshold);

    let txWithEditedFee: Deferrable<ethers.providers.TransactionRequest>;

    const oldTxsGasValues: IGasParams = {
      maxFeePerGas: maxFeePerGas as BigNumber,
      maxPriorityFeePerGas: maxPriorityFeePerGas as BigNumber,
      gasPrice: gasPrice as BigNumber,
      gasLimit: gasLimit as BigNumber,
    };

    if (!isLegacy) {
      const newGasValues = this.calculateNewGasValues(
        oldTxsGasValues,
        false,
        false
      );

      let adjustedValue = txValue;

      // For likely max sends, check if we need to adjust value
      if (
        isLikelyMaxSend &&
        newGasValues.gasLimit &&
        newGasValues.maxFeePerGas
      ) {
        const newGasCost = newGasValues.gasLimit.mul(newGasValues.maxFeePerGas);
        const newTotalCost = txValue.add(newGasCost);

        if (newTotalCost.gt(currentBalance)) {
          // If this is a contract call, we cannot adjust the value
          if (isContractCall) {
            console.error(
              '[SpeedUp] Cannot adjust value for contract call - rejecting speedup'
            );
            return {
              isSpeedUp: false,
              error: true,
            };
          }

          // For non-contract calls, reduce value to fit within balance
          adjustedValue = currentBalance.sub(newGasCost);

          // Ensure we don't go below a minimum threshold (0.0001 ETH)
          const minValue = ethers.utils.parseEther('0.0001');
          if (adjustedValue.lt(minValue)) {
            console.warn('[SpeedUp] Adjusted value too low, keeping original');
            adjustedValue = txValue;
          }
        }
      }

      txWithEditedFee = {
        from: tx.from,
        to: tx.to,
        nonce: tx.nonce,
        value: adjustedValue,
        data: txData,
        maxFeePerGas: newGasValues.maxFeePerGas,
        maxPriorityFeePerGas: newGasValues.maxPriorityFeePerGas,
        gasLimit: newGasValues.gasLimit,
      };
    } else {
      const newGasValues = this.calculateNewGasValues(
        oldTxsGasValues,
        false,
        true
      );

      let adjustedValue = txValue;

      // For likely max sends, check if we need to adjust value
      if (isLikelyMaxSend && newGasValues.gasLimit && newGasValues.gasPrice) {
        const newGasCost = newGasValues.gasLimit.mul(newGasValues.gasPrice);
        const newTotalCost = txValue.add(newGasCost);

        if (newTotalCost.gt(currentBalance)) {
          // If this is a contract call, we cannot adjust the value
          if (isContractCall) {
            console.error(
              '[SpeedUp] Cannot adjust value for contract call - rejecting speedup'
            );
            return {
              isSpeedUp: false,
              error: true,
            };
          }

          // For non-contract calls, reduce value to fit within balance
          adjustedValue = currentBalance.sub(newGasCost);

          // Ensure we don't go below a minimum threshold (0.0001 ETH)
          const minValue = ethers.utils.parseEther('0.0001');
          if (adjustedValue.lt(minValue)) {
            console.warn('[SpeedUp] Adjusted value too low, keeping original');
            adjustedValue = txValue;
          }
        }
      }

      txWithEditedFee = {
        from: tx.from,
        to: tx.to,
        nonce: tx.nonce,
        value: adjustedValue,
        data: txData,
        gasLimit: newGasValues.gasLimit,
        gasPrice: newGasValues.gasPrice,
      };
    }

    const sendEditedTransaction = async () => {
      try {
        const transactionResponse = await wallet.sendTransaction(
          txWithEditedFee
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
        //If we don't find the TX or is already confirmed we send as error true to show this message
        //in the alert at Pali
        return {
          isSpeedUp: false,
          error: true,
        };
      }
    };

    return await sendEditedTransaction();
  };
  // TODO: refactor this function
  sendTransaction = async ({
    sender,
    receivingAddress,
    amount,
    gasLimit,
    token,
  }: ISendTransaction): Promise<TransactionResponse> => {
    const tokenDecimals = token && token.decimals ? token.decimals : 18;
    const decimals = this.toBigNumber(tokenDecimals);

    const parsedAmount = ethers.utils.parseEther(String(amount));

    const { decryptedPrivateKey } = this.getDecryptedPrivateKey();

    const wallet = new ethers.Wallet(decryptedPrivateKey, this.web3Provider);

    const value =
      token && token.contract_address
        ? parsedAmount.mul(this.toBigNumber('10').pow(decimals))
        : parsedAmount;

    const data =
      token && token.contract_address
        ? this.getData({
            contractAddress: token.contract_address,
            receivingAddress,
            value,
          })
        : null;

    // gas price, gas limit e maxPriorityFeePerGas (tip)
    const { maxFeePerGas, maxPriorityFeePerGas } =
      await this.getFeeDataWithDynamicMaxPriorityFeePerGas();

    const tx: Deferrable<ethers.providers.TransactionRequest> = {
      to: receivingAddress,
      value,
      maxPriorityFeePerGas,
      maxFeePerGas,
      nonce: await this.web3Provider.getTransactionCount(sender, 'latest'),
      type: 2,
      chainId: this.web3Provider.network.chainId,
      gasLimit: this.toBigNumber(0) || gasLimit,
      data,
    };

    tx.gasLimit = await this.web3Provider.estimateGas(tx);

    try {
      const transaction = await wallet.sendTransaction(tx);
      const response = await this.web3Provider.getTransaction(transaction.hash);
      if (!response) {
        return await this.getTransactionTimestamp(transaction);
      } else {
        return await this.getTransactionTimestamp(response);
      }
    } catch (error) {
      throw error;
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
    const { decryptedPrivateKey } = this.getDecryptedPrivateKey();
    const { accounts, activeAccountType, activeAccountId, activeNetwork } =
      this.getState();
    const { address: activeAccountAddress } =
      accounts[activeAccountType][activeAccountId];

    const sendERC20Token = async () => {
      const currentWallet = new ethers.Wallet(decryptedPrivateKey);

      const walletSigned = currentWallet.connect(this.web3Provider);

      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc20Abi(),
          walletSigned
        );
        const calculatedTokenAmount = ethers.BigNumber.from(
          decimals
            ? ethers.utils.parseUnits(
                tokenAmount as string,
                this.toBigNumber(decimals as number)
              )
            : ethers.utils.parseEther(tokenAmount as string)
        );
        let transferMethod;
        if (isLegacy) {
          const overrides = {
            nonce: await this.web3Provider.getTransactionCount(
              walletSigned.address,
              'pending'
            ),
            gasPrice,
            ...(gasLimit && { gasLimit }),
          };
          transferMethod = await _contract.transfer(
            receiver,
            calculatedTokenAmount,
            overrides
          );
        } else {
          const overrides = {
            nonce: await this.web3Provider.getTransactionCount(
              walletSigned.address,
              'pending'
            ),
            maxPriorityFeePerGas,
            maxFeePerGas,
            ...(gasLimit && { gasLimit }),
          };

          transferMethod = await _contract.transfer(
            receiver,
            calculatedTokenAmount,
            overrides
          );
        }

        return transferMethod;
      } catch (error) {
        throw error;
      }
    };

    const sendERC20TokenOnLedger = async () => {
      const signer = this.web3Provider.getSigner(activeAccountAddress);
      const transactionNonce = await this.getRecommendedNonce(
        activeAccountAddress
      );
      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc20Abi(),
          signer
        );

        const calculatedTokenAmount = ethers.BigNumber.from(
          ethers.utils.parseEther(tokenAmount as string)
        );

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
            type: 2,
          };
        }

        const rawTx = ethers.utils.serializeTransaction(txFormattedForEthers);

        const signature = await this.ledgerSigner.evm.signEVMTransaction({
          rawTx: rawTx.replace('0x', ''),
          accountIndex: activeAccountId,
        });

        const formattedSignature = {
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: parseInt(signature.v, 16),
        };
        if (signature) {
          try {
            const signedTx = ethers.utils.serializeTransaction(
              txFormattedForEthers,
              formattedSignature
            );
            const finalTx = await this.web3Provider.sendTransaction(signedTx);

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
      const signer = this.web3Provider.getSigner(activeAccountAddress);
      const transactionNonce = await this.getRecommendedNonce(
        activeAccountAddress
      );
      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc20Abi(),
          signer
        );

        const calculatedTokenAmount = ethers.BigNumber.from(
          ethers.utils.parseEther(tokenAmount as string)
        );

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
            // @ts-ignore
            gasLimit: `${effectiveGasLimit.hex}`,
            // @ts-ignore
            gasPrice: `${gasPrice}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        } else {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            // @ts-ignore
            gasLimit: `${effectiveGasLimit.hex}`,
            // @ts-ignore
            maxFeePerGas: `${maxFeePerGas.hex}`,
            // @ts-ignore
            maxPriorityFeePerGas: `${maxPriorityFeePerGas.hex}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        }

        const signature = await this.trezorSigner.signEthTransaction({
          index: `${activeAccountId}`,
          tx: txToBeSignedByTrezor,
          coin: activeNetwork.currency,
          slip44: activeNetwork.slip44,
        });

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
                type: 2,
              };
            }
            signature.payload.v = parseInt(signature.payload.v, 16); //v parameter must be a number by ethers standards
            const signedTx = ethers.utils.serializeTransaction(
              txFormattedForEthers,
              signature.payload
            );
            const finalTx = await this.web3Provider.sendTransaction(signedTx);

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
        return await sendERC20Token();
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
    const { decryptedPrivateKey } = this.getDecryptedPrivateKey();
    const { accounts, activeAccountType, activeAccountId, activeNetwork } =
      this.getState();
    const { address: activeAccountAddress } =
      accounts[activeAccountType][activeAccountId];

    const sendERC721Token = async () => {
      const currentWallet = new ethers.Wallet(decryptedPrivateKey);
      const walletSigned = currentWallet.connect(this.web3Provider);
      let transferMethod;
      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc21Abi(),
          walletSigned
        );

        if (isLegacy) {
          const overrides = {
            nonce: await this.web3Provider.getTransactionCount(
              walletSigned.address,
              'pending'
            ),
            gasPrice,
            ...(gasLimit && { gasLimit }),
          };
          transferMethod = await _contract.transferFrom(
            walletSigned.address,
            receiver,
            tokenId as number,
            overrides
          );
        } else {
          const overrides = {
            nonce: await this.web3Provider.getTransactionCount(
              walletSigned.address,
              'pending'
            ),
          };
          transferMethod = await _contract.transferFrom(
            walletSigned.address,
            receiver,
            tokenId as number,
            overrides
          );
        }

        return transferMethod;
      } catch (error) {
        throw error;
      }
    };

    const sendERC721TokenOnLedger = async () => {
      const signer = this.web3Provider.getSigner(activeAccountAddress);
      const transactionNonce = await this.getRecommendedNonce(
        activeAccountAddress
      );
      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc21Abi(),
          signer
        );
        const txData = _contract.interface.encodeFunctionData('transferFrom', [
          activeAccountAddress,
          receiver,
          tokenId,
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
            type: 2,
          };
        }

        const rawTx = ethers.utils.serializeTransaction(txFormattedForEthers);

        const signature = await this.ledgerSigner.evm.signEVMTransaction({
          rawTx: rawTx.replace('0x', ''),
          accountIndex: activeAccountId,
        });

        const formattedSignature = {
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: parseInt(signature.v, 16),
        };

        if (signature) {
          try {
            const signedTx = ethers.utils.serializeTransaction(
              txFormattedForEthers,
              formattedSignature
            );
            const finalTx = await this.web3Provider.sendTransaction(signedTx);

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
      const signer = this.web3Provider.getSigner(activeAccountAddress);
      const transactionNonce = await this.getRecommendedNonce(
        activeAccountAddress
      );
      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc21Abi(),
          signer
        );
        const txData = _contract.interface.encodeFunctionData('transferFrom', [
          activeAccountAddress,
          receiver,
          tokenId,
        ]);

        // Use fallback gas limit if not provided (for auto-estimation)
        const effectiveGasLimit = gasLimit || this.toBigNumber('150000'); // ERC721 fallback

        let txToBeSignedByTrezor;
        if (isLegacy) {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            // @ts-ignore
            gasLimit: `${effectiveGasLimit.hex}`,
            // @ts-ignore
            gasPrice: `${gasPrice}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
          console.log({ txToBeSignedByTrezor });
        } else {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            // @ts-ignore
            gasLimit: `${effectiveGasLimit.hex}`,
            // @ts-ignore
            maxFeePerGas: `${maxFeePerGas.hex}`,
            // @ts-ignore
            maxPriorityFeePerGas: `${maxPriorityFeePerGas.hex}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        }

        // For EVM networks, Trezor expects 'eth' regardless of the network's currency
        const trezorCoin =
          activeNetwork.slip44 === 60 ? 'eth' : activeNetwork.currency;
        const signature = await this.trezorSigner.signEthTransaction({
          index: `${activeAccountId}`,
          tx: txToBeSignedByTrezor,
          coin: trezorCoin,
          slip44: activeNetwork.slip44,
        });

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
                type: 2,
              };
            }
            signature.payload.v = parseInt(signature.payload.v, 16); //v parameter must be a number by ethers standards
            const signedTx = ethers.utils.serializeTransaction(
              txFormattedForEthers,
              signature.payload
            );
            const finalTx = await this.web3Provider.sendTransaction(signedTx);

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
        return await sendERC721Token();
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
    const { decryptedPrivateKey } = this.getDecryptedPrivateKey();
    const { accounts, activeAccountType, activeAccountId, activeNetwork } =
      this.getState();
    const { address: activeAccountAddress } =
      accounts[activeAccountType][activeAccountId];

    const sendERC1155Token = async () => {
      const currentWallet = new ethers.Wallet(decryptedPrivateKey);
      const walletSigned = currentWallet.connect(this.web3Provider);
      let transferMethod;
      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc55Abi(),
          walletSigned
        );

        const amount = tokenAmount ? parseInt(tokenAmount) : 1;

        const overrides = {};

        transferMethod = await _contract.safeTransferFrom(
          walletSigned.address,
          receiver,
          tokenId as number,
          amount,
          [],
          overrides
        );
        return transferMethod;
      } catch (error) {
        throw error;
      }
    };

    const sendERC1155TokenOnLedger = async () => {
      const signer = this.web3Provider.getSigner(activeAccountAddress);
      const transactionNonce = await this.getRecommendedNonce(
        activeAccountAddress
      );
      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc55Abi(),
          signer
        );

        const amount = tokenAmount ? parseInt(tokenAmount) : 1;

        const txData = _contract.interface.encodeFunctionData(
          'safeTransferFrom',
          [activeAccountAddress, receiver, tokenId, amount, []]
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
            type: 2,
          };
        }

        const rawTx = ethers.utils.serializeTransaction(txFormattedForEthers);

        const signature = await this.ledgerSigner.evm.signEVMTransaction({
          rawTx: rawTx.replace('0x', ''),
          accountIndex: activeAccountId,
        });

        const formattedSignature = {
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: parseInt(signature.v, 16),
        };

        if (signature) {
          try {
            const signedTx = ethers.utils.serializeTransaction(
              txFormattedForEthers,
              formattedSignature
            );
            const finalTx = await this.web3Provider.sendTransaction(signedTx);

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
      const signer = this.web3Provider.getSigner(activeAccountAddress);
      const transactionNonce = await this.getRecommendedNonce(
        activeAccountAddress
      );
      try {
        const _contract = new ethers.Contract(
          tokenAddress,
          getErc55Abi(),
          signer
        );

        const amount = tokenAmount ? parseInt(tokenAmount) : 1;

        const txData = _contract.interface.encodeFunctionData(
          'safeTransferFrom',
          [activeAccountAddress, receiver, tokenId, amount, []]
        );

        // Use fallback gas limit if not provided (for auto-estimation)
        const effectiveGasLimit = gasLimit || this.toBigNumber('200000'); // ERC1155 fallback

        let txToBeSignedByTrezor;
        if (isLegacy) {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            // @ts-ignore
            gasLimit: `${effectiveGasLimit.hex}`,
            // @ts-ignore
            gasPrice: `${gasPrice}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        } else {
          txToBeSignedByTrezor = {
            to: tokenAddress,
            value: '0x0',
            // @ts-ignore
            gasLimit: `${effectiveGasLimit.hex}`,
            // @ts-ignore
            maxFeePerGas: `${maxFeePerGas.hex}`,
            // @ts-ignore
            maxPriorityFeePerGas: `${maxPriorityFeePerGas.hex}`,
            nonce: this.toBigNumber(transactionNonce)._hex,
            chainId: activeNetwork.chainId,
            data: txData,
          };
        }

        const signature = await this.trezorSigner.signEthTransaction({
          index: `${activeAccountId}`,
          tx: txToBeSignedByTrezor,
          coin: activeNetwork.currency,
          slip44: activeNetwork.slip44,
        });

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
                type: 2,
              };
            }
            signature.payload.v = parseInt(signature.payload.v, 16); //v parameter must be a number by ethers standards
            const signedTx = ethers.utils.serializeTransaction(
              txFormattedForEthers,
              signature.payload
            );
            const finalTx = await this.web3Provider.sendTransaction(signedTx);

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
        return await sendERC1155Token();
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
      .mul(ethers.BigNumber.from('8'))
      .div(ethers.BigNumber.from('10'))
      .toString();

    const high = this.toBigNumber(gasPrice)
      .mul(ethers.BigNumber.from('11'))
      .div(ethers.BigNumber.from('10'))
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

      return Number(ethers.utils.formatUnits(estimated, 'gwei'));
    } catch (error) {
      throw error;
    }
  };

  getTxGasLimit = async (tx: SimpleTransactionRequest) => {
    try {
      return this.web3Provider.estimateGas(tx);
    } catch (error) {
      throw error;
    }
  };

  getRecommendedGasPrice = async (formatted?: boolean) => {
    try {
      const gasPriceBN = await this.web3Provider.getGasPrice();

      if (formatted) {
        return {
          gwei: Number(ethers.utils.formatUnits(gasPriceBN, 'gwei')).toFixed(2),
          ethers: ethers.utils.formatEther(gasPriceBN),
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
      const formattedBalance = ethers.utils.formatEther(balance);

      const roundedBalance = floor(parseFloat(formattedBalance), 4);

      return roundedBalance;
    } catch (error) {
      throw error;
    }
  };

  private getTransactionTimestamp = async (
    transaction: TransactionResponse
  ) => {
    const { timestamp } = await this.web3Provider.getBlock(
      Number(transaction.blockNumber)
    );

    return {
      ...transaction,
      timestamp,
    } as TransactionResponse;
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
    } else {
      // For EVM networks, create normal providers
      const isL2Network = L2_NETWORK_CHAIN_IDS.includes(network.chainId);

      const CurrentProvider = isL2Network
        ? CustomL2JsonRpcProvider
        : CustomJsonRpcProvider;

      this._web3Provider = new CurrentProvider(
        this.abortController.signal,
        network.url
      );
    }
  }

  public importAccount = (mnemonicOrPrivKey: string) => {
    if (ethers.utils.isHexString(mnemonicOrPrivKey)) {
      return new ethers.Wallet(mnemonicOrPrivKey);
    }

    const { privateKey } = ethers.Wallet.fromMnemonic(mnemonicOrPrivKey);

    const account = new ethers.Wallet(privateKey);

    return account;
  };
}

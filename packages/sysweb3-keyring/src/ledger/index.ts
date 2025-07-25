/* eslint-disable camelcase */
/* eslint-disable import/no-named-as-default */
/* eslint-disable import/order */
import Transport from '@ledgerhq/hw-transport';
import SysUtxoClient, { DefaultWalletPolicy } from './bitcoin_client';
import {
  DESCRIPTOR,
  RECEIVING_ADDRESS_INDEX,
  WILL_NOT_DISPLAY,
} from './consts';
import { fromBase58 } from '@trezor/utxo-lib/lib/bip32';
import { IEvmMethods, IUTXOMethods, MessageTypes } from './types';
import LedgerEthClient, { ledgerService } from '@ledgerhq/hw-app-eth';
import { TypedDataUtils, TypedMessage, Version } from 'eth-sig-util';
import {
  getAccountDerivationPath,
  getAddressDerivationPath,
  isEvmCoin,
} from '../utils/derivation-paths';
import { Transaction } from 'syscoinjs-lib';
import {
  HardwareWalletManager,
  HardwareWalletType,
} from '../hardware-wallet-manager';

export class LedgerKeyring {
  public ledgerEVMClient!: LedgerEthClient;
  public ledgerUtxoClient!: SysUtxoClient;
  private hdPath = "m/44'/57'/0'/0/0";
  public evm: IEvmMethods;
  public utxo: IUTXOMethods;
  public transport: Transport | null = null;
  private hardwareWalletManager: HardwareWalletManager;

  constructor() {
    this.hardwareWalletManager = new HardwareWalletManager();

    // Set up event listeners
    this.hardwareWalletManager.on('connected', ({ type }) => {
      if (type === HardwareWalletType.LEDGER) {
        console.log('Ledger connected');
      }
    });

    this.hardwareWalletManager.on('disconnected', ({ type }) => {
      if (type === HardwareWalletType.LEDGER) {
        console.log('Ledger disconnected');
        this.transport = null;
        // Clear clients on disconnect
        this.ledgerEVMClient = null as any;
        this.ledgerUtxoClient = null as any;
      }
    });

    this.hardwareWalletManager.on('connectionFailed', ({ type, error }) => {
      if (type === HardwareWalletType.LEDGER) {
        console.error('Ledger connection failed:', error);
      }
    });

    this.evm = {
      getEvmAddressAndPubKey: this.getEvmAddressAndPubKey,
      signEVMTransaction: this.signEVMTransaction,
      signPersonalMessage: this.signPersonalMessage,
      signTypedData: this.signTypedData,
    };

    this.utxo = {
      getUtxoAddress: this.getUtxoAddress,
      getXpub: this.getXpub,
      verifyUtxoAddress: this.verifyUtxoAddress,
    };
  }

  /**
   * Ensure Ledger is connected with automatic retry
   * Note: This is automatically called by all operations through executeWithRetry
   * External callers don't need to call this directly
   */
  public async ensureConnection(): Promise<void> {
    await this.hardwareWalletManager.ensureConnection(
      HardwareWalletType.LEDGER
    );
    this.transport = await this.hardwareWalletManager.getLedgerConnection();

    // Create clients if transport is available
    if (this.transport && (!this.ledgerEVMClient || !this.ledgerUtxoClient)) {
      this.ledgerEVMClient = new LedgerEthClient(this.transport);
      this.ledgerUtxoClient = new SysUtxoClient(this.transport);
    }
  }

  private getUtxoAddress = async ({
    coin,
    index, // account index
    slip44,
    showInLedger,
  }: {
    coin: string;
    index: number;
    showInLedger?: boolean;
    slip44: number;
  }) => {
    return this.executeWithRetry(async () => {
      const fingerprint = await this.ledgerUtxoClient.getMasterFingerprint();
      const xpub = await this.getXpub({ index, coin, slip44 });
      this.setHdPath(coin, index, slip44);

      const xpubWithDescriptor = `[${this.hdPath}]${xpub}`.replace(
        'm',
        fingerprint
      );
      const walletPolicy = new DefaultWalletPolicy(
        DESCRIPTOR,
        xpubWithDescriptor
      );

      const address = await this.ledgerUtxoClient.getWalletAddress(
        walletPolicy,
        null,
        RECEIVING_ADDRESS_INDEX,
        index,
        showInLedger ? showInLedger : WILL_NOT_DISPLAY
      );

      return address;
    }, 'getUtxoAddress');
  };

  public verifyUtxoAddress = async (
    accountIndex: number,
    currency: string,
    slip44: number
  ) =>
    await this.getUtxoAddress({
      coin: currency,
      index: accountIndex,
      slip44: slip44,
      showInLedger: true,
    });

  private getXpub = async ({
    index,
    coin,
    slip44,
  }: {
    coin: string;
    index: number;
    slip44: number;
  }): Promise<string> => {
    return this.executeWithRetry(async () => {
      this.setHdPath(coin, index, slip44);
      const xpub = await this.ledgerUtxoClient.getExtendedPubkey(
        this.hdPath,
        WILL_NOT_DISPLAY
      );

      // Always return raw xpub - descriptor format is built inline where needed
      return xpub;
    }, 'getXpub');
  };

  /**
   * Sign a UTXO message - public method used by transaction classes
   */
  public signUtxoMessage = async (path: string, message: string) => {
    return this.executeWithRetry(async () => {
      const bufferMessage = Buffer.from(message);
      const signature = await this.ledgerUtxoClient.signMessage(
        bufferMessage,
        path
      );
      return signature;
    }, 'signUtxoMessage');
  };

  private signEVMTransaction = async ({
    rawTx,
    accountIndex,
  }: {
    accountIndex: number;
    rawTx: string;
  }) => {
    return this.executeWithRetry(async () => {
      this.setHdPath('eth', accountIndex, 60);
      const resolution = await ledgerService.resolveTransaction(rawTx, {}, {});

      const signature = await this.ledgerEVMClient.signTransaction(
        this.hdPath.replace(/^m\//, ''), // Remove 'm/' prefix for EVM
        rawTx,
        resolution
      );

      return signature;
    }, 'signEVMTransaction');
  };

  private signPersonalMessage = async ({
    message,
    accountIndex,
  }: {
    accountIndex: number;
    message: string;
  }) => {
    return this.executeWithRetry(async () => {
      this.setHdPath('eth', accountIndex, 60);

      const signature = await this.ledgerEVMClient.signPersonalMessage(
        this.hdPath.replace(/^m\//, ''), // Remove 'm/' prefix for EVM
        message
      );

      return `0x${signature.r}${signature.s}${signature.v.toString(16)}`;
    }, 'signPersonalMessage');
  };

  private sanitizeData(data: any): any {
    switch (Object.prototype.toString.call(data)) {
      case '[object Object]': {
        const entries = Object.keys(data).map((k) => [
          k,
          this.sanitizeData(data[k]),
        ]);
        return Object.fromEntries(entries);
      }

      case '[object Array]':
        return data.map((v: any[]) => this.sanitizeData(v));

      case '[object BigInt]':
        return data.toString();

      default:
        return data;
    }
  }

  private transformTypedData = <T extends MessageTypes>(
    data: TypedMessage<T>,
    metamaskV4Compat: boolean
  ) => {
    if (!metamaskV4Compat) {
      throw new Error(
        'Ledger: Only version 4 of typed data signing is supported'
      );
    }

    const { types, primaryType, domain, message } = this.sanitizeData(data);

    const domainSeparatorHash = TypedDataUtils.hashStruct(
      'EIP712Domain',
      this.sanitizeData(domain),
      types,
      true
    ).toString('hex');

    let messageHash: string | null = null;

    if (primaryType !== 'EIP712Domain') {
      messageHash = TypedDataUtils.hashStruct(
        primaryType as string,
        this.sanitizeData(message),
        types,
        true
      ).toString('hex');
    }

    return {
      domain_separator_hash: domainSeparatorHash,
      message_hash: messageHash,
      ...data,
    };
  };

  private getEvmAddressAndPubKey = async ({
    accountIndex,
  }: {
    accountIndex: number;
  }): Promise<{ address: string; publicKey: string }> => {
    return this.executeWithRetry(async () => {
      this.setHdPath('eth', accountIndex, 60);
      const { address, publicKey } = await this.ledgerEVMClient.getAddress(
        this.hdPath.replace(/^m\//, '') // Remove 'm/' prefix for EVM
      );
      return { address, publicKey };
    }, 'getEvmAddressAndPubKey');
  };

  private signTypedData = async ({
    version,
    data,
    accountIndex,
  }: {
    accountIndex: number;
    data: any;
    version: Version;
  }) => {
    return this.executeWithRetry(async () => {
      this.setHdPath('eth', accountIndex, 60);
      const dataWithHashes = this.transformTypedData(data, version === 'V4');

      const { domain_separator_hash, message_hash } = dataWithHashes;

      const signature = await this.ledgerEVMClient.signEIP712HashedMessage(
        this.hdPath.replace(/^m\//, ''), // Remove 'm/' prefix for EVM
        domain_separator_hash,
        message_hash ? message_hash : ''
      );

      return `0x${signature.r}${signature.s}${signature.v.toString(16)}`;
    }, 'signTypedData');
  };

  private getMasterFingerprint = async () => {
    try {
      const masterFingerprint =
        await this.ledgerUtxoClient.getMasterFingerprint();
      return masterFingerprint;
    } catch (error) {
      console.log('Fingerprint error: ', error);
      throw error;
    }
  };

  private setHdPath(coin: string, accountIndex: number, slip44: number) {
    if (isEvmCoin(coin, slip44)) {
      // For EVM, the "accountIndex" parameter is actually used as the address index
      // EVM typically uses account 0, and different addresses are at different address indices
      this.hdPath = getAddressDerivationPath(
        coin,
        slip44,
        0, // account is always 0 for EVM
        false, // not a change address
        accountIndex // this is actually the address index for EVM
      );
    } else {
      // For UTXO, use account-level derivation path
      this.hdPath = getAccountDerivationPath(coin, slip44, accountIndex);
    }
  }

  /**
   * Convert PSBT to Ledger format with retry logic
   */
  public async convertToLedgerFormat(
    psbt: any,
    accountXpub: string,
    accountId: number,
    currency: string,
    slip44: number
  ): Promise<any> {
    return this.executeWithRetry(async () => {
      // Ensure Ledger is connected before attempting operations
      // This is now handled by executeWithRetry

      // Create BIP32 node from account xpub
      const accountNode = fromBase58(accountXpub);

      // Get master fingerprint
      const fingerprint = await this.getMasterFingerprint();

      // Enhance each input with bip32Derivation
      for (let i = 0; i < psbt.inputCount; i++) {
        const dataInput = psbt.data.inputs[i];

        // Skip if already has bip32Derivation
        if (dataInput.bip32Derivation && dataInput.bip32Derivation.length > 0) {
          continue;
        }

        // Ensure witnessUtxo is present if nonWitnessUtxo exists
        if (!dataInput.witnessUtxo && dataInput.nonWitnessUtxo) {
          const txBuffer = dataInput.nonWitnessUtxo;
          const tx = Transaction.fromBuffer(txBuffer);
          const vout = psbt.txInputs[i].index;

          if (tx.outs[vout]) {
            dataInput.witnessUtxo = {
              script: tx.outs[vout].script,
              value: tx.outs[vout].value,
            };
          }
        }

        // Extract path from unknownKeyVals
        if (
          dataInput.unknownKeyVals &&
          dataInput.unknownKeyVals.length > 1 &&
          dataInput.unknownKeyVals[1].key.equals(Buffer.from('path'))
        ) {
          const fullPath = dataInput.unknownKeyVals[1].value.toString();
          const accountPath = getAccountDerivationPath(
            currency,
            slip44,
            accountId
          );
          const relativePath = fullPath
            .replace(accountPath, '')
            .replace(/^\//, '');
          const derivationTokens = relativePath.split('/').filter((t) => t);

          const derivedAccount = derivationTokens.reduce(
            (acc: any, token: string) => {
              const index = parseInt(token);
              if (isNaN(index)) {
                return acc;
              }
              return acc.derive(index);
            },
            accountNode
          );

          const pubkey = derivedAccount.publicKey;

          if (pubkey && Buffer.isBuffer(pubkey)) {
            // Add the bip32Derivation that Ledger needs
            const bip32Derivation = {
              masterFingerprint: Buffer.from(fingerprint, 'hex'),
              path: fullPath,
              pubkey: pubkey,
            };

            psbt.updateInput(i, {
              bip32Derivation: [bip32Derivation],
            });
          }
        }
      }

      return psbt;
    }, 'convertToLedgerFormat');
  }

  /**
   * Execute operation with automatic retry
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    // Ensure connection first
    await this.ensureConnection();

    // Use hardware wallet manager's retry mechanism
    return this.hardwareWalletManager.retryOperation(operation, operationName, {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 5000,
      backoffMultiplier: 2,
    });
  }

  /**
   * Get hardware wallet status
   */
  public getStatus() {
    return this.hardwareWalletManager
      .getStatus()
      .find((s) => s.type === HardwareWalletType.LEDGER);
  }

  /**
   * Clean up resources
   */
  public async destroy() {
    await this.hardwareWalletManager.destroy();
    this.transport = null;
  }
}

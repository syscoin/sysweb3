/* eslint-disable camelcase */
/* eslint-disable import/no-named-as-default */
/* eslint-disable import/order */
import Transport from '@ledgerhq/hw-transport';
import HIDTransport from '@ledgerhq/hw-transport-webhid';
import { listen } from '@ledgerhq/logs';
import SysUtxoClient, { DefaultWalletPolicy } from './bitcoin_client';
import {
  DESCRIPTOR,
  RECEIVING_ADDRESS_INDEX,
  WILL_NOT_DISPLAY,
} from './consts';
import { getXpubWithDescriptor } from './utils';
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

export class LedgerKeyring {
  public ledgerUtxoClient: SysUtxoClient;
  public ledgerEVMClient: LedgerEthClient;
  public ledgerTransport: Transport;
  public utxo: IUTXOMethods;
  public evm: IEvmMethods;
  public hdPath = '';

  constructor() {
    this.utxo = {
      getUtxoAddress: this.getUtxoAddress,
      getXpub: this.getXpub,
      verifyUtxoAddress: this.verifyUtxoAddress,
    };
    this.evm = {
      getEvmAddressAndPubKey: this.getEvmAddressAndPubKey,
      signEVMTransaction: this.signEVMTransaction,
      signPersonalMessage: this.signPersonalMessage,
      signTypedData: this.signTypedData,
    };
  }

  public isConnected = (): boolean => {
    return !!(
      this.ledgerTransport &&
      this.ledgerUtxoClient &&
      this.ledgerEVMClient
    );
  };

  public ensureConnection = async (): Promise<void> => {
    // Check if all clients are properly initialized
    if (!this.isConnected()) {
      await this.connectToLedgerDevice();
    }

    // Additional check: Try a simple operation to verify connection is still active
    try {
      if (this.ledgerUtxoClient) {
        // Try to get master fingerprint as a connection test
        await this.ledgerUtxoClient.getMasterFingerprint();
      }
    } catch (error) {
      // Connection lost, reconnect
      console.log('Ledger connection lost, reconnecting...');
      await this.connectToLedgerDevice();
    }
  };

  public connectToLedgerDevice = async () => {
    try {
      const connectionResponse = await HIDTransport.create();
      listen((log) => console.log(log));

      this.ledgerUtxoClient = new SysUtxoClient(connectionResponse);
      this.ledgerEVMClient = new LedgerEthClient(connectionResponse);
      this.ledgerTransport = connectionResponse;
      return connectionResponse;
    } catch (error) {
      throw new Error(error);
    }
  };

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
    try {
      // Ensure Ledger is connected before attempting operations
      await this.ensureConnection();

      const fingerprint = await this.getMasterFingerprint();
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
    } catch (error) {
      throw error;
    }
  };

  private verifyUtxoAddress = async (
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
    withDescriptor,
  }: {
    coin: string;
    index: number;
    slip44: number;
    withDescriptor?: boolean;
  }) => {
    try {
      // Ensure Ledger is connected before attempting operations
      await this.ensureConnection();

      const fingerprint = await this.getMasterFingerprint();
      this.setHdPath(coin, index, slip44);
      const xpub = await this.ledgerUtxoClient.getExtendedPubkey(this.hdPath);
      const xpubWithDescriptor = getXpubWithDescriptor(
        xpub,
        this.hdPath,
        fingerprint
      );

      return withDescriptor ? xpubWithDescriptor : xpub;
    } catch (error) {
      throw error;
    }
  };

  public signUtxoMessage = async (path: string, message: string) => {
    try {
      // Ensure Ledger is connected before attempting to sign
      await this.ensureConnection();

      const bufferMessage = Buffer.from(message);
      const signature = await this.ledgerUtxoClient.signMessage(
        bufferMessage,
        path
      );
      return signature;
    } catch (error) {
      throw error;
    }
  };

  private signEVMTransaction = async ({
    rawTx,
    accountIndex,
  }: {
    accountIndex: number;
    rawTx: string;
  }) => {
    // Ensure Ledger is connected before attempting to sign
    await this.ensureConnection();

    this.setHdPath('eth', accountIndex, 60);
    const resolution = await ledgerService.resolveTransaction(rawTx, {}, {});

    const signature = await this.ledgerEVMClient.signTransaction(
      this.hdPath,
      rawTx,
      resolution
    );

    return signature;
  };

  private signPersonalMessage = async ({
    message,
    accountIndex,
  }: {
    accountIndex: number;
    message: string;
  }) => {
    // Ensure Ledger is connected before attempting to sign
    await this.ensureConnection();

    this.setHdPath('eth', accountIndex, 60);

    const signature = await this.ledgerEVMClient.signPersonalMessage(
      this.hdPath,
      message
    );

    return `0x${signature.r}${signature.s}${signature.v.toString(16)}`;
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
  }) => {
    // Ensure Ledger is connected before attempting operations
    await this.ensureConnection();

    this.setHdPath('eth', accountIndex, 60);
    try {
      const { address, publicKey } = await this.ledgerEVMClient.getAddress(
        this.hdPath
      );
      return { address, publicKey: `0x${publicKey}` };
    } catch (error) {
      throw error;
    }
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
    // Ensure Ledger is connected before attempting to sign
    await this.ensureConnection();

    this.setHdPath('eth', accountIndex, 60);
    const dataWithHashes = this.transformTypedData(data, version === 'V4');

    const { domain_separator_hash, message_hash } = dataWithHashes;

    const signature = await this.ledgerEVMClient.signEIP712HashedMessage(
      this.hdPath,
      domain_separator_hash,
      message_hash ? message_hash : ''
    );

    return `0x${signature.r}${signature.s}${signature.v.toString(16)}`;
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

  private setHdPath = (coin: string, accountIndex: number, slip44: number) => {
    // Use dynamic coin type detection instead of hardcoded checks
    if (isEvmCoin(coin, slip44)) {
      // For EVM, use address-level derivation path
      this.hdPath = getAddressDerivationPath(
        coin,
        slip44,
        0,
        false,
        accountIndex || 0
      );
    } else {
      // For UTXO, use account-level derivation path
      this.hdPath = getAccountDerivationPath(coin, slip44, accountIndex);
    }
  };

  // Convert PSBT to Ledger-compatible format by adding bip32Derivation
  public convertToLedgerFormat = async (
    psbt: any,
    accountXpub: string,
    accountId: number,
    currency: string,
    slip44: number
  ): Promise<any> => {
    try {
      // Ensure Ledger is connected before attempting operations
      await this.ensureConnection();

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
    } catch (error) {
      console.error('Error converting PSBT to Ledger format:', error);
      // Return original PSBT if conversion fails
      return psbt;
    }
  };
}

/* eslint-disable camelcase */
import TrezorConnect, {
  AccountInfo,
  DEVICE_EVENT,
  EthereumTransaction,
  EthereumTransactionEIP1559,
  // @ts-ignore
} from '@trezor/connect-webextension';
import { address } from '@trezor/utxo-lib';
import bitcoinops from 'bitcoin-ops';
import { Transaction, payments, script } from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { TypedDataUtils, TypedMessage, Version } from 'eth-sig-util';
import Web3 from 'web3';

import {
  HardwareWalletManager,
  HardwareWalletType,
} from '../hardware-wallet-manager';
import { SyscoinHDSigner } from '../signers';
import {
  getAccountDerivationPath,
  getAddressDerivationPath,
  isEvmCoin,
} from '../utils/derivation-paths';

const { p2wsh } = payments;
const { decompile } = script;
const { fromBase58Check, fromBech32 } = address;

const initialHDPath = `m/44'/60'/0'/0/0`;
const DELAY_BETWEEN_POPUPS = 2000; // Increased from 1000ms to 2000ms for more reliable operation

export interface TrezorControllerState {
  hdPath: string;
  paths: Record<string, number>;
}

interface MessageTypeProperty {
  name: string;
  type: string;
}
interface MessageTypes {
  [additionalProperties: string]: MessageTypeProperty[];
  EIP712Domain: MessageTypeProperty[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  interface Window {
    TrezorConnect: any;
  }
}
export class TrezorKeyring {
  public hdPath: string = initialHDPath;
  public publicKey: Buffer;
  public chainCode: Buffer;
  public paths: Record<string, number> = {};
  public model?: string;
  private getSigner: () => {
    hd: SyscoinHDSigner;
    main: any;
  };
  private hardwareWalletManager: HardwareWalletManager;
  private initialized = false;

  constructor(
    getSyscoinSigner: () => {
      hd: SyscoinHDSigner;
      main: any;
    }
  ) {
    this.publicKey = Buffer.from('', 'hex');
    this.chainCode = Buffer.from('', 'hex');
    this.hdPath = '';
    this.paths = {};
    this.getSigner = getSyscoinSigner;
    this.hardwareWalletManager = new HardwareWalletManager();

    // Set up event listeners
    this.hardwareWalletManager.on('connected', ({ type }) => {
      if (type === HardwareWalletType.TREZOR) {
        console.log('Trezor connected');
        this.initialized = true;
      }
    });

    this.hardwareWalletManager.on('disconnected', ({ type }) => {
      if (type === HardwareWalletType.TREZOR) {
        console.log('Trezor disconnected');
        this.initialized = false;
      }
    });

    TrezorConnect.on(DEVICE_EVENT, (event: any) => {
      if (event.payload.features) {
        this.model = event.payload.features.model;
      }
    });
  }

  /**
   * Initialize Trezor script.
   */
  public async init(): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    // Add a small delay to ensure Chrome extension context is ready
    // This helps prevent "waiting for handshake" errors
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = await this.hardwareWalletManager.initializeTrezor();
    if (result) {
      this.initialized = true;
    }
    return result;
  }

  /**
   * Execute operation with automatic retry
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    // Ensure initialization first
    if (!this.initialized) {
      const initResult = await this.init();
      if (!initResult) {
        throw new Error('Failed to initialize Trezor');
      }
    }

    // For Trezor operations, use reduced retry config to prevent popup spam
    const trezorRetryConfig = {
      maxRetries: 1, // Only retry once
      baseDelay: 1000,
      maxDelay: 5000,
      backoffMultiplier: 2,
    };

    // Use hardware wallet manager's retry mechanism with custom config
    return this.hardwareWalletManager
      .retryOperation(operation, operationName, trezorRetryConfig)
      .catch((error) => {
        // Clean up Trezor state on failure
        if (
          error.message?.includes('Popup closed') ||
          error.message?.includes('cancelled') ||
          error.message?.includes('denied')
        ) {
          this.initialized = false;
          // Dispose Trezor connection to clean up
          try {
            TrezorConnect.dispose();
          } catch (disposeError) {
            console.log('Failed to dispose Trezor on error:', disposeError);
          }
        }
        throw error;
      });
  }

  /**
   * This return account info based in params provided.
   *
   * @param coin - network symbol. Example: eth, sys, btc
   * @param slip44 - network slip44 number
   * @param hdPath - path derivation. Example: m/84'/57'/0'
   * @param index - index of account for path derivation
   * @returns derivated account info or error
   */

  public async getAccountInfo({
    coin,
    slip44,
    hdPath,
    index,
  }: {
    coin: string;
    hdPath?: string;
    index?: number;
    slip44: number;
  }): Promise<AccountInfo> {
    return this.executeWithRetry(async () => {
      // Use dynamic path generation instead of hardcoded switch
      this.setHdPath(coin, index || 0, slip44);

      if (hdPath) this.hdPath = hdPath;

      // For EVM networks, getAccountInfo is not supported
      // We need to use getAddress instead
      if (slip44 === 60) {
        const addressResponse = await TrezorConnect.ethereumGetAddress({
          path: this.hdPath,
          showOnTrezor: false,
        });

        if (!addressResponse.success) {
          throw new Error(
            addressResponse.payload.error || 'Failed to get EVM address'
          );
        }

        // Return a compatible AccountInfo structure
        return {
          descriptor: addressResponse.payload.address,
          balance: '0', // Balance is fetched separately for EVM
          empty: true,
          history: {
            total: 0,
            unconfirmed: 0,
          },
        } as AccountInfo;
      }

      // For UTXO networks, use the standard getAccountInfo
      const response = await TrezorConnect.getAccountInfo({
        coin,
        path: this.hdPath,
      });

      if (response.success) {
        return response.payload;
      }
      throw new Error(response.payload.error);
    }, 'getAccountInfo');
  }

  /**
   * Gets the model, if known.
   * This may be `undefined` if the model hasn't been loaded yet.
   *
   * @returns
   */
  public getModel(): string | undefined {
    return this.model;
  }

  /**
   * This removes the Trezor Connect iframe from the DOM
   *
   * @returns void
   */

  public dispose() {
    try {
      TrezorConnect.dispose();
      this.initialized = false;
      // Clear any cached data
      this.publicKey = Buffer.from('', 'hex');
      this.chainCode = Buffer.from('', 'hex');
      this.hdPath = '';
      this.paths = {};
    } catch (error) {
      console.log('Error disposing Trezor:', error);
    }
  }

  /**
   * This verify if message is valid or not.
   *
   * @param coin - network symbol. Example: eth, sys, btc
   * @param address - account address that signed message
   * @param message - message to be verified. Example: 'Test message'
   * @param signature - signature received in sign method. Example: I6BrpivjCwZmScZ6BMAHWGQPo+JjX2kzKXU5LcGVfEgvFb2VfJuKo3g6eSQcykQZiILoWNUDn5rDHkwJg3EcvuY=
   * @returns derivated account info or error
   */

  public async verifyMessage({
    coin,
    address,
    message,
    signature,
  }: {
    address: string;
    coin: string;
    message: string;
    signature: string;
  }) {
    return this.executeWithRetry(async () => {
      let method = '';
      switch (coin) {
        case 'eth':
          method = 'ethereumVerifyMessage';
          break;
        default:
          method = 'verifyMessage';
      }
      // @ts-ignore
      const { success, payload } = await TrezorConnect[method]({
        coin,
        address,
        message,
        signature,
      });

      if (success) {
        return { success, payload };
      }
      throw new Error(payload.error);
    }, 'verifyMessage');
  }

  /**
   * This return account public key.
   *
   * @param coin - network symbol. Example: eth, sys, btc
   * @param slip44 - network slip44 number
   * @param hdPath - path derivation. Example: m/44'/57'/0'/0/0
   * @returns publicKey and chainCode
   */

  public async getPublicKey({
    coin,
    slip44,
    hdPath,
    index,
  }: {
    coin: string;
    hdPath?: string;
    index?: number;
    slip44: number;
  }) {
    this.setHdPath(coin, index || 0, slip44);

    if (hdPath) this.hdPath = hdPath;

    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_POPUPS));

    try {
      // For EVM networks, use ethereumGetPublicKey
      if (slip44 === 60) {
        const { success, payload } = await TrezorConnect.ethereumGetPublicKey({
          path: this.hdPath,
          showOnTrezor: false,
        });

        if (success) {
          const { publicKey } = payload;
          // For Ethereum, we don't get chainCode from ethereumGetPublicKey
          this.publicKey = Buffer.from(publicKey, 'hex');

          return {
            publicKey: `0x${publicKey}`,
            chainCode: '', // Ethereum doesn't use chainCode in the same way
          };
        }

        return { success: false, payload };
      }

      // For UTXO networks, use standard getPublicKey
      const { success, payload } = await TrezorConnect.getPublicKey({
        coin: coin,
        path: this.hdPath,
      });

      if (success) {
        const { publicKey, chainCode } = payload;

        this.publicKey = Buffer.from(publicKey, 'hex');
        this.chainCode = Buffer.from(chainCode, 'hex');

        return {
          publicKey: `0x${this.publicKey.toString('hex')}`,
          chainCode: `0x${this.chainCode.toString('hex')}`,
        };
      }

      return { success: false, payload };
    } catch (error) {
      return error;
    }
  }

  public range(n: number) {
    return [...Array(n).keys()];
  }

  /**
   * This sign UTXO tx.
   *
   * @param coin - network symbol. Example: eth, sys, btc
   * @param inputs - utxo transaction inputs
   * @param outputs - utxo transaction outputs
   * @returns signature object
   */

  public async signUtxoTransaction(utxoTransaction: any, psbt: any) {
    return this.executeWithRetry(async () => {
      const { payload, success } = await TrezorConnect.signTransaction(
        utxoTransaction
      );

      if (success) {
        const tx = Transaction.fromHex(payload.serializedTx);
        for (const i of this.range(psbt.data.inputs.length)) {
          if (tx.ins[i].witness == null) {
            throw new Error(
              'Please move your funds to a Segwit address: https://wiki.trezor.io/Account'
            );
          }
          const partialSig = [
            {
              pubkey: tx.ins[i].witness[1],
              signature: tx.ins[i].witness[0],
            },
          ];
          psbt.updateInput(i, { partialSig });
        }
        try {
          if (psbt.validateSignaturesOfAllInputs()) {
            psbt.finalizeAllInputs();
          }
        } catch (err) {
          console.log(err);
        }
        return psbt;
      } else {
        throw new Error('Trezor sign failed: ' + payload.error);
      }
    }, 'signUtxoTransaction');
  }

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

  public convertToAddressNFormat(path: string) {
    const pathArray = path.replace(/'/g, '').split('/');

    pathArray.shift();

    const addressN: any[] = [];

    for (const index in pathArray) {
      if (Number(index) <= 2 && Number(index) >= 0) {
        addressN[Number(index)] = Number(pathArray[index]) | 0x80000000;
      } else {
        addressN[Number(index)] = Number(pathArray[index]);
      }
    }

    return addressN;
  }
  public isScriptHash(address: string, networkInfo: any) {
    if (!this.isBech32(address)) {
      const decoded = fromBase58Check(address);
      if (decoded.version === networkInfo.pubKeyHash) {
        return false;
      }
      if (decoded.version === networkInfo.scriptHash) {
        return true;
      }
    } else {
      const decoded = fromBech32(address);
      if (decoded.data.length === 20) {
        return false;
      }
      if (decoded.data.length === 32) {
        return true;
      }
    }
    throw new Error('isScriptHash: Unknown address type');
  }

  public isPaymentFactory(payment: any) {
    return (script: any) => {
      try {
        payment({ output: script });
        return true;
      } catch (err) {
        return false;
      }
    };
  }
  public isBech32(address: string) {
    try {
      fromBech32(address);
      return true;
    } catch (e) {
      return false;
    }
  }
  public isP2WSHScript(script: any) {
    this.isPaymentFactory(p2wsh)(script);

    return false;
  }

  public convertToTrezorFormat({ psbt, pathIn, coin }: any) {
    const { hd } = this.getSigner();
    const trezortx: any = {};

    trezortx.coin = coin;
    trezortx.version = psbt.version;
    trezortx.inputs = [];
    trezortx.outputs = [];

    for (let i = 0; i < psbt.txInputs.length; i++) {
      const scriptTypes = psbt.getInputType(i);
      const input = psbt.txInputs[i];
      const inputItem: any = {};
      inputItem.prev_index = input.index;
      inputItem.prev_hash = input.hash.reverse().toString('hex');
      if (input.sequence) inputItem.sequence = input.sequence;
      const dataInput = psbt.data.inputs[i];
      let path = '';
      if (
        pathIn ||
        (dataInput.unknownKeyVals &&
          dataInput.unknownKeyVals.length > 1 &&
          dataInput.unknownKeyVals[1].key.equals(Buffer.from('path')) &&
          (!dataInput.bip32Derivation ||
            dataInput.bip32Derivation.length === 0))
      ) {
        path = pathIn || dataInput.unknownKeyVals[1].value.toString();
        inputItem.address_n = this.convertToAddressNFormat(path);
      }
      switch (scriptTypes) {
        case 'multisig':
          inputItem.script_type = 'SPENDMULTISIG';
          break;
        case 'witnesspubkeyhash':
          inputItem.script_type = 'SPENDWITNESS';
          break;
        default:
          inputItem.script_type = this.isP2WSHScript(
            psbt.data.inputs[i].witnessUtxo.script
              ? psbt.data.inputs[i].witnessUtxo.script
              : ''
          )
            ? 'SPENDP2SHWITNESS'
            : 'SPENDADDRESS';
          break;
      }
      trezortx.inputs.push(inputItem);
    }

    for (let i = 0; i < psbt.txOutputs.length; i++) {
      const output = psbt.txOutputs[i];
      const outputItem: any = {};
      const chunks = decompile(output.script);
      outputItem.amount = output.value.toString();
      if (chunks && chunks[0] === bitcoinops.OP_RETURN) {
        outputItem.script_type = 'PAYTOOPRETURN';
        // @ts-ignore
        outputItem.op_return_data = chunks[1].toString('hex');
      } else {
        if (output && this.isBech32(output.address)) {
          if (
            output.script.length === 34 &&
            output.script[0] === 0 &&
            output.script[1] === 0x20
          ) {
            outputItem.script_type = 'PAYTOP2SHWITNESS';
          } else {
            outputItem.script_type = 'PAYTOWITNESS';
          }
        } else {
          outputItem.script_type = this.isScriptHash(
            output.address,
            hd.Signer.network
          )
            ? 'PAYTOSCRIPTHASH'
            : 'PAYTOADDRESS';
        }
        if (output.address) outputItem.address = output.address;
      }
      trezortx.outputs.push(outputItem);
    }
    return trezortx;
  }

  /**
   * This sign EVM tx.
   *
   * @param index - index of account for path derivation
   * @param tx - ethereum tx object
   * @returns signature object
   */
  public async signEthTransaction({
    tx,
    index,
    coin,
    slip44,
  }: {
    index: string;
    tx: EthereumTransaction | EthereumTransactionEIP1559;
    coin: string;
    slip44: number;
  }) {
    return this.executeWithRetry(async () => {
      // Wait between popups
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_POPUPS));

      // Use dynamic path generation based on actual network parameters
      this.setHdPath(coin, Number(index) || 0, slip44);

      const response = await TrezorConnect.ethereumSignTransaction({
        path: this.hdPath,
        transaction: tx,
      });

      if (response.success) {
        return response;
      }
      throw new Error(response.payload.error);
    }, 'signEthTransaction');
  }

  /**
   * This sign message.
   *
   * @param coin - network symbol. Example: eth, sys, btc
   * @param slip44 - network slip44 number
   * @param message - message to be signed. Example: 'Test message'
   * @param index - index of account for path derivation
   * @returns signature object
   */

  public async signMessage({
    index,
    message,
    coin,
    slip44,
    address,
  }: {
    address: string;
    coin: string;
    index?: number;
    message?: string;
    slip44: number; // Required, not optional
  }) {
    return this.executeWithRetry(async () => {
      // Wait between popups
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_POPUPS));

      if (isEvmCoin(coin, slip44) && `${index ? index : 0}` && message) {
        return this._signEthPersonalMessage(Number(index), message, address);
      }
      return this._signUtxoPersonalMessage({ coin, index, slip44, message });
    }, 'signMessage');
  }

  private async _signUtxoPersonalMessage({
    coin,
    index,
    slip44,
    message,
  }: {
    coin: string;
    index?: number;
    slip44: number;
    message?: string;
  }) {
    try {
      // Use dynamic path generation instead of hardcoded switch
      this.setHdPath(coin, index || 0, slip44);
      const { success, payload } = await TrezorConnect.signMessage({
        path: this.hdPath,
        coin: coin,
        message: message,
      });

      if (success) {
        return { success, payload };
      }
      return { success: false, payload };
    } catch (error) {
      return { error };
    }
  }

  // For personal_sign, we need to prefix the message:
  private async _signEthPersonalMessage(
    index: number,
    message: string,
    address: string
  ) {
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          this.setHdPath('eth', index, 60);

          TrezorConnect.ethereumSignMessage({
            path: this.hdPath,
            message: Web3.utils.stripHexPrefix(message),
            hex: true,
          })
            .then((response: any) => {
              if (response.success) {
                if (
                  address &&
                  response.payload.address.toLowerCase() !==
                    address.toLowerCase()
                ) {
                  reject(new Error('signature doesnt match the right address'));
                }
                const signature = `0x${response.payload.signature}`;
                resolve({ signature, success: true });
              } else {
                reject(
                  // @ts-ignore
                  new Error(response.payload.error || 'Unknown error')
                );
              }
            })
            .catch((e: any) => {
              reject(new Error(e.toString() || 'Unknown error'));
            });
        } catch (error) {
          reject(error);
        }
        // This is necessary to avoid popup collision
        // between the unlock & sign trezor popups
      }, DELAY_BETWEEN_POPUPS);
    });
  }
  private _sanitizeData(data: any): any {
    switch (Object.prototype.toString.call(data)) {
      case '[object Object]': {
        const entries = Object.keys(data).map((k) => [
          k,
          this._sanitizeData(data[k]),
        ]);
        return Object.fromEntries(entries);
      }

      case '[object Array]':
        return data.map((v: any[]) => this._sanitizeData(v));

      case '[object BigInt]':
        return data.toString();

      default:
        return data;
    }
  }

  private _transformTypedData = <T extends MessageTypes>(
    data: TypedMessage<T>,
    metamask_v4_compat: boolean
  ) => {
    if (!metamask_v4_compat) {
      throw new Error(
        'Trezor: Only version 4 of typed data signing is supported'
      );
    }

    const { types, primaryType, domain, message } = this._sanitizeData(data);

    const domainSeparatorHash = TypedDataUtils.hashStruct(
      'EIP712Domain',
      this._sanitizeData(domain),
      types,
      true
    ).toString('hex');

    let messageHash: string | null = null;

    if (primaryType !== 'EIP712Domain') {
      messageHash = TypedDataUtils.hashStruct(
        primaryType as string,
        this._sanitizeData(message),
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

  /**
   * EIP-712 Sign Typed Data
   */
  public async signTypedData({
    version,
    address,
    data,
    index,
  }: {
    address: string;
    data: any;
    index: number;
    version: Version;
  }) {
    return this.executeWithRetry(async () => {
      // Wait between popups
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_POPUPS));

      this.setHdPath('eth', index, 60);
      // Use dynamic path generation for ETH (EVM) - typed data is only used for EVM

      const dataWithHashes = this._transformTypedData(data, version === 'V4');

      // set default values for signTypedData
      // Trezor is stricter than @metamask/eth-sig-util in what it accepts
      const {
        types,
        message = {},
        domain = {},
        primaryType,
        // snake_case since Trezor uses Protobuf naming conventions here
        domain_separator_hash, // eslint-disable-line camelcase
        message_hash, // eslint-disable-line camelcase
      } = dataWithHashes;

      // This is necessary to avoid popup collision
      // between the unlock & sign trezor popups

      const response = await TrezorConnect.ethereumSignTypedData({
        path: this.hdPath,
        data: {
          types: {
            ...types,
            EIP712Domain: types.EIP712Domain ? types.EIP712Domain : [],
          },
          message,
          domain,
          primaryType: primaryType as any,
        },
        metamask_v4_compat: true,
        // Trezor 1 only supports blindly signing hashes
        domain_separator_hash,
        message_hash: message_hash ? message_hash : '',
      });

      if (response.success) {
        if (address !== response.payload.address) {
          throw new Error('signature doesnt match the right address');
        }
        return response.payload.signature;
      }
      // @ts-ignore
      throw new Error(response.payload.error || 'Unknown error');
    }, 'signTypedData');
  }

  /**
   * Verify UTXO address by displaying it on the Trezor device
   * @param accountIndex - The account index
   * @param currency - The currency (coin type)
   * @param slip44 - The slip44 value for the network
   * @returns The verified address
   */
  public async verifyUtxoAddress(
    accountIndex: number,
    currency: string,
    slip44: number
  ): Promise<string | undefined> {
    return this.executeWithRetry(async () => {
      const fullPath = getAddressDerivationPath(
        currency,
        slip44,
        accountIndex,
        false, // Not a change address
        0
      );

      try {
        const { payload, success } = await TrezorConnect.getAddress({
          path: fullPath,
          coin: currency,
          showOnTrezor: true, // This displays the address on device for verification
        });
        if (success) {
          return payload.address;
        }
        throw new Error('Address verification cancelled by user');
      } catch (error) {
        throw error;
      }
    }, 'verifyUtxoAddress');
  }

  /**
   * Check Trezor status
   */
  public getStatus() {
    return this.hardwareWalletManager
      .getStatus()
      .find((s) => s.type === HardwareWalletType.TREZOR);
  }

  /**
   * Clean up resources
   */
  public async destroy() {
    try {
      // First dispose Trezor Connect
      this.dispose();
      // Then destroy hardware wallet manager
      await this.hardwareWalletManager.destroy();
      this.initialized = false;
    } catch (error) {
      console.error('Error destroying Trezor keyring:', error);
    }
  }
}

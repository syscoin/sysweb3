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

import { SyscoinHDSigner } from '../signers';

const { p2wsh } = payments;
const { decompile } = script;
const { fromBase58Check, fromBech32 } = address;

const initialHDPath = `m/44'/60'/0'/0/0`;
const DELAY_BETWEEN_POPUPS = 1000;
const TREZOR_CONNECT_MANIFEST = {
  appUrl: 'https://paliwallet.com/',
  email: 'pali@pollum.io',
};

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
    TrezorConnect.on(DEVICE_EVENT, (event: any) => {
      if (event.payload.features) {
        this.model = event.payload.features.model;
      }
    });
  }

  /**
   * Initialize Trezor script.
   *
   * Trezor Connect raises an error that reads "Manifest not set" if manifest is not provided. It can be either set via manifest method or passed as a param in init method.
   * @returns true, if trezor was initialized successfully and false, if some error happen
   */

  public async init() {
    try {
      await TrezorConnect.init({
        manifest: TREZOR_CONNECT_MANIFEST,
        lazyLoad: true,
        popup: true,
        connectSrc: 'https://connect.trezor.io/9/',
        _extendWebextensionLifetime: true,
        transports: ['BridgeTransport', 'WebUsbTransport'], // Transport protocols to be used
      });
      return true;
    } catch (error) {
      if (
        error.message.includes('TrezorConnect has been already initialized')
      ) {
        return true;
      }
      return false;
    }
  }

  /**
   * This return derivated account info based in params provided.
   *
   * @param index - index of account for path derivation
   * @param slip44 - network slip44 number
   * @param bip - BIP for derivation. Example: 44, 49, 84
   * @param coin - network symbol. Example: eth, sys, btc
   * @returns derivated account info or error
   */

  public async deriveAccount({
    index,
    slip44,
    bip,
    coin,
  }: {
    bip: number;
    coin: string;
    index: number;
    slip44: number | string;
  }): Promise<
    | AccountInfo
    | {
        code?: string;
        error: string;
      }
  > {
    const keypath = `m/${bip}'/${slip44}'/0'/0/${index}`;

    return new Promise((resolve, reject) => {
      TrezorConnect.getAccountInfo({
        path: keypath,
        coin: coin,
      })
        .then((response: any) => {
          if (response.success) {
            resolve(response.payload);
          }
          // @ts-ignore
          reject(response.payload.error);
        })
        .catch((error: any) => {
          console.error('TrezorConnectError', error);
          reject(error);
        });
    });
  }

  /**
   * This return account info based in params provided.
   *
   * @param coin - network symbol. Example: eth, sys, btc
   * @param slip44 - network slip44 number
   * @param hdPath - path derivation. Example: m/44'/57'/0'/0/0
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
    index?: string;
    slip44: string;
  }): Promise<AccountInfo> {
    switch (coin) {
      case 'sys':
        this.hdPath = `m/84'/57'/${index}'`;
        break;
      case 'btc':
        this.hdPath = `m/84'/0'/${index}'`;
        break;
      case 'eth':
        this.hdPath = `m/44'/60'/0'/0/${index ? index : 0}`;
        break;
      default:
        this.hdPath = `m/84'/${slip44}'/0'/0/${index ? index : 0}`;
        break;
    }

    if (hdPath) this.hdPath === hdPath;

    const response = await TrezorConnect.getAccountInfo({
      coin,
      path: this.hdPath,
    });

    if (response.success) {
      return response.payload;
    }
    return response.payload as any;
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
    TrezorConnect.dispose();
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
    try {
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
      return { success: false, payload };
    } catch (error) {
      return { error };
    }
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
    slip44: string;
  }) {
    switch (coin) {
      case 'sys':
        this.hdPath = `m/84'/57'/0'`;
        break;
      case 'btc':
        this.hdPath = "m/84'/0'/0'";
        break;
      case 'eth':
        this.hdPath = `m/44'/60'/0'/0/${index ? index : 0}`;
        break;
      default:
        this.hdPath = `m/84'/${slip44}'/0'`;
        break;
    }

    if (hdPath) this.hdPath = hdPath;

    try {
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
    try {
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
    } catch (error) {
      return { error };
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
  }: {
    index: string;
    tx: EthereumTransaction | EthereumTransactionEIP1559;
  }) {
    try {
      const { success, payload } = await TrezorConnect.ethereumSignTransaction({
        path: `m/44'/60'/0'/0/${index}`,
        transaction: tx,
      });

      if (success) {
        return { success, payload };
      }
      return { success: false, payload };
    } catch (error) {
      return { success: false, payload: error };
    }
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
    slip44?: string;
  }) {
    switch (coin) {
      case 'sys':
        this.hdPath = `m/84'/57'/0'/0/${index ? index : 0}`;
        break;
      case 'btc':
        this.hdPath = `m/84'/0'/0'/0/${index ? index : 0}`;
        break;
      case 'eth':
        this.hdPath = `m/44'/60'/0'/0/${index ? index : 0}`;
        break;
      default:
        this.hdPath = `m/84'/${slip44}'/0'/0/${index ? index : 0}`;
        break;
    }

    if (coin === 'eth' && `${index ? index : 0}` && message) {
      return this._signEthPersonalMessage(Number(index), message, address);
    }
    return this._signUtxoPersonalMessage({ coin, hdPath: this.hdPath });
  }

  private async _signUtxoPersonalMessage({
    coin,
    hdPath,
  }: {
    coin: string;
    hdPath: string;
  }) {
    try {
      const { success, payload } = await TrezorConnect.signMessage({
        path: hdPath,
        coin: coin,
        message: 'UTXO example message',
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
        TrezorConnect.ethereumSignMessage({
          path: `m/44'/60'/0'/0/${index}`,
          message: Web3.utils.stripHexPrefix(message),
          hex: true,
        })
          .then((response: any) => {
            if (response.success) {
              if (
                address &&
                response.payload.address.toLowerCase() !== address.toLowerCase()
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
    const derivationPath = `m/44'/60'/0'/0/${index}`;
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
      path: derivationPath,
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
  }

  /**
   * Gets account address based in index of account in path derivation.
   *
   * @param coin - network symbol. Example: eth, sys, btc
   * @param slip44 - network slip44 number
   * @param index - index of account for path derivation
   * @returns account address
   */

  public async getAddress({
    coin,
    slip44,
    index,
    isChangeAddress,
  }: {
    coin: string;
    index: string | number;
    isChangeAddress?: boolean;
    slip44?: string;
  }): Promise<string | undefined> {
    switch (coin) {
      case 'sys':
        this.hdPath = `m/84'/57'/0'/${isChangeAddress ? 1 : 0}`;
        break;
      case 'btc':
        this.hdPath = "m/84'/0'/0'";
        break;
      case 'eth':
        this.hdPath = `m/44'/60'/0'/0`;
        break;
      default:
        this.hdPath = `m/84'/${slip44}'/0'/0`;
        break;
    }
    try {
      const { payload, success } = await TrezorConnect.getAddress({
        path: `${this.hdPath}/${index}`,
        coin,
      });
      if (success) {
        return payload.address;
      }
    } catch (error) {
      return error;
    }
  }

  public async getMultipleAddress({
    coin,
    slip44,
    indexArray,
    isChangeAddress,
  }: {
    coin: string;
    indexArray: string[] | number[];
    isChangeAddress?: boolean;
    slip44?: string;
  }): Promise<string[] | undefined> {
    switch (coin) {
      case 'sys':
        this.hdPath = `m/84'/57'/0'/${isChangeAddress ? 1 : 0}`;
        break;
      case 'btc':
        this.hdPath = "m/84'/0'/0'";
        break;
      case 'eth':
        this.hdPath = `m/44'/60'/0'/0`;
        break;
      default:
        this.hdPath = `m/84'/${slip44}'/0'/0`;
        break;
    }
    try {
      const { payload, success } = await TrezorConnect.getAddress({
        bundle: indexArray.map((index) => ({
          path: `${this.hdPath}/${index}`,
          coin,
        })),
      });
      if (success) {
        return payload.map((item: any) => item.address);
      }
    } catch (error) {
      return error;
    }
  }
}

/* eslint-disable camelcase */
import {
  TypedDataUtils,
  TypedMessage,
  SignTypedDataVersion,
  TypedDataV1,
} from '@metamask/eth-sig-util';
import bitcoinops from 'bitcoin-ops';
import { Psbt } from 'bitcoinjs-lib';
import bs58check from 'bs58check';
import { Buffer } from 'buffer';
import * as syscoinjs from 'syscoinjs-lib';

import TrezorConnect, {
  subscribeTrezorEvents,
  trezorResponseError,
} from './connect';
import { serializeWitness } from './witness';
import {
  HardwareWalletManager,
  HardwareWalletType,
} from '../hardware-wallet-manager';
import {
  getAccountDerivationPath,
  getAddressDerivationPath,
  isEvmCoin,
} from '../utils/derivation-paths';

import type {
  AccountInfo,
  CoinSymbol,
  EthereumTransaction,
  EthereumTransactionEIP1559,
} from '@trezor/connect-webextension';

const bitcoinjs: any = (syscoinjs.utils as any).bitcoinjs;
const { p2wsh } = bitcoinjs.payments;
const { decompile } = bitcoinjs.script;
const { fromBech32 } = bitcoinjs.address;
const fromBase58Check = (value: string) => {
  try {
    return bitcoinjs.address.fromBase58Check(value);
  } catch (error) {
    // The former decoder also accepted a two-byte network version. Preserve
    // exactly that checksum-verified format without loading the legacy fork.
    const payload = bs58check.decode(value);
    if (payload.length === 22) {
      return {
        version: (payload[0] << 8) | payload[1],
        hash: payload.subarray(2),
      };
    }
    throw error;
  }
};

const initialHDPath = `m/44'/60'/0'/0/0`;
const DELAY_BETWEEN_POPUPS = 2000; // Increased from 1000ms to 2000ms for more reliable operation
const stripHexPrefix = (value: string) =>
  value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
const finalizedFields = (input: any) => {
  if (!input.finalScriptSig && !input.finalScriptWitness) return null;
  return {
    scriptSig: Buffer.from(input.finalScriptSig || []).toString('hex'),
    witness: input.finalScriptWitness
      ? Buffer.from(input.finalScriptWitness).toString('hex')
      : '00',
  };
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
  private hardwareWalletManager: HardwareWalletManager;
  private initialized = false;
  private lifecycleGeneration = 0;
  private unsubscribeTrezor?: () => void;
  private readonly onTrezorConnected = ({
    type,
  }: {
    type: HardwareWalletType;
  }) => {
    if (type === HardwareWalletType.TREZOR) {
      console.log('Trezor connected');
      this.initialized = true;
    }
  };
  private readonly onTrezorDisconnected = ({
    type,
  }: {
    type: HardwareWalletType;
  }) => {
    if (type === HardwareWalletType.TREZOR) {
      console.log('Trezor disconnected');
      this.initialized = false;
    }
  };

  constructor() {
    this.publicKey = Buffer.from('', 'hex');
    this.chainCode = Buffer.from('', 'hex');
    this.hdPath = '';
    this.paths = {};
    this.hardwareWalletManager = new HardwareWalletManager();

    this.observeTrezor();
  }

  private observeTrezor(): void {
    // Manager destruction removes its listeners. Reusing an unlocked keyring
    // must restore these same callbacks without multiplying them on each init.
    if (
      !this.hardwareWalletManager
        .listeners('connected')
        .includes(this.onTrezorConnected)
    )
      this.hardwareWalletManager.on('connected', this.onTrezorConnected);
    if (
      !this.hardwareWalletManager
        .listeners('disconnected')
        .includes(this.onTrezorDisconnected)
    )
      this.hardwareWalletManager.on('disconnected', this.onTrezorDisconnected);
    if (!this.unsubscribeTrezor)
      this.unsubscribeTrezor = subscribeTrezorEvents((event) => {
        if (event.type === 'model') this.model = event.model;
      });
  }

  /**
   * Initialize Trezor script.
   */
  public async init(): Promise<boolean> {
    const generation = this.lifecycleGeneration;
    this.observeTrezor();
    if (this.initialized) {
      return true;
    }

    // Add a small delay to ensure Chrome extension context is ready
    // This helps prevent "waiting for handshake" errors
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (generation !== this.lifecycleGeneration) return false;

    const result = await this.hardwareWalletManager.initializeTrezor();
    if (generation !== this.lifecycleGeneration) return false;
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
      .catch(async (error) => {
        // Clean up Trezor state on failure
        const message = String(error.message || '').toLowerCase();
        if (
          message.includes('popup closed') ||
          message.includes('cancelled') ||
          message.includes('canceled') ||
          message.includes('denied')
        ) {
          this.initialized = false;
          // Dispose Trezor connection to clean up
          try {
            await TrezorConnect.dispose();
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
          throw trezorResponseError(addressResponse);
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
        coin: coin as CoinSymbol,
        path: this.hdPath,
      });

      if (response.success) {
        return response.payload;
      }
      throw trezorResponseError(response);
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
   * This disposes the active Trezor Suite connection
   *
   * @returns void
   */

  public dispose() {
    this.lifecycleGeneration++;
    try {
      void TrezorConnect.dispose().catch((error) => {
        console.log('Error disposing Trezor:', error);
      });
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
      throw trezorResponseError({ payload });
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
        coin: coin as CoinSymbol,
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

  public async signUtxoTransaction(utxoTransaction: any, psbt: Psbt) {
    // Capture approval before the device await. Witnesses and scriptSigs are
    // signatures, but every unsigned transaction field must remain identical.
    const unsignedSnapshot = (transaction: any): string =>
      JSON.stringify({
        version: transaction.version,
        locktime: transaction.locktime,
        inputs: (transaction.txInputs || transaction.ins).map((input: any) => ({
          hash: Buffer.from(input.hash).toString('hex'),
          index: input.index,
          sequence: input.sequence,
        })),
        outputs: (transaction.txOutputs || transaction.outs).map(
          (output: any) => ({
            script: Buffer.from(output.script).toString('hex'),
            value: output.value.toString(),
          })
        ),
      });
    const approvedTransaction = unsignedSnapshot(psbt);
    const approvedFinalInputs = psbt.data.inputs.map(finalizedFields);
    const payload = await this.executeWithRetry(async () => {
      const response = await TrezorConnect.signTransaction(utxoTransaction);
      if (!response.success) {
        throw trezorResponseError(response, 'Trezor sign failed: ');
      }
      return response.payload;
    }, 'signUtxoTransaction');

    const tx = bitcoinjs.Transaction.fromHex(payload.serializedTx);
    if (
      unsignedSnapshot(tx) !== approvedTransaction ||
      unsignedSnapshot(psbt) !== approvedTransaction
    ) {
      throw new Error('Trezor returned a different unsigned transaction');
    }
    // Finalized inputs belong to another signer. Neither the device response
    // nor concurrent code may replace their approved scripts or witnesses.
    if (
      approvedFinalInputs.some((approved, index) => {
        const current = finalizedFields(psbt.data.inputs[index]);
        if (!approved) return current !== null;
        return (
          !current ||
          current.scriptSig !== approved.scriptSig ||
          current.witness !== approved.witness ||
          Buffer.from(tx.ins[index].script).toString('hex') !==
            approved.scriptSig ||
          serializeWitness(tx.ins[index].witness || []).toString('hex') !==
            approved.witness
        );
      })
    ) {
      throw new Error('Trezor changed an already-finalized input');
    }
    for (const i of this.range(psbt.data.inputs.length)) {
      if (approvedFinalInputs[i]) continue;
      if (tx.ins[i].witness == null || tx.ins[i].witness.length !== 2) {
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
      syscoinjs.utils.finalizePSBT(psbt);
    } catch (err) {
      console.log(err);
    }
    return psbt;
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
    if (!networkInfo) {
      // If network info is not available, make a best guess based on address format
      // This is a fallback for hardware wallet scenarios
      if (this.isBech32(address)) {
        const decoded = fromBech32(address);
        return decoded.data.length === 32; // 32 bytes = P2WSH
      }
      // For non-bech32, we can't reliably determine without network info
      // Default to false (P2PKH) as it's more common
      return false;
    }

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

  public convertToTrezorFormat({ psbt, coin, network }: any) {
    const trezortx: any = {};

    trezortx.coin = coin;
    trezortx.version = psbt.version;
    trezortx.locktime = psbt.locktime;
    trezortx.inputs = [];
    trezortx.outputs = [];

    for (let i = 0; i < psbt.txInputs.length; i++) {
      const input = psbt.txInputs[i];
      const inputItem: any = {};
      inputItem.prev_index = input.index;
      const hashBuf = Buffer.from(input.hash);
      const prevHashHex = hashBuf.reverse().toString('hex'); // 64-char hex
      inputItem.prev_hash = prevHashHex;
      if (input.sequence !== undefined) inputItem.sequence = input.sequence;

      const dataInput = psbt.data.inputs[i];

      if (dataInput.finalScriptSig || dataInput.finalScriptWitness) {
        // A finalized co-signer input is supplied as public transaction data,
        // never as a private derivation request to this device.
        let prevout = dataInput.witnessUtxo;
        if (dataInput.nonWitnessUtxo) {
          const previous = bitcoinjs.Transaction.fromBuffer(
            Buffer.from(dataInput.nonWitnessUtxo)
          );
          const output = previous.outs[input.index];
          if (
            !Buffer.from(previous.getHash()).equals(Buffer.from(input.hash)) ||
            !output ||
            (prevout &&
              (!Buffer.from(prevout.script).equals(
                Buffer.from(output.script)
              ) ||
                prevout.value.toString() !== output.value.toString()))
          ) {
            throw new Error('Trezor external input has an invalid prevout');
          }
          prevout = output;
        }
        if (!prevout || prevout.value === undefined || !prevout.script) {
          throw new Error('Trezor external input is missing its prevout');
        }
        inputItem.script_type = 'EXTERNAL';
        inputItem.amount = prevout.value.toString();
        inputItem.script_pubkey = Buffer.from(prevout.script).toString('hex');
        if (dataInput.finalScriptSig)
          inputItem.script_sig = Buffer.from(dataInput.finalScriptSig).toString(
            'hex'
          );
        if (dataInput.finalScriptWitness)
          inputItem.witness = Buffer.from(
            dataInput.finalScriptWitness
          ).toString('hex');
        trezortx.inputs.push(inputItem);
        continue;
      }

      // Resolve derivation path for this input
      let resolvedPath: string | null = null;
      const tapDer =
        dataInput.tapBip32Derivation && dataInput.tapBip32Derivation.length > 0
          ? dataInput.tapBip32Derivation[0]
          : null;
      const b32Der =
        dataInput.bip32Derivation && dataInput.bip32Derivation.length > 0
          ? dataInput.bip32Derivation[0]
          : null;

      if (tapDer && tapDer.path) {
        resolvedPath = tapDer.path;
      } else if (b32Der && b32Der.path) {
        resolvedPath = b32Der.path;
      } else if (dataInput.unknownKeyVals && dataInput.unknownKeyVals.length) {
        for (const kv of dataInput.unknownKeyVals) {
          if (Buffer.isBuffer(kv.key) && kv.key.toString() === 'path') {
            resolvedPath = kv.value.toString();
            break;
          }
        }
      }

      if (!resolvedPath) {
        throw new Error(
          'convertToTrezorFormat: Missing path (tapBip32Derivation/bip32Derivation/unknownKeyVals)'
        );
      }

      // Map path to Trezor address_n
      inputItem.address_n = this.convertToAddressNFormat(resolvedPath);

      // Coerce witnessUtxo.script to Buffer for downstream helpers
      const inScriptBuf =
        dataInput && dataInput.witnessUtxo && dataInput.witnessUtxo.script
          ? Buffer.isBuffer(dataInput.witnessUtxo.script)
            ? dataInput.witnessUtxo.script
            : Buffer.from(dataInput.witnessUtxo.script)
          : Buffer.alloc(0);

      // Select Trezor script_type (detect Taproot explicitly)
      const isTaproot =
        inScriptBuf &&
        inScriptBuf.length === 34 &&
        inScriptBuf[0] === bitcoinops.OP_1 &&
        inScriptBuf[1] === 0x20;

      if (isTaproot) {
        inputItem.script_type = 'SPENDTAPROOT';
      } else {
        const scriptTypes = psbt.getInputType(i);
        switch (scriptTypes) {
          case 'multisig':
            inputItem.script_type = 'SPENDMULTISIG';
            break;
          case 'witnesspubkeyhash':
            inputItem.script_type = 'SPENDWITNESS';
            break;
          default:
            inputItem.script_type = this.isP2WSHScript(inScriptBuf)
              ? 'SPENDP2SHWITNESS'
              : 'SPENDADDRESS';
            break;
        }
      }

      trezortx.inputs.push(inputItem);
    }

    for (let i = 0; i < psbt.txOutputs.length; i++) {
      const output = psbt.txOutputs[i];
      const outputItem: any = {};
      const scriptBuf = Buffer.isBuffer(output.script)
        ? output.script
        : Buffer.from(output.script || []);
      const chunks = decompile(scriptBuf);

      // Debug logging to understand the output structure
      console.log(`[Trezor] Processing output ${i}:`, {
        value: output.value,
        valueType: typeof output.value,
        hasAddress: !!output.address,
        address: output.address,
        scriptLength: output.script?.length,
      });

      // Ensure value exists and convert properly
      if (output.value === undefined || output.value === null) {
        throw new Error(`Output ${i} has no value`);
      }

      // Handle different value types
      let amountStr: string;
      if (typeof output.value === 'bigint') {
        amountStr = output.value.toString();
      } else if (typeof output.value === 'number') {
        amountStr = output.value.toString();
      } else if (typeof output.value === 'string') {
        amountStr = output.value;
      } else {
        throw new Error(
          `Output ${i} has unexpected value type: ${typeof output.value}`
        );
      }

      outputItem.amount = amountStr;
      if (chunks && chunks[0] === bitcoinops.OP_RETURN) {
        outputItem.script_type = 'PAYTOOPRETURN';
        // @ts-ignore
        outputItem.op_return_data = Buffer.from(chunks[1]).toString('hex');
      } else {
        if (output && this.isBech32(output.address)) {
          // Any bech32 witness program (P2WPKH or P2WSH) signs as PAYTOWITNESS
          outputItem.script_type = 'PAYTOWITNESS';
        } else {
          outputItem.script_type = this.isScriptHash(output.address, network)
            ? 'PAYTOSCRIPTHASH'
            : 'PAYTOADDRESS';
        }
        if (output.address) outputItem.address = output.address;
      }

      // Validate that the output has required fields for Trezor
      if (
        outputItem.script_type === 'PAYTOADDRESS' ||
        outputItem.script_type === 'PAYTOSCRIPTHASH' ||
        outputItem.script_type === 'PAYTOWITNESS'
      ) {
        if (!outputItem.address) {
          console.error(
            `[Trezor] Output ${i} missing address for script type ${outputItem.script_type}`
          );
          throw new Error(
            `Output ${i} requires an address for script type ${outputItem.script_type}`
          );
        }
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
      throw trezorResponseError(response);
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
      if (typeof message !== 'string')
        throw new Error('Message must be a string');
      // Use dynamic path generation instead of hardcoded switch
      this.setHdPath(coin, index || 0, slip44);
      const { success, payload } = await TrezorConnect.signMessage({
        path: this.hdPath,
        coin: coin as CoinSymbol,
        message,
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
            message: stripHexPrefix(message),
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
                  trezorResponseError(response)
                );
              }
            })
            .catch((e: any) => {
              reject(e instanceof Error ? e : new Error(String(e)));
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
    version: SignTypedDataVersion
  ) => {
    const { types, primaryType, domain, message } = this._sanitizeData(data);

    const domainSeparatorHash = TypedDataUtils.hashStruct(
      'EIP712Domain',
      this._sanitizeData(domain),
      types,
      version as SignTypedDataVersion.V3 | SignTypedDataVersion.V4
    ).toString('hex');

    let messageHash: string | null = null;

    if (primaryType !== 'EIP712Domain') {
      messageHash = TypedDataUtils.hashStruct(
        primaryType as string,
        this._sanitizeData(message),
        types,
        version as SignTypedDataVersion.V3 | SignTypedDataVersion.V4
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
    data: TypedMessage<any> | TypedDataV1;
    index: number;
    version: SignTypedDataVersion;
  }) {
    return this.executeWithRetry(async () => {
      // Wait between popups
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_POPUPS));

      this.setHdPath('eth', index, 60);
      // Use dynamic path generation for ETH (EVM) - typed data is only used for EVM

      // V1 typed data is not supported by hardware wallets
      if (version === SignTypedDataVersion.V1) {
        throw new Error(
          'Trezor: V1 typed data signing is not supported. Please use V3 or V4.'
        );
      }

      const dataWithHashes = this._transformTypedData(
        data as TypedMessage<any>,
        version
      );

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
        metamask_v4_compat: version === SignTypedDataVersion.V4,
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
      throw trezorResponseError(response);
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
          coin: currency as CoinSymbol,
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
    this.unsubscribeTrezor?.();
    this.unsubscribeTrezor = undefined;
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

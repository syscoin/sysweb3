import ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory } from 'bip32';
import CryptoJS from 'crypto-js';
import omit from 'lodash/omit';
import * as BIP84 from 'syscoinjs-lib/bip84-replacement';

import {
  arrayify,
  dataSlice,
  getAddress,
  hexlify,
  hexZeroPad,
  joinSignature,
  keccak256,
  normalizeTransactionRequest,
  resolveProperties,
  serializeTransaction,
  type Deferrable,
  type TransactionRequest,
} from '../ethers-v6';
import { CustomJsonRpcProvider } from '../providers';

const bip32 = BIP32Factory(ecc);

export type EvmLocalAccount = {
  address: string;
  privateKey: string;
  publicKey: string;
};

const strip0x = (value: string) =>
  value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export const normalizePrivateKey = (privateKey: string | Uint8Array) => {
  let bytes: Buffer;
  if (typeof privateKey === 'string') {
    const stripped = strip0x(privateKey);
    if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
      throw new Error('Invalid EVM private key');
    }
    bytes = Buffer.from(stripped, 'hex');
  } else {
    bytes = Buffer.from(privateKey);
  }

  if (bytes.length !== 32 || !ecc.isPrivate(bytes)) {
    throw new Error('Invalid EVM private key');
  }

  return bytes;
};

export const privateKeyToAccount = (
  privateKey: string | Uint8Array
): EvmLocalAccount => {
  const privateKeyBytes = normalizePrivateKey(privateKey);
  const publicKeyBytes = ecc.pointFromScalar(privateKeyBytes, false);
  if (!publicKeyBytes) {
    throw new Error('Unable to derive EVM public key');
  }

  const address = getAddress(dataSlice(keccak256(publicKeyBytes.slice(1)), 12));

  return {
    address,
    privateKey: `0x${toHex(privateKeyBytes)}`,
    publicKey: hexlify(publicKeyBytes),
  };
};

export const deriveEvmAccountFromMnemonic = (
  mnemonic: string,
  derivationPath: string
): EvmLocalAccount => {
  const normalizedMnemonic = mnemonic.normalize('NFKD');
  if (!BIP84.validateMnemonic(normalizedMnemonic)) {
    throw new Error('Invalid EVM mnemonic');
  }

  const seedWords = CryptoJS.PBKDF2(
    normalizedMnemonic,
    'mnemonic'.normalize('NFKD'),
    {
      hasher: CryptoJS.algo.SHA512,
      iterations: 2048,
      keySize: 512 / 32,
    }
  );
  const seed = Buffer.from(seedWords.toString(CryptoJS.enc.Hex), 'hex');
  const node = bip32.fromSeed(seed).derivePath(derivationPath);

  if (!node.privateKey) {
    throw new Error('Unable to derive EVM private key');
  }

  return privateKeyToAccount(node.privateKey);
};

export const signDigest = (
  digest: string | Uint8Array,
  privateKey: string | Uint8Array
) => {
  const digestBytes =
    typeof digest === 'string' ? Buffer.from(strip0x(digest), 'hex') : digest;
  if (digestBytes.length !== 32) {
    throw new Error('EVM signatures require a 32-byte digest');
  }

  const { signature, recoveryId } = ecc.signRecoverable(
    Buffer.from(digestBytes),
    normalizePrivateKey(privateKey)
  );

  return {
    r: hexZeroPad(hexlify(signature.slice(0, 32)), 32),
    s: hexZeroPad(hexlify(signature.slice(32, 64)), 32),
    recoveryParam: recoveryId,
    v: recoveryId + 27,
  };
};

export const signDigestHex = (
  digest: string | Uint8Array,
  privateKey: string | Uint8Array
) => joinSignature(signDigest(digest, privateKey));

export const hashPersonalMessage = (message: Uint8Array) => {
  const prefix = Buffer.from(
    `\u0019Ethereum Signed Message:\n${message.length}`,
    'utf8'
  );
  return keccak256(Buffer.concat([prefix, Buffer.from(message)]));
};

export const signPersonalMessage = (
  message: string | Uint8Array,
  privateKey: string | Uint8Array
) => {
  const messageBytes =
    typeof message === 'string'
      ? message.startsWith('0x') || message.startsWith('0X')
        ? arrayify(message)
        : Buffer.from(message, 'utf8')
      : message;

  return signDigestHex(
    hashPersonalMessage(Buffer.from(messageBytes)),
    privateKey
  );
};

export const parsePersonalMessage = (hexMessage: string) =>
  Buffer.from(strip0x(hexMessage), 'hex').toString('utf8');

export const signTransaction = (
  transaction: TransactionRequest,
  privateKey: string | Uint8Array
) => {
  const unsigned = serializeTransaction(transaction);
  const digest = keccak256(unsigned);
  const signature = signDigest(digest, privateKey);
  return serializeTransaction(transaction, signature);
};

export const sendLocalEvmTransaction = async (
  provider: CustomJsonRpcProvider,
  privateKey: string,
  transaction: Deferrable<Record<string, any>>,
  beforeBroadcast?: () => void,
  beforeSign?: () => void,
  /** Synchronous final-envelope check; throw to reject. Promise results are rejected. */
  validateBeforeSign?: (transaction: TransactionRequest) => void
) => {
  const account = privateKeyToAccount(privateKey);
  const resolved = await resolveProperties(transaction);
  if (resolved.from && !sameAddress(resolved.from, account.address)) {
    throw new Error('Transaction from does not match EVM private key');
  }

  await provider.verifyConfiguredChainId();

  const tx = normalizeTransactionRequest(
    omit(resolved, ['from', 'ccipReadEnabled', 'customData'])
  ) as TransactionRequest;

  if (!tx.chainId) {
    const network = await provider.getNetwork();
    tx.chainId = Number(network.chainId);
  }
  if (tx.to && typeof tx.to === 'string') {
    try {
      tx.to = getAddress(tx.to);
    } catch {
      const resolvedTo = await provider.resolveName(tx.to);
      if (!resolvedTo) {
        throw new Error(
          `Unable to resolve EVM transaction recipient: ${tx.to}`
        );
      }
      tx.to = getAddress(resolvedTo);
    }
  }
  if (tx.nonce === undefined || tx.nonce === null) {
    tx.nonce = await provider.getTransactionCount(account.address, 'pending');
  }
  if (!tx.gasLimit) {
    tx.gasLimit = await provider.estimateGas({
      ...resolved,
      from: account.address,
    } as any);
  }
  if ((tx.type === 0 || tx.type === 1) && tx.gasPrice == null) {
    tx.gasPrice = await provider.getGasPrice();
  } else if (
    tx.gasPrice == null &&
    (tx.maxFeePerGas == null || tx.maxPriorityFeePerGas == null)
  ) {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
      tx.maxFeePerGas = tx.maxFeePerGas ?? feeData.maxFeePerGas;
      tx.maxPriorityFeePerGas =
        tx.maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas;
      tx.type = tx.type ?? 2;
    } else if (tx.type !== 2) {
      tx.gasPrice = feeData.gasPrice ?? (await provider.getGasPrice());
      tx.type = tx.type ?? 0;
    } else {
      throw new Error('EIP-1559 fee data unavailable');
    }
  }
  if (!tx.data) {
    tx.data = '0x';
  }
  if (!tx.value) {
    tx.value = '0x0';
  }

  beforeSign?.();
  const validation = validateBeforeSign?.(tx) as unknown;
  if (
    validation &&
    (typeof validation === 'object' || typeof validation === 'function') &&
    typeof (validation as PromiseLike<unknown>).then === 'function'
  ) {
    // Final envelope admission must finish synchronously before signing.
    void Promise.resolve(validation).catch(() => undefined);
    throw new Error('Transaction validation must be synchronous');
  }
  const signedTx = signTransaction(tx, privateKey);
  beforeBroadcast?.();
  return provider.sendTransaction(signedTx);
};

export const sameAddress = (left: string, right: string) =>
  getAddress(left).toLowerCase() === getAddress(right).toLowerCase();

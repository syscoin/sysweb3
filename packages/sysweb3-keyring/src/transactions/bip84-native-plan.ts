import {
  address as bitcoinAddress,
  Psbt,
  Transaction,
  Network,
} from 'bitcoinjs-lib';
import { decode as decodeVarInt } from 'varuint-bitcoin';

import {
  deriveBip84PublicAddress,
  parseBip84PublicAccount,
  Bip84PublicAccount,
  Bip84PublicNetwork,
} from '../public-bip84';

export type Bip84NetworkBinding = Readonly<{
  network: Bip84PublicNetwork;
  endpoint: string;
}>;
export type Bip84Guard = Readonly<{ assertCurrent(): void }>;
export type Bip84NativePlan = Readonly<{
  network: Bip84NetworkBinding;
  account: Bip84PublicAccount;
  inputs: readonly Readonly<{
    txid: string;
    vout: number;
    branch: 0 | 1;
    index: number;
  }>[];
  previousTransactions: readonly Readonly<{
    txid: string;
    rawTransaction: string;
  }>[];
  recipient: Readonly<{ address: string; valueSatoshis: string }>;
  change: Readonly<{ index: number; valueSatoshis: string }> | null;
  locktime: 0;
  rbf: boolean;
  feeLimits: Readonly<{
    maxFeeSatoshis: string;
    maxFeeRateSatPerVByte: string;
  }>;
}>;
export type PreparedBip84NativeTransaction = Readonly<{
  plan: Bip84NativePlan;
  unsignedTransaction: string;
  feeSatoshis: string;
}>;
export type Bip84NativeErrorCode =
  | 'INVALID_REQUEST'
  | 'LIMIT_EXCEEDED'
  | 'UNSUPPORTED_NETWORK'
  | 'UNSUPPORTED_PARENT'
  | 'ACCOUNT_MISMATCH'
  | 'INPUT_MISMATCH'
  | 'FEE_LIMIT'
  | 'SIGNATURE_INVALID'
  | 'CANCELLED'
  | 'BUSY';
export class Bip84NativeError extends Error {
  constructor(public readonly code: Bip84NativeErrorCode) {
    super(code);
    this.name = 'Bip84NativeError';
  }
}

// Resource/consent policy, not consensus or relay limits.
export const LIMITS = Object.freeze({
  inputs: 64,
  parentBytes: 1_000_000,
  totalParentBytes: 2_000_000,
  parentComponents: 8192,
  unsignedBytes: 8 * 1024,
  signedBytes: 16 * 1024,
  psbtBytes: 64 * 1024,
  maxFee: 10_000_000n,
  maxFeeRate: 1_000n,
});
const HARDENED = 0x80000000;
const baseNetwork: Network = Object.freeze({
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  bech32: 'bc',
  bip32: Object.freeze({ public: 0x0488b21e, private: 0x0488ade4 }),
  pubKeyHash: 0,
  scriptHash: 5,
  wif: 128,
});
const profiles = Object.freeze({
  bitcoin: Object.freeze({
    chainId: 0,
    slip44: 0,
    currency: 'btc',
    maximumMoney: 2_100_000_000_000_000n,
    addressNetwork: baseNetwork,
  }),
  syscoin: Object.freeze({
    chainId: 57,
    slip44: 57,
    currency: 'sys',
    maximumMoney: 999_999_999_999_999_999n,
    addressNetwork: Object.freeze({
      ...baseNetwork,
      messagePrefix: '\x18Syscoin Signed Message:\n',
      bech32: 'sys',
      pubKeyHash: 0x3f,
    }),
  }),
});
export type Bip84Profile = Readonly<{
  chainId: number;
  slip44: number;
  currency: string;
  maximumMoney: bigint;
  addressNetwork: Network;
}>;
export const bip84Profile = (network: Bip84PublicNetwork): Bip84Profile =>
  profiles[network];
export const fail = (code: Bip84NativeErrorCode): never => {
  throw new Bip84NativeError(code);
};

export function record(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail('INVALID_REQUEST');
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (
      !d ||
      !d.enumerable ||
      !Object.prototype.hasOwnProperty.call(d, 'value')
    )
      return fail('INVALID_REQUEST');
    result[field] = d.value;
  }
  return result;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return fail('INVALID_REQUEST');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 1)
    return fail('INVALID_REQUEST');
  if (length > LIMITS.inputs) return fail('LIMIT_EXCEEDED');
  if (Reflect.ownKeys(value).length !== length + 1)
    return fail('INVALID_REQUEST');
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (
      !d ||
      !d.enumerable ||
      !Object.prototype.hasOwnProperty.call(d, 'value')
    )
      return fail('INVALID_REQUEST');
    result.push(d.value);
  }
  return result;
}
export function index(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= HARDENED
  )
    return fail('INVALID_REQUEST');
  return value as number;
}
function txid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    return fail('INVALID_REQUEST');
  return value;
}
function quantity(value: unknown, max: bigint, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    return fail('INVALID_REQUEST');
  const amount = BigInt(value);
  if (amount > max || (positive && amount === 0n))
    return fail('INVALID_REQUEST');
  return value;
}
export function snapshotBip84Network(value: unknown): Bip84NetworkBinding {
  const n = record(value, ['network', 'endpoint']);
  if (n.network !== 'bitcoin' && n.network !== 'syscoin')
    return fail('UNSUPPORTED_NETWORK');
  if (
    typeof n.endpoint !== 'string' ||
    !n.endpoint ||
    n.endpoint.length > 2048 ||
    n.endpoint.trim() !== n.endpoint ||
    Array.from(n.endpoint).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
    })
  )
    return fail('INVALID_REQUEST');
  return Object.freeze({ network: n.network, endpoint: n.endpoint });
}
export function snapshotBip84Guard(value: unknown): () => void {
  const guard = record(value, ['assertCurrent']).assertCurrent;
  if (typeof guard !== 'function') return fail('INVALID_REQUEST');
  return () => {
    let result: unknown;
    try {
      result = guard();
    } catch {
      return fail('CANCELLED');
    }
    if (result !== undefined) {
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function')
      )
        void Promise.resolve(result).catch(() => undefined);
      return fail('CANCELLED');
    }
  };
}
function snapshotAccount(
  value: unknown,
  network: Bip84PublicNetwork
): Bip84PublicAccount {
  const a = record(value, [
    'network',
    'policy',
    'canonicalKey',
    'accountIndex',
  ]);
  if (a.network !== network || a.policy !== 'bip84-p2wpkh')
    return fail('ACCOUNT_MISMATCH');
  let parsed: Bip84PublicAccount;
  try {
    parsed = parseBip84PublicAccount({
      network,
      accountKey: a.canonicalKey as string,
    });
  } catch {
    return fail('INVALID_REQUEST');
  }
  if (
    parsed.canonicalKey !== a.canonicalKey ||
    parsed.accountIndex !== a.accountIndex
  )
    return fail('ACCOUNT_MISMATCH');
  return parsed;
}
function recipientAddress(value: unknown, network: Network): string {
  if (
    typeof value !== 'string' ||
    value.length > 90 ||
    value !== value.toLowerCase()
  )
    return fail('INVALID_REQUEST');
  try {
    const script = bitcoinAddress.toOutputScript(value, network);
    if (
      script.length !== 22 ||
      script[0] !== 0 ||
      script[1] !== 20 ||
      bitcoinAddress.fromOutputScript(script, network) !== value
    )
      return fail('INVALID_REQUEST');
    return value;
  } catch {
    return fail('INVALID_REQUEST');
  }
}

/** Bound decoded objects as well as wire bytes before bitcoinjs allocates them.
 * One component is an input, output, witness vector or witness item.
 */
function boundedParentEncoding(
  bytes: Buffer,
  remainingComponents: number
): number {
  let offset = 4;
  let components = 0;
  const charge = (count: number) => {
    if (count > remainingComponents - components) return fail('LIMIT_EXCEEDED');
    components += count;
  };
  const skip = (length: number) => {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > bytes.length - offset
    )
      return fail('INVALID_REQUEST');
    offset += length;
  };
  const compact = () => {
    const value = decodeVarInt(bytes, offset);
    offset += value.bytes;
    if (value.bigintValue > BigInt(bytes.length - offset))
      return fail('INVALID_REQUEST');
    return Number(value.bigintValue);
  };
  let inputs = compact();
  let witness = false;
  if (inputs === 0) {
    if (bytes[offset] !== 1) return fail('INVALID_REQUEST');
    offset++;
    witness = true;
    inputs = compact();
  }
  if (inputs === 0 || inputs > Math.floor((bytes.length - offset) / 41))
    return fail('INVALID_REQUEST');
  charge(inputs);
  for (let i = 0; i < inputs; i++) {
    skip(36);
    skip(compact());
    skip(4);
  }
  const outputs = compact();
  if (outputs === 0 || outputs > Math.floor((bytes.length - offset) / 9))
    return fail('INVALID_REQUEST');
  charge(outputs);
  for (let i = 0; i < outputs; i++) {
    skip(8);
    skip(compact());
  }
  if (witness) {
    charge(inputs);
    for (let i = 0; i < inputs; i++) {
      const items = compact();
      charge(items);
      for (let j = 0; j < items; j++) skip(compact());
    }
  }
  skip(4);
  if (offset !== bytes.length) return fail('INVALID_REQUEST');
  return components;
}

export type ValidatedBip84Plan = {
  prepared: PreparedBip84NativeTransaction;
  psbt: Psbt;
  previousOutputs: readonly Readonly<{ script: Uint8Array; value: bigint }>[];
};

/** Internal result includes owned mutable transaction data; public entry exports only prepare. */
export function validateBip84NativePlan(value: unknown): ValidatedBip84Plan {
  try {
    const r = record(value, [
      'network',
      'account',
      'inputs',
      'previousTransactions',
      'recipient',
      'change',
      'locktime',
      'rbf',
      'feeLimits',
    ]);
    const network = snapshotBip84Network(r.network);
    const profile = bip84Profile(network.network);
    const account = snapshotAccount(r.account, network.network);
    if (r.locktime !== 0 || typeof r.rbf !== 'boolean')
      return fail('INVALID_REQUEST');
    const inputs = Object.freeze(
      array(r.inputs).map((v) => {
        const i = record(v, ['txid', 'vout', 'branch', 'index']);
        if (
          !Number.isSafeInteger(i.vout) ||
          (i.vout as number) < 0 ||
          (i.vout as number) > 0xffffffff ||
          (i.branch !== 0 && i.branch !== 1)
        )
          return fail('INVALID_REQUEST');
        return Object.freeze({
          txid: txid(i.txid),
          vout: i.vout as number,
          branch: i.branch,
          index: index(i.index),
        });
      })
    );
    let totalParentBytes = 0;
    const previousTransactions = Object.freeze(
      array(r.previousTransactions)
        .map((v) => {
          const p = record(v, ['txid', 'rawTransaction']);
          const id = txid(p.txid);
          if (typeof p.rawTransaction !== 'string')
            return fail('INVALID_REQUEST');
          if (p.rawTransaction.length > 2 * LIMITS.parentBytes)
            return fail('LIMIT_EXCEEDED');
          if (
            p.rawTransaction.length < 20 ||
            p.rawTransaction.length % 2 !== 0 ||
            !/^[0-9a-f]+$/.test(p.rawTransaction)
          )
            return fail('INVALID_REQUEST');
          totalParentBytes += p.rawTransaction.length / 2;
          if (totalParentBytes > LIMITS.totalParentBytes)
            return fail('LIMIT_EXCEEDED');
          return Object.freeze({ txid: id, rawTransaction: p.rawTransaction });
        })
        .sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0))
    );
    // Preflight the whole parent set before the first object-heavy decode.
    const encodedParents = new Map<string, Buffer>();
    let parentComponents = 0;
    for (const p of previousTransactions) {
      if (encodedParents.has(p.txid)) return fail('INVALID_REQUEST');
      const bytes = Buffer.from(p.rawTransaction, 'hex');
      const version = bytes.readInt32LE(0);
      if (version !== 1 && version !== 2) return fail('UNSUPPORTED_PARENT');
      parentComponents += boundedParentEncoding(
        bytes,
        LIMITS.parentComponents - parentComponents
      );
      encodedParents.set(p.txid, bytes);
    }
    const parents = new Map<string, Transaction>();
    for (const p of previousTransactions) {
      const parent = Transaction.fromBuffer(encodedParents.get(p.txid)!);
      if (parent.toHex() !== p.rawTransaction || parent.getId() !== p.txid)
        return fail('INPUT_MISMATCH');
      if (parent.isCoinbase()) return fail('UNSUPPORTED_PARENT');
      let total = 0n;
      for (const output of parent.outs) {
        if (output.value < 0n || output.value > profile.maximumMoney)
          return fail('INVALID_REQUEST');
        total += output.value;
        if (total > profile.maximumMoney) return fail('INVALID_REQUEST');
      }
      parents.set(p.txid, parent);
    }
    const recipientRecord = record(r.recipient, ['address', 'valueSatoshis']);
    const recipient = Object.freeze({
      address: recipientAddress(
        recipientRecord.address,
        profile.addressNetwork
      ),
      valueSatoshis: quantity(
        recipientRecord.valueSatoshis,
        profile.maximumMoney,
        true
      ),
    });
    const changeRecord =
      r.change === null ? null : record(r.change, ['index', 'valueSatoshis']);
    const change =
      changeRecord === null
        ? null
        : Object.freeze({
            index: index(changeRecord.index),
            valueSatoshis: quantity(
              changeRecord.valueSatoshis,
              profile.maximumMoney,
              true
            ),
          });
    const f = record(r.feeLimits, ['maxFeeSatoshis', 'maxFeeRateSatPerVByte']);
    const feeLimits = Object.freeze({
      maxFeeSatoshis: quantity(f.maxFeeSatoshis, LIMITS.maxFee),
      maxFeeRateSatPerVByte: quantity(
        f.maxFeeRateSatPerVByte,
        LIMITS.maxFeeRate
      ),
    });
    const psbt = new Psbt({ network: profile.addressNetwork });
    psbt.setVersion(2);
    psbt.setLocktime(0);
    const seen = new Set<string>();
    const used = new Set<string>();
    const previousOutputs: { script: Uint8Array; value: bigint }[] = [];
    let inputTotal = 0n;
    for (const i of inputs) {
      const outpoint = `${i.txid}:${i.vout}`;
      if (seen.has(outpoint)) return fail('INPUT_MISMATCH');
      seen.add(outpoint);
      const previous = parents.get(i.txid)?.outs[i.vout];
      if (!previous) return fail('INPUT_MISMATCH');
      used.add(i.txid);
      const derived = deriveBip84PublicAddress({
        network: network.network,
        accountKey: account.canonicalKey,
        branch: i.branch,
        index: i.index,
      });
      if (Buffer.from(previous.script).toString('hex') !== derived.scriptPubKey)
        return fail('INPUT_MISMATCH');
      inputTotal += previous.value;
      if (inputTotal > profile.maximumMoney) return fail('INVALID_REQUEST');
      previousOutputs.push({
        script: Uint8Array.from(previous.script),
        value: previous.value,
      });
      psbt.addInput({
        hash: i.txid,
        index: i.vout,
        sequence: r.rbf ? 0xfffffffd : 0xffffffff,
        witnessUtxo: {
          script: Uint8Array.from(previous.script),
          value: previous.value,
        },
        sighashType: Transaction.SIGHASH_ALL,
      });
    }
    if (used.size !== parents.size) return fail('INVALID_REQUEST');
    psbt.addOutput({
      address: recipient.address,
      value: BigInt(recipient.valueSatoshis),
    });
    let outputTotal = BigInt(recipient.valueSatoshis);
    if (change) {
      const derived = deriveBip84PublicAddress({
        network: network.network,
        accountKey: account.canonicalKey,
        branch: 1,
        index: change.index,
      });
      psbt.addOutput({
        script: Buffer.from(derived.scriptPubKey, 'hex'),
        value: BigInt(change.valueSatoshis),
      });
      outputTotal += BigInt(change.valueSatoshis);
    }
    if (outputTotal > profile.maximumMoney) return fail('INVALID_REQUEST');
    const fee = inputTotal - outputTotal;
    if (fee < 0n || fee > BigInt(feeLimits.maxFeeSatoshis))
      return fail('FEE_LIMIT');
    const unsignedBytes = psbt.data.globalMap.unsignedTx.toBuffer();
    if (
      unsignedBytes.length > LIMITS.unsignedBytes ||
      psbt.toBuffer().length > LIMITS.psbtBytes
    )
      return fail('LIMIT_EXCEEDED');
    // A valid P2WPKH DER signature (including sighash byte) is at most 73 bytes.
    // This only rejects fees that cannot fit the rate cap even at maximum size.
    // Signing must check the actual final vsize again before releasing bytes.
    const maximumSigned = Transaction.fromBuffer(unsignedBytes);
    inputs.forEach((_, i) =>
      maximumSigned.setWitness(i, [new Uint8Array(73), new Uint8Array(33)])
    );
    if (maximumSigned.toBuffer().length > LIMITS.signedBytes)
      return fail('LIMIT_EXCEEDED');
    if (
      fee >
      BigInt(maximumSigned.virtualSize()) *
        BigInt(feeLimits.maxFeeRateSatPerVByte)
    )
      return fail('FEE_LIMIT');
    const plan: Bip84NativePlan = Object.freeze({
      network,
      account,
      inputs,
      previousTransactions,
      recipient,
      change,
      locktime: 0,
      rbf: r.rbf,
      feeLimits,
    });
    return {
      prepared: Object.freeze({
        plan,
        unsignedTransaction: Buffer.from(unsignedBytes).toString('hex'),
        feeSatoshis: fee.toString(),
      }),
      psbt,
      previousOutputs,
    };
  } catch (error) {
    if (error instanceof Bip84NativeError) throw error;
    return fail('INVALID_REQUEST');
  }
}

/** Pure bounded preparation; returned data carries no signing authorization. */
export function prepareBip84NativeTransaction(
  plan: Bip84NativePlan
): PreparedBip84NativeTransaction {
  return validateBip84NativePlan(plan).prepared;
}

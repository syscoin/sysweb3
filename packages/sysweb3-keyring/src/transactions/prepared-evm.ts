import { getAddress } from 'ethers/address';
import { keccak256 } from 'ethers/crypto';
import { Transaction } from 'ethers/transaction';

import { signTransaction } from './evm-local-signer';

/**
 * Fully specified type-0/type-2 transaction. Quantities are canonical decimal
 * integer strings, nonce is at most MAX_SAFE_INTEGER, and gasLimit is uint64.
 * Addresses must be nonzero hex addresses; valid casing is normalized. Data is
 * even-length 0x hex, at most 16 KiB. Contract creation/access lists are omitted.
 */
export type PreparedEvmTransaction = Readonly<
  {
    from: string;
    to: string;
    chainId: string;
    nonce: string;
    value: string;
    gasLimit: string;
    data: string;
  } & (
    | { type: 0; gasPrice: string }
    | { type: 2; maxFeePerGas: string; maxPriorityFeePerGas: string }
  )
>;

export type PreparedSoftwareEvmSigningRequest = Readonly<{
  account: Readonly<{
    id: number;
    type: 'HDAccount' | 'Imported';
    expectedAddress: string;
  }>;
  network: Readonly<{
    kind: 'ethereum';
    chainId: string;
    slip44: 60;
    /** Exact configured endpoint binding; signing does not contact or authenticate it. */
    url: string;
  }>;
  transaction: PreparedEvmTransaction;
}>;

export type PreparedEvmSigningOptions = Readonly<{
  /** Host-owned consent/session/review expiry check. Must return undefined. */
  assertCurrent(): void;
}>;

export type SignedPreparedEvmTransaction = Readonly<{
  rawTransaction: string;
  hash: string;
  unsignedHash: string;
  from: string;
  /** Canonical signed fields, checked against the requested envelope. */
  transaction: PreparedEvmTransaction;
}>;

const UINT256 = (1n << 256n) - 1n;
const UINT64 = (1n << 64n) - 1n;
const MAX_DATA_BYTES = 16 * 1024;
const invalid = () => new TypeError('Invalid prepared EVM signing request');

/** Snapshot values without invoking accessors or accepting hidden fields. */
function record(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    )
      throw invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function quantity(value: unknown, maximum = UINT256, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value))
    throw invalid();
  const parsed = BigInt(value);
  if (parsed > maximum || (positive && parsed === 0n)) throw invalid();
  return value;
}

function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw invalid();
  let canonical: string;
  try {
    canonical = getAddress(value);
  } catch {
    throw invalid();
  }
  if (/^0x0{40}$/i.test(canonical)) throw invalid();
  return canonical;
}

export function snapshotPreparedEvmRequest(
  input: unknown
): PreparedSoftwareEvmSigningRequest {
  const root = record(input, ['account', 'network', 'transaction']);
  const account = record(root.account, ['id', 'type', 'expectedAddress']);
  if (
    !Number.isSafeInteger(account.id) ||
    (account.id as number) < 0 ||
    (account.id as number) > 0x7fffffff ||
    (account.type !== 'HDAccount' && account.type !== 'Imported')
  )
    throw invalid();
  const network = record(root.network, ['kind', 'chainId', 'slip44', 'url']);
  if (
    network.kind !== 'ethereum' ||
    network.slip44 !== 60 ||
    typeof network.url !== 'string' ||
    !network.url ||
    network.url.length > 4096 ||
    network.url.trim() !== network.url ||
    // eslint-disable-next-line no-control-regex -- Reject endpoint control characters and lone surrogates.
    /[\uD800-\uDFFF\u0000-\u001f\u007f]/u.test(network.url)
  )
    throw invalid();
  const chainId = quantity(network.chainId, UINT256, true);
  // Read the discriminator from a data property before choosing the exact schema.
  if (!root.transaction || typeof root.transaction !== 'object')
    throw invalid();
  const typeDescriptor = Object.getOwnPropertyDescriptor(
    root.transaction,
    'type'
  );
  if (
    !typeDescriptor ||
    !Object.prototype.hasOwnProperty.call(typeDescriptor, 'value')
  )
    throw invalid();
  const type = typeDescriptor.value;
  if (type !== 0 && type !== 2) throw invalid();
  const fields = [
    'type',
    'from',
    'to',
    'chainId',
    'nonce',
    'value',
    'gasLimit',
    'data',
  ];
  const transaction = record(
    root.transaction,
    type === 0
      ? [...fields, 'gasPrice']
      : [...fields, 'maxFeePerGas', 'maxPriorityFeePerGas']
  );
  const from = address(transaction.from);
  const expectedAddress = address(account.expectedAddress);
  if (
    from !== expectedAddress ||
    quantity(transaction.chainId, UINT256, true) !== chainId
  )
    throw invalid();
  if (
    typeof transaction.data !== 'string' ||
    transaction.data.length > 2 + 2 * MAX_DATA_BYTES ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.data)
  )
    throw invalid();
  const common = {
    from,
    to: address(transaction.to),
    chainId,
    nonce: quantity(transaction.nonce, BigInt(Number.MAX_SAFE_INTEGER)),
    value: quantity(transaction.value),
    gasLimit: quantity(transaction.gasLimit, UINT64, true),
    data: transaction.data.toLowerCase(),
  };
  const fees =
    type === 0
      ? { type: 0 as const, gasPrice: quantity(transaction.gasPrice) }
      : {
          type: 2 as const,
          maxFeePerGas: quantity(transaction.maxFeePerGas),
          maxPriorityFeePerGas: quantity(transaction.maxPriorityFeePerGas),
        };
  if (
    fees.type === 2 &&
    BigInt(fees.maxPriorityFeePerGas) > BigInt(fees.maxFeePerGas)
  )
    throw invalid();
  const maximumFee =
    BigInt(common.gasLimit) *
    BigInt(fees.type === 0 ? fees.gasPrice : fees.maxFeePerGas);
  if (maximumFee + BigInt(common.value) > UINT256) throw invalid();
  return Object.freeze({
    account: Object.freeze({
      id: account.id as number,
      type: account.type,
      expectedAddress,
    }),
    network: Object.freeze({
      kind: 'ethereum',
      chainId,
      slip44: 60,
      url: network.url,
    }),
    transaction: Object.freeze({ ...common, ...fees }),
  });
}

export function preparedEvmGuard(input: unknown): () => void {
  const options = record(input, ['assertCurrent']);
  if (typeof options.assertCurrent !== 'function') throw invalid();
  const guard = options.assertCurrent;
  return () => {
    const result: unknown = guard();
    if (result !== undefined) {
      // Consume a rejected async guard without allowing it to authorize signing.
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function')
      )
        void Promise.resolve(result).catch(() => undefined);
      throw new TypeError(
        'Prepared EVM signing guard must return undefined synchronously'
      );
    }
  };
}

/** Internal, network-free signing. The key never becomes part of the result. */
export function signPreparedEvmEnvelope(
  transaction: PreparedEvmTransaction,
  privateKey: string
): SignedPreparedEvmTransaction {
  const unsigned = {
    type: transaction.type,
    to: transaction.to,
    chainId: BigInt(transaction.chainId),
    nonce: Number(transaction.nonce),
    value: BigInt(transaction.value),
    gasLimit: BigInt(transaction.gasLimit),
    data: transaction.data,
    ...(transaction.type === 0
      ? { gasPrice: BigInt(transaction.gasPrice) }
      : {
          maxFeePerGas: BigInt(transaction.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas),
        }),
  };
  const expected = Transaction.from(unsigned);
  const rawTransaction = signTransaction(unsigned, privateKey);
  const signed = Transaction.from(rawTransaction);
  if (
    !signed.isSigned() ||
    signed.from !== transaction.from ||
    signed.unsignedSerialized !== expected.unsignedSerialized ||
    signed.unsignedHash !== expected.unsignedHash ||
    signed.hash !== keccak256(rawTransaction)
  )
    throw new Error(
      'Prepared EVM signature does not match requested transaction'
    );
  return Object.freeze({
    rawTransaction,
    hash: signed.hash!,
    unsignedHash: signed.unsignedHash,
    from: signed.from!,
    transaction,
  });
}

import {
  ClearSignContextType,
  type ContextModule,
} from '@ledgerhq/context-module';
import {
  SignerEthBuilder,
  type Signature as DeviceSignature,
  type TypedData,
} from '@ledgerhq/device-signer-kit-ethereum';
import { TypedDataUtils, SignTypedDataVersion } from '@metamask/eth-sig-util';
import {
  computeAddress,
  getAddress,
  hashMessage,
  recoverAddress,
  Signature,
  Transaction,
} from 'ethers';

import {
  ledgerHostError,
  type LedgerEvmHost,
  type LedgerTypedData,
  type LedgerBlindSigningIntent,
  type LedgerEvmConfig,
} from './host-types';

import type { LedgerDmkOperation, LedgerDmkSession } from './dmk-session';

export type { LedgerBlindSigningIntent, LedgerEvmConfig } from './host-types';

const invalid = (message: string) =>
  ledgerHostError('LEDGER_INVALID_REQUEST', message);
const unavailable = () =>
  ledgerHostError(
    'HARDWARE_CLEAR_SIGNING_UNAVAILABLE',
    'This Ledger operation requires explicit approval because clear signing is not guaranteed'
  );

/** No remote metadata, transaction checks, or signing telemetry by default. */
export const offlineLedgerContext: ContextModule = Object.freeze({
  getContexts: async () => [],
  getFieldContext: async () => ({
    type: ClearSignContextType.ERROR as const,
    error: unavailable(),
  }),
  getTypedDataFilters: async () => ({
    type: 'error' as const,
    error: unavailable(),
  }),
  report: async () => undefined,
  signReport: async () => undefined,
});

const accountPath = (index: number): string => {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff)
    throw invalid('Invalid Ledger address index');
  // Preserve the existing Ledger wallet layout: account 0, address index i.
  return `44'/60'/0'/0/${index}`;
};

const hexBytes = (value: string, label: string): Uint8Array => {
  if (typeof value !== 'string') throw invalid(`Invalid ${label}`);
  const hex = value.replace(/^0x/i, '');
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw invalid(`Invalid ${label}`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
};

const expectedAddress = (value: string): string => {
  try {
    return getAddress(value);
  } catch {
    throw invalid('Invalid expected Ledger address');
  }
};

function copyTypedValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): any {
  if (depth > 64) throw invalid('Typed data nesting is too deep');
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('Invalid typed data number');
    return value;
  }
  if (value instanceof Uint8Array)
    return `0x${Buffer.from(value).toString('hex')}`;
  if (typeof value !== 'object' || value === undefined)
    throw invalid('Invalid typed data value');
  if (seen.has(value)) throw invalid('Circular typed data');
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    throw invalid('Invalid typed data object');
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => copyTypedValue(item, seen, depth + 1));
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor))
        throw invalid('Typed data accessors are not supported');
      if (descriptor.value !== undefined)
        result[key] = copyTypedValue(descriptor.value, seen, depth + 1);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

const normalizeSignature = (
  output: DeviceSignature,
  digest: string,
  address: string
) => {
  try {
    if (
      !/^0x[0-9a-f]{64}$/i.test(output.r) ||
      !/^0x[0-9a-f]{64}$/i.test(output.s) ||
      !Number.isSafeInteger(output.v) ||
      output.v < 0
    )
      throw new Error('Malformed signature');
    const signature = Signature.from(output);
    if (
      recoverAddress(digest, signature).toLowerCase() !== address.toLowerCase()
    )
      throw new Error('Wrong signer');
    return {
      signature,
      r: output.r.slice(2),
      s: output.s.slice(2),
      v: output.v.toString(16),
    };
  } catch {
    throw ledgerHostError(
      'LEDGER_INVALID_SIGNATURE',
      'Ledger returned an invalid signature for this request'
    );
  }
};

const signerFor = (operation: LedgerDmkOperation) =>
  new SignerEthBuilder({ dmk: operation.dmk, sessionId: operation.sessionId })
    .withContextModule(offlineLedgerContext)
    .build();

type Signer = ReturnType<typeof signerFor>;
async function verifySigner(
  operation: LedgerDmkOperation,
  signer: Signer,
  path: string,
  expected: string
) {
  const output = await operation.runAction(() =>
    signer.getAddress(path, { checkOnDevice: false })
  );
  operation.assertCurrent();
  try {
    const publicKey = output.publicKey.startsWith('0x')
      ? output.publicKey
      : `0x${output.publicKey}`;
    if (
      getAddress(output.address) !== expected ||
      computeAddress(publicKey) !== expected
    )
      throw new Error('Wrong device account');
  } catch {
    throw ledgerHostError(
      'HARDWARE_ACCOUNT_MISMATCH',
      'Ledger account does not match the approved request'
    );
  }
}

async function approveBlindCapability(
  operation: LedgerDmkOperation,
  config: LedgerEvmConfig,
  intent: LedgerBlindSigningIntent
) {
  operation.assertCurrent();
  const approved = await config.confirmBlindSigning!(
    freezeDeep(intent),
    operation.signal
  );
  operation.assertCurrent();
  if (approved !== true) throw unavailable();
}

/** EVM facade preserves existing SDK signature formats and performs no broadcast. */
export function createLedgerEvmAdapter(
  session: LedgerDmkSession,
  config: LedgerEvmConfig = {}
): LedgerEvmHost {
  const policy = Object.freeze({
    confirmBlindSigning: config.confirmBlindSigning,
  });
  return {
    async getAddress(request, options) {
      const path = accountPath(request.accountIndex);
      const checkOnDevice = request.checkOnDevice === true;
      const chainId = request.chainId;
      if (
        chainId !== undefined &&
        (!Number.isSafeInteger(chainId) || chainId <= 0)
      )
        throw invalid('Invalid Ledger chain ID');
      return session.runExclusive(async (operation) => {
        const signer = signerFor(operation);
        const output = await operation.runAction(() =>
          signer.getAddress(path, { checkOnDevice, chainId })
        );
        operation.assertCurrent();
        try {
          const address = getAddress(output.address);
          const publicKey = output.publicKey.replace(/^0x/i, '');
          if (computeAddress(`0x${publicKey}`) !== address)
            throw new Error('Invalid public key');
          return { address, publicKey };
        } catch {
          throw ledgerHostError(
            'LEDGER_INVALID_RESPONSE',
            'Ledger returned an invalid address or public key'
          );
        }
      }, options);
    },

    async signTransaction(request, options) {
      if (!policy.confirmBlindSigning) throw unavailable();
      const path = accountPath(request.accountIndex);
      const address = expectedAddress(request.expectedAddress);
      const bytes = hexBytes(request.unsignedTxHex, 'unsigned transaction');
      let transaction: Transaction;
      try {
        transaction = Transaction.from(
          `0x${Buffer.from(bytes).toString('hex')}`
        );
        if (
          transaction.signature ||
          transaction.chainId <= 0n ||
          transaction.chainId >
            BigInt(Math.floor((Number.MAX_SAFE_INTEGER - 36) / 2))
        )
          throw new Error('Unsupported transaction');
      } catch {
        throw invalid('Invalid unsigned Ledger transaction');
      }
      const unsignedTxHex = transaction.unsignedSerialized;
      const digest = transaction.unsignedHash;
      const intent: LedgerBlindSigningIntent = {
        kind: 'transaction',
        accountIndex: request.accountIndex,
        derivationPath: path,
        expectedAddress: address,
        unsignedTxHex,
        chainId: transaction.chainId.toString(),
        digest,
      };
      return session.runExclusive(async (operation) => {
        const signer = signerFor(operation);
        await verifySigner(operation, signer, path, address);
        await approveBlindCapability(operation, policy, intent);
        const output = await operation.runAction(() =>
          signer.signTransaction(
            path,
            hexBytes(unsignedTxHex, 'unsigned transaction')
          )
        );
        operation.assertCurrent();
        const { r, s, v } = normalizeSignature(output, digest, address);
        return { r, s, v };
      }, options);
    },

    async signPersonalMessage(request, options) {
      const path = accountPath(request.accountIndex);
      const address = expectedAddress(request.expectedAddress);
      const bytes = hexBytes(request.messageHex, 'personal message');
      const digest = hashMessage(bytes);
      return session.runExclusive(async (operation) => {
        const signer = signerFor(operation);
        await verifySigner(operation, signer, path, address);
        // Strings in the DSK use ASCII encoding; pass the reviewed bytes directly.
        const output = await operation.runAction(() =>
          signer.signMessage(path, bytes)
        );
        operation.assertCurrent();
        return normalizeSignature(output, digest, address).signature.serialized;
      }, options);
    },

    async signTypedData(request, options) {
      if (!policy.confirmBlindSigning) throw unavailable();
      const path = accountPath(request.accountIndex);
      const address = expectedAddress(request.expectedAddress);
      if (request.version !== 'V3' && request.version !== 'V4')
        throw invalid('Ledger supports typed data V3 and V4 only');
      let data: LedgerTypedData, digest: string;
      try {
        data = copyTypedValue(request.data);
        digest = `0x${TypedDataUtils.eip712Hash(
          data as any,
          request.version as SignTypedDataVersion.V3 | SignTypedDataVersion.V4
        ).toString('hex')}`;
      } catch {
        throw invalid('Invalid Ledger typed data for the requested version');
      }
      const intent: LedgerBlindSigningIntent = {
        kind: 'typed-data',
        accountIndex: request.accountIndex,
        derivationPath: path,
        expectedAddress: address,
        version: request.version,
        data: copyTypedValue(data),
        digest,
      };
      return session.runExclusive(async (operation) => {
        const signer = signerFor(operation);
        await verifySigner(operation, signer, path, address);
        await approveBlindCapability(operation, policy, intent);
        // The DSK parser may add EIP712Domain; do not expose that mutation to callers or approval UI.
        const deviceData = copyTypedValue(data) as TypedData;
        const output = await operation.runAction(() =>
          signer.signTypedData(path, deviceData)
        );
        operation.assertCurrent();
        return normalizeSignature(output, digest, address).signature.serialized;
      }, options);
    },
  };
}

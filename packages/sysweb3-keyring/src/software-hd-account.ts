import type { IKeyringAccountState } from './types';

/** Fixed Ethereum BIP44 address index; not an arbitrary derivation path. */
export interface EvmHdRuntimeAccountRequest {
  readonly index: number;
}

/** Trusted host guard must return undefined synchronously. */
export interface EvmHdRuntimeAccountOptions {
  assertCurrent: () => void;
}

/**
 * Internal runtime record, matching createFirstAccount/addNewAccount. Contains a
 * password-encrypted xprv; never publish it or persist it as a public catalogue.
 * No plaintext private key, mnemonic, or password is returned.
 */
export type EncryptedEvmHdRuntimeAccount = IKeyringAccountState;

export function snapshotEvmHdIndex(value: EvmHdRuntimeAccountRequest): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Ethereum HD account index');
  }
  const prototype = Object.getPrototypeOf(value);
  const names = Reflect.ownKeys(value);
  const index = Object.getOwnPropertyDescriptor(value, 'index');
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    names.length !== 1 ||
    names[0] !== 'index' ||
    !index ||
    !index.enumerable ||
    !('value' in index) ||
    !Number.isSafeInteger(index.value) ||
    index.value < 0 ||
    index.value > 0x7fffffff
  )
    throw new TypeError('Invalid Ethereum HD account index');
  return index.value;
}

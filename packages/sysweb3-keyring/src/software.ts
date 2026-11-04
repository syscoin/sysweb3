/** Software-only entry: explicit host storage, no browser/device initialization. */
import { KeyringCore } from './keyring-core';
import { createVaultPersistence } from './storage-core';

import type { KeyringStoragePort } from './keyring-core';
import type {
  EncryptedEvmHdRuntimeAccount,
  EvmHdRuntimeAccountOptions,
  EvmHdRuntimeAccountRequest,
} from './software-hd-account';
import type {
  Bip84HdPublicRequest,
  Bip84HdPublicResult,
} from './software-utxo-account';
import type { VaultPersistence } from './storage-core';
import type { Bip84Guard } from './transactions/bip84-native-plan';
import type {
  PreparedBip84SigningRequest,
  SignedBip84NativeTransaction,
} from './transactions/prepared-bip84';
import type {
  PreparedEvmSigningOptions,
  PreparedSoftwareEvmSigningRequest,
  SignedPreparedEvmTransaction,
} from './transactions/prepared-evm';

declare const softwareHostBrand: unique symbol;
/** Opaque handle minted by createSoftwareKeyringHost; no injectable persistence. */
export interface SoftwareKeyringHost {
  readonly [softwareHostBrand]: true;
}

const hosts = new WeakMap<
  SoftwareKeyringHost,
  {
    storage: KeyringStoragePort;
    vaultPersistence: VaultPersistence;
  }
>();

/** Create once per wallet authority, then share with its per-network keyrings. */
export const createSoftwareKeyringHost = (
  storage: KeyringStoragePort
): SoftwareKeyringHost => {
  const vaultPersistence = createVaultPersistence(storage);
  if (typeof storage.deleteItem !== 'function') {
    throw new TypeError('Keyring storage port must provide deleteItem');
  }
  const host = Object.freeze({}) as SoftwareKeyringHost;
  hosts.set(host, { storage, vaultPersistence });
  return host;
};

const requireHost = (host: SoftwareKeyringHost) => {
  const dependencies = hosts.get(host);
  if (!dependencies) throw new TypeError('Invalid software keyring host');
  return dependencies;
};

export class SoftwareKeyring extends KeyringCore<undefined, undefined> {
  constructor(host: SoftwareKeyringHost) {
    const dependencies = requireHost(host);
    super({
      authority: host,
      storage: dependencies.storage,
      vaultPersistence: dependencies.vaultPersistence,
      ledgerSigner: undefined,
      trezorSigner: undefined,
    });
  }

  /**
   * Derive a fixed-path Ethereum HD runtime account without network or storage
   * writes. The returned password-encrypted xprv is internal runtime state,
   * never a public account/catalogue DTO. The host owns index allocation.
   */
  public deriveEvmHdRuntimeAccount(
    request: EvmHdRuntimeAccountRequest,
    options: EvmHdRuntimeAccountOptions
  ): Promise<EncryptedEvmHdRuntimeAccount> {
    return this.deriveSoftwareEvmHdRuntimeAccount(request, options);
  }

  /** Derive public BIP84 account data from the live seed; no storage or discovery. */
  public deriveBip84HdPublicAccount(
    request: Bip84HdPublicRequest,
    options: Bip84Guard
  ): Promise<Bip84HdPublicResult> {
    return this.deriveSoftwareBip84HdPublicAccount(request, options);
  }

  /** Sign the selected HD account's exact prepared native transaction offline. */
  public signPreparedBip84Transaction(
    request: PreparedBip84SigningRequest,
    options: Bip84Guard
  ): Promise<SignedBip84NativeTransaction> {
    return this.signPreparedSoftwareBip84Transaction(request, options);
  }

  /**
   * Sign exactly the prepared envelope without RPC, fee/nonce discovery or
   * broadcasting. The host must journal the result before submitting it.
   * A later lock cannot revoke already returned signed bytes.
   */
  public signPreparedEvmTransaction(
    request: PreparedSoftwareEvmSigningRequest,
    options: PreparedEvmSigningOptions
  ): SignedPreparedEvmTransaction {
    return this.signPreparedSoftwareEvmTransaction(request, options);
  }

  /** Software authorities cannot rebind their backing store after creation. */
  public override setStorage = (client: any): never => {
    void client;
    throw new Error('Storage replacement is unavailable in this host');
  };

  /** Sessions may move only through the core's same-authority transfer path. */
  public override receiveSessionOwnership = (
    ...session: Parameters<KeyringCore['receiveSessionOwnership']>
  ): never => {
    void session;
    throw new Error('Direct session injection is unavailable in this host');
  };

  public static async createInitialized(
    host: SoftwareKeyringHost,
    seed: string,
    password: string,
    vaultStateGetter: () => any
  ): Promise<SoftwareKeyring> {
    const keyring = new SoftwareKeyring(host);
    keyring.setVaultStateGetter(vaultStateGetter);
    await keyring.initializeWalletSecurely(seed, password);
    return keyring;
  }
}

export { KeyringAccountType } from './types';
export { INetworkType } from '@sidhujag/sysweb3-network';
export type { INetwork } from '@sidhujag/sysweb3-network';
export type { KeyringStoragePort } from './keyring-core';
export type { IKeyringAccountState } from './types';

export type {
  PreparedEvmTransaction,
  PreparedEvmSigningOptions,
  PreparedSoftwareEvmSigningRequest,
  SignedPreparedEvmTransaction,
} from './transactions/prepared-evm';

export type {
  EncryptedEvmHdRuntimeAccount,
  EvmHdRuntimeAccountOptions,
  EvmHdRuntimeAccountRequest,
} from './software-hd-account';

export type {
  Bip84HdPublicRequest,
  Bip84HdPublicResult,
} from './software-utxo-account';
export type { Bip84Guard } from './transactions/bip84-native-plan';

export type {
  PreparedBip84SigningRequest,
  SignedBip84NativeTransaction,
} from './transactions/prepared-bip84';

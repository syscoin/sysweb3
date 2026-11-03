/** Software-only entry: explicit host storage, no browser/device initialization. */
import { KeyringCore } from './keyring-core';
import { createVaultPersistence } from './storage-core';

import type { KeyringStoragePort } from './keyring-core';
import type { VaultPersistence } from './storage-core';

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

import { sysweb3Di } from '@sidhujag/sysweb3-core';

import { createVaultPersistence } from './storage-core';

// Preserve the legacy process-wide storage authority. Host-isolated consumers
// import storage-core directly and supply their own asynchronous storage port.
const storage = sysweb3Di.getStateStorageDb();
const persistence = createVaultPersistence({
  get: async (key) => storage.get(key),
  set: async (key, value) => {
    await storage.set(key, value);
  },
  createManyIfAbsent: async (items) => storage.createManyIfAbsent(items),
});

export const setEncryptedVault = persistence.setEncryptedVault;
export const getDecryptedVault = persistence.getDecryptedVault;
export { VaultAuthenticationError } from './storage-core';

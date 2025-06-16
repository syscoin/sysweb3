import CryptoJS from 'crypto-js';

import { sysweb3Di } from '@pollum-io/sysweb3-core';

const storage = sysweb3Di.getStateStorageDb();

// Each keyring gets its own vault based on slip44
export const setEncryptedVault = async (
  decryptedVault: any,
  pwd: string,
  slip44?: number
) => {
  const encryptedVault = CryptoJS.AES.encrypt(
    JSON.stringify(decryptedVault),
    pwd
  );

  // Use slip44-specific key if provided, otherwise fall back to 'vault' for backward compatibility
  const vaultKey = slip44 !== undefined ? `vault-${slip44}` : 'vault';
  await storage.set(vaultKey, encryptedVault.toString());
};

export const getDecryptedVault = async (pwd: string, slip44?: number) => {
  // Use slip44-specific key if provided, otherwise fall back to 'vault' for backward compatibility
  const vaultKey = slip44 !== undefined ? `vault-${slip44}` : 'vault';
  const vault = await storage.get(vaultKey);

  if (!vault) {
    // If slip44-specific vault doesn't exist, try the global vault for migration
    if (slip44 !== undefined) {
      const globalVault = await storage.get('vault');
      if (globalVault) {
        console.log(
          `[Storage] Migrating global vault to slip44-specific vault: ${vaultKey}`
        );
        // Migrate the global vault to slip44-specific vault
        await storage.set(vaultKey, globalVault);
        return getDecryptedVault(pwd, slip44);
      }
    }
    throw new Error('Vault not found');
  }

  const decryptedVault = CryptoJS.AES.decrypt(vault, pwd).toString(
    CryptoJS.enc.Utf8
  );

  if (!decryptedVault) {
    throw new Error(
      'Failed to decrypt vault - invalid password or corrupted data'
    );
  }

  return JSON.parse(decryptedVault);
};

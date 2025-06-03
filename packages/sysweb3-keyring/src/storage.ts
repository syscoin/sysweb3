import CryptoJS from 'crypto-js';

import { sysweb3Di } from '@pollum-io/sysweb3-core';

const storage = sysweb3Di.getStateStorageDb();

//TODO: completely remove set and get vault from utils
export const setEncryptedVault = async (decryptedVault: any, pwd: string) => {
  const encryptedVault = CryptoJS.AES.encrypt(
    JSON.stringify(decryptedVault),
    pwd
  );

  await storage.set('vault', encryptedVault.toString());
};

export const getDecryptedVault = async (pwd: string) => {
  const vault = await storage.get('vault');

  if (!vault) {
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

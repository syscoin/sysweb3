import CryptoJS from 'crypto-js';

/** A host-owned namespace containing one wallet authority's logical records. */
export interface VaultStoragePort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** Atomically creates the entire batch only when every key is absent. */
  createManyIfAbsent(items: Record<string, unknown>): Promise<boolean>;
}

export interface VaultPersistence {
  setEncryptedVault(
    decryptedVault: any,
    pwd: string,
    freshVaultKeys?: { salt: string }
  ): Promise<void>;
  getDecryptedVault(pwd: string, legacyPassword?: string): Promise<any>;
}

type VaultGcmEnvelopeV4 = {
  v: 4;
  alg: 'A256GCM';
  iv: string; // hex (12 bytes)
  ct: string; // hex (ciphertext + tag)
};

// Simple async mutex implementation to prevent concurrent vault operations
class AsyncMutex {
  private mutex = Promise.resolve();

  async runExclusive<T>(callback: () => Promise<T>): Promise<T> {
    const oldMutex = this.mutex;

    let release: () => void;
    this.mutex = new Promise((resolve) => {
      release = resolve;
    });

    await oldMutex;
    try {
      return await callback();
    } finally {
      release!();
    }
  }
}

const isHex = (s: string): boolean => /^[0-9a-fA-F]+$/.test(s);

const hexToBytes = (hex: string): Uint8Array => {
  const clean = (hex || '').trim();
  if (!isHex(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const bytesToHex = (bytes: ArrayBuffer): string => {
  const u8 = new Uint8Array(bytes);
  let hex = '';
  for (let i = 0; i < u8.length; i++) {
    hex += u8[i].toString(16).padStart(2, '0');
  }
  return hex;
};

const maybeParseGcmEnvelope = (raw: any): VaultGcmEnvelopeV4 | null => {
  if (!raw || typeof raw !== 'string') return null;
  if (!raw.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VaultGcmEnvelopeV4>;
    if (
      parsed &&
      parsed.v === 4 &&
      parsed.alg === 'A256GCM' &&
      typeof parsed.iv === 'string' &&
      typeof parsed.ct === 'string'
    ) {
      return parsed as VaultGcmEnvelopeV4;
    }
    return null;
  } catch {
    return null;
  }
};

const encryptVaultWebCrypto = async (
  plaintextJson: string,
  keyHex: string
): Promise<VaultGcmEnvelopeV4> => {
  const subtle = (globalThis as any).crypto.subtle as SubtleCrypto;
  const iv = new Uint8Array(12);
  (globalThis as any).crypto.getRandomValues(iv);

  const keyBytes = hexToBytes(keyHex);
  if (keyBytes.length !== 32) {
    throw new Error('Vault key must be 32 bytes (hex length 64)');
  }

  const key = await subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const pt = new TextEncoder().encode(plaintextJson);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    pt as unknown as BufferSource
  );

  return {
    v: 4,
    alg: 'A256GCM',
    iv: bytesToHex(iv.buffer),
    ct: bytesToHex(ct),
  };
};

export class VaultAuthenticationError extends Error {
  readonly code = 'INVALID_PASSWORD';

  constructor() {
    super('Failed to decrypt vault - invalid password or corrupted data');
    this.name = 'VaultAuthenticationError';
  }
}

const invalidPasswordError = () => new VaultAuthenticationError();

const decryptVaultWebCrypto = async (
  envelope: VaultGcmEnvelopeV4,
  keyHex: string
): Promise<string> => {
  const subtle = (globalThis as any)?.crypto?.subtle as
    | SubtleCrypto
    | undefined;
  if (!subtle) {
    throw new Error('WebCrypto is required to decrypt this vault');
  }
  const keyBytes = hexToBytes(keyHex);
  if (keyBytes.length !== 32) {
    throw new Error('Vault key must be 32 bytes (hex length 64)');
  }
  const key = await subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const ivBytes = hexToBytes(envelope.iv);
  const ctBytes = hexToBytes(envelope.ct);
  if (ivBytes.length !== 12 || ctBytes.length < 16) {
    throw new Error('Invalid encrypted vault format');
  }

  let pt: ArrayBuffer;
  try {
    pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes as unknown as BufferSource },
      key,
      ctBytes as unknown as BufferSource
    );
  } catch (error) {
    // Only a failed authentication tag is a password/ciphertext failure.
    // Key import and other platform exceptions must remain operational.
    if (error?.name === 'OperationError') {
      throw invalidPasswordError();
    }
    throw error;
  }
  return new TextDecoder().decode(pt);
};

/**
 * Create once per wallet authority and share across its network keyrings.
 * The host owns storage durability and cross-context atomic creation.
 */
export const createVaultPersistence = (
  storage: VaultStoragePort
): VaultPersistence => {
  if (
    !storage ||
    typeof storage.get !== 'function' ||
    typeof storage.set !== 'function' ||
    typeof storage.createManyIfAbsent !== 'function'
  ) {
    throw new TypeError(
      'Vault storage port must provide get, set, and createManyIfAbsent methods'
    );
  }
  const vaultMutex = new AsyncMutex();

  // Single vault for all networks; derivation remains the keyring's concern.
  const setEncryptedVault = async (
    decryptedVault: any,
    pwd: string,
    freshVaultKeys?: { salt: string }
  ) => {
    return vaultMutex.runExclusive(async () => {
      const plaintext = JSON.stringify(decryptedVault);

      // Writes never downgrade to unauthenticated passphrase AES. Legacy CBC
      // remains readable below, but missing WebCrypto is an operational failure.
      const canUseWebCrypto =
        !!(globalThis as any)?.crypto?.subtle &&
        !!(globalThis as any)?.crypto?.getRandomValues;
      if (!canUseWebCrypto) {
        throw new Error('WebCrypto is required for vault encryption');
      }
      if (typeof pwd !== 'string' || !isHex(pwd) || pwd.length !== 64) {
        throw new Error('Vault key must be 32 bytes (hex length 64)');
      }
      const envelope = await encryptVaultWebCrypto(plaintext, pwd);
      const toStore = JSON.stringify(envelope);

      if (freshVaultKeys) {
        // The host primitive covers the absence check and batch commit
        // across all clients that can initialize the same persisted authority.
        const created = await storage.createManyIfAbsent({
          'vault-keys': freshVaultKeys,
          vault: toStore,
        });
        if (typeof created !== 'boolean')
          throw new Error('Atomic storage creation returned an invalid result');
        if (!created)
          throw new Error(
            'Cannot initialize a new vault over existing wallet storage'
          );
      } else {
        // Existing vault updates retain their migration-specific write ordering.
        await storage.set('vault', toStore);
      }
    });
  };

  const getDecryptedVault = async (pwd: string, legacyPassword?: string) => {
    return vaultMutex.runExclusive(async () => {
      // Always use single 'vault' key
      const vault = await storage.get('vault');

      if (!vault) {
        throw new Error('Vault not found');
      }

      // Prefer WebCrypto AES-GCM when the stored vault is in v4 envelope format.
      const maybeEnvelope = maybeParseGcmEnvelope(vault);
      if (
        !maybeEnvelope &&
        typeof vault === 'string' &&
        vault.trim().startsWith('{')
      ) {
        // Legacy CBC vaults are base64. A JSON-shaped record must be a valid
        // GCM envelope rather than being misreported as a password failure.
        throw new Error('Invalid encrypted vault format');
      }
      let decryptedVault: string;
      if (maybeEnvelope) {
        decryptedVault = await decryptVaultWebCrypto(maybeEnvelope, pwd);
      } else {
        // Legacy CryptoJS passphrase-AES vault (v3 and older v4 canary).
        // An interrupted migration can already have written CBC with the
        // derived key while the metadata still selects the legacy password.
        for (const candidateKey of new Set([legacyPassword ?? pwd, pwd])) {
          let plaintext: string;
          try {
            plaintext = CryptoJS.AES.decrypt(
              vault as string,
              candidateKey
            ).toString(CryptoJS.enc.Utf8);
          } catch (error) {
            if (error?.message === 'Malformed UTF-8 data') continue;
            throw error;
          }
          if (!plaintext) continue;
          try {
            return JSON.parse(plaintext);
          } catch (error) {
            // CBC has no authentication tag; invalid plaintext is the only
            // available indication of a bad password/ciphertext.
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
        throw invalidPasswordError();
      }

      if (!decryptedVault) {
        throw invalidPasswordError();
      }

      return JSON.parse(decryptedVault);
    });
  };

  return { setEncryptedVault, getDecryptedVault };
};

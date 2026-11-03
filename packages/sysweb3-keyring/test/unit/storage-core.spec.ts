import { webcrypto } from 'crypto';
import CryptoJS from 'crypto-js';

import {
  createVaultPersistence,
  VaultAuthenticationError,
} from '../../src/storage-core';

import type { VaultStoragePort } from '../../src/storage-core';

const key = '11'.repeat(32);
const wrongKey = '22'.repeat(32);
const vault = { mnemonic: 'public test fixture', accounts: { imported: [] } };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

const createStorage = () => {
  const records = new Map<string, unknown>();
  const port: VaultStoragePort = {
    get: jest.fn(async (name) => records.get(name)),
    set: jest.fn(async (name, value) => {
      records.set(name, value);
    }),
    createManyIfAbsent: jest.fn(async (items) => {
      // This test backend's entire conditional commit runs synchronously.
      if (Object.keys(items).some((name) => records.has(name))) return false;
      Object.entries(items).forEach(([name, value]) =>
        records.set(name, value)
      );
      return true;
    }),
  };
  return { records, port };
};

describe('host-owned vault persistence', () => {
  let cryptoDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: webcrypto,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (cryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    } else {
      delete (globalThis as any).crypto;
    }
  });

  it('imports without loading global storage or hardware modules', () => {
    jest.resetModules();
    const unexpectedImport = () => {
      throw new Error('Unexpected host dependency');
    };
    jest.doMock('@sidhujag/sysweb3-core', unexpectedImport);
    jest.doMock(
      '../../src/hardware-wallet-manager-singleton',
      unexpectedImport
    );
    try {
      jest.isolateModules(() => {
        expect(
          typeof require('../../src/storage-core').createVaultPersistence
        ).toBe('function');
      });
    } finally {
      jest.dontMock('@sidhujag/sysweb3-core');
      jest.dontMock('../../src/hardware-wallet-manager-singleton');
    }
  });

  it.each(['get', 'set', 'createManyIfAbsent'])(
    'rejects a missing %s port before any vault operation',
    (method) => {
      const { port } = createStorage();
      expect(() =>
        createVaultPersistence({ ...port, [method]: undefined } as any)
      ).toThrow(
        'Vault storage port must provide get, set, and createManyIfAbsent methods'
      );
      expect(port.get).not.toHaveBeenCalled();
      expect(port.set).not.toHaveBeenCalled();
      expect(port.createManyIfAbsent).not.toHaveBeenCalled();
    }
  );

  it.each([null, undefined])('rejects an absent storage port (%s)', (port) => {
    expect(() => createVaultPersistence(port as any)).toThrow(TypeError);
  });

  it('keeps independent authorities isolated and preserves the v4 envelope', async () => {
    const first = createStorage();
    const second = createStorage();
    const firstVault = createVaultPersistence(first.port);
    const secondVault = createVaultPersistence(second.port);
    await Promise.all([
      firstVault.setEncryptedVault(vault, key),
      secondVault.setEncryptedVault({ owner: 'second' }, key),
    ]);
    await expect(firstVault.getDecryptedVault(key)).resolves.toEqual(vault);
    await expect(secondVault.getDecryptedVault(key)).resolves.toEqual({
      owner: 'second',
    });
    const stored = JSON.parse(first.records.get('vault') as string);
    expect(Object.keys(stored).sort()).toEqual(['alg', 'ct', 'iv', 'v']);
    expect(stored).toMatchObject({ v: 4, alg: 'A256GCM' });
    expect(stored.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(stored.ct).toMatch(/^[0-9a-f]+$/);
    const cryptoKey = await webcrypto.subtle.importKey(
      'raw',
      Buffer.from(key, 'hex'),
      'AES-GCM',
      false,
      ['decrypt']
    );
    const plaintext = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(stored.iv, 'hex') },
      cryptoKey,
      Buffer.from(stored.ct, 'hex')
    );
    expect(JSON.parse(Buffer.from(plaintext).toString('utf8'))).toEqual(vault);
  });

  it('serializes reads and writes through one authority until storage completes', async () => {
    const { port } = createStorage();
    const persistence = createVaultPersistence(port);
    const entered = deferred();
    const release = deferred();
    const set = port.set;
    jest.spyOn(port, 'set').mockImplementationOnce(async (name, value) => {
      entered.resolve();
      await release.promise;
      await set(name, value);
    });
    const first = persistence.setEncryptedVault({ sequence: 1 }, key);
    await entered.promise;
    const read = persistence.getDecryptedVault(key);
    const second = persistence.setEncryptedVault({ sequence: 2 }, key);
    await Promise.resolve();
    expect(port.get).not.toHaveBeenCalled();
    expect(port.set).toHaveBeenCalledTimes(1);
    release.resolve();
    await first;
    await expect(read).resolves.toEqual({ sequence: 1 });
    await second;
    await expect(persistence.getDecryptedVault(key)).resolves.toEqual({
      sequence: 2,
    });
  });

  it('does not block a separate authority behind another authority storage read', async () => {
    const first = createStorage();
    const second = createStorage();
    const entered = deferred();
    const release = deferred();
    jest.spyOn(first.port, 'get').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return undefined;
    });
    const blocked = createVaultPersistence(first.port).getDecryptedVault(key);
    const missing = expect(blocked).rejects.toThrow('Vault not found');
    await entered.promise;
    const other = createVaultPersistence(second.port);
    await other.setEncryptedVault(vault, key);
    await expect(other.getDecryptedVault(key)).resolves.toEqual(vault);
    release.resolve();
    await missing;
  });

  it('awaits an asynchronous read and preserves storage errors without reclassification', async () => {
    const { port } = createStorage();
    const persistence = createVaultPersistence(port);
    await persistence.setEncryptedVault(vault, key);
    const error = Object.assign(new Error('Storage unavailable'), {
      code: 'INVALID_PASSWORD',
    });
    jest.spyOn(port, 'get').mockRejectedValueOnce(error);
    await expect(persistence.getDecryptedVault(key)).rejects.toBe(error);
    await expect(persistence.getDecryptedVault(key)).resolves.toEqual(vault);
  });

  it('propagates a rejected write and releases the authority mutex', async () => {
    const { port } = createStorage();
    const persistence = createVaultPersistence(port);
    const error = new Error('Write rejected');
    jest.spyOn(port, 'set').mockRejectedValueOnce(error);
    await expect(persistence.setEncryptedVault(vault, key)).rejects.toBe(error);
    await persistence.setEncryptedVault(vault, key);
    await expect(persistence.getDecryptedVault(key)).resolves.toEqual(vault);
  });

  it('does not report success when a committed write loses its acknowledgement', async () => {
    const { port, records } = createStorage();
    const persistence = createVaultPersistence(port);
    const error = new Error('Commit acknowledgement lost');
    jest.spyOn(port, 'set').mockImplementationOnce(async (name, value) => {
      records.set(name, value);
      throw error;
    });
    await expect(persistence.setEncryptedVault(vault, key)).rejects.toBe(error);
    await expect(persistence.getDecryptedVault(key)).resolves.toEqual(vault);
  });

  it('creates vault and salt in exactly one conditional batch and awaits completion', async () => {
    const { port, records } = createStorage();
    const persistence = createVaultPersistence(port);
    const entered = deferred();
    const release = deferred();
    const create = port.createManyIfAbsent;
    jest
      .spyOn(port, 'createManyIfAbsent')
      .mockImplementationOnce(async (items) => {
        entered.resolve();
        await release.promise;
        return create(items);
      });
    let settled = false;
    const pending = persistence
      .setEncryptedVault(vault, key, { salt: 'salt' })
      .then(() => {
        settled = true;
      });
    await entered.promise;
    expect(settled).toBe(false);
    expect(port.set).not.toHaveBeenCalled();
    expect(port.get).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
    expect(port.createManyIfAbsent).toHaveBeenCalledTimes(1);
    release.resolve();
    await pending;
    expect(records.get('vault-keys')).toEqual({ salt: 'salt' });
    expect(records.get('vault')).toEqual(expect.any(String));
  });

  it('relies on atomic creation across independent authorities sharing one backend', async () => {
    const { port, records } = createStorage();
    const first = createVaultPersistence(port);
    const second = createVaultPersistence(port);
    const results = await Promise.allSettled([
      first.setEncryptedVault({ owner: 'first' }, key, { salt: 'first' }),
      second.setEncryptedVault({ owner: 'second' }, key, { salt: 'second' }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(rejected.reason.message).toBe(
      'Cannot initialize a new vault over existing wallet storage'
    );
    const persisted = await first.getDecryptedVault(key);
    expect(records.get('vault-keys')).toEqual({ salt: persisted.owner });
    expect(records.size).toBe(2);
    expect(port.set).not.toHaveBeenCalled();
  });

  it.each(['vault', 'vault-keys'])(
    'preserves an existing %s record on conditional create failure',
    async (existing) => {
      const { port, records } = createStorage();
      records.set(existing, 'existing data');
      await expect(
        createVaultPersistence(port).setEncryptedVault(vault, key, {
          salt: 'new',
        })
      ).rejects.toThrow(
        'Cannot initialize a new vault over existing wallet storage'
      );
      expect(Array.from(records.entries())).toEqual([
        [existing, 'existing data'],
      ]);
      expect(port.set).not.toHaveBeenCalled();
    }
  );

  it('rejects invalid atomic results and never falls back to sequential writes', async () => {
    const { port } = createStorage();
    jest.spyOn(port, 'createManyIfAbsent').mockResolvedValueOnce('true' as any);
    await expect(
      createVaultPersistence(port).setEncryptedVault(vault, key, {
        salt: 'salt',
      })
    ).rejects.toThrow('Atomic storage creation returned an invalid result');
    expect(port.set).not.toHaveBeenCalled();
  });

  it('preserves atomic creation failures', async () => {
    const { port } = createStorage();
    const error = new Error('Atomic creation unavailable');
    jest.spyOn(port, 'createManyIfAbsent').mockRejectedValueOnce(error);
    await expect(
      createVaultPersistence(port).setEncryptedVault(vault, key, {
        salt: 'salt',
      })
    ).rejects.toBe(error);
    expect(port.set).not.toHaveBeenCalled();
  });

  it('does not write or downgrade encryption when WebCrypto is missing', async () => {
    const { port } = createStorage();
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    });
    await expect(
      createVaultPersistence(port).setEncryptedVault(vault, key)
    ).rejects.toThrow('WebCrypto is required for vault encryption');
    expect(port.set).not.toHaveBeenCalled();
    expect(port.createManyIfAbsent).not.toHaveBeenCalled();
  });

  it('preserves the authentication error class and rejects a damaged GCM tag', async () => {
    const { port, records } = createStorage();
    const persistence = createVaultPersistence(port);
    await persistence.setEncryptedVault(vault, key);
    await expect(
      persistence.getDecryptedVault(wrongKey)
    ).rejects.toBeInstanceOf(VaultAuthenticationError);
    const envelope = JSON.parse(records.get('vault') as string);
    envelope.ct =
      envelope.ct.slice(0, -2) + (envelope.ct.endsWith('00') ? '01' : '00');
    records.set('vault', JSON.stringify(envelope));
    await expect(persistence.getDecryptedVault(key)).rejects.toMatchObject({
      name: 'VaultAuthenticationError',
      code: 'INVALID_PASSWORD',
      message: 'Failed to decrypt vault - invalid password or corrupted data',
    });
  });

  it('preserves malformed-envelope and WebCrypto operational failures', async () => {
    const { port, records } = createStorage();
    const persistence = createVaultPersistence(port);
    records.set('vault', '{"v":99}');
    await expect(persistence.getDecryptedVault(key)).rejects.toThrow(
      'Invalid encrypted vault format'
    );
    await persistence.setEncryptedVault(vault, key);
    const error = new Error('Key import unavailable');
    jest.spyOn(webcrypto.subtle, 'importKey').mockRejectedValueOnce(error);
    await expect(persistence.getDecryptedVault(key)).rejects.toBe(error);
  });

  it.each(['legacy-password', key])(
    'reads legacy CBC records with either migration key (%s)',
    async (storedKey) => {
      const { port, records } = createStorage();
      const ciphertext = CryptoJS.AES.encrypt(
        JSON.stringify(vault),
        storedKey
      ).toString();
      records.set('vault', ciphertext);
      const persistence = createVaultPersistence(port);
      await expect(
        persistence.getDecryptedVault(key, 'legacy-password')
      ).resolves.toEqual(vault);
      expect(records.get('vault')).toBe(ciphertext);
      await expect(
        persistence.getDecryptedVault(wrongKey, 'incorrect')
      ).rejects.toBeInstanceOf(VaultAuthenticationError);
    }
  );

  it('keeps legacy wrapper calls on one captured storage authority and the same error class', async () => {
    jest.resetModules();
    const first = createStorage();
    const second = createStorage();
    let selected = first.port;
    const getStateStorageDb = jest.fn(() => selected);
    jest.doMock('@sidhujag/sysweb3-core', () => ({
      sysweb3Di: { getStateStorageDb },
    }));
    let legacy!: typeof import('../../src/storage');
    let core!: typeof import('../../src/storage-core');
    try {
      jest.isolateModules(() => {
        legacy = require('../../src/storage');
        core = require('../../src/storage-core');
      });
      expect(legacy.VaultAuthenticationError).toBe(
        core.VaultAuthenticationError
      );
      selected = second.port;
      await legacy.setEncryptedVault(vault, key, { salt: 'legacy' });
      await expect(
        core.createVaultPersistence(first.port).getDecryptedVault(key)
      ).resolves.toEqual(vault);
      await core
        .createVaultPersistence(first.port)
        .setEncryptedVault({ owner: 'core' }, key);
      await expect(legacy.getDecryptedVault(key)).resolves.toEqual({
        owner: 'core',
      });
      await expect(legacy.getDecryptedVault(wrongKey)).rejects.toBeInstanceOf(
        core.VaultAuthenticationError
      );
      expect(getStateStorageDb).toHaveBeenCalledTimes(1);
      expect(second.records.size).toBe(0);
    } finally {
      jest.dontMock('@sidhujag/sysweb3-core');
    }
  });
});

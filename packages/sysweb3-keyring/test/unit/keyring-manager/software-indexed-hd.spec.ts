import {
  SoftwareKeyring,
  createSoftwareKeyringHost,
  INetworkType,
  KeyringAccountType,
} from '../../../src/software';

import type { KeyringStoragePort } from '../../../src/software';

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const password = 'public indexed HD fixture password';
const current = () => undefined;
async function fixture() {
  const records = new Map<string, unknown>();
  const storage: KeyringStoragePort = {
    get: jest.fn(async (key) => records.get(key)),
    set: jest.fn(async (key, value) => {
      records.set(key, value);
    }),
    deleteItem: jest.fn(async (key) => {
      records.delete(key);
    }),
    createManyIfAbsent: jest.fn(async (items) => {
      if (Object.keys(items).some((key) => records.has(key))) return false;
      Object.entries(items).forEach(([key, value]) => records.set(key, value));
      return true;
    }),
  };
  const state: any = {
    activeAccount: { id: 0, type: KeyringAccountType.HDAccount },
    activeNetwork: {
      kind: INetworkType.Ethereum,
      chainId: 1,
      slip44: 60,
      currency: 'ETH',
      label: 'Ethereum',
      url: 'https://offline.invalid',
    },
    accounts: {
      HDAccount: {},
      Imported: {},
      Ledger: {},
      Trezor: {},
      SmartAccount: {},
    },
  };
  const keyring = new SoftwareKeyring(createSoftwareKeyringHost(storage));
  keyring.setVaultStateGetter(() => state);
  await keyring.initializeSession(phrase, password);
  jest.mocked(storage.get).mockClear();
  jest.mocked(storage.set).mockClear();
  jest.mocked(storage.createManyIfAbsent).mockClear();
  const derive = jest.spyOn(keyring as any, 'setDerivedWeb3Accounts');
  return { keyring, state, storage, derive };
}

afterEach(() => jest.restoreAllMocks());

it('derives exact account 0/1 vectors without installing accounts, storage or network access', async () => {
  const f = await fixture();
  const oldFetch = globalThis.fetch;
  const fetch = jest.fn(() => {
    throw Error('Unexpected network');
  });
  globalThis.fetch = fetch as typeof globalThis.fetch;
  try {
    const first = await f.keyring.deriveEvmHdRuntimeAccount(
      { index: 0 },
      { assertCurrent: current }
    );
    const second = await f.keyring.deriveEvmHdRuntimeAccount(
      { index: 1 },
      { assertCurrent: current }
    );
    expect(first.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(second.address).toBe('0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0');
    expect(first.id).toBe(0);
    expect(second.id).toBe(1);
    expect(second.label).toBe('Account 2');
    expect(second.xpub).toMatch(/^0x04[0-9a-fA-F]{128}$/);
    expect(second.xprv).toBeTruthy();
    expect(second).not.toHaveProperty('privateKey');
    expect(JSON.stringify(second)).not.toContain(phrase);
    expect(JSON.stringify(second)).not.toContain(password);
    expect(f.state.accounts.HDAccount).toEqual({});
    expect(f.state.activeAccount.id).toBe(0);
    expect(f.storage.get).not.toHaveBeenCalled();
    expect(f.storage.set).not.toHaveBeenCalled();
    expect(f.storage.createManyIfAbsent).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = oldFetch;
    await f.keyring.destroy();
  }
});

it.each([-1, 0x80000000, 1.1, NaN, Infinity, '1', null, undefined])(
  'rejects invalid index %p before derivation',
  async (index) => {
    const f = await fixture();
    try {
      await expect(
        f.keyring.deriveEvmHdRuntimeAccount({ index } as any, {
          assertCurrent: current,
        })
      ).rejects.toThrow('Invalid Ethereum HD account index');
      expect(f.derive).not.toHaveBeenCalled();
    } finally {
      await f.keyring.destroy();
    }
  }
);

it('rejects extra fields and accessor-backed index before derivation', async () => {
  const f = await fixture();
  try {
    const getter = jest.fn(() => 1);
    const input = Object.defineProperty({}, 'index', {
      enumerable: true,
      get: getter,
    });
    await expect(
      f.keyring.deriveEvmHdRuntimeAccount(input as any, {
        assertCurrent: current,
      })
    ).rejects.toThrow();
    await expect(
      f.keyring.deriveEvmHdRuntimeAccount(
        { index: 1, path: "m/44'/1'/0'" } as any,
        { assertCurrent: current }
      )
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.derive).not.toHaveBeenCalled();
  } finally {
    await f.keyring.destroy();
  }
});

it.each(['locked', 'kind', 'slip44'])(
  'rejects %s context before deriving',
  async (kind) => {
    const f = await fixture();
    try {
      if (kind === 'locked') await f.keyring.lockWallet();
      else if (kind === 'kind')
        f.state.activeNetwork.kind = INetworkType.Syscoin;
      else f.state.activeNetwork.slip44 = 57;
      await expect(
        f.keyring.deriveEvmHdRuntimeAccount(
          { index: 1 },
          { assertCurrent: current }
        )
      ).rejects.toThrow('context changed');
      expect(f.derive).not.toHaveBeenCalled();
    } finally {
      await f.keyring.destroy();
    }
  }
);

it('rejects an asynchronous host guard before deriving', async () => {
  const f = await fixture();
  try {
    await expect(
      f.keyring.deriveEvmHdRuntimeAccount(
        { index: 1 },
        {
          assertCurrent: async () => {
            throw Error('stale');
          },
        }
      )
    ).rejects.toThrow('synchronously');
    expect(f.derive).not.toHaveBeenCalled();
  } finally {
    await f.keyring.destroy();
  }
});

it.each(['selection', 'network', 'lock'])(
  'does not release a derived result after %s changes',
  async (kind) => {
    const f = await fixture();
    try {
      let calls = 0;
      await expect(
        f.keyring.deriveEvmHdRuntimeAccount(
          { index: 1 },
          {
            assertCurrent: () => {
              calls++;
              if (calls === 2) {
                if (kind === 'selection') f.state.activeAccount.id = 1;
                else if (kind === 'network')
                  f.state.activeNetwork.url = 'https://changed.invalid';
                else void f.keyring.lockWallet();
              }
            },
          }
        )
      ).rejects.toThrow('context changed');
      expect(f.derive).toHaveBeenCalledTimes(1);
    } finally {
      await f.keyring.destroy();
    }
  }
);

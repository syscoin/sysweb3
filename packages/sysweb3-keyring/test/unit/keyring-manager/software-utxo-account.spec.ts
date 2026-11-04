jest.resetModules();
jest.unmock('syscoinjs-lib');
(global as any).window.location = { href: 'http://localhost/' };

import { HDNodeWallet } from 'ethers/wallet';

import { parseBip84PublicAccount } from '../../../src/public-bip84';
import {
  SoftwareKeyring,
  createSoftwareKeyringHost,
  INetworkType,
  KeyringAccountType,
} from '../../../src/software';

import type { KeyringStoragePort } from '../../../src/software';

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const password = 'public BIP84 derivation fixture password';
const noop = () => undefined;
async function fixture(coin: 'bitcoin' | 'syscoin' = 'bitcoin') {
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
      kind: INetworkType.Syscoin,
      chainId: coin === 'bitcoin' ? 0 : 57,
      slip44: coin === 'bitcoin' ? 0 : 57,
      currency: coin === 'bitcoin' ? 'btc' : 'sys',
      label: coin,
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
  const request = {
    network: { network: coin, endpoint: state.activeNetwork.url },
    accountIndex: 0,
  };
  for (const fn of [
    storage.get,
    storage.set,
    storage.deleteItem,
    storage.createManyIfAbsent!,
  ])
    jest.mocked(fn).mockClear();
  return { records, storage, state, keyring, request };
}

it.each(['bitcoin', 'syscoin'] as const)(
  'derives exact %s account 0 and nonzero vectors with no catalogue/storage/network mutation',
  async (coin) => {
    const f = await fixture(coin);
    const before = JSON.stringify([...f.records]);
    const network = JSON.stringify(f.state);
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw Error('No network');
    });
    try {
      for (const accountIndex of [0, 2]) {
        const result = await f.keyring.deriveBip84HdPublicAccount(
          { ...f.request, accountIndex },
          { assertCurrent: noop }
        );
        const expected = HDNodeWallet.fromPhrase(
          phrase,
          undefined,
          `m/84'/${coin === 'bitcoin' ? 0 : 57}'/${accountIndex}'`
        ).neuter().extendedKey;
        expect(result.account).toEqual(
          parseBip84PublicAccount({ network: coin, accountKey: expected })
        );
        expect(result.receive.branch).toBe(0);
        expect(result.receive.index).toBe(0);
        expect(result.receive.account).toEqual(result.account);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.account)).toBe(true);
        expect(Object.isFrozen(result.receive)).toBe(true);
        expect(JSON.stringify(result)).not.toContain(phrase);
        expect(JSON.stringify(result)).not.toContain(password);
        expect(result).not.toHaveProperty('xprv');
        expect(result).not.toHaveProperty('privateKey');
      }
      expect(JSON.stringify(f.state)).toBe(network);
      expect(JSON.stringify([...f.records])).toBe(before);
      expect(f.storage.get).not.toHaveBeenCalled();
      expect(f.storage.set).not.toHaveBeenCalled();
      expect(f.storage.deleteItem).not.toHaveBeenCalled();
      expect(f.storage.createManyIfAbsent).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await f.keyring.destroy();
    }
  }
);

it('rejects wrong coin, endpoint and SLIP44 without silently deriving another path', async () => {
  const f = await fixture();
  try {
    await expect(
      f.keyring.deriveBip84HdPublicAccount(
        { ...f.request, network: { ...f.request.network, network: 'syscoin' } },
        { assertCurrent: noop }
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(
      f.keyring.deriveBip84HdPublicAccount(
        {
          ...f.request,
          network: { ...f.request.network, endpoint: 'https://other.invalid' },
        },
        { assertCurrent: noop }
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    f.state.activeNetwork.slip44 = 57;
    await expect(
      f.keyring.deriveBip84HdPublicAccount(f.request, { assertCurrent: noop })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    await f.keyring.destroy();
  }
});

it.each([
  KeyringAccountType.Imported,
  KeyringAccountType.Ledger,
  KeyringAccountType.Trezor,
  KeyringAccountType.SmartAccount,
])('rejects a selected %s kind', async (type) => {
  const f = await fixture();
  f.state.activeAccount.type = type;
  try {
    await expect(
      f.keyring.deriveBip84HdPublicAccount(f.request, { assertCurrent: noop })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    await f.keyring.destroy();
  }
});

it.each([-1, 0x80000000, 0.5, NaN, Infinity, '0', null])(
  'rejects malformed account index %p',
  async (accountIndex) => {
    const f = await fixture();
    try {
      await expect(
        f.keyring.deriveBip84HdPublicAccount(
          { ...f.request, accountIndex } as any,
          { assertCurrent: noop }
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    } finally {
      await f.keyring.destroy();
    }
  }
);

it('rejects a locked or disposed keyring and a reentrant operation without wedging future derivation', async () => {
  const f = await fixture();
  let nested: Promise<unknown> | undefined;
  try {
    await f.keyring.deriveBip84HdPublicAccount(f.request, {
      assertCurrent() {
        if (!nested)
          nested = f.keyring
            .deriveBip84HdPublicAccount(f.request, { assertCurrent: noop })
            .catch((error) => error);
      },
    });
    expect(await nested).toMatchObject({ code: 'BUSY' });
    await f.keyring.deriveBip84HdPublicAccount(f.request, {
      assertCurrent: noop,
    });
    await f.keyring.lockWallet();
    await expect(
      f.keyring.deriveBip84HdPublicAccount(f.request, { assertCurrent: noop })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await f.keyring.destroy();
    await expect(
      f.keyring.deriveBip84HdPublicAccount(f.request, { assertCurrent: noop })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    await f.keyring.destroy();
  }
});

it('rejects Promise/value guards and a host-detected A-B-A revision change', async () => {
  const f = await fixture();
  try {
    for (const result of [
      Promise.resolve(),
      Promise.reject(new Error('not authority')),
      true,
      null,
    ])
      await expect(
        f.keyring.deriveBip84HdPublicAccount(f.request, {
          assertCurrent: () => result,
        } as any)
      ).rejects.toMatchObject({ code: 'CANCELLED' });
    let revision = 0;
    await expect(
      f.keyring.deriveBip84HdPublicAccount(f.request, {
        assertCurrent() {
          const initial = revision;
          f.state.activeNetwork.chainId = 57;
          revision++;
          f.state.activeNetwork.chainId = 0;
          revision++;
          if (revision !== initial) throw Error('revoked');
        },
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await f.keyring.deriveBip84HdPublicAccount(f.request, {
      assertCurrent: noop,
    });
  } finally {
    await f.keyring.destroy();
  }
});

it('detects guard-side account/lock mutation and does not let caller request mutation retarget derivation', async () => {
  const f = await fixture();
  try {
    const mutable: any = { ...f.request, accountIndex: 2 };
    const result = await f.keyring.deriveBip84HdPublicAccount(mutable, {
      assertCurrent() {
        mutable.accountIndex = 3;
      },
    });
    expect(result.accountIndex).toBe(2);
    await expect(
      f.keyring.deriveBip84HdPublicAccount(f.request, {
        assertCurrent() {
          void f.keyring.lockWallet();
        },
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    await f.keyring.destroy();
  }
});

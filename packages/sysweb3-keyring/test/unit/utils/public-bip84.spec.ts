import { address, networks } from 'bitcoinjs-lib';
import bs58check from 'bs58check';

import {
  deriveBip84PublicAddress,
  parseBip84PublicAccount,
  PublicBip84Error,
} from '../../../src/public-bip84';

// Public account key and addresses from the BIP84 test vector. No seed/key is used.
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const payload = () => Buffer.from(bs58check.decode(ZPUB));
const changed = (edit: (bytes: Buffer) => void) => {
  const bytes = payload();
  edit(bytes);
  return bs58check.encode(bytes);
};
const XPUB = changed((bytes) => bytes.writeUInt32BE(0x0488b21e, 0));
const request = { network: 'bitcoin' as const, accountKey: ZPUB };

afterEach(() => {
  expect(global.fetch).not.toHaveBeenCalled();
});
beforeEach(() => {
  jest.mocked(global.fetch).mockClear();
});

describe('strict stateless BIP84 public accounts', () => {
  it('canonicalizes xpub/zpub aliases without claiming ancestry', () => {
    const expected = {
      network: 'bitcoin',
      policy: 'bip84-p2wpkh',
      canonicalKey: ZPUB,
      accountIndex: 0,
    };
    expect(parseBip84PublicAccount(request)).toEqual(expected);
    expect(parseBip84PublicAccount({ ...request, accountKey: XPUB })).toEqual(
      expected
    );
    expect(parseBip84PublicAccount({ ...request, network: 'syscoin' })).toEqual(
      { ...expected, network: 'syscoin' }
    );
  });

  it.each([
    [0, 0, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'],
    [0, 1, 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'],
    [1, 0, 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'],
  ])(
    'matches public Bitcoin BIP84 vector /%i/%i',
    (branch, index, expected) => {
      const result = deriveBip84PublicAddress({
        ...request,
        branch: branch as 0 | 1,
        index,
      });
      expect(result.address).toBe(expected);
      expect(result.scriptPubKey).toBe(
        Buffer.from(
          address.toOutputScript(expected, networks.bitcoin)
        ).toString('hex')
      );
      expect(result.branch).toBe(branch);
      expect(result.index).toBe(index);
    }
  );

  it('uses Syscoin HRP with the identical derived witness program, including nonzero account metadata', () => {
    const btc = deriveBip84PublicAddress({ ...request, branch: 1, index: 4 });
    const sys = deriveBip84PublicAddress({
      ...request,
      network: 'syscoin',
      branch: 1,
      index: 4,
    });
    expect(sys.address.startsWith('sys1q')).toBe(true);
    expect(sys.scriptPubKey).toBe(btc.scriptPubKey);
    expect(address.fromBech32(sys.address).data).toEqual(
      address.fromBech32(btc.address).data
    );
    const high = changed((bytes) => bytes.writeUInt32BE(0xffffffff, 9));
    expect(
      parseBip84PublicAccount({ ...request, accountKey: high }).accountIndex
    ).toBe(0x7fffffff);
  });

  it('returns only deeply immutable public values and leaves input untouched', () => {
    const input = { ...request, branch: 0 as const, index: 0 };
    const result = deriveBip84PublicAddress(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.account)).toBe(true);
    expect(Object.keys(result).sort()).toEqual([
      'account',
      'address',
      'branch',
      'index',
      'scriptPubKey',
    ]);
    expect(Object.keys(result.account).sort()).toEqual([
      'accountIndex',
      'canonicalKey',
      'network',
      'policy',
    ]);
    input.accountKey = XPUB;
    expect(result.account.canonicalKey).toBe(ZPUB);
    expect(() => {
      (result as any).index = 12;
    }).toThrow();
    expect(() => {
      (result.account as any).network = 'syscoin';
    }).toThrow();
  });

  it.each([0, 1, 2, 4, 255])('rejects account depth %i', (depth) => {
    expect(() =>
      parseBip84PublicAccount({
        ...request,
        accountKey: changed((bytes) => {
          bytes[4] = depth;
        }),
      })
    ).toThrow(PublicBip84Error);
  });
  it.each([0, 1, 0x7fffffff])(
    'requires a hardened account child, rejecting %i',
    (index) => {
      expect(() =>
        parseBip84PublicAccount({
          ...request,
          accountKey: changed((bytes) => bytes.writeUInt32BE(index, 9)),
        })
      ).toThrow('INVALID_ACCOUNT');
    }
  );
  it.each([0x043587cf, 0x045f1cf6, 0x049d7cb2, 0x0488ade4, 0x04b2430c, 1])(
    'rejects unsupported version %i',
    (version) => {
      expect(() =>
        parseBip84PublicAccount({
          ...request,
          accountKey: changed((bytes) => bytes.writeUInt32BE(version, 0)),
        })
      ).toThrow('INVALID_ACCOUNT');
    }
  );
  it.each([
    changed((bytes) => {
      bytes.fill(0, 45);
      bytes[77] = 1;
    }),
    changed((bytes) => {
      bytes.fill(255, 46);
      bytes[45] = 2;
    }),
    ZPUB.slice(0, -1) + '1',
    '',
    ' ' + ZPUB,
    ZPUB + '\n',
    ZPUB.repeat(200),
    `wpkh(${ZPUB})`,
    ZPUB + '/0/*',
  ])(
    'rejects private, malformed or non-bare input %# without echoing it',
    (accountKey) => {
      expect(() => parseBip84PublicAccount({ ...request, accountKey })).toThrow(
        'INVALID_ACCOUNT'
      );
      try {
        parseBip84PublicAccount({ ...request, accountKey });
      } catch (error) {
        expect((error as Error).message).not.toContain(accountKey || 'zpub');
      }
    }
  );

  it.each(['testnet', 'BTC', 'ethereum', 0, 57, {}, null])(
    'requires an explicit supported network %#',
    (network) => {
      expect(() =>
        parseBip84PublicAccount({ ...request, network } as any)
      ).toThrow('INVALID_INPUT');
    }
  );
  it.each([-1, 2, 0.5, '0', true, null, undefined])(
    'rejects branch %#',
    (branch) => {
      expect(() =>
        deriveBip84PublicAddress({ ...request, branch, index: 0 } as any)
      ).toThrow('INVALID_INPUT');
    }
  );
  it.each([-1, 0x80000000, 1.5, NaN, Infinity, '0', null, undefined])(
    'rejects index %#',
    (index) => {
      expect(() =>
        deriveBip84PublicAddress({ ...request, branch: 0, index } as any)
      ).toThrow('INVALID_INPUT');
    }
  );
  it('derives the highest nonhardened index without scanning preceding indices', () => {
    const result = deriveBip84PublicAddress({
      ...request,
      branch: 0,
      index: 0x7fffffff,
    });
    expect(result.index).toBe(0x7fffffff);
    expect(result.address.startsWith('bc1q')).toBe(true);
  });
  it('rejects getter, inherited, missing, extra and symbol inputs without evaluating accessors', () => {
    let calls = 0;
    const getter = {
      network: 'bitcoin',
      get accountKey() {
        calls++;
        return ZPUB;
      },
    };
    for (const value of [
      getter,
      Object.create(request),
      { network: 'bitcoin' },
      { ...request, path: 'm/84h/0h/0h' },
      { ...request, [Symbol('extra')]: true },
    ])
      expect(() => parseBip84PublicAccount(value as any)).toThrow(
        'INVALID_INPUT'
      );
    expect(calls).toBe(0);
  });

  it('uses fixed encodings even if the external Bitcoin network object is changed before import', () => {
    const original = networks.bitcoin.bech32;
    try {
      networks.bitcoin.bech32 = 'tainted';
      jest.isolateModules(() => {
        const dependency = require('bitcoinjs-lib');
        dependency.networks.bitcoin.bech32 = 'tainted';
        const api = require('../../../src/public-bip84');
        expect(
          api.deriveBip84PublicAddress({ ...request, branch: 0, index: 0 })
            .address
        ).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
      });
    } finally {
      networks.bitcoin.bech32 = original;
    }
  });

  it('requests exactly the branch and leaf without iterating earlier indices', () => {
    jest.isolateModules(() => {
      const real = jest
        .requireActual('bip32')
        .BIP32Factory(jest.requireActual('@bitcoinerlab/secp256k1'));
      const calls: number[] = [];
      jest.doMock('bip32', () => ({
        BIP32Factory: () => ({
          fromBase58(key: string, network: any) {
            const root = real.fromBase58(key, network);
            const derive = root.derive.bind(root);
            root.derive = (branch: number) => {
              calls.push(branch);
              const child = derive(branch);
              const deriveChild = child.derive.bind(child);
              child.derive = (index: number) => {
                calls.push(index);
                return deriveChild(index);
              };
              return child;
            };
            return root;
          },
        }),
      }));
      const api = require('../../../src/public-bip84');
      api.parseBip84PublicAccount(request);
      expect(calls).toEqual([]);
      api.deriveBip84PublicAddress({
        ...request,
        branch: 1,
        index: 0x7fffffff,
      });
      expect(calls).toEqual([1, 0x7fffffff]);
    });
    jest.dontMock('bip32');
  });

  it.each(['branch', 'leaf'])(
    'rejects BIP32 invalid-child retry at the %s step',
    (step) => {
      jest.isolateModules(() => {
        const real = jest
          .requireActual('bip32')
          .BIP32Factory(jest.requireActual('@bitcoinerlab/secp256k1'));
        jest.doMock('bip32', () => ({
          BIP32Factory: () => ({
            fromBase58(key: string, network: any) {
              const root = real.fromBase58(key, network);
              root.derive = (index: number) => {
                return step === 'branch'
                  ? { index: index + 1 }
                  : { index, derive: (leaf: number) => ({ index: leaf + 1 }) };
              };
              return root;
            },
          }),
        }));
        const api = require('../../../src/public-bip84');
        expect(() =>
          api.deriveBip84PublicAddress({ ...request, branch: 0, index: 0 })
        ).toThrow('INVALID_DERIVATION');
      });
      jest.dontMock('bip32');
    }
  );
});

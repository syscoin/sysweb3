jest.resetModules();
jest.unmock('syscoinjs-lib');
(global as any).window.location = { href: 'http://localhost/' };

import ecc from '@bitcoinerlab/secp256k1';
import { Transaction, payments, script } from 'bitcoinjs-lib';
import { HDNodeWallet } from 'ethers/wallet';

import {
  Bip84NativeError,
  prepareBip84NativeTransaction,
} from '../../../src/bip84-native';
import {
  deriveBip84PublicAddress,
  parseBip84PublicAccount,
} from '../../../src/public-bip84';
import {
  SoftwareKeyring,
  createSoftwareKeyringHost,
  INetworkType,
  KeyringAccountType,
} from '../../../src/software';

import type { Bip84NativePlan } from '../../../src/bip84-native';
import type { Bip84PublicAccount } from '../../../src/public-bip84';
import type { KeyringStoragePort } from '../../../src/software';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'public prepared BIP84 fixture password';
const ENDPOINT = 'https://offline.invalid';
const noop = () => undefined;
type Coin = 'bitcoin' | 'syscoin';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function publicAccount(coin: Coin, index: number, phrase = PHRASE) {
  const key = HDNodeWallet.fromPhrase(
    phrase,
    undefined,
    `m/84'/${coin === 'bitcoin' ? 0 : 57}'/${index}'`
  ).neuter().extendedKey;
  return parseBip84PublicAccount({ network: coin, accountKey: key });
}

function makePlan(
  coin: Coin,
  account: Bip84PublicAccount,
  values: readonly bigint[] = [100_000n, 80_000n]
): Bip84NativePlan {
  const paths = [
    { branch: 0 as const, index: 3, value: values[0] },
    { branch: 1 as const, index: 5, value: values[1] },
  ];
  const parents = paths.map((input, index) => {
    const previous = new Transaction();
    previous.version = 2;
    previous.addInput(Buffer.alloc(32, index + 1), 0);
    const derived = deriveBip84PublicAddress({
      network: coin,
      accountKey: account.canonicalKey,
      branch: input.branch,
      index: input.index,
    });
    previous.addOutput(Buffer.from(derived.scriptPubKey, 'hex'), input.value);
    return previous;
  });
  return {
    network: { network: coin, endpoint: ENDPOINT },
    account,
    inputs: paths.map((input, index) => ({
      txid: parents[index].getId(),
      vout: 0,
      branch: input.branch,
      index: input.index,
    })),
    previousTransactions: parents.map((tx) => ({
      txid: tx.getId(),
      rawTransaction: tx.toHex(),
    })),
    recipient: {
      address: deriveBip84PublicAddress({
        network: coin,
        accountKey: account.canonicalKey,
        branch: 0,
        index: 9,
      }).address,
      valueSatoshis: (values[0] + values[1] - 30_000n).toString(),
    },
    change: { index: 7, valueSatoshis: '29000' },
    locktime: 0,
    rbf: true,
    feeLimits: { maxFeeSatoshis: '1000', maxFeeRateSatPerVByte: '1000' },
  };
}

async function fixture(coin: Coin = 'bitcoin', index = 2) {
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
      url: ENDPOINT,
    },
    accounts: {
      HDAccount: {},
      Imported: {},
      Ledger: {},
      Trezor: {},
      SmartAccount: {},
    },
  };
  const host = createSoftwareKeyringHost(storage);
  const keyring = new SoftwareKeyring(host);
  keyring.setVaultStateGetter(() => state);
  await keyring.initializeSession(PHRASE, PASSWORD);
  // Public derivation deliberately leaves SDK selection at its initial HD0.
  const derived = await keyring.deriveBip84HdPublicAccount(
    { network: { network: coin, endpoint: ENDPOINT }, accountIndex: index },
    { assertCurrent: noop }
  );
  expect(state.activeAccount.id).toBe(0);
  const account = derived.account;
  const receive = deriveBip84PublicAddress({
    network: coin,
    accountKey: account.canonicalKey,
    branch: 0,
    index: 11,
  });
  state.accounts.HDAccount[index] = {
    id: index,
    label: 'Public runtime account',
    address: receive.address,
    xpub: account.canonicalKey,
    xprv: '',
  };
  state.activeAccount.id = index;
  const prepared = prepareBip84NativeTransaction(makePlan(coin, account));
  const input = {
    account: {
      type: 'HDAccount' as const,
      index,
      expectedAccountKey: account.canonicalKey,
    },
    prepared,
  };
  for (const fn of [
    storage.get,
    storage.set,
    storage.deleteItem,
    storage.createManyIfAbsent!,
  ])
    jest.mocked(fn).mockClear();
  return { coin, index, records, storage, host, state, keyring, input };
}

function referenceTransaction(
  input: Awaited<ReturnType<typeof fixture>>['input']
) {
  const tx = Transaction.fromHex(input.prepared.unsignedTransaction);
  input.prepared.plan.inputs.forEach((spend, index) => {
    const node = HDNodeWallet.fromPhrase(
      PHRASE,
      undefined,
      `m/84'/${input.prepared.plan.network.network === 'bitcoin' ? 0 : 57}'/${
        input.account.index
      }'/${spend.branch}/${spend.index}`
    );
    const pubkey = Buffer.from(
      node.signingKey.compressedPublicKey.slice(2),
      'hex'
    );
    const privateKey = Buffer.from(node.privateKey.slice(2), 'hex');
    try {
      const parent = input.prepared.plan.previousTransactions.find(
        (p) => p.txid === spend.txid
      )!;
      const value = Transaction.fromHex(parent.rawTransaction).outs[spend.vout]
        .value;
      const digest = tx.hashForWitnessV0(
        index,
        payments.p2pkh({ pubkey }).output!,
        value,
        Transaction.SIGHASH_ALL
      );
      tx.setWitness(index, [
        script.signature.encode(
          ecc.sign(digest, privateKey),
          Transaction.SIGHASH_ALL
        ),
        pubkey,
      ]);
    } finally {
      privateKey.fill(0);
    }
  });
  return tx;
}

it.each(['bitcoin', 'syscoin'] as const)(
  'signs selected %s HD2 using public runtime metadata and exact independently built witnesses',
  async (coin) => {
    const f = await fixture(coin);
    const beforeState = JSON.stringify(f.state);
    const beforeRecords = JSON.stringify([...f.records]);
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw Error('Forbidden network request');
    });
    const provider = jest.requireMock(
      '../../../src/providers'
    ).CustomJsonRpcProvider;
    provider.mockClear();
    const forbidden = () => {
      throw Error('Forbidden transport operation');
    };
    const http = jest
      .spyOn(jest.requireActual('node:http'), 'request')
      .mockImplementation(forbidden);
    const https = jest
      .spyOn(jest.requireActual('node:https'), 'request')
      .mockImplementation(forbidden);
    const dns = jest
      .spyOn(jest.requireActual('node:dns'), 'lookup')
      .mockImplementation(forbidden);
    try {
      const result = await f.keyring.signPreparedBip84Transaction(f.input, {
        assertCurrent: noop,
      });
      const reference = referenceTransaction(f.input);
      expect(result.rawTransaction).toBe(reference.toHex());
      expect(result.txid).toBe(reference.getId());
      expect(result.wtxid).toBe(
        Buffer.from(reference.getHash(true)).reverse().toString('hex')
      );
      expect(result.unsignedTransaction).toBe(
        f.input.prepared.unsignedTransaction
      );
      expect(result.feeSatoshis).toBe('1000');
      expect(result.virtualSize).toBe(reference.virtualSize());
      const final = Transaction.fromHex(result.rawTransaction);
      const stripped = final.clone();
      final.ins.forEach((input, index) => {
        expect(input.script.length).toBe(0);
        expect(input.witness).toHaveLength(2);
        const decoded = script.signature.decode(input.witness[0]);
        expect(decoded.hashType).toBe(Transaction.SIGHASH_ALL);
        const spend = f.input.prepared.plan.inputs[index];
        const parent = f.input.prepared.plan.previousTransactions.find(
          (p) => p.txid === spend.txid
        )!;
        const value = Transaction.fromHex(parent.rawTransaction).outs[
          spend.vout
        ].value;
        const hash = final.hashForWitnessV0(
          index,
          payments.p2pkh({ pubkey: input.witness[1] }).output!,
          value,
          Transaction.SIGHASH_ALL
        );
        expect(
          ecc.verify(hash, input.witness[1], decoded.signature, true)
        ).toBe(true);
        stripped.setWitness(index, []);
      });
      expect(stripped.toHex()).toBe(f.input.prepared.unsignedTransaction);
      expect(Object.keys(result).sort()).toEqual([
        'feeSatoshis',
        'rawTransaction',
        'txid',
        'unsignedTransaction',
        'virtualSize',
        'wtxid',
      ]);
      expect(Object.isFrozen(result)).toBe(true);
      expect(
        Object.values(result).every(
          (value) => typeof value === 'string' || typeof value === 'number'
        )
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(PHRASE);
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(result).not.toHaveProperty('privateKey');
      expect(result).not.toHaveProperty('psbt');
      expect(JSON.stringify(f.state)).toBe(beforeState);
      expect(JSON.stringify([...f.records])).toBe(beforeRecords);
      expect(f.storage.get).not.toHaveBeenCalled();
      expect(f.storage.set).not.toHaveBeenCalled();
      expect(f.storage.deleteItem).not.toHaveBeenCalled();
      expect(f.storage.createManyIfAbsent).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(https).not.toHaveBeenCalled();
      expect(dns).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      http.mockRestore();
      https.mockRestore();
      dns.mockRestore();
      await f.keyring.destroy();
    }
  }
);

it('keeps SYS input and output arithmetic above Number.MAX_SAFE_INTEGER exact', async () => {
  const f = await fixture('syscoin');
  const large = 9_007_199_254_740_993n;
  f.input.prepared = prepareBip84NativeTransaction(
    makePlan('syscoin', f.input.prepared.plan.account, [large, 80_000n])
  );
  try {
    const result = await f.keyring.signPreparedBip84Transaction(f.input, {
      assertCurrent: noop,
    });
    expect(result.rawTransaction).toBe(referenceTransaction(f.input).toHex());
    const tx = Transaction.fromHex(result.rawTransaction);
    expect(tx.outs[0].value).toBe(large + 50_000n);
    expect(tx.outs[1].value).toBe(29_000n);
    expect(
      large + 80_000n - tx.outs.reduce((sum, output) => sum + output.value, 0n)
    ).toBe(1_000n);
    expect(result.feeSatoshis).toBe('1000');
  } finally {
    await f.keyring.destroy();
  }
});

it('derives the mnemonic seed once per multi-input operation without retaining a signing cache', async () => {
  const f = await fixture();
  const deriveSeed = jest.spyOn(
    jest.requireActual('bip39'),
    'mnemonicToSeedSync'
  );
  try {
    expect(f.input.prepared.plan.inputs).toHaveLength(2);
    await f.keyring.signPreparedBip84Transaction(f.input, {
      assertCurrent: noop,
    });
    expect(deriveSeed).toHaveBeenCalledTimes(1);
    await f.keyring.signPreparedBip84Transaction(f.input, {
      assertCurrent: noop,
    });
    expect(deriveSeed).toHaveBeenCalledTimes(2);
  } finally {
    deriveSeed.mockRestore();
    await f.keyring.destroy();
  }
});

it('does not let the initial SDK HD0 anchor sign a reviewed HD2 plan', async () => {
  const f = await fixture();
  const zero = publicAccount('bitcoin', 0);
  f.state.accounts.HDAccount[0] = {
    ...f.state.accounts.HDAccount[2],
    id: 0,
    xpub: zero.canonicalKey,
  };
  f.state.activeAccount.id = 0;
  try {
    await expect(
      f.keyring.signPreparedBip84Transaction(f.input, { assertCurrent: noop })
    ).rejects.toBeInstanceOf(Bip84NativeError);
    expect(f.state.activeAccount.id).toBe(0);
  } finally {
    await f.keyring.destroy();
  }
});

it('rejects a foreign seed account even when the selected record and complete plan agree with it', async () => {
  const f = await fixture();
  const foreign = publicAccount('bitcoin', 2, OTHER_PHRASE);
  f.state.accounts.HDAccount[2].xpub = foreign.canonicalKey;
  const input = {
    account: { ...f.input.account, expectedAccountKey: foreign.canonicalKey },
    prepared: prepareBip84NativeTransaction(makePlan('bitcoin', foreign)),
  };
  try {
    await expect(
      f.keyring.signPreparedBip84Transaction(input, { assertCurrent: noop })
    ).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  } finally {
    await f.keyring.destroy();
  }
});

it.each([
  'missing-record',
  'wrong-record-id',
  'wrong-xpub',
  'isImported',
  'isLedgerWallet',
  'isTrezorWallet',
  'isSmartAccount',
])('refuses invalid selected public runtime state: %s', async (change) => {
  const f = await fixture();
  if (change === 'missing-record') delete f.state.accounts.HDAccount[2];
  else if (change === 'wrong-record-id') f.state.accounts.HDAccount[2].id = 1;
  else if (change === 'wrong-xpub')
    f.state.accounts.HDAccount[2].xpub = publicAccount(
      'bitcoin',
      1
    ).canonicalKey;
  else f.state.accounts.HDAccount[2][change] = true;
  try {
    await expect(
      f.keyring.signPreparedBip84Transaction(f.input, { assertCurrent: noop })
    ).rejects.toBeInstanceOf(Bip84NativeError);
  } finally {
    await f.keyring.destroy();
  }
});

it.each([
  KeyringAccountType.Imported,
  KeyringAccountType.Ledger,
  KeyringAccountType.Trezor,
  KeyringAccountType.SmartAccount,
])(
  'refuses selected %s even if it carries matching public HD metadata',
  async (type) => {
    const f = await fixture();
    f.state.accounts[type][2] = { ...f.state.accounts.HDAccount[2] };
    f.state.activeAccount.type = type;
    try {
      await expect(
        f.keyring.signPreparedBip84Transaction(f.input, { assertCurrent: noop })
      ).rejects.toBeInstanceOf(Bip84NativeError);
    } finally {
      await f.keyring.destroy();
    }
  }
);

it.each([
  'account',
  'address',
  'xpub',
  'network',
  'endpoint',
  'slip44',
  'lock',
])(
  'rejects a guard-side %s mutation before releasing signed bytes',
  async (change) => {
    const f = await fixture();
    try {
      await expect(
        f.keyring.signPreparedBip84Transaction(f.input, {
          assertCurrent() {
            if (change === 'account') f.state.activeAccount.id = 0;
            if (change === 'address')
              f.state.accounts.HDAccount[2].address = 'changed';
            if (change === 'xpub')
              f.state.accounts.HDAccount[2].xpub = publicAccount(
                'bitcoin',
                1
              ).canonicalKey;
            if (change === 'network') f.state.activeNetwork.chainId = 57;
            if (change === 'endpoint')
              f.state.activeNetwork.url = 'https://other.invalid';
            if (change === 'slip44') f.state.activeNetwork.slip44 = 57;
            if (change === 'lock') void f.keyring.lockWallet();
          },
        })
      ).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await f.keyring.destroy();
    }
  }
);

it('requires a synchronous undefined-returning guard and does not expose its rejection text', async () => {
  const f = await fixture();
  try {
    for (const value of [
      true,
      null,
      Promise.resolve(),
      Promise.reject(Error('private guard detail')),
    ]) {
      await expect(
        f.keyring.signPreparedBip84Transaction(f.input, {
          assertCurrent: () => value,
        } as any)
      ).rejects.toMatchObject({ code: 'CANCELLED' });
    }
    let error: any;
    try {
      await f.keyring.signPreparedBip84Transaction(f.input, {
        assertCurrent() {
          throw Error(PHRASE);
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Bip84NativeError);
    expect(error.message).toBe('CANCELLED');
    expect(error).not.toHaveProperty('cause');
    await f.keyring.signPreparedBip84Transaction(f.input, {
      assertCurrent: noop,
    });
  } finally {
    await f.keyring.destroy();
  }
});

it('honors a monotonic host revision after account and endpoint values return to their originals', async () => {
  const f = await fixture();
  let revision = 0;
  const admitted = revision;
  try {
    await expect(
      f.keyring.signPreparedBip84Transaction(f.input, {
        assertCurrent() {
          f.state.activeAccount.id = 0;
          revision++;
          f.state.activeNetwork.url = 'https://other.invalid';
          revision++;
          f.state.activeAccount.id = 2;
          f.state.activeNetwork.url = ENDPOINT;
          if (revision !== admitted) throw Error('stale host review');
        },
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await f.keyring.signPreparedBip84Transaction(f.input, {
      assertCurrent: noop,
    });
  } finally {
    await f.keyring.destroy();
  }
});

it('shares admission with reentrant public derivation and signing, then releases only its own token', async () => {
  const f = await fixture();
  let nested: Promise<unknown>[] | undefined;
  try {
    await f.keyring.signPreparedBip84Transaction(f.input, {
      assertCurrent() {
        if (!nested)
          nested = [
            f.keyring
              .deriveBip84HdPublicAccount(
                { network: f.input.prepared.plan.network, accountIndex: 2 },
                { assertCurrent: noop }
              )
              .catch((error) => error),
            f.keyring
              .signPreparedBip84Transaction(f.input, { assertCurrent: noop })
              .catch((error) => error),
          ];
      },
    });
    for (const result of await Promise.all(nested!))
      expect(result).toMatchObject({ code: 'BUSY' });
    await f.keyring.signPreparedBip84Transaction(f.input, {
      assertCurrent: noop,
    });
  } finally {
    await f.keyring.destroy();
  }
});

it('detaches the approved request before a guard mutates caller-owned values', async () => {
  const f = await fixture();
  const input: any = clone(f.input);
  try {
    const result = await f.keyring.signPreparedBip84Transaction(input, {
      assertCurrent() {
        input.account.index = 3;
        input.account.expectedAccountKey = publicAccount(
          'bitcoin',
          3
        ).canonicalKey;
        input.prepared.plan.recipient.valueSatoshis = '1';
        input.prepared.unsignedTransaction = '00';
      },
    });
    expect(result.rawTransaction).toBe(referenceTransaction(f.input).toHex());
  } finally {
    await f.keyring.destroy();
  }
});

it('rejects while locked, permits a new authenticated session, and rejects after disposal', async () => {
  const f = await fixture();
  try {
    await f.keyring.lockWallet();
    await expect(
      f.keyring.signPreparedBip84Transaction(f.input, { assertCurrent: noop })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(f.keyring.unlock(PASSWORD)).resolves.toMatchObject({
      canLogin: true,
    });
    await f.keyring.signPreparedBip84Transaction(f.input, {
      assertCurrent: noop,
    });
    await f.keyring.destroy();
    await expect(
      f.keyring.signPreparedBip84Transaction(f.input, { assertCurrent: noop })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    await f.keyring.destroy();
  }
});

it('does not clear or sign through a session transferred to another same-authority keyring', async () => {
  const f = await fixture();
  const replacement = new SoftwareKeyring(f.host);
  replacement.setVaultStateGetter(() => f.state);
  let moved = false;
  try {
    await expect(
      f.keyring.signPreparedBip84Transaction(f.input, {
        assertCurrent() {
          if (!moved) {
            moved = true;
            f.keyring.transferSessionTo(replacement);
          }
        },
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(replacement.isUnlocked()).toBe(true);
    const result = await replacement.signPreparedBip84Transaction(f.input, {
      assertCurrent: noop,
    });
    expect(result.rawTransaction).toBe(referenceTransaction(f.input).toHex());
  } finally {
    await f.keyring.destroy();
    await replacement.destroy();
  }
});

import { Transaction, address, networks } from 'bitcoinjs-lib';
import { encode as encodeVarInt } from 'varuint-bitcoin';

import {
  prepareBip84NativeTransaction,
  Bip84NativeError,
} from '../../../src/bip84-native';
import {
  deriveBip84PublicAddress,
  parseBip84PublicAccount,
} from '../../../src/public-bip84';

import type { Bip84NativePlan } from '../../../src/bip84-native';

const key =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const account = parseBip84PublicAccount({
  network: 'bitcoin',
  accountKey: key,
});
const receive = deriveBip84PublicAddress({
  network: 'bitcoin',
  accountKey: key,
  branch: 0,
  index: 0,
});
function parent(value = 100_000n, version = 2, nonce = 1) {
  const tx = new Transaction();
  tx.version = version;
  tx.addInput(Buffer.alloc(32, nonce), 0);
  tx.addOutput(Buffer.from(receive.scriptPubKey, 'hex'), value);
  return tx;
}
function fixture(tx = parent()): Bip84NativePlan {
  return {
    network: { network: 'bitcoin', endpoint: 'https://offline.invalid' },
    account,
    inputs: [{ txid: tx.getId(), vout: 0, branch: 0, index: 0 }],
    previousTransactions: [{ txid: tx.getId(), rawTransaction: tx.toHex() }],
    recipient: { address: receive.address, valueSatoshis: '90000' },
    change: { index: 4, valueSatoshis: '9000' },
    locktime: 0,
    rbf: true,
    feeLimits: { maxFeeSatoshis: '1000', maxFeeRateSatPerVByte: '1000' },
  };
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function witnessParent(
  tx: Transaction,
  items: readonly number[],
  width?: 4 | 8,
  nonempty = false
) {
  const count = (n: number) => {
    if (!width) return Buffer.from(encodeVarInt(n).buffer).toString('hex');
    const bytes = Buffer.alloc(width + 1);
    bytes[0] = width === 4 ? 0xfe : 0xff;
    if (width === 4) bytes.writeUInt32LE(n, 1);
    else bytes.writeBigUInt64LE(BigInt(n), 1);
    return bytes.toString('hex');
  };
  const raw = tx.toHex();
  return (
    raw.slice(0, 8) +
    '0001' +
    raw.slice(8, -8) +
    items.map((n) => count(n) + (nonempty ? '01aa' : '00').repeat(n)).join('') +
    raw.slice(-8)
  );
}
function expectResourceRejectionBeforeDecode(plan: Bip84NativePlan) {
  const decode = jest.spyOn(Transaction, 'fromBuffer');
  try {
    expect(() => prepareBip84NativeTransaction(plan)).toThrow('LIMIT_EXCEEDED');
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
}
const expectFailure = (v: unknown, code?: string) => {
  expect(() => prepareBip84NativeTransaction(v as Bip84NativePlan)).toThrow(
    code || Bip84NativeError
  );
};

test('prepares exact ordered outputs, fee, version and sequence with no shared mutable results', () => {
  const input = fixture();
  const prepared = prepareBip84NativeTransaction(input);
  const tx = Transaction.fromHex(prepared.unsignedTransaction);
  expect(prepared.feeSatoshis).toBe('1000');
  expect(tx.version).toBe(2);
  expect(tx.locktime).toBe(0);
  expect(tx.ins[0].sequence).toBe(0xfffffffd);
  expect(tx.outs.map((o) => o.value)).toEqual([90000n, 9000n]);
  expect(address.fromOutputScript(tx.outs[1].script, networks.bitcoin)).toBe(
    deriveBip84PublicAddress({
      network: 'bitcoin',
      accountKey: key,
      branch: 1,
      index: 4,
    }).address
  );
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.plan)).toBe(true);
  for (const value of [
    prepared.plan.inputs,
    prepared.plan.inputs[0],
    prepared.plan.previousTransactions,
    prepared.plan.previousTransactions[0],
    prepared.plan.recipient,
    prepared.plan.change,
    prepared.plan.feeLimits,
    prepared.plan.network,
    prepared.plan.account,
  ])
    expect(Object.isFrozen(value)).toBe(true);
  (input.inputs[0] as any).index = 1;
  expect(prepared.plan.inputs[0].index).toBe(0);
  expect(() => {
    (prepared.plan.inputs[0] as any).index = 7;
  }).toThrow();
  expect(prepared).not.toHaveProperty('psbt');
});

test('supports exact SYS encoding and no-change, zero-fee, non-RBF plans', () => {
  const sys = parseBip84PublicAccount({ network: 'syscoin', accountKey: key });
  const sysReceive = deriveBip84PublicAddress({
    network: 'syscoin',
    accountKey: key,
    branch: 0,
    index: 0,
  });
  const plan = {
    ...fixture(),
    network: {
      network: 'syscoin' as const,
      endpoint: 'https://offline.invalid',
    },
    account: sys,
    recipient: { address: sysReceive.address, valueSatoshis: '100000' },
    change: null,
    rbf: false,
    feeLimits: { maxFeeSatoshis: '0', maxFeeRateSatPerVByte: '0' },
  };
  const result = prepareBip84NativeTransaction(plan);
  expect(result.feeSatoshis).toBe('0');
  expect(Transaction.fromHex(result.unsignedTransaction).ins[0].sequence).toBe(
    0xffffffff
  );
});

test.each([80, 85, 128, 137, 138, 139, 140, 141, 142, 0x7400, 3, 0xffffffff])(
  'rejects every special/unknown parent version %i including native change without asset metadata',
  (version) => {
    const p = parent(100000n, version);
    expectFailure(fixture(p), 'UNSUPPORTED_PARENT');
  }
);
test('rejects coinbase regardless of any caller maturity assertion', () => {
  const p = parent();
  p.ins[0].hash = new Uint8Array(32);
  p.ins[0].index = 0xffffffff;
  expectFailure(fixture(p), 'UNSUPPORTED_PARENT');
  expectFailure({ ...fixture(p), confirmations: 10000 }, 'INVALID_REQUEST');
});
test.each(['f'.repeat(64), 'A'.repeat(64), '0x' + 'a'.repeat(64)])(
  'rejects incorrect/noncanonical parent ID %s',
  (txid) => {
    const p = fixture();
    (p.previousTransactions[0] as any).txid = txid;
    expectFailure(p);
  }
);
test('rejects missing/out-of-range/duplicated/unowned inputs and unused parents', () => {
  for (const mutate of [
    (p: any) => {
      p.inputs[0].vout = 1;
    },
    (p: any) => {
      p.inputs[0].txid = 'e'.repeat(64);
    },
    (p: any) => {
      p.inputs.push({ ...p.inputs[0] });
    },
    (p: any) => {
      p.inputs[0].branch = 1;
    },
    (p: any) => {
      p.inputs[0].index = 1;
    },
    (p: any) => {
      p.previousTransactions.push({ ...p.previousTransactions[0] });
    },
    (p: any) => {
      const other = parent(1n, 2, 2);
      p.previousTransactions.push({
        txid: other.getId(),
        rawTransaction: other.toHex(),
      });
    },
  ]) {
    const p = copy(fixture());
    mutate(p);
    expectFailure(p);
  }
});
test.each(['00', 'fdffff', '0001'])(
  'rejects malformed transaction count/encoding %s before allocating',
  (suffix) => {
    const p: any = copy(fixture());
    p.previousTransactions[0].rawTransaction =
      '02000000' + suffix + '00'.repeat(20);
    expectFailure(p);
  }
);

test('accepts exactly8192 decoded components and rejects the next empty witness item before decoding', () => {
  const tx = parent();
  const plan = fixture(tx);
  const withItems = (items: number) => ({
    ...plan,
    previousTransactions: [
      { txid: tx.getId(), rawTransaction: witnessParent(tx, [items]) },
    ],
  });
  // One input, one output and one witness vector leave8189 item slots.
  expect(prepareBip84NativeTransaction(withItems(8189)).feeSatoshis).toBe(
    '1000'
  );
  expectResourceRejectionBeforeDecode(withItems(8190));
  // Original amplification shape remains within the separate1MB wire limit.
  expectResourceRejectionBeforeDecode(withItems(900000));
});

test.each([undefined, 4, 8] as const)(
  'bounds empty and nonempty witness counts at every wide CompactSize representation: %s',
  (width) => {
    const tx = parent();
    for (const nonempty of [false, true]) {
      const plan = fixture(tx);
      expectResourceRejectionBeforeDecode({
        ...plan,
        previousTransactions: [
          {
            txid: tx.getId(),
            rawTransaction: witnessParent(tx, [8190], width, nonempty),
          },
        ],
      });
    }
  }
);

test.each(['inputs', 'outputs'] as const)(
  'counts all parent %s separately from selected spend inputs',
  (kind) => {
    const tx = parent();
    for (let i = 1; i < 8191; i++) {
      if (kind === 'inputs') tx.addInput(Buffer.alloc(32, 2), i);
      else tx.addOutput(new Uint8Array(0), 0n);
    }
    expect(prepareBip84NativeTransaction(fixture(tx)).feeSatoshis).toBe('1000');
    if (kind === 'inputs') tx.addInput(Buffer.alloc(32, 2), 8191);
    else tx.addOutput(new Uint8Array(0), 0n);
    expectResourceRejectionBeforeDecode(fixture(tx));
  }
);

test('counts witness vectors/items across inputs even when each count fits a single byte', () => {
  const tx = parent();
  for (let i = 1; i < 33; i++) tx.addInput(Buffer.alloc(32, 2), i);
  const plan = fixture(tx);
  expectResourceRejectionBeforeDecode({
    ...plan,
    previousTransactions: [
      {
        txid: tx.getId(),
        rawTransaction: witnessParent(tx, Array(33).fill(255)),
      },
    ],
  });
});

test('preflights the aggregate component boundary before decoding any parent', () => {
  const first = parent(),
    second = parent(100000n, 2, 2);
  const plan: Bip84NativePlan = {
    ...fixture(first),
    inputs: [
      { txid: first.getId(), vout: 0, branch: 0, index: 0 },
      { txid: second.getId(), vout: 0, branch: 0, index: 0 },
    ],
    previousTransactions: [
      { txid: first.getId(), rawTransaction: witnessParent(first, [4093]) },
      { txid: second.getId(), rawTransaction: witnessParent(second, [4093]) },
    ],
    change: { index: 4, valueSatoshis: '109000' },
  };
  expect(prepareBip84NativeTransaction(plan).feeSatoshis).toBe('1000');
  expectResourceRejectionBeforeDecode({
    ...plan,
    previousTransactions: [
      plan.previousTransactions[0],
      { txid: second.getId(), rawTransaction: witnessParent(second, [4094]) },
    ],
  });
});
test('rejects trailing bytes and altered parent outputs despite the claimed txid', () => {
  const p: any = copy(fixture());
  p.previousTransactions[0].rawTransaction += '00';
  expectFailure(p);
  const altered = parent(100001n);
  p.previousTransactions[0].rawTransaction = altered.toHex();
  expectFailure(p, 'INPUT_MISMATCH');
});
test('accepts canonical witness parents while committing the non-witness txid', () => {
  const p = parent();
  p.setWitness(0, [new Uint8Array([1, 2]), new Uint8Array([3])]);
  expect(prepareBip84NativeTransaction(fixture(p)).feeSatoshis).toBe('1000');
});
test.each([-1, 0x80000000, 1.5, NaN, Infinity, '0'])(
  'rejects malformed child index %p',
  (index) => {
    const p: any = copy(fixture());
    p.inputs[0].index = index;
    expectFailure(p, 'INVALID_REQUEST');
  }
);
test.each(['-1', '01', '1.2', '1e5', '', '10000000000000000000'])(
  'rejects noncanonical/oversized quantities %s',
  (value) => {
    const p: any = copy(fixture());
    p.recipient.valueSatoshis = value;
    expectFailure(p, 'INVALID_REQUEST');
  }
);
test('rejects zero recipient, negative fee, caller fee cap, rate cap and caps above policy', () => {
  for (const mutate of [
    (p: any) => {
      p.recipient.valueSatoshis = '0';
    },
    (p: any) => {
      p.recipient.valueSatoshis = '100001';
    },
    (p: any) => {
      p.feeLimits.maxFeeSatoshis = '999';
    },
    (p: any) => {
      p.feeLimits.maxFeeRateSatPerVByte = '1';
    },
    (p: any) => {
      p.feeLimits.maxFeeSatoshis = '10000001';
    },
    (p: any) => {
      p.feeLimits.maxFeeRateSatPerVByte = '1001';
    },
  ]) {
    const p: any = copy(fixture());
    mutate(p);
    expectFailure(p);
  }
});
test('keeps SYS quantities above Number.MAX_SAFE_INTEGER exact and enforces both money ranges', () => {
  const amount = 9007199254740993n;
  const p = fixture(parent(amount));
  const sys = {
    ...p,
    account: parseBip84PublicAccount({ network: 'syscoin', accountKey: key }),
    network: {
      network: 'syscoin' as const,
      endpoint: 'https://offline.invalid',
    },
    recipient: {
      address: deriveBip84PublicAddress({
        network: 'syscoin',
        accountKey: key,
        branch: 0,
        index: 0,
      }).address,
      valueSatoshis: (amount - 1000n).toString(),
    },
    change: null,
  };
  expect(prepareBip84NativeTransaction(sys).feeSatoshis).toBe('1000');
  expectFailure(p, 'INVALID_REQUEST');
  const excessive = parent(1000000000000000000n);
  expectFailure(
    {
      ...sys,
      ...fixture(excessive),
      network: sys.network,
      account: sys.account,
      recipient: sys.recipient,
      change: null,
    },
    'INVALID_REQUEST'
  );
});
test('bounds parent bytes before decoding and total bytes before parsing', () => {
  const p: any = copy(fixture());
  p.previousTransactions[0].rawTransaction = '00'.repeat(1000001);
  expectFailure(p, 'LIMIT_EXCEEDED');
  const big = [1, 2, 3].map((n) => {
    const tx = parent(100000n, 2, n);
    tx.addOutput(new Uint8Array(700000), 0n);
    return tx;
  });
  p.previousTransactions = big.map((tx) => ({
    txid: tx.getId(),
    rawTransaction: tx.toHex(),
  }));
  expectFailure(p, 'LIMIT_EXCEEDED');
});
test('accepts 64 inputs without scanning child indices, rejects 65, and canonicalizes parent order', () => {
  const p = parent(100000n);
  for (let i = 1; i < 64; i++)
    p.addOutput(Buffer.from(receive.scriptPubKey, 'hex'), 1n);
  const plan: any = fixture(p);
  plan.inputs = Array.from({ length: 64 }, (_, vout) => ({
    txid: p.getId(),
    vout,
    branch: 0,
    index: 0,
  }));
  plan.change.valueSatoshis = '9063';
  expect(prepareBip84NativeTransaction(plan).plan.inputs).toHaveLength(64);
  plan.inputs.push(plan.inputs[0]);
  expectFailure(plan, 'LIMIT_EXCEEDED');
  const q = parent(100000n, 1, 2);
  const multi: any = fixture(p);
  multi.inputs.push({ txid: q.getId(), vout: 0, branch: 0, index: 0 });
  multi.previousTransactions.push({
    txid: q.getId(),
    rawTransaction: q.toHex(),
  });
  multi.change.valueSatoshis = '109000';
  const result = prepareBip84NativeTransaction(multi);
  expect(result.plan.previousTransactions.map((x) => x.txid)).toEqual(
    [p.getId(), q.getId()].sort()
  );
});
test('rejects wrong network/account/recipient and never accepts a caller change address or sighash', () => {
  for (const mutate of [
    (p: any) => {
      p.network.network = 'testnet';
    },
    (p: any) => {
      p.account.accountIndex = 1;
    },
    (p: any) => {
      p.account.network = 'syscoin';
    },
    (p: any) => {
      p.recipient.address = 'bc1invalid';
    },
    (p: any) => {
      p.change.address = receive.address;
    },
    (p: any) => {
      p.inputs[0].sighashType = 2;
    },
    (p: any) => {
      p.locktime = 1;
    },
    (p: any) => {
      p.inputs[0].sequence = 0;
    },
  ]) {
    const p: any = copy(fixture());
    mutate(p);
    expectFailure(p);
  }
});
test('rejects accessors, inherited/extra fields, symbols, sparse/accessor arrays without evaluating getters', () => {
  let reads = 0;
  const p: any = copy(fixture());
  Object.defineProperty(p, 'account', {
    enumerable: true,
    get() {
      reads++;
      return account;
    },
  });
  expectFailure(p);
  expectFailure(Object.create(fixture()));
  expectFailure({ ...fixture(), [Symbol('extra')]: 1 });
  const q: any = copy(fixture());
  delete q.inputs[0];
  expectFailure(q);
  const r: any = copy(fixture());
  Object.defineProperty(r.inputs, '0', {
    enumerable: true,
    get() {
      reads++;
      return fixture().inputs[0];
    },
  });
  expectFailure(r);
  expect(reads).toBe(0);
});

test('accepts exactly the parent/aggregate byte ceilings and rejects the next byte', () => {
  function sized(nonce: number, bytes: number) {
    const tx = parent(100000n, 2, nonce);
    tx.addOutput(new Uint8Array(1), 0n);
    let padding = bytes - tx.toBuffer().length + 1;
    for (let attempt = 0; attempt < 3; attempt++) {
      tx.outs[1].script = new Uint8Array(padding);
      padding += bytes - tx.toBuffer().length;
    }
    expect(tx.toBuffer()).toHaveLength(bytes);
    return tx;
  }
  const first = sized(1, 1000000);
  const second = sized(2, 1000000);
  const input: any = fixture(first);
  input.previousTransactions.push({
    txid: second.getId(),
    rawTransaction: second.toHex(),
  });
  input.inputs.push({ txid: second.getId(), vout: 0, branch: 0, index: 0 });
  input.change.valueSatoshis = '109000';
  expect(prepareBip84NativeTransaction(input).feeSatoshis).toBe('1000');
  const excess = sized(1, 1000001);
  expectFailure(fixture(excess), 'LIMIT_EXCEEDED');
});

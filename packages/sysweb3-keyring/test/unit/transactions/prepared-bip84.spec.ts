import ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory, BIP32Interface } from 'bip32';
import { Psbt, Transaction, script } from 'bitcoinjs-lib';

import {
  deriveBip84PublicAddress,
  parseBip84PublicAccount,
} from '../../../src/public-bip84';
import {
  prepareBip84NativeTransaction,
  validateBip84NativePlan,
  Bip84NativePlan,
} from '../../../src/transactions/bip84-native-plan';
import {
  signValidatedBip84Plan,
  snapshotPreparedBip84Request,
} from '../../../src/transactions/prepared-bip84';

const bip32 = BIP32Factory(ecc);
const noop = () => undefined;
function fixture(count = 2, fee = 1000, rate = '1000') {
  const accountNode = bip32
    .fromSeed(Buffer.alloc(32, 7))
    .derivePath("m/84'/0'/2'");
  const account = parseBip84PublicAccount({
    network: 'bitcoin',
    accountKey: accountNode.neutered().toBase58(),
  });
  const parent = new Transaction();
  parent.version = 2;
  parent.addInput(Buffer.alloc(32, 5), 0);
  const inputs = Array.from({ length: count }, (_, i) => {
    const branch = (i % 2) as 0 | 1,
      index = i + 3;
    const derived = deriveBip84PublicAddress({
      network: 'bitcoin',
      accountKey: account.canonicalKey,
      branch,
      index,
    });
    parent.addOutput(Buffer.from(derived.scriptPubKey, 'hex'), 100_000n);
    return { branch, index };
  });
  const plan: Bip84NativePlan = {
    network: { network: 'bitcoin', endpoint: 'https://offline.invalid' },
    account,
    inputs: inputs.map((path, vout) => ({
      txid: parent.getId(),
      vout,
      ...path,
    })),
    previousTransactions: [
      { txid: parent.getId(), rawTransaction: parent.toHex() },
    ],
    recipient: {
      address: deriveBip84PublicAddress({
        network: 'bitcoin',
        accountKey: account.canonicalKey,
        branch: 0,
        index: 11,
      }).address,
      valueSatoshis: String(count * 100_000 - fee),
    },
    change: null,
    locktime: 0,
    rbf: true,
    feeLimits: { maxFeeSatoshis: String(fee), maxFeeRateSatPerVByte: rate },
  };
  return { accountNode, plan, validated: () => validateBip84NativePlan(plan) };
}
afterEach(() => jest.restoreAllMocks());

it('checks exact unsigned bytes, independently verifiable complete witnesses and final fee', () => {
  const f = fixture();
  const result = signValidatedBip84Plan(f.validated(), f.accountNode, noop);
  const tx = Transaction.fromHex(result.rawTransaction);
  const unsigned = tx.clone();
  unsigned.stripWitnesses();
  expect(unsigned.toHex()).toBe(
    prepareBip84NativeTransaction(f.plan).unsignedTransaction
  );
  expect(result.txid).toBe(tx.getId());
  expect(result.wtxid).toBe(
    Buffer.from(tx.getHash(true)).reverse().toString('hex')
  );
  expect(result.virtualSize).toBe(tx.virtualSize());
  expect(result.feeSatoshis).toBe('1000');
  expect(Object.isFrozen(result)).toBe(true);
  for (const [i, input] of tx.ins.entries()) {
    expect(input.script.length).toBe(0);
    expect(input.witness).toHaveLength(2);
    const path = f.plan.inputs[i],
      child = f.accountNode.derive(path.branch).derive(path.index);
    expect(Buffer.from(input.witness[1])).toEqual(Buffer.from(child.publicKey));
    const sig = script.signature.decode(input.witness[0]);
    expect(sig.hashType).toBe(Transaction.SIGHASH_ALL);
  }
});

it.each(['high-s', 'wrong-key', 'none', 'extra'] as const)(
  'rejects malicious partial signature: %s',
  (kind) => {
    const f = fixture(),
      original = Psbt.prototype.signInput;
    jest
      .spyOn(Psbt.prototype, 'signInput')
      .mockImplementation(function (this: Psbt, i, key, hashTypes) {
        const result = original.call(this, i, key, hashTypes),
          partial = this.data.inputs[i].partialSig![0];
        const decoded = script.signature.decode(partial.signature);
        if (kind === 'high-s') {
          const n =
            0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
          const s = BigInt(
            '0x' + Buffer.from(decoded.signature.subarray(32)).toString('hex')
          );
          decoded.signature.set(
            Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex'),
            32
          );
          partial.signature = script.signature.encode(
            decoded.signature,
            Transaction.SIGHASH_ALL
          );
        } else if (kind === 'none')
          partial.signature = script.signature.encode(
            decoded.signature,
            Transaction.SIGHASH_NONE
          );
        else if (kind === 'wrong-key')
          partial.pubkey = Uint8Array.from(f.accountNode.publicKey);
        else this.data.inputs[i].partialSig!.push({ ...partial });
        return result;
      });
    expect(() =>
      signValidatedBip84Plan(f.validated(), f.accountNode, noop)
    ).toThrow('SIGNATURE_INVALID');
  }
);

it.each(['incomplete', 'throw'] as const)(
  'rejects %s finalization without partial success',
  (kind) => {
    const f = fixture(),
      original = Psbt.prototype.finalizeInput;
    jest
      .spyOn(Psbt.prototype, 'finalizeInput')
      .mockImplementation(function (this: Psbt, i, ...rest) {
        if (i === 1) {
          if (kind === 'throw') throw Error('sensitive unexpected finalizer');
          return this;
        }
        return original.call(this, i, ...rest);
      });
    expect(() =>
      signValidatedBip84Plan(f.validated(), f.accountNode, noop)
    ).toThrow('SIGNATURE_INVALID');
  }
);

it.each([
  'witness-key',
  'witness-extra',
  'witness-signature',
  'script-sig',
  'output',
  'sequence',
] as const)('independently rejects modified extracted %s', (kind) => {
  const f = fixture(),
    original = Psbt.prototype.extractTransaction;
  jest
    .spyOn(Psbt.prototype, 'extractTransaction')
    .mockImplementation(function (this: Psbt, ...args) {
      const tx = original.apply(this, args).clone();
      if (kind === 'witness-key')
        tx.ins[1].witness[1] = Uint8Array.from(f.accountNode.publicKey);
      else if (kind === 'witness-extra')
        tx.ins[1].witness.push(new Uint8Array(1));
      else if (kind === 'witness-signature')
        tx.ins[1].witness[0] = Uint8Array.from(tx.ins[0].witness[0]);
      else if (kind === 'script-sig') tx.ins[1].script = Uint8Array.from([0]);
      else if (kind === 'output') tx.outs[0].value++;
      else tx.ins[1].sequence--;
      return tx;
    });
  expect(() =>
    signValidatedBip84Plan(f.validated(), f.accountNode, noop)
  ).toThrow('SIGNATURE_INVALID');
});

it('rejects a forged prepared unsigned or fee field before obtaining any signing key', () => {
  const f = fixture(),
    prepared = prepareBip84NativeTransaction(f.plan),
    account = {
      type: 'HDAccount' as const,
      index: 2,
      expectedAccountKey: f.plan.account.canonicalKey,
    };
  for (const change of [
    { feeSatoshis: '999' },
    { unsignedTransaction: prepared.unsignedTransaction + '00' },
  ])
    expect(() =>
      snapshotPreparedBip84Request({
        account,
        prepared: { ...prepared, ...change },
      })
    ).toThrow('INVALID_REQUEST');
  expect(() =>
    snapshotPreparedBip84Request({
      account: { ...account, index: 3 },
      prepared,
    })
  ).toThrow('ACCOUNT_MISMATCH');
  const getter = jest.fn(() => prepared);
  const input = Object.defineProperty({ account }, 'prepared', {
    enumerable: true,
    get: getter,
  });
  expect(() => snapshotPreparedBip84Request(input)).toThrow('INVALID_REQUEST');
  expect(getter).not.toHaveBeenCalled();
});

it('enforces exact actual-vsize rate boundary and plus one after the maximum-size planning filter', () => {
  let exact: number | undefined;
  let plusOne: number | undefined;
  for (let fee = 306; fee <= 318; fee++) {
    const f = fixture(4, fee);
    const validated = f.validated();
    const maximum = Transaction.fromHex(validated.prepared.unsignedTransaction);
    maximum.ins.forEach((_, i) =>
      maximum.setWitness(i, [new Uint8Array(73), new Uint8Array(33)])
    );
    const actual = signValidatedBip84Plan(
      validated,
      f.accountNode,
      noop
    ).virtualSize;
    if (fee === actual) exact = fee;
    if (fee === actual + 1 && fee <= maximum.virtualSize()) plusOne = fee;
  }
  expect(exact).toBeDefined();
  expect(plusOne).toBeDefined();
  const accepted = fixture(4, exact!, '1');
  const signed = signValidatedBip84Plan(
    accepted.validated(),
    accepted.accountNode,
    noop
  );
  expect(Number(signed.feeSatoshis)).toBe(signed.virtualSize);
  const rejected = fixture(4, plusOne!, '1');
  expect(() =>
    signValidatedBip84Plan(rejected.validated(), rejected.accountNode, noop)
  ).toThrow('FEE_LIMIT');
});

it('does not use SJS fee getters as the returned fee authority', () => {
  const f = fixture();
  const calculate = Psbt.prototype.getFeeRate;
  jest.spyOn(Psbt.prototype, 'getFee').mockReturnValue(-1n);
  jest
    .spyOn(Psbt.prototype, 'getFeeRate')
    .mockImplementation(function (this: Psbt) {
      calculate.call(this); // The library still initializes its extraction cache.
      return -1; // Its reported rate is not our returned fee authority.
    });
  expect(
    signValidatedBip84Plan(f.validated(), f.accountNode, noop).feeSatoshis
  ).toBe('1000');
});

it.each(['branch', 'child'] as const)(
  'rejects a BIP32 retry that changes the requested %s index',
  (kind) => {
    const f = fixture(),
      derive = f.accountNode.derive.bind(f.accountNode);
    jest.spyOn(f.accountNode, 'derive').mockImplementation((i) => {
      const branch = derive(kind === 'branch' ? i + 1 : i);
      if (kind === 'child') {
        const child = branch.derive.bind(branch);
        jest.spyOn(branch, 'derive').mockImplementation((j) => child(j + 1));
      }
      return branch;
    });
    expect(() =>
      signValidatedBip84Plan(f.validated(), f.accountNode, noop)
    ).toThrow('ACCOUNT_MISMATCH');
  }
);

it.each(['success', 'failure'] as const)(
  'clears all owned branch/child scalar buffers on %s',
  (kind) => {
    const f = fixture(),
      owned: BIP32Interface[] = [],
      derive = f.accountNode.derive.bind(f.accountNode);
    jest.spyOn(f.accountNode, 'derive').mockImplementation((i) => {
      const branch = derive(i);
      owned.push(branch);
      const child = branch.derive.bind(branch);
      jest.spyOn(branch, 'derive').mockImplementation((j) => {
        const value = child(j);
        owned.push(value);
        return value;
      });
      return branch;
    });
    if (kind === 'failure')
      jest.spyOn(Psbt.prototype, 'finalizeInput').mockImplementation(() => {
        throw Error('failure');
      });
    try {
      signValidatedBip84Plan(f.validated(), f.accountNode, noop);
    } catch (error) {
      if (kind === 'success') throw error;
    }
    expect(owned.length).toBeGreaterThan(1);
    for (const node of owned)
      expect(node.privateKey!.every((b) => b === 0)).toBe(true);
    expect(f.accountNode.privateKey!.some((b) => b !== 0)).toBe(true);
  }
);

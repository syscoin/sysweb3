/* Plain-Node check for the compiled or unpacked public-only entry. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const entry = path.resolve(
  process.argv[2] || path.join(__dirname, '../dist/cjs/bip84-native.js')
);
const originalLoad = Module._load;
const originals = [];
const forbid = () => {
  throw new Error('Public derivation attempted a host or authority operation');
};
const replace = (object, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, value: forbid });
  originals.push(() =>
    descriptor
      ? Object.defineProperty(object, key, descriptor)
      : delete object[key]
  );
};
const forbidden =
  /(?:^@(?:ledgerhq|trezor|sidhujag)\/|^syscoinjs-lib$|(?:^|[/\\])(?:storage(?:-core)?|software|providers?|keyring-(?:core|manager)|hardware-wallet-manager)(?:[/\\.]|$)|^(?:node:)?(?:https?|net|tls|fs)(?:\/|$))/;
try {
  for (const key of ['fetch', 'setTimeout', 'setInterval'])
    replace(global, key);
  for (const key of ['window', 'chrome', 'document', 'self', 'localStorage']) {
    const descriptor = Object.getOwnPropertyDescriptor(global, key);
    Object.defineProperty(global, key, { configurable: true, get: forbid });
    originals.push(() =>
      descriptor
        ? Object.defineProperty(global, key, descriptor)
        : delete global[key]
    );
  }
  for (const key of [
    'randomBytes',
    'randomFillSync',
    'randomFill',
    'randomInt',
    'randomUUID',
  ])
    replace(crypto, key);
  replace(crypto.webcrypto, 'getRandomValues');
  replace(Math, 'random');
  Module._load = function (request, parent, isMain) {
    assert(
      !forbidden.test(request),
      `Public entry loaded host/authority dependency: ${request}`
    );
    return originalLoad.apply(this, arguments);
  };
  const api = require(entry);
  assert.deepEqual(Object.keys(api).sort(), [
    'Bip84NativeError',
    'prepareBip84NativeTransaction',
  ]);
  const { Transaction } = require('bitcoinjs-lib');
  const publicApi = require(path.join(path.dirname(entry), 'public-bip84.js'));
  const key =
    'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
  const account = publicApi.parseBip84PublicAccount({
    network: 'bitcoin',
    accountKey: key,
  });
  const receive = publicApi.deriveBip84PublicAddress({
    network: 'bitcoin',
    accountKey: key,
    branch: 0,
    index: 0,
  });
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 1), 0);
  tx.addOutput(Buffer.from(receive.scriptPubKey, 'hex'), 100000n);
  const plan = {
    network: { network: 'bitcoin', endpoint: 'https://offline.invalid' },
    account,
    inputs: [{ txid: tx.getId(), vout: 0, branch: 0, index: 0 }],
    previousTransactions: [{ txid: tx.getId(), rawTransaction: tx.toHex() }],
    recipient: { address: receive.address, valueSatoshis: '99000' },
    change: null,
    locktime: 0,
    rbf: true,
    feeLimits: { maxFeeSatoshis: '1000', maxFeeRateSatPerVByte: '1000' },
  };
  const prepared = api.prepareBip84NativeTransaction(plan);
  assert.equal(prepared.feeSatoshis, '1000');
  assert.equal(
    Transaction.fromHex(prepared.unsignedTransaction).ins[0].sequence,
    0xfffffffd
  );
  assert(Object.isFrozen(prepared) && Object.isFrozen(prepared.plan.inputs[0]));
  assert.throws(
    () => api.prepareBip84NativeTransaction({ ...plan, locktime: 1 }),
    { code: 'INVALID_REQUEST' }
  );
  process.stdout.write(
    'BIP84 native planner: exact unsigned bytes, immutable public data, no host, timers, network, storage or RNG passed.\n'
  );
} finally {
  Module._load = originalLoad;
  for (const restore of originals.reverse()) restore();
}

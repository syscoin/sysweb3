/* Plain-Node check for the compiled or unpacked public-only entry. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const entry = path.resolve(
  process.argv[2] || path.join(__dirname, '../dist/cjs/public-bip84.js')
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
    'PublicBip84Error',
    'deriveBip84PublicAddress',
    'parseBip84PublicAccount',
  ]);
  const accountKey =
    'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
  const account = api.parseBip84PublicAccount({
    network: 'bitcoin',
    accountKey,
  });
  const result = api.deriveBip84PublicAddress({
    network: 'bitcoin',
    accountKey,
    branch: 0,
    index: 0,
  });
  assert.equal(result.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(
    result.scriptPubKey,
    '0014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2'
  );
  assert.equal(account.canonicalKey, accountKey);
  assert.equal(account.accountIndex, 0);
  assert(
    Object.isFrozen(account) &&
      Object.isFrozen(result) &&
      Object.isFrozen(result.account)
  );
  const sys = api.deriveBip84PublicAddress({
    network: 'syscoin',
    accountKey,
    branch: 0,
    index: 0,
  });
  assert.equal(sys.scriptPubKey, result.scriptPubKey);
  assert(sys.address.startsWith('sys1q'));
  assert.throws(
    () => api.parseBip84PublicAccount({ network: 'testnet', accountKey }),
    { code: 'INVALID_INPUT' }
  );
  assert.throws(
    () =>
      api.deriveBip84PublicAddress({
        network: 'bitcoin',
        accountKey,
        branch: 0,
        index: 0x80000000,
      }),
    { code: 'INVALID_INPUT' }
  );
  process.stdout.write(
    'Public BIP84 entry: exact exports/vectors, immutable outputs, no host, timers, network, storage, RNG or authority imports passed.\n'
  );
} finally {
  Module._load = originalLoad;
  for (const restore of originals.reverse()) restore();
}

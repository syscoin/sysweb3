/* Run against compiled or unpacked published output; no Jest mocks or TS loader. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const entry = path.resolve(
  process.argv[2] || path.join(__dirname, '../dist/cjs/software.js')
);
const originalLoad = Module._load;
const originalInterval = global.setInterval;
const originalTimeout = global.setTimeout;
const originalFetch = global.fetch;
const forbidden =
  /(?:^@(?:ledgerhq|trezor)\/|^@sidhujag\/sysweb3-core(?:\/|$)|(?:^|[/\\])(?:ledger|trezor|hardware-wallet-manager(?:-singleton)?|hardware-psbt|keyring-manager)(?:[/\\.]|$)|(?:^|[/\\])storage(?:\.js)?$)/;
for (const name of ['window', 'chrome', 'document', 'self'])
  delete global[name];
Module._load = function (request, parent, isMain) {
  assert(
    !forbidden.test(request),
    `Software entry loaded host/device dependency: ${request}`
  );
  return originalLoad.apply(this, arguments);
};
global.setInterval = global.setTimeout = () => {
  throw new Error('Software entry started a timer');
};
global.fetch = () => {
  throw new Error('Software entry attempted network access');
};
process.env.NODE_ENV = 'test';
process.env.SYSWEB3_PBKDF2_ENC_ITERS = '1000';

const storage = () => {
  const records = new Map();
  return {
    records,
    async get(key) {
      return records.get(key);
    },
    async set(key, value) {
      records.set(key, value);
    },
    async deleteItem(key) {
      records.delete(key);
    },
    async createManyIfAbsent(items) {
      if (Object.keys(items).some((key) => records.has(key))) return false;
      Object.entries(items).forEach(([key, value]) => records.set(key, value));
      return true;
    },
  };
};
(async () => {
  const {
    SoftwareKeyring,
    createSoftwareKeyringHost,
    KeyringAccountType,
    INetworkType,
  } = require(entry);
  const makeState = () => ({
    activeAccount: { id: 0, type: KeyringAccountType.HDAccount },
    activeNetwork: {
      kind: INetworkType.Ethereum,
      chainId: 1,
      slip44: 60,
      label: 'Ethereum',
      currency: 'ETH',
      url: 'https://offline.invalid',
    },
    accounts: {
      HDAccount: {},
      Imported: {},
      Ledger: {},
      Trezor: {},
      SmartAccount: {},
    },
  });
  const first = storage();
  const second = storage();
  const firstHost = createSoftwareKeyringHost(first);
  const a = new SoftwareKeyring(firstHost);
  const b = new SoftwareKeyring(createSoftwareKeyringHost(second));
  const aState = makeState();
  const bState = makeState();
  a.setVaultStateGetter(() => aState);
  b.setVaultStateGetter(() => bState);
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const otherMnemonic =
    'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const password = 'published software entry fixture';
  try {
    aState.accounts.HDAccount[0] = await a.initializeWalletSecurely(
      mnemonic,
      password
    );
    bState.accounts.HDAccount[0] = await b.initializeWalletSecurely(
      otherMnemonic,
      password
    );
    assert.notEqual(
      aState.accounts.HDAccount[0].address,
      bState.accounts.HDAccount[0].address
    );
    assert.equal(a.ledgerSigner, undefined);
    assert.equal(a.trezorSigner, undefined);
    assert.notEqual(first.records.get('vault'), second.records.get('vault'));
    assert(!JSON.stringify([...first.records]).includes(mnemonic));
    const storageBeforeDerivation = JSON.stringify([...first.records]);
    const indexed = await a.deriveEvmHdRuntimeAccount(
      { index: 1 },
      { assertCurrent() {} }
    );
    assert.equal(indexed.id, 1);
    assert.equal(indexed.address, '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0');
    assert.match(indexed.xpub, /^0x04[0-9a-f]{128}$/i);
    assert.equal(typeof indexed.xprv, 'string');
    assert(!Object.hasOwn(indexed, 'privateKey'));
    assert(!Object.hasOwn(aState.accounts.HDAccount, 1));
    assert.equal(JSON.stringify([...first.records]), storageBeforeDerivation);
    const signature = await a.ethereumTransaction.signPersonalMessage([
      '0x11',
      aState.accounts.HDAccount[0].address,
    ]);
    assert.match(signature, /^0x[0-9a-f]{130}$/i);
    const address = aState.accounts.HDAccount[0].address;
    const prepared = a.signPreparedEvmTransaction(
      {
        account: { id: 0, type: 'HDAccount', expectedAddress: address },
        network: {
          kind: 'ethereum',
          chainId: '1',
          slip44: 60,
          url: 'https://offline.invalid',
        },
        transaction: {
          type: 2,
          from: address,
          to: address,
          chainId: '1',
          nonce: '0',
          value: '1',
          gasLimit: '21000',
          data: '0x',
          maxFeePerGas: '2',
          maxPriorityFeePerGas: '1',
        },
      },
      { assertCurrent() {} }
    );
    const { Transaction } = require('ethers/transaction');
    const decoded = Transaction.from(prepared.rawTransaction);
    assert.equal(decoded.from, address);
    assert.equal(decoded.hash, prepared.hash);
    assert.equal(decoded.value, 1n);
    assert.equal(decoded.nonce, 0);
    assert(Object.isFrozen(prepared));
    await a.lockWallet();
    assert.equal(a.isUnlocked(), false);
    assert.equal(b.isUnlocked(), true);
    assert.equal((await a.unlock('wrong')).canLogin, false);
    assert.equal((await a.unlock(password)).canLogin, true);
    assert.equal(
      await a.ethereumTransaction.signPersonalMessage([
        '0x11',
        aState.accounts.HDAccount[0].address,
      ]),
      signature
    );
    assert.equal(await a.getSeed(password), mnemonic);
    assert.equal(await b.getSeed(password), otherMnemonic);
    assert.equal(typeof a.syscoinTransaction.getRecommendedFee, 'function');
    await assert.rejects(a.importLedgerAccount(), {
      code: 'HARDWARE_SIGNER_UNAVAILABLE',
    });
    const restarted = new SoftwareKeyring(firstHost);
    restarted.setVaultStateGetter(() => aState);
    try {
      assert.equal((await restarted.unlock(password)).canLogin, true);
    } finally {
      await restarted.destroy();
    }
  } finally {
    await a.destroy();
    await b.destroy();
    Module._load = originalLoad;
    global.setInterval = originalInterval;
    global.setTimeout = originalTimeout;
    global.fetch = originalFetch;
  }
  process.stdout.write(
    'Software entry: browser/device-free import, no timers, isolated vaults, signing and restart passed.\n'
  );
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});

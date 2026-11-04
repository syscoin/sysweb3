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
    const utxo = new SoftwareKeyring(firstHost);
    const utxoState = makeState();
    utxoState.activeNetwork = {
      kind: INetworkType.Syscoin,
      chainId: 0,
      slip44: 0,
      currency: 'btc',
      label: 'Bitcoin',
      url: 'https://offline.invalid',
    };
    utxo.setVaultStateGetter(() => utxoState);
    try {
      assert.equal((await utxo.unlock(password)).canLogin, true);
      const beforePublicDerivation = JSON.stringify([...first.records]);
      const publicAccount = await utxo.deriveBip84HdPublicAccount(
        {
          network: { network: 'bitcoin', endpoint: 'https://offline.invalid' },
          accountIndex: 0,
        },
        { assertCurrent() {} }
      );
      assert.equal(
        publicAccount.receive.address,
        'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
      );
      assert.equal(publicAccount.account.accountIndex, 0);
      assert(
        Object.isFrozen(publicAccount) && Object.isFrozen(publicAccount.account)
      );
      assert(!JSON.stringify(publicAccount).includes(mnemonic));
      assert(!Object.hasOwn(publicAccount, 'xprv'));
      assert.equal(JSON.stringify([...first.records]), beforePublicDerivation);
      const { Transaction } = require('bitcoinjs-lib');
      const { prepareBip84NativeTransaction } = require(path.join(
        path.dirname(entry),
        'bip84-native.js'
      ));
      const { deriveBip84PublicAddress } = require(path.join(
        path.dirname(entry),
        'public-bip84.js'
      ));
      for (const coin of ['bitcoin', 'syscoin']) {
        utxoState.activeNetwork = {
          ...utxoState.activeNetwork,
          chainId: coin === 'bitcoin' ? 0 : 57,
          slip44: coin === 'bitcoin' ? 0 : 57,
          currency: coin === 'bitcoin' ? 'btc' : 'sys',
        };
        const derived = await utxo.deriveBip84HdPublicAccount(
          {
            network: { network: coin, endpoint: 'https://offline.invalid' },
            accountIndex: 2,
          },
          { assertCurrent() {} }
        );
        utxoState.accounts.HDAccount[2] = {
          id: 2,
          address: derived.receive.address,
          xpub: derived.account.canonicalKey,
          xprv: '',
          label: 'HD2',
          isImported: false,
          isLedgerWallet: false,
          isTrezorWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
        };
        utxoState.activeAccount = { id: 2, type: KeyringAccountType.HDAccount };
        const parent = new Transaction();
        parent.version = 2;
        parent.addInput(Buffer.alloc(32, 2), 0);
        parent.addOutput(
          Buffer.from(derived.receive.scriptPubKey, 'hex'),
          100000n
        );
        const recipient = deriveBip84PublicAddress({
          network: coin,
          accountKey: derived.account.canonicalKey,
          branch: 0,
          index: 9,
        });
        const prepared = prepareBip84NativeTransaction({
          network: { network: coin, endpoint: 'https://offline.invalid' },
          account: derived.account,
          inputs: [{ txid: parent.getId(), vout: 0, branch: 0, index: 0 }],
          previousTransactions: [
            { txid: parent.getId(), rawTransaction: parent.toHex() },
          ],
          recipient: { address: recipient.address, valueSatoshis: '99000' },
          change: null,
          locktime: 0,
          rbf: true,
          feeLimits: { maxFeeSatoshis: '1000', maxFeeRateSatPerVByte: '1000' },
        });
        const request = {
          account: {
            type: 'HDAccount',
            index: 2,
            expectedAccountKey: derived.account.canonicalKey,
          },
          prepared,
        };
        const signed = await utxo.signPreparedBip84Transaction(request, {
          assertCurrent() {},
        });
        const tx = Transaction.fromHex(signed.rawTransaction),
          unsigned = tx.clone();
        unsigned.stripWitnesses();
        assert.equal(unsigned.toHex(), prepared.unsignedTransaction);
        assert.equal(tx.ins[0].witness.length, 2);
        assert.equal(signed.feeSatoshis, '1000');
        assert.equal(tx.getId(), signed.txid);
        assert.equal(tx.virtualSize(), signed.virtualSize);
        assert(Object.isFrozen(signed));
        assert(!JSON.stringify(signed).includes(mnemonic));
        utxoState.activeAccount.id = 0;
        await assert.rejects(
          utxo.signPreparedBip84Transaction(request, { assertCurrent() {} }),
          { code: 'CANCELLED' }
        );
      }
      assert.equal(JSON.stringify([...first.records]), beforePublicDerivation);
    } finally {
      await utxo.destroy();
    }
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
    'Software entry: browser/device-free import, no timers, isolated vaults, public BIP84 derivation, signing and restart passed.\n'
  );
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});

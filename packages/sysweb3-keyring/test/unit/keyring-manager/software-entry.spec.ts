import { SignTypedDataVersion } from '@metamask/eth-sig-util';

import { KeyringCore } from '../../../src/keyring-core';
import {
  SoftwareKeyring,
  createSoftwareKeyringHost,
  KeyringAccountType,
  INetworkType,
} from '../../../src/software';
import { createVaultPersistence } from '../../../src/storage-core';
import { EthereumTransactions } from '../../../src/transactions/ethereum';

import type { KeyringStoragePort } from '../../../src/software';

const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const otherMnemonic =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const password = 'software entry synthetic fixture';

function memoryStorage() {
  const records = new Map<string, any>();
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
  return { storage, records };
}

function vaultState() {
  return {
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
  } as any;
}

it('binds independent software authorities to their own encrypted storage across lock and restart', async () => {
  const first = memoryStorage();
  const second = memoryStorage();
  const firstHost = createSoftwareKeyringHost(first.storage);
  const secondHost = createSoftwareKeyringHost(second.storage);
  const firstState = vaultState();
  const secondState = vaultState();
  const a = new SoftwareKeyring(firstHost);
  const b = new SoftwareKeyring(secondHost);
  a.setVaultStateGetter(() => firstState);
  b.setVaultStateGetter(() => secondState);
  try {
    firstState.accounts.HDAccount[0] = await a.initializeWalletSecurely(
      mnemonic,
      password
    );
    secondState.accounts.HDAccount[0] = await b.initializeWalletSecurely(
      otherMnemonic,
      password
    );
    expect(firstState.accounts.HDAccount[0].address).not.toBe(
      secondState.accounts.HDAccount[0].address
    );
    expect(a.ledgerSigner).toBeUndefined();
    expect(a.trezorSigner).toBeUndefined();
    expect(first.records.get('vault')).not.toBe(second.records.get('vault'));
    expect(JSON.stringify([...first.records])).not.toContain(mnemonic);
    const firstCiphertext = first.records.get('vault');
    const secondCiphertext = second.records.get('vault');
    await a.lockWallet();
    expect(a.isUnlocked()).toBe(false);
    expect(b.isUnlocked()).toBe(true);
    expect(await a.unlock('incorrect')).toEqual({ canLogin: false });
    expect(await a.unlock(password)).toEqual({ canLogin: true });
    expect(await a.getSeed(password)).toBe(mnemonic);
    expect(await b.getSeed(password)).toBe(otherMnemonic);
    expect(typeof a.syscoinTransaction.getRecommendedFee).toBe('function');
    expect(first.records.get('vault')).toBe(firstCiphertext);
    expect(second.records.get('vault')).toBe(secondCiphertext);
    const restarted = new SoftwareKeyring(firstHost);
    restarted.setVaultStateGetter(() => firstState);
    try {
      expect(await restarted.unlock(password)).toEqual({ canLogin: true });
      expect(await restarted.getSeed(password)).toBe(mnemonic);
      expect(() => restarted.setStorage({})).toThrow(
        'Storage replacement is unavailable'
      );
    } finally {
      await restarted.destroy();
    }
  } finally {
    await a.destroy();
    await b.destroy();
  }
});

it('reuses the explicitly injected Syscoin signer ports after locking and unlocking', async () => {
  const { storage } = memoryStorage();
  const ledger = jest.fn();
  const state = vaultState();
  const keyring = new KeyringCore({
    authority: Object.freeze({}),
    storage,
    vaultPersistence: createVaultPersistence(storage),
    ledgerSigner: undefined,
    trezorSigner: undefined,
    syscoinHardwareSigners: { ledger },
  });
  keyring.setVaultStateGetter(() => state);
  try {
    state.accounts.HDAccount[0] = await keyring.initializeWalletSecurely(
      mnemonic,
      password
    );
    const before = keyring.syscoinTransaction;
    await keyring.lockWallet();
    expect(await keyring.unlock(password)).toEqual({ canLogin: true });
    expect(keyring.syscoinTransaction).not.toBe(before);
    expect((keyring.syscoinTransaction as any).hardwareSigners.ledger).toBe(
      ledger
    );
  } finally {
    await keyring.destroy();
  }
});

const missingHardwareCases = [
  { name: 'Ledger account', type: KeyringAccountType.Ledger, metadata: {} },
  { name: 'Trezor account', type: KeyringAccountType.Trezor, metadata: {} },
  {
    name: 'Ledger metadata',
    type: KeyringAccountType.HDAccount,
    metadata: { isLedgerWallet: true },
  },
  {
    name: 'Trezor metadata',
    type: KeyringAccountType.HDAccount,
    metadata: { isTrezorWallet: true },
  },
];

describe.each(missingHardwareCases)(
  '$name without a host signer',
  ({ type, metadata }) => {
    const address = `0x${'11'.repeat(20)}`;
    let sdk: EthereumTransactions<undefined, undefined>;
    let getKey: jest.Mock;
    let getNetwork: jest.Mock;
    beforeEach(() => {
      getKey = jest.fn(() => {
        throw new Error('Private key getter must not run');
      });
      getNetwork = jest.fn(() => {
        throw new Error('Provider must not initialize');
      });
      sdk = new EthereumTransactions(
        getNetwork,
        getKey,
        () => ({
          activeAccountId: 0,
          activeAccountType: type,
          activeNetwork: {} as any,
          accounts: { [type]: { 0: { address, ...metadata } } } as any,
        }),
        undefined,
        undefined
      );
    });
    const operations: Array<
      [
        string,
        (sdk: EthereumTransactions<undefined, undefined>) => Promise<unknown>
      ]
    > = [
      [
        'typed data',
        (sdk) => sdk.signTypedData(address, {} as any, SignTypedDataVersion.V4),
      ],
      ['personal message', (sdk) => sdk.signPersonalMessage(['0x11', address])],
      ['eth_sign', (sdk) => sdk.ethSign([address, '0x11'])],
      ['transaction', (sdk) => sdk.sendFormattedTransaction({} as any)],
      ['ERC20', (sdk) => sdk.sendSignedErc20Transaction({} as any)],
      ['ERC721', (sdk) => sdk.sendSignedErc721Transaction({} as any)],
      ['ERC1155', (sdk) => sdk.sendSignedErc1155Transaction({} as any)],
      [
        'cancellation',
        (sdk) =>
          sdk.cancelSentTransaction('0x11', false, undefined, {
            approvedMaximumFee: '10',
            assertCurrentContext: () => undefined,
            validateOriginal: () => undefined,
          }),
      ],
      [
        'replacement',
        (sdk) =>
          sdk.sendTransactionWithEditedFee('0x11', false, {
            approvedMaximumFee: '10',
          }),
      ],
    ];
    it.each(operations)(
      'rejects %s before private keys or provider access',
      async (_name, operation) => {
        await expect(operation(sdk)).rejects.toMatchObject({
          code: 'HARDWARE_SIGNER_UNAVAILABLE',
        });
        expect(getKey).not.toHaveBeenCalled();
        expect(getNetwork).not.toHaveBeenCalled();
      }
    );
  }
);

it.each([KeyringAccountType.Ledger, KeyringAccountType.Trezor])(
  'rejects %s address display without a device',
  async (type) => {
    const state = vaultState();
    state.activeAccount.type = type;
    const keyring = new SoftwareKeyring(
      createSoftwareKeyringHost(memoryStorage().storage)
    );
    keyring.setVaultStateGetter(() => state);
    await expect(
      keyring.ethereumTransaction.verifyUtxoAddress(0, 'sys', 57)
    ).rejects.toMatchObject({ code: 'HARDWARE_SIGNER_UNAVAILABLE' });
    await keyring.destroy();
  }
);

it('rejects forged or mixed software hosts before any storage work', () => {
  const first = memoryStorage();
  const second = memoryStorage();
  expect(
    () =>
      new SoftwareKeyring({
        storage: first.storage,
        vaultPersistence: createVaultPersistence(second.storage),
      } as any)
  ).toThrow('Invalid software keyring host');
  expect(() => new SoftwareKeyring({} as any)).toThrow(
    'Invalid software keyring host'
  );
  expect(first.storage.get).not.toHaveBeenCalled();
  expect(first.storage.set).not.toHaveBeenCalled();
  expect(second.storage.get).not.toHaveBeenCalled();
  expect(second.storage.set).not.toHaveBeenCalled();
});

it('rejects cross-authority session transfer without changing either session, and allows same-host transfers', async () => {
  const firstHost = createSoftwareKeyringHost(memoryStorage().storage);
  const secondHost = createSoftwareKeyringHost(memoryStorage().storage);
  const a = new SoftwareKeyring(firstHost);
  const b = new SoftwareKeyring(secondHost);
  const sibling = new SoftwareKeyring(firstHost);
  const aState = vaultState();
  const bState = vaultState();
  a.setVaultStateGetter(() => aState);
  b.setVaultStateGetter(() => bState);
  sibling.setVaultStateGetter(() => aState);
  try {
    aState.accounts.HDAccount[0] = await a.initializeWalletSecurely(
      mnemonic,
      password
    );
    bState.accounts.HDAccount[0] = await b.initializeWalletSecurely(
      otherMnemonic,
      password
    );
    const sourcePassword = (a as any).sessionPassword;
    const sourceMnemonic = (a as any).sessionMnemonic;
    expect(() =>
      b.receiveSessionOwnership(sourcePassword, sourceMnemonic)
    ).toThrow('Direct session injection is unavailable');
    expect(() =>
      sibling.receiveSessionOwnership(sourcePassword, sourceMnemonic)
    ).toThrow('Direct session injection is unavailable');
    expect((a as any).sessionPassword).toBe(sourcePassword);
    expect(() => a.transferSessionTo(b)).toThrow(
      'different wallet authorities'
    );
    expect(a.isUnlocked()).toBe(true);
    expect(b.isUnlocked()).toBe(true);
    expect(await a.getSeed(password)).toBe(mnemonic);
    expect(await b.getSeed(password)).toBe(otherMnemonic);
    a.transferSessionTo(sibling);
    expect(a.isUnlocked()).toBe(false);
    expect(sibling.isUnlocked()).toBe(true);
    expect(await sibling.getSeed(password)).toBe(mnemonic);
    sibling.transferSessionTo(a);
    expect(a.isUnlocked()).toBe(true);
    expect(sibling.isUnlocked()).toBe(false);
  } finally {
    await a.destroy();
    await b.destroy();
    await sibling.destroy();
  }
});

it('cannot rebind a software host through the legacy storage setter', async () => {
  const first = memoryStorage();
  const setClient = jest.fn();
  first.storage.setClient = setClient;
  const keyring = new SoftwareKeyring(createSoftwareKeyringHost(first.storage));
  const state = vaultState();
  keyring.setVaultStateGetter(() => state);
  try {
    state.accounts.HDAccount[0] = await keyring.initializeWalletSecurely(
      mnemonic,
      password
    );
    const before = first.records.get('vault');
    expect(() => keyring.setStorage({})).toThrow(
      'Storage replacement is unavailable'
    );
    expect(setClient).not.toHaveBeenCalled();
    expect(first.records.get('vault')).toBe(before);
    expect(keyring.isUnlocked()).toBe(true);
    expect(await keyring.getSeed(password)).toBe(mnemonic);
  } finally {
    await keyring.destroy();
  }
});

it.each([false, true])(
  'rejects a reused authority token with mismatched storage or persistence (same storage: %s)',
  async (sameStorage) => {
    const first = memoryStorage();
    const second = sameStorage ? first : memoryStorage();
    const authority = Object.freeze({});
    const a = new KeyringCore({
      authority,
      storage: first.storage,
      vaultPersistence: createVaultPersistence(first.storage),
      ledgerSigner: undefined,
      trezorSigner: undefined,
    });
    const b = new KeyringCore({
      authority,
      storage: second.storage,
      vaultPersistence: createVaultPersistence(second.storage),
      ledgerSigner: undefined,
      trezorSigner: undefined,
    });
    const state = vaultState();
    a.setVaultStateGetter(() => state);
    b.setVaultStateGetter(() => state);
    try {
      state.accounts.HDAccount[0] = await a.initializeWalletSecurely(
        mnemonic,
        password
      );
      if (sameStorage)
        expect(await b.unlock(password)).toEqual({ canLogin: true });
      else await b.initializeWalletSecurely(otherMnemonic, password);
      expect(() => a.transferSessionTo(b)).toThrow(
        'different wallet authorities'
      );
      expect(a.isUnlocked()).toBe(true);
      expect(b.isUnlocked()).toBe(true);
      expect(await a.getSeed(password)).toBe(mnemonic);
      expect(await b.getSeed(password)).toBe(
        sameStorage ? mnemonic : otherMnemonic
      );
    } finally {
      await a.destroy();
      await b.destroy();
    }
  }
);

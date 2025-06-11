import { KeyringManager, KeyringAccountType, initialWalletState } from '../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from './constants';

// Mock for address generation - track calls to simulate address progression
let addressCallCount = 0;

// Only mock network calls
jest.mock('syscoinjs-lib', () => {
  const actual = jest.requireActual('syscoinjs-lib');
  return {
    ...actual,
    utils: {
      ...actual.utils,
      // Mock the network call to simulate address progression
      fetchBackendAccount: jest.fn().mockImplementation(() => {
        // Simulate different used addresses on each call to get different next addresses
        addressCallCount++;
        const usedIndex = Math.max(0, addressCallCount - 1);

        return Promise.resolve({
          balance: 100000000, // 1 SYS
          tokens: [{ path: `m/84'/57'/0'/0/${usedIndex}`, transfers: 1 }],
        });
      }),
    },
  };
});

// Mock network providers
jest.mock('../src/providers', () => ({
  CustomJsonRpcProvider: jest.fn().mockImplementation(() => ({
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
  })),
}));

// Mock only the network-dependent parts of transactions
jest.mock('../src/transactions', () => {
  const { SyscoinTransactions, EthereumTransactions } = jest.requireActual(
    '../src/transactions'
  );

  // Override only network methods
  class MockedEthereumTransactions extends EthereumTransactions {
    async getBalance() {
      return 0;
    }

    setWeb3Provider() {
      // no-op
    }

    async getRecommendedNonce() {
      return 1;
    }
  }

  return {
    SyscoinTransactions,
    EthereumTransactions: MockedEthereumTransactions,
  };
});

// Mock storage
const mockStorage = new Map<string, any>();

jest.mock('@pollum-io/sysweb3-core', () => ({
  sysweb3Di: {
    getStateStorageDb: () => ({
      get: jest.fn((key) => Promise.resolve(mockStorage.get(key))),
      set: jest.fn((key, value) => {
        mockStorage.set(key, value);
        return Promise.resolve();
      }),
    }),
  },
}));

describe('Keyring Manager - Real Implementation Tests', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
    addressCallCount = 0; // Reset address counter for each test
  });

  it('should properly manage account indexes when switching accounts', async () => {
    // Setup
    keyringManager = new KeyringManager();
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);

    // Create initial account
    const account1 = await keyringManager.createKeyringVault();
    expect(account1.id).toBe(0);

    // Set to Syscoin network to initialize HD signer before adding accounts
    const testnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(testnet, 'syscoin');

    // Create second account
    const account2 = await keyringManager.addNewAccount('Account 2');
    expect(account2?.id).toBe(1);

    // Verify active account changed
    const activeAccount2 = keyringManager.getActiveAccount();
    expect(activeAccount2.activeAccount.id).toBe(1);

    // Create third account
    const account3 = await keyringManager.addNewAccount('Account 3');
    expect(account3?.id).toBe(2);

    // Verify active account changed
    const activeAccount3 = keyringManager.getActiveAccount();
    expect(activeAccount3.activeAccount.id).toBe(2);

    // Switch back to first account
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    const activeAccount0 = keyringManager.getActiveAccount();
    expect(activeAccount0.activeAccount.id).toBe(0);

    // Switch to second account
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
    const activeAccount1 = keyringManager.getActiveAccount();
    expect(activeAccount1.activeAccount.id).toBe(1);

    // Verify the addresses are different by updating receiving addresses
    const addr1 = await keyringManager.updateReceivingAddress();
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
    const addr2 = await keyringManager.updateReceivingAddress();

    expect(addr1).not.toBe(addr2);
  });

  it('should derive correct addresses for different accounts', async () => {
    keyringManager = new KeyringManager();
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set to Syscoin network to initialize HD signer before adding accounts
    const testnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(testnet, 'syscoin');

    // Get addresses from different accounts
    const addresses: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await keyringManager.addNewAccount(`Account ${i + 1}`);
      }
      await keyringManager.setActiveAccount(i, KeyringAccountType.HDAccount);
      const address = await keyringManager.updateReceivingAddress();
      addresses.push(address);
    }

    // All addresses should be unique
    const uniqueAddresses = new Set(addresses);
    expect(uniqueAddresses.size).toBe(3);
  });

  it('should properly handle imported accounts', async () => {
    keyringManager = new KeyringManager();
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set to Syscoin network first
    const testnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(testnet, 'syscoin');

    // Import a UTXO account with a valid mainnet zprv (BIP84)
    // We'll use a mainnet key and let the address format adjust for testnet
    const zprv =
      'zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE';
    const syscoinTestnet = {
      chainId: 5700,
      currency: 'Syscoin Testnet',
      slip44: 1,
      isTestnet: true,
      url: 'https://explorer-blockbook-dev.syscoin.org/',
      label: 'Syscoin Testnet',
    };
    const importedAccount = await keyringManager.importAccount(
      zprv,
      'Imported UTXO',
      syscoinTestnet
    );

    expect(importedAccount.isImported).toBe(true);
    expect(importedAccount.label).toBe('Imported UTXO');

    // Switch to imported account
    await keyringManager.setActiveAccount(
      importedAccount.id,
      KeyringAccountType.Imported
    );

    const activeAccount = keyringManager.getActiveAccount();
    expect(activeAccount.activeAccountType).toBe(KeyringAccountType.Imported);
    expect(activeAccount.activeAccount.id).toBe(importedAccount.id);
  });

  it('should maintain correct state when switching between networks', async () => {
    keyringManager = new KeyringManager();
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Start with Syscoin
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    // Create multiple accounts
    await keyringManager.addNewAccount('Syscoin Account 2');
    await keyringManager.addNewAccount('Syscoin Account 3');

    // Switch to account 1 (index 1)
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
    const activeBeforeSwitch = keyringManager.getActiveAccount();
    expect(activeBeforeSwitch.activeAccount.id).toBe(1);

    // Switch to Ethereum
    const ethMainnet = initialWalletState.networks.ethereum[1];
    await keyringManager.setSignerNetwork(ethMainnet, 'ethereum');

    // Active account should remain the same
    const activeOnEth = keyringManager.getActiveAccount();
    expect(activeOnEth.activeAccount.id).toBe(1);

    // Switch back to Syscoin
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    // Should restore the correct account index
    const activeAfterSwitch = keyringManager.getActiveAccount();
    expect(activeAfterSwitch.activeAccount.id).toBe(1);
  });

  it('should handle edge cases in account switching', async () => {
    keyringManager = new KeyringManager();
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set to Syscoin network first to initialize HD signer
    const testnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(testnet, 'syscoin');

    // Create accounts non-sequentially
    await keyringManager.addNewAccount('Account 2');
    await keyringManager.addNewAccount('Account 3');

    // Now try to activate account 0 again
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    const activeAccount0 = keyringManager.getActiveAccount();
    expect(activeAccount0.activeAccount.id).toBe(0);

    // Try to activate account 2
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
    const activeAccount2 = keyringManager.getActiveAccount();
    expect(activeAccount2.activeAccount.id).toBe(2);

    // Verify we can get change addresses for different accounts
    const changeAddr0 = await keyringManager.getChangeAddress(0);
    const changeAddr2 = await keyringManager.getChangeAddress(2);
    expect(changeAddr0).not.toBe(changeAddr2);
  });

  it('should properly update receiving addresses', async () => {
    keyringManager = new KeyringManager();
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set to Syscoin network first to initialize HD signer
    const testnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(testnet, 'syscoin');

    // Get initial address
    const address1 = await keyringManager.updateReceivingAddress();

    // Get another address - should be different
    const address2 = await keyringManager.updateReceivingAddress();

    expect(address1).toBeDefined();
    expect(address2).toBeDefined();
    expect(address1).not.toBe(address2);
  });
});

import { KeyringManager, KeyringAccountType, initialWalletState } from '../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from './constants';
import { INetworkType } from '@pollum-io/sysweb3-network';

// Minimal mocking - only mock network calls
jest.mock('syscoinjs-lib', () => {
  const actual = jest.requireActual('syscoinjs-lib');
  return {
    ...actual,
    utils: {
      ...actual.utils,
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 100000000,
        tokens: [],
      }),
    },
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

// Mock network providers
jest.mock('../src/providers', () => ({
  CustomJsonRpcProvider: jest.fn(),
}));

// Mock only the network-dependent parts of transactions
jest.mock('../src/transactions', () => ({
  SyscoinTransactions: jest.fn().mockImplementation(() => ({})),
  EthereumTransactions: jest.fn().mockImplementation(() => ({
    setWeb3Provider: jest.fn(),
    getBalance: jest.fn().mockResolvedValue(0),
  })),
}));

describe('Account Index Fix - Issue #1157', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
  });

  it('should maintain correct account index when switching between accounts in UTXO', async () => {
    // Initialize with Syscoin testnet using new architecture
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: syscoinTestnet,
      },
      INetworkType.Syscoin
    );

    // Account 0 is already created by createInitialized
    const account0 = keyringManager.getActiveAccount().activeAccount;
    expect(account0.id).toBe(0);

    // The HD signer should be initialized and pointing to account 0
    let hd = (keyringManager as any).hd;
    expect(hd).toBeDefined();
    expect(hd.Signer.accountIndex).toBe(0);

    // Create account 1
    const account1 = await keyringManager.addNewAccount('Account 2');
    expect(account1?.id).toBe(1);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(1); // Should switch to newly created account

    // Create account 2
    const account2 = await keyringManager.addNewAccount('Account 3');
    expect(account2?.id).toBe(2);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(2); // Should switch to newly created account

    // Switch back to account 0
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(0); // Should be 0 after switch

    // Switch to account 1
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(1); // Should be 1 after switch

    // Switch to account 2
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(2); // Should be 2 after switch

    // Verify the active account matches
    const activeAccount = keyringManager.getActiveAccount();
    expect(activeAccount.activeAccount.id).toBe(2);
  });

  it('should correctly set account index when creating new UTXO keyring with existing account structure', async () => {
    // Initialize with Syscoin testnet using standard approach
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: syscoinTestnet,
      },
      INetworkType.Syscoin
    );

    // Create multiple accounts (account 0 already exists from createInitialized)
    const account1 = await keyringManager.addNewAccount('Account 2');
    expect(account1?.id).toBe(1);

    const account2 = await keyringManager.addNewAccount('Account 3');
    expect(account2?.id).toBe(2);

    // HD signer should be at account 2 (the last created account)
    let hd = (keyringManager as any).hd;
    expect(hd).toBeDefined();
    expect(hd.Signer.accountIndex).toBe(2);

    // Switch to account 1
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(1);

    // Switch to account 0
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(0);

    // Switch back to account 2 to verify it works
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(2);
  });

  it('should handle non-sequential account switching correctly', async () => {
    // Initialize with Syscoin testnet using new architecture
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: syscoinTestnet,
      },
      INetworkType.Syscoin
    );

    let hd = (keyringManager as any).hd;

    // Create multiple accounts (account 0 already exists)
    const account1 = await keyringManager.addNewAccount('Account 2');
    expect(account1?.id).toBe(1);

    const account2 = await keyringManager.addNewAccount('Account 3');
    expect(account2?.id).toBe(2);

    const account3 = await keyringManager.addNewAccount('Account 4');
    expect(account3?.id).toBe(3);

    // After creating 3 accounts, should be at account 3 (the last created account)
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(3);

    // Jump from account 3 to account 0 (non-sequential)
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(0);
    let activeAccount = keyringManager.getActiveAccount().activeAccount;
    expect(activeAccount.id).toBe(0);

    // Jump from account 0 to account 2 (non-sequential)
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(2);
    activeAccount = keyringManager.getActiveAccount().activeAccount;
    expect(activeAccount.id).toBe(2);

    // Jump from account 2 to account 1 (non-sequential)
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(1);
    activeAccount = keyringManager.getActiveAccount().activeAccount;
    expect(activeAccount.id).toBe(1);

    // Jump from account 1 to account 3 (non-sequential)
    await keyringManager.setActiveAccount(3, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(3);
    activeAccount = keyringManager.getActiveAccount().activeAccount;
    expect(activeAccount.id).toBe(3);
  });
});

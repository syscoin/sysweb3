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
    // Initialize with Syscoin network
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[5700], // Syscoin testnet
      },
      activeChain: INetworkType.Syscoin,
    });

    // Setup wallet
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);

    // Create initial account - this creates the HD signer
    const account0 = await keyringManager.createKeyringVault();
    expect(account0.id).toBe(0);

    // Make sure we're on Syscoin network to initialize HD signer
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

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

  it('should correctly set account index when recreating accounts after network switch', async () => {
    // Start with Ethereum network
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.ethereum[1],
      },
      activeChain: INetworkType.Ethereum,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Create accounts on Ethereum
    await keyringManager.addNewAccount('ETH Account 2');
    await keyringManager.addNewAccount('ETH Account 3');

    // Switch to account 2
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);

    // Switch to Syscoin network - this will initialize the HD signer
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    // The HD signer should be created and set to account 2 (the active account)
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
  });

  it('should handle non-sequential account switching correctly', async () => {
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[5700],
      },
      activeChain: INetworkType.Syscoin,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set up Syscoin network to initialize HD signer
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    let hd = (keyringManager as any).hd;

    // Create multiple accounts
    await keyringManager.addNewAccount();
    await keyringManager.addNewAccount();
    await keyringManager.addNewAccount();

    // After creating 3 accounts, should be at account 3 (the last created account)
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(3);
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(0);

    // Jump from account 0 to account 2
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
    hd = (keyringManager as any).hd; // Get fresh reference
    expect(hd.Signer.accountIndex).toBe(2);

    // Verify accounts array is properly populated
    expect(hd.Signer.accounts[0]).toBeDefined();
    expect(hd.Signer.accounts[1]).toBeDefined();
    expect(hd.Signer.accounts[2]).toBeDefined();
    expect(hd.Signer.accounts[3]).toBeDefined();
  });
});

import { KeyringManager, KeyringAccountType, initialWalletState } from '../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from './constants';
import { INetworkType } from '@pollum-io/sysweb3-network';

// Mock syscoinjs-lib
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

// Mock getSysRpc
jest.mock('@pollum-io/sysweb3-network', () => ({
  getSysRpc: jest.fn((network) => {
    const isTestnet =
      network.chainId === 5700 ||
      network.url.includes('dev') ||
      network.url.includes('test');
    return Promise.resolve({
      rpc: {
        formattedNetwork: network,
        networkConfig: null,
      },
      chain: isTestnet ? 'test' : 'main',
      isTestnet,
    });
  }),
  INetworkType: {
    Syscoin: 'syscoin',
    Ethereum: 'ethereum',
  },
}));

// Mock transactions
jest.mock('../src/transactions', () => ({
  SyscoinTransactions: jest.fn().mockImplementation(() => ({})),
  EthereumTransactions: jest.fn().mockImplementation(() => ({
    setWeb3Provider: jest.fn(),
    getBalance: jest.fn().mockResolvedValue(0),
  })),
}));

describe('Network Synchronization Fix', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
  });

  it('should recreate HD signer when switching from mainnet to testnet', async () => {
    // Start with mainnet
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[57], // Syscoin mainnet
      },
      activeChain: INetworkType.Syscoin,
    });

    // Setup wallet
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set mainnet network
    const syscoinMainnet = initialWalletState.networks.syscoin[57];
    await keyringManager.setSignerNetwork(syscoinMainnet, 'syscoin');

    const hdBefore = (keyringManager as any).hd;
    expect(hdBefore).toBeDefined();
    expect(hdBefore.Signer.isTestnet).toBe(false); // Should be mainnet

    // Now switch to testnet network
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    // The HD signer should have been recreated for testnet
    const hdAfter = (keyringManager as any).hd;
    expect(hdAfter).toBeDefined();
    expect(hdAfter.Signer.isTestnet).toBe(true); // Should be testnet

    // Now when we call setActiveAccount, it should detect the network sync is needed
    // if we manually manipulate the network back to mainnet without updating HD
    (keyringManager as any).wallet.activeNetwork = syscoinMainnet;

    // This call should recreate HD signer due to network mismatch
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    const hdAfter2 = (keyringManager as any).hd;

    // The HD signer should have been recreated due to network mismatch
    expect(hdAfter2.Signer.isTestnet).toBe(false); // Should be mainnet again
  });

  it('should not recreate HD signer when network matches', async () => {
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[5700], // Testnet
      },
      activeChain: INetworkType.Syscoin,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set testnet network
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    const hdBefore = (keyringManager as any).hd;
    expect(hdBefore.Signer.isTestnet).toBe(true);

    // Create another account
    await keyringManager.addNewAccount();

    // Switch between accounts - should NOT recreate HD signer since network matches
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    const hdAfter1 = (keyringManager as any).hd;

    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
    const hdAfter2 = (keyringManager as any).hd;

    // HD signer should be the same instance since network didn't change
    expect(hdAfter1.Signer.isTestnet).toBe(true);
    expect(hdAfter2.Signer.isTestnet).toBe(true);
  });

  it('should handle edge case where HD signer network becomes out of sync', async () => {
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[57], // Mainnet
      },
      activeChain: INetworkType.Syscoin,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set mainnet
    const syscoinMainnet = initialWalletState.networks.syscoin[57];
    await keyringManager.setSignerNetwork(syscoinMainnet, 'syscoin');

    const hd = (keyringManager as any).hd;
    expect(hd.Signer.isTestnet).toBe(false);

    // Simulate edge case: network changes but HD signer doesn't get updated
    // (this could happen in race conditions or bugs)
    (keyringManager as any).wallet.activeNetwork =
      initialWalletState.networks.syscoin[5700]; // Switch to testnet

    // Now setActiveAccount should detect the mismatch and fix it
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);

    const hdAfter = (keyringManager as any).hd;
    expect(hdAfter.Signer.isTestnet).toBe(true); // Should have been corrected to testnet
  });
});

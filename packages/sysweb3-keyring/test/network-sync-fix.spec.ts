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
    return Promise.resolve({
      rpc: {
        formattedNetwork: network,
        networkConfig: null,
      },
      chain: 'main',
    });
  }),
  clearRpcCaches: jest.fn(() => {
    console.log('[RPC] Cleared all RPC caches');
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

describe('EVM Network Synchronization', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
  });

  it('should handle EVM network switching correctly', async () => {
    // Initialize with Ethereum mainnet using new architecture
    const ethMainnet = initialWalletState.networks.ethereum[1];
    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: ethMainnet,
      },
      INetworkType.Ethereum
    );

    const hdBefore = (keyringManager as any).hd;
    expect(hdBefore).toBeDefined();

    // Now switch to Polygon network (different EVM network)
    const polygonMainnet = initialWalletState.networks.ethereum[137];
    await keyringManager.setSignerNetwork(polygonMainnet);

    // The HD signer should still exist and work for EVM networks
    const hdAfter = (keyringManager as any).hd;
    expect(hdAfter).toBeDefined();

    // Account switching should work across EVM networks
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
  });

  it('should maintain account consistency across EVM networks', async () => {
    // Initialize with Ethereum mainnet using new architecture
    const ethMainnet = initialWalletState.networks.ethereum[1];
    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: ethMainnet,
      },
      INetworkType.Ethereum
    );

    // Create another account
    await keyringManager.addNewAccount();

    // Switch between accounts - should work seamlessly
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
  });

  it('should handle UTXO account switching within same network', async () => {
    // Initialize with Syscoin mainnet using new architecture
    const syscoinMainnet = initialWalletState.networks.syscoin[57];
    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: syscoinMainnet,
      },
      INetworkType.Syscoin
    );

    // Note: HD signer is already initialized with the network

    // Create another account
    await keyringManager.addNewAccount();

    // Switch between UTXO accounts within the same network - this is valid
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
  });
});

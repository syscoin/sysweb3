import { KeyringManager, KeyringAccountType, initialWalletState } from '../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from './constants';
import { INetworkType } from '@pollum-io/sysweb3-network';

// Mock syscoinjs-lib - only network calls, use real HDSigner for deterministic crypto
jest.mock('syscoinjs-lib', () => {
  const actual = jest.requireActual('syscoinjs-lib');

  return {
    ...actual,
    utils: {
      ...actual.utils,
      // Only mock network-dependent functions
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 100000000,
        tokens: [],
      }),
      fetchBackendUTXOS: jest.fn().mockResolvedValue([]),
      sanitizeBlockbookUTXOs: jest.fn().mockReturnValue([]),
      fetchEstimateFee: jest.fn().mockResolvedValue(0.001024), // 0.001024 SYS/kB = 0.000001 SYS/byte
    },
    SyscoinJSLib: jest.fn().mockImplementation((hd, url) => ({
      blockbookURL: url || 'https://blockbook.syscoin.org/',
      Signer: hd,
    })),
  };
});

// Mock storage module
jest.mock('../src/storage', () => ({
  getDecryptedVault: jest.fn().mockResolvedValue({
    mnemonic:
      'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA==',
  }),
  setEncryptedVault: jest.fn().mockResolvedValue(true),
}));

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

// Mock getSysRpc to handle different UTXO networks
jest.mock('@pollum-io/sysweb3-network', () => ({
  getSysRpc: jest.fn((network) => {
    // For testing purposes, we don't provide networkConfig for Bitcoin networks
    // to avoid complex Bitcoin network parameter requirements that would require
    // extensive Bitcoin-specific network structure
    const networkConfig: any = null;
    // Syscoin networks don't need networkConfig for basic functionality

    return Promise.resolve({
      rpc: {
        formattedNetwork: {
          ...network,
          chainId: network.chainId,
        },
        networkConfig,
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

describe('Account Management and EVM Network Switching', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
  });

  it('should handle EVM network switching correctly', async () => {
    // Start with Ethereum mainnet
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.ethereum[1], // Ethereum mainnet
      },
      activeChain: INetworkType.Ethereum,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set Ethereum mainnet
    const ethMainnet = initialWalletState.networks.ethereum[1];
    await keyringManager.setSignerNetwork(ethMainnet, 'ethereum');

    const hdBefore = (keyringManager as any).hd;
    expect(hdBefore).toBeDefined();

    // Switch to Polygon network (different EVM network)
    const polygonMainnet = initialWalletState.networks.ethereum[137];
    await keyringManager.setSignerNetwork(polygonMainnet, 'ethereum');

    const hdAfter = (keyringManager as any).hd;
    expect(hdAfter).toBeDefined();

    // Account switching should work across EVM networks
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
  });

  it('should handle custom EVM network switching', async () => {
    // Start with Ethereum mainnet
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

    const originalNetwork = initialWalletState.networks.ethereum[1];
    await keyringManager.setSignerNetwork(originalNetwork, 'ethereum');

    // Create a custom EVM network
    const customEVMNetwork = {
      chainId: 999,
      label: 'Custom EVM Network',
      url: 'https://custom-evm-rpc.example.com',
      currency: 'CUSTOM',
      slip44: 60, // EVM networks use slip44=60
      default: false,
      apiUrl: '',
      explorer: 'https://custom-evm-explorer.example.com',
    };

    // Add the custom network
    (keyringManager as any).wallet.networks.ethereum[999] = customEVMNetwork;

    // Switch to custom EVM network
    await keyringManager.setSignerNetwork(customEVMNetwork, 'ethereum');

    // Account switching should work with custom EVM networks
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
  });

  it('should handle UTXO account switching within same network', async () => {
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[57],
      },
      activeChain: INetworkType.Syscoin,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Note: No setSignerNetwork call needed - setupWallet initializes with Syscoin

    // Create another account
    await keyringManager.addNewAccount();

    // Switch between UTXO accounts within the same network - this is valid
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
  });

  it('should maintain account consistency during operations', async () => {
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[57],
      },
      activeChain: INetworkType.Syscoin,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Create multiple accounts
    await keyringManager.addNewAccount();
    await keyringManager.addNewAccount();

    // Switch between accounts - should work seamlessly
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
  });
});

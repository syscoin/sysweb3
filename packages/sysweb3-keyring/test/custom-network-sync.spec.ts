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
    const isTestnet =
      network.chainId === 5700 ||
      network.chainId === 1 ||
      network.url.includes('dev') ||
      network.url.includes('test') ||
      network.isTestnet;

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
      chain: isTestnet ? 'test' : 'main',
      isTestnet,
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

describe('Custom Network Synchronization', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
  });

  it('should recreate HD signer when switching between different UTXO networks (mainnet to mainnet)', async () => {
    // Start with Syscoin mainnet
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[57], // Syscoin mainnet
      },
      activeChain: INetworkType.Syscoin,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set Syscoin mainnet
    const syscoinMainnet = initialWalletState.networks.syscoin[57];
    await keyringManager.setSignerNetwork(syscoinMainnet, 'syscoin');

    const hdBefore = (keyringManager as any).hd;
    expect(hdBefore.Signer.isTestnet).toBe(false);
    // Note: SLIP44 will be set by the current active network, which is Syscoin (57)

    // Create a custom Bitcoin mainnet network
    const bitcoinMainnet = {
      chainId: 0, // Bitcoin mainnet
      label: 'Bitcoin Mainnet',
      url: 'https://blockbook.bitcoin.org',
      currency: 'btc',
      slip44: 0,
      isTestnet: false,
      default: false,
      apiUrl: '',
      explorer: 'https://blockbook.bitcoin.org',
    };

    // Add the custom network to wallet state
    (keyringManager as any).wallet.networks.syscoin[0] = bitcoinMainnet;

    // Switch to Bitcoin mainnet (both are mainnet, but different networks)
    await keyringManager.setSignerNetwork(bitcoinMainnet, 'syscoin');

    const hdAfter = (keyringManager as any).hd;
    const syscoinSignerAfter = (keyringManager as any).syscoinSigner;

    // Test validates that network switching updates the signer URL

    // HD signer should have been recreated for the new network
    expect(hdAfter.Signer.isTestnet).toBe(false); // Still mainnet
    expect(hdAfter.Signer.SLIP44).toBe(0); // Now Bitcoin (from networkConfig)
    expect(syscoinSignerAfter.blockbookURL).toBe(bitcoinMainnet.url);

    // Now test setActiveAccount with the network mismatch scenario
    // Manually set network back to Syscoin without updating HD signer
    (keyringManager as any).wallet.activeNetwork = syscoinMainnet;

    // This should detect network mismatch and recreate HD signer for Syscoin
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);

    const syscoinSignerFinal = (keyringManager as any).syscoinSigner;
    // Verify that switching back to Syscoin updated the signer URL
    expect(syscoinSignerFinal.blockbookURL).toBe(syscoinMainnet.url);
    const hdFinal = (keyringManager as any).hd;
    expect(hdFinal.Signer.SLIP44).toBe(57);
  });

  it('should recreate HD signer when switching between different testnet networks', async () => {
    // Start with Syscoin testnet
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[5700], // Syscoin testnet
      },
      activeChain: INetworkType.Syscoin,
    });

    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set Syscoin testnet
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    const hdBefore = (keyringManager as any).hd;
    expect(hdBefore.Signer.isTestnet).toBe(true);
    // Note: SLIP44 will be set to testnet value (1) from the Bitcoin testnet network config

    // Create a custom Bitcoin testnet network
    const bitcoinTestnet = {
      chainId: 1, // Bitcoin testnet (using 1 as example)
      label: 'Bitcoin Testnet',
      url: 'https://blockbook-dev.bitcoin.org',
      currency: 'tbtc',
      slip44: 1,
      isTestnet: true,
      default: false,
      apiUrl: '',
      explorer: 'https://blockbook-test.bitcoin.org',
    };

    // Add the custom network
    (keyringManager as any).wallet.networks.syscoin[1] = bitcoinTestnet;

    // Switch to Bitcoin testnet (both are testnet, but different networks)
    await keyringManager.setSignerNetwork(bitcoinTestnet, 'syscoin');

    const hdAfter = (keyringManager as any).hd;

    // HD signer should have been recreated for Bitcoin testnet
    expect(hdAfter.Signer.isTestnet).toBe(true); // Still testnet
    // Both Syscoin testnet and Bitcoin testnet have SLIP44 = 1, but URLs should be different
    const syscoinSignerAfter = (keyringManager as any).syscoinSigner;
    expect(syscoinSignerAfter.blockbookURL).toBe(bitcoinTestnet.url);
    expect(hdAfter.Signer.SLIP44).toBe(1); // Both Bitcoin testnet and Syscoin testnet use SLIP44 = 1

    // Test setActiveAccount with URL mismatch scenario
    (keyringManager as any).wallet.activeNetwork = syscoinTestnet;

    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    const hdFinal = (keyringManager as any).hd;
    expect(hdFinal.Signer.SLIP44).toBe(1); // Syscoin testnet also uses SLIP44 = 1
    const syscoinSignerFinal = (keyringManager as any).syscoinSigner;
    // Verify that switching back to Syscoin testnet updated the signer URL
    expect(syscoinSignerFinal.blockbookURL).toBe(syscoinTestnet.url);
  });

  it('should recreate HD signer when URL changes even with same chainId', async () => {
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

    const originalNetwork = initialWalletState.networks.syscoin[57];
    await keyringManager.setSignerNetwork(originalNetwork, 'syscoin');

    const syscoinSignerBefore = (keyringManager as any).syscoinSigner;
    expect(syscoinSignerBefore.blockbookURL).toBe(originalNetwork.url);

    // Create same chainId but different URL (custom RPC endpoint)
    const customSyscoinMainnet = {
      ...originalNetwork,
      url: 'https://custom-syscoin-rpc.example.com',
      label: 'Custom Syscoin Mainnet',
    };

    // Simulate network change to custom RPC
    (keyringManager as any).wallet.activeNetwork = customSyscoinMainnet;

    // setActiveAccount should detect URL mismatch and recreate signer
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);

    const syscoinSignerAfter = (keyringManager as any).syscoinSigner;
    expect(syscoinSignerAfter.blockbookURL).toBe(customSyscoinMainnet.url);
  });

  it('should not recreate HD signer when network is truly identical', async () => {
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

    const network = initialWalletState.networks.syscoin[57];
    await keyringManager.setSignerNetwork(network, 'syscoin');

    const hdBefore = (keyringManager as any).hd;
    const syscoinSignerBefore = (keyringManager as any).syscoinSigner;

    // Create another account
    await keyringManager.addNewAccount();

    // Switch between accounts - should NOT recreate since all parameters match
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);

    const hdAfter = (keyringManager as any).hd;
    const syscoinSignerAfter = (keyringManager as any).syscoinSigner;

    // Should be same instances since no network change occurred
    expect(hdAfter.Signer.isTestnet).toBe(hdBefore.Signer.isTestnet);
    expect(hdAfter.Signer.SLIP44).toBe(hdBefore.Signer.SLIP44);
    expect(syscoinSignerAfter.blockbookURL).toBe(
      syscoinSignerBefore.blockbookURL
    );
  });
});

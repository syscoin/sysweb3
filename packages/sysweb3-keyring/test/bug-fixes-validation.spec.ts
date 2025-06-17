import * as crypto from 'crypto';

import { KeyringManager, KeyringAccountType, initialWalletState } from '../src';
import { FAKE_PASSWORD } from './constants';
import { INetworkType } from '@pollum-io/sysweb3-network';

// Mock ethers inline
jest.mock('ethers', () => {
  const actualEthers = jest.requireActual('ethers');

  const mockWallet = jest.fn().mockImplementation((privateKey) => ({
    privateKey: privateKey,
    address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
  }));

  (mockWallet as any).fromMnemonic = jest.fn((mnemonic) => ({
    privateKey:
      '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    mnemonic: {
      phrase: mnemonic,
    },
  }));

  return {
    ethers: {
      ...actualEthers,
      utils: {
        ...actualEthers.utils,
        isHexString: jest.fn((value) => {
          return (
            typeof value === 'string' &&
            /^0x[0-9a-fA-F]+$/.test(value) &&
            value.length === 66
          );
        }),
        isAddress: jest.fn((value) => {
          return (
            typeof value === 'string' &&
            /^0x[0-9a-fA-F]+$/.test(value) &&
            value.length === 42
          );
        }),
      },
      Wallet: mockWallet,
    },
  };
});

// Mock only network calls, keep real crypto implementation
jest.mock('syscoinjs-lib', () => {
  const actual = jest.requireActual('syscoinjs-lib');

  return {
    ...actual,
    utils: {
      ...actual.utils,
      // Mock only network-dependent calls
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 100000000,
        tokens: [],
      }),
      fetchBackendUTXOS: jest.fn().mockResolvedValue([]),
      sanitizeBlockbookUTXOs: jest.fn().mockReturnValue([]),
      fetchEstimateFee: jest.fn().mockResolvedValue(0.001024), // 0.001024 SYS/kB = 0.000001 SYS/byte
      // Keep real HDSigner implementation
    },
    SyscoinJSLib: jest.fn().mockImplementation(() => ({
      blockbookURL: 'https://blockbook.syscoin.org/',
    })),
  };
});

// Mock storage module - return properly encrypted mnemonic that can be decrypted with real crypto-js
jest.mock('../src/storage', () => ({
  getDecryptedVault: jest.fn().mockResolvedValue({
    mnemonic:
      'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA==',
  }),
  setEncryptedVault: jest.fn().mockResolvedValue(undefined),
}));

// Use real bip39 - it's deterministic

// Mock providers
jest.mock('../src/providers', () => ({
  CustomJsonRpcProvider: jest.fn().mockImplementation(() => ({
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1, name: 'homestead' }),
  })),
}));

// Mock transactions
jest.mock('../src/transactions', () => ({
  SyscoinTransactions: jest.fn().mockImplementation(() => ({})),
  EthereumTransactions: jest.fn().mockImplementation(() => ({
    setWeb3Provider: jest.fn(),
    getBalance: jest.fn().mockResolvedValue(0),
  })),
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

describe('Bug Fixes Validation', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
    mockStorage.set('vault-keys', {
      hash: 'mock-hash',
      salt: 'mock-salt',
      currentSessionSalt: 'mock-salt',
    });
    mockStorage.set('utf8Error', { hasUtf8Error: false });
  });

  describe('Fix #1: Account Index Synchronization (line 1157)', () => {
    it('should set account index when creating account through addUTXOAccount', async () => {
      const seed =
        'test test test test test test test test test test test junk';

      // Initialize Syscoin wallet
      keyringManager = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.syscoin[5700],
        },
        activeChain: INetworkType.Syscoin,
      });

      keyringManager.setSeed(seed);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);

      // Set up session variables to match what real unlock would create
      const sessionSalt = 'mock-salt';
      const sessionPassword = crypto
        .createHmac('sha512', sessionSalt)
        .update(FAKE_PASSWORD)
        .digest('hex');

      (keyringManager as any).sessionSeed = 'encrypted-seed';
      (keyringManager as any).sessionPassword = sessionPassword;
      (keyringManager as any).currentSessionSalt = sessionSalt;

      await keyringManager.createKeyringVault();

      // Get the HD signer
      const hd = (keyringManager as any).hd;
      expect(hd).toBeDefined();
      expect(hd.Signer.accountIndex).toBe(0);

      // Add new accounts
      await keyringManager.addNewAccount();
      expect(hd.Signer.accountIndex).toBe(1);

      await keyringManager.addNewAccount();
      expect(hd.Signer.accountIndex).toBe(2);

      // Switch between accounts
      await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
      expect(hd.Signer.accountIndex).toBe(0);

      await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
      expect(hd.Signer.accountIndex).toBe(2);

      await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
      expect(hd.Signer.accountIndex).toBe(1);
    });
  });

  describe('Fix #2: Network-aware HD Signer Creation (line 1075)', () => {
    it('should create HD signer with correct testnet flag for mainnet', async () => {
      const seed =
        'test test test test test test test test test test test junk';

      // Initialize with mainnet
      keyringManager = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.syscoin[57], // Mainnet
        },
        activeChain: INetworkType.Syscoin,
      });

      keyringManager.setSeed(seed);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);

      // Set up session variables to match what real unlock would create
      const sessionSalt = 'mock-salt';
      const sessionPassword = crypto
        .createHmac('sha512', sessionSalt)
        .update(FAKE_PASSWORD)
        .digest('hex');

      (keyringManager as any).sessionSeed = 'encrypted-seed';
      (keyringManager as any).sessionPassword = sessionPassword;
      (keyringManager as any).currentSessionSalt = sessionSalt;

      await keyringManager.createKeyringVault();

      const hd = (keyringManager as any).hd;
      expect(hd).toBeDefined();
      expect(hd.Signer.networks.mainnet).toBeDefined();
    });

    it('should create HD signer with correct testnet flag for testnet', async () => {
      const seed =
        'test test test test test test test test test test test junk';

      // Initialize with testnet
      keyringManager = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.syscoin[5700], // Testnet
        },
        activeChain: INetworkType.Syscoin,
      });

      keyringManager.setSeed(seed);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);

      // Set up session variables to match what real unlock would create
      const sessionSalt = 'mock-salt';
      const sessionPassword = crypto
        .createHmac('sha512', sessionSalt)
        .update(FAKE_PASSWORD)
        .digest('hex');

      (keyringManager as any).sessionSeed = 'encrypted-seed';
      (keyringManager as any).sessionPassword = sessionPassword;
      (keyringManager as any).currentSessionSalt = sessionSalt;

      await keyringManager.createKeyringVault();

      const hd = (keyringManager as any).hd;
      expect(hd).toBeDefined();
      expect(hd.Signer.networks.testnet).toBeDefined();
    });
  });

  describe('Fix #3: Import Account Validation', () => {
    it('should reject zprv import in importWeb3Account with helpful error', async () => {
      keyringManager = new KeyringManager();

      const zprvKey =
        'zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5';

      expect(() => {
        keyringManager.importWeb3Account(zprvKey);
      }).toThrow(
        'Syscoin extended private keys (zprv/tprv) should be imported using importAccount, not importWeb3Account'
      );
    });

    it('should reject tprv import in importWeb3Account', async () => {
      keyringManager = new KeyringManager();

      const tprvKey =
        'tprv8ZgxMBicQKsPeDgjzdC36fs6bMjGApWDNLR9erAXMs5skhMv36j9MV5ecvfavji5khqjWaWSFhN3YcCUUdiKH6isR4Pwy3U5y5egddBr16m';

      expect(() => {
        keyringManager.importWeb3Account(tprvKey);
      }).toThrow(
        'Syscoin extended private keys (zprv/tprv) should be imported using importAccount, not importWeb3Account'
      );
    });

    it('should accept valid Ethereum private key in importWeb3Account', async () => {
      keyringManager = new KeyringManager();

      const ethPrivateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

      const account = keyringManager.importWeb3Account(ethPrivateKey);
      expect(account).toBeDefined();
      expect(account.privateKey).toBe(ethPrivateKey);
    });

    it('should accept valid mnemonic in importWeb3Account', async () => {
      keyringManager = new KeyringManager();

      const mnemonic =
        'test test test test test test test test test test test junk';

      const account = keyringManager.importWeb3Account(mnemonic);
      expect(account).toBeDefined();
      expect(account.mnemonic.phrase).toBe(mnemonic);
    });
  });

  describe('Fix #4: Network/Chain Type Validation', () => {
    it('should reject Ethereum chain type with Syscoin network', async () => {
      keyringManager = new KeyringManager();
      keyringManager.setSeed(
        'test test test test test test test test test test test junk'
      );
      await keyringManager.setWalletPassword(FAKE_PASSWORD);

      // Set up session variables to match what real unlock would create
      const sessionSalt = 'mock-salt';
      const sessionPassword = crypto
        .createHmac('sha512', sessionSalt)
        .update(FAKE_PASSWORD)
        .digest('hex');

      (keyringManager as any).sessionSeed = 'encrypted-seed';
      (keyringManager as any).sessionPassword = sessionPassword;
      (keyringManager as any).currentSessionSalt = sessionSalt;

      await keyringManager.createKeyringVault();

      const syscoinNetwork = initialWalletState.networks.syscoin[5700];

      await expect(
        keyringManager.setSignerNetwork(syscoinNetwork)
      ).rejects.toThrow(
        'Cannot switch between different UTXO networks within the same keyring. Current network uses slip44=57, target network uses slip44=1. Each UTXO network requires a separate KeyringManager instance.'
      );
    });

    it('should reject Syscoin chain type with Ethereum network', async () => {
      keyringManager = new KeyringManager();
      keyringManager.setSeed(
        'test test test test test test test test test test test junk'
      );
      await keyringManager.setWalletPassword(FAKE_PASSWORD);

      // Set up session variables to match what real unlock would create
      const sessionSalt = 'mock-salt';
      const sessionPassword = crypto
        .createHmac('sha512', sessionSalt)
        .update(FAKE_PASSWORD)
        .digest('hex');

      (keyringManager as any).sessionSeed = 'encrypted-seed';
      (keyringManager as any).sessionPassword = sessionPassword;
      (keyringManager as any).currentSessionSalt = sessionSalt;

      await keyringManager.createKeyringVault();

      const ethereumNetwork = initialWalletState.networks.ethereum[1];

      await expect(
        keyringManager.setSignerNetwork(ethereumNetwork)
      ).rejects.toThrow('Cannot use Ethereum chain type with Syscoin network');
    });

    it('should accept matching network and chain types', async () => {
      const seed =
        'test test test test test test test test test test test junk';

      // Test 1: Syscoin network with syscoin chain type
      const syscoinKeyring = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.syscoin[5700],
        },
        activeChain: INetworkType.Syscoin,
      });

      syscoinKeyring.setSeed(seed);
      await syscoinKeyring.setWalletPassword(FAKE_PASSWORD);

      // Set up session variables to match what real unlock would create
      const sessionSalt = 'mock-salt';
      const sessionPassword = crypto
        .createHmac('sha512', sessionSalt)
        .update(FAKE_PASSWORD)
        .digest('hex');

      (syscoinKeyring as any).sessionSeed = 'encrypted-seed';
      (syscoinKeyring as any).sessionPassword = sessionPassword;
      (syscoinKeyring as any).currentSessionSalt = sessionSalt;

      await syscoinKeyring.createKeyringVault();

      const syscoinNetwork = initialWalletState.networks.syscoin[5700];
      const result1 = await syscoinKeyring.setSignerNetwork(syscoinNetwork);
      expect(result1.success).toBe(true);

      // Test 2: Ethereum network with ethereum chain type (separate keyring instance)
      const ethereumKeyring = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.ethereum[1],
        },
        activeChain: INetworkType.Ethereum,
      });

      ethereumKeyring.setSeed(seed);
      await ethereumKeyring.setWalletPassword(FAKE_PASSWORD);

      (ethereumKeyring as any).sessionSeed = 'encrypted-seed';
      (ethereumKeyring as any).sessionPassword = sessionPassword;
      (ethereumKeyring as any).currentSessionSalt = sessionSalt;

      await ethereumKeyring.createKeyringVault();

      const ethereumNetwork = initialWalletState.networks.ethereum[1];
      const result2 = await ethereumKeyring.setSignerNetwork(ethereumNetwork);
      expect(result2.success).toBe(true);
    });
  });
});

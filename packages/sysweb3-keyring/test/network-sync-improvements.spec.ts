import { KeyringManager, KeyringAccountType } from '../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from './constants';
import { INetworkType } from '@pollum-io/sysweb3-network';

// Mock storage
const globalMockStorage = new Map();
const globalMockStorageClient = {
  get: jest.fn((key: string) => {
    const value = globalMockStorage.get(key);
    return Promise.resolve(value);
  }),
  set: jest.fn((key: string, value: any) => {
    globalMockStorage.set(key, value);
    return Promise.resolve();
  }),
  clear: jest.fn(() => {
    globalMockStorage.clear();
  }),
  setClient: jest.fn(),
};

// Mock sysweb3-core
jest.mock('@pollum-io/sysweb3-core', () => ({
  sysweb3Di: {
    getStateStorageDb: jest.fn(() => globalMockStorageClient),
  },
}));

// Mock syscoinjs-lib
jest.mock('syscoinjs-lib', () => {
  const actual = jest.requireActual('syscoinjs-lib');
  return {
    ...actual,
    utils: {
      ...actual.utils,
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 100000000,
        tokens: [{ path: "m/84'/57'/0'/0/0", transfers: 1 }],
      }),
      fetchBackendUTXOS: jest.fn().mockResolvedValue([]),
      sanitizeBlockbookUTXOs: jest.fn().mockReturnValue([]),
      fetchEstimateFee: jest.fn().mockResolvedValue(0.001024),
    },
    createTransaction: jest.fn(() => ({
      txid: '0x123',
      hex: '0x456',
      psbt: {
        toBase64: jest.fn(() => 'mock-psbt-base64'),
      },
      assets: new Map(),
    })),
    SyscoinJSLib: jest.fn().mockImplementation(() => ({
      blockbookURL: 'https://blockbook.syscoin.org/',
      createTransaction: jest.fn().mockResolvedValue({
        txid: '0x123',
        hex: '0x456',
        psbt: {
          toBase64: jest.fn(() => 'mock-psbt-base64'),
        },
        assets: new Map(),
      }),
      createPSBTFromRes: jest.fn().mockResolvedValue('mock-psbt'),
      signAndSend: jest.fn().mockResolvedValue('mock-signed-psbt'),
    })),
  };
});

// Mock storage module
jest.mock('../src/storage', () => ({
  getDecryptedVault: jest.fn().mockImplementation(async () => ({
    mnemonic:
      'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA==',
  })),
  decryptAES: jest.fn().mockImplementation((cipherText) => {
    if (
      cipherText ===
      'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA=='
    ) {
      return PEACE_SEED_PHRASE;
    }
    return cipherText;
  }),
  encryptAES: jest.fn().mockImplementation((text) => {
    return 'encrypted-' + text;
  }),
  setEncryptedVault: jest.fn().mockResolvedValue(undefined),
}));

// Mock RPC validation
jest.mock('@pollum-io/sysweb3-network', () => {
  const actual = jest.requireActual('@pollum-io/sysweb3-network');
  return {
    ...actual,
    validateSysRpc: jest.fn().mockResolvedValue({ status: 200 }),
    validateEthRpc: jest.fn().mockResolvedValue({ status: 200 }),
    clearRpcCaches: jest.fn().mockImplementation(() => {
      console.log('[RPC] Cleared all RPC caches');
    }),
  };
});

// Mock providers
jest.mock('../src/providers', () => ({
  CustomJsonRpcProvider: jest.fn().mockImplementation((_signal, url) => ({
    getNetwork: jest.fn().mockResolvedValue({
      chainId:
        url.includes('mainnet.infura.io') || url.includes('alchemyapi.io')
          ? 1
          : url.includes('blockbook')
          ? 57
          : 1,
    }),
  })),
}));

describe('Network Synchronization with Multi-Keyring Architecture', () => {
  let keyringManager: KeyringManager;

  beforeEach(async () => {
    globalMockStorage.clear();
    jest.clearAllMocks();

    keyringManager = new KeyringManager();
  });

  afterEach(() => {
    keyringManager = null as any;
  });

  describe('Network Management', () => {
    it('should validate network type requirements', async () => {
      // Setup keyring
      keyringManager.setSeed(PEACE_SEED_PHRASE);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      const syscoinNetwork = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
        kind: INetworkType.Syscoin,
      };

      // Should work with proper UTXO network
      const result = await keyringManager.setSignerNetwork(syscoinNetwork);
      expect(result.success).toBe(true);
    });

    it('should only allow EVM custom networks', async () => {
      // Setup keyring
      keyringManager.setSeed(PEACE_SEED_PHRASE);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      const customUTXONetwork = {
        chainId: 123,
        url: 'https://custom-utxo.com/',
        label: 'Custom UTXO',
        currency: 'CUSTOM',
        slip44: 123,
        kind: INetworkType.Syscoin,
      };

      // Should prevent adding custom UTXO networks
      expect(() => {
        keyringManager.addCustomNetwork(customUTXONetwork);
      }).toThrow(
        'Custom networks can only be added for EVM. UTXO networks require separate keyring instances.'
      );
    });
  });

  describe('Account Operations', () => {
    it('should handle account creation correctly', async () => {
      // Setup UTXO keyring
      keyringManager.setSeed(PEACE_SEED_PHRASE);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      const syscoinNetwork = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
        kind: INetworkType.Syscoin,
      };

      await keyringManager.setSignerNetwork(syscoinNetwork);

      // Create new account
      const newAccount = await keyringManager.addNewAccount('Test Account');
      expect(newAccount).toBeDefined();
      expect(newAccount.label).toBe('Test Account');
      expect(newAccount.address).toMatch(/^(bc1|tb1|sys1|tsys1)/);
    });

    it('should handle account switching correctly', async () => {
      // Setup UTXO keyring
      keyringManager.setSeed(PEACE_SEED_PHRASE);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      const syscoinNetwork = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
        kind: INetworkType.Syscoin,
      };

      await keyringManager.setSignerNetwork(syscoinNetwork);

      // Create additional account
      await keyringManager.addNewAccount();

      // Switch to account 1
      await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
      const activeAccount = keyringManager.getActiveAccount();
      expect(activeAccount.activeAccount.id).toBe(1);
    });
  });

  describe('Validation and Error Handling', () => {
    it('should validate extended private keys correctly', async () => {
      // Setup keyring
      keyringManager.setSeed(PEACE_SEED_PHRASE);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      const syscoinNetwork = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
        kind: INetworkType.Syscoin,
      };

      // Test valid key format
      const validKey =
        'zprvAdJ5mPutamoCbmounzFidqfJUi2wywJSfevREt3CzbyVCHZDavEXVXY3GnMKB3ppQDMKXTikdQVV8bWR6qHvHM1F5kiPnYRZfYCesvN634X';
      const validation = keyringManager.validateZprv(validKey, syscoinNetwork);
      expect(validation.isValid).toBe(true);

      // Test invalid key format
      const invalidKey = 'invalid-key-format';
      const invalidValidation = keyringManager.validateZprv(
        invalidKey,
        syscoinNetwork
      );
      expect(invalidValidation.isValid).toBe(false);
    });

    it('should handle network requirements correctly', async () => {
      // Test that multi-keyring architecture constraints are enforced
      const syscoinNetwork = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
        kind: INetworkType.Syscoin,
      };

      const ethNetwork = {
        chainId: 1,
        url: 'https://eth-mainnet.alchemyapi.io/v2/test',
        label: 'Ethereum Mainnet',
        currency: 'ETH',
        slip44: 60,
        kind: INetworkType.Ethereum,
      };

      // Setup with Syscoin network
      keyringManager.setSeed(PEACE_SEED_PHRASE);
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();
      await keyringManager.setSignerNetwork(syscoinNetwork);

      // Try to switch to Ethereum network (different slip44) - should be prevented by multi-keyring architecture
      await expect(keyringManager.setSignerNetwork(ethNetwork)).rejects.toThrow(
        'Cannot use Ethereum chain type with Syscoin network'
      );
    });
  });
});

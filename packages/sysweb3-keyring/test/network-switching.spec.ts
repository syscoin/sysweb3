import {
  KeyringManager,
  KeyringAccountType,
  IKeyringAccountState,
  initialWalletState,
} from '../src';
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

describe('Network Switching with Multi-Keyring Architecture', () => {
  let evmKeyring: KeyringManager;
  let utxoKeyring: KeyringManager;

  beforeEach(async () => {
    globalMockStorage.clear();
    jest.clearAllMocks();

    // Create separate keyring instances for different network types
    evmKeyring = new KeyringManager();
    utxoKeyring = new KeyringManager();
  });

  afterEach(() => {
    evmKeyring = null as any;
    utxoKeyring = null as any;
  });

  describe('EVM Network Switching (Valid Operations)', () => {
    it('should switch between EVM networks correctly', async () => {
      // Start with Ethereum mainnet
      const ethMainnet = {
        chainId: 1,
        url: 'https://eth-mainnet.alchemyapi.io/v2/test',
        label: 'Ethereum Mainnet',
        currency: 'ETH',
        slip44: 60,
      };

      // Setup EVM keyring properly with Ethereum network
      evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethMainnet,
        },
        INetworkType.Ethereum
      );

      // Create multiple accounts
      await evmKeyring.addNewAccount();
      await evmKeyring.addNewAccount();

      const evmAccounts =
        evmKeyring.wallet.accounts[KeyringAccountType.HDAccount];
      expect(Object.keys(evmAccounts).length).toBe(3); // 0, 1, 2

      // All should be EVM addresses
      Object.values(evmAccounts).forEach((acc: IKeyringAccountState) => {
        expect(acc.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(acc.xpub).toMatch(/^0x[a-fA-F0-9]+$/);
      });

      // Switch to Polygon (also EVM, slip44=60)
      const polygon = {
        chainId: 137,
        url: 'https://polygon-rpc.com',
        label: 'Polygon',
        currency: 'MATIC',
        slip44: 60, // Same slip44 as Ethereum
      };
      await evmKeyring.setSignerNetwork(polygon, INetworkType.Ethereum);

      // Accounts should remain the same (same addresses/xpubs)
      const evmAccountsAfter =
        evmKeyring.wallet.accounts[KeyringAccountType.HDAccount];
      expect(Object.keys(evmAccountsAfter).length).toBe(3);

      Object.values(evmAccountsAfter).forEach(
        (acc: IKeyringAccountState, index) => {
          const originalAcc = Object.values(evmAccounts)[index];
          expect(acc.address).toBe(originalAcc.address);
          expect(acc.xpub).toBe(originalAcc.xpub);
          expect(acc.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      );
    });

    it('should handle imported EVM accounts correctly', async () => {
      const ethMainnet = {
        chainId: 1,
        url: 'https://eth-mainnet.alchemyapi.io/v2/test',
        label: 'Ethereum Mainnet',
        currency: 'ETH',
        slip44: 60,
      };

      // Setup EVM keyring properly with Ethereum network
      evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethMainnet,
        },
        INetworkType.Ethereum
      );

      // Import EVM account
      const ethPrivateKey =
        '0x4e806a5d2a51aabe60df0df5f5117613fbe24a284c49a4b0ee9f26ddeb4b871b';
      const importedAccount = await evmKeyring.importAccount(
        ethPrivateKey,
        'Imported EVM'
      );

      expect(importedAccount.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(importedAccount.xpub).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(importedAccount.isImported).toBe(true);

      // Switch to different EVM network
      const bsc = {
        chainId: 56,
        url: 'https://bsc-dataseed.binance.org',
        label: 'BSC',
        currency: 'BNB',
        slip44: 60,
      };
      await evmKeyring.setSignerNetwork(bsc, INetworkType.Ethereum);

      // Imported account should remain unchanged
      const importedAfter = evmKeyring.getAccountById(
        importedAccount.id,
        KeyringAccountType.Imported
      );
      expect(importedAfter.address).toBe(importedAccount.address);
      expect(importedAfter.xpub).toBe(importedAccount.xpub);
    });
  });

  describe('UTXO Network Operations (Valid Within Network)', () => {
    it('should create and manage UTXO accounts correctly', async () => {
      // Setup UTXO keyring for Syscoin
      utxoKeyring.setSeed(PEACE_SEED_PHRASE);
      await utxoKeyring.setWalletPassword(FAKE_PASSWORD);
      await utxoKeyring.createKeyringVault();

      const syscoinMainnet = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
      };
      await utxoKeyring.setSignerNetwork(syscoinMainnet, INetworkType.Syscoin);

      // Create multiple accounts
      await utxoKeyring.addNewAccount();
      await utxoKeyring.addNewAccount();

      const utxoAccounts =
        utxoKeyring.wallet.accounts[KeyringAccountType.HDAccount];
      expect(Object.keys(utxoAccounts).length).toBe(3); // 0, 1, 2

      // All should be UTXO addresses
      Object.values(utxoAccounts).forEach((acc: IKeyringAccountState) => {
        expect(acc.address).toMatch(/^(bc1|tb1|sys1|tsys1)/);
        expect(acc.xpub).toMatch(/^(xpub|ypub|zpub|tpub|upub|vpub)/);
        expect(acc.xpub).not.toMatch(/^0x/);
      });
    });

    it('should handle imported UTXO accounts correctly', async () => {
      // Setup UTXO keyring
      utxoKeyring.setSeed(PEACE_SEED_PHRASE);
      await utxoKeyring.setWalletPassword(FAKE_PASSWORD);
      await utxoKeyring.createKeyringVault();

      const syscoinMainnet = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
      };
      await utxoKeyring.setSignerNetwork(syscoinMainnet, INetworkType.Syscoin);

      // Import UTXO account
      const zprvKey =
        'zprvAdDkmgEFWyn5ZGbToHDxiVGuBxtXwY13FDFek6tvUdMFxGvwYsUtTXtqQ8Br1SgiRqaNpDnhSgYTKDk5rc5mq9oD3RpMVYvgk9FE3dAYHcG';
      const importedAccount = await utxoKeyring.importAccount(
        zprvKey,
        'Imported UTXO'
      );

      expect(importedAccount.address).toMatch(/^(bc1|tb1|sys1|tsys1)/);
      expect(importedAccount.xpub).toMatch(/^(xpub|ypub|zpub|tpub|upub|vpub)/);
      expect(importedAccount.xpub).not.toMatch(/^0x/);
      expect(importedAccount.isImported).toBe(true);
    });

    it('should validate zprv keys correctly', async () => {
      // Setup UTXO keyring
      utxoKeyring.setSeed(PEACE_SEED_PHRASE);
      await utxoKeyring.setWalletPassword(FAKE_PASSWORD);
      await utxoKeyring.createKeyringVault();

      const syscoinMainnet = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
      };

      // Test valid mainnet key
      const mainnetKey =
        'zprvAdJ5mPutamoCbmounzFidqfJUi2wywJSfevREt3CzbyVCHZDavEXVXY3GnMKB3ppQDMKXTikdQVV8bWR6qHvHM1F5kiPnYRZfYCesvN634X';
      const mainnetValidation = utxoKeyring.validateZprv(
        mainnetKey,
        syscoinMainnet
      );
      expect(mainnetValidation.isValid).toBe(true);

      // Test invalid format
      const invalidKey = 'invalid-key-format';
      const invalidValidation = utxoKeyring.validateZprv(
        invalidKey,
        syscoinMainnet
      );
      expect(invalidValidation.isValid).toBe(false);
      expect(invalidValidation.message).toContain(
        'Not an extended private key'
      );
    });
  });

  describe('Multi-Keyring Architecture Constraints', () => {
    it('should prevent switching between different UTXO networks', async () => {
      // Setup UTXO keyring for Syscoin
      utxoKeyring.setSeed(PEACE_SEED_PHRASE);
      await utxoKeyring.setWalletPassword(FAKE_PASSWORD);
      await utxoKeyring.createKeyringVault();

      const syscoinMainnet = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
      };
      await utxoKeyring.setSignerNetwork(syscoinMainnet, INetworkType.Syscoin);

      // Try to switch to Bitcoin (different slip44)
      const bitcoinMainnet = {
        chainId: 0,
        url: 'https://blockbook.bitcoin.org/',
        label: 'Bitcoin Mainnet',
        currency: 'BTC',
        slip44: 0,
      };

      await expect(
        utxoKeyring.setSignerNetwork(bitcoinMainnet, INetworkType.Syscoin)
      ).rejects.toThrow(
        'Cannot switch between different UTXO networks within the same keyring'
      );
    });

    it('should prevent switching from EVM to UTXO', async () => {
      const ethMainnet = {
        chainId: 1,
        url: 'https://eth-mainnet.alchemyapi.io/v2/test',
        label: 'Ethereum Mainnet',
        currency: 'ETH',
        slip44: 60,
      };

      // Setup EVM keyring properly with Ethereum network
      evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethMainnet,
        },
        INetworkType.Ethereum
      );

      // Try to switch to Syscoin UTXO
      const syscoinMainnet = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
      };

      // Try to switch to Syscoin UTXO - should fail
      const result = await evmKeyring.setSignerNetwork(
        syscoinMainnet,
        INetworkType.Syscoin
      );
      expect(result.success).toBe(false);
    });

    it('should prevent switching from UTXO to EVM', async () => {
      // Setup UTXO keyring
      utxoKeyring.setSeed(PEACE_SEED_PHRASE);
      await utxoKeyring.setWalletPassword(FAKE_PASSWORD);
      await utxoKeyring.createKeyringVault();

      const syscoinMainnet = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
      };
      await utxoKeyring.setSignerNetwork(syscoinMainnet, INetworkType.Syscoin);

      // Try to switch to Ethereum
      const ethMainnet = {
        chainId: 1,
        url: 'https://eth-mainnet.alchemyapi.io/v2/test',
        label: 'Ethereum Mainnet',
        currency: 'ETH',
        slip44: 60,
      };

      await expect(
        utxoKeyring.setSignerNetwork(ethMainnet, INetworkType.Ethereum)
      ).rejects.toThrow(
        'Cannot switch between different UTXO networks within the same keyring'
      );
    });

    it('should prevent adding custom UTXO networks', async () => {
      // Setup any keyring
      evmKeyring.setSeed(PEACE_SEED_PHRASE);
      await evmKeyring.setWalletPassword(FAKE_PASSWORD);
      await evmKeyring.createKeyringVault();

      const customUTXONetwork = {
        chainId: 123,
        url: 'https://custom-utxo.com/',
        label: 'Custom UTXO',
        currency: 'CUSTOM',
        slip44: 123,
      };

      expect(() => {
        evmKeyring.addCustomNetwork(INetworkType.Syscoin, customUTXONetwork);
      }).toThrow(
        'Custom networks can only be added for EVM. UTXO networks require separate keyring instances.'
      );
    });

    it('should allow adding custom EVM networks', async () => {
      const ethMainnet = {
        chainId: 1,
        url: 'https://eth-mainnet.alchemyapi.io/v2/test',
        label: 'Ethereum Mainnet',
        currency: 'ETH',
        slip44: 60,
      };

      // Setup EVM keyring properly with Ethereum network
      evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethMainnet,
        },
        INetworkType.Ethereum
      );

      const customEVMNetwork = {
        chainId: 999,
        url: 'https://custom-evm.com/',
        label: 'Custom EVM',
        currency: 'CUSTOM',
        slip44: 60, // EVM networks use slip44=60
      };

      // Should not throw
      expect(() => {
        evmKeyring.addCustomNetwork(INetworkType.Ethereum, customEVMNetwork);
      }).not.toThrow();

      // Network should be added
      expect(evmKeyring.wallet.networks.ethereum[999]).toEqual(
        customEVMNetwork
      );
    });
  });

  describe('Account Management', () => {
    it('should preserve account IDs when switching between compatible EVM networks', async () => {
      const ethMainnet = {
        chainId: 1,
        url: 'https://eth-mainnet.alchemyapi.io/v2/test',
        label: 'Ethereum Mainnet',
        currency: 'ETH',
        slip44: 60,
      };

      // Setup EVM keyring properly with Ethereum network
      evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethMainnet,
        },
        INetworkType.Ethereum
      );

      // Create accounts
      await evmKeyring.addNewAccount();
      await evmKeyring.addNewAccount();

      const originalAccountIds = Object.keys(
        evmKeyring.wallet.accounts[KeyringAccountType.HDAccount]
      )
        .map((id) => parseInt(id))
        .sort();

      // Switch to different EVM network
      const polygon = {
        chainId: 137,
        url: 'https://polygon-rpc.com',
        label: 'Polygon',
        currency: 'MATIC',
        slip44: 60,
      };
      await evmKeyring.setSignerNetwork(polygon, INetworkType.Ethereum);

      const newAccountIds = Object.keys(
        evmKeyring.wallet.accounts[KeyringAccountType.HDAccount]
      )
        .map((id) => parseInt(id))
        .sort();

      expect(newAccountIds).toEqual(originalAccountIds);
    });

    it('should handle active account switching correctly', async () => {
      // Setup UTXO keyring
      utxoKeyring.setSeed(PEACE_SEED_PHRASE);
      await utxoKeyring.setWalletPassword(FAKE_PASSWORD);
      await utxoKeyring.createKeyringVault();

      const syscoinMainnet = {
        chainId: 57,
        url: 'https://blockbook.syscoin.org/',
        label: 'Syscoin Mainnet',
        currency: 'SYS',
        slip44: 57,
      };
      await utxoKeyring.setSignerNetwork(syscoinMainnet, INetworkType.Syscoin);

      // Create additional accounts
      await utxoKeyring.addNewAccount();
      await utxoKeyring.addNewAccount();

      // Switch to account 1
      await utxoKeyring.setActiveAccount(1, KeyringAccountType.HDAccount);
      let activeAccount = utxoKeyring.getActiveAccount();
      expect(activeAccount.activeAccount.id).toBe(1);

      // Switch to account 2
      await utxoKeyring.setActiveAccount(2, KeyringAccountType.HDAccount);
      activeAccount = utxoKeyring.getActiveAccount();
      expect(activeAccount.activeAccount.id).toBe(2);

      // Switch back to account 0
      await utxoKeyring.setActiveAccount(0, KeyringAccountType.HDAccount);
      activeAccount = utxoKeyring.getActiveAccount();
      expect(activeAccount.activeAccount.id).toBe(0);
    });
  });
});

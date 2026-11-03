// Test setup file
import { INetworkType } from '@sidhujag/sysweb3-network';
import { webcrypto } from 'crypto';
import CryptoJS from 'crypto-js';

import { KeyringAccountType, KeyringManager } from '../../src';
import { getDecryptedVault, setEncryptedVault } from '../../src/storage';

const getTestIters = (envKey: string, fallback: number) => {
  const parsed = Number.parseInt(process?.env?.[envKey] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Extend global type to include setupTestVault and mockVaultState utilities
declare global {
  function setupTestVault(password?: string): Promise<void>;
  function createMockVaultState(options?: {
    activeAccountId?: number;
    activeAccountType?: KeyringAccountType;
    networkType?: INetworkType;
    chainId?: number;
  }): any;
  const mockVaultState: any;
}

// Exercise the production WebCrypto path; fallback CBC is read-only.
global.crypto = webcrypto as any;

// Mock browser globals that Trezor expects
global.self = global as any;
(global as any).window = global;
(global as any).document = {
  createElement: () => ({}),
  body: {
    appendChild: () => {
      // Empty implementation for mock DOM element appendChild
    },
  },
};

// Mock ledgerService from @ledgerhq/hw-app-eth
jest.mock('@ledgerhq/hw-app-eth', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getAddress: jest.fn(),
    signTransaction: jest.fn(),
    signPersonalMessage: jest.fn(),
    signEIP712HashedMessage: jest.fn(),
  })),
  ledgerService: {
    resolveTransaction: jest.fn().mockResolvedValue({}),
  },
}));

// Mock environment variables if needed
process.env.SEED_PEACE_GLOBE =
  process.env.SEED_PEACE_GLOBE ||
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
process.env.PRIVATE_KEY_ACCOUNT =
  process.env.PRIVATE_KEY_ACCOUNT ||
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PRIVATE_KEY_ACCOUNT_ADDRESS =
  process.env.PRIVATE_KEY_ACCOUNT_ADDRESS ||
  '0x1234567890123456789012345678901234567890';
process.env.SEED_ACCOUNT_ADDRESS_AT_EVM =
  process.env.SEED_ACCOUNT_ADDRESS_AT_EVM ||
  '0x1234567890123456789012345678901234567890';
process.env.SEED_ACCOUNT_ADDRESS_AT_UTX0 =
  process.env.SEED_ACCOUNT_ADDRESS_AT_UTX0 ||
  'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4';
process.env.SEED_SWALLOW_HEALTH =
  process.env.SEED_SWALLOW_HEALTH ||
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';

// Mock the providers module
jest.mock('../../src/providers', () => ({
  CustomJsonRpcProvider: jest.fn().mockImplementation((_signal, _url) => {
    const { BigNumber } = jest.requireActual('../../src/ethers-v6');

    // Determine chainId based on URL
    let chainId = 57; // Default Syscoin mainnet
    let name = 'syscoin';

    if (_url) {
      if (_url.includes('rpc.ankr.com/eth') || _url.includes('mainnet')) {
        chainId = 1;
        name = 'mainnet';
      } else if (
        _url.includes('tanenbaum') ||
        _url.includes('test') ||
        _url.includes('5700')
      ) {
        chainId = 5700;
        name = 'syscoin-testnet';
      } else if (_url.includes('mumbai') || _url.includes('80001')) {
        chainId = 80001;
        name = 'mumbai';
      } else if (_url.includes('polygon') && !_url.includes('mumbai')) {
        chainId = 137;
        name = 'polygon';
      }
    }

    // Create signer first
    const signer = {
      getAddress: jest
        .fn()
        .mockResolvedValue('0x1234567890123456789012345678901234567890'),
      sendTransaction: jest.fn().mockResolvedValue({
        hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        wait: jest.fn().mockResolvedValue({ status: 1 }),
      }),
      connect: jest.fn().mockReturnThis(),
      provider: null as any, // Will be set below
    };

    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      getNetwork: jest.fn().mockResolvedValue({ chainId, name }),
      getBalance: jest
        .fn()
        .mockResolvedValue(BigNumber.from('1000000000000000000')),
      getCode: jest.fn().mockResolvedValue('0x'),
      estimateGas: jest.fn().mockResolvedValue(BigNumber.from('21000')),
      getGasPrice: jest.fn().mockResolvedValue(BigNumber.from('20000000000')),
      getTransactionCount: jest.fn().mockResolvedValue(0),
      sendTransaction: jest.fn().mockResolvedValue({
        hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        wait: jest.fn().mockResolvedValue({ status: 1 }),
      }),
      call: jest
        .fn()
        .mockResolvedValue(
          '0x0000000000000000000000000000000000000000000000000000000000000001'
        ),
      getBlock: jest.fn().mockResolvedValue({
        number: 12345,
        timestamp: Math.floor(Date.now() / 1000),
        baseFeePerGas: BigNumber.from('20000000000'),
        gasLimit: BigNumber.from('30000000'),
        gasUsed: BigNumber.from('21000'),
        transactions: [],
        hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
      }),
      send: jest.fn().mockImplementation((method: string) => {
        if (method === 'eth_maxPriorityFeePerGas') {
          return Promise.resolve('0x5f5e100'); // 1 gwei
        }
        return Promise.resolve('0x0');
      }),
      getTransaction: jest.fn().mockResolvedValue({
        hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
        nonce: 0,
        gasLimit: BigNumber.from('21000'),
        gasPrice: BigNumber.from('20000000000'),
        maxFeePerGas: BigNumber.from('40000000000'),
        maxPriorityFeePerGas: BigNumber.from('2000000000'),
        value: BigNumber.from('0'),
        chainId: 1,
        wait: jest.fn().mockResolvedValue({ status: 1 }),
      }),
      getSigner: jest.fn().mockReturnValue(signer),
      // Add missing methods that ethers.js expects
      resolveName: jest.fn().mockImplementation((nameOrAddress) => {
        // If it's already an address, return it; otherwise return null (no ENS resolution)
        if (
          nameOrAddress &&
          nameOrAddress.startsWith('0x') &&
          nameOrAddress.length === 42
        ) {
          return Promise.resolve(nameOrAddress);
        }
        return Promise.resolve(null);
      }),
      lookupAddress: jest.fn().mockResolvedValue(null),
      waitForTransaction: jest.fn().mockImplementation((hash) => {
        return Promise.resolve({
          hash,
          status: 1,
          confirmations: 1,
          blockNumber: 12345,
          blockHash:
            '0x1234567890123456789012345678901234567890123456789012345678901234',
          gasUsed: BigNumber.from('21000'),
        });
      }),
      getResolver: jest.fn().mockResolvedValue(null),
      getAvatar: jest.fn().mockResolvedValue(null),
      network: { chainId },
      _isProvider: true,
    };

    // Set circular reference
    signer.provider = provider;

    return provider;
  }),
}));

// Mock storage for sysweb3-core
const mockStorage = new Map();

// Match production DI: every lookup returns the same facade; records still reset per test.
jest.mock('@sidhujag/sysweb3-core', () => {
  const storage = {
    get: jest.fn(async (key: string) => {
      return mockStorage.get(key) || null;
    }),
    set: jest.fn((key: string, value: any) => {
      mockStorage.set(key, value);
      return Promise.resolve();
    }),
    setMany: jest.fn((items: Record<string, any>) => {
      Object.entries(items).forEach(([key, value]) =>
        mockStorage.set(key, value)
      );
      return Promise.resolve();
    }),
    createManyIfAbsent: jest.fn((items: Record<string, any>) => {
      // No await between the shared map's absence check and complete write.
      if (Object.keys(items).some((key) => mockStorage.get(key) != null))
        return Promise.resolve(false);
      Object.entries(items).forEach(([key, value]) =>
        mockStorage.set(key, value)
      );
      return Promise.resolve(true);
    }),
    deleteItem: jest.fn((key: string) => {
      mockStorage.delete(key);
      return Promise.resolve();
    }),
    clear: jest.fn(() => {
      mockStorage.clear();
      return Promise.resolve();
    }),
    setClient: jest.fn(),
  };
  return { sysweb3Di: { getStateStorageDb: () => storage } };
});

// Mock sysweb3-utils to support token operations
jest.mock('@sidhujag/sysweb3-utils', () => {
  const actualUtils = jest.requireActual('@sidhujag/sysweb3-utils');
  return {
    ...actualUtils,
    getAsset: jest.fn().mockResolvedValue({
      assetGuid: '123456789',
      symbol: 'TEST',
      decimals: 8,
      maxSupply: 1000000,
      totalSupply: 500000,
    }),
  };
});

// Mock syscoinjs utilities - only network calls, use real HDSigner for deterministic crypto
jest.mock('syscoinjs-lib', () => {
  const actualSyscoinjs = jest.requireActual('syscoinjs-lib');

  // Create a mock HDSigner class that extends the real one
  class MockHDSigner extends actualSyscoinjs.utils.HDSigner {
    // Override sign method to avoid real PSBT signing
    async sign(psbt) {
      // If psbt is a string (from mock), just return it
      if (typeof psbt === 'string') {
        return psbt;
      }

      // If it's a mock PSBT object, return a properly signed mock
      if (psbt && psbt.data && psbt.data.inputs) {
        // Mock the signing process
        return {
          ...psbt,
          signed: true,
          extractTransaction: jest.fn().mockReturnValue({
            getId: jest.fn().mockReturnValue('mock_txid'),
            toHex: jest.fn().mockReturnValue('mock_hex'),
          }),
          finalizeAllInputs: jest.fn(),
          validateSignaturesOfAllInputs: jest.fn().mockReturnValue(true),
        };
      }

      // Otherwise return the psbt as-is
      return psbt;
    }
  }

  return {
    ...actualSyscoinjs,
    utils: {
      ...actualSyscoinjs.utils,
      // Replace HDSigner with our mock version
      HDSigner: MockHDSigner,
      // Only mock network-dependent functions
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 100000000, // 1 SYS in satoshis
        tokens: [],
        address: 'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4',
      }),
      fetchEstimateFee: jest.fn().mockResolvedValue(10), // Return reasonable fee rate (10 satoshis per 1024 bytes)
      fetchBackendRawTx: jest.fn().mockResolvedValue('mockedRawTx'),
      fetchBackendUTXOS: jest.fn().mockResolvedValue([]),
      sanitizeBlockbookUTXOs: jest.fn().mockReturnValue([]),
      getMemoFromOpReturn: jest.fn(),
      createTransaction: jest.fn().mockResolvedValue({
        psbt: 'mocked_psbt',
        assets: [],
      }),
      syscoinNetworks: {
        mainnet: {},
        testnet: {},
      },
    },
    createPSBTFromRes: jest.fn().mockReturnValue({
      psbt: 'mocked_psbt',
      assets: [],
    }),
    signTransaction: jest.fn().mockResolvedValue('signed_tx'),
    sendTransaction: jest.fn().mockResolvedValue({ txid: 'mocked_txid' }),
    SyscoinJSLib: jest.fn().mockImplementation((hd, url) => ({
      blockbookURL: url || 'https://blockbook-dev.elint.services/',
      Signer: hd,
      createTransaction: jest.fn().mockResolvedValue({
        psbt: 'mocked_psbt_object',
        fee: 0.0001, // 0.0001 SYS fee
      }),
      decodeRawTransaction: jest.fn().mockReturnValue({
        txid: 'mocked_txid',
        version: 1,
        locktime: 0,
        vin: [],
        vout: [],
      }),
      assetAllocationSend: jest.fn().mockResolvedValue({
        psbt: 'mocked_spt_psbt',
        fee: 0.0001,
      }),
      send: jest.fn().mockResolvedValue({
        extractTransaction: jest.fn().mockReturnValue({
          getId: jest.fn().mockReturnValue('mock_transaction_id'),
        }),
      }),
    })),
  };
});

// Mock fetch to avoid network requests
global.fetch = jest.fn((url) => {
  if (url.includes('/api/v2') && !url.includes('xpub')) {
    // Determine coin name based on URL
    let coinName = 'Syscoin'; // Default to mainnet
    let chainType = 'main';

    // Check if it's a testnet URL
    if (
      url.includes('dev') ||
      url.includes('test') ||
      url.includes('tanenbaum')
    ) {
      coinName = 'Syscoin Testnet';
      chainType = 'test';
    }

    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          blockbook: { coin: coinName },
          backend: { chain: chainType },
        }),
    } as any);
  }
  if (url.includes('xpub') || url.includes('fetchBackendAccount')) {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          balance: 100000000,
          tokens: [],
          address: 'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4',
        }),
    } as any);
  }
  if (url.includes('fetchEstimateFee')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ result: 10000 }),
    } as any);
  }
  // Default Ethereum RPC response
  return Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        jsonrpc: '2.0',
        id: 1,
        result: '0x1',
      }),
  } as any);
}) as any;

// Clear storage before each test to ensure clean state
beforeEach(() => {
  mockStorage.clear();
});

// Also clear after each test to prevent cross-test pollution
afterEach(() => {
  mockStorage.clear();
});

// Helper function to set up a basic vault for tests
global.setupTestVault = async (password = 'Asdqwe123!') => {
  const { sysweb3Di } = jest.requireMock('@sidhujag/sysweb3-core');
  const storage = sysweb3Di.getStateStorageDb();

  // Match keyring-manager.ts defaults under NODE_ENV=test
  const encIters = getTestIters('SYSWEB3_PBKDF2_ENC_ITERS', 1_000);

  const deriveSessionKey = (pwd: string, saltHex: string) =>
    CryptoJS.PBKDF2(pwd, CryptoJS.enc.Hex.parse(saltHex), {
      keySize: 256 / 32,
      iterations: encIters,
      hasher: CryptoJS.algo.SHA512,
    }).toString();

  // Check if vault-keys already exist - if so, don't recreate them (idempotent)
  const existingVaultKeys = await storage.get('vault-keys');
  if (existingVaultKeys && existingVaultKeys.salt) {
    // Vault already set up, verify password by attempting decrypt with derived session key (v4)
    const sessionKey = deriveSessionKey(password, existingVaultKeys.salt);
    try {
      await getDecryptedVault(sessionKey);
      return;
    } catch {
      // Wrong password or stale vault -> recreate below
    }
  }

  // Create a vault with plain mnemonic (it will be encrypted by storage)
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  // Use CONSISTENT salts for testing (not random) to prevent password validation mismatches
  const salt = '0123456789abcdef0123456789abcdef'; // 16-byte hex salt
  const sessionKey = deriveSessionKey(password, salt);

  // Vault should contain plain mnemonic - the storage layer handles encryption (v4 uses derived session key)
  await setEncryptedVault({ mnemonic }, sessionKey);

  await storage.set('vault-keys', { salt });
};

// Create mock vault state utility function
global.createMockVaultState = (
  options: {
    activeAccountId?: number;
    activeAccountType?: KeyringAccountType;
    networkType?: INetworkType;
    chainId?: number;
  } = {}
): any => {
  const {
    activeAccountId = 0,
    activeAccountType = KeyringAccountType.HDAccount,
    networkType = INetworkType.Syscoin,
    chainId,
  } = options;

  // Derive real addresses from the test seed phrase for consistency
  const testSeedPhrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const testPassword = 'Asdqwe123!'; // Must match FAKE_PASSWORD from constants

  let address, xpub, xprv;
  if (networkType === INetworkType.Ethereum) {
    // Derive real EVM address from test seed
    const { deriveEvmAccountFromMnemonic } = jest.requireActual(
      '../../src/transactions/evm-local-signer'
    );
    const { getAddressDerivationPath } = jest.requireActual(
      '../../src/utils/derivation-paths'
    );

    const ethDerivationPath = getAddressDerivationPath(
      'eth',
      60,
      0,
      false,
      activeAccountId
    );
    const derivedAccount = deriveEvmAccountFromMnemonic(
      testSeedPhrase,
      ethDerivationPath
    );

    address = derivedAccount.address;
    xpub = derivedAccount.publicKey;

    // Encrypt the private key like the real vault does
    const salt = '0123456789abcdef0123456789abcdef';
    const sessionPassword = CryptoJS.PBKDF2(
      testPassword,
      CryptoJS.enc.Hex.parse(salt),
      {
        keySize: 256 / 32,
        iterations: getTestIters('SYSWEB3_PBKDF2_ENC_ITERS', 1_000),
        hasher: CryptoJS.algo.SHA512,
      }
    ).toString();
    xprv = CryptoJS.AES.encrypt(
      derivedAccount.privateKey,
      sessionPassword
    ).toString();
  } else {
    // For UTXO, use syscoinjs to derive real xpub and address from test seed
    const { getSyscoinSigners } = jest.requireActual('../../src/signers');
    const { getNetworkConfig } = jest.requireActual(
      '@sidhujag/sysweb3-network'
    );
    // CryptoJS is already imported at top

    try {
      // Determine slip44 and coin name based on chainId
      const slip44 = chainId === 57 ? 57 : 1; // mainnet = 57, testnet = 1
      const currency = chainId === 57 ? 'SYS' : 'TSYS';
      const coinName = chainId === 57 ? 'Syscoin' : 'Syscoin Testnet'; // Use full coin names from coins.ts

      // Get network config for proper syscoin parameters
      const networkConfig = getNetworkConfig(slip44, coinName);

      // Create mock RPC config for syscoinjs
      const mockRpc = {
        formattedNetwork: {
          url:
            chainId === 57
              ? 'https://blockbook.elint.services/'
              : 'https://blockbook-dev.elint.services/',
          slip44,
          currency,
          chainId,
        },
        networkConfig,
      };

      // Use syscoinjs to create HD signer with proper network parameters
      const { hd } = getSyscoinSigners({
        mnemonic: testSeedPhrase,
        rpc: mockRpc,
      });

      // Create account at the specified index (synchronous)
      hd.createAccount(84);
      hd.setAccountIndex(activeAccountId);

      // Get the real xpub and address from syscoinjs
      xpub = hd.getAccountXpub();
      address = hd.createAddress(0, false, 84); // receiving address at index 0
    } catch (error) {
      // Fallback to known working addresses if syscoinjs derivation fails
      console.warn(
        'Syscoinjs derivation failed, using fallback addresses:',
        error.message
      );
      if (chainId === 57) {
        // Use a known mainnet address format
        address = 'sys1q4kk5wqjwdzxh6zt7hpfj3zwrhv5v5v5ht8fqv8';
        xpub =
          'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wgmUn9Q5Vgg2KHJD5YQJpFHxhtQQh3yJiRMLrYjfF5VGN1yPYxkQWxgd6YWBvYcB';
      } else {
        // Use a known testnet address format
        address = 'tsys1qhkd3x4r8p5w2e5n9v3h8j2m4b6c9z7f5g3h2k7';
        xpub =
          'tpubDDJC8T2bGJkQs6Qu7xRELGF9KNKpfF8nTy6tGNT7BudJw32VhJ7HkF7yGG7LfQ6SFGgM4V4MYWGCE7h4K7JbE7QGJFSD9P5a6f1vNMrDbqZ';
      }
    }

    // Encrypt a mock private key
    const salt = '0123456789abcdef0123456789abcdef';
    const sessionPassword = CryptoJS.PBKDF2(
      testPassword,
      CryptoJS.enc.Hex.parse(salt),
      {
        keySize: 256 / 32,
        iterations: getTestIters('SYSWEB3_PBKDF2_ENC_ITERS', 1_000),
        hasher: CryptoJS.algo.SHA512,
      }
    ).toString();
    const mockPrivateKey =
      'L1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    xprv = CryptoJS.AES.encrypt(mockPrivateKey, sessionPassword).toString();
  }

  // Create mock networks structure
  const networks = {
    syscoin: {
      57: {
        chainId: 57,
        currency: 'SYS',
        label: 'Syscoin Mainnet',
        url: 'https://blockbook.elint.services/',
        kind: INetworkType.Syscoin,
        explorer: 'https://explorer.syscoin.org/',
        slip44: 57,
      },
      5700: {
        chainId: 5700,
        currency: 'TSYS',
        label: 'Syscoin Testnet',
        url: 'https://blockbook-dev.elint.services/',
        kind: INetworkType.Syscoin,
        explorer: 'https://explorer-testnet.syscoin.org/',
        slip44: 1,
      },
    },
    ethereum: {
      1: {
        chainId: 1,
        currency: 'ETH',
        label: 'Ethereum Mainnet',
        url: 'https://rpc.ankr.com/eth',
        kind: INetworkType.Ethereum,
        explorer: 'https://etherscan.io/',
        slip44: 60,
      },
      57: {
        chainId: 57,
        currency: 'SYS',
        label: 'Syscoin NEVM',
        url: 'https://rpc.syscoin.org',
        kind: INetworkType.Ethereum,
        explorer: 'https://explorer.syscoin.org/',
        slip44: 60,
      },
      5700: {
        chainId: 5700,
        currency: 'TSYS',
        label: 'Syscoin NEVM Testnet',
        url: 'https://rpc.tanenbaum.io',
        kind: INetworkType.Ethereum,
        explorer: 'https://explorer.tanenbaum.io/',
        slip44: 60,
      },
      137: {
        chainId: 137,
        currency: 'MATIC',
        label: 'Polygon',
        url: 'https://polygon-rpc.com',
        kind: INetworkType.Ethereum,
        explorer: 'https://polygonscan.com/',
        slip44: 60,
      },
      80001: {
        chainId: 80001,
        currency: 'MATIC',
        label: 'Mumbai',
        url: 'https://rpc-mumbai.maticvigil.com',
        kind: INetworkType.Ethereum,
        explorer: 'https://mumbai.polygonscan.com/',
        slip44: 60,
      },
    },
  };

  // Determine the network based on type and chainId
  let activeNetwork;
  if (networkType === INetworkType.Syscoin) {
    const syscoinChainId = chainId || 57; // Default to mainnet
    activeNetwork = networks.syscoin[syscoinChainId];
  } else if (networkType === INetworkType.Ethereum) {
    const ethChainId = chainId || 1; // Default to Ethereum mainnet
    activeNetwork = networks.ethereum[ethChainId];
  } else {
    throw new Error(`Unsupported network type: ${networkType}`);
  }

  if (!activeNetwork) {
    throw new Error(
      `Network not found for type ${networkType} and chainId ${chainId}`
    );
  }

  // Create mock accounts structure with generic labels - tests should verify what keyring manager actually produces
  const accounts = {
    [KeyringAccountType.HDAccount]: {
      0: {
        id: 0,
        address,
        xpub,
        xprv, // Now includes encrypted private key like real vault
        label: `Account 1`, // Generic label - tests should expect what keyring manager actually creates
        balances: { syscoin: 0, ethereum: 0 },
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        assets: { syscoin: [], ethereum: [] },
      },
    },
    [KeyringAccountType.Imported]: {},
    [KeyringAccountType.Trezor]: {},
    [KeyringAccountType.Ledger]: {},
  };

  return {
    activeAccount: { id: activeAccountId, type: activeAccountType },
    accounts,
    activeNetwork,
    networks,
    isUnlocked: false,
    lastLogin: null,
  };
};

// Default mock vault state (for backward compatibility) - Ethereum mainnet by default
(global as any).mockVaultState = global.createMockVaultState({
  networkType: INetworkType.Ethereum,
  chainId: 1,
});

// Export setupMocks function for use in test files
export const setupMocks = () => {
  // Reset any global state
  jest.clearAllMocks();

  // Don't clear storage here - let the beforeEach/afterEach hooks handle it
  // This prevents clearing vault-keys between keyring creation and password validation

  // Reset vault data if it exists
  if ((global as any).storedVaultData) {
    (global as any).storedVaultData = null;
  }
};

// Each fixture factory call represents a separate, intentionally fresh wallet.
// Production initialization must never replace a persisted wallet; restoration
// tests use unlock() explicitly instead of this helper.
export const createFreshTestKeyring = async (
  seed: string,
  password: string,
  vaultStateGetter: () => any
): Promise<KeyringManager> => {
  const { sysweb3Di } = jest.requireMock('@sidhujag/sysweb3-core');
  const storage = sysweb3Di.getStateStorageDb();
  await storage.deleteItem('vault');
  await storage.deleteItem('vault-keys');
  // The account fixture above was encrypted with this public deterministic
  // salt. Keep its wrapping key aligned; GCM's independent IV stays random.
  const crypto = require('crypto');
  const originalRandomBytes = crypto.randomBytes;
  const randomBytes = jest
    .spyOn(crypto, 'randomBytes')
    .mockImplementation((size: number) =>
      size === 16
        ? Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
        : originalRandomBytes(size)
    );
  try {
    return await KeyringManager.createInitialized(
      seed,
      password,
      vaultStateGetter
    );
  } finally {
    randomBytes.mockRestore();
  }
};

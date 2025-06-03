// Test setup file
import { randomBytes, createHmac } from 'crypto';
import { TextEncoder, TextDecoder } from 'util';

// Extend global type to include setupTestVault
declare global {
  function setupTestVault(password?: string): Promise<void>;
}

// Polyfill for TextEncoder/TextDecoder in Node.js environment
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

// Polyfill crypto.getRandomValues for Node.js
global.crypto = {
  getRandomValues: (arr: Uint8Array) => {
    const bytes = randomBytes(arr.length);
    arr.set(bytes);
    return arr;
  },
} as any;

// Mock browser globals that Trezor expects
global.self = global as any;
(global as any).window = global;
(global as any).document = {
  createElement: () => ({}),
  body: {
    appendChild: () => {},
  },
};

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
jest.mock('../src/providers', () => ({
  CustomJsonRpcProvider: jest.fn().mockImplementation((_signal, _url) => {
    const { ethers } = jest.requireActual('ethers');

    // Determine chainId based on URL
    let chainId = 57; // Default Syscoin mainnet
    let name = 'syscoin';

    if (_url) {
      if (
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

    const provider = {
      getNetwork: jest.fn().mockResolvedValue({ chainId, name }),
      getBalance: jest
        .fn()
        .mockResolvedValue(ethers.BigNumber.from('1000000000000000000')),
      getCode: jest.fn().mockResolvedValue('0x'),
      estimateGas: jest.fn().mockResolvedValue(ethers.BigNumber.from('21000')),
      getGasPrice: jest
        .fn()
        .mockResolvedValue(ethers.BigNumber.from('20000000000')),
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
        baseFeePerGas: ethers.BigNumber.from('20000000000'),
        gasLimit: ethers.BigNumber.from('30000000'),
        gasUsed: ethers.BigNumber.from('21000'),
        transactions: [],
        hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
      }),
      send: jest.fn().mockImplementation((method: string, _params: any[]) => {
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
        gasLimit: ethers.BigNumber.from('21000'),
        gasPrice: ethers.BigNumber.from('20000000000'),
        maxFeePerGas: ethers.BigNumber.from('40000000000'),
        maxPriorityFeePerGas: ethers.BigNumber.from('2000000000'),
        value: ethers.BigNumber.from('0'),
        chainId: 1,
        wait: jest.fn().mockResolvedValue({ status: 1 }),
      }),
      getSigner: jest.fn().mockReturnValue({
        getAddress: jest
          .fn()
          .mockResolvedValue('0x1234567890123456789012345678901234567890'),
        sendTransaction: jest.fn().mockResolvedValue({
          hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
          wait: jest.fn().mockResolvedValue({ status: 1 }),
        }),
      }),
      network: { chainId },
      _isProvider: true,
    };
    return provider;
  }),
  CustomL2JsonRpcProvider: jest.fn().mockImplementation((_signal, _url) => {
    // Return the same mock as CustomJsonRpcProvider for simplicity
    const CustomJsonRpcProviderMock =
      jest.requireMock('../src/providers').CustomJsonRpcProvider;
    return new CustomJsonRpcProviderMock(_signal, _url);
  }),
}));

// Mock storage for sysweb3-core
const mockStorage = new Map();

// Mock sysweb3-core storage
jest.mock('@pollum-io/sysweb3-core', () => ({
  sysweb3Di: {
    getStateStorageDb: () => ({
      get: jest.fn(async (key: string) => {
        return mockStorage.get(key) || null;
      }),
      set: jest.fn((key: string, value: any) => {
        mockStorage.set(key, value);
        return Promise.resolve();
      }),
      remove: jest.fn((key: string) => {
        mockStorage.delete(key);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        mockStorage.clear();
        return Promise.resolve();
      }),
      setClient: jest.fn(),
    }),
  },
}));

// Mock syscoinjs utilities - only network calls, use real HDSigner for deterministic crypto
jest.mock('syscoinjs-lib', () => {
  const actualSyscoinjs = jest.requireActual('syscoinjs-lib');

  return {
    ...actualSyscoinjs,
    // Use real HDSigner - no mock needed for deterministic crypto operations
    utils: {
      ...actualSyscoinjs.utils,
      // Only mock network-dependent functions
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 100000000, // 1 SYS in satoshis
        tokens: [],
        address: 'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4',
      }),
      fetchEstimateFee: jest.fn().mockResolvedValue({
        result: 10000,
      }),
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
    })),
  };
});

// Mock fetch to avoid network requests
global.fetch = jest.fn((url) => {
  if (url.includes('/api/v2') && !url.includes('xpub')) {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          blockbook: { coin: 'Syscoin Testnet' },
          backend: { chain: 'test' },
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
global.setupTestVault = async (password = 'test123') => {
  const { sysweb3Di } = jest.requireMock('@pollum-io/sysweb3-core');
  const storage = sysweb3Di.getStateStorageDb();

  // Create a properly encrypted vault
  const CryptoJS = jest.requireActual('crypto-js');
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const encryptedMnemonic = CryptoJS.AES.encrypt(mnemonic, password).toString();
  const vault = { mnemonic: encryptedMnemonic };
  const encryptedVault = CryptoJS.AES.encrypt(
    JSON.stringify(vault),
    password
  ).toString();

  await storage.set('vault', encryptedVault);

  // Set up vault-keys
  const salt = randomBytes(16).toString('hex');
  const currentSessionSalt = randomBytes(16).toString('hex');
  const hash = createHmac('sha512', salt).update(password).digest('hex');

  await storage.set('vault-keys', {
    hash,
    salt,
    currentSessionSalt,
  });
};

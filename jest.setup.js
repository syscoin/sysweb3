// Mock fetch globally
global.fetch = require('isomorphic-fetch');

// Mock localStorage for browser-like environments
global.localStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};

// Mock ethers providers
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');

  class MockJsonRpcProvider {
    _isProvider = true;
    _events = [];
    _emitted = { block: -2 };
    disableCcipRead = false;
    anyNetwork = false;
    _networkPromise = Promise.resolve({ chainId: 80001, name: 'mumbai' });
    _maxInternalBlockNumber = -1024;
    _lastBlockNumber = -2;
    _maxFilterBlockRange = 10;
    _pollingInterval = 4000;
    _fastQueryDate = 0;
    connection = { url: 'http://localhost:8545' };
    _nextId = 42;

    constructor() {}

    async getNetwork() {
      return { chainId: 80001, name: 'mumbai' };
    }

    async getBalance() {
      return actual.BigNumber.from('1000000000000000000');
    }

    async getBlock(blockTag) {
      // Return a mock block for testing
      return {
        number: 12345,
        timestamp: Math.floor(Date.now() / 1000),
        baseFeePerGas: actual.BigNumber.from('20000000000'),
        gasLimit: actual.BigNumber.from('30000000'),
        gasUsed: actual.BigNumber.from('21000'),
        transactions: [],
        hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
      };
    }

    async getFeeData() {
      return {
        maxFeePerGas: actual.BigNumber.from('40000000000'),
        maxPriorityFeePerGas: actual.BigNumber.from('2000000000'),
        gasPrice: actual.BigNumber.from('20000000000'),
      };
    }

    async getCode(address) {
      const contracts = [
        '0x0c702f78b889f25e3347fb978345f7ecf4f3861c',
        '0xd19018f7946d518d316bb10fdff118c28835cf7a',
        '0xaa54a8e8bdea1aa7e2ed7e5f681c798a8ed7e5ab',
        '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
        '0x1297228a708602b796fa16e9a7683db9cde09436',
        '0x628a9db47d7aeb6cf80ebf8c441bb72a83ddb08e',
        '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
        '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa',
      ];

      // Normalize address for comparison
      if (!address || typeof address !== 'string') return '0x';
      const normalizedAddress = address.toLowerCase().trim();
      const isContract = contracts.some(
        (c) => normalizedAddress === c.toLowerCase()
      );

      // Debug logging
      if (
        address
          .toLowerCase()
          .includes('0x0c702f78b889f25e3347fb978345f7ecf4f3861c')
      ) {
        console.log('getCode debug:', {
          address,
          normalizedAddress,
          isContract,
        });
      }

      return isContract ? '0x608060405234801561001057600080fd5b50' : '0x';
    }

    async call() {
      return '0x0000000000000000000000000000000000000000000000000000000000000001';
    }

    async estimateGas() {
      return actual.BigNumber.from('21000');
    }

    async getGasPrice() {
      return actual.BigNumber.from('20000000000');
    }

    async getTransactionCount() {
      return 0;
    }

    async sendTransaction(tx) {
      return {
        hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        wait: async () => ({
          status: 1,
          transactionHash:
            '0x1234567890123456789012345678901234567890123456789012345678901234',
        }),
      };
    }
  }

  return {
    ...actual,
    providers: {
      ...actual.providers,
      JsonRpcProvider: MockJsonRpcProvider,
    },
    Contract: jest.fn().mockImplementation((address, abi, provider) => {
      const lowerAddress = address.toLowerCase();

      // Determine contract type based on address
      const erc721Addresses = ['0x0c702f78b889f25e3347fb978345f7ecf4f3861c'];
      const erc1155Addresses = ['0xaa54a8e8bdea1aa7e2ed7e5f681c798a8ed7e5ab'];
      const erc20Addresses = ['0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa'];

      const isERC721 = erc721Addresses.some(
        (a) => a.toLowerCase() === lowerAddress
      );
      const isERC1155 = erc1155Addresses.some(
        (a) => a.toLowerCase() === lowerAddress
      );
      const isERC20 = erc20Addresses.some(
        (a) => a.toLowerCase() === lowerAddress
      );

      return {
        balanceOf: jest.fn().mockImplementation(async (_addr) => {
          // For ERC721 NFT, return 0 for first address, 1 for second
          if (
            isERC721 &&
            lowerAddress === '0x0c702f78b889f25e3347fb978345f7ecf4f3861c'
          ) {
            return actual.BigNumber.from('0');
          }
          return actual.BigNumber.from('1');
        }),
        supportsInterface: jest.fn().mockImplementation(async (interfaceId) => {
          if (!isERC721 && !isERC1155) {
            throw new Error('Contract does not support supportsInterface');
          }
          if (interfaceId === '0x80ac58cd' && isERC721) return true; // ERC721
          if (interfaceId === '0xd9b67a26' && isERC1155) return true; // ERC1155
          return false;
        }),
        ownerOf: jest
          .fn()
          .mockResolvedValue('0x1234567890123456789012345678901234567890'),
        tokenURI: jest.fn().mockResolvedValue('https://example.com/token/1'),
        symbol: jest.fn().mockResolvedValue('TEST'),
        name: jest.fn().mockResolvedValue('Test Token'),
        decimals: jest.fn().mockResolvedValue(18),
      };
    }),
  };
});

// Mock crypto for tests
global.crypto = {
  randomBytes: (size) => Buffer.alloc(size, 1),
  getRandomValues: (buffer) => {
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
    return buffer;
  },
};

// Suppress console errors during tests unless explicitly needed
const originalError = console.error;
beforeAll(() => {
  console.error = (...args) => {
    if (
      typeof args[0] === 'string' &&
      (args[0].includes('Consider adding an error boundary') ||
        args[0].includes('Warning:') ||
        args[0].includes('act()'))
    ) {
      return;
    }
    originalError.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
});

// Mock sysweb3 storage
jest.mock('@pollum-io/sysweb3-core', () => {
  const mockStorage = {
    vault: null,
    set: jest.fn((key, value) => {
      mockStorage[key] = value;
      return Promise.resolve();
    }),
    get: jest.fn((key) => {
      return Promise.resolve(mockStorage[key]);
    }),
    remove: jest.fn((key) => {
      delete mockStorage[key];
      return Promise.resolve();
    }),
    clear: jest.fn(() => {
      Object.keys(mockStorage).forEach((key) => {
        if (
          key !== 'set' &&
          key !== 'get' &&
          key !== 'remove' &&
          key !== 'clear'
        ) {
          delete mockStorage[key];
        }
      });
      return Promise.resolve();
    }),
  };

  return {
    sysweb3Di: {
      getStateStorageDb: () => mockStorage,
    },
  };
});

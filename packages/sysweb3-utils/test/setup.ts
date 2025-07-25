// Mock the dynamic ethers import
jest.mock('@ethersproject/contracts', () => {
  const ethers = jest.requireActual('ethers');
  const mockEthers = jest.requireMock('ethers');
  return {
    Contract: mockEthers.Contract || ethers.Contract,
    default: { Contract: mockEthers.Contract || ethers.Contract },
  };
});

// Mock ethers providers to avoid real network calls
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');

  // Create a mock that doesn't try to connect to network
  const MockJsonRpcProvider = jest
    .fn()
    .mockImplementation(function (this: any, _url?: string) {
      this._isProvider = true;
      this._network = { chainId: 80001, name: 'mumbai' };
      this.connection = { url: _url || 'http://localhost:8545' };
      this._networkPromise = Promise.resolve({
        chainId: 80001,
        name: 'mumbai',
      });

      this.getNetwork = async () => ({ chainId: 80001, name: 'mumbai' });
      this.detectNetwork = async () => ({ chainId: 80001, name: 'mumbai' });
      this.ready = Promise.resolve({ chainId: 80001, name: 'mumbai' });

      Object.defineProperty(this, 'network', {
        get: () => ({ chainId: 80001, name: 'mumbai' }),
      });

      this.getBalance = async () => {
        return actual.BigNumber.from('1000000000000000000');
      };

      this.getCode = async (address: string) => {
        // Return contract code for known contract addresses
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

        // Handle case-insensitive comparison
        const normalizedAddress = address.toLowerCase();
        const isContract = contracts.some(
          (c) => normalizedAddress === c.toLowerCase()
        );

        // Debug logging for the failing test
        if (
          normalizedAddress === '0x0c702f78b889f25e3347fb978345f7ecf4f3861c'
        ) {
          console.log(
            'getCode debug - address:',
            address,
            'normalized:',
            normalizedAddress,
            'isContract:',
            isContract
          );
        }

        return isContract ? '0x608060405234801561001057600080fd5b50' : '0x';
      };

      this.call = async (transaction: any) => {
        // Mock contract calls for ERC721 balanceOf
        if (transaction.data && transaction.data.startsWith('0x70a08231')) {
          // Return balance based on the contract address
          if (
            transaction.to.toLowerCase() ===
            '0x0c702f78b889f25e3347fb978345f7ecf4f3861c'
          ) {
            return '0x0000000000000000000000000000000000000000000000000000000000000000'; // 0
          } else {
            return '0x0000000000000000000000000000000000000000000000000000000000000001'; // 1
          }
        }
        return '0x0000000000000000000000000000000000000000000000000000000000000001';
      };

      this.estimateGas = async () => {
        return actual.BigNumber.from('21000');
      };

      // Add send method for JSON-RPC calls
      this.send = async (method: string, params: any[]) => {
        if (method === 'eth_chainId') {
          return '0x13881'; // 80001 in hex
        }
        if (method === 'net_version') {
          return '80001';
        }
        if (method === 'eth_getCode') {
          return this.getCode(params[0]);
        }
        return null;
      };

      // Add perform method
      this.perform = async (method: string, params: any) => {
        if (method === 'getCode') {
          return this.getCode(params.address);
        }
        return null;
      };
    });

  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: actual.Contract || actual.ethers?.Contract || jest.fn(),
    },
    providers: {
      ...actual.providers,
      JsonRpcProvider: MockJsonRpcProvider,
    },
    Contract: jest.fn().mockImplementation((address: string) => {
      const lowerAddress = address.toLowerCase();

      // Determine contract type based on address
      const erc721Addresses = [
        '0x0c702f78b889f25e3347fb978345f7ecf4f3861c',
        '0xd19018f7946d518d316bb10fdff118c28835cf7a',
      ];
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
        balanceOf: jest.fn().mockImplementation(async () => {
          // For ERC20 type detection, return balance even when checking contract's own balance
          if (isERC20) {
            return actual.BigNumber.from('1000000');
          }
          // For unknown contracts that don't support any standard, throw error
          if (!isERC721 && !isERC1155 && !isERC20) {
            throw new Error('Contract does not support balanceOf');
          }
          // Return different balances for NFTs
          if (lowerAddress === '0x0c702f78b889f25e3347fb978345f7ecf4f3861c') {
            return actual.BigNumber.from('0');
          }
          return actual.BigNumber.from('1');
        }),
        supportsInterface: jest
          .fn()
          .mockImplementation(async (interfaceId: string) => {
            // For unknown contracts, throw error to simulate they don't have supportsInterface
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

// Mock fetch for any remaining network calls
global.fetch = jest.fn().mockImplementation((url) => {
  if (url.includes('coingecko')) {
    if (url.includes('/search')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            coins: [
              {
                id: 'ethereum',
                name: 'Ethereum',
                symbol: 'ETH',
                thumb: 'https://example.com/eth-thumb.png',
              },
            ],
            exchanges: [],
            icos: [],
            categories: [],
            nfts: [],
          }),
      });
    } else if (url.includes('/simple/price')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            syscoin: { usd: 0.5 },
            ethereum: { usd: 2000 },
          }),
      });
    }
  }

  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
  });
});

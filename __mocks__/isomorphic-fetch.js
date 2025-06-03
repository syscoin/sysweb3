const nodeFetch = jest.fn();

// Mock responses for different endpoints
const mockResponses = {
  // Ethereum RPC responses
  eth_chainId: {
    jsonrpc: '2.0',
    id: 1,
    result: '0x1',
  },
  eth_getBalance: {
    jsonrpc: '2.0',
    id: 1,
    result: '0x0',
  },
  eth_getCode: {
    jsonrpc: '2.0',
    id: 1,
    result: '0x', // Empty by default, we'll handle specific addresses below
  },
  net_version: {
    jsonrpc: '2.0',
    id: 1,
    result: '1',
  },
  eth_call: {
    jsonrpc: '2.0',
    id: 1,
    result:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
  },
};

// Blockbook API responses
const blockbookResponses = {
  '/api/v2': {
    blockbook: {
      coin: 'Syscoin Testnet',
      about: 'Blockbook - blockchain indexer for Syscoin',
    },
    backend: {
      chain: 'test',
      blocks: 1000000,
      headers: 1000000,
    },
  },
  '/api/v2/xpub': {
    address: 'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4',
    balance: '100000000',
    totalReceived: '200000000',
    totalSent: '100000000',
    unconfirmedBalance: '0',
    unconfirmedTxs: 0,
    txs: 10,
    tokens: [],
  },
};

nodeFetch.mockImplementation((url, options) => {
  // Handle different types of requests
  if (
    url.includes('1rpc.io') ||
    url.includes('infura.io') ||
    url.includes('rpc-mumbai') ||
    url.includes('rpc.syscoin.org') ||
    url.includes('polygon-rpc.com') ||
    url.includes('rpc.tanenbaum.io')
  ) {
    const body = options && options.body ? JSON.parse(options.body) : {};

    // Special handling for eth_chainId based on URL
    if (body.method === 'eth_chainId') {
      let chainId = '0x1'; // Default mainnet
      if (url.includes('mumbai')) chainId = '0x13881'; // Mumbai testnet
      else if (url.includes('polygon')) chainId = '0x89'; // Polygon mainnet
      else if (url.includes('syscoin.org')) chainId = '0x39'; // Syscoin mainnet
      else if (url.includes('tanenbaum')) chainId = '0x1644'; // Syscoin Tanenbaum testnet

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: body.id || 1,
            result: chainId,
          }),
      });
    }

    // Special handling for eth_getCode to detect contracts
    if (body.method === 'eth_getCode' && body.params && body.params[0]) {
      const address = body.params[0].toLowerCase();
      const contractAddresses = [
        '0xd19018f7946d518d316bb10fdff118c28835cf7a',
        '0xaa54a8e8bdea1aa7e2ed7e5f681c798a8ed7e5ab',
        '0x0c702f78b889f25e3347fb978345f7ecf4f3861c',
        '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
        '0x1297228a708602b796fa16e9a7683db9cde09436',
        '0x628a9db47d7aeb6cf80ebf8c441bb72a83ddb08e',
        '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
        '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa',
      ];

      const isContract = contractAddresses.some((addr) =>
        address.includes(addr)
      );
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: body.id || 1,
            result: isContract
              ? '0x608060405234801561001057600080fd5b50'
              : '0x',
          }),
      });
    }

    const response = mockResponses[body.method] || {
      jsonrpc: '2.0',
      id: body.id || 1,
      result: null,
    };

    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(response),
    });
  }

  if (url.includes('blockbook')) {
    // Handle different blockbook endpoints
    if (url.includes('/api/v2/xpub')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(blockbookResponses['/api/v2/xpub']),
      });
    } else if (url.includes('/api/v2')) {
      // Determine if it's mainnet or testnet based on URL
      const isTestnet = url.includes('test') || url.includes('dev.elint');
      const response = {
        blockbook: {
          coin: isTestnet ? 'Syscoin Testnet' : 'Syscoin',
          about: 'Blockbook - blockchain indexer for Syscoin',
        },
        backend: {
          chain: isTestnet ? 'test' : 'main',
          blocks: 1000000,
          headers: 1000000,
        },
      };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(response),
      });
    }
  }

  if (url.includes('coingecko')) {
    // Handle different coingecko endpoints
    if (url.includes('/search')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            coins: [
              {
                id: 'ethereum',
                name: 'Ethereum',
                symbol: 'ETH',
                market_cap_rank: 2,
                thumb:
                  'https://assets.coingecko.com/coins/images/279/thumb/ethereum.png',
                large:
                  'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
              },
              {
                id: 'syscoin',
                name: 'Syscoin',
                symbol: 'SYS',
                market_cap_rank: 100,
                thumb:
                  'https://assets.coingecko.com/coins/images/119/thumb/syscoin.png',
                large:
                  'https://assets.coingecko.com/coins/images/119/large/syscoin.png',
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
        status: 200,
        json: () =>
          Promise.resolve({
            syscoin: { usd: 0.5 },
            ethereum: { usd: 2000 },
          }),
      });
    } else {
      // Default coingecko response
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: 'syscoin',
            symbol: 'sys',
            name: 'Syscoin',
          }),
      });
    }
  }

  // Default response
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
  });
});

module.exports = nodeFetch;
module.exports.default = nodeFetch;

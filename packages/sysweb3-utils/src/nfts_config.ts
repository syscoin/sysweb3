/**
 * multiple chain type
 * [ChainType]: {
 *   Disabled: true or false      //close or open chain
 *   MainChainId：string          //main chain ID
 *   Networks: object              //network config
 * }
 **/
export const NetworkConfig: { [type: number]: any } = {
  [1]: {
    Name: 'Ethereum',
    MainChainId: '1',
    UseInfura: false,
    Disabled: false,
    DefiTokenChain: [],
    CoingeckoId: 'ethereum',
    SwapUrl: 'https://app.uniswap.org/#/swap',
    SwapTokenUrl: 'https://app.uniswap.org/#/swap?inputCurrency=',
    CurrencyLogo: 'https://pali-images.s3.amazonaws.com/files/eth_logo.png',
    NeedAvailableUrl: true,
    OtherCoinInfoUrl:
      'https://api.thegraph.com/subgraphs/name/ianlapham/uniswapv2',
    SushiswapGraphUrl:
      'https://api.thegraph.com/subgraphs/name/sushiswap/exchange',
    Networks: {
      'Ethereum Mainnet': {
        provider: {
          rpcTarget: '',
          type: 'Ethereum Mainnet',
          chainId: '1',
          ticker: 'ETH',
          nickname: 'Ethereum',
        },
        rpcTargets: [
          'https://rpc.ankr.com/eth',
          'https://https://ethereum.publicnode.com',
          'https://eth-mainnet.g.alchemy.com/v2/demo',
          'https://eth-rpc.gateway.pokt.network',
          'https://eth-mainnet.public.blastapi.io',
          'https://1rpc.io/eth',
        ],
        infuraType: 'mainnet',
        ExplorerUrl: 'https://etherscan.io',
        ExplorerApiUrl: 'https://api.etherscan.io',
      },
      Goerli: {
        provider: {
          rpcTarget: 'https://rpc.ankr.com/eth_goerli',
          type: 'Goerli',
          chainId: '5',
          ticker: 'ETH',
          nickname: 'Ethereum',
        },
        infuraType: 'goerli',
        ExplorerUrl: 'https://goerli.etherscan.io',
        ExplorerApiUrl: 'https://api-goerli.etherscan.io',
      },
    },
  },
  [137]: {
    Name: 'Polygon',
    MainChainId: '137',
    UseInfura: false,
    Disabled: false,
    DefiTokenChain: ['matic'],
    CoingeckoId: 'matic-network',
    SwapUrl: 'https://quickswap.exchange/#/swap',
    SwapTokenUrl: 'https://quickswap.exchange/#/swap?inputCurrency=',
    CurrencyLogo:
      'https://pali-images.s3.amazonaws.com/files/matic_network_logo.png',
    NeedAvailableUrl: true,
    OtherCoinInfoUrl:
      'https://api.thegraph.com/subgraphs/name/sameepsi/quickswap06',
    SushiswapGraphUrl:
      'https://api.thegraph.com/subgraphs/name/sushiswap/matic-exchange',
    Networks: {
      'Polygon Mainnet': {
        provider: {
          rpcTarget: 'https://polygonapi.terminet.io/rpc',
          type: 'Polygon Mainnet',
          chainId: '137',
          ticker: 'MATIC',
          nickname: 'Polygon',
        },
        rpcTargets: [
          'https://poly-rpc.gateway.pokt.network',
          'https://matic-mainnet-archive-rpc.bwarelabs.com',
          'https://polygon.llamarpc.com',
          'https://polygonapi.terminet.io/rpc',
          'https://rpc-mainnet.matic.quiknode.pro',
          'https://polygon-mainnet-public.unifra.io',
          'https://1rpc.io/matic',
          'https://polygon-mainnet.public.blastapi.io',
          'https://polygon-bor.publicnode.com',
        ],
        infuraType: 'polygon-mainnet',
        ExplorerUrl: 'https://polygonscan.com',
        ExplorerApiUrl: 'https://api.polygonscan.com',
        partnerChainId: '1',
        DepositManagerProxy: '0x401F6c983eA34274ec46f84D70b31C151321188b',
        Tokens: {
          MaticToken: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0',
          TestToken: '0x3db715989dA05C1D17441683B5b41d4510512722',
          RootERC721: '0x96CDDF45C0Cd9a59876A2a29029d7c54f6e54AD3',
          MaticWeth: '0xa45b966996374E9e65ab991C6FE4Bfce3a56DDe8',
        },
        RootChainManagerProxy: '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77',
        MaticWETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        MaticTokenMatic: '0x0000000000000000000000000000000000001010',
      },
      'Polygon Testnet': {
        provider: {
          rpcTarget: 'https://rpc-mumbai.matic.today',
          type: 'Polygon Testnet',
          chainId: '80001',
          ticker: 'MATIC',
          nickname: 'Polygon',
        },
        infuraType: 'polygon-mumbai',
        ExplorerUrl: 'https://mumbai.polygonscan.com',
        ExplorerApiUrl: 'https://api-testnet.polygonscan.com',
        partnerChainId: '5',
        DepositManagerProxy: '0x7850ec290A2e2F40B82Ed962eaf30591bb5f5C96',
        Tokens: {
          MaticToken: '0x499d11E0b6eAC7c0593d8Fb292DCBbF815Fb29Ae',
          TestToken: '0x3f152B63Ec5CA5831061B2DccFb29a874C317502',
          RootERC721: '0xfA08B72137eF907dEB3F202a60EfBc610D2f224b',
          MaticWeth: '0x60D4dB9b534EF9260a88b0BED6c486fe13E604Fc',
        },
        RootChainManagerProxy: '0xBbD7cBFA79faee899Eaf900F13C9065bF03B1A74',
        MaticWETH: '0xA6FA4fB5f76172d178d61B04b0ecd319C5d1C0aa',
        MaticTokenMatic: '0x0000000000000000000000000000000000001010',
      },
    },
  },

  [57]: {
    Name: 'Syscoin',
    MainChainId: '57',
    UseInfura: false,
    Disabled: false,
    DefiTokenChain: ['sys', 'syscoin'],
    CoingeckoId: 'syscoin',
    SwapUrl: 'https://v1.pegasys.fi/#/swap',
    SwapTokenUrl: 'https://v1.pegasys.fi/#/swap?inputCurrency=',
    CurrencyLogo: 'https://pali-images.s3.amazonaws.com/files/syscoin_logo.png',
    NeedAvailableUrl: false,
    OtherCoinInfoUrl: '',
    SushiswapGraphUrl: '',
    Networks: {
      'Syscoin Mainnet': {
        provider: {
          rpcTarget: 'https://rpc.syscoin.org',
          type: 'Syscoin Mainnet',
          chainId: '57',
          ticker: 'SYS',
          nickname: 'Syscoin',
        },
        ExplorerUrl: 'https://explorer.syscoin.org',
        ExplorerApiUrl: 'https://explorer.syscoin.org',
      },
      'Syscoin Tanenbaum Testnet': {
        provider: {
          rpcTarget: 'https://rpc.tanenbaum.io',
          type: 'Syscoin Tanenbaum Testnet',
          chainId: '5700',
          ticker: 'tSYS',
          nickname: 'Syscoin',
        },
        ExplorerUrl: 'https://explorer.tanenbaum.io',
        ExplorerApiUrl: 'https://explorer.tanenbaum.io',
      },
    },
  },
  [570]: {
    Name: 'Rollux',
    MainChainId: '570',
    UseInfura: false,
    Disabled: false,
    DefiTokenChain: ['sys', 'rollux'],
    CoingeckoId: 'syscoin',
    SwapUrl: 'https://app.pegasys.fi/#/swap',
    SwapTokenUrl: 'https://app.pegasys.fi/#/swap?inputCurrency=',
    CurrencyLogo: 'https://pali-images.s3.amazonaws.com/files/rollux_logo.png',
    NeedAvailableUrl: false,
    OtherCoinInfoUrl: '',
    SushiswapGraphUrl: '',
    Networks: {
      'Rollux Mainnet': {
        provider: {
          rpcTarget: 'https://rpc.rollux.com',
          type: 'Rollux Mainnet',
          chainId: '570',
          ticker: 'SYS',
          nickname: 'Rollux',
        },
        ExplorerUrl: 'https://explorer.rollux.com/',
        ExplorerApiUrl: 'https://explorer.rollux.com',
      },
      'Rollux Testnet': {
        provider: {
          rpcTarget: 'https://rpc-tanenbaum.rollux.com',
          type: 'Rollux Testnet',
          chainId: '57000',
          ticker: 'TSYS',
          nickname: 'Rollux Testnet',
        },
        ExplorerUrl: 'https://rollux.tanenbaum.io',
        ExplorerApiUrl: 'https://rollux.tanenbaum.io',
      },
    },
  },
};

export const BaseChainConfig = {
  1: {
    balances_address: '0xb1f8e55c7f64d203c1400b9d8555d050f94adf39',
    coingecko_path: 'ethereum',
    tokeninfos_address: '0x4c4CE947f2cFb993B0ADdEB7373450bf2F4f54Fe',
    nftbalances_address: '0x557cF37ABEA8b81fA7fbB02a5f1907fDdFE96cA3',
  },
  137: {
    balances_address: '0x2352c63A83f9Fd126af8676146721Fa00924d7e4',
    coingecko_path: 'polygon-pos',
    tokeninfos_address: '0xfe73731e5CbBaA28C43740A2953BB4Dc343dddDa',
    nftbalances_address: '0x65067414772F3153476E23C8394055838b48798A',
  },
  57: {
    coingecko_path: 'syscoin',
    balances_address: '0xBFD340EB52D77ADeDA7622367877072E72E5bfDb',
    tokeninfos_address: '0x4a5eE16E6885C7C351d02A6034c49061EA07AFE7',
    nftbalances_address: '0x667AD1C77181FA247a1220d9a95b054802e52777',
  },
  570: {
    coingecko_path: 'rollux',
    balances_address: '0xa66b2E50c2b805F31712beA422D0D9e7D0Fd0F35',
    tokeninfos_address: '0x4DFc340487bbec780bA8458e614b732d7226AE8f',
    nftbalances_address: '0xdBB59E294A93487822d1d7e164609Cd59d396fb5',
  },
  57000: {
    coingecko_path: 'rollux',
    balances_address: '0x1ACD0B3bCC084D02Fa4E9017997BaF2F4aa256F4',
    tokeninfos_address: '0xAbD231AA41B691585F029Ecfd43B4B93b15b1D3a',
    nftbalances_address: '0x78eE491E6339421592e0043db9618F4d36B2aBAB',
  },
};

export const tlc = (str: string) => str?.toLowerCase?.();

export const toLowerCaseEquals = (a: string, b: string) => {
  if (!a && !b) {
    return false;
  }
  return tlc(a) === tlc(b);
};

const etherscanAvailable = true;
const etherscanAvailableChecked = false;
export async function isEtherscanAvailableAsync() {
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!etherscanAvailableChecked) {
    await new Promise((resolve) => setTimeout(() => resolve(true), 500));
  }
  return etherscanAvailable;
}

export async function getAvailableUrl(
  url: string
): Promise<{ url: string; options: RequestInit }> {
  let options: RequestInit = { method: 'GET' };
  if (!(await isEtherscanAvailableAsync())) {
    const formData = new FormData();
    formData.append('url', url);
    options = { method: 'POST', body: formData, headers: getBaseHeaders() };

    url = 'https://pali.pollum.cloud/proxy-json';
  }
  return { url, options };
}

export async function getScanApiByType(
  chainId: number,
  address: string,
  action: string,
  fromBlock?: string,
  etherscanApiKey?: string
) {
  let apiUrl;
  const networks = NetworkConfig[chainId]?.Networks;
  if (!networks) {
    return undefined;
  }
  for (const network in networks) {
    if (chainId === Number(networks[network].provider.chainId)) {
      apiUrl = networks[network].ExplorerApiUrl;
      break;
    }
  }
  let scanUrl = `${apiUrl}/api?module=account&action=${action}&address=${address}&tag=latest&page=1`;

  if (fromBlock) {
    scanUrl += `&startBlock=${fromBlock}`;
  }

  if (etherscanApiKey) {
    scanUrl += `&apikey=${etherscanApiKey}`;
  }

  if (NetworkConfig[chainId].NeedAvailableUrl) {
    return await getAvailableUrl(scanUrl);
  }
  return {
    url: scanUrl,
    options: {
      method: 'GET',
      headers: getBaseHeaders(),
    },
  };
}

export function getBaseHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; Android SDK built for x86 Build/OSM1.180201.023) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.92 Mobile Safari/537.36',
  };
}

/**
 * Execute fetch and verify that the response was successful
 *
 * @param request - Request information
 * @param options - Options
 * @returns - Promise resolving to the fetch response
 */
export async function successfulFetch(request: string, options?: RequestInit) {
  const response = await fetch(request, options);
  if (!response.ok) {
    throw new Error(
      `Fetch failed with status '${response.status}' for request '${request}'`
    );
  }
  return response;
}

/**
 * Fetch that fails after timeout
 *
 * @param url - Url to fetch
 * @param options - Options to send with the request
 * @param timeout - Timeout to fail request
 *
 * @returns - Promise resolving the request
 */
export async function timeoutFetch(
  url: string,
  options?: RequestInit,
  timeout = 500
): Promise<Response> {
  return Promise.race([
    successfulFetch(url, options),
    new Promise<Response>((_, reject) =>
      setTimeout(() => {
        reject(new Error('timeout'));
      }, timeout)
    ),
  ]);
}

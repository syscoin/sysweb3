import * as dotenv from 'dotenv';

dotenv.config();

export const CHAIN_ID_NUMBER = 1;
export const CHAIN_ID_HEX = '0x01';
export const RPC_URL = 'https://1rpc.io/eth';
export const SYS_RPC_URL = 'https://blockbook.syscoin.org/';

export const CHAINS_EXPLORERS = [
  {
    name: 'etherscan',
    url: 'https://etherscan.io',
    standard: 'EIP3091',
  },
];

export const CHAINS_DETAILS = {
  name: 'Ethereum Mainnet',
  chain: 'ETH',
  icon: 'ethereum',
  rpc: [
    'https://mainnet.infura.io/v3/${INFURA_API_KEY}',
    'wss://mainnet.infura.io/ws/v3/${INFURA_API_KEY}',
    'https://api.mycryptoapi.com/eth',
    'https://cloudflare-eth.com',
  ],
  faucets: [],
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  infoURL: 'https://ethereum.org',
  shortName: 'eth',
  chainId: 1,
  networkId: 1,
  slip44: 60,
  ens: { registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' },
  explorers: CHAINS_EXPLORERS,
};

export const VALID_ETH_RPC_RESPONSE = {
  chain: 'ETH',
  hexChainId: '0x01',
  valid: true,
  chainId: 1,
  details: CHAINS_DETAILS,
  isTestnet: false,
};

export const FORMATTED_BEDROCK_TESTNET = {
  url: 'https://bedrock.rollux.com:9545/',
  chainId: 57000,
  apiUrl: undefined,
  label: 'Rollux Bedrock Testnet',
  symbol: 'bSYS',
};

export const FORMATTED_GOERLI = {
  url: 'https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161',
  chainId: 5,
  apiURL: 'https://goerli.etherscan.io/',
  label: 'GOERLI',
  default: true,
  currency: 'GOR',
  explorer: 'https://goerli.etherscan.io/',
};

export const FORMATTED_OPTIMISM = {
  url: 'https://mainnet.optimism.io',
  chainId: 10,
  apiUrl: 'https://optimistic.etherscan.io/',
  label: 'OPTIMISM',
  default: false,
  currency: 'OP',
  explorer: 'https://optimistic.etherscan.io/',
};

export const DEFAULT_ETHEREUM_NETWORKS = [57, 5700, 80001, 137];

export const VALID_BLOCKBOOK_RPC_RESPONSE = {
  valid: true,
  coin: 'Litecoin',
  chain: 'main',
};
export const VALID_SYS_BLOCKBOOK_RESPONSE = {
  valid: true,
  coin: 'Syscoin',
  chain: 'main',
};
export const VALID_BIP44_DATA_RESPONSE = {
  nativeCurrency: { name: 'Litecoin', symbol: 'ltc', decimals: 8 },
  coinType: 2147483650,
  chainId: 2,
};

export const VALID_BITCOIN_LIKE_NETWORK = {
  networks: {
    mainnet: {
      bech32: 'ltc',
      bip32: { private: 27106558, public: 27108450 },
      messagePrefix: '\x19Litecoin Signed Message:',
      pubKeyHash: '0x30',
      scriptHash: '0x05',
      slip44: 2,
      wif: 176,
    },
    testnet: {
      bech32: 'ltc',
      bip32: { private: 27106558, public: 27108450 },
      messagePrefix: '\x19Litecoin Signed Message:',
      pubKeyHash: '0x30',
      scriptHash: '0x05',
      slip44: 2,
      wif: 176,
    },
  },
  types: {
    xPubType: {
      mainnet: { zprv: '27106558', zpub: '27108450' },
      testnet: { vprv: '27106558', vpub: '27108450' },
    },
    zPubType: {
      mainnet: { zprv: '04b2430c', zpub: '04b24746' },
      testnet: { vprv: '045f18bc', vpub: '045f1cf6' },
    },
  },
};

/** litecoin */
export const VALID_ADDRESS_TYPE = 48;
export const VALID_ADDRESS_START = ['L', 'M'];
export const REGEX_LITECOIN_ADDRESS = /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/g;

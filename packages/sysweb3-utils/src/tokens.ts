import axios from 'axios';
import camelcaseKeys from 'camelcase-keys';
import { ethers as ethersModule } from 'ethers';
import * as sys from 'syscoinjs-lib';

import { createContractUsingAbi } from '.';
import ABI1155 from './abi/erc1155.json';
import abi20 from './abi/erc20.json';
import ABI721 from './abi/erc721.json';
import tokens from './tokens.json';

import type {
  Contract,
  ContractFunction,
  Event,
} from '@ethersproject/contracts';
import type { BaseProvider, JsonRpcProvider } from '@ethersproject/providers';

const COINGECKO_API = 'https://api.coingecko.com/api/v3';

type NftMetadataMixedInJsonSchema = {
  title: string;
  type: 'object';
  properties: {
    name: { type: 'string'; description: string };
    image: { type: 'string'; description: string };
    description: { type: 'string'; description: string };
  };
};

export const RARIBLE_MATCH_RE =
  /^https:\/\/rarible\.com\/token\/(0x[a-fA-F0-9]{40}):([0-9]+)/;

export const isAddress = (value: string): value is Address =>
  /^0x[a-fA-F0-9]{40}$/.test(value);

export const identity = <T = unknown>(arg: T): T => arg;

export const parseNftUrl = (url: string): [string, string] | null => {
  const raribleMatch = RARIBLE_MATCH_RE.exec(url);

  if (raribleMatch) {
    return [raribleMatch[1], raribleMatch[2]];
  }

  return null;
};

export const fetchImage = (src: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.src = src;
    image.crossOrigin = '';
    image.onload = () => resolve(image);
    image.onerror = (error) => reject(error);
  });
};

export const normalizeOpenSeaUrl = (url: string, tokenId: string): string => {
  try {
    const _url = new URL(url);

    const { host, pathname, searchParams } = _url;

    // 0x%7Bid%7D" = 0x{id} (url encoded)
    if (
      (host !== 'api.opensea.io' && host !== 'testnets-api.opensea.io') ||
      !pathname.includes('0x%7Bid%7D')
    ) {
      return url;
    }

    _url.pathname = pathname.replace(/0x%7Bid%7D/g, tokenId);
    searchParams.set('format', 'json');

    return String(_url);
  } catch (error) {
    return url;
  }
};

export const normalizeNiftyGatewayUrl = (url: string): string => {
  try {
    const _url = new URL(url);

    if (_url.host !== 'api.niftygateway.com') {
      return url;
    }

    // Without final slash, the Nifty Gateway API server
    // doesn't set the CORS headers properly.
    _url.pathname = _url.pathname + '/';

    return String(_url);
  } catch (error) {
    return url;
  }
};

export const normalizeTokenUrl = (url: string): string =>
  String(url).replace('ipfs://', 'https://ipfs.io/ipfs/');

export const normalizeImageUrl = (url: string): string =>
  normalizeTokenUrl(url);

export const normalizeNftMetadata = (
  data: NftJsonMetadata
): NftJsonMetadata => ({
  ...data,
  image: normalizeImageUrl(data.image),
});

export const ABI = [
  // ERC-721
  'function tokenURI(uint256 _tokenId) external view returns (string)',
  'function ownerOf(uint256 _tokenId) external view returns (address)',
  // ERC-1155
  'function uri(uint256 _id) external view returns (string)',
];

export const ERC20ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint amount)',
];

type NftContract = InstanceType<typeof Contract> & {
  ownerOf: ContractFunction<string>;
  tokenURI: ContractFunction<string>;
  uri: ContractFunction<string>;
  balanceOf: ContractFunction<number>;
};

type TokenContract = InstanceType<typeof Contract> & {
  balanceOf: ContractFunction<number>;
  decimals: ContractFunction<number>;
  symbol: ContractFunction<string>;
  transfer: ContractFunction<any>;
  Transfer: Event;
};

export const url = async (
  contract: NftContract,
  tokenId: string
): Promise<string> => {
  const uri = await promiseAny([
    contract.tokenURI(tokenId),
    contract.uri(tokenId),
  ]).catch((error: Error) => {
    throw new Error(
      `An error occurred while trying to fetch the token URI from the NFT contract. Error: ${error}`
    );
  });

  return normalizeTokenUrl(uri);
};

export const fetchBalanceOfERC721Contract = async (
  contractAddress: string,
  address: string,
  config: EthersFetcherConfigEthersLoaded
): Promise<number | undefined> => {
  const contract = new config.ethers.Contract(
    contractAddress,
    ABI721,
    config.provider
  ) as NftContract;

  const fetchBalanceOfValue = await contract.balanceOf(address);

  return fetchBalanceOfValue;
};

export const fetchBalanceOfERC1155Contract = async (
  contractAddress: string,
  address: string,
  config: EthersFetcherConfigEthersLoaded,
  tokenId: number
): Promise<number | undefined> => {
  const contract = new config.ethers.Contract(
    contractAddress,
    ABI1155,
    config.provider
  ) as NftContract;

  const fetchBalanceOfValue = await contract.balanceOf(address, tokenId);

  return fetchBalanceOfValue;
};

export const getERC1155StandardBalance = async (
  contractAddress: string,
  address: string,
  provider: JsonRpcProvider,
  tokenId: number
) => {
  try {
    const config = { provider, ethers: ethersModule };
    const loaded = await loadEthers(config);

    return await fetchBalanceOfERC1155Contract(
      contractAddress,
      address,
      loaded,
      tokenId
    );
  } catch (error) {
    throw new Error(
      `Verify current network or the contract address. Set the same network of token contract. Error: ${error}`
    );
  }
};

export const getERC721StandardBalance = async (
  contractAddress: string,
  address: string,
  provider: JsonRpcProvider
) => {
  try {
    const config = { provider, ethers: ethersModule };
    const loaded = await loadEthers(config);

    return await fetchBalanceOfERC721Contract(contractAddress, address, loaded);
  } catch (error) {
    throw new Error(
      `Verify current network or the contract address. Set the same network of token contract. Error: ${error}`
    );
  }
};

export const fetchStandardNftContractData = async (
  contractAddress: Address,
  config: EthersFetcherConfigEthersLoaded
): Promise<NftMetadata> => {
  const contract = new config.ethers.Contract(
    contractAddress,
    ABI1155,
    config.provider
  ) as NftContract;

  const [name, symbol] = await Promise.all([
    contract.name(),
    contract.symbol(),
  ]);

  return {
    name,
    symbol,
  };
};

export const fetchStandardTokenContractData = async (
  contractAddress: Address,
  address: Address,
  config: EthersFetcherConfigEthersLoaded
): Promise<{ balance: number; decimals: number; tokenSymbol: string }> => {
  const contract = new config.ethers.Contract(
    contractAddress,
    ERC20ABI,
    config.provider
  ) as TokenContract;

  const [balance, decimals, symbol] = await Promise.all([
    contract.balanceOf(address),
    contract.decimals(),
    contract.symbol(),
  ]);

  return {
    balance,
    decimals,
    tokenSymbol: symbol,
  };
};

const ETHERS_NOT_FOUND = `Ethers couldn't be imported. Please add the ethers module to your project dependencies, or inject it in the Ethers fetcher options.`;

export const loadEthers = async (
  config: EthersFetcherConfig
): Promise<EthersFetcherConfigEthersLoaded> => {
  if (config.ethers.Contract) {
    return config as EthersFetcherConfigEthersLoaded;
  }

  try {
    const ethers = await Promise.resolve()
      .then(() => import('@ethersproject/contracts'))
      .then((m) => (m.default ? m.default : m));

    if (!ethers.Contract) {
      throw new Error();
    }

    return { ...config, ethers };
  } catch (error) {
    throw new Error(ETHERS_NOT_FOUND);
  }
};

export const fixIncorrectImageField = (
  data: Record<string, unknown>
): Record<string, unknown> => {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const _data = data as {
    image: string;
    imageUrl: string;
  };

  // makersplace.com is using `imageUrl` rather than `image`
  if (
    typeof _data.image === 'undefined' &&
    typeof _data.imageUrl === 'string'
  ) {
    return { ..._data, image: _data.imageUrl };
  }

  return data;
};

export const isNftMetadataMixedInJsonSchema = (
  data: unknown
): data is NftMetadataMixedInJsonSchema => {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const _data = data as NftMetadataMixedInJsonSchema;

  return (
    _data.title === 'Asset Metadata' &&
    _data.type === 'object' &&
    typeof _data.properties.name.description === 'string' &&
    typeof _data.properties.image.description === 'string' &&
    typeof _data.properties.description.description === 'string' &&
    _data.properties.name.type === 'string' &&
    _data.properties.image.type === 'string' &&
    _data.properties.description.type === 'string'
  );
};

export const fixNftMetadataMixedInJsonSchema = (
  data: NftMetadataMixedInJsonSchema
): NftJsonMetadata => ({
  name: data.properties.name.description || '',
  description: data.properties.description.description || '',
  image: data.properties.image.description || '',
  rawData: { ...data },
});

export const isNftMetadata = (data: unknown): data is NftMetadata => {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const _data = data as NftMetadata;

  return 'name' in _data || 'image' in _data;
};

export const addressesEqual = (
  address: Address,
  addressToCompare: Address
): boolean => {
  return address.toLowerCase() === addressToCompare.toLowerCase();
};

// Promise.any() implementation from https://github.com/m0ppers/promise-any
export const promiseAny = (promises: Promise<any>[]): Promise<any> => {
  return reversePromise(
    Promise.all([...promises].map(reversePromise))
  ) as Promise<any>;
};

export const reversePromise = (promise: Promise<unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    Promise.resolve(promise).then(reject, resolve);
  });

export const IMAGE_EXT_RE = /\.(?:png|svg|jpg|jepg|gif|webp|jxl|avif)$/;
export const VIDEO_EXT_RE = /\.(?:mp4|mov|webm|ogv)$/;

export const getTokenIconBySymbol = async (symbol: string): Promise<string> => {
  symbol = symbol.toUpperCase();
  const searchResults = await getSearch(symbol);

  const tokens = searchResults.coins.filter(
    (token: any) => token.symbol.toUpperCase() === symbol
  );

  if (tokens[0]) return tokens[0].thumb;

  throw new Error('Token icon not found');
};

export const isNFT = (guid: number) => {
  const assetGuid = BigInt.asUintN(64, BigInt(guid));

  return assetGuid >> BigInt(32) > 0;
};

export const getHost = (url: string) => {
  if (typeof url === 'string' && url !== '') {
    return new URL(url).host;
  }

  return url;
};

export const getToken = async (id: string): Promise<ICoingeckoToken> => {
  let token;
  try {
    if (fetch) {
      const response = await fetch(`${COINGECKO_API}/coins/${id}`);
      token = await response.json();
    } else {
      const response = await axios.get(`${COINGECKO_API}/coins/${id}`);
      token = response.data;
    }
  } catch (error) {
    throw new Error('Unable to retrieve token data');
  }

  return camelcaseKeys(token, { deep: true });
};

export const getTokenStandardMetadata = async (
  contractAddress: string,
  address: string,
  provider: JsonRpcProvider
) => {
  try {
    const config = { provider, ethers: ethersModule };
    const loaded = await loadEthers(config);

    return await fetchStandardTokenContractData(
      contractAddress,
      address,
      loaded
    );
  } catch (error) {
    throw new Error(
      `Verify current network. Set the same network of token contract. Error: ${error}`
    );
  }
};

export const getNftStandardMetadata = async (
  contractAddress: string,
  provider: JsonRpcProvider
) => {
  try {
    const config = { provider, ethers: ethersModule };
    const loaded = await loadEthers(config);

    return await fetchStandardNftContractData(contractAddress, loaded);
  } catch (error) {
    throw new Error(
      `Verify current network. Set the same network of NFT token contract. Error: ${error}`
    );
  }
};

/**
 * Converts a token to a fiat value
 *
 * Parameters should be all lower case and written by extense
 *
 * @param token Token to get fiat price from
 * @param fiat Fiat to convert token price to, should be a {@link [ISO 4217 code](https://docs.1010data.com/1010dataReferenceManual/DataTypesAndFormats/currencyUnitCodes.html)}
 * @example 'syscoin' for token | 'usd' for fiat
 */
export const getFiatValueByToken = async (
  token: string,
  fiat: string
): Promise<number> => {
  try {
    if (fetch) {
      const response = await fetch(
        `${COINGECKO_API}/simple/price?ids=${token}&vs_currencies=${fiat}`
      );
      const data = await response.json();
      return data[token][fiat];
    } else {
      const response = await axios.get(
        `${COINGECKO_API}/simple/price?ids=${token}&vs_currencies=${fiat}`
      );
      return response.data[token][fiat];
    }
  } catch (error) {
    throw new Error(`Unable to retrieve ${token} price as ${fiat} `);
  }
};

/**
 * Get token symbol by chain
 * @param chain should be written in lower case and by extense
 * @example 'ethereum' | 'syscoin'
 */
export const getSymbolByChain = async (chain: string): Promise<string> => {
  const { symbol } = await getToken(chain);

  return symbol.toUpperCase();
};

export const getTokenBySymbol = async (
  symbol: string
): Promise<ICoingeckoSearchResultToken> => {
  const searchResults = await getSearch(symbol);
  const firstCoin = searchResults.coins[0];

  const symbolsAreEqual =
    firstCoin.symbol.toUpperCase() === symbol.toUpperCase();

  if (symbolsAreEqual) return firstCoin;
  else throw new Error('Unable to find token');
};

export const getSearch = async (
  query: string
): Promise<ICoingeckoSearchResults> => {
  if (fetch) {
    const response = await fetch(`${COINGECKO_API}/search?query=${query}`);
    const data = await response.json();
    return camelcaseKeys(data, { deep: true });
  } else {
    const response = await axios.get(`${COINGECKO_API}/search?query=${query}`);
    return camelcaseKeys(response.data, { deep: true });
  }
};

export const getSearchTokenAtCoingecko = async (
  tokenSymbol: string
): Promise<ICoingeckoSearchResultToken | null> => {
  try {
    const { coins } = await getSearch(tokenSymbol);

    if (coins && coins[0]) {
      return coins[0];
    } else {
      return null;
    }
  } catch (error) {
    return null;
  }
};
const isImageUrlAvailable = async (imageUrl: string) => {
  try {
    const response = await fetch(imageUrl);

    return response.status === 200;
  } catch (error) {
    console.log('isImageUrlAvailable -->', { error });
    return false;
  }
};

export const getSearchTokenAtSysGithubRepo = async (tokenSymbol: string) => {
  const baseUrlToFetch = `https://raw.githubusercontent.com/syscoin/syscoin-rollux.github.io/master/data/${tokenSymbol}`;

  try {
    const imageUrl = `${baseUrlToFetch}/logo`;
    const dataUrl = `${baseUrlToFetch}/data.json`;

    const isPngImageAvailable = await isImageUrlAvailable(`${imageUrl}.png`);

    const formattedImgUrl = isPngImageAvailable
      ? `${imageUrl}.png`
      : `${imageUrl}.svg`;

    const tokenData = await fetch(dataUrl);

    const formattedTokenData = await tokenData.json();

    if (formattedTokenData) {
      return {
        token: formattedTokenData,
        imageUrl: formattedImgUrl,
      };
    } else {
      return {
        token: null,
        imageUrl: '',
      };
    }
  } catch (error) {
    console.log('getSearchTokenAtSysGithubRepo error --> ', { error });
    return {
      token: null,
      imageUrl: '',
    };
  }
};

export const getTokenInfoBasedOnNetwork = async (
  token: ITokenEthProps,
  networkChainId: number
): Promise<ITokenEthProps> => {
  const rolluxChainIds = [570, 57000];

  const isRolluxNetwork = rolluxChainIds.some(
    (rolluxChain) => rolluxChain === networkChainId
  );

  //Fill the let with the default values that can't be different / edited
  let web3Token: ITokenEthProps = {
    ...token,
    tokenSymbol: token.editedSymbolToUse
      ? token.editedSymbolToUse
      : token.tokenSymbol,
    balance: token.balance ? token.balance : 0,
    id: token.contractAddress,
    isNft: token.isNft,
    chainId: networkChainId,
  };

  switch (isRolluxNetwork) {
    case true: {
      const fetchTokenData = await getSearchTokenAtSysGithubRepo(
        token.tokenSymbol
      );

      if (fetchTokenData?.token !== null && fetchTokenData?.imageUrl !== '') {
        web3Token = {
          ...web3Token,
          name: fetchTokenData?.token.name || token?.name,
          logo: fetchTokenData?.imageUrl || token?.logo,
        };
      } else {
        const tokenResult = await getSearchTokenAtCoingecko(token.tokenSymbol);

        if (tokenResult !== null && tokenResult !== undefined) {
          const { name, thumb } = tokenResult;

          web3Token = {
            ...web3Token,
            name: token?.name ? token.name : name,
            logo: token?.logo ? token.logo : thumb,
          };
        } else {
          web3Token = {
            ...web3Token,
            name: token.tokenSymbol,
            logo: token?.logo ? token.logo : '', //Return empty string to use fill it up with Pali Logo at Pali Side
          };
        }
      }
      break;
    }

    case false: {
      const tokenResult = await getSearchTokenAtCoingecko(token.tokenSymbol);

      if (tokenResult !== null && tokenResult !== undefined) {
        const { name, thumb } = tokenResult;

        web3Token = {
          ...web3Token,
          name: token?.name ? token.name : name,
          logo: token?.logo ? token.logo : thumb,
        };
      } else {
        web3Token = {
          ...web3Token,
          name: token.tokenSymbol,
          logo: token?.logo ? token.logo : '', //Return empty string to use fill it up with Pali Logo at Pali Side
        };
      }
      break;
    }
  }

  return web3Token;
};

/**
 *
 * @param contractAddress Contract address of the token to get info from
 */
export const getTokenByContract = async (
  contractAddress: string
): Promise<ICoingeckoToken> => {
  let token;
  try {
    if (fetch) {
      const response = await fetch(
        `${COINGECKO_API}/coins/ethereum/contract/${contractAddress}`
      );
      token = await response.json();
    } else {
      const response = await axios.get(
        `${COINGECKO_API}/coins/ethereum/contract/${contractAddress}`
      );
      token = response.data;
    }
  } catch (error) {
    throw new Error('Token not found');
  }

  return camelcaseKeys(token, { deep: true });
};

/**
 *
 * @param address Contract address of the token to validate
 */
export const validateToken = async (
  address: string,
  web3Provider: any
): Promise<IErc20Token | any> => {
  try {
    const contract = createContractUsingAbi(abi20, address, web3Provider);

    const [decimals, name, symbol]: IErc20Token[] = await Promise.all([
      contract.methods.decimals().call(),
      contract.methods.name().call(),
      contract.methods.symbol().call(),
    ]);

    const validToken = decimals && name && symbol;

    if (validToken) {
      return {
        name: String(name),
        symbol: String(symbol),
        decimals: Number(decimals),
      };
    }

    return console.error('Invalid token');
  } catch (error) {
    return console.error('Token not found, verify the Token Contract Address.');
  }
};

export const getTokenJson = (): any => tokens;

export const getAsset = async (
  explorerUrl: string,
  assetGuid: string
): Promise<
  | {
      assetGuid: string;
      contract: string;
      decimals: number;
      maxSupply: string;
      pubData: any;
      symbol: string;
      totalSupply: string;
      updateCapabilityFlags: number;
    }
  | undefined
> => {
  try {
    const asset = await sys.utils.fetchBackendAsset(explorerUrl, assetGuid);

    if (!asset) throw new Error(`Asset with guid ${assetGuid} not found`);

    return asset;
  } catch (error) {
    return;
  }
};

export const countDecimals = (x: number) => {
  if (Math.floor(x) === x) return 0;

  return x.toString().split('.')[1].length || 0;
};

/** types */

// the source is in snake case
export interface ICoingeckoToken {
  id: string;
  symbol: string;
  name: string;
  assetPlatformId: string;
  platforms: object;
  blockTimeInMinutes: number;
  hashingAlgorithm?: string;
  categories: string[];
  localization: object;
  description: object;
  links: object;
  image: {
    thumb: string;
    small: string;
    large: string;
  };
  countryOrigin: string;
  genesisDate?: string;
  contractAddress?: string;
  sentimentVotesUpPercentage: number;
  sentimentVotesDownPercentage: number;
  icoData?: object;
  marketCapRank: number;
  coingeckoRank: number;
  coingeckoScore: number;
  developerScore: number;
  communityScore: number;
  liquidityScore: number;
  publicInterestScore: number;
  marketData: {
    currentPrice: { [fiat: string]: number };
    marketCap: { [fiat: string]: number };
    totalVolume: { [fiat: string]: number };
    fullyDilutedValuation: object;
    totalValueLocked?: object;
    fdvToTvlRatio?: number;
    mcapToTvlRatio?: number;
    circulatingSupply: number;
    totalSupply?: number;
    maxSupply?: number;
    priceChange24H: number;
  };
  communityData: object;
  developerData: object;
  publicInterestStats: object;
  lastUpdated: string;
  tickers: object[];
}

export interface ICoingeckoSearchResultToken {
  id: string;
  name: string;
  symbol: string;
  marketCapRank: number;
  thumb: string;
  large: string;
}

export interface ICoingeckoSearchResults {
  coins: ICoingeckoSearchResultToken[];
  exchanges: object[];
  icos: object[];
  categories: object[];
  nfts: object[];
}

export type EthTokenDetails = {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  description: string;
  contract: string;
};

export type IEthereumAddress = {
  address: IEthereumBalance[];
};

export type IEthereumBalance = {
  balances: IEthereumCurrency[];
};

export type IEthereumCurrency = {
  currency: {
    symbol: string;
  };
  value: number;
};

export type IEthereumTokensResponse = {
  ethereum: IEthereumAddress;
};

export type IEthereumToken = {
  id: string;
  name: string;
  symbol: string;
  market_cap_rank: number;
  thumb: string;
  large: string;
};

export type TokenIcon = {
  thumbImage: string;
  largeImage: string;
};

export type NftResultDone = {
  status: 'done';
  loading: false;
  error: undefined;
  nft: NftMetadata;
  reload: () => Promise<boolean>;
};

export interface IEtherscanNFT {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  nonce: string;
  blockHash: string;
  from: string;
  contractAddress: string;
  to: string;
  tokenID: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
  transactionIndex: string;
  gas: string;
  gasPrice: string;
  gasUsed: string;
  cumulativeGasUsed: string;
  input: string;
  confirmations: string;
}

export interface NftMetadata {
  name: string;
  symbol: string;
}

export type IErc20Token = {
  name: string;
  symbol: string;
  decimals: number;
};

export enum IKeyringTokenType {
  SYS = 'SYS',
  ETH = 'ETH',
  ERC20 = 'ERC20',
}

export type ISyscoinToken = {
  type: string;
  name: string;
  path: string;
  tokenId: string;
  transfers: number;
  symbol: string;
  decimals: number;
  balance: number;
  totalReceived: string;
  totalSent: string;
};

export type IAddressMap = {
  changeAddress: string;
  outputs: [
    {
      value: number;
      address: string;
    }
  ];
};

export type EthersContract = typeof Contract;

export type EthersFetcherConfig = {
  ethers: { Contract: EthersContract };
  provider: BaseProvider | JsonRpcProvider;
};

export type EthersFetcherConfigEthersLoaded = EthersFetcherConfig & {
  ethers: { Contract: EthersContract };
};

export type EthereumProviderEip1193 = {
  request: (args: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }) => Promise<unknown>;
};

export type Address = string;

export type NftResultLoading = {
  status: 'loading';
  loading: true;
  error: undefined;
  nft: undefined;
  reload: () => Promise<boolean>;
};

export type NftResultError = {
  status: 'error';
  loading: false;
  error: Error;
  nft: undefined;
  reload: () => Promise<boolean>;
};

export type IQueryFilterResult = Promise<Array<Event>>;

export type NftResult = NftResultLoading | NftResultError | NftResultDone;

export type NftJsonMetadata = {
  description: string;
  image: string;
  name: string;
  rawData: Record<string, unknown> | null;
};

export type ContractMethod = {
  address: string;
  methodName: string;
  methodHash: string;
  humanReadableAbi: [string];
};

interface ITokenEthProps {
  balance: number;
  chainId?: number;
  collection?: IERC1155Collection[];
  collectionName?: string;
  contractAddress: string;
  decimals: string | number;
  editedSymbolToUse?: string;
  id?: string;
  is1155?: boolean;
  isNft: boolean;
  logo?: string;
  name?: string;
  tokenId?: number | string;
  tokenSymbol: string;
}

interface IERC1155Collection {
  balance: number;
  tokenId: number;
  tokenSymbol: string;
}

export type ITokenMap = Map<string, IAddressMap>;
/** end */

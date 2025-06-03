import { BigNumber } from 'bignumber.js';
import { ethers } from 'ethers';

import NFT_BALANCE_CHECKER_ABI from './abi/nft_balance_checker_abi.json';
import { createContractUsingAbi } from './contracts';
import {
  BaseChainConfig,
  getScanApiByType,
  timeoutFetch,
  toLowerCaseEquals,
} from './nfts_config';

const LOAD_NFT_MAX = 400;

export const isSupportOpensea = (chainId: number) => {
  return chainId === 1 || chainId === 137;
};

export const isSupportLuxy = (chainId: number) => {
  return chainId === 57 || chainId === 570;
};

export const getOwnerCollectiblesApi = (
  chainId: number,
  address: string,
  offset: number
) => {
  const openSeaApiKey = '036fa7af78b64330af9e3be14d7cd1be';
  if (chainId === 137) {
    return {
      api: `https://api.opensea.io/api/v2/assets/matic?owner_address=${address}`,
      key: openSeaApiKey,
      version: 'v2',
    };
  }
  return {
    api: `https://api.opensea.io/api/v1/assets?owner=${address}&offset=${offset}&limit=50`,
    key: openSeaApiKey,
    version: 'v1',
  };
};

export const getCollectiblesByType = async (
  walletAddress: string,
  chainId: number
) => {
  const api = await getScanApiByType(
    chainId,
    walletAddress,
    'tokennfttx',
    undefined
  );
  if (!api?.url) {
    return undefined;
  }
  const response = await timeoutFetch(api.url, api.options, 15000);
  const nftResult = await response.json();
  if (
    !nftResult ||
    nftResult.status === '0' ||
    !Array.isArray(nftResult.result)
  ) {
    return undefined;
  }
  return nftResult.result;
};

export const fetchLuxyNFTs = async (
  walletAddress: string,
  chainId: number,
  rpcUrl: string
) => {
  try {
    const network = chainId === 57 ? 'Syscoin' : 'Rollux';

    const formattedWalletAddress = ethers.utils.getAddress(walletAddress);

    const limit = 50;
    let page = 0;
    let pagingFinish = false;
    let collectibles: any[] = [];
    let url = `https://backend.luxy.io/nft/by-owner/${formattedWalletAddress}?network=%5B"${network}"%5D&page=${page}&limit=${limit}`;

    do {
      const response = await fetch(url);
      const { assets, more_pages } = await response.json();

      if (assets?.length) {
        collectibles = [...collectibles, ...assets];
      }

      if (!more_pages || collectibles.length >= LOAD_NFT_MAX) {
        pagingFinish = true;
      }

      url = `https://backend.luxy.io/nft/by-owner/${formattedWalletAddress}?network=%5B"${network}"%5D&page=${page}&limit=${limit}`;
      page += 1;
    } while (!pagingFinish);

    if (!collectibles.length) {
      return undefined;
    }

    return await fixDataCollectibles(
      collectibles,
      chainId,
      formattedWalletAddress,
      rpcUrl
    );
  } catch (e) {
    console.log('PPYang fetchLuxyNFTs e:', e);
    return undefined;
  }
};

export const getCollectiblesByOpensea = async (
  chainId: number,
  walletAddress: string,
  rpcUrl: string
) => {
  const collectibles = await getOwnerCollectibles(chainId, walletAddress);
  if (!collectibles) {
    return undefined;
  }
  return await fixDataCollectibles(
    collectibles,
    chainId,
    walletAddress,
    rpcUrl
  );
};

export const detectCollectibles = async (
  requestedSelectedAddress: string,
  chainId: number,
  rpcUrl: string
): Promise<INftsStructure[] | undefined> => {
  let collectibles: INftsStructure[] | undefined;

  if (isSupportOpensea(chainId)) {
    collectibles = await getCollectiblesByOpensea(
      chainId,
      requestedSelectedAddress,
      rpcUrl
    );
  } else if (isSupportLuxy(chainId)) {
    collectibles = await fetchLuxyNFTs(
      requestedSelectedAddress,
      chainId,
      rpcUrl
    );
  }

  return collectibles;
};

export const getOwnerCollectibles = async (
  chainId: number,
  walletAddress: string
) => {
  let response: Response;
  let collectibles: any = [];
  try {
    let offset = 0;
    let pagingFinish = false;
    let api;
    do {
      const openseaApi = getOwnerCollectiblesApi(
        chainId,
        walletAddress,
        offset
      );
      response = await timeoutFetch(
        api || openseaApi.api,
        openseaApi.key ? { headers: { 'X-API-KEY': openseaApi.key } } : {},
        15000
      );
      const collectiblesArray = await response.json();
      let results;
      if (openseaApi.version === 'v1') {
        results = collectiblesArray.assets;
      } else {
        results = collectiblesArray.results;
      }
      if (results?.length) {
        collectibles = [...collectibles, ...results];
      }
      if (!results || results.length <= 0) {
        pagingFinish = true;
      }
      if (openseaApi.version === 'v1') {
        if (results.length < 50) {
          pagingFinish = true;
        }
      } else if (openseaApi.version === 'v2') {
        if (collectiblesArray.next) {
          api = collectiblesArray.next;
          api =
            'https://api.opensea.io/api/v2/assets/matic' +
            api.substring(api.indexOf('?'), api.length);
        } else {
          api = undefined;
          pagingFinish = true;
        }
      }
      offset += 50;
      if (offset >= LOAD_NFT_MAX) {
        pagingFinish = true;
      }
    } while (!pagingFinish);
  } catch (e) {
    console.log('PPYang getOwnerCollectibles e:', e);
    return undefined;
  }
  return collectibles;
};

export const fixDataCollectibles = async (
  collectibles: any,
  chainId: number,
  walletAddress: string,
  rpcUrl: string
): Promise<INftsStructure[] | undefined> => {
  const erc721Tokens: string[] = [];
  const erc721Ids: string[] = [];

  const erc1155Tokens: string[] = [];
  const erc1155Ids: string[] = [];

  collectibles.forEach((collectible: any) => {
    if (collectible.asset_contract.schema_name === 'ERC721') {
      erc721Tokens.push(collectible.asset_contract.address);
      erc721Ids.push(collectible.token_id);
    } else if (collectible.asset_contract.schema_name === 'ERC1155') {
      erc1155Tokens.push(collectible.asset_contract.address);
      erc1155Ids.push(collectible.token_id);
    }
  });

  const allOwners: any[] = [];
  if (erc721Tokens.length > 0) {
    let owners: any[] = [];
    try {
      owners = await getERC721OwnersInSingleCall(
        walletAddress,
        erc721Tokens,
        erc721Ids,
        rpcUrl,
        chainId
      );
    } catch (e) {
      console.log('PPYang getERC721OwnersInSingleCall e:', e);
    }
    if (owners && owners.length === erc721Tokens.length) {
      erc721Tokens.forEach((address, index) => {
        if (toLowerCaseEquals(owners[index], walletAddress)) {
          allOwners.push({
            balanceOf: new BigNumber(1),
            address,
            token_id: erc721Ids[index],
          });
        }
      });
    } else {
      console.log(
        'PPYang getERC721OwnersInSingleCall length is not match:',
        owners?.length,
        erc721Tokens.length
      );
      return undefined;
    }
  }
  if (erc1155Tokens.length > 0) {
    let owners: any[] = [];
    try {
      owners = await getERC1155BalancesInSingleCall(
        walletAddress,
        erc1155Tokens,
        erc1155Ids,
        rpcUrl,
        chainId
      );
    } catch (e) {
      console.log('PPYang getERC1155BalancesInSingleCall e:', e);
    }
    if (owners && owners.length === erc1155Tokens.length) {
      erc1155Tokens.forEach((address, index) => {
        if (owners[index]?.gt(0)) {
          allOwners.push({
            balanceOf: owners[index],
            address,
            token_id: erc1155Ids[index],
          });
        }
      });
    } else {
      console.log(
        'PPYang getERC1155BalancesInSingleCall length is not match:',
        owners?.length,
        erc1155Tokens.length
      );
      return undefined;
    }
  }

  const ownedCollectibles: INftsStructure[] = [];
  collectibles.forEach((collectible: any) => {
    const owner = allOwners.find(
      (item) =>
        item.address === collectible.asset_contract.address &&
        item.token_id === collectible.token_id
    );

    if (owner) {
      ownedCollectibles.push({
        ...collectible,
        balanceOf: owner.balanceOf,
        chainId,
      });
    }
  });

  return ownedCollectibles;
};

export const getERC721OwnersInSingleCall = async (
  walletAddress: string,
  tokens: string[],
  ids: string[],
  rpcUrl: string,
  currentChainId: number,
  targetChainId: number | undefined = undefined
): Promise<string[]> => {
  if (targetChainId && targetChainId !== currentChainId) {
    console.log(
      `getERC721OwnersInSingleCall:Cannot match target chainId, current ${currentChainId} target ${targetChainId}`
    );
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const ADDRESS = BaseChainConfig[currentChainId]?.nftbalances_address;
  if (!ADDRESS) {
    return [];
  }

  const allBalances: string[] = [];
  for (let i = 0; i <= tokens.length / 500; i++) {
    const sliced_tokens = tokens.slice(i * 500, (i + 1) * 500);
    const sliced_ids = ids.slice(i * 500, (i + 1) * 500);
    const result = await getERC721OwnersInSingleCallInternal(
      walletAddress,
      sliced_tokens,
      sliced_ids,
      rpcUrl,
      currentChainId,
      targetChainId as number
    );
    result && allBalances.push(...result);
  }
  return allBalances;
};

export const getERC721OwnersInSingleCallInternal = async (
  walletAddress: string,
  tokens: string[],
  ids: string[],
  rpcUrl: string,
  currentChainId: number,
  targetChainId: number | undefined = undefined
): Promise<string[]> => {
  if (targetChainId && targetChainId !== currentChainId) {
    console.log(
      `getERC721OwnersInSingleCall:Cannot match target chainId, current ${currentChainId} target ${targetChainId}`
    );
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const ADDRESS = BaseChainConfig[currentChainId]?.nftbalances_address;
  if (!ADDRESS) {
    return [];
  }
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  const contract = createContractUsingAbi(
    NFT_BALANCE_CHECKER_ABI,
    ADDRESS,
    provider
  );
  return new Promise<string[]>((resolve) => {
    contract
      .owners([walletAddress], tokens, ids)
      .then((result: string[]) => {
        let allBalances: string[] = [];

        allBalances = result;
        resolve(allBalances);
      })
      .catch((error: Error) => {
        if (error) {
          resolve([]);
          return;
        }
      });
  });
};

export const getERC1155BalancesInSingleCall = async (
  walletAddress: string,
  tokens: string[],
  ids: string[],
  rpcUrl: string,
  currentChainId: number,
  targetChainId: number | undefined = undefined
): Promise<BigNumber[]> => {
  if (targetChainId && targetChainId !== currentChainId) {
    console.log(
      `getERC1155BalancesInSingleCall:Cannot match target chainId, current ${currentChainId} target ${targetChainId}`
    );
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const ADDRESS = BaseChainConfig[currentChainId]?.nftbalances_address;
  if (!ADDRESS) {
    return [];
  }

  const allBalances: BigNumber[] = [];
  for (let i = 0; i <= tokens.length / 500; i++) {
    const sliced_tokens = tokens.slice(i * 500, (i + 1) * 500);
    const sliced_ids = ids.slice(i * 500, (i + 1) * 500);
    const result = await getERC1155BalancesInSingleCallInternal(
      walletAddress,
      sliced_tokens,
      sliced_ids,
      rpcUrl,
      currentChainId,
      targetChainId
    );
    result && allBalances.push(...result);
  }
  return allBalances;
};

export const getERC1155BalancesInSingleCallInternal = async (
  walletAddress: string,
  tokens: string[],
  ids: string[],
  rpcUrl: string,
  currentChainId: number,
  targetChainId: number | undefined = undefined
): Promise<BigNumber[]> => {
  if (targetChainId && targetChainId !== currentChainId) {
    console.log(
      `getERC1155BalancesInSingleCall:Cannot match target chainId, current ${currentChainId} target ${targetChainId}`
    );
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const ADDRESS = BaseChainConfig[currentChainId]?.nftbalances_address;
  if (!ADDRESS) {
    return [];
  }
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  const contract = createContractUsingAbi(
    NFT_BALANCE_CHECKER_ABI,
    ADDRESS,
    provider
  );

  return new Promise<BigNumber[]>((resolve) => {
    contract
      .balances([walletAddress], tokens, ids)
      .then((result: BigNumber[]) => {
        resolve(result);
      })
      .catch((error: Error) => {
        if (error) {
          resolve([]);
          return;
        }
      });
  });
};

export interface IApiNftsCreator {
  user: { username: string };
  profile_img_url: string;
  address: string;
}

export interface IApiNftsLastSale {
  event_timestamp: string;
  total_price: string;
  transaction: { transaction_hash: string; block_hash: string };
}

export interface IApiNftsCollection {
  name: string;
  slug: string;
  image_url: string;
  description: string;
}

export interface INftsStructure {
  chainId: string;
  token_id: string;
  address: string;
  collection: IApiNftsCollection | null;
  num_sales: number | null;
  background_color: string | null;
  image_url: string | null;
  image_preview_url: string | null;
  image_thumbnail_url: string | null;
  image_original_url: string | null;
  animation_url: string | null;
  animation_original_url: string | null;
  name: string | null;
  description: string | null;
  external_link: string | null;
  creator: IApiNftsCreator | null;
  last_sale: IApiNftsLastSale | null;
  balanceOf: BigNumber;
}

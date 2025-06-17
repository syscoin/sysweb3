import { Chain, chains } from 'eth-chains';
import { hexlify } from 'ethers/lib/utils';

import { findCoin } from './coin-utils';
// import fetch from "node-fetch";
import { getNetworkConfig, toDecimalFromHex, INetwork } from './networks';
import { INetworkType } from './networks';

const hexRegEx = /^0x[0-9a-f]+$/iu;

// Cache for blockbook validation to prevent repeated calls
const blockbookValidationCache = new Map<
  string,
  {
    result: { chain: string; coin: string; valid: boolean };
    timestamp: number;
  }
>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for eth_chainId calls
const ethChainIdCache = new Map<
  string,
  {
    chainId: number;
    timestamp: number;
  }
>();

// Function to clear RPC caches
export const clearRpcCaches = () => {
  blockbookValidationCache.clear();
  ethChainIdCache.clear();
  console.log('[RPC] Cleared all RPC caches');
};

export const validateChainId = (
  chainId: number | string
): { hexChainId: string; valid: boolean } => {
  const hexChainId = hexlify(chainId);

  const isHexChainIdValid =
    typeof hexChainId === 'string' && hexRegEx.test(hexChainId);

  return {
    valid: isHexChainIdValid,
    hexChainId,
  };
};
//TODO: add returns types for getEthChainId
const getEthChainId = async (
  url: string,
  isInCooldown: boolean
): Promise<{ chainId: number }> => {
  if (isInCooldown) {
    throw new Error('Cant make request, rpc cooldown is active');
  }

  // Check cache first
  const cached = ethChainIdCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('[getEthChainId] Returning cached chainId for', url);
    return { chainId: cached.chainId };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_chainId',
      params: [],
      id: 1,
    }),
  });

  // Check the status code of the HTTP response
  if (!response.ok) {
    switch (response.status) {
      case 429:
        throw new Error(
          'Error 429: Too many requests. Please slow down your request rate.'
        );
      case 503:
        throw new Error(
          'Error 503: Service Unavailable. The server is currently unable to handle the request.'
        );
      default:
        throw new Error(
          `Error ${response.status}: An error occurred while fetching the chain ID.`
        );
    }
  }

  const data = await response.json();

  // If the request was successful, the chain ID will be in data.result.
  // Otherwise, there will be an error message in data.error.
  if (data.error) {
    throw new Error(`Error getting chain ID: ${data.error.message}`);
  }

  const chainId = Number(data.result);

  // Cache the result
  ethChainIdCache.set(url, {
    chainId,
    timestamp: Date.now(),
  });

  return { chainId };
};

/** eth rpc */
export const isValidChainIdForEthNetworks = (chainId: number | string) =>
  Number.isSafeInteger(chainId) &&
  Number(chainId) > 0 &&
  Number(chainId) <= 4503599627370476;

export const validateEthRpc = async (
  url: string,
  isInCooldown: boolean
): Promise<{
  chain: string;
  chainId: number;
  details: Chain | undefined;
  hexChainId: string;
  valid: boolean;
}> => {
  try {
    const { chainId } = await getEthChainId(url, isInCooldown);
    if (!chainId) {
      throw new Error('Invalid RPC URL. Could not get chain ID for network.');
    }

    if (!isValidChainIdForEthNetworks(Number(chainId))) {
      throw new Error('Invalid chain ID for ethereum networks.');
    }

    const { valid, hexChainId } = validateChainId(chainId);
    const details = chains.getById(chainId);
    if (!valid) {
      throw new Error('RPC has an invalid chain ID');
    }

    return {
      chainId,
      details,
      chain: details && details.chain ? details.chain : 'unknown',
      hexChainId,
      valid,
    };
  } catch (error) {
    throw new Error(error);
  }
};

export const getEthRpc = async (
  data: any,
  isInCooldown: boolean
): Promise<{
  formattedNetwork: INetwork;
}> => {
  const endsWithSlash = /\/$/;
  const { valid, hexChainId, details } = await validateEthRpc(
    data.url,
    isInCooldown
  );

  if (!valid) throw new Error('Invalid RPC.');

  const chainIdNumber = toDecimalFromHex(hexChainId);
  let explorer = '';
  if (details && !data.explorer) {
    explorer = details.explorers ? details.explorers[0].url : explorer;
  } else if (data.explorer) {
    explorer = data.explorer;
  }
  if (!endsWithSlash.test(explorer)) {
    explorer = explorer + '/';
  }
  if (!details && !data.symbol) throw new Error('Must define a symbol');
  const formattedNetwork = {
    url: data.url,
    default: false,
    label: data.label || String(details ? details.name : ''),
    apiUrl: data.apiUrl,
    explorer: String(explorer),
    currency: details ? details.nativeCurrency.symbol : data.symbol,
    chainId: chainIdNumber,
    slip44: 60, // All EVM networks use ETH slip44 for address compatibility
    kind: INetworkType.Ethereum,
  };

  return {
    formattedNetwork,
  };
};
/** end */

/** bitcoin-like rpc */
export const validateSysRpc = async (
  url: string
): Promise<{
  chain: string;
  coin: string;
  valid: boolean;
}> => {
  try {
    // Check cache first
    const cached = blockbookValidationCache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('[validateSysRpc] Returning cached result for', url);
      return cached.result;
    }

    const formatURL = `${url.endsWith('/') ? url.slice(0, -1) : url}/api/v2`;
    const response = await (await fetch(formatURL)).json();
    const {
      blockbook: { coin },
      backend: { chain },
    } = response;

    const valid = Boolean(response && coin);

    const result = {
      valid,
      coin,
      chain,
    };

    // Cache the result
    blockbookValidationCache.set(url, {
      result,
      timestamp: Date.now(),
    });

    return result;
  } catch (error) {
    throw new Error(error);
  }
};

// With proper slip44 in network configs, we don't need special testnet handling
// Each network (including testnets) has its own slip44 value

// TODO: type data with ICustomRpcParams later
// TODO: type return correctly
export const getSysRpc = async (data: any) => {
  try {
    const { valid, coin, chain } = await validateSysRpc(data.url);

    if (!valid) throw new Error('Invalid Trezor Blockbook Explorer URL');

    // Look up coin configuration directly - no special testnet handling
    const coinData = findCoin({ name: coin });
    if (!coinData) {
      throw new Error(`Coin configuration not found for ${coin}`);
    }

    // Get network config using the coin's slip44
    const networkConfig = getNetworkConfig(coinData.slip44, coin);

    let explorer: string | undefined = data.explorer;
    if (!explorer) {
      // We accept only trezor blockbook for UTXO chains, this method won't work for non trezor apis
      explorer = data.url.replace(/\/api\/v[12]/, ''); // trimming /api/v{number}/ from explorer
    }

    // Use coin's actual slip44/chainId - no testnet differentiation
    const formattedNetwork = {
      url: data.url,
      apiUrl: data.url, // apiURL and URL are the same for blockbooks explorer TODO: remove this field from UTXO networks
      explorer,
      currency: coin.toLowerCase(),
      label: data.label || coin,
      default: true,
      chainId: coinData.slip44, // Use coin's actual slip44 as chainId
      slip44: coinData.slip44,
      kind: INetworkType.Syscoin,
    };

    const rpc = {
      formattedNetwork,
      networkConfig,
    };

    return { rpc, coin, chain };
  } catch (error) {
    throw new Error(error);
  }
};
/** end */

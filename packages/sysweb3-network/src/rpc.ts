import bip44Constants from 'bip44-constants';
import { Chain, chains } from 'eth-chains';
import { hexlify } from 'ethers/lib/utils';

// import fetch from "node-fetch";

import { getNetworkConfig, toDecimalFromHex, INetwork } from './networks';

const hexRegEx = /^0x[0-9a-f]+$/iu;

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

  return { chainId: Number(data.result) };
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
  isTestnet: boolean;
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

    const ethTestnetsChainsIds = [5700, 80001, 11155111, 421611, 5, 69]; // Some ChainIds from Ethereum Testnets as Polygon Testnet, Goerli, Sepolia, etc.

    const isTestnet = details
      ? details.name.toLowerCase().includes('test')
      : ethTestnetsChainsIds.includes(chainId); // Fallback for RPCs that don't have details

    return {
      chainId,
      details,
      chain: details && details.chain ? details.chain : 'unknown',
      hexChainId,
      isTestnet,
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
  const { valid, hexChainId, details, isTestnet } = await validateEthRpc(
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
    isTestnet,
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
    const formatURL = `${url.endsWith('/') ? url.slice(0, -1) : url}/api/v2`;
    const response = await (await fetch(formatURL)).json();
    const {
      blockbook: { coin },
      backend: { chain },
    } = response;

    const valid = Boolean(response && coin);

    return {
      valid,
      coin,
      chain,
    };
  } catch (error) {
    throw new Error(error);
  }
};

// review keyring manager
export const getBip44Chain = (coin: string, isTestnet?: boolean) => {
  const bip44Coin = bip44Constants.find(
    (item: any) => item[2] === (isTestnet ? bip44Constants[1][2] : coin)
  );

  const coinTypeInDecimal = bip44Coin[0];
  const symbol = bip44Coin[1];

  const { valid, hexChainId } = validateChainId(coinTypeInDecimal);

  const isChainValid = bip44Coin && valid;

  const replacedCoinTypePrefix = hexChainId.replace('0x8', '');
  const chainId = toDecimalFromHex(replacedCoinTypePrefix);

  if (!isChainValid) {
    throw new Error(
      'RPC invalid. Not found in Trezor Blockbook list of RPCS. See https://github.com/satoshilabs/slips/blob/master/slip-0044.md for available networks.'
    );
  }

  return {
    nativeCurrency: {
      name: coin,
      symbol: symbol.toString().toLowerCase(),
      decimals: 8,
    },
    coinType: coinTypeInDecimal,
    chainId,
  };
};

// TODO: type data with ICustomRpcParams later
// TODO: type return correctly
export const getSysRpc = async (data: any) => {
  try {
    const { valid, coin, chain } = await validateSysRpc(data.url);

    if (!valid) throw new Error('Invalid Trezor Blockbook Explorer URL');

    // Use standard BIP44 approach for all networks - no special cases
    const { nativeCurrency, chainId } = getBip44Chain(coin, chain === 'test');
    const networkConfig = getNetworkConfig(chainId, coin);

    let explorer: string | undefined = data.explorer;
    if (!explorer) {
      // We accept only trezor blockbook for UTXO chains, this method won't work for non trezor apis
      explorer = data.url.replace(/\/api\/v[12]/, ''); // trimming /api/v{number}/ from explorer
    }

    const networkType = chain === 'test' ? 'testnet' : 'mainnet';
    const formattedNetwork = {
      url: data.url,
      apiUrl: data.url, // apiURL and URL are the same for blockbooks explorer TODO: remove this field from UTXO networks
      explorer,
      currency: nativeCurrency.symbol,
      label: data.label || coin,
      default: true,
      chainId,
      slip44: networkConfig.networks[networkType].slip44,
      isTestnet: chain === 'test',
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

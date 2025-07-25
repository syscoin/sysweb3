import { ethers } from 'ethers';

import { findCoin } from './coin-utils';

export const toHexFromNumber = (decimal: number) =>
  ethers.utils.hexlify(decimal);
export const toDecimalFromHex = (hexString: string) => parseInt(hexString, 16);

export const getPubType = (
  network: BitcoinNetwork
): { [type: string]: IPubTypes } => {
  const { private: _prv, public: _pub } = network.bip32;

  const pubString = String(_pub);
  const prvString = String(_prv);

  const xPubType = {
    mainnet: {
      zprv: prvString,
      zpub: pubString,
    },
    testnet: {
      vprv: prvString,
      vpub: pubString,
    },
  };

  const zPubType = {
    mainnet: { zprv: '04b2430c', zpub: '04b24746' },
    testnet: { vprv: '045f18bc', vpub: '045f1cf6' },
  };

  return {
    xPubType,
    zPubType,
  };
};

/**
 * Helper function to get network config directly from a coin object
 * This is more efficient when you already have the coin data
 */
export const getNetworkConfigFromCoin = (coin: any) => {
  if (!coin) {
    throw new Error('Coin object is required');
  }

  const {
    signedMessageHeader,
    bech32Prefix,
    xprvMagic,
    xpubMagic,
    addressType,
    addressTypeP2sh,
    wif,
    coinName,
    name,
    coinLabel,
  } = coin;

  const coinDisplayName = coinName || name || coinLabel || 'Unknown';

  const hexPubKeyHash = addressType;
  const hexScriptHash = addressTypeP2sh;

  if (bech32Prefix === null) {
    throw new Error(
      `We currently don't support ${coinDisplayName} as we don't have its bech32 prefix (or it doesn't support segwit)`
    );
  }

  // Each coin has its own network parameters - no testnet differentiation
  const network = {
    messagePrefix: String(signedMessageHeader).replace(/[\r\n]/gm, ''),
    bech32: String(bech32Prefix),
    bip32: {
      public: xpubMagic,
      private: xprvMagic,
    },
    pubKeyHash: hexPubKeyHash,
    scriptHash: hexScriptHash,
    slip44: coin.slip44,
    wif,
  };

  // For backward compatibility, provide both mainnet and testnet as the same
  const networks = {
    mainnet: network,
    testnet: network,
  };

  return {
    networks,
    types: getPubType(network) || null,
  };
};

export const getNetworkConfig = (slip44: number, coinName: string) => {
  try {
    // Use the shared findCoin utility
    const coin = findCoin({ slip44, name: coinName });

    if (!coin) {
      throw `${coinName} not supported, add its network config on coins.ts at Pali repo`;
    }

    // Use the helper function
    return getNetworkConfigFromCoin(coin);
  } catch (error) {
    throw new Error(error);
  }
};

export type Bip32 = {
  private: number;
  public: number;
};

export type BitcoinNetwork = {
  bech32: string;
  bip32: Bip32;
  messagePrefix: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
};

export type IPubTypes = {
  mainnet: { zprv: string; zpub: string };
};

export type INetwork = {
  apiUrl?: string;
  chainId: number;
  coingeckoId?: string;
  coingeckoPlatformId?: string;
  currency: string;
  default?: boolean;
  explorer?: string;
  key?: string;
  kind: INetworkType;
  label: string;
  slip44: number;
  url: string;
};

export enum INetworkType {
  Ethereum = 'ethereum',
  Syscoin = 'syscoin',
}

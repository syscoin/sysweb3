import { ethers } from 'ethers';

import { coins } from './coins';

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

export const getNetworkConfig = (slip44: number, coinName: string) => {
  try {
    const coin = coins.find(
      (supported: any) => supported.coinName === coinName
    );

    if (!(coin && coin.slip44 === slip44)) {
      throw `${coinName} not supported, add its network config on coins.ts at Pali repo`;
    }
    const {
      signedMessageHeader,
      bech32Prefix,
      xprvMagic,
      xpubMagic,
      addressType,
      addressTypeP2sh,
      wif,
    } = coin;

    const isTestnet = coin.name.toLowerCase().includes('test');

    const hexPubKeyHash = ethers.utils.hexlify(addressType);
    const hexScriptHash = ethers.utils.hexlify(addressTypeP2sh);
    if (bech32Prefix === null) {
      throw new Error(
        `We currently don't support ${coinName} as we don't have its bech32 prefix, please if you need it supported create a pr on sysweb3-network package adding it to coins.ts  `
      );
    }
    const baseNetwork = {
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

    const networks = {
      mainnet: baseNetwork,
      testnet: baseNetwork,
    };

    const useMainnet = networks.mainnet && !isTestnet;

    const networkChain = useMainnet ? networks.mainnet : networks.testnet;

    return {
      networks,
      types: getPubType(networkChain) || null,
    };
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
  pubKeyHash: string;
  scriptHash: string;
  wif: number;
};

export type IPubTypes = {
  mainnet: { zprv: string; zpub: string };
  testnet: { vprv: string; vpub: string };
};

export type INetwork = {
  apiUrl?: string;
  chainId: number;
  currency: string;
  default?: boolean;
  explorer?: string;
  isTestnet: boolean;
  key?: string;
  label: string;
  slip44: number;
  url: string;
};

export enum INetworkType {
  Ethereum = 'ethereum',
  Syscoin = 'syscoin',
}

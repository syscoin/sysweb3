import { bech32 } from 'bech32';
import { ethers } from 'ethers';

import { isContractAddress } from '.';
import { findCoin } from '@pollum-io/sysweb3-network';

export const isValidEthereumAddress = (address: string) =>
  ethers.utils.isAddress(address);

//TODO: this function needs to be refactorated to validate with descriptors in mind
export const isValidSYSAddress = (
  address: string,
  purpose: number, //From pali purpose is called chainId
  verification = true
) => {
  if (!verification) return true;

  // ? this if might be unnecessary
  if (address && typeof address === 'string') {
    try {
      const decodedAddr = bech32.decode(address);
      const prefix = decodedAddr.prefix?.toLowerCase();

      // Find the coin by chainId (purpose) using the shared utility
      const coin = findCoin({ slip44: purpose });

      if (coin && coin.bech32Prefix) {
        const expectedPrefix = coin.bech32Prefix.toLowerCase();

        if (prefix === expectedPrefix) {
          const encode = bech32.encode(decodedAddr.prefix, decodedAddr.words);
          return encode === address.toLowerCase();
        }
      } else {
        // Fallback for legacy Syscoin networks if not found in coins
        if (
          (purpose === 57 && prefix === 'sys') ||
          (purpose === 5700 && prefix === 'tsys')
        ) {
          const encode = bech32.encode(decodedAddr.prefix, decodedAddr.words);
          return encode === address.toLowerCase();
        }
      }
    } catch (error) {
      return false;
    }
  }

  return false;
};

export const validateEOAAddress = async (
  address: string,
  web3Provider: any
): Promise<IValidateEOAAddressResponse> => {
  const validateContract = await isContractAddress(address, web3Provider);

  if (validateContract) {
    return {
      contract: true,
      wallet: false,
    };
  } else {
    const validateEthAddress = isValidEthereumAddress(address);

    if (validateEthAddress) {
      return {
        contract: false,
        wallet: true,
      };
    }

    return {
      contract: undefined,
      wallet: undefined,
    };
  }
};

interface IValidateEOAAddressResponse {
  contract: boolean | undefined;
  wallet: boolean | undefined;
}

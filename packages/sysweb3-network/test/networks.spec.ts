import {
  VALID_BIP44_DATA_RESPONSE,
  VALID_BITCOIN_LIKE_NETWORK,
} from './constants';
import { getNetworkConfig, getPubType } from '../src/networks';

describe('networks tests', () => {
  it('should return formatted bitcoin like network for a given coin', () => {
    const {
      nativeCurrency: { name },
      chainId,
    } = VALID_BIP44_DATA_RESPONSE;

    const response = getNetworkConfig(chainId, name);

    expect(response.networks).toStrictEqual(
      VALID_BITCOIN_LIKE_NETWORK.networks
    );
  });

  it('should return pub types for a given coin', () => {
    const response = getPubType(VALID_BITCOIN_LIKE_NETWORK.networks.mainnet);

    expect(response).toStrictEqual(VALID_BITCOIN_LIKE_NETWORK.types);
  });
});

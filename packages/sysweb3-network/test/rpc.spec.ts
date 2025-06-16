import {
  CHAIN_ID_HEX,
  CHAIN_ID_NUMBER,
  RPC_URL,
  VALID_SYS_BLOCKBOOK_RESPONSE,
  VALID_ETH_RPC_RESPONSE,
  SYS_RPC_URL,
} from './constants';
import {
  isValidChainIdForEthNetworks,
  validateChainId,
  validateEthRpc,
  validateSysRpc,
} from '../src/rpc';
import 'isomorphic-fetch';

describe('rpc tests', () => {
  it('should check if given chain id is a safe integer and it is between 0 and 4503599627370476', () => {
    const isValid = isValidChainIdForEthNetworks(CHAIN_ID_NUMBER);

    expect(isValid).toBe(true);
  });

  it('should validate an ethereum chain id', () => {
    const isValid = validateChainId(CHAIN_ID_NUMBER);

    expect(isValid.valid).toBe(true);
    expect(isValid.hexChainId).toBe(CHAIN_ID_HEX);
  });

  it('should validate given eth rpc', async () => {
    const response = await validateEthRpc(RPC_URL, false);

    expect(response).toStrictEqual(VALID_ETH_RPC_RESPONSE);
  });

  it('should validate sys rpc', async () => {
    const response = await validateSysRpc(SYS_RPC_URL);

    expect(response).toStrictEqual(VALID_SYS_BLOCKBOOK_RESPONSE);
  });
});

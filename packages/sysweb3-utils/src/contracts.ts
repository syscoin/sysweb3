import { ethers, Contract, ContractInterface } from 'ethers';

import abi55 from './abi/erc1155.json';
import abi20 from './abi/erc20.json';
import abi21 from './abi/erc721.json';
import { getContractType, ISupportsInterfaceProps } from './getContract';

export const createContractUsingAbi = (
  AbiContract: ContractInterface,
  address: string,
  web3Provider: any
): Contract => new ethers.Contract(String(address), AbiContract, web3Provider);

export const isContractAddress = async (address: string, web3Provider: any) => {
  if (!address) return false;
  try {
    const code = await web3Provider.getCode(address);

    return Boolean(code !== '0x');
  } catch (error) {
    if (String(error).includes('bad address checksum')) return false;
    return false; // Return false for any other error
  }
};

export const contractChecker = async (
  contractAddress: string,
  web3Provider: any
): Promise<ISupportsInterfaceProps | ErrorConstructor> => {
  try {
    const validateContractAddress = await isContractAddress(
      contractAddress,
      web3Provider
    );

    if (!validateContractAddress)
      throw new Error(`Invalid contract address: ${contractAddress}`);

    const contractData = (await getContractType(
      contractAddress,
      web3Provider
    )) as ISupportsInterfaceProps;

    return contractData;
  } catch (error) {
    return error;
  }
};

export const getErc20Abi = () => abi20;

export const getErc21Abi = () => abi21;

export const getErc55Abi = () => abi55;

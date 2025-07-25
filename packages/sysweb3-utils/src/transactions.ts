import * as syscoinjs from 'syscoinjs-lib';

// import { web3Provider } from '@pollum-io/sysweb3-network';

export const txUtils = () => {
  const getRawTransaction = (explorerUrl: string, txid: string) =>
    syscoinjs.utils.fetchBackendRawTx(explorerUrl, txid);

  return {
    getRawTransaction,
    // getGasUsedInTransaction,
  };
};

export type ISyscoinVIn = {
  addresses: string[];
  isAddress: boolean;
  n: number;
  sequence: number;
  txid: string;
  value: number;
  vout: number;
};

export type ISyscoinVOut = {
  addresses: string[];
  hex: string;
  isAddress: boolean;
  n: number;
  spent: boolean;
  value: number;
};

export type ISyscoinTokenTxInfo = {
  tokenId: string;
  value: number;
  valueStr: string;
};

export type ISyscoinTransaction = {
  [txid: string]: {
    blockHash: string;
    blockHeight: number;
    blockTime: number;
    confirmations: number;
    fees: number;
    hex: string;
    tokenType: string;
    txid: string;
    value: number;
    valueIn: number;
    version: number;
    vin: ISyscoinVIn[];
    vout: ISyscoinVOut[];
  };
};

export type ITxid = { txid: string };

export type IETHTxConfig = {
  gasLimit?: number;
  gasPrice: number;
  memo?: string;
  nonce?: number;
  txData?: string;
};

export type IETHNetwork = 'testnet' | 'mainnet';

export interface IETHPendingTx {
  amount: string;
  assetId: string;
  data?: string;
  fromAddress: string;
  gasPrice: number;
  network: IETHNetwork;
  nonce: number;
  onConfirmed?: () => void;
  timestamp: number;
  toAddress: string;
  txHash: string;
}

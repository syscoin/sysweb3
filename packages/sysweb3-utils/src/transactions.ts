import * as syscoinjs from 'syscoinjs-lib';

import { ITokenMap, ISyscoinToken } from '.';
// import { web3Provider } from '@pollum-io/sysweb3-network';

export const txUtils = () => {
  const getRawTransaction = (explorerUrl: string, txid: string) => {
    return syscoinjs.utils.fetchBackendRawTx(explorerUrl, txid);
  };

  const getPsbtFromJson = (psbt: JSON): string => {
    //@ts-ignore
    return syscoinjs.utils.importPsbtFromJson(psbt);
  };

  const getTokenMap = ({
    guid,
    changeAddress,
    amount,
    receivingAddress,
  }: {
    guid: number | string;
    changeAddress: string;
    amount: number;
    receivingAddress: string;
  }): ITokenMap => {
    return new Map([
      [
        String(guid),
        {
          changeAddress,
          outputs: [
            {
              value: amount,
              address: receivingAddress,
            },
          ],
        },
      ],
    ]);
  };

  const getFeeRate = (fee: number): bigint => {
    return new syscoinjs.utils.BN(fee * 1e8);
  };

  return {
    getPsbtFromJson,
    getRawTransaction,
    getTokenMap,
    getFeeRate,
    // getGasUsedInTransaction,
  };
};

export type ISyscoinVIn = {
  txid: string;
  vout: number;
  sequence: number;
  n: number;
  addresses: string[];
  isAddress: boolean;
  value: number;
};

export type ISyscoinVOut = {
  value: number;
  n: number;
  spent: boolean;
  hex: string;
  addresses: string[];
  isAddress: boolean;
};

export type ISyscoinTokenTxInfo = {
  tokenId: string;
  value: number;
  valueStr: string;
};

export type ISyscoinTransaction = {
  [txid: string]: {
    blockTime: number;
    confirmations: number;
    fees: number;
    tokenType: string;
    txid: string;
    value: number;
    blockHash: string;
    blockHeight: number;
    valueIn: number;
    hex: string;
    version: number;
    vin: ISyscoinVIn[];
    vout: ISyscoinVOut[];
  };
};

export type ITxid = { txid: string };

export type ITransactionInfo = {
  amount: number;
  fee: number;
  fromAddress: string;
  rbf: boolean;
  toAddress: string;
  token: ISyscoinToken | null;
};

export type ITokenSend = {
  amount: number;
  fee: number;
  isToken: boolean;
  rbf?: boolean;
  receivingAddress: string;
  sender: string;
  token: { symbol: string; guid: string };
};

export type ITemporaryTransaction = {
  sendAsset: ITokenSend | null;
  signAndSendPSBT: any | null;
  signPSBT: any | null;
};

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

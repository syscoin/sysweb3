import { Version } from 'eth-sig-util';

export interface IUTXOMethods {
  getUtxoAddress: ({
    coin,
    index,
    slip44,
  }: {
    coin: string;
    index: number;
    slip44: number;
  }) => Promise<string>;
  getXpub: ({
    index,
    coin,
    slip44,
  }: {
    coin: string;
    index: number;
    slip44: number;
  }) => Promise<string>;
  verifyUtxoAddress: (
    accountIndex: number,
    currency: string,
    slip44: number
  ) => Promise<string>;
}

interface MessageTypeProperty {
  name: string;
  type: string;
}
export interface MessageTypes {
  [additionalProperties: string]: MessageTypeProperty[];
  EIP712Domain: MessageTypeProperty[];
}

export interface IEvmMethods {
  getEvmAddressAndPubKey: ({
    accountIndex,
  }: {
    accountIndex: number;
  }) => Promise<{
    address: string;
    publicKey: string;
  }>;
  signEVMTransaction: ({
    rawTx,
    accountIndex,
  }: {
    accountIndex: number;
    rawTx: string;
  }) => Promise<{
    r: string;
    s: string;
    v: string;
  }>;
  signPersonalMessage: ({
    message,
    accountIndex,
  }: {
    accountIndex: number;
    message: string;
  }) => Promise<string>;
  signTypedData: ({
    version,
    data,
    accountIndex,
  }: {
    accountIndex: number;
    data: any;
    version: Version;
  }) => Promise<string>;
}

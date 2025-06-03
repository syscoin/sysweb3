import { TransactionResponse } from '@ethersproject/abstract-provider';
import { TypedData, TypedMessage } from 'eth-sig-util';
import { ethers, BigNumber, BigNumberish } from 'ethers';
import { CustomJsonRpcProvider, CustomL2JsonRpcProvider } from 'providers';
import {
  EncryptedKeystoreV3Json,
  Sign,
  SignedTransaction,
  TransactionConfig,
} from 'web3-core';

import { LedgerKeyring } from './ledger';
import { TrezorKeyring } from './trezor';
import { INetwork, INetworkType } from '@pollum-io/sysweb3-network';
import { ITokenSend, ITxid } from '@pollum-io/sysweb3-utils';

export interface ITrezorWallet {
  createHardwareWallet: () => Promise<IKeyringAccountState>;
}

export interface ISendTransaction {
  sender: string;
  receivingAddress: string;
  amount: number;
  gasLimit?: number;
  gasPrice?: number;
  token?: any;
}
export type SimpleTransactionRequest = {
  to: string;
  from: string;
  nonce?: ethers.BigNumberish;
  gasLimit?: ethers.BigNumberish;
  gasPrice?: ethers.BigNumberish;

  data?: ethers.BytesLike;
  value?: ethers.BigNumberish;
  chainId: number;

  type?: number;
  accessList?: ethers.utils.AccessListish;

  maxPriorityFeePerGas: ethers.BigNumberish;
  maxFeePerGas: ethers.BigNumberish;

  customData?: Record<string, any>;
  ccipReadEnabled?: boolean;
  v?: string;
  r?: string;
  s?: string;
};

export declare type Version = 'V1' | 'V2' | 'V3' | 'V4';

export interface IEthereumTransactions {
  signTypedData: (
    addr: string,
    typedData: TypedData | TypedMessage<any>,
    version: Version
  ) => Promise<string>;
  ethSign: (params: string[]) => Promise<string>;
  signPersonalMessage: (params: string[]) => Promise<string>;
  parsePersonalMessage: (hexMsg: string) => string;
  decryptMessage: (msgParams: string[]) => string;
  verifyPersonalMessage: (msg: string, sign: string) => string;
  verifyTypedSignature: (
    data: TypedData | TypedMessage<any>,
    signature: string,
    version: Version
  ) => string;
  cancelSentTransaction: (
    txHash: string,
    isLegacy?: boolean
  ) => Promise<{
    isCanceled: boolean;
    transaction?: TransactionResponse;
    error?: boolean;
  }>;
  sendTransaction: (data: ISendTransaction) => Promise<TransactionResponse>;
  sendFormattedTransaction: (
    params: SimpleTransactionRequest,
    isLegacy?: boolean
  ) => Promise<TransactionResponse>;
  sendTransactionWithEditedFee: (
    txHash: string,
    isLegacy?: boolean
  ) => Promise<{
    isSpeedUp: boolean;
    transaction?: TransactionResponse;
    error?: boolean;
  }>;
  getRecommendedNonce: (address: string) => Promise<number>;
  getFeeByType: (type: string) => Promise<string>;
  getFeeDataWithDynamicMaxPriorityFeePerGas: () => Promise<any>;
  getGasLimit: (toAddress: string) => Promise<number>;
  getTxGasLimit: (tx: SimpleTransactionRequest) => Promise<ethers.BigNumber>;
  getRecommendedGasPrice: (formatted?: boolean) => Promise<
    | string
    | {
        gwei: string;
        ethers: string;
      }
  >;
  getGasOracle?: () => Promise<any>;
  getEncryptedPubKey: () => string;
  toBigNumber: (aBigNumberish: string | number) => ethers.BigNumber;
  sendSignedErc20Transaction: ({
    networkUrl,
    receiver,
    tokenAddress,
    tokenAmount,
  }: ISendSignedErcTransactionProps) => Promise<IResponseFromSendErcSignedTransaction>;

  sendSignedErc721Transaction: ({
    networkUrl,
    receiver,
    tokenAddress,
    tokenId,
  }: ISendSignedErcTransactionProps) => Promise<IResponseFromSendErcSignedTransaction>;

  sendSignedErc1155Transaction: ({
    receiver,
    tokenAddress,
    tokenId,
    isLegacy,
    gasPrice,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }: ISendSignedErcTransactionProps) => Promise<IResponseFromSendErcSignedTransaction>;

  getBalance: (address: string) => Promise<number>;
  getErc20TokensByAddress?: (
    address: string,
    isSupported: boolean,
    apiUrl: string
  ) => Promise<any[]>;
  setWeb3Provider: (network: INetwork) => void;
  importAccount: (mnemonicOrPrivKey: string) => ethers.Wallet;
  web3Provider: CustomJsonRpcProvider | CustomL2JsonRpcProvider;
  contentScriptWeb3Provider: CustomJsonRpcProvider | CustomL2JsonRpcProvider;
}

export interface ISyscoinTransactions {
  getEstimateSysTransactionFee: ({
    amount,
    receivingAddress,
  }: {
    amount: number;
    receivingAddress: string;
  }) => Promise<number>;
  getRecommendedFee: (explorerUrl: string) => Promise<number>;
  sendTransaction: (
    transaction: ITokenSend,
    isTrezor: boolean,
    isLedger: boolean
  ) => Promise<ITxid>;
  signTransaction: (
    data: { psbt: string; assets: string },
    isSendOnly: boolean,
    pathIn?: string
  ) => Promise<any>;
}

export interface IKeyringManager {
  addNewAccount: (label?: string) => Promise<IKeyringAccountState>;
  createKeyringVault: () => Promise<IKeyringAccountState>;
  forgetMainWallet: (password: string) => void;
  getAccountById: (
    id: number,
    accountType: KeyringAccountType
  ) => Omit<IKeyringAccountState, 'xprv'>;
  getAccountXpub: () => string;
  getEncryptedXprv: () => string;
  importTrezorAccount(
    coin: string,
    slip44: string,
    index: string
  ): Promise<IKeyringAccountState>;
  getNetwork: () => INetwork;
  getPrivateKeyByAccountId: (
    id: number,
    acountType: KeyringAccountType,
    pwd: string
  ) => string;
  getSeed: (password: string) => string;
  unlock: (
    password: string,
    isForPvtKey?: boolean
  ) => Promise<{
    canLogin: boolean;
    wallet?: IWalletState | null;
  }>;
  isUnlocked: () => boolean;
  logout: () => void;
  ledgerSigner: LedgerKeyring;
  trezorSigner: TrezorKeyring;
  setActiveAccount: (
    accountId: number,
    accountType: KeyringAccountType
  ) => void;
  setSignerNetwork: (
    network: INetwork,
    chain: string
  ) => Promise<{
    sucess: boolean;
    wallet?: IWalletState;
    activeChain?: INetworkType;
  }>;
  addCustomNetwork: (chain: INetworkType, network: INetwork) => void;
  removeNetwork: (
    chain: INetworkType,
    chainId: number,
    rpcUrl: string,
    label: string,
    key?: string
  ) => void;
  updateNetworkConfig: (network: INetwork, chainType: INetworkType) => void;
  setWalletPassword: (password: string) => void;
  isSeedValid: (seed: string) => boolean;
  setSeed: (seed: string) => void;
  createNewSeed: () => string;
  setStorage: (client: any) => void;
  ethereumTransaction: IEthereumTransactions;
  syscoinTransaction: ISyscoinTransactions;
  verifyIfIsTestnet: () => boolean | undefined;
  updateAccountLabel: (
    label: string,
    accountId: number,
    accountType: KeyringAccountType
  ) => void;
  utf8Error: boolean;
  validateZprv: (
    zprv: string,
    targetNetwork?: INetwork
  ) => IValidateZprvResponse;
}

export enum KeyringAccountType {
  Trezor = 'Trezor',
  Imported = 'Imported',
  HDAccount = 'HDAccount',
  Ledger = 'Ledger',
}

export type IKeyringDApp = {
  id: number;
  url: string;
  active: boolean;
};

export type accountType = {
  [id: number]: IKeyringAccountState;
};

export interface IWalletState {
  accounts: { [key in KeyringAccountType]: accountType };
  activeAccountId: number;
  activeAccountType: KeyringAccountType;
  networks: {
    [INetworkType.Ethereum]: {
      [chainId: number | string]: INetwork;
    };
    [INetworkType.Syscoin]: {
      [chainId: number | string]: INetwork;
    };
  };
  activeNetwork: INetwork;
}

export type IKeyringBalances = {
  [INetworkType.Syscoin]: number;
  [INetworkType.Ethereum]: number;
};

export interface IWeb3Account extends IKeyringAccountState {
  signTransaction: (
    transactionConfig: TransactionConfig,
    callback?: (signTransaction: SignedTransaction) => void
  ) => Promise<SignedTransaction>;
  sign: (data: string) => Sign;
  encrypt: (password: string) => EncryptedKeystoreV3Json;
}

type IsBitcoinBased = {
  isBitcoinBased?: boolean;
};

type IOriginNetwork = INetwork & IsBitcoinBased;

interface INetworkParams {
  messagePrefix: string;
  bech32: string;
  bip32: {
    public: number;
    private: number;
  };
  pubKeyHash: number;
  scriptHash: number;
  slip44: number;
  wif: number;
}

interface IValidateZprvResponse {
  isValid: boolean;
  message: string;
  node?: any;
  network?: INetworkParams | null;
}

export interface IKeyringAccountState {
  address: string;
  id: number;
  isTrezorWallet: boolean;
  isLedgerWallet: boolean;
  label: string;
  xprv: string;
  balances: IKeyringBalances;
  xpub: string;
  isImported: boolean;
  originNetwork?: IOriginNetwork;
}

export interface ISyscoinBackendAccount {
  page: number;
  totalPages: number;
  itemsOnPage: number;
  address: string;
  balance: string;
  totalReceived: string;
  totalSent: string;
  unconfirmedBalance: string;
  unconfirmedTxs: number;
  txs: number;
}

export interface ILatestUpdateForSysAccount {
  xpub: any;
  balances: {
    syscoin: number;
    ethereum: number;
  };
  receivingAddress: any;
}

export interface ISendSignedErcTransactionProps {
  networkUrl: string;
  receiver: string;
  tokenAddress: string;
  isLegacy?: boolean;
  maxPriorityFeePerGas?: BigNumberish;
  maxFeePerGas?: BigNumberish;
  gasPrice?: BigNumberish;
  gasLimit?: BigNumberish;
  tokenAmount?: string;
  decimals?: number;
  tokenId?: number;
  saveTrezorTx?: (tx: any) => void;
}

export interface IResponseFromSendErcSignedTransaction {
  type: number;
  chainId: number;
  nonce: number;
  maxPriorityFeePerGas: BigNumber;
  maxFeePerGas: BigNumber;
  gasPrice: BigNumber | null;
  gasLimit: BigNumber;
  to: string;
  value: BigNumber;
  data: string;
  accessList: any[];
  hash: string;
  v: number | null;
  r: string;
  s: string;
  from: string;
  confirmations: number | null;
  wait: any;
}

export interface IGasParams {
  maxFeePerGas?: BigNumber;
  maxPriorityFeePerGas?: BigNumber;
  gasPrice?: BigNumber;
  gasLimit?: BigNumber;
}

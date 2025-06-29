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
import { SyscoinHDSigner } from './signers';
import { TrezorKeyring } from './trezor';
import { INetwork, INetworkType } from '@pollum-io/sysweb3-network';
import { ITxid } from '@pollum-io/sysweb3-utils';

export interface ITrezorWallet {
  createHardwareWallet: () => Promise<IKeyringAccountState>;
}

export interface ISendTransaction {
  amount: number;
  gasLimit?: number;
  gasPrice?: number;
  receivingAddress: string;
  sender: string;
  token?: any;
}
export type SimpleTransactionRequest = {
  accessList?: ethers.utils.AccessListish;
  ccipReadEnabled?: boolean;
  chainId: number;
  customData?: Record<string, any>;
  data?: ethers.BytesLike;

  from: string;
  gasLimit?: ethers.BigNumberish;
  gasPrice?: ethers.BigNumberish;

  maxFeePerGas: ethers.BigNumberish;
  maxPriorityFeePerGas: ethers.BigNumberish;

  nonce?: ethers.BigNumberish;
  r?: string;

  s?: string;
  to: string;
  type?: number;
  v?: string;
  value?: ethers.BigNumberish;
};

export declare type Version = 'V1' | 'V2' | 'V3' | 'V4';

export interface IEthereumTransactions {
  cancelSentTransaction: (
    txHash: string,
    isLegacy?: boolean
  ) => Promise<{
    error?: boolean;
    isCanceled: boolean;
    transaction?: TransactionResponse;
  }>;
  contentScriptWeb3Provider: CustomJsonRpcProvider | CustomL2JsonRpcProvider;
  decryptMessage: (msgParams: string[]) => string;
  ethSign: (params: string[]) => Promise<string>;
  getBalance: (address: string) => Promise<number>;
  getEncryptedPubKey: () => string;
  getErc20TokensByAddress?: (
    address: string,
    isSupported: boolean,
    apiUrl: string
  ) => Promise<any[]>;
  getFeeByType: (type: string) => Promise<string>;
  getFeeDataWithDynamicMaxPriorityFeePerGas: () => Promise<any>;
  getGasLimit: (toAddress: string) => Promise<number>;
  getGasOracle?: () => Promise<any>;
  getRecommendedNonce: (address: string) => Promise<number>;
  signTypedData: (
    addr: string,
    typedData: TypedData | TypedMessage<any>,
    version: Version
  ) => Promise<string>;
  sendTransaction: (data: ISendTransaction) => Promise<TransactionResponse>;
  importAccount: (mnemonicOrPrivKey: string) => ethers.Wallet;
  parsePersonalMessage: (hexMsg: string) => string;
  sendFormattedTransaction: (
    params: SimpleTransactionRequest,
    isLegacy?: boolean
  ) => Promise<TransactionResponse>;
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
  verifyPersonalMessage: (msg: string, sign: string) => string;
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

  sendTransactionWithEditedFee: (
    txHash: string,
    isLegacy?: boolean
  ) => Promise<{
    isSpeedUp: boolean;
    transaction?: TransactionResponse;
    error?: boolean;
  }>;

  signPersonalMessage: (params: string[]) => Promise<string>;
  verifyTypedSignature: (
    data: TypedData | TypedMessage<any>,
    signature: string,
    version: Version
  ) => string;
  setWeb3Provider: (network: INetwork) => void;
  getRecommendedGasPrice: (formatted?: boolean) => Promise<
    | string
    | {
        ethers: string;
        gwei: string;
      }
  >;
  web3Provider: CustomJsonRpcProvider | CustomL2JsonRpcProvider;
  getTxGasLimit: (tx: SimpleTransactionRequest) => Promise<ethers.BigNumber>;
}

/**
 * Error structure for Syscoin transaction operations.
 * This interface documents the error format that consumers (like Pali) should expect
 * when catching errors from ISyscoinTransactions methods.
 *
 * @example
 * try {
 *   const result = await syscoinTransaction.getEstimateSysTransactionFee({...});
 * } catch (error: unknown) {
 *   const sysError = error as ISyscoinTransactionError;
 *   if (sysError.code === 'INSUFFICIENT_FUNDS') {
 *     console.log(`Short by ${sysError.shortfall} SYS`);
 *   }
 * }
 */
export interface ISyscoinTransactionError {
  error: boolean;
  code:
    | 'INSUFFICIENT_FUNDS'
    | 'INVALID_FEE_RATE'
    | 'INVALID_AMOUNT'
    | 'INVALID_MEMO'
    | 'INVALID_BLOB'
    | 'INVALID_OUTPUT_COUNT'
    | 'INVALID_ASSET_ALLOCATION'
    | 'INVALID_PARENT_NODES'
    | 'INVALID_TX_VALUE'
    | 'INVALID_RECEIPT_VALUE'
    | 'SUBTRACT_FEE_FAILED'
    | 'TRANSACTION_CREATION_FAILED'
    | 'TRANSACTION_SEND_FAILED';
  message: string;
  fee?: number; // in SYS (not satoshis)
  remainingFee?: number; // in SYS (not satoshis)
  shortfall?: number; // in SYS (not satoshis)
  details?: {
    inputTotal?: any; // BN object in satoshis
    outputTotal?: any; // BN object in satoshis
    requiredFee?: any; // BN object in satoshis
    message?: string; // Additional context about the error
    markedOutputs?: number; // For SUBTRACT_FEE_FAILED
    removedOutputs?: number; // For SUBTRACT_FEE_FAILED
    guid?: string; // For INVALID_ASSET_ALLOCATION
  };
}

export interface ISyscoinTransactions {
  getEstimateSysTransactionFee: ({
    txOptions,
    amount,
    receivingAddress,
    feeRate,
    token,
    isMax,
  }: {
    amount: number;
    feeRate?: number;
    receivingAddress: string;
    token?: { guid: string; symbol?: string } | null;
    txOptions?: any;
    isMax?: boolean | false;
  }) => Promise<{ fee: number; psbt: any }>; // Returns UNSIGNED psbt - may throw ISyscoinTransactionError
  getRecommendedFee: (explorerUrl: string) => Promise<number>;
  decodeRawTransaction: (psbtOrHex: any, isRawHex?: boolean) => any;
  // Sign PSBT separately
  sendTransaction: (psbt: any) => Promise<ITxid>;
  signPSBT: ({
    psbt,
    isTrezor,
    isLedger,
    pathIn,
  }: {
    isLedger?: boolean;
    isTrezor?: boolean;
    pathIn?: string;
    psbt: any;
  }) => Promise<any>;
}

export interface IKeyringManager {
  // Core keyring functionality
  addNewAccount: (label?: string) => Promise<IKeyringAccountState>;
  ethereumTransaction: IEthereumTransactions;
  forgetMainWallet: (pwd: string) => void;
  getAccountById: (
    id: number,
    accountType: KeyringAccountType
  ) => Omit<IKeyringAccountState, 'xprv'>;
  getAccountXpub: () => string;
  getEncryptedXprv: (hd: SyscoinHDSigner) => string;
  unlock: (
    password: string,
    isForPvtKey?: boolean
  ) => Promise<{
    canLogin: boolean;
  }>;
  isUnlocked: () => boolean;
  logout: () => void;
  ledgerSigner: LedgerKeyring;
  trezorSigner: TrezorKeyring;
  setSignerNetwork: (network: INetwork) => Promise<{
    success: boolean;
  }>;
  getPrivateKeyByAccountId: (
    id: number,
    accountType: KeyringAccountType,
    pwd: string
  ) => Promise<string>;
  setStorage: (client: any) => void;
  syscoinTransaction: ISyscoinTransactions;
  isSeedValid: (seedPhrase: string) => boolean;
  getSeed: (pwd: string) => Promise<string>;
  importTrezorAccount: (label?: string) => Promise<IKeyringAccountState>;
  utf8Error: boolean;
  validateZprv: (
    zprv: string,
    targetNetwork?: INetwork
  ) => IValidateZprvResponse;
  // Account management
  importAccount: (
    privKey: string,
    label?: string
  ) => Promise<IKeyringAccountState>;
  getNewChangeAddress: () => Promise<string>;
  getChangeAddress: (id: number) => Promise<string>;
  updateReceivingAddress: () => Promise<string>;
  getActiveAccount: () => {
    activeAccount: Omit<IKeyringAccountState, 'xprv'>;
    activeAccountType: KeyringAccountType;
  };
  importWeb3Account: (mnemonicOrPrivKey: string) => any;
  createNewSeed: () => string;
  getUTXOState: () => any;
  importLedgerAccount: (
    isAlreadyConnected: boolean,
    label?: string
  ) => Promise<IKeyringAccountState | undefined>;
  getActiveUTXOAccountState: () => any;
  createEthAccount: (privateKey: string) => any;
  getAddress: (xpub: string, isChangeAddress: boolean) => Promise<string>;
  // Secure initialization and password management
  initializeWalletSecurely: (
    seedPhrase: string,
    password: string,
    prvPassword?: string
  ) => Promise<IKeyringAccountState>;
  // NEW: Separated initialization methods
  initializeSession: (seedPhrase: string, password: string) => Promise<void>;
  createFirstAccount: (label?: string) => Promise<IKeyringAccountState>;
  transferSessionTo: (targetKeyring: IKeyringManager) => void;
  receiveSessionOwnership: (sessionPassword: any, sessionMnemonic: any) => void;
  lockWallet: () => void;
  // NEW: Store access for stateless keyring
  setVaultStateGetter: (getter: () => any) => void;
}

export enum KeyringAccountType {
  HDAccount = 'HDAccount',
  Imported = 'Imported',
  Ledger = 'Ledger',
  Trezor = 'Trezor',
}

export type IKeyringDApp = {
  active: boolean;
  id: number;
  url: string;
};

export type accountType = {
  [id: number]: IKeyringAccountState;
};

export type IKeyringBalances = {
  [INetworkType.Syscoin]: number;
  [INetworkType.Ethereum]: number;
};

export interface IWeb3Account extends IKeyringAccountState {
  encrypt: (password: string) => EncryptedKeystoreV3Json;
  sign: (data: string) => Sign;
  signTransaction: (
    transactionConfig: TransactionConfig,
    callback?: (signTransaction: SignedTransaction) => void
  ) => Promise<SignedTransaction>;
}

interface INetworkParams {
  bech32: string;
  bip32: {
    private: number;
    public: number;
  };
  messagePrefix: string;
  pubKeyHash: number;
  scriptHash: number;
  slip44: number;
  wif: number;
}

interface IValidateZprvResponse {
  isValid: boolean;
  message: string;
  network?: INetworkParams | null;
  node?: any;
}

export interface IKeyringAccountState {
  address: string;
  balances: IKeyringBalances;
  id: number;
  isImported: boolean;
  isLedgerWallet: boolean;
  isTrezorWallet: boolean;
  label: string;
  xprv: string;
  xpub: string;
}

export interface ISyscoinBackendAccount {
  address: string;
  balance: string;
  itemsOnPage: number;
  page: number;
  totalPages: number;
  totalReceived: string;
  totalSent: string;
  txs: number;
  unconfirmedBalance: string;
  unconfirmedTxs: number;
}

export interface ILatestUpdateForSysAccount {
  balances: {
    ethereum: number;
    syscoin: number;
  };
  receivingAddress: any;
  xpub: any;
}

export interface ISendSignedErcTransactionProps {
  decimals?: number;
  gasLimit?: BigNumberish;
  gasPrice?: BigNumberish;
  isLegacy?: boolean;
  maxFeePerGas?: BigNumberish;
  maxPriorityFeePerGas?: BigNumberish;
  networkUrl: string;
  receiver: string;
  saveTrezorTx?: (tx: any) => void;
  tokenAddress: string;
  tokenAmount?: string;
  tokenId?: number;
}

export interface IResponseFromSendErcSignedTransaction {
  accessList: any[];
  chainId: number;
  confirmations: number | null;
  data: string;
  from: string;
  gasLimit: BigNumber;
  gasPrice: BigNumber | null;
  hash: string;
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
  nonce: number;
  r: string;
  s: string;
  to: string;
  type: number;
  v: number | null;
  value: BigNumber;
  wait: any;
}

export interface IGasParams {
  gasLimit?: BigNumber;
  gasPrice?: BigNumber;
  maxFeePerGas?: BigNumber;
  maxPriorityFeePerGas?: BigNumber;
}

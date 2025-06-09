import { BIP32Interface } from 'bip32';
import { Psbt } from 'bitcoinjs-lib';
import * as syscoinjs from 'syscoinjs-lib';

import {
  BitcoinNetwork,
  IPubTypes,
  INetwork,
} from '@pollum-io/sysweb3-network';

export const getSyscoinSigners = ({
  mnemonic,
  isTestnet,
  rpc,
}: ISyscoinSignerParams): { hd: SyscoinHDSigner; main: any } => {
  const { url } = rpc.formattedNetwork;
  let config: BitcoinNetwork | null = null;
  let pubTypes: IPubTypes | null = null;
  let networks: { mainnet: BitcoinNetwork; testnet: BitcoinNetwork } | null =
    null;

  // Use explicit SLIP44 from network configuration - all networks now have correct slip44 values
  const slip44 = rpc.formattedNetwork.slip44;

  if (rpc.networkConfig) {
    const { networkConfig } = rpc;

    const { networks: _networkConfig, types } = networkConfig;

    config = isTestnet ? _networkConfig.testnet : _networkConfig.mainnet;

    networks = _networkConfig;
    pubTypes = types.zPubType;
  }
  // @ts-ignore
  const hd: SyscoinHDSigner = new syscoinjs.utils.HDSigner(
    mnemonic,
    null,
    isTestnet,
    networks,
    slip44,
    pubTypes,
    84
  );

  const main: any = new syscoinjs.SyscoinJSLib(hd, url, config);

  return {
    hd,
    main,
  };
};

export type SyscoinHdAccount = {
  isTestnet: boolean;
  network: BitcoinNetwork;
  networks: {
    mainnet: BitcoinNetwork;
    testnet: BitcoinNetwork;
  };
  pubTypes: IPubTypes;
  zprv: string;
};

export interface Bip84FromMnemonic {
  deriveAccount: () => string;
  getRootPrivateKey: () => string;
  getRootPublicKey: () => string;
}

export type ISyscoinSignerParams = {
  isTestnet: boolean;
  mnemonic: string;
  rpc: {
    formattedNetwork: INetwork;
    networkConfig?: {
      networks: { mainnet: BitcoinNetwork; testnet: BitcoinNetwork };
      types: { xPubType: IPubTypes; zPubType: IPubTypes };
    };
  };
};

export type IMainSignerParams = {
  hd: SyscoinHDSigner;
  network?: BitcoinNetwork;
  url: string;
};

export interface SyscoinHDSigner {
  Signer: {
    SLIP44: number;
    accountIndex: number;
    accounts: any;
    blockbookURL: string;
    changeIndex: number;
    isTestnet: boolean;
    network: BitcoinNetwork;
    networks: { mainnet: BitcoinNetwork; testnet: BitcoinNetwork };
    password: string | null;
    pubTypes: IPubTypes;
    receivingIndex: number;
    setIndexFlag: number;
  };
  backup: () => void;
  blockbookURL: string;
  // Already async
  createAccount: (bipNum?: number, zprv?: string) => number;
  createAddress: (
    addressIndex: number,
    isChange: boolean,
    bipNum?: number
  ) => string;
  createKeypair: (addressIndex: number, isChange: boolean) => BIP32Interface;
  deriveAccount: (index: number, bipNum?: number) => string;
  deriveKeypair: (keypath: string) => BIP32Interface;
  derivePubKey: (keypath: string) => string;
  // Updated signature
  getAccountXpub: () => string;
  getAddressFromKeypair: (keypair: BIP32Interface) => string;
  getAddressFromPubKey: (pubkey: string) => string;
  getHDPath: (
    addressIndex: number,
    isChange: boolean,
    bipNum?: number
  ) => string; // Already async
  getNewReceivingAddress: (
    skipIncrement?: boolean,
    bipNum?: number
  ) => Promise<string>;
  // Added new property for import method tracking
  node: {
    seed: Buffer;
    isTestnet: boolean;
    coinType: number;
    pubTypes: IPubTypes;
    network: BitcoinNetwork;
  };
  setAccountIndex: (accountIndex: number) => void;
  getRootNode: () => BIP32Interface;
  // Updated to reflect the enhanced property name
  importMethod: string;
  signPSBT: ({
    psbt,
    isTrezor,
    isLedger,
    pathIn,
  }: {
    psbt: string;
    isTrezor?: boolean;
    isLedger?: boolean;
    pathIn?: string;
  }) => Promise<string>;
  getNewChangeAddress: (
    skipIncrement?: boolean,
    bipNum?: number
  ) => Promise<string>;
  restore: (password: string, bipNum?: number) => boolean;
  mnemonicOrZprv: string;
  setLatestIndexesFromXPubTokens: (tokens: any) => void;
  // Made async
  sign: (psbt: Psbt, pathIn?: string) => Promise<Psbt>;
  // Made async
  getMasterFingerprint: () => Buffer;
}

export type SyscoinMainSigner = {
  Signer: SyscoinHDSigner;
  blockbookURL: string;
  network: BitcoinNetwork;
};

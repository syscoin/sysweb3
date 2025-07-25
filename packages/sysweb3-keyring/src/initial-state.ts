import { getDefaultUTXONetworks } from './network-utils';
import { IKeyringAccountState } from './types';
import { INetworkType } from '@pollum-io/sysweb3-network';

export const initialActiveHdAccountState: IKeyringAccountState = {
  address: '',
  balances: {
    ethereum: 0,
    syscoin: 0,
  },
  id: 0,
  isTrezorWallet: false,
  isLedgerWallet: false,
  label: 'Account 1',
  xprv: '',
  xpub: '',
  isImported: false,
};

export const initialActiveImportedAccountState: IKeyringAccountState = {
  ...initialActiveHdAccountState,
  isImported: true,
};

export const initialActiveTrezorAccountState: IKeyringAccountState = {
  ...initialActiveHdAccountState,
  isTrezorWallet: true,
  isLedgerWallet: false,
};

export const initialActiveLedgerAccountState: IKeyringAccountState = {
  ...initialActiveHdAccountState,
  isLedgerWallet: true,
  isTrezorWallet: false,
};

export const initialNetworksState = {
  syscoin: getDefaultUTXONetworks(),
  ethereum: {
    1: {
      chainId: 1,
      url: 'https://rpc.ankr.com/eth',
      label: 'Ethereum Mainnet',
      default: false,
      currency: 'eth',
      explorer: 'https://etherscan.io',
      apiUrl: 'https://api.etherscan.io/api',
      slip44: 60,
      kind: INetworkType.Ethereum,
    },
    137: {
      chainId: 137,
      currency: 'matic',
      default: false,
      label: 'Polygon Mainnet',
      url: 'https://polygon-rpc.com',
      apiUrl: 'https://api.polygonscan.com/api',
      explorer: 'https://polygonscan.com',
      slip44: 60,
      kind: INetworkType.Ethereum,
    },
    80001: {
      chainId: 80001,
      currency: 'matic',
      default: false,
      label: 'Mumbai Testnet',
      url: 'https://endpoints.omniatech.io/v1/matic/mumbai/public',
      apiUrl: 'https://api-testnet.polygonscan.com/api',
      explorer: 'https://mumbai.polygonscan.com',
      slip44: 60,
      kind: INetworkType.Ethereum,
    },
    57: {
      chainId: 57,
      currency: 'sys',
      default: true,
      label: 'Syscoin NEVM',
      url: 'https://rpc.syscoin.org',
      apiUrl: 'https://explorer.syscoin.org/api',
      explorer: 'https://explorer.syscoin.org',
      slip44: 60,
      kind: INetworkType.Ethereum,
    },
    570: {
      chainId: 570,
      currency: 'sys',
      default: true,
      label: 'Rollux',
      url: 'https://rpc.rollux.com',
      apiUrl: 'https://explorer.rollux.com/api',
      explorer: 'https://explorer.rollux.com',
      slip44: 60,
      kind: INetworkType.Ethereum,
    },
    5700: {
      chainId: 5700,
      currency: 'tsys',
      default: false,
      label: 'Tanenbaum Testnet',
      url: 'https://rpc.tanenbaum.io',
      apiUrl: 'https://explorer.tanenbaum.io/api',
      explorer: 'https://explorer.tanenbaum.io',
      slip44: 60,
      kind: INetworkType.Ethereum,
    },
  },
};

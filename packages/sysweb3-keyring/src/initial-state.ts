import {
  IKeyringAccountState,
  IWalletState,
  KeyringAccountType,
} from './types';

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
  syscoin: {
    57: {
      chainId: 57,
      label: 'Syscoin Mainnet',
      url: 'https://explorer-blockbook.syscoin.org',
      default: true,
      currency: 'sys',
      apiUrl: '',
      explorer: 'https://explorer-blockbook.syscoin.org',
      slip44: 57,
      isTestnet: false,
    },
    5700: {
      chainId: 5700,
      label: 'Syscoin Testnet',
      url: 'https://explorer-blockbook-dev.syscoin.org',
      default: true,
      currency: 'tsys',
      apiUrl: '',
      explorer: '',
      slip44: 1,
      isTestnet: true,
    },
  },
  ethereum: {
    1: {
      chainId: 1,
      url: 'https://rpc.ankr.com/eth',
      label: 'Ethereum Mainnet',
      default: false,
      currency: 'eth',
      explorer: 'https://etherscan.io',
      apiUrl: 'https://api.etherscan.io/api',
      isTestnet: false,
    },
    137: {
      chainId: 137,
      currency: 'matic',
      default: false,
      label: 'Polygon Mainnet',
      url: 'https://polygon-rpc.com',
      apiUrl: 'https://api.polygonscan.com/api',
      explorer: 'https://polygonscan.com',
      isTestnet: false,
    },
    80001: {
      chainId: 80001,
      currency: 'matic',
      default: false,
      label: 'Mumbai Testnet',
      url: 'https://endpoints.omniatech.io/v1/matic/mumbai/public',
      apiUrl: 'https://api-testnet.polygonscan.com/api',
      explorer: 'https://mumbai.polygonscan.com',
      isTestnet: true,
    },
    57: {
      chainId: 57,
      currency: 'sys',
      default: true,
      label: 'Syscoin NEVM',
      url: 'https://rpc.syscoin.org',
      apiUrl: 'https://explorer.syscoin.org/api',
      explorer: 'https://explorer.syscoin.org',
      isTestnet: false,
    },
    570: {
      chainId: 570,
      currency: 'sys',
      default: true,
      label: 'Rollux',
      url: 'https://rpc.rollux.com',
      apiUrl: 'https://explorer.rollux.com/api',
      explorer: 'https://explorer.rollux.com',
      isTestnet: false,
    },
    5700: {
      chainId: 5700,
      currency: 'tsys',
      default: false,
      label: 'Tanenbaum Testnet',
      url: 'https://rpc.tanenbaum.io',
      apiUrl: 'https://explorer.tanenbaum.io/api',
      explorer: 'https://explorer.tanenbaum.io',
      isTestnet: true,
    },
  },
};

export const initialWalletState: IWalletState = {
  accounts: {
    [KeyringAccountType.HDAccount]: {
      [initialActiveHdAccountState.id]: initialActiveHdAccountState,
    },
    [KeyringAccountType.Imported]: {
      [initialActiveImportedAccountState.id]: initialActiveImportedAccountState,
    },
    [KeyringAccountType.Trezor]: {
      [initialActiveTrezorAccountState.id]: initialActiveTrezorAccountState,
    },
    [KeyringAccountType.Ledger]: {
      [initialActiveTrezorAccountState.id]: initialActiveLedgerAccountState,
    },
  },
  activeAccountId: 0,
  activeAccountType: KeyringAccountType.HDAccount,
  networks: initialNetworksState,
  activeNetwork: {
    chainId: 57,
    label: 'Syscoin Mainnet',
    url: 'https://explorer-blockbook.syscoin.org',
    explorer: 'https://explorer-blockbook.syscoin.org',
    default: true,
    currency: 'sys',
    isTestnet: false,
  },
};

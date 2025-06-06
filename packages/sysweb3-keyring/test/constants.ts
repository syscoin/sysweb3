import * as dotenv from 'dotenv';

import { initialNetworksState } from '../src/initial-state';
import { IWalletState, KeyringAccountType } from '../src/types';
dotenv.config();
export const FAKE_PASSWORD = 'Asdqwe123!';
export const FAKE_INVALID_PASSWORD = '12345';
export const POLYGON_MUMBAI_NETWORK = {
  chainId: 80001,
  currency: 'MATIC',
  default: true,
  label: 'Polygon Mumbai',
  url: 'https://rpc.ankr.com/polygon_mumbai',
  apiUrl: 'https://api-testnet.polygonscan.com/api',
  explorer: 'https://mumbai.polygonscan.com/',
  isTestnet: true,
};
export const SYS_EVM_NETWORK = {
  chainId: 57,
  currency: 'sys',
  default: true,
  label: 'Syscoin Mainnet',
  url: 'https://rpc.syscoin.org',
  apiUrl: 'https://explorer.syscoin.org/api',
  explorer: 'https://explorer.syscoin.org/',
  isTestnet: false,
};
export const SYS_TANENBAUM_UTXO_NETWORK = {
  chainId: 5700,
  label: 'Syscoin Testnet',
  url: 'https://sys-test.tk/',
  default: true,
  currency: 'tsys',
  apiUrl: '',
  explorer: '',
  isTestnet: true,
};

export const BTC_TESTNET_TOKEN = {
  chainId: 57,
  label: 'Bitcoin Testnet',
  url: 'https://blockbook.syscoin.org/',
  default: true,
  currency: 'sys',
  apiUrl: '',
  explorer: 'https://blockbook.syscoin.org/',
  isTestnet: true,
};

export const SYS_MAINNET_UTXO_NETWORK = {
  chainId: 57,
  label: 'Syscoin Mainnet',
  url: 'https://blockbook.syscoin.org/',
  default: true,
  currency: 'sys',
  isTestnet: false,
};

export const SYS_TESTNET_UTXO_ADDRESS =
  'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4';

export const DATA: { [type: string]: any } = {
  send: {
    amount: 1,
    fee: 0.00001,
    token: null,
    isToken: false,
    rbf: true,
  },
  sign: {
    psbt: 'cHNidP8BANmCAAAAAXV1yEYFkSVeffIhpGoiJeEYWdwHtfutBmNrQq9Y3+yXAgAAAAD/////A6AJAQAAAAAAFgAUZMBLT7xge2bLcHuAmhtOdCUnv4kA4fUFAAAAAF9qTFwCg7Wg6XcBAAAAhsNAAQIJAAjBCGNHRnNhVEU9CTt7ImRlc2MiOiJjR0ZzYVNCa1pXMXZJR1JoY0hBZ2RHOXJaVzRnWTNKbFlYUmxJSFJsYzNRZ01RPT0ifQB/APS5PDADAAAAFgAUtji2FZyTh0hQCpxBnA47GNrn9fQAAAAAAAEBH/R8NzYDAAAAFgAUTTxsbg+2G8pcJY7dAQcZx1QtYHEBCGsCRzBEAiB8cJut6NP2IOGiFgAD2/0YM2otMAgvYlY51VyEoYWl0gIgYHXg85w1sJsHXuklbBYFarSVeYAuxoCIeU39HkLiO+IBIQKDuln5k6NYVB+eI+UIS6GMvaICoPDxp892khDysiiybgdhZGRyZXNzLHRzeXMxcWY1N3hjbXMwa2NkdTVocDkzbXdzenBjZWNhMno2Y3IzcjNjamNzBHBhdGgSbS84NCcvMScvMCcvMS8xNjU0AAAAAA==',
    assets: '[]',
  },
  signAndSend: {
    psbt: 'cHNidP8BANmCAAAAAXV1yEYFkSVeffIhpGoiJeEYWdwHtfutBmNrQq9Y3+yXAgAAAAD/////A6AJAQAAAAAAFgAUZMBLT7xge2bLcHuAmhtOdCUnv4kA4fUFAAAAAF9qTFwCg7Wg6XcBAAAAhsNAAQIJAAjBCGNHRnNhVEU9CTt7ImRlc2MiOiJjR0ZzYVNCa1pXMXZJR1JoY0hBZ2RHOXJaVzRnWTNKbFlYUmxJSFJsYzNRZ01RPT0ifQB/APS5PDADAAAAFgAUtji2FZyTh0hQCpxBnA47GNrn9fQAAAAAAAEBH/R8NzYDAAAAFgAUTTxsbg+2G8pcJY7dAQcZx1QtYHEBCGsCRzBEAiB8cJut6NP2IOGiFgAD2/0YM2otMAgvYlY51VyEoYWl0gIgYHXg85w1sJsHXuklbBYFarSVeYAuxoCIeU39HkLiO+IBIQKDuln5k6NYVB+eI+UIS6GMvaICoPDxp892khDysiiybgdhZGRyZXNzLHRzeXMxcWY1N3hjbXMwa2NkdTVocDkzbXdzenBjZWNhMno2Y3IzcjNjamNzBHBhdGgSbS84NCcvMScvMCcvMS8xNjU0AAAAAA==',
    assets: '[]',
  },
};

export const FAKE_PRIVATE_KEY_ACCOUNT_ADDRESS =
  process.env.PRIVATE_KEY_ACCOUNT_ADDRESS ||
  '0x742d35Cc6634C0532925a3b844Bc9e7595f8b2c0';
export const FAKE_PRIVATE_KEY =
  process.env.PRIVATE_KEY_ACCOUNT ||
  '0x1234567890123456789012345678901234567890123456789012345678901234';
export const PEACE_SEED_PHRASE =
  process.env.SEED_PEACE_GLOBE ||
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const HEALTH_SEED_PHRASE =
  process.env.SEED_SWALLOW_HEALTH ||
  'health swallow abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const SEED_ACCOUNT_ADDRESS_AT_EVM =
  process.env.SEED_ACCOUNT_ADDRESS_AT_EVM ||
  '0x9fB29AAc15b9A4B7F17c3385939b007540f4d791';
export const SEED_ACCOUNT_ADDRESS_AT_UTX0 =
  process.env.SEED_ACCOUNT_ADDRESS_AT_UTX0 ||
  'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4';
export const SECOND_FAKE_SEED_PHRASE =
  'gauge gauge gauge gauge gauge gauge gauge gauge gauge gauge gauge gauge';
export const INVALID_SEED_PHRASE =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
export const FAKE_ADDRESS = '0x4d4DB937177Ceb77aF4541b4EC9Ae8b0EA5d1a64';
export const FAKE_PRIV_KEY =
  '0x27cf026f5657ad3403b767f16e0c46eeaa03fe0ff1903ad5a84d448263255a2b';
export const TX: any = {
  to: '0xaaf791cc2cb91527c4aa2ac52c8af97150685840',
  from: '0x1FEdCaf5b29259a24C79D3Dfec099b4766AD9ca4',
  nonce: 0,
  value: '0x9a2241af62c0000',
  type: 2,
  chainId: 57,
  // v: '0x1',
  // r: '0xe48cd40bae42146f44d4d8caab1edd2f19ec5a136db3f4e3f6678441afa23b3',
  // s: '0x739de80ac6b7c4c478b0669faa44282848445e16c110271de4ec0501bfeaabb7',
};
const account0 = {
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
const imp0 = {
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
  isImported: true,
};
const trezorAcc0 = {
  address: '',
  balances: {
    ethereum: 0,
    syscoin: 0,
  },
  id: 0,
  isTrezorWallet: true,
  isLedgerWallet: false,
  label: 'Trezor 1',
  xprv: '',
  xpub: '',
  isImported: false,
};
const ethAcc0 = {
  address: '0x6a92ef94f6db88098625a30396e0fde7255e97d5',
  xpub: '0x8d5466dc6f075d8c90ce7a84f03fc9ac608109e976fd133dce0bfbb85748c0ab78328ee292d43b1f2c9a642def96bf891a54eb43d345ee9dad9c6688ed2e3eb4',
  xprv: 'U2FsdGVkX19ryI/42IJW7ER13/UNdMHlnSmFG5UV9s3LSe4IfN/85d5hAWu9vEoS/Ts8wTLTM/7ev/9uvHabpaKrSqMLiMukz3RiWpmU9BOAMyg02dnkXiy9qptKMrb2',
  isImported: false,
  id: 0,
  isTrezorWallet: false,
  isLedgerWallet: false,
  label: 'Account 1',
  balances: { syscoin: 0, ethereum: 0 },
};
export const previousWalletState: IWalletState = {
  accounts: {
    [KeyringAccountType.HDAccount]: {
      [0]: account0,
    },
    [KeyringAccountType.Imported]: {
      [0]: imp0,
    },
    [KeyringAccountType.Trezor]: {
      [0]: trezorAcc0,
    },
    [KeyringAccountType.Ledger]: {},
  },
  activeAccountId: 0,
  activeAccountType: KeyringAccountType.HDAccount,
  networks: initialNetworksState,
  activeNetwork: {
    chainId: 57,
    label: 'Syscoin Mainnet',
    url: 'https://blockbook.syscoin.org/',
    default: true,
    currency: 'sys',
    isTestnet: false,
  },
};

export const secPreviousWalletState: IWalletState = {
  accounts: {
    [KeyringAccountType.HDAccount]: {
      [0]: ethAcc0,
    },
    [KeyringAccountType.Imported]: {
      [0]: imp0,
    },
    [KeyringAccountType.Trezor]: {
      [0]: trezorAcc0,
    },
    [KeyringAccountType.Ledger]: {},
  },
  activeAccountId: 0,
  activeAccountType: KeyringAccountType.HDAccount,
  networks: initialNetworksState,
  activeNetwork: POLYGON_MUMBAI_NETWORK,
};

export const mockVault = {
  password: FAKE_PASSWORD,
  encryptedMnemonic: 'encrypted_mnemonic_mock',
  encryptedPrivateKeys: {},
};

// Support information for different Trezor models
export interface CoinSupport {
  connect: boolean;
  suite: boolean;
  trezor1?: string;
  trezor2?: string;
}

// Fee structure for different priority levels
export interface DefaultFeeB {
  economy?: number;
  high?: number;
  low?: number;
  normal?: number;
}

// Blockchain link configuration
export interface BlockchainLink {
  type: string;
  url: string | string[];
}

// Comprehensive coin type definition
export interface Coin {
  addressType: number;
  addressTypeP2sh: number;
  bech32Prefix: string | null;
  blockchainLink: BlockchainLink | null;
  blocktimeSeconds: number;
  cashaddrPrefix: string | null;
  chainId?: number; // Optional unique chain identifier
  coinLabel: string;
  coinName: string;
  coinShortcut: string;
  curveName: string;
  decimals: number;
  decred: boolean;
  default?: boolean;
  defaultFeeB: DefaultFeeB;
  dustLimit: number;
  extraData: boolean;
  forceBip143: boolean;
  forkId: number | null;
  hashGenesisBlock: string;
  maxAddressLength: number;
  maxfeeKb: number;
  minAddressLength: number;
  minfeeKb: number;
  name: string;
  segwit: boolean;
  shortcut: string;
  signedMessageHeader: string;
  slip44: number;
  support: CoinSupport;
  taproot: boolean;
  timestamp: boolean;
  xprvMagic: number;
  xpubMagic: number;
  xpubMagicMultisigSegwitNative: number | null;
  xpubMagicMultisigSegwitP2sh: number | null;
  xpubMagicSegwitNative: number | null;
  xpubMagicSegwitP2sh: number | null;
  wif: number;
}

// Export the coins array type
export type CoinsArray = Coin[];

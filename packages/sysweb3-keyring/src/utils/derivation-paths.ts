// Import coins data from the relative package in the monorepo
import { coins } from '@pollum-io/sysweb3-network';
const getCoinsData = () => {
  try {
    return coins || [];
  } catch (error) {
    console.error(
      'Failed to load coins from @pollum-io/sysweb3-network:',
      error
    );
    return [];
  }
};

/**
 * Get coin information by coin shortcut or slip44
 * Priority: 1) Check if slip44=60 or 61 (EVM), 2) Check coins.ts (UTXO), 3) Default to unknown
 */
export function getCoinInfo(coinShortcut: string, slip44: number) {
  const coinKey = coinShortcut.toLowerCase();

  // CRITICAL: If slip44 is 60 or 61, it's ALWAYS EVM
  // slip44=60: Ethereum and most EVM-compatible networks (BSC, Polygon, Arbitrum, etc.)
  // slip44=61: Ethereum Classic (ETC)
  // This must be checked FIRST to prevent any UTXO coin conflicts
  if (slip44 === 60 || slip44 === 61) {
    return {
      slip44,
      segwit: false,
      isEvm: true,
    };
  }

  // Second, check UTXO coins from coins.ts (comprehensive database)
  const coins = getCoinsData();
  const coin = coins.find(
    (c: any) =>
      c.coinShortcut?.toLowerCase() === coinKey ||
      c.shortcut?.toLowerCase() === coinKey ||
      c.coinName?.toLowerCase() === coinKey
  );

  if (coin) {
    return {
      slip44: coin.slip44,
      segwit: coin.segwit || false,
      isEvm: false, // UTXO coins from coins.ts are not EVM
    };
  }

  // Third, if searching by slip44, check remaining UTXO coins (slip44=60,61 already handled above)
  if (slip44 !== undefined) {
    const coinBySlip44 = coins.find((c: any) => c.slip44 === slip44);
    if (coinBySlip44) {
      return {
        slip44: coinBySlip44.slip44,
        segwit: coinBySlip44.segwit || false,
        isEvm: false,
      };
    }
  }

  // For unknown slip44 values, we cannot safely assume EVM
  // Return as unknown/unsupported rather than defaulting to EVM
  return {
    slip44,
    segwit: false,
    isEvm: false, // Changed from true to false - unknown slip44 should not default to EVM
  };
}

/**
 * Determine if a coin is EVM-based (Ethereum-like)
 */
export function isEvmCoin(coinShortcut: string, slip44: number): boolean {
  const coinInfo = getCoinInfo(coinShortcut, slip44);
  return coinInfo.isEvm;
}

/**
 * Determine if a coin uses SegWit (BIP84 - m/84')
 */
export function isSegwitCoin(coinShortcut: string, slip44: number): boolean {
  const coinInfo = getCoinInfo(coinShortcut, slip44);
  return coinInfo.segwit === true;
}

/**
 * Determine if a coin uses legacy derivation (BIP44 - m/44')
 */
export function isLegacyCoin(coinShortcut: string, slip44: number): boolean {
  return !isSegwitCoin(coinShortcut, slip44);
}

/**
 * Get the appropriate BIP standard for a coin
 */
export function getBipStandard(coinShortcut: string, slip44: number): number {
  if (isEvmCoin(coinShortcut, slip44)) {
    return 44; // EVM coins use BIP44
  }

  if (isSegwitCoin(coinShortcut, slip44)) {
    return 84; // SegWit coins use BIP84
  }

  return 44; // Default to BIP44 for legacy coins
}

/**
 * Generate derivation path for account level (ending with account index)
 * Example: m/84'/57'/0' for Syscoin account derivation
 */
export function getAccountDerivationPath(
  coinShortcut: string,
  slip44: number,
  accountIndex = 0
): string {
  const bip = getBipStandard(coinShortcut, slip44);
  return `m/${bip}'/${slip44}'/${accountIndex}'`;
}

/**
 * Generate derivation path for address level (full path to specific address)
 * Example: m/84'/57'/0'/0/0 for first address of first Syscoin account
 */
export function getAddressDerivationPath(
  coinShortcut: string,
  slip44: number,
  accountIndex = 0,
  isChangeAddress = false,
  addressIndex = 0
): string {
  const bip = getBipStandard(coinShortcut, slip44);

  if (isEvmCoin(coinShortcut, slip44)) {
    // EVM coins typically use: m/44'/60'/0'/0/addressIndex
    return `m/${bip}'/${slip44}'/0'/0/${addressIndex}`;
  } else {
    // UTXO coins use: m/84'/slip44'/account'/change/addressIndex
    const changeValue = isChangeAddress ? 1 : 0;
    return `m/${bip}'/${slip44}'/${accountIndex}'/${changeValue}/${addressIndex}`;
  }
}

/**
 * Generate derivation path for public key derivation (typically account level + change level)
 * Example: m/84'/57'/0'/0 for Syscoin receive addresses
 */
export function getPublicKeyDerivationPath(
  coinShortcut: string,
  slip44: number,
  accountIndex = 0,
  isChangeAddress = false
): string {
  const bip = getBipStandard(coinShortcut, slip44);

  if (isEvmCoin(coinShortcut, slip44)) {
    // EVM coins: m/44'/60'/0'/0
    return `m/${bip}'/${slip44}'/0'/0`;
  } else {
    // UTXO coins: m/84'/slip44'/account'/change
    const changeValue = isChangeAddress ? 1 : 0;
    return `m/${bip}'/${slip44}'/${accountIndex}'/${changeValue}`;
  }
}

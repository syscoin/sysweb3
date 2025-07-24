// Import coins data from the relative package in the monorepo
import { findCoin } from '@pollum-io/sysweb3-network';

/**
 * Get coin information by coin shortcut or slip44
 * Priority: 1) Check if slip44=60 (EVM), 2) Check coins.ts (UTXO), 3) Default to unknown
 */
export function getCoinInfo(coinShortcut: string, slip44: number) {
  // slip44=60: Ethereum and most EVM-compatible networks (BSC, Polygon, Arbitrum, etc.)
  // This must be checked FIRST to prevent any UTXO coin conflicts
  if (slip44 === 60) {
    return {
      slip44,
      segwit: false,
      isEvm: true,
    };
  }

  // Use the shared findCoin utility to search for UTXO coins
  const coin = findCoin({ slip44, name: coinShortcut });

  if (coin) {
    return {
      slip44: coin.slip44,
      segwit: coin.segwit || false,
      isEvm: false, // UTXO coins from coins.ts are not EVM
    };
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

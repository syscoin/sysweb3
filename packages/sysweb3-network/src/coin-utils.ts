import { coins } from './coins';

export interface CoinSearchOptions {
  slip44?: number;
  name?: string;
  exactMatch?: boolean;
}

/**
 * Find a coin by slip44 and/or name fields
 * This is the common search logic used by getNetworkConfig and getCoinInfo
 *
 * @param options - Search options
 * @returns The found coin or undefined
 */
export function findCoin(options: CoinSearchOptions): any {
  const { slip44, name, exactMatch = false } = options;

  if (slip44 === undefined && !name) {
    return undefined;
  }

  // Helper function to check if name matches any coin variations
  const nameMatches = (coin: any, searchName: string): boolean => {
    const variations = getCoinNameVariations(coin);
    return variations.some(
      (variation) => variation.toLowerCase() === searchName.toLowerCase()
    );
  };

  // First try to find by both slip44 AND name (most precise)
  if (slip44 !== undefined && name) {
    const coin = coins.find(
      (c: any) => c.slip44 === slip44 && nameMatches(c, name)
    );

    if (coin) return coin;
  }

  // If exactMatch is true, don't fall back to partial matches
  if (exactMatch) {
    return undefined;
  }

  // Second, try to find by name only
  if (name) {
    const coin = coins.find((c: any) => nameMatches(c, name));
    if (coin) return coin;
  }

  // Finally, fall back to slip44 only
  if (slip44 !== undefined) {
    return coins.find((c: any) => c.slip44 === slip44);
  }

  return undefined;
}

/**
 * Check if a coin exists by slip44
 */
export function coinExistsBySlip44(slip44: number): boolean {
  return coins.some((c: any) => c.slip44 === slip44);
}

/**
 * Get all coin name variations for a coin
 * Useful for display or matching purposes
 */
export function getCoinNameVariations(coin: any): string[] {
  const variations: string[] = [];

  if (coin.coinName) variations.push(coin.coinName);
  if (coin.name && coin.name !== coin.coinName) variations.push(coin.name);
  if (coin.coinShortcut) variations.push(coin.coinShortcut);
  if (coin.shortcut && coin.shortcut !== coin.coinShortcut)
    variations.push(coin.shortcut);
  if (coin.coinLabel && !variations.includes(coin.coinLabel))
    variations.push(coin.coinLabel);

  return variations;
}

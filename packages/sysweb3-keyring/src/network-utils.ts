import {
  INetwork,
  INetworkType,
  coins as utxoCoins,
} from '@pollum-io/sysweb3-network';

/**
 * Generate default UTXO networks from coins.ts data
 * This ensures consistency and avoids hardcoded duplicates
 */
export function getDefaultUTXONetworks(): { [chainId: number]: INetwork } {
  const defaultNetworks: { [chainId: number]: INetwork } = {};

  // Filter coins that should be default networks
  const defaultCoins = utxoCoins.filter((coin) => {
    // Include Syscoin mainnet and testnet as defaults
    return (
      (coin.coinShortcut === 'SYS' && coin.slip44 === 57) || // Syscoin Mainnet
      (coin.coinShortcut === 'tSYS' && coin.slip44 === 1) // Syscoin Testnet
    );
  });

  defaultCoins.forEach((coin) => {
    if (
      !coin.blockchainLink ||
      !coin.blockchainLink.url ||
      coin.blockchainLink.url.length === 0
    ) {
      return; // Skip coins without valid blockbook URLs
    }

    // Use primary blockbook URL
    const primaryUrl = Array.isArray(coin.blockchainLink.url)
      ? coin.blockchainLink.url[0]
      : coin.blockchainLink.url;

    const chainId = (coin as any).chainId || coin.slip44;

    const network: INetwork = {
      chainId,
      url: primaryUrl,
      label: coin.coinLabel || coin.name || `${coin.coinShortcut} Network`,
      default: coin.coinShortcut === 'SYS',
      currency: coin.coinShortcut?.toLowerCase() || 'unknown',
      slip44: coin.slip44,
      kind: INetworkType.Syscoin,
    };

    defaultNetworks[chainId] = network;
  });

  return defaultNetworks;
}

/**
 * Get specific default UTXO networks for backwards compatibility
 */
export function getSyscoinUTXOMainnetNetwork(): INetwork {
  const networks = getDefaultUTXONetworks();
  // Find Syscoin mainnet (slip44: 57)
  const syscoinMainnet = Object.values(networks).find(
    (network) => network.slip44 === 57 && network.currency === 'sys'
  );

  if (!syscoinMainnet) {
    throw new Error('Syscoin UTXO Mainnet network not found in coins.ts');
  }

  return syscoinMainnet;
}

export function getSyscoinUTXOTestnetNetwork(): INetwork {
  const networks = getDefaultUTXONetworks();
  // Find Syscoin testnet (slip44: 1, currency: tsys)
  const syscoinTestnet = Object.values(networks).find(
    (network) => network.slip44 === 1 && network.currency === 'tsys'
  );

  if (!syscoinTestnet) {
    throw new Error('Syscoin UTXO Testnet network not found in coins.ts');
  }

  return syscoinTestnet;
}

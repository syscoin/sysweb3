import bip44Constants from 'bip44-constants';

export const getFormattedBip44Coins = () => {
  const bip44FormattedCoins = bip44Constants.map(
    ([coinType, symbol, name]: IBip44Coin): IBip44FormattedCoin => ({
      coinType,
      symbol,
      name,
    })
  );

  const bip44Coins = bip44FormattedCoins.reduce(
    (prev: IBip44Coin, current: IBip44FormattedCoin) => ({
      ...prev,
      [current.name]: current,
    }),
    {}
  );

  return bip44Coins;
};

export type IBip44Coin = [number, string, string];
export type IBip44FormattedCoin = {
  coinType: number;
  name: string;
  symbol: string;
};

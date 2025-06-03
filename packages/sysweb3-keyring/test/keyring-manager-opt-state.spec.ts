import {
  FAKE_PASSWORD,
  PEACE_SEED_PHRASE,
  previousWalletState,
  secPreviousWalletState,
} from './constants';
import { KeyringManager } from '../src/keyring-manager';
import { INetworkType } from '@pollum-io/sysweb3-network';
/**
 * export interface IkeyringManagerOpts {
  wallet?: IWalletState | null;
  activeChain?: INetworkType | null;
  //todo: other props
}
 */

/**
 * export interface IWalletState {
  accounts: { [key in KeyringAccountType]: accountType };
  activeAccountId: number;
  activeAccountType: KeyringAccountType;
  networks: {
    [INetworkType.Ethereum]: {
      [chainId: number | string]: INetwork;
    };
    [INetworkType.Syscoin]: {
      [chainId: number | string]: INetwork;
    };
  };
  activeNetwork: INetwork;
}
 */

/** network chain opt
 * export enum INetworkType {
  Ethereum = 'ethereum',
  Syscoin = 'syscoin',
}
 wallet: IWalletState;
  activeChain: INetworkType;
  mnemonic?: string;
  password?: string;
 */
describe('testing functions for the new-sys txs', () => {
  //--------------------------------------------------------Tests for initialize wallet state----------------------------------------------------

  it('should initialize a new keyring with syscoin as the active chain and unlock it', async () => {
    const keyringManager = new KeyringManager({
      wallet: previousWalletState,
      activeChain: INetworkType.Syscoin,
    });

    // Properly set up the wallet
    keyringManager.setSeed(String(PEACE_SEED_PHRASE));
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    const activeChain = keyringManager.activeChain;
    expect(activeChain).toBe(INetworkType.Syscoin);

    keyringManager.lockWallet();
    const right = await keyringManager.unlock(FAKE_PASSWORD);
    expect(right.canLogin).toBe(true);
    const xpub = await keyringManager.getAccountXpub();
    expect(xpub).toBeDefined();
    expect(xpub.substring(1, 4)).toEqual('pub');
  });

  it('should initialize a new keyring with ethereum as the active chain', async () => {
    const keyringManager = new KeyringManager({
      wallet: secPreviousWalletState,
      activeChain: INetworkType.Ethereum,
    });

    // Properly set up the wallet
    keyringManager.setSeed(String(PEACE_SEED_PHRASE));
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set the network to Ethereum after creating the vault
    await keyringManager.setSignerNetwork(
      secPreviousWalletState.activeNetwork,
      INetworkType.Ethereum
    );

    const activeChain = keyringManager.activeChain;
    expect(activeChain).toBe(INetworkType.Ethereum);

    keyringManager.lockWallet();
    const right = await keyringManager.unlock(FAKE_PASSWORD);
    expect(right.canLogin).toBe(true);

    // After switching to Ethereum, the xpub should be an Ethereum public key
    const xpub = await keyringManager.getAccountXpub();
    expect(xpub).toBeDefined();
    expect(xpub.substring(0, 2)).toEqual('0x');
  });
});

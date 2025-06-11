import ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory } from 'bip32';
import { generateMnemonic, validateMnemonic, mnemonicToSeed } from 'bip39';
import BIP84 from 'bip84';
import * as bjs from 'bitcoinjs-lib';
import bs58check from 'bs58check';
import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import { hdkey } from 'ethereumjs-wallet';
import { ethers } from 'ethers';
import mapValues from 'lodash/mapValues';
import omit from 'lodash/omit';
import * as syscoinjs from 'syscoinjs-lib';

import {
  initialActiveImportedAccountState,
  initialActiveLedgerAccountState,
  initialActiveTrezorAccountState,
  initialWalletState,
} from './initial-state';
import { LedgerKeyring } from './ledger';
import { CustomJsonRpcProvider } from './providers';
import {
  getSyscoinSigners,
  SyscoinHDSigner,
  SyscoinMainSigner,
} from './signers';
import { getDecryptedVault, setEncryptedVault } from './storage';
import { EthereumTransactions, SyscoinTransactions } from './transactions';
import { TrezorKeyring } from './trezor';
import {
  IKeyringAccountState,
  IKeyringBalances,
  ISyscoinTransactions,
  IWalletState,
  KeyringAccountType,
  IEthereumTransactions,
  IKeyringManager,
  accountType,
} from './types';
import { getAddressDerivationPath, isEvmCoin } from './utils/derivation-paths';
import * as sysweb3 from '@pollum-io/sysweb3-core';
import {
  BitcoinNetwork,
  getSysRpc,
  IPubTypes,
  INetwork,
  INetworkType,
  getNetworkConfig,
  clearRpcCaches,
} from '@pollum-io/sysweb3-network';

export interface ISysAccount {
  address: string;
  balances: IKeyringBalances;
  label?: string;
  xprv?: string;
  xpub: string;
}

export interface IkeyringManagerOpts {
  activeChain: INetworkType;
  password?: string;
  wallet: IWalletState;
}

export interface ISysAccountWithId extends ISysAccount {
  id: number;
}

// Dynamic ETH HD path generation - will be computed as needed

export class KeyringManager implements IKeyringManager {
  public trezorSigner: TrezorKeyring;
  public ledgerSigner: LedgerKeyring;
  public activeChain: INetworkType;
  public initialTrezorAccountState: IKeyringAccountState;
  public initialLedgerAccountState: IKeyringAccountState;
  public utf8Error: boolean;
  //transactions objects
  public ethereumTransaction: IEthereumTransactions;
  public syscoinTransaction: ISyscoinTransactions;
  wallet: IWalletState; //todo change this name, we will use wallets for another const -> Maybe for defaultInitialState / defaultStartState;
  private storage: any; //todo type
  //local variables
  private hd: SyscoinHDSigner | null;
  private syscoinSigner: SyscoinMainSigner | undefined;
  private memMnemonic: string;
  private memPassword: string;
  private currentSessionSalt: string;
  private sessionPassword: string;
  private sessionMnemonic: string; // can be a mnemonic or a zprv, can be changed to a zprv when using an imported wallet
  private sessionMainMnemonic: string; // mnemonic of the main account, does not change
  private sessionSeed: string;
  // Separate account caches for ETH and UTXO to prevent interference
  private ethAccountsCache: { [key in KeyringAccountType]?: accountType } = {};
  private utxoAccountsCache: { [key in KeyringAccountType]?: accountType } = {};

  constructor(opts?: IkeyringManagerOpts | null) {
    this.storage = sysweb3.sysweb3Di.getStateStorageDb();
    this.currentSessionSalt = this.generateSalt();
    this.sessionPassword = '';
    this.storage.set('utf8Error', {
      hasUtf8Error: false,
    });
    if (opts) {
      this.wallet = opts.wallet;
      // Defensive: Ensure all account type objects exist for migration compatibility
      if (!this.wallet.accounts[KeyringAccountType.Imported]) {
        this.wallet.accounts[KeyringAccountType.Imported] = {};
      }
      if (!this.wallet.accounts[KeyringAccountType.Trezor]) {
        this.wallet.accounts[KeyringAccountType.Trezor] = {};
      }
      if (!this.wallet.accounts[KeyringAccountType.Ledger]) {
        this.wallet.accounts[KeyringAccountType.Ledger] = {};
      }
      this.activeChain = opts.activeChain;
      this.hd = null;
    } else {
      this.wallet = initialWalletState;
      this.activeChain = INetworkType.Syscoin;
      this.hd = null;
    }
    this.utf8Error = false;
    this.memMnemonic = '';
    this.sessionSeed = '';
    this.sessionMnemonic = '';
    this.sessionMainMnemonic = '';
    this.memPassword = ''; //Lock wallet in case opts.password has been provided
    this.initialTrezorAccountState = initialActiveTrezorAccountState;
    this.initialLedgerAccountState = initialActiveLedgerAccountState;
    this.trezorSigner = new TrezorKeyring(this.getSigner);
    this.ledgerSigner = new LedgerKeyring();

    // this.syscoinTransaction = SyscoinTransactions();
    this.syscoinTransaction = new SyscoinTransactions(
      this.getSigner,
      this.getAccountsState,
      this.getAddress,
      this.ledgerSigner
    );
    this.ethereumTransaction = new EthereumTransactions(
      this.getNetwork,
      this.getDecryptedPrivateKey,
      this.getSigner,
      this.getAccountsState,
      this.ledgerSigner
    );
  }

  // ===================================== PUBLIC METHODS - KEYRING MANAGER FOR HD - SYS ALL ===================================== //

  public setStorage = (client: any) => this.storage.setClient(client);

  public validateAccountType = (account: IKeyringAccountState) => {
    return account.isImported === true
      ? KeyringAccountType.Imported
      : KeyringAccountType.HDAccount;
  };

  public isUnlocked = () => !!this.sessionPassword;
  public lockWallet = () => {
    this.sessionPassword = '';
    this.sessionSeed = '';
  };

  public addNewAccount = async (
    label?: string
  ): Promise<IKeyringAccountState> => {
    const network = this.wallet.activeNetwork;
    const mnemonic = this.sessionSeed;
    const isSyscoinChain = this.isSyscoinChain(network);

    if (isSyscoinChain) {
      const result = await this.addNewAccountToSyscoinChain(label);
      if (!result) {
        throw new Error('Failed to create Syscoin account');
      }
      return result;
    }

    if (!mnemonic) {
      throw new Error('Seed phrase is required to create a new account.');
    }

    const result = await this.addNewAccountToEth(label);
    if (!result) {
      throw new Error('Failed to create Ethereum account');
    }
    return result;
  };

  public setWalletPassword = async (pwd: string, prvPwd?: string) => {
    if (this.sessionPassword) {
      if (!prvPwd) {
        throw new Error('Previous password is required to change the password');
      }
      const genPwd = this.encryptSHA512(prvPwd, this.currentSessionSalt);
      if (genPwd !== this.sessionPassword) {
        throw new Error('Previous password is not correct');
      }
    }
    const salt = this.generateSalt();
    const hash = this.encryptSHA512(pwd, salt);
    this.memPassword = pwd; //This will be needed a bit longer on the memory for wallet creation purposes
    this.sessionPassword = this.encryptSHA512(pwd, this.currentSessionSalt);

    if (this.memMnemonic) {
      await setEncryptedVault(
        {
          mnemonic: CryptoJS.AES.encrypt(this.memMnemonic, pwd).toString(),
        },
        this.memPassword
      );

      this.sessionMnemonic = CryptoJS.AES.encrypt(
        this.memMnemonic,
        this.sessionPassword
      ).toString();

      this.sessionMainMnemonic = this.sessionMnemonic;

      this.memMnemonic = '';
    }
    if (prvPwd) this.updateWalletKeys(prvPwd);

    this.storage.set('vault-keys', {
      hash,
      salt,
      currentSessionSalt: this.currentSessionSalt,
    });
  };

  public unlock = async (
    password: string,
    isForPvtKey?: boolean
  ): Promise<{
    canLogin: boolean;
    wallet?: IWalletState | null;
  }> => {
    try {
      // Get vault-keys and utf8Error in parallel for efficiency
      const [vaultKeysResult, utf8ErrorResult] = await Promise.allSettled([
        this.storage.get('vault-keys'),
        this.storage.get('utf8Error'),
      ]);

      // Handle vault-keys result with retry logic only if needed
      let vaultKeys;
      if (
        vaultKeysResult.status === 'fulfilled' &&
        vaultKeysResult.value &&
        vaultKeysResult.value.hash &&
        vaultKeysResult.value.salt
      ) {
        vaultKeys = vaultKeysResult.value;
      } else {
        // Only retry if the first attempt failed or returned incomplete data
        console.log(
          `[KeyringManager] vault-keys not ready on first attempt, retrying...`
        );

        let retries = 0;
        const maxRetries = 2; // Reduced from 3 to 2
        const retryDelay = 150; // Reduced from 200ms to 150ms

        while (retries < maxRetries) {
          try {
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            vaultKeys = await this.storage.get('vault-keys');
            if (vaultKeys && vaultKeys.hash && vaultKeys.salt) {
              break; // Successfully got vault keys
            }
            console.log(
              `[KeyringManager] vault-keys retry ${
                retries + 1
              }/${maxRetries} failed`
            );
            retries++;
          } catch (error) {
            console.error(
              `[KeyringManager] vault-keys retry ${
                retries + 1
              }/${maxRetries} error:`,
              error
            );
            retries++;
          }
        }
      }

      if (!vaultKeys || !vaultKeys.hash || !vaultKeys.salt) {
        console.error('[KeyringManager] Failed to get valid vault-keys');
        return {
          canLogin: false,
          wallet: null,
        };
      }

      const { hash, salt } = vaultKeys;
      const hasUtf8Error =
        utf8ErrorResult.status === 'fulfilled' && utf8ErrorResult.value
          ? utf8ErrorResult.value.hasUtf8Error
          : false;
      const hashPassword = this.encryptSHA512(password, salt);

      if (isForPvtKey) {
        return {
          canLogin: hashPassword === hash,
        };
      }

      let wallet: IWalletState | null = null;

      if (hashPassword === hash) {
        this.sessionPassword = await this.recoverLastSessionPassword(password);

        const isHdCreated = !!this.hd;
        let needsRestore = false;

        // Check if we need to restore the wallet
        if (hasUtf8Error) {
          const sysMainnetNetwork = {
            apiUrl: '',
            chainId: 57,
            currency: 'sys',
            default: true,
            explorer: 'https://explorer-blockbook.syscoin.org',
            label: 'Syscoin Mainnet',
            slip44: 57,
            url: 'https://explorer-blockbook.syscoin.org',
            isTestnet: false,
          };

          await this.setSignerNetwork(sysMainnetNetwork, INetworkType.Syscoin);
          needsRestore = true;
          this.storage.set('utf8Error', { hasUtf8Error: false });
        }

        // Only restore once if needed
        if (needsRestore || !isHdCreated || !this.sessionMnemonic) {
          await this.restoreWallet(isHdCreated, password);
        }

        if (hasUtf8Error) {
          wallet = this.wallet;
        }

        await this.updateWalletKeys(password);

        // Load account caches from storage
        await this.loadAccountsCacheFromStorage();

        // This ensures EVM private keys are properly derived for the default account
        try {
          const { activeAccountId, activeAccountType } = this.wallet;
          await this.setActiveAccount(activeAccountId, activeAccountType);
          console.log(
            `[KeyringManager] Active account ${activeAccountId} initialized after unlock`
          );
        } catch (accountError) {
          console.warn(
            '[KeyringManager] Failed to initialize active account after unlock:',
            accountError.message
          );
          // Don't fail the unlock process if account initialization fails
        }
      }

      return {
        canLogin: hashPassword === hash,
        wallet,
      };
    } catch (error) {
      console.log('ERROR unlock', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
      return {
        canLogin: false,
        wallet: null,
      };
    }
  };

  public getNewChangeAddress = async (): Promise<string> => {
    const { activeAccountType, accounts, activeAccountId } = this.wallet;
    const { xpub } = accounts[activeAccountType][activeAccountId];
    return await this.getAddress(xpub, true); // Don't skip increment - get next unused
  };

  public getChangeAddress = async (id: number): Promise<string> => {
    const { activeAccountType, accounts } = this.wallet;
    const { xpub } = accounts[activeAccountType][id];

    return await this.getAddress(xpub, true);
  };

  public updateReceivingAddress = async (): Promise<string> => {
    const { activeAccountType, accounts, activeAccountId } = this.wallet;
    const { xpub } = accounts[activeAccountType][activeAccountId];

    const address = await this.getAddress(xpub, false);
    this.wallet.accounts[activeAccountType][activeAccountId].address = address;
    return address;
  };

  public createKeyringVault = async (): Promise<IKeyringAccountState> => {
    try {
      if (!this.memPassword) {
        throw new Error('Create a password first');
      }
      let { mnemonic } = await getDecryptedVault(this.memPassword);

      if (!mnemonic) {
        throw new Error('Mnemonic not found in vault or is empty');
      }

      // Try to detect if mnemonic is encrypted or plain text
      // Encrypted mnemonics typically don't contain common BIP39 words
      const isLikelyPlainMnemonic =
        mnemonic.includes(' ') &&
        (mnemonic.split(' ').length === 12 ||
          mnemonic.split(' ').length === 24);

      if (!isLikelyPlainMnemonic) {
        try {
          mnemonic = CryptoJS.AES.decrypt(mnemonic, this.memPassword).toString(
            CryptoJS.enc.Utf8
          );
        } catch (decryptError) {
          // If decryption fails, assume mnemonic is already decrypted
          // This can happen in tests or if the storage format changes
          console.warn(
            'Mnemonic decryption failed, using as-is:',
            decryptError.message
          );
        }
      }

      if (!mnemonic) {
        throw new Error(
          'Failed to decrypt mnemonic or mnemonic is empty after decryption'
        );
      }

      const rootAccount = await this.createMainWallet(mnemonic);
      this.wallet = {
        ...initialWalletState,
        ...this.wallet,
        accounts: {
          ...this.wallet.accounts,
          [KeyringAccountType.HDAccount]: {
            [rootAccount.id]: rootAccount,
          },
        },
        activeAccountId: rootAccount.id,
        activeAccountType: this.validateAccountType(rootAccount),
      };

      this.memPassword = '';
      const seed = (await mnemonicToSeed(mnemonic)).toString('hex');
      this.sessionSeed = CryptoJS.AES.encrypt(
        seed,
        this.sessionPassword
      ).toString();

      // Sync initial account to appropriate cache
      this.syncAccountsToCache(this.activeChain);

      return rootAccount;
    } catch (error) {
      console.log('ERROR createKeyringVault', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
      throw error;
    }
  };

  public setActiveAccount = async (
    id: number,
    accountType: KeyringAccountType
  ) => {
    if (!this.hd && this.activeChain === INetworkType.Syscoin)
      throw new Error(
        'Initialise wallet first, cant change accounts without an active HD'
      );

    const accounts = this.wallet.accounts[accountType];
    if (!accounts[id]) throw new Error('Account not found');
    if (!accounts[id].xpub) throw new Error('Account not set');

    this.wallet = {
      ...this.wallet,
      activeAccountId: id,
      activeAccountType: accountType,
    };

    if (this.activeChain === INetworkType.Syscoin) {
      const isHDAccount = accountType === KeyringAccountType.HDAccount;

      this.sessionMnemonic = isHDAccount
        ? this.sessionMainMnemonic
        : accounts[id].xprv;

      const { rpc, isTestnet } = await this.getSignerUTXO(
        this.wallet.activeNetwork
      );

      // Check if HD signer needs to be recreated due to network changes
      const needsHDSignerUpdate = this.shouldUpdateHDSigner(rpc, isTestnet);

      if (needsHDSignerUpdate) {
        await this.updateUTXOAccounts(rpc, isTestnet);
      }

      // Set account index for any account type that has an HD signer
      if (this.hd) {
        this.hd.setAccountIndex(id);
      }

      // No balance updates - Pali handles this
    }
  };

  public getAccountById = (
    id: number,
    accountType: KeyringAccountType
  ): Omit<IKeyringAccountState, 'xprv'> => {
    const accounts = Object.values(this.wallet.accounts[accountType]);

    const account = accounts.find((account) => account.id === id);

    if (!account) {
      throw new Error('Account not found');
    }

    return omit(account, 'xprv');
  };

  public getPrivateKeyByAccountId = (
    id: number,
    acountType: KeyringAccountType,
    pwd: string
  ): string => {
    try {
      // Validate password first
      const genPwd = this.encryptSHA512(pwd, this.currentSessionSalt);
      if (!this.sessionPassword) {
        throw new Error('Unlock wallet first');
      } else if (this.sessionPassword !== genPwd) {
        throw new Error('Invalid password');
      }
      const accounts = this.wallet.accounts[acountType];

      const account = Object.values(accounts).find(
        (account) => account.id === id
      );

      if (!account) {
        throw new Error('Account not found');
      }
      const decryptedPrivateKey = CryptoJS.AES.decrypt(
        account.xprv,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      return decryptedPrivateKey;
    } catch (error) {
      console.log('ERROR getPrivateKeyByAccountId', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
      throw error;
    }
  };

  public getActiveAccount = (): {
    activeAccount: Omit<IKeyringAccountState, 'xprv'>;
    activeAccountType: KeyringAccountType;
  } => {
    const { accounts, activeAccountId, activeAccountType } = this.wallet;

    return {
      activeAccount: omit(accounts[activeAccountType][activeAccountId], 'xprv'),
      activeAccountType,
    };
  };

  public getEncryptedXprv = () => {
    return CryptoJS.AES.encrypt(
      this.getSysActivePrivateKey(),
      this.sessionPassword
    ).toString();
  };

  public getSeed = async (pwd: string) => {
    const genPwd = this.encryptSHA512(pwd, this.currentSessionSalt);
    if (!this.sessionPassword) {
      throw new Error('Unlock wallet first');
    } else if (this.sessionPassword !== genPwd) {
      throw new Error('Invalid password');
    }
    let { mnemonic } = await getDecryptedVault(pwd);

    if (!mnemonic) {
      throw new Error('Mnemonic not found in vault or is empty');
    }

    // Try to detect if mnemonic is encrypted or plain text
    const isLikelyPlainMnemonic =
      mnemonic.includes(' ') &&
      (mnemonic.split(' ').length === 12 || mnemonic.split(' ').length === 24);

    if (!isLikelyPlainMnemonic) {
      try {
        mnemonic = CryptoJS.AES.decrypt(mnemonic, pwd).toString(
          CryptoJS.enc.Utf8
        );
      } catch (decryptError) {
        // If decryption fails, assume mnemonic is already decrypted
        console.warn(
          'Mnemonic decryption failed in getSeed, using as-is:',
          decryptError.message
        );
      }
    }

    if (!mnemonic) {
      throw new Error(
        'Failed to decrypt mnemonic or mnemonic is empty after decryption'
      );
    }

    return mnemonic;
  };

  public updateNetworkConfig = async (
    data: INetwork,
    chainType: INetworkType
  ) => {
    if (
      chainType !== INetworkType.Syscoin &&
      chainType !== INetworkType.Ethereum
    ) {
      throw new Error('Invalid chain type');
    }
    if (!this.wallet.networks[chainType][data.chainId]) {
      throw new Error('Network does not exist');
    }
    if (
      this.wallet.activeNetwork.chainId === data.chainId &&
      this.activeChain === chainType
    ) {
      // Clear RPC caches when updating network configuration
      clearRpcCaches();

      if (
        chainType === INetworkType.Syscoin &&
        this.syscoinSigner?.blockbookURL
      ) {
        this.syscoinSigner.blockbookURL = data.url;
      } else {
        this.ethereumTransaction.setWeb3Provider(data);
      }
    }
    this.wallet = {
      ...this.wallet,
      networks: {
        ...this.wallet.networks,
        [chainType]: {
          ...this.wallet.networks[chainType],
          [data.chainId]: data,
        },
      },
    };
  };

  public addCustomNetwork = (chain: INetworkType, network: INetwork) => {
    const networkIdentifier = network.key ? network.key : network.chainId;

    this.wallet = {
      ...this.wallet,
      networks: {
        ...this.wallet.networks,
        [chain]: {
          ...this.wallet.networks[chain],
          [networkIdentifier]: network,
        },
      },
    };
  };

  public removeNetwork = (
    chain: INetworkType,
    chainId: number,
    rpcUrl: string,
    label: string,
    key?: string
  ) => {
    const validateIfKeyExists =
      key &&
      this.wallet.activeNetwork.key &&
      this.wallet.activeNetwork.key === key;

    //TODO: test failure case to validate rollback;
    if (
      this.activeChain === chain &&
      this.wallet.activeNetwork.chainId === chainId &&
      this.wallet.activeNetwork.url === rpcUrl &&
      this.wallet.activeNetwork.label === label &&
      validateIfKeyExists
    ) {
      throw new Error('Cannot remove active network');
    }

    const updatedNetworks = Object.entries(this.wallet.networks[chain]).reduce(
      (result, [index, networkValue]) => {
        const networkTyped = networkValue as INetwork;

        if (key && networkTyped.key === key) {
          return result; // Skip the network with the provided key
        }

        if (
          networkTyped.url === rpcUrl &&
          networkTyped.chainId === chainId &&
          networkTyped.label === label
        ) {
          return result; // Skip the network that matches the criteria
        }

        return { ...result, [index]: networkValue }; // Keep the network in the updated object
      },
      {}
    );

    // Replace the networks object for the chain with the updated object
    this.wallet = {
      ...this.wallet,
      networks: {
        ...this.wallet.networks,
        [chain]: {
          ...updatedNetworks,
        },
      },
    };
  };

  public setSignerNetwork = async (
    network: INetwork,
    chain: string
  ): Promise<{
    activeChain?: INetworkType;
    success: boolean;
    wallet?: IWalletState;
  }> => {
    // Clear RPC caches when switching networks to ensure fresh data
    clearRpcCaches();

    // FIX #4: Check network type before making calls
    if (this.isSyscoinChain(network) && chain === INetworkType.Ethereum) {
      throw new Error('Cannot use Ethereum chain type with Syscoin network');
    }
    if (!this.isSyscoinChain(network) && chain === INetworkType.Syscoin) {
      throw new Error('Cannot use Syscoin chain type with Ethereum network');
    }

    if (INetworkType.Ethereum !== chain && INetworkType.Syscoin !== chain) {
      throw new Error('Unsupported chain');
    }
    const networkChain: INetworkType =
      INetworkType.Ethereum === chain
        ? INetworkType.Ethereum
        : INetworkType.Syscoin;
    const prevWalletState = this.wallet;
    const prevActiveChainState = this.activeChain;
    const prevHDState = this.hd;
    const prevSyscoinSignerState = this.syscoinSigner;

    try {
      // Check if we're switching chain types
      const isChainTypeSwitch = this.activeChain !== networkChain;

      if (isChainTypeSwitch) {
        // Save current accounts to cache before switching
        await this.syncAccountsToCache(this.activeChain);

        // Always regenerate accounts when switching chain types
        // This ensures addresses are in the correct format for the new chain
        if (chain === INetworkType.Syscoin) {
          const { rpc, isTestnet } = await this.getSignerUTXO(network);
          await this.updateUTXOAccounts(rpc, isTestnet, network);
          if (!this.hd) throw new Error('Error initialising HD');
          this.hd.setAccountIndex(this.wallet.activeAccountId);
        } else if (chain === INetworkType.Ethereum) {
          await this.setSignerEVM(network);
          await this.updateWeb3Accounts();
        }
      } else {
        // Same chain type, normal network switch
        if (chain === INetworkType.Syscoin) {
          const { rpc, isTestnet } = await this.getSignerUTXO(network);

          // Update activeNetwork early so address updates use the correct network
          this.wallet.activeNetwork = network;

          // Check if HD signer needs update
          if (this.shouldUpdateHDSigner(rpc, isTestnet)) {
            // Recreate HD signer with new network parameters
            await this.updateUTXOAccounts(rpc, isTestnet, network);
          } else {
            // HD signer is fine, just update address formats
            this.updateUTXOAddressFormats(network);
          }

          if (!this.hd) throw new Error('Error initialising HD');
          this.hd.setAccountIndex(this.wallet.activeAccountId);
        } else if (chain === INetworkType.Ethereum) {
          await this.setSignerEVM(network);
          // No need to update accounts for same chain type
        }
      }

      this.wallet = {
        ...this.wallet,
        networks: {
          ...this.wallet.networks,
          [networkChain]: {
            ...this.wallet.networks[networkChain],
            [network.chainId]: network,
          },
        },
        activeNetwork: network,
      };

      this.activeChain = networkChain;

      return {
        success: true,
        wallet: this.wallet,
        activeChain: this.activeChain,
      };
    } catch (err) {
      console.log('ERROR setSignerNetwork', {
        err,
      });

      this.validateAndHandleErrorByMessage(err.message);

      //Rollback to previous values
      console.error('Set Signer Network failed with', err);

      this.wallet = prevWalletState;
      this.activeChain = prevActiveChainState;

      if (this.activeChain === INetworkType.Ethereum) {
        this.ethereumTransaction.setWeb3Provider(this.wallet.activeNetwork);
      } else if (this.activeChain === INetworkType.Syscoin) {
        this.hd = prevHDState;
        this.syscoinSigner = prevSyscoinSignerState;
      }

      return { success: false };
    }
  };

  public forgetMainWallet = async (pwd: string) => {
    const genPwd = this.encryptSHA512(pwd, this.currentSessionSalt);
    if (!this.sessionPassword) {
      throw new Error('Unlock wallet first');
    } else if (this.sessionPassword !== genPwd) {
      throw new Error('Invalid password');
    }

    await this.clearTemporaryLocalKeys(pwd);
  };

  public importWeb3Account = (mnemonicOrPrivKey: string) => {
    // Check if it's a hex string (Ethereum private key)
    if (ethers.utils.isHexString(mnemonicOrPrivKey)) {
      return new ethers.Wallet(mnemonicOrPrivKey);
    }

    // Check if it's a zprv/tprv (Syscoin private key)
    const zprvPrefixes = ['zprv', 'tprv', 'vprv', 'xprv'];
    if (zprvPrefixes.some((prefix) => mnemonicOrPrivKey.startsWith(prefix))) {
      throw new Error(
        'Syscoin extended private keys (zprv/tprv) should be imported using importAccount, not importWeb3Account'
      );
    }

    // Otherwise, assume it's a mnemonic
    const account = ethers.Wallet.fromMnemonic(mnemonicOrPrivKey);

    return account;
  };

  public getAccountXpub = (): string => {
    const { activeAccountId, activeAccountType } = this.wallet;
    const account = this.wallet.accounts[activeAccountType][activeAccountId];
    return account.xpub;
  };

  public isSeedValid = (seedPhrase: string) => validateMnemonic(seedPhrase);

  public createNewSeed = () => generateMnemonic();

  public setSeed = (seedPhrase: string) => {
    if (validateMnemonic(seedPhrase)) {
      this.memMnemonic = seedPhrase;
      if (this.sessionPassword) {
        this.sessionMnemonic = CryptoJS.AES.encrypt(
          seedPhrase,
          this.sessionPassword
        ).toString();

        this.sessionMainMnemonic = this.sessionMnemonic;

        this.memMnemonic = '';
      }
      return seedPhrase;
    }
    throw new Error('Invalid Seed');
  };

  public getUTXOState = () => {
    if (this.activeChain !== INetworkType.Syscoin) {
      throw new Error('Cannot get state in a ethereum network');
    }

    const utxOAccounts = mapValues(this.wallet.accounts.HDAccount, (value) =>
      omit(value, 'xprv')
    );

    return {
      ...this.wallet,
      accounts: {
        [KeyringAccountType.HDAccount]: utxOAccounts,
        [KeyringAccountType.Imported]: {},
        [KeyringAccountType.Trezor]: {},
      },
    };
  };

  public async importTrezorAccount(
    coin: string,
    slip44: number,
    index: string
  ) {
    const importedAccount = await this._createTrezorAccount(
      coin,
      slip44,
      index
    );
    this.wallet.accounts[KeyringAccountType.Trezor][importedAccount.id] =
      importedAccount;

    return importedAccount;
  }

  public async importLedgerAccount(
    coin: string,
    slip44: number,
    index: string,
    isAlreadyConnected: boolean
  ) {
    try {
      const connectionResponse = isAlreadyConnected
        ? true
        : await this.ledgerSigner.connectToLedgerDevice();

      if (connectionResponse) {
        const importedAccount = await this._createLedgerAccount(
          coin,
          slip44,
          index
        );
        this.wallet.accounts[KeyringAccountType.Ledger][importedAccount.id] =
          importedAccount;

        return importedAccount;
      }
    } catch (error) {
      console.log({ error });
      throw error;
    }
  }

  public getActiveUTXOAccountState = () => ({
    ...this.wallet.accounts.HDAccount[this.wallet.activeAccountId],
    xprv: undefined,
  });

  public getNetwork = () => this.wallet.activeNetwork;

  public verifyIfIsTestnet = () => {
    const { chainId } = this.wallet.activeNetwork;
    if (this.wallet.networks.syscoin[chainId] && this.hd) {
      return this.hd.Signer.isTestnet;
    }
    return undefined;
  };

  public createEthAccount = (privateKey: string) =>
    new ethers.Wallet(privateKey);

  public getAddress = async (xpub: string, isChangeAddress: boolean) => {
    const { hd, main } = this.getSigner();
    const options = 'tokens=used&details=tokens';

    const { tokens } = await syscoinjs.utils.fetchBackendAccount(
      main.blockbookURL,
      xpub,
      options,
      true,
      undefined
    );

    const { receivingIndex, changeIndex } =
      this.setLatestIndexesFromXPubTokens(tokens);

    const currentAccount = new BIP84.fromZPub(
      xpub,
      hd.Signer.pubTypes,
      hd.Signer.networks
    );

    const address = currentAccount.getAddress(
      isChangeAddress ? changeIndex : receivingIndex,
      isChangeAddress,
      84
    ) as string;

    return address;
  };

  public logout = () => {
    this.sessionPassword = '';
    this.sessionSeed = '';
    this.sessionMnemonic = '';
    this.sessionMainMnemonic = '';
  };

  public async importAccount(
    privKey: string,
    label?: string,
    targetNetwork?: INetwork
  ) {
    const importedAccount = await this._getPrivateKeyAccountInfos(
      privKey,
      label,
      targetNetwork
    );

    this.wallet.accounts[KeyringAccountType.Imported][importedAccount.id] =
      importedAccount;

    return importedAccount;
  }

  public updateAccountLabel = (
    label: string,
    accountId: number,
    accountType: KeyringAccountType
  ) => {
    this.wallet.accounts[accountType][accountId].label = label;
  };

  public validateZprv(zprv: string, targetNetwork?: INetwork) {
    if (!targetNetwork) {
      throw new Error('Target network is required for validation');
    }

    try {
      // Check if it looks like an extended key based on known prefixes
      const knownExtendedKeyPrefixes = [
        'xprv',
        'xpub',
        'yprv',
        'ypub',
        'zprv',
        'zpub',
        'tprv',
        'tpub',
        'uprv',
        'upub',
        'vprv',
        'vpub',
      ];
      const prefix = zprv.substring(0, 4);
      const looksLikeExtendedKey = knownExtendedKeyPrefixes.includes(prefix);

      // Only check prefix validity if it looks like an extended key
      if (looksLikeExtendedKey) {
        const validBip84Prefixes = ['zprv', 'vprv']; // zprv for mainnet, vprv for testnet
        if (!validBip84Prefixes.includes(prefix)) {
          throw new Error(
            `Invalid key prefix '${prefix}'. Only BIP84 keys (zprv/vprv) are supported for UTXO imports. BIP44 keys (xprv/tprv) are not supported.`
          );
        }
      } else {
        // Not an extended key format
        throw new Error('Not an extended private key');
      }

      const bip32 = BIP32Factory(ecc);
      const decoded = bs58check.decode(zprv);

      if (decoded.length !== 78) {
        throw new Error('Invalid length for a BIP-32 key');
      }

      const { networks, types } = getNetworkConfig(
        targetNetwork.slip44,
        targetNetwork.currency || 'Bitcoin'
      );

      const isTestnet =
        targetNetwork.isTestnet || targetNetwork.chainId === 5700;

      // Note: We allow cross-network usage of keys (mainnet key on testnet and vice versa)
      // The key derivation is the same, only the address encoding changes
      // This allows imported accounts to work across networks

      // Get the BIP84 network configuration
      let network = isTestnet ? networks.testnet : networks.mainnet;

      if (types && types.zPubType) {
        const bip84Versions = isTestnet
          ? types.zPubType.testnet
          : types.zPubType.mainnet;
        const privKey = isTestnet ? 'vprv' : 'zprv';
        const pubKey = isTestnet ? 'vpub' : 'zpub';

        // Create network config with BIP84 version bytes
        network = {
          ...network,
          bip32: {
            public: parseInt(bip84Versions[pubKey], 16),
            private: parseInt(bip84Versions[privKey], 16),
          },
        };
      }

      // Try to parse with the target network first
      let node;
      try {
        node = bip32.fromBase58(zprv, network);
      } catch (e) {
        // If parsing fails with target network, try with the opposite network
        // This handles cross-network usage (mainnet key on testnet and vice versa)
        const alternateNetwork = isTestnet
          ? networks.mainnet
          : networks.testnet;

        // Set up alternate network with BIP84 version bytes
        if (types && types.zPubType) {
          const altBip84Versions = isTestnet
            ? types.zPubType.mainnet
            : types.zPubType.testnet;
          const altPrivKey = isTestnet ? 'zprv' : 'vprv';
          const altPubKey = isTestnet ? 'zpub' : 'vpub';

          alternateNetwork.bip32 = {
            public: parseInt(altBip84Versions[altPubKey], 16),
            private: parseInt(altBip84Versions[altPrivKey], 16),
          };
        }

        try {
          node = bip32.fromBase58(zprv, alternateNetwork);
          // If we successfully parsed with alternate network, use target network for address generation
          // This allows the key to work across networks while generating addresses for the target network
        } catch (e2) {
          throw new Error(`Failed to parse extended private key: ${e.message}`);
        }
      }

      if (!node.privateKey) {
        throw new Error('Private key not found in extended private key');
      }
      if (!ecc.isPrivate(node.privateKey)) {
        throw new Error('Invalid private key for secp256k1 curve');
      }

      return {
        isValid: true,
        node,
        network, // Always return the target network for address generation
        message: 'The zprv is valid.',
      };
    } catch (error) {
      return { isValid: false, message: error.message };
    }
  }

  /**
   * PRIVATE METHODS
   */

  // ===================================== AUXILIARY METHOD - FOR TRANSACTIONS CLASSES ===================================== //
  private getDecryptedPrivateKey = (): {
    address: string;
    decryptedPrivateKey: string;
  } => {
    try {
      const { accounts, activeAccountId, activeAccountType } = this.wallet;
      if (!this.sessionPassword)
        throw new Error('Wallet is locked cant proceed with transaction');

      const activeAccountData = accounts[activeAccountType][activeAccountId];
      if (!activeAccountData) {
        throw new Error(
          `Active account (${activeAccountType}:${activeAccountId}) not found. Account switching may be in progress.`
        );
      }

      const { xprv, address } = activeAccountData;
      if (!xprv) {
        throw new Error(
          `Private key not found for account ${activeAccountType}:${activeAccountId}. Account may not be fully initialized.`
        );
      }

      let decryptedPrivateKey: string;
      try {
        decryptedPrivateKey = CryptoJS.AES.decrypt(
          xprv,
          this.sessionPassword
        ).toString(CryptoJS.enc.Utf8);
      } catch (decryptError) {
        throw new Error(
          `Failed to decrypt private key for account ${activeAccountType}:${activeAccountId}. The wallet may be locked or corrupted.`
        );
      }

      if (!decryptedPrivateKey) {
        throw new Error(
          `Decrypted private key is empty for account ${activeAccountType}:${activeAccountId}. Invalid password or corrupted data.`
        );
      }

      // For EVM accounts, validate that the derived address matches the stored address
      // This helps catch account switching race conditions early
      if (this.activeChain === INetworkType.Ethereum) {
        try {
          const derivedWallet = new ethers.Wallet(decryptedPrivateKey);
          if (derivedWallet.address.toLowerCase() !== address.toLowerCase()) {
            throw new Error(
              `Address mismatch for account ${activeAccountType}:${activeAccountId}. Expected ${address} but derived ${derivedWallet.address}. Account switching may be in progress.`
            );
          }
        } catch (ethersError) {
          throw new Error(
            `Failed to validate EVM address for account ${activeAccountType}:${activeAccountId}: ${ethersError.message}`
          );
        }
      }

      return {
        address,
        decryptedPrivateKey,
      };
    } catch (error) {
      console.error('ERROR getDecryptedPrivateKey', {
        error: error.message,
        activeChain: this.activeChain,
        wallet: {
          activeAccountId: this.wallet?.activeAccountId,
          activeAccountType: this.wallet?.activeAccountType,
        },
      });
      this.validateAndHandleErrorByMessage(error.message);
      throw error;
    }
  };

  private getSigner = (): {
    hd: SyscoinHDSigner;
    main: any; //TODO: Type this following syscoinJSLib interface
  } => {
    if (!this.sessionPassword) {
      throw new Error('Wallet is locked cant proceed with transaction');
    }
    if (this.activeChain !== INetworkType.Syscoin) {
      throw new Error('Switch to UTXO chain');
    }
    if (!this.syscoinSigner || !this.hd) {
      throw new Error(
        'Wallet is not initialised yet call createKeyringVault first'
      );
    }

    return { hd: this.hd, main: this.syscoinSigner };
  };

  private validateAndHandleErrorByMessage(message: string) {
    const utf8ErrorMessage = 'Malformed UTF-8 data';
    if (
      message.includes(utf8ErrorMessage) ||
      message.toLowerCase().includes(utf8ErrorMessage.toLowerCase())
    ) {
      this.storage.set('utf8Error', { hasUtf8Error: true });
    }
  }

  private async recoverLastSessionPassword(pwd: string) {
    //As before locking the wallet we always keep the value of the last currentSessionSalt correctly stored in vault,
    //we use the value in vault instead of the one present in the class to get the last correct value for sessionPassword
    const initialVaultKeys = await this.storage.get('vault-keys');

    //Here we need to validate if user has the currentSessionSalt in the vault-keys, because for Pali Users that
    //already has accounts created in some old version this value will not be in the storage. So we need to check it
    //and if user doesn't have we set it and if has we use the storage value
    if (!this.currentSessionSalt || !initialVaultKeys?.currentSessionSalt) {
      this.storage.set('vault-keys', {
        ...initialVaultKeys,
        currentSessionSalt: this.currentSessionSalt,
      });

      return this.encryptSHA512(pwd, this.currentSessionSalt);
    }

    return this.encryptSHA512(pwd, initialVaultKeys.currentSessionSalt);
  }

  private getAccountsState = () => {
    const { activeAccountId, accounts, activeAccountType, activeNetwork } =
      this.wallet;
    return { activeAccountId, accounts, activeAccountType, activeNetwork };
  };

  /**
   *
   * @param password
   * @param salt
   * @returns hash: string
   */
  private encryptSHA512 = (password: string, salt: string) =>
    crypto.createHmac('sha512', salt).update(password).digest('hex');

  private createMainWallet = async (
    mnemonic: string
  ): Promise<IKeyringAccountState> => {
    // Check if we're on testnet based on the active network
    const isTestnet =
      this.wallet.activeNetwork.isTestnet ||
      this.wallet.activeNetwork.chainId === 5700;

    //@ts-ignore
    this.hd = new syscoinjs.utils.HDSigner(
      mnemonic,
      null,
      isTestnet, // Use actual network instead of hardcoded false
      undefined,
      undefined,
      undefined,
      84
    ) as SyscoinHDSigner; //To understand better this look at: https://github.com/syscoin/syscoinjs-lib/blob/298fda26b26d7007f0c915a6f77626fb2d3c852f/utils.js#L894
    this.syscoinSigner = new syscoinjs.SyscoinJSLib(
      this.hd,
      this.wallet.activeNetwork.url,
      undefined
    );

    const xpub = this.hd.getAccountXpub();

    const formattedBackendAccount: ISysAccount =
      this.getFormattedBackendAccount({
        xpub,
        id: this.hd.Signer.accountIndex,
      });

    const account = this.getInitialAccountData({
      signer: this.hd,
      sysAccount: formattedBackendAccount,
      xprv: this.getEncryptedXprv(),
    });
    return account;
  };

  private getSysActivePrivateKey = () => {
    if (this.hd === null) throw new Error('No HD Signer');
    return this.hd.Signer.accounts[
      this.hd.Signer.accountIndex
    ].getAccountPrivateKey();
  };

  private getInitialAccountData = ({
    label,
    signer,
    sysAccount,
    xprv,
  }: {
    label?: string;
    signer: any;
    sysAccount: ISysAccount;
    xprv: string;
  }) => {
    const { balances, address, xpub } = sysAccount;

    return {
      id: signer.Signer.accountIndex,
      label: label ? label : `Account ${signer.Signer.accountIndex + 1}`,
      balances,
      xpub,
      xprv,
      address,
      isTrezorWallet: false,
      isLedgerWallet: false,
      isImported: false,
    };
  };

  private async _createTrezorAccount(
    coin: string,
    slip44: number,
    index: string,
    label?: string
  ) {
    const { accounts, activeNetwork } = this.wallet;
    let xpub, balance;
    try {
      const { descriptor, balance: _balance } =
        await this.trezorSigner.getAccountInfo({
          coin,
          slip44,
          index,
        });
      xpub = descriptor;
      balance = _balance;
    } catch (e) {
      throw new Error(e);
    }
    let ethPubKey = '';

    const isEVM = isEvmCoin(coin, slip44);

    const address = isEVM ? xpub : await this.getAddress(xpub, false);

    if (isEVM) {
      const response = await this.trezorSigner.getPublicKey({
        coin,
        slip44,
        index: +index,
      });
      ethPubKey = response.publicKey;
    }

    const accountAlreadyExists =
      Object.values(
        accounts[KeyringAccountType.Trezor] as IKeyringAccountState[]
      ).some((account) => account.address === address) ||
      Object.values(
        accounts[KeyringAccountType.HDAccount] as IKeyringAccountState[]
      ).some((account) => account.address === address) ||
      Object.values(
        accounts[KeyringAccountType.Imported] as IKeyringAccountState[]
      ).some((account) => account.address === address);

    if (accountAlreadyExists)
      throw new Error('Account already exists on your Wallet.');
    if (!xpub || !balance || !address)
      throw new Error(
        'Something wrong happened. Please, try again or report it'
      );

    const id =
      Object.values(accounts[KeyringAccountType.Trezor]).length < 1
        ? 0
        : Object.values(accounts[KeyringAccountType.Trezor]).length;

    const trezorAccount = {
      ...this.initialTrezorAccountState,
      balances: {
        syscoin: +balance / 1e8,
        ethereum: 0,
      },
      address,
      originNetwork: { ...activeNetwork, isBitcoinBased: !isEVM },
      label: label ? label : `Trezor ${id + 1}`,
      id,
      xprv: '',
      xpub: isEVM ? ethPubKey : xpub,
      assets: {
        syscoin: [],
        ethereum: [],
      },
    } as IKeyringAccountState;

    return trezorAccount;
  }

  private async _createLedgerAccount(
    coin: string,
    slip44: number,
    index: string,
    label?: string
  ) {
    const { accounts, activeNetwork } = this.wallet;
    let xpub;
    let address = '';
    if (isEvmCoin(coin, slip44)) {
      const { address: ethAddress, publicKey } =
        await this.ledgerSigner.evm.getEvmAddressAndPubKey({
          accountIndex: +index,
        });
      address = ethAddress;
      xpub = publicKey;
    } else {
      try {
        const ledgerXpub = await this.ledgerSigner.utxo.getXpub({
          index: +index,
          coin,
          slip44,
          withDecriptor: true,
        });
        xpub = ledgerXpub;
        address = await this.ledgerSigner.utxo.getUtxoAddress({
          coin,
          index: +index,
          slip44,
        });
      } catch (e) {
        throw new Error(e);
      }
    }

    const accountAlreadyExists =
      Object.values(
        accounts[KeyringAccountType.Ledger] as IKeyringAccountState[]
      ).some((account) => account.address === address) ||
      Object.values(
        accounts[KeyringAccountType.Trezor] as IKeyringAccountState[]
      ).some((account) => account.address === address) ||
      Object.values(
        accounts[KeyringAccountType.HDAccount] as IKeyringAccountState[]
      ).some((account) => account.address === address) ||
      Object.values(
        accounts[KeyringAccountType.Imported] as IKeyringAccountState[]
      ).some((account) => account.address === address);

    if (accountAlreadyExists)
      throw new Error('Account already exists on your Wallet.');
    if (!xpub || !address)
      throw new Error(
        'Something wrong happened. Please, try again or report it'
      );

    const id =
      Object.values(accounts[KeyringAccountType.Ledger]).length < 1
        ? 0
        : Object.values(accounts[KeyringAccountType.Ledger]).length;

    const isEVM = isEvmCoin(coin, slip44);
    const currentBalances = { syscoin: 0, ethereum: 0 };

    const ledgerAccount = {
      ...this.initialLedgerAccountState,
      balances: currentBalances,
      address,
      originNetwork: {
        ...activeNetwork,
        isBitcoinBased: !isEVM,
      },
      label: label ? label : `Ledger ${id + 1}`,
      id,
      xprv: '',
      xpub,
      assets: {
        syscoin: [],
        ethereum: [],
      },
    } as IKeyringAccountState;

    return ledgerAccount;
  }

  private getFormattedBackendAccount = ({
    xpub,
    id,
  }: {
    id: number;
    xpub: string;
  }): ISysAccount => {
    // Get address from existing account if it exists, otherwise derive it
    let address: string;
    const existingAccount =
      this.wallet.accounts[this.wallet.activeAccountType][id];
    if (existingAccount && existingAccount.address) {
      address = existingAccount.address;
    } else {
      // For new accounts, we need to derive the address
      if (!this.hd) throw new Error('No HD Signer');
      address = this.hd.Signer.accounts[id].getAddress(0, false, 84);
    }

    // Preserve existing balances if available
    const balances = existingAccount?.balances || {
      syscoin: 0,
      ethereum: 0,
    };

    return {
      address,
      xpub: xpub,
      balances,
    };
  };
  private setLatestIndexesFromXPubTokens = function (tokens) {
    let changeIndexInternal = -1,
      receivingIndexInternal = -1;
    if (tokens) {
      tokens.forEach((token) => {
        if (!token.transfers || !token.path) {
          return {
            changeIndex: changeIndexInternal + 1,
            receivingIndex: receivingIndexInternal + 1,
          };
        }
        const transfers = parseInt(token.transfers, 10);
        if (token.path && transfers > 0) {
          const splitPath = token.path.split('/');
          if (splitPath.length >= 6) {
            const change = parseInt(splitPath[4], 10);
            const index = parseInt(splitPath[5], 10);
            if (change === 1) {
              if (index > changeIndexInternal) {
                changeIndexInternal = index;
              }
            } else if (index > receivingIndexInternal) {
              receivingIndexInternal = index;
            }
          }
        }
      });
    }
    return {
      changeIndex: changeIndexInternal + 1,
      receivingIndex: receivingIndexInternal + 1,
    };
  };
  //todo network type
  private async addNewAccountToSyscoinChain(label?: string) {
    try {
      if (this.hd === null || !this.hd.mnemonicOrZprv) {
        throw new Error(
          'Keyring Vault is not created, should call createKeyringVault first '
        );
      }

      if (this.wallet.activeAccountType !== KeyringAccountType.HDAccount) {
        await this.setActiveAccount(0, KeyringAccountType.HDAccount);
      }

      const id = this.hd.createAccount(84);
      const xpub = this.hd.getAccountXpub();
      const xprv = this.getEncryptedXprv();

      const latestUpdate: ISysAccount = this.getFormattedBackendAccount({
        xpub,
        id: id,
      });

      const account = this.getInitialAccountData({
        label,
        signer: this.hd,
        sysAccount: latestUpdate,
        xprv,
      });

      this.wallet = {
        ...this.wallet,
        accounts: {
          ...this.wallet.accounts,
          [KeyringAccountType.HDAccount]: {
            ...this.wallet.accounts[KeyringAccountType.HDAccount],
            [id]: account,
          },
        },
        activeAccountId: account.id,
      };

      return {
        ...account,
        id,
      };
    } catch (error) {
      console.log('ERROR addNewAccountToSyscoinChain', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  }

  private async addNewAccountToEth(label?: string) {
    try {
      const { length } = Object.values(
        this.wallet.accounts[KeyringAccountType.HDAccount]
      );
      const seed = Buffer.from(
        CryptoJS.AES.decrypt(this.sessionSeed, this.sessionPassword).toString(
          CryptoJS.enc.Utf8
        ),
        'hex'
      );
      const privateRoot = hdkey.fromMasterSeed(seed);

      // Use dynamic path generation for ETH addresses
      const ethDerivationPath = getAddressDerivationPath(
        'eth',
        60,
        0,
        false,
        length
      );
      const derivedCurrentAccount = privateRoot.derivePath(ethDerivationPath);
      const newWallet = derivedCurrentAccount.getWallet();
      const address = newWallet.getAddressString();
      const xprv = newWallet.getPrivateKeyString();
      const xpub = newWallet.getPublicKeyString();

      const basicAccountInfo = this.getBasicWeb3AccountInfo(length, label);

      const createdAccount: IKeyringAccountState = {
        address,
        xpub,
        xprv: CryptoJS.AES.encrypt(xprv, this.sessionPassword).toString(),
        isImported: false,
        ...basicAccountInfo,
      };

      this.wallet = {
        ...this.wallet,
        accounts: {
          ...this.wallet.accounts,
          [KeyringAccountType.HDAccount]: {
            ...this.wallet.accounts[KeyringAccountType.HDAccount],
            [createdAccount.id]: createdAccount,
          },
        },
        activeAccountId: createdAccount.id,
      };

      return createdAccount;
    } catch (error) {
      console.log('ERROR addNewAccountToEth', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  }

  private getBasicWeb3AccountInfo = (id: number, label?: string) => {
    // Preserve existing balances if available
    const existingAccount =
      this.wallet.accounts[this.wallet.activeAccountType]?.[id];
    const balances = existingAccount?.balances || {
      syscoin: 0,
      ethereum: 0,
    };

    return {
      id,
      isTrezorWallet: false,
      isLedgerWallet: false,
      label: label ? label : `Account ${id + 1}`,
      balances,
    };
  };

  private updateWeb3Accounts = async () => {
    try {
      const { accounts, activeAccountId, activeAccountType } = this.wallet;
      const hdAccounts = Object.values(accounts[KeyringAccountType.HDAccount]);

      //Account of HDAccount is always initialized as it is required to create a network
      // Create array of promises for parallel execution
      const hdAccountPromises = hdAccounts.map((_, index) => {
        const id = Number(index);
        const label =
          this.wallet.accounts[KeyringAccountType.HDAccount][id].label;
        return this.setDerivedWeb3Accounts(id, label, activeAccountId);
      });

      // Execute all HD account updates in parallel
      await Promise.all(hdAccountPromises);

      return this.wallet.accounts[activeAccountType][activeAccountId];
    } catch (error) {
      console.log('ERROR updateWeb3Accounts', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  };

  private setDerivedWeb3Accounts = async (
    id: number,
    label: string,
    activeAccountId: number
  ) => {
    try {
      // Check if wallet account already exists and we're not dealing with the active account
      const existingWalletAccount =
        this.wallet.accounts[KeyringAccountType.HDAccount][id];
      const isActiveAccount = id === activeAccountId;

      // Only update wallet account if it doesn't exist or if it's the active account (which needs fresh balance data)
      if (!existingWalletAccount || isActiveAccount) {
        const seed = Buffer.from(
          CryptoJS.AES.decrypt(this.sessionSeed, this.sessionPassword).toString(
            CryptoJS.enc.Utf8
          ),
          'hex'
        );
        const privateRoot = hdkey.fromMasterSeed(seed);

        // Use dynamic path generation for ETH addresses
        const ethDerivationPath = getAddressDerivationPath(
          'eth',
          60,
          0,
          false,
          id
        );
        const derivedCurrentAccount = privateRoot.derivePath(ethDerivationPath);

        const derievedWallet = derivedCurrentAccount.getWallet();
        const address = derievedWallet.getAddressString();
        const xprv = derievedWallet.getPrivateKeyString();
        const xpub = derievedWallet.getPublicKeyString();

        const basicAccountInfo = this.getBasicWeb3AccountInfo(id, label);

        const createdAccount = {
          address,
          xpub,
          xprv: CryptoJS.AES.encrypt(xprv, this.sessionPassword).toString(),
          isImported: false,
          ...basicAccountInfo,
        };

        this.wallet.accounts[KeyringAccountType.HDAccount][id] = createdAccount;
      }
    } catch (error) {
      console.log('ERROR setDerivedWeb3Accounts', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  };

  private getSignerUTXO = async (
    network: INetwork
  ): Promise<{ isTestnet: boolean; rpc: any }> => {
    try {
      const { rpc, chain } = await getSysRpc(network);

      return {
        rpc,
        isTestnet: chain === 'test',
      };
    } catch (error) {
      console.error('[KeyringManager] getSignerUTXO error:', error);

      // Check if it's a JSON parsing error (HTML response)
      if (
        error?.message?.includes('Unexpected token') ||
        error?.message?.includes('is not valid JSON')
      ) {
        console.error(
          '[KeyringManager] RPC returned non-JSON response, likely an error page'
        );

        // Try to extract the actual error message from the error
        const match = error.message.match(/"([^"]+)"\s*is not valid JSON/);
        if (match && match[1]) {
          throw new Error(`RPC error: ${match[1]}`);
        }

        throw new Error(
          `Invalid RPC response from ${network.url}. Please check your RPC endpoint.`
        );
      }

      // Re-throw other errors
      throw error;
    }
  };

  private setSignerEVM = async (network: INetwork): Promise<void> => {
    const abortController = new AbortController();
    try {
      // FIX #4: Don't make ETH calls for UTXO networks
      if (this.isSyscoinChain(network)) {
        throw new Error('Cannot use EVM signer for UTXO network');
      }

      const web3Provider = new CustomJsonRpcProvider(
        abortController.signal,
        network.url
      );
      const { chainId } = await web3Provider.getNetwork();
      if (network.chainId !== chainId) {
        throw new Error(
          `SetSignerEVM: Wrong network information expected ${network.chainId} received ${chainId}`
        );
      }
      this.ethereumTransaction.setWeb3Provider(network);
      abortController.abort();
    } catch (error) {
      abortController.abort();
      throw new Error(`SetSignerEVM: Failed with ${error}`);
    }
  };

  private updateUTXOAccounts = async (
    rpc: {
      formattedNetwork: INetwork;
      networkConfig?: {
        networks: { mainnet: BitcoinNetwork; testnet: BitcoinNetwork };
        types: { xPubType: IPubTypes; zPubType: IPubTypes };
      };
    },
    isTestnet: boolean,
    targetNetwork?: INetwork
  ) => {
    try {
      if (!this.sessionPassword) {
        throw new Error('Unlock wallet first');
      }

      const isHDAccount =
        this.wallet.activeAccountType === KeyringAccountType.HDAccount;

      const encryptedMnemonic = isHDAccount
        ? this.sessionMainMnemonic
        : this.sessionMnemonic;

      if (!encryptedMnemonic) {
        throw new Error('No mnemonic available. Please unlock wallet first.');
      }

      const mnemonic = CryptoJS.AES.decrypt(
        encryptedMnemonic,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      if (!mnemonic) {
        throw new Error('Failed to decrypt mnemonic');
      }

      const { hd, main } = getSyscoinSigners({
        mnemonic,
        isTestnet,
        rpc,
      });

      this.hd = hd;
      this.syscoinSigner = main;

      // Update addresses
      this.updateUTXOAddressFormats();

      // For imported accounts, we need to manually derive the address with the target network
      if (
        this.wallet.activeAccountType === KeyringAccountType.Imported &&
        this.hd &&
        targetNetwork
      ) {
        const activeAccountId = this.wallet.activeAccountId;
        const account =
          this.wallet.accounts[KeyringAccountType.Imported][activeAccountId];

        if (account) {
          this.updateImportedUTXOAccountAddress(
            activeAccountId,
            account,
            targetNetwork
          );
        }
      }

      // Note: Don't set account index here - it will be set correctly by setActiveAccount
    } catch (error) {
      console.log('ERROR updateUTXOAccounts', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  };

  private clearTemporaryLocalKeys = async (pwd: string) => {
    this.wallet = initialWalletState;

    // Clear account caches
    this.ethAccountsCache = {};
    this.utxoAccountsCache = {};

    // Clear caches from storage
    await this.storage.set('ethAccountsCache', null);
    await this.storage.set('utxoAccountsCache', null);

    await setEncryptedVault(
      {
        mnemonic: '',
      },
      pwd
    );

    this.logout();
  };

  private isSyscoinChain = (network: any) =>
    Boolean(this.wallet.networks.syscoin[network.chainId]) &&
    (network.url.includes('blockbook') || network.url.includes('trezor'));

  private generateSalt = () => crypto.randomBytes(16).toString('hex');

  private shouldUpdateHDSigner = (rpc: any, isTestnet: boolean): boolean => {
    // Always update if no HD signer exists
    if (!this.hd || !this.syscoinSigner) {
      return true;
    }

    try {
      const currentSlip44 = this.hd.Signer.SLIP44;
      const currentIsTestnet = this.hd.Signer.isTestnet;
      const currentURL = this.syscoinSigner.blockbookURL;

      const newSlip44 =
        rpc.formattedNetwork.slip44 || rpc.formattedNetwork.chainId;
      const newURL = rpc.formattedNetwork.url;

      // 1. Check testnet/mainnet status mismatch
      if (currentIsTestnet !== isTestnet) {
        return true;
      }

      // 2. Check SLIP44/chainId mismatch (covers different UTXO networks)
      if (currentSlip44 !== newSlip44) {
        return true;
      }

      // 3. Check blockbook URL mismatch (handles custom RPC endpoints)
      if (currentURL !== newURL) {
        return true;
      }

      // No mismatch detected - no need to update HD signer
      return false;
    } catch (error) {
      // If we can't determine the current state, err on the side of updating
      console.log('Error checking HD signer state, forcing update:', error);
      return true;
    }
  };

  // ===================================== PRIVATE KEY ACCOUNTS METHODS - SIMPLE KEYRING ===================================== //

  private async restoreWallet(hdCreated: boolean, pwd: string) {
    if (!this.sessionMnemonic) {
      const isImported =
        this.wallet.activeAccountType === KeyringAccountType.Imported;

      const { mnemonic } = await getDecryptedVault(pwd);

      if (!mnemonic) {
        throw new Error('Mnemonic not found in vault or is empty');
      }

      let hdWalletSeed: string;
      // Try to detect if mnemonic is encrypted or plain text
      const isLikelyPlainMnemonic =
        mnemonic.includes(' ') &&
        (mnemonic.split(' ').length === 12 ||
          mnemonic.split(' ').length === 24);

      if (!isLikelyPlainMnemonic) {
        try {
          hdWalletSeed = CryptoJS.AES.decrypt(mnemonic, pwd).toString(
            CryptoJS.enc.Utf8
          );
        } catch (decryptError) {
          // If decryption fails, assume mnemonic is already decrypted
          console.warn(
            'Mnemonic decryption failed in restoreWallet, using as-is:',
            decryptError.message
          );
          hdWalletSeed = mnemonic;
        }
      } else {
        hdWalletSeed = mnemonic;
      }

      if (!hdWalletSeed) {
        throw new Error(
          'Failed to decrypt mnemonic or mnemonic is empty after decryption'
        );
      }

      if (isImported && this.activeChain === INetworkType.Syscoin) {
        const zprv = this.getDecryptedPrivateKey()?.decryptedPrivateKey;

        this.sessionMnemonic = CryptoJS.AES.encrypt(
          zprv,
          this.sessionPassword
        ).toString();
      } else {
        this.sessionMnemonic = CryptoJS.AES.encrypt(
          hdWalletSeed,
          this.sessionPassword
        ).toString();
      }

      const seed = (await mnemonicToSeed(hdWalletSeed)).toString('hex');

      this.sessionMainMnemonic = CryptoJS.AES.encrypt(
        hdWalletSeed,
        this.sessionPassword
      ).toString();

      this.sessionSeed = CryptoJS.AES.encrypt(
        seed,
        this.sessionPassword
      ).toString();
    }

    if (this.activeChain === INetworkType.Syscoin && !hdCreated) {
      const { rpc, isTestnet } = await this.getSignerUTXO(
        this.wallet.activeNetwork
      );
      await this.updateUTXOAccounts(rpc, isTestnet);
      if (!this.hd) throw new Error('Error initialising HD');
      this.hd.setAccountIndex(this.wallet.activeAccountId);
    }
  }

  private guaranteeUpdatedPrivateValues(pwd: string) {
    try {
      const isHDAccount =
        this.wallet.activeAccountType === KeyringAccountType.HDAccount;

      // Check if session values exist before trying to decrypt
      if (
        !this.sessionMainMnemonic ||
        !this.sessionMnemonic ||
        !this.sessionSeed
      ) {
        // Session values not initialized, skip update
        return;
      }

      //Here we need to decrypt the sessionMnemonic and sessionSeed values with the sessionPassword value before it changes and get updated
      const decryptedSessionMnemonic = CryptoJS.AES.decrypt(
        isHDAccount ? this.sessionMainMnemonic : this.sessionMnemonic,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      const decryptSessionSeed = CryptoJS.AES.decrypt(
        this.sessionSeed,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      const decryptedSessionMainMnemonic = CryptoJS.AES.decrypt(
        this.sessionMainMnemonic,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      //Generate a new salt
      this.currentSessionSalt = this.generateSalt();

      //Encrypt and generate a new sessionPassword to keep the values safe
      this.sessionPassword = this.encryptSHA512(pwd, this.currentSessionSalt);

      //Encrypt again the sessionSeed and sessionMnemonic after decrypt to keep it safe with the new sessionPassword value
      this.sessionSeed = CryptoJS.AES.encrypt(
        decryptSessionSeed,
        this.sessionPassword
      ).toString();

      this.sessionMnemonic = CryptoJS.AES.encrypt(
        decryptedSessionMnemonic,
        this.sessionPassword
      ).toString();

      this.sessionMainMnemonic = CryptoJS.AES.encrypt(
        decryptedSessionMainMnemonic,
        this.sessionPassword
      ).toString();
    } catch (error) {
      console.log('ERROR updateValuesToUpdateWalletKeys', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  }

  private async updateWalletKeys(pwd: string) {
    try {
      const vaultKeys = await this.storage.get('vault-keys');
      let { accounts } = this.wallet;

      const decryptedXprvs = Object.entries(accounts).reduce(
        (acc, [key, value]) => {
          const accounts = {};

          Object.entries(value).forEach(([key, value]) => {
            accounts[key] = CryptoJS.AES.decrypt(
              value.xprv,
              this.sessionPassword
            ).toString(CryptoJS.enc.Utf8);
          });

          acc[key] = accounts;
          return acc;
        },
        {}
      );

      //Update values
      this.guaranteeUpdatedPrivateValues(pwd);

      accounts = this.wallet.accounts;

      for (const accountTypeKey in accounts) {
        // Exclude 'Trezor' accounts
        if (accountTypeKey !== KeyringAccountType.Trezor) {
          // Iterate through each account in the current accountType
          for (const id in accounts[accountTypeKey as KeyringAccountType]) {
            const activeAccount =
              accounts[accountTypeKey as KeyringAccountType][id];
            const isBitcoinBased = !ethers.utils.isHexString(
              activeAccount.address
            );

            let encryptNewXprv = '';

            if (!isBitcoinBased) {
              try {
                let { mnemonic } = await getDecryptedVault(pwd);

                if (!mnemonic) {
                  console.warn(
                    'Mnemonic not found in vault, skipping Ethereum key update for account',
                    id
                  );
                  continue;
                }

                // Try to detect if mnemonic is encrypted or plain text
                const isLikelyPlainMnemonic =
                  mnemonic.includes(' ') &&
                  (mnemonic.split(' ').length === 12 ||
                    mnemonic.split(' ').length === 24);

                if (!isLikelyPlainMnemonic) {
                  try {
                    mnemonic = CryptoJS.AES.decrypt(mnemonic, pwd).toString(
                      CryptoJS.enc.Utf8
                    );
                  } catch (decryptError) {
                    // If decryption fails, assume mnemonic is already decrypted
                    console.warn(
                      'Mnemonic decryption failed in updateWalletKeys, using as-is:',
                      decryptError.message
                    );
                  }
                }

                // Validate mnemonic before using it
                if (!mnemonic || mnemonic.length < 10) {
                  console.warn(
                    'Invalid mnemonic detected, skipping Ethereum key update for account',
                    id
                  );
                  continue;
                }

                const { privateKey } = ethers.Wallet.fromMnemonic(mnemonic);

                encryptNewXprv = CryptoJS.AES.encrypt(
                  privateKey,
                  this.sessionPassword
                ).toString();
              } catch (mnemonicError) {
                console.warn(
                  'Failed to process mnemonic for Ethereum account',
                  id,
                  mnemonicError.message
                );
                continue;
              }
            } else {
              encryptNewXprv = CryptoJS.AES.encrypt(
                decryptedXprvs[accountTypeKey as KeyringAccountType][id],
                this.sessionPassword
              ).toString();
            }

            activeAccount.xprv = encryptNewXprv;
          }
        }
      }
      //Update new currentSessionSalt value to state to keep it equal as the created at the updateValuesToUpdateWalletKeys function
      this.storage.set('vault-keys', {
        ...vaultKeys,
        currentSessionSalt: this.currentSessionSalt,
      });
    } catch (error) {
      console.log('ERROR updateWalletKeys', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  }

  private async _getPrivateKeyAccountInfos(
    privKey: string,
    label?: string,
    targetNetwork?: INetwork
  ) {
    const { accounts } = this.wallet;
    let importedAccountValue: {
      address: string;
      privateKey: string;
      publicKey: string;
    };

    const balances = {
      syscoin: 0,
      ethereum: 0,
    };

    // Try to validate as extended private key first, regardless of prefix
    const networkToUse = targetNetwork || this.wallet.activeNetwork;
    const zprvValidation = this.validateZprv(privKey, networkToUse);

    if (zprvValidation.isValid) {
      const { node, network } = zprvValidation;

      if (!node || !network) {
        throw new Error('Failed to validate extended private key');
      }

      // Always use index 0 for consistency
      const nodeChild = node.derivePath(`0/0`);
      if (!nodeChild) {
        throw new Error('Failed to derive child node');
      }

      const { address } = bjs.payments.p2wpkh({
        pubkey: nodeChild.publicKey,
        network,
      });

      if (!address) {
        throw new Error('Failed to generate address');
      }

      importedAccountValue = {
        address,
        publicKey: node.neutered().toBase58(),
        privateKey: privKey,
      };

      balances.syscoin = 0;
    } else {
      // Check if the validation failed due to invalid key prefix (only for known extended key formats)
      if (
        zprvValidation.message &&
        zprvValidation.message.includes('Invalid key prefix')
      ) {
        throw new Error(zprvValidation.message);
      }

      // Check if it failed parsing as an extended key
      if (
        zprvValidation.message &&
        zprvValidation.message.includes('Failed to parse extended private key')
      ) {
        throw new Error(zprvValidation.message);
      }

      // If it's not an extended key, treat it as an Ethereum private key
      const hexPrivateKey =
        privKey.slice(0, 2) === '0x' ? privKey : `0x${privKey}`;

      // Validate it's a valid hex string (32 bytes = 64 hex chars)
      if (
        !/^0x[0-9a-fA-F]{64}$/.test(hexPrivateKey) &&
        !/^[0-9a-fA-F]{64}$/.test(privKey)
      ) {
        throw new Error(
          'Invalid private key format. Expected 32-byte hex string or extended private key.'
        );
      }

      importedAccountValue =
        this.ethereumTransaction.importAccount(hexPrivateKey);

      balances.ethereum = 0;
    }

    const { address, publicKey, privateKey } = importedAccountValue;

    //Validate if account already exists
    const accountAlreadyExists =
      (accounts[KeyringAccountType.Imported] &&
        Object.values(
          accounts[KeyringAccountType.Imported] as IKeyringAccountState[]
        ).some((account) => account.address === address)) ||
      Object.values(
        accounts[KeyringAccountType.HDAccount] as IKeyringAccountState[]
      ).some((account) => account.address === address); //Find a way to verify if private Key is not par of seed wallet derivation path

    if (accountAlreadyExists)
      throw new Error(
        'Account already exists, try again with another Private Key.'
      );

    const id =
      Object.values(accounts[KeyringAccountType.Imported]).length < 1
        ? 0
        : Object.values(accounts[KeyringAccountType.Imported]).length;

    return {
      ...initialActiveImportedAccountState,
      address,
      label: label ? label : `Imported ${id + 1}`,
      id,
      balances,
      isImported: true,
      xprv: CryptoJS.AES.encrypt(privateKey, this.sessionPassword).toString(),
      xpub: publicKey,
      assets: {
        syscoin: [],
        ethereum: [],
      },
    } as IKeyringAccountState;
  }

  // ===================================== ACCOUNT CACHE MANAGEMENT ===================================== //

  /**
   * Updates a single imported UTXO account's address for the target network
   */
  private updateImportedUTXOAccountAddress(
    accountId: number,
    account: IKeyringAccountState,
    targetNetwork: INetwork
  ): boolean {
    if (!account.xprv) return false;

    try {
      // Decrypt the private key
      const decryptedXprv = CryptoJS.AES.decrypt(
        account.xprv,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      // Validate with target network to get proper network config
      const validation = this.validateZprv(decryptedXprv, targetNetwork);
      if (!validation.isValid || !validation.node || !validation.network) {
        console.error(
          `Failed to validate imported account ${accountId}: ${validation.message}`
        );
        return false;
      }

      // Generate address with target network parameters
      const { address } = bjs.payments.p2wpkh({
        pubkey: validation.node.derivePath('0/0').publicKey,
        network: validation.network,
      });

      if (address) {
        // Update the wallet state with new address
        this.wallet.accounts[KeyringAccountType.Imported][accountId] = {
          ...account,
          address,
        };
        return true;
      }
    } catch (error) {
      console.error(
        `Error updating imported account ${accountId} address:`,
        error
      );
    }
    return false;
  }

  /**
   * Syncs accounts from wallet state to the appropriate cache based on chain type
   */
  private async syncAccountsToCache(chainType: INetworkType) {
    const cache =
      chainType === INetworkType.Ethereum
        ? this.ethAccountsCache
        : this.utxoAccountsCache;

    // Deep copy accounts to cache
    Object.keys(this.wallet.accounts).forEach((accountTypeKey) => {
      const accountType = accountTypeKey as KeyringAccountType;
      cache[accountType] = {};

      Object.entries(this.wallet.accounts[accountType]).forEach(
        ([id, account]) => {
          const cacheForType = cache[accountType];
          if (cacheForType) {
            cacheForType[Number(id)] = { ...account };
          }
        }
      );
    });

    // Persist cache to storage (encrypted)
    if (this.sessionPassword) {
      try {
        const cacheKey =
          chainType === INetworkType.Ethereum
            ? 'ethAccountsCache'
            : 'utxoAccountsCache';
        const encryptedCache = CryptoJS.AES.encrypt(
          JSON.stringify(cache),
          this.sessionPassword
        ).toString();
        await this.storage.set(cacheKey, encryptedCache);
      } catch (error) {
        console.log('Failed to persist account cache:', error);
      }
    }
  }

  /**
   * Loads accounts from storage cache
   */
  private async loadAccountsCacheFromStorage() {
    if (!this.sessionPassword) return;

    try {
      // Load ETH cache
      const ethCacheData = await this.storage.get('ethAccountsCache');
      if (ethCacheData && typeof ethCacheData === 'string') {
        try {
          const decryptedEth = CryptoJS.AES.decrypt(
            ethCacheData,
            this.sessionPassword
          ).toString(CryptoJS.enc.Utf8);
          if (decryptedEth && decryptedEth.trim()) {
            this.ethAccountsCache = JSON.parse(decryptedEth);
          }
        } catch (decryptError) {
          // Cache might be corrupted or from old version, ignore
          console.log('Failed to decrypt ETH cache, starting fresh');
          this.ethAccountsCache = {};
        }
      }

      // Load UTXO cache
      const utxoCacheData = await this.storage.get('utxoAccountsCache');
      if (utxoCacheData && typeof utxoCacheData === 'string') {
        try {
          const decryptedUtxo = CryptoJS.AES.decrypt(
            utxoCacheData,
            this.sessionPassword
          ).toString(CryptoJS.enc.Utf8);
          if (decryptedUtxo && decryptedUtxo.trim()) {
            this.utxoAccountsCache = JSON.parse(decryptedUtxo);
          }
        } catch (decryptError) {
          // Cache might be corrupted or from old version, ignore
          console.log('Failed to decrypt UTXO cache, starting fresh');
          this.utxoAccountsCache = {};
        }
      }
    } catch (error) {
      console.log('Failed to load account caches from storage:', error);
      // Initialize empty caches on error
      this.ethAccountsCache = {};
      this.utxoAccountsCache = {};
    }
  }

  /**
   * Updates UTXO account addresses without re-derivation
   * This is called when switching between UTXO networks
   */
  private updateUTXOAddressFormats(targetNetwork?: INetwork) {
    if (!this.hd || !this.syscoinSigner) return;

    const accounts = this.wallet.accounts[this.wallet.activeAccountType];
    const bipNum = 84;

    // Handle imported accounts differently - they don't support HD derivation
    if (this.wallet.activeAccountType === KeyringAccountType.Imported) {
      // For imported accounts, regenerate addresses with current network format
      const networkToUse = targetNetwork || this.wallet.activeNetwork;

      for (const [id, account] of Object.entries(accounts)) {
        if (!account.xprv) continue;
        this.updateImportedUTXOAccountAddress(
          Number(id),
          account,
          networkToUse
        );
      }
      return;
    }

    // Original HD account handling for non-imported accounts

    // First ensure HD signer has all the accounts
    for (const [id] of Object.entries(accounts)) {
      const accountId = Number(id);

      // Create account in HD signer if it doesn't exist
      if (!this.hd.Signer.accounts[accountId]) {
        const childAccount = this.hd.deriveAccount(accountId, bipNum);
        const derivedAccount = new BIP84.fromZPrv(
          childAccount,
          this.hd.Signer.pubTypes,
          this.hd.Signer.networks
        );

        // Ensure the accounts array is large enough
        while (this.hd.Signer.accounts.length <= accountId) {
          this.hd.Signer.accounts.push(null);
        }
        this.hd.Signer.accounts[accountId] = derivedAccount;
      }
    }

    // Now update addresses - always use index 0 for consistency with EVM
    for (const [id, account] of Object.entries(accounts)) {
      const accountId = Number(id);

      // Get the new address format for current network - always use index 0
      const address = this.hd.Signer.accounts[accountId].getAddress(
        0,
        false,
        bipNum
      );

      // Update only the address
      this.wallet.accounts[this.wallet.activeAccountType][accountId] = {
        ...account,
        address,
      };
    }
  }
}

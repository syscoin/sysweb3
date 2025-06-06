//@ts-nocheck @ts-ignore
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
} from './types';
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

const ethHdPath: Readonly<string> = "m/44'/60'/0'";

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

  public addNewAccount = async (label?: string) => {
    const network = this.wallet.activeNetwork;
    const mnemonic = this.sessionSeed;
    const isSyscoinChain = this.isSyscoinChain(network);

    if (isSyscoinChain) {
      return this.addNewAccountToSyscoinChain(network, label);
    }

    if (!mnemonic) {
      throw new Error('Seed phrase is required to create a new account.');
    }

    return this.addNewAccountToEth(label);
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
      mnemonic = CryptoJS.AES.decrypt(mnemonic, this.memPassword).toString(
        CryptoJS.enc.Utf8
      );
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
      return rootAccount;
    } catch (error) {
      console.log('ERROR createKeyringVault', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  };

  public setActiveAccount = async (
    accountId: number,
    accountType: KeyringAccountType
  ) => {
    if (!this.hd && this.activeChain === INetworkType.Syscoin)
      throw new Error(
        'Initialise wallet first, cant change accounts without an active HD'
      );

    // Don't set account index here - it will be set after updateUTXOAccounts

    const accounts = this.wallet.accounts[accountType];
    if (!accounts[accountId].xpub) throw new Error('Account not set');
    this.wallet = {
      ...this.wallet,
      activeAccountId: accounts[accountId].id,
      activeAccountType: accountType,
    };

    if (this.activeChain === INetworkType.Syscoin) {
      const isHDAccount = accountType === KeyringAccountType.HDAccount;

      this.sessionMnemonic = isHDAccount
        ? this.sessionMainMnemonic
        : accounts[accountId].xprv;

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
        this.hd.setAccountIndex(accountId);
      }
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

  public getEncryptedXprv = () =>
    CryptoJS.AES.encrypt(
      this.getSysActivePrivateKey(),
      this.sessionPassword
    ).toString();

  public getSeed = async (pwd: string) => {
    const genPwd = this.encryptSHA512(pwd, this.currentSessionSalt);
    if (!this.sessionPassword) {
      throw new Error('Unlock wallet first');
    } else if (this.sessionPassword !== genPwd) {
      throw new Error('Invalid password');
    }
    let { mnemonic } = await getDecryptedVault(pwd);
    mnemonic = CryptoJS.AES.decrypt(mnemonic, pwd).toString(CryptoJS.enc.Utf8);

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
    sucess: boolean;
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
      if (chain === INetworkType.Syscoin) {
        const { rpc, isTestnet } = await this.getSignerUTXO(network);

        // Check if HD signer needs to be recreated due to network changes
        const needsHDSignerUpdate = this.shouldUpdateHDSigner(rpc, isTestnet);

        if (needsHDSignerUpdate) {
          await this.updateUTXOAccounts(rpc, isTestnet);
        }

        if (!this.hd) throw new Error('Error initialising HD');
        this.hd.setAccountIndex(this.wallet.activeAccountId);
      } else if (chain === INetworkType.Ethereum) {
        await this.setSignerEVM(network);
        await this.updateWeb3Accounts();
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

      this.wallet.activeNetwork = network;
      this.activeChain = networkChain;

      return {
        sucess: true,
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

      return { sucess: false };
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
    slip44: string,
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
    slip44: string,
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

  //TODO: validate updateAllPrivateKeyAccounts updating 2 accounts or more works properly
  public async updateAllPrivateKeyAccounts() {
    try {
      const { activeAccountId } = this.wallet;

      const accountPromises = Object.values(
        this.wallet.accounts[KeyringAccountType.Imported]
      ).map(
        async (account) =>
          await this.updatePrivWeb3Account(account, activeAccountId)
      );

      const updatedWallets = await Promise.all(accountPromises);

      this.wallet.accounts[KeyringAccountType.Imported] = updatedWallets;
    } catch (error) {
      console.log('ERROR updateAllPrivateKeyAccounts', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  }

  public updateAccountLabel = (
    label: string,
    accountId: number,
    accountType: KeyringAccountType
  ) => {
    this.wallet.accounts[accountType][accountId].label = label;
  };

  public validateZprv(zprv: string, targetNetwork: INetwork) {
    if (!targetNetwork) {
      throw new Error('Target network is required for validation');
    }

    try {
      const bip32 = BIP32Factory(ecc);
      const decoded = bs58check.decode(zprv);

      if (decoded.length !== 78) {
        throw new Error('Invalid length for a BIP-32 key');
      }

      // Use the network's currency and slip44 to get proper network config
      const { networks } = getNetworkConfig(
        targetNetwork.slip44 || targetNetwork.chainId,
        targetNetwork.currency || 'Bitcoin'
      );

      const isTestnet =
        targetNetwork.isTestnet || targetNetwork.chainId === 5700;
      const network = isTestnet ? networks.testnet : networks.mainnet;

      const node = bip32.fromBase58(zprv, network);
      if (!node.privateKey) {
        throw new Error('Private key not found in extended private key');
      }
      if (!ecc.isPrivate(node.privateKey)) {
        throw new Error('Invalid private key for secp256k1 curve');
      }

      return {
        isValid: true,
        node,
        network,
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

      const { xprv, address } = accounts[activeAccountType][activeAccountId];
      const decryptedPrivateKey = CryptoJS.AES.decrypt(
        xprv,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      return {
        address,
        decryptedPrivateKey,
      };
    } catch (error) {
      console.log('ERROR getDecryptedPrivateKey', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
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
      await this.getFormattedBackendAccount({
        url: this.wallet.activeNetwork.url,
        xpub,
        id: this.hd.Signer.accountIndex,
        activeAccountId: this.hd.Signer.accountIndex,
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

  private addUTXOAccount = async (
    accountId: number,
    activeAccountId: number
  ): Promise<any> => {
    try {
      if (this.hd === null) throw new Error('No HD Signer');

      // Create the specific account if it doesn't exist
      if (!this.hd.Signer.accounts[accountId]) {
        // Derive the specific account we need
        const childAccount = this.hd.deriveAccount(accountId, 84);

        // Create the BIP84 account directly and insert it at the correct index
        const derivedAccount = new BIP84.fromZPrv(
          childAccount,
          this.hd.Signer.pubTypes,
          this.hd.Signer.networks
        );

        // Ensure the accounts array is large enough and insert at the correct index
        while (this.hd.Signer.accounts.length <= accountId) {
          this.hd.Signer.accounts.push(null);
        }
        this.hd.Signer.accounts[accountId] = derivedAccount;
      }

      // Check if wallet account already exists and we're not dealing with the active account
      const existingWalletAccount =
        this.wallet.accounts[this.wallet.activeAccountType][accountId];
      const isActiveAccount = accountId === activeAccountId;

      // Only update wallet account if it doesn't exist or if it's the active account (which needs fresh balance data)
      if (!existingWalletAccount || isActiveAccount) {
        // Temporarily set account index to get correct xpub/xprv for this specific account
        const originalAccountIndex = this.hd.Signer.accountIndex;
        this.hd.setAccountIndex(accountId);
        const xpub = this.hd.getAccountXpub();
        const xprv = this.getEncryptedXprv();
        // Restore original account index
        this.hd.setAccountIndex(originalAccountIndex);

        const basicAccountInfo = await this.getBasicSysAccountInfo(
          xpub,
          accountId,
          activeAccountId
        );

        const isImported =
          this.wallet.activeAccountType === KeyringAccountType.Imported;

        const createdAccount = {
          xprv,
          isImported,
          ...basicAccountInfo,
        };
        this.wallet.accounts[this.wallet.activeAccountType][accountId] =
          createdAccount;
      }
    } catch (error) {
      console.log('ERROR addUTXOAccount', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  };

  private getBasicSysAccountInfo = async (
    xpub: string,
    id: number,
    activeAccountId: number
  ) => {
    if (!this.syscoinSigner) throw new Error('No HD Signer');
    const label = this.wallet.accounts[KeyringAccountType.HDAccount][id].label;
    const formattedBackendAccount = await this.getFormattedBackendAccount({
      url: this.syscoinSigner.blockbookURL,
      xpub,
      id,
      activeAccountId,
    });
    return {
      id,
      isTrezorWallet: false,
      isLedgerWallet: false,
      label: label ? label : `Account ${Number(id) + 1}`,
      ...formattedBackendAccount,
    };
  };

  private async _createTrezorAccount(
    coin: string,
    slip44: string,
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

    const isEVM = coin === 'eth';

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
    slip44: string,
    index: string,
    label?: string
  ) {
    const { accounts, activeNetwork } = this.wallet;
    let xpub;
    let address = '';
    let balance;

    if (coin === 'eth') {
      const { address: ethAddress, publicKey } =
        await this.ledgerSigner.evm.getEvmAddressAndPubKey({
          accountIndex: +index,
        });
      const ethBalance = await this.ethereumTransaction.getBalance(ethAddress);
      address = ethAddress;
      xpub = publicKey;
      balance = ethBalance;
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

        const options = 'tokens=used&details=tokens';
        const { balance: sysBalance } =
          await syscoinjs.utils.fetchBackendAccount(
            this.wallet.activeNetwork.url,
            xpub,
            options,
            true,
            undefined
          );
        balance = sysBalance;
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

    const currentBalances =
      coin === 'eth'
        ? { syscoin: 0, ethereum: balance }
        : { syscoin: +balance / 1e8, ethereum: 0 };

    const ledgerAccount = {
      ...this.initialLedgerAccountState,
      balances: currentBalances,
      address,
      originNetwork: { ...activeNetwork, isBitcoinBased: coin !== 'eth' },
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

  private getFormattedBackendAccount = async ({
    url,
    xpub,
    id,
    activeAccountId,
  }: {
    activeAccountId: number;
    id: number;
    url: string;
    xpub: string;
  }): Promise<ISysAccount> => {
    if (this.hd === null) throw new Error('No HD Signer');
    const bipNum = 84; //TODO: we need to change this logic to use descriptors for now we only use bip84
    const options = 'tokens=used&details=tokens';
    let balance = 0;
    let receivingIndex = 0;
    let stealthAddr = '';
    try {
      // only fetch backend account for the active account
      if (id === activeAccountId) {
        const { balance: _balance, tokens } =
          await syscoinjs.utils.fetchBackendAccount(
            url,
            xpub,
            options,
            true,
            undefined
          );
        const indexes = this.setLatestIndexesFromXPubTokens(tokens);
        receivingIndex = indexes.receivingIndex;
        balance = _balance;
      }
      stealthAddr = this.hd.Signer.accounts[id].getAddress(
        receivingIndex,
        false,
        bipNum
      );
    } catch (e) {
      throw new Error(`Error fetching account from network ${url}: ${e}`);
    }

    return {
      address: stealthAddr,
      xpub: xpub,
      balances: {
        syscoin: balance / 1e8,
        ethereum: 0,
      },
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
  private async addNewAccountToSyscoinChain(network: any, label?: string) {
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

      const latestUpdate: ISysAccount = await this.getFormattedBackendAccount({
        url: network.url,
        xpub,
        id,
        id,
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
      const derivedCurrentAccount = privateRoot.derivePath(
        `${ethHdPath}/0/${length}`
      );
      const newWallet = derivedCurrentAccount.getWallet();
      const address = newWallet.getAddressString();
      const xprv = newWallet.getPrivateKeyString();
      const xpub = newWallet.getPublicKeyString();

      const basicAccountInfo = await this.getBasicWeb3AccountInfo(
        address,
        length,
        label,
        length // This new account will become active, so fetch balance
      );

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

  private getBasicWeb3AccountInfo = async (
    address: string,
    id: number,
    label?: string,
    activeAccountId?: number
  ) => {
    let balance = 0;

    // Only fetch balance for the active account
    if (activeAccountId !== undefined && id === activeAccountId) {
      balance = await this.ethereumTransaction.getBalance(address);
    }

    return {
      id,
      isTrezorWallet: false,
      isLedgerWallet: false,
      label: label ? label : `Account ${id + 1}`,
      balances: {
        syscoin: 0,
        ethereum: balance,
      },
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

      if (
        accounts[KeyringAccountType.Imported] &&
        Object.keys(accounts[KeyringAccountType.Imported]).length > 0
      ) {
        await this.updateAllPrivateKeyAccounts();
      }

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

        const derivedCurrentAccount = privateRoot.derivePath(
          `${ethHdPath}/0/${String(id)}`
        );

        const derievedWallet = derivedCurrentAccount.getWallet();
        const address = derievedWallet.getAddressString();
        const xprv = derievedWallet.getPrivateKeyString();
        const xpub = derievedWallet.getPublicKeyString();

        const basicAccountInfo = await this.getBasicWeb3AccountInfo(
          address,
          id,
          label,
          activeAccountId
        );

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
    isTestnet: boolean
  ) => {
    try {
      if (!this.sessionPassword) {
        throw new Error('Unlock wallet first');
      }
      const accounts = this.wallet.accounts[this.wallet.activeAccountType];
      const isHDAccount =
        this.wallet.activeAccountType === KeyringAccountType.HDAccount;

      const encryptedMnemonic = isHDAccount
        ? this.sessionMainMnemonic
        : this.sessionMnemonic;

      const mnemonic = CryptoJS.AES.decrypt(
        encryptedMnemonic,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      const { hd, main } = getSyscoinSigners({
        mnemonic,
        isTestnet,
        rpc,
      });

      this.hd = hd;
      this.syscoinSigner = main;

      // Initialize with account index 0, will be set correctly after account restoration
      this.hd.setAccountIndex(0);

      // Recreate all existing accounts in the new HD signer
      const walletAccountsArray = isHDAccount
        ? Object.values(accounts)
        : Object.values(accounts).filter(
            ({ address }) => !ethers.utils.isAddress(address)
          );

      // Create an array of promises.
      const accountPromises = walletAccountsArray.map(async ({ id }) => {
        await this.addUTXOAccount(Number(id), this.wallet.activeAccountId);
      });
      await Promise.all(accountPromises);

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
  private async updatePrivWeb3Account(
    account: IKeyringAccountState,
    activeAccountId?: number
  ) {
    const isEthAddress = ethers.utils.isAddress(account.address);
    let balance: null | number = null;

    // Only fetch balance for the active account
    const isActiveAccount =
      activeAccountId !== undefined && account.id === activeAccountId;

    if (isActiveAccount) {
      if (isEthAddress) {
        balance = await this.ethereumTransaction.getBalance(account.address);
      } else {
        const networkUrl =
          this.wallet.networks.syscoin[
            this.wallet.activeNetwork.isTestnet ? '5700' : '57'
          ].url;
        const options = 'tokens=used&details=tokens';
        const response = await syscoinjs.utils.fetchBackendAccount(
          networkUrl,
          account.xpub,
          options,
          true,
          undefined
        );

        if (response !== null) balance = response.balance / 1e8;
      }
    }

    const updatedAccount = {
      ...account,
      balances: {
        syscoin:
          !isEthAddress && balance !== null
            ? balance
            : account.balances.syscoin,
        ethereum:
          isEthAddress && balance !== null
            ? balance
            : account.balances.ethereum,
      },
    } as IKeyringAccountState;

    return updatedAccount;
  }

  private async restoreWallet(hdCreated: boolean, pwd: string) {
    if (!this.sessionMnemonic) {
      const isImported =
        this.wallet.activeAccountType === KeyringAccountType.Imported;

      const { mnemonic } = await getDecryptedVault(pwd);
      const hdWalletSeed = CryptoJS.AES.decrypt(mnemonic, pwd).toString(
        CryptoJS.enc.Utf8
      );

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
                mnemonic = CryptoJS.AES.decrypt(mnemonic, pwd).toString(
                  CryptoJS.enc.Utf8
                );

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

      // Use the target network's URL for balance fetching
      const { balance: _balance, tokens } =
        await syscoinjs.utils.fetchBackendAccount(
          networkToUse.url,
          node.neutered().toBase58(),
          'tokens=used&details=tokens',
          true,
          undefined
        );
      const { receivingIndex } = this.setLatestIndexesFromXPubTokens(tokens);

      const nodeChild = node.derivePath(`0/${receivingIndex}`);
      const { address } = bjs.payments.p2wpkh({
        pubkey: Buffer.from(nodeChild.publicKey),
        network,
      });

      importedAccountValue = {
        address,
        publicKey: node.neutered().toBase58(),
        privateKey: privKey,
      };

      balances.syscoin = _balance / 1e8;
    } else {
      // It's an Ethereum private key
      const hexPrivateKey =
        privKey.slice(0, 2) === '0x' ? privKey : `0x${privKey}`;

      // Validate it's a valid hex string (32 bytes = 64 hex chars)
      if (
        !/^0x[0-9a-fA-F]{64}$/.test(hexPrivateKey) &&
        !/^[0-9a-fA-F]{64}$/.test(hexPrivateKey)
      ) {
        throw new Error(
          'Invalid private key format. Expected 32-byte hex string or extended private key.'
        );
      }

      importedAccountValue =
        this.ethereumTransaction.importAccount(hexPrivateKey);

      balances.ethereum = await this.ethereumTransaction.getBalance(
        importedAccountValue.address
      );
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
}

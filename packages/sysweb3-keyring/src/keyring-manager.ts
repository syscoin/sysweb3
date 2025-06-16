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
import { getAddressDerivationPath, isEvmCoin } from './utils/derivation-paths';
import * as sysweb3 from '@pollum-io/sysweb3-core';
import {
  getSysRpc,
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

  // NEW: Separate HD signers for main seed vs imported
  private hdMain: SyscoinHDSigner | null = null; // Main HD signer from seed
  private hdImportedByAccountId: Map<number, SyscoinHDSigner> = new Map(); // Imported zprvs

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
      // Load wallet state with migration support (async loading will happen in initialize methods)
      this.wallet = JSON.parse(JSON.stringify(opts.wallet));

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
      // Create a deep copy of the initial wallet state to prevent contamination
      this.wallet = JSON.parse(JSON.stringify(initialWalletState));
      this.activeChain = INetworkType.Syscoin;
      this.hd = null;
    }

    this.utf8Error = false;
    this.memMnemonic = '';
    this.sessionSeed = '';
    this.sessionMnemonic = '';
    this.sessionMainMnemonic = '';
    this.memPassword = '';
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

  // Static factory method for creating a fully initialized KeyringManager with slip44 support
  public static async createInitialized(
    seed: string,
    password: string,
    walletState: IWalletState,
    chainType: INetworkType
  ): Promise<KeyringManager> {
    const keyringManager = new KeyringManager({
      wallet: walletState,
      activeChain: chainType,
    });

    // Set the seed
    keyringManager.setSeed(seed);

    // Set the wallet password
    await keyringManager.setWalletPassword(password);

    // Create the keyring vault - it will use the activeNetwork and activeChain to determine account type
    await keyringManager.createKeyringVault();

    // Set the active account based on the wallet state (respects activeAccountId)
    try {
      await keyringManager.setActiveAccount(
        keyringManager.wallet.activeAccountId,
        keyringManager.wallet.activeAccountType
      );
    } catch (error) {
      // If the specified active account doesn't exist, that's fine
      // The vault creation already set account 0 as active
      console.warn(
        `[KeyringManager] Could not set active account ${keyringManager.wallet.activeAccountId}, using account 0:`,
        error.message
      );
    }

    return keyringManager;
  }

  // Convenience method for complete setup after construction
  public async initialize(
    seed: string,
    password: string,
    network?: INetwork
  ): Promise<IKeyringAccountState> {
    // Set the seed
    this.setSeed(seed);

    // Set the network if provided (this is crucial for proper address derivation)
    if (network) {
      await this.setSignerNetwork(network, this.activeChain);
    }

    // Set the wallet password
    await this.setWalletPassword(password);

    // Create the keyring vault
    const account = await this.createKeyringVault();

    // Set the created account as active
    await this.setActiveAccount(account.id, this.validateAccountType(account));

    return account;
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
    // addNewAccount should only create accounts from the main seed
    // For importing accounts (including zprvs), use importAccount
    if (this.activeChain === INetworkType.Syscoin) {
      return await this.addNewAccountToSyscoinChain(label);
    } else {
      // EVM chainType
      return await this.addNewAccountToEth(label);
    }
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
    if (prvPwd) await this.updateWalletKeys(prvPwd);

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

        let needsRestore = false;
        const hdCreated = !!this.hd;
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
        if (needsRestore || !hdCreated || !this.sessionMnemonic) {
          await this.restoreWallet(hdCreated, password);
        }

        if (hasUtf8Error) {
          wallet = this.wallet;
        }

        await this.updateWalletKeys(password);

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

      // Store the seed for account creation
      const seed = (await mnemonicToSeed(mnemonic)).toString('hex');
      this.sessionSeed = CryptoJS.AES.encrypt(
        seed,
        this.sessionPassword
      ).toString();

      // Initialize wallet accounts structure if empty
      if (!this.wallet.accounts[KeyringAccountType.HDAccount]) {
        this.wallet.accounts[KeyringAccountType.HDAccount] = {};
      }

      // Create account 0 directly (it will be set as active anyway)
      let rootAccount: IKeyringAccountState;
      if (this.activeChain === INetworkType.Ethereum) {
        // For EVM: Set up provider and create account 0 directly
        await this.setSignerEVM(this.wallet.activeNetwork);
        rootAccount = await this.addNewAccountToEth();
      } else {
        // For UTXO: Create account 0 directly
        const { rpc } = await this.getSignerUTXO(this.wallet.activeNetwork);
        const { hd } = getSyscoinSigners({ mnemonic, rpc });

        this.hd = hd;
        this.hdMain = hd; // Set as main HD signer

        this.syscoinSigner = new syscoinjs.SyscoinJSLib(
          hd,
          this.wallet.activeNetwork.url,
          undefined
        );

        const xpub = hd.getAccountXpub();
        const sysAccount = this.getFormattedBackendAccount({
          xpub,
          id: 0,
        });

        rootAccount = this.getInitialAccountData({
          label: 'Account 1',
          signer: hd,
          sysAccount,
          xprv: this.getEncryptedXprv(),
        });
      }

      // Store account 0 in the wallet and set as active
      this.wallet.accounts[KeyringAccountType.HDAccount][rootAccount.id] =
        rootAccount;
      this.wallet.activeAccountId = rootAccount.id;
      this.wallet.activeAccountType = KeyringAccountType.HDAccount;

      this.memPassword = '';
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
    const accounts = this.wallet.accounts[accountType];
    if (!accounts[id]) throw new Error('Account not found');
    if (!accounts[id].xpub) throw new Error('Account not set');

    this.wallet = {
      ...this.wallet,
      activeAccountId: id,
      activeAccountType: accountType,
    };

    // Handle UTXO-specific logic
    if (this.activeChain === INetworkType.Syscoin) {
      let hdSigner: SyscoinHDSigner | null = null;

      if (accountType === KeyringAccountType.HDAccount) {
        // For HD accounts, use the main HD signer
        if (!this.hdMain) {
          const { rpc } = await this.getSignerUTXO(this.wallet.activeNetwork);
          this.hdMain = await this.createHDSignerFromMainSeed(id, rpc);
          // Account is already set by createAccountAtIndex, no need to set again
        } else {
          // HD signer already exists, just switch to the requested account
          this.hdMain.setAccountIndex(id);
        }
        hdSigner = this.hdMain;
      } else if (accountType === KeyringAccountType.Imported) {
        // Check if this imported account has an HD signer
        hdSigner = this.hdImportedByAccountId.get(id) || null;

        if (!hdSigner) {
          // For imported accounts with zprv, create HD from that zprv
          const account = accounts[id];
          const decryptedXprv = CryptoJS.AES.decrypt(
            account.xprv,
            this.sessionPassword
          ).toString(CryptoJS.enc.Utf8);

          if (!decryptedXprv) {
            throw new Error('Failed to decrypt account private key');
          }

          if (this.isZprv(decryptedXprv)) {
            // It's a zprv, create HD signer from it
            const { rpc } = await this.getSignerUTXO(this.wallet.activeNetwork);
            hdSigner = await this.createHDSignerFromZprv(decryptedXprv, rpc);
            this.hdImportedByAccountId.set(id, hdSigner);
          } else {
            throw new Error('Imported account does not have a valid zprv');
          }
        }
      }

      if (hdSigner) {
        this.hd = hdSigner;
        this.syscoinSigner = new syscoinjs.SyscoinJSLib(
          hdSigner,
          this.wallet.activeNetwork.url,
          undefined
        );
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

      if (!decryptedPrivateKey) {
        throw new Error(
          'Failed to decrypt private key. Invalid password or corrupted data.'
        );
      }

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

    // For UTXO networks, only allow updating the same network (e.g., changing RPC URL)
    if (chainType === INetworkType.Syscoin) {
      if (data.chainId !== this.wallet.activeNetwork.chainId) {
        throw new Error(
          'Cannot change UTXO network. Each UTXO network has its own keyring instance.'
        );
      }
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
    // Only EVM networks can be added dynamically
    if (chain !== INetworkType.Ethereum) {
      throw new Error(
        'Custom networks can only be added for EVM. UTXO networks require separate keyring instances.'
      );
    }

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
    // Only EVM networks can be removed dynamically
    if (chain !== INetworkType.Ethereum) {
      throw new Error(
        'Networks can only be removed for EVM. UTXO networks have dedicated keyrings.'
      );
    }

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

    // With multi-keyring architecture, each keyring is dedicated to specific slip44
    if (INetworkType.Ethereum !== chain && INetworkType.Syscoin !== chain) {
      throw new Error('Unsupported chain');
    }

    // Validate network/chain type compatibility
    if (chain === INetworkType.Ethereum && network.slip44 !== 60) {
      throw new Error('Cannot use Ethereum chain type with Syscoin network');
    }
    if (chain === INetworkType.Syscoin && network.slip44 === 60) {
      throw new Error('Cannot use Syscoin chain type with Ethereum network');
    }

    // CRITICAL: Prevent UTXO-to-UTXO network switching within same keyring
    // Each UTXO network should have its own KeyringManager instance based on slip44
    if (
      this.activeChain === INetworkType.Syscoin &&
      this.wallet.activeNetwork
    ) {
      const currentSlip44 = this.wallet.activeNetwork.slip44;
      const newSlip44 = network.slip44;

      if (currentSlip44 !== newSlip44) {
        throw new Error(
          `Cannot switch between different UTXO networks within the same keyring. ` +
            `Current network uses slip44=${currentSlip44}, target network uses slip44=${newSlip44}. ` +
            `Each UTXO network requires a separate KeyringManager instance.`
        );
      }
    }

    const networkChain: INetworkType =
      INetworkType.Ethereum === chain
        ? INetworkType.Ethereum
        : INetworkType.Syscoin;

    try {
      // With multi-keyring architecture:
      // - UTXO: Each keyring is dedicated to one network (slip44), so this is only called during initialization
      // - EVM: All EVM networks share slip44=60, so network can change within the same keyring

      if (chain === INetworkType.Syscoin) {
        // For UTXO networks, this should only be called during initial setup
        // as each UTXO network has its own keyring manager
        if (!this.hd || !this.syscoinSigner) {
          // Initial setup - use the current wallet state (which persists per keyring)
          // The wallet state already contains the correct activeAccountId for this keyring
          const accountId = this.wallet.activeAccountId || 0;
          const accountType =
            this.wallet.activeAccountType || KeyringAccountType.HDAccount;

          await this.setActiveAccount(accountId, accountType);

          if (!this.hd) throw new Error('Error initialising HD');
        }
        // If HD signer already exists, the active account is already set correctly
      } else if (chain === INetworkType.Ethereum) {
        // For EVM, network can change within the same keyring manager (all use slip44=60)
        // First update the provider with new network
        await this.setSignerEVM(network);

        // Only derive accounts if none exist (first time setup)
        if (
          !this.wallet.accounts[KeyringAccountType.HDAccount] ||
          Object.keys(this.wallet.accounts[KeyringAccountType.HDAccount])
            .length === 0
        ) {
          await this.updateWeb3Accounts();
        }
      }

      // Update network configuration
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

  public async importTrezorAccount(label?: string) {
    const importedAccount = await this._createTrezorAccount(
      this.wallet.activeNetwork.currency!,
      this.wallet.activeNetwork.slip44,
      Object.values(this.wallet.accounts[KeyringAccountType.Trezor]).length
    );
    importedAccount.label = label ? label : `Trezor ${importedAccount.id + 1}`;
    this.wallet.accounts[KeyringAccountType.Trezor][importedAccount.id] =
      importedAccount;
    return importedAccount;
  }

  public async importLedgerAccount(
    isAlreadyConnected: boolean,
    label?: string
  ) {
    try {
      const connectionResponse = isAlreadyConnected
        ? true
        : await this.ledgerSigner.connectToLedgerDevice();

      if (connectionResponse) {
        const importedAccount = await this._createLedgerAccount(
          this.wallet.activeNetwork.currency!,
          this.wallet.activeNetwork.slip44,
          Object.values(this.wallet.accounts[KeyringAccountType.Ledger]).length
        );
        importedAccount.label = label
          ? label
          : `Ledger ${importedAccount.id + 1}`;
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

  public async importAccount(privKey: string, label?: string) {
    const importedAccount = await this._getPrivateKeyAccountInfos(
      privKey,
      label
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
    // Use the active network if targetNetwork is not provided
    const networkToValidateAgainst = targetNetwork || this.wallet.activeNetwork;

    if (!networkToValidateAgainst) {
      throw new Error('No network available for validation');
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

      // Get network configuration for the target network
      const { networks, types } = getNetworkConfig(
        networkToValidateAgainst.slip44,
        networkToValidateAgainst.currency || 'Bitcoin'
      );

      // For BIP84 (zprv/zpub), we need to use the correct magic bytes from zPubType
      // Use testnet types for vprv/vpub, mainnet types for zprv/zpub
      const isTestnet = prefix === 'vprv';
      const pubTypes = isTestnet
        ? (types.zPubType as any).testnet
        : types.zPubType.mainnet;
      const baseNetwork = isTestnet ? networks.testnet : networks.mainnet;

      const network = {
        ...baseNetwork,
        bip32: {
          public: parseInt(pubTypes.vpub || pubTypes.zpub, 16),
          private: parseInt(pubTypes.vprv || pubTypes.zprv, 16),
        },
      };

      // Validate that the key prefix matches the expected network format
      // This ensures the key was generated for a compatible network
      const expectedPrefixes = ['zprv', 'vprv', 'xprv', 'yprv']; // Accept various BIP32/84 formats
      if (!expectedPrefixes.includes(prefix)) {
        throw new Error(
          `Invalid extended private key prefix: ${prefix}. Expected one of: ${expectedPrefixes.join(
            ', '
          )}`
        );
      }

      // Strict network matching - only allow keys that match the target network
      let node;
      try {
        node = bip32.fromBase58(zprv, network);
      } catch (e) {
        throw new Error(
          `Extended private key is not compatible with ${networkToValidateAgainst.label}. Please use a key generated for this specific network.`
        );
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
        network,
        message: 'The extended private key is valid for this network.',
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

  private getSysActivePrivateKey = () => {
    if (this.hd === null) throw new Error('No HD Signer');

    const accountIndex = this.hd.Signer.accountIndex;

    // Verify the account exists now
    if (!this.hd.Signer.accounts.has(accountIndex)) {
      throw new Error(`Account at index ${accountIndex} could not be created`);
    }

    return this.hd.Signer.accounts.get(accountIndex).getAccountPrivateKey();
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
    index: number,
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
    index: number,
    label?: string
  ) {
    const { accounts, activeNetwork } = this.wallet;
    let xpub;
    let address = '';
    if (isEvmCoin(coin, slip44)) {
      const { address: ethAddress, publicKey } =
        await this.ledgerSigner.evm.getEvmAddressAndPubKey({
          accountIndex: index,
        });
      address = ethAddress;
      xpub = publicKey;
    } else {
      try {
        const ledgerXpub = await this.ledgerSigner.utxo.getXpub({
          index: index,
          coin,
          slip44,
          withDecriptor: true,
        });
        xpub = ledgerXpub;
        address = await this.ledgerSigner.utxo.getUtxoAddress({
          coin,
          index: index,
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
      if (!this.hd.Signer.accounts.has(id)) {
        throw new Error('Account not found');
      }

      address = this.hd.Signer.accounts.get(id).getAddress(0, false, 84);
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

  private async addNewAccountToSyscoinChain(label?: string) {
    try {
      if (!this.hdMain) {
        await this.setActiveAccount(0, KeyringAccountType.HDAccount);
        // Verify hdMain was initialized
        if (!this.hdMain) {
          throw new Error('Failed to initialize HD signer from main seed');
        }
      }

      // Get next available account ID
      const accounts = this.wallet.accounts[KeyringAccountType.HDAccount];
      const nextId = this.getNextAccountId(accounts);

      // Create account at the specific index
      await this.hdMain.createAccountAtIndex(nextId, 84);

      const xpub = this.hdMain.getAccountXpub();
      const sysAccount = this.getFormattedBackendAccount({
        xpub,
        id: nextId,
      });

      const accountData = this.getInitialAccountData({
        label: label || `Account ${nextId + 1}`,
        signer: this.hdMain,
        sysAccount,
        xprv: this.getEncryptedXprv(),
      });

      // Store the new account
      this.wallet.accounts[KeyringAccountType.HDAccount][nextId] = accountData;

      return accountData;
    } catch (error) {
      console.log('ERROR addNewAccountToSyscoinChain', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
      throw error;
    }
  }

  private async addNewAccountToEth(label?: string) {
    try {
      // Get next available account ID
      const accounts = this.wallet.accounts[KeyringAccountType.HDAccount];
      const nextId = this.getNextAccountId(accounts);

      await this.setDerivedWeb3Accounts(
        nextId,
        label || `Account ${nextId + 1}`
      );

      const newAccount =
        this.wallet.accounts[KeyringAccountType.HDAccount][nextId];

      return newAccount;
    } catch (error) {
      console.log('ERROR addNewAccountToEth', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
      throw error;
    }
  }

  // Helper method to get next available account ID
  private getNextAccountId(accounts: any): number {
    const existingIds = Object.keys(accounts)
      .map((id) => parseInt(id, 10))
      .filter((id) => !isNaN(id));

    if (existingIds.length === 0) {
      return 0;
    }

    return Math.max(...existingIds) + 1;
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
      const hdAccounts = Object.entries(accounts[KeyringAccountType.HDAccount]);

      //Account of HDAccount is always initialized as it is required to create a network
      // Create array of promises for parallel execution
      const hdAccountPromises = hdAccounts.map(([accountId, account]) => {
        const id = Number(accountId);
        const label = account.label;
        return this.setDerivedWeb3Accounts(id, label);
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

  private setDerivedWeb3Accounts = async (id: number, label: string) => {
    try {
      // Only update wallet account if it doesn't exist or if it's the active account (which needs fresh balance data)

      const decryptedSeed = CryptoJS.AES.decrypt(
        this.sessionSeed,
        this.sessionPassword
      ).toString(CryptoJS.enc.Utf8);

      if (!decryptedSeed) {
        throw new Error(
          'Failed to decrypt session seed. Invalid password or corrupted data.'
        );
      }

      const seed = Buffer.from(decryptedSeed, 'hex');
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
    } catch (error) {
      console.log('ERROR setDerivedWeb3Accounts', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
    }
  };

  private getSignerUTXO = async (network: INetwork): Promise<{ rpc: any }> => {
    try {
      const { rpc } = await getSysRpc(network);

      return {
        rpc,
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
      // With multi-keyring architecture, this is only called on EVM keyrings
      this.ethereumTransaction.setWeb3Provider(network);
      abortController.abort();
    } catch (error) {
      abortController.abort();
      throw new Error(`SetSignerEVM: Failed with ${error}`);
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

  // With multi-keyring architecture, chain type checking is no longer needed
  // Each keyring is dedicated to a specific chain type

  private generateSalt = () => crypto.randomBytes(16).toString('hex');

  // With multi-keyring architecture, this method is no longer needed
  // Each keyring is dedicated to a specific slip44

  // ===================================== PRIVATE KEY ACCOUNTS METHODS - SIMPLE KEYRING ===================================== //

  private async restoreWallet(hdCreated: boolean, pwd: string) {
    if (!this.sessionMnemonic) {
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

      // Always store the main mnemonic
      this.sessionMainMnemonic = CryptoJS.AES.encrypt(
        hdWalletSeed,
        this.sessionPassword
      ).toString();

      this.sessionMnemonic = this.sessionMainMnemonic;

      const seed = (await mnemonicToSeed(hdWalletSeed)).toString('hex');
      this.sessionSeed = CryptoJS.AES.encrypt(
        seed,
        this.sessionPassword
      ).toString();
    }

    // No HD setup needed here - it's done lazily in setActiveAccount
    if (this.activeChain === INetworkType.Syscoin && !hdCreated) {
      // Just ensure the active account's HD signer exists
      await this.setActiveAccount(
        this.wallet.activeAccountId,
        this.wallet.activeAccountType
      );
    }
  }

  private guaranteeUpdatedPrivateValues(pwd: string) {
    try {
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
        this.sessionMainMnemonic,
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

      // Validate decryption results
      if (
        !decryptedSessionMnemonic ||
        !decryptSessionSeed ||
        !decryptedSessionMainMnemonic
      ) {
        throw new Error(
          'Failed to decrypt session data. Invalid password or corrupted data.'
        );
      }

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
            const decryptedXprv = CryptoJS.AES.decrypt(
              value.xprv,
              this.sessionPassword
            ).toString(CryptoJS.enc.Utf8);

            if (!decryptedXprv) {
              throw new Error(
                `Failed to decrypt private key for account ${key}. Invalid password or corrupted data.`
              );
            }

            accounts[key] = decryptedXprv;
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

            let encryptNewXprv = '';

            // With multi-keyring architecture, we know the type from activeChain
            if (this.activeChain === INetworkType.Ethereum) {
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

  private async _getPrivateKeyAccountInfos(privKey: string, label?: string) {
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
    const networkToUse = this.wallet.activeNetwork;
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
      // Check if the validation failed due to network mismatch
      if (
        zprvValidation.message &&
        zprvValidation.message.includes('Network mismatch')
      ) {
        throw new Error(zprvValidation.message);
      }

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

  // NEW: Helper methods for HD signer management
  private isZprv(key: string): boolean {
    const zprvPrefixes = ['zprv', 'tprv', 'vprv', 'xprv'];
    return zprvPrefixes.some((prefix) => key.startsWith(prefix));
  }

  private async createHDSignerFromMainSeed(
    accountId: number,
    rpc: any
  ): Promise<SyscoinHDSigner> {
    if (!this.sessionMainMnemonic) {
      throw new Error('Main mnemonic not available');
    }

    const mnemonic = CryptoJS.AES.decrypt(
      this.sessionMainMnemonic,
      this.sessionPassword
    ).toString(CryptoJS.enc.Utf8);

    if (!mnemonic) {
      throw new Error('Failed to decrypt mnemonic');
    }

    const { hd } = getSyscoinSigners({ mnemonic, rpc });

    // Create account directly at the requested index
    // createAccountAtIndex handles existing accounts internally
    // and automatically sets it as the active account
    await hd.createAccountAtIndex(accountId, 84);

    return hd;
  }

  private async createHDSignerFromZprv(
    zprv: string,
    rpc: any
  ): Promise<SyscoinHDSigner> {
    const { hd } = getSyscoinSigners({ mnemonic: zprv, rpc });

    // For imported zprv, we only ever use index 0
    // The HD signer constructor should create account 0 by default
    // No need to explicitly create it

    return hd;
  }
}

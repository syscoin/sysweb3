import ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory } from 'bip32';
import { generateMnemonic, validateMnemonic } from 'bip39';
import BIP84 from 'bip84';
import * as bjs from 'bitcoinjs-lib';
import bs58check from 'bs58check';
import crypto from 'crypto';
import CryptoJS from 'crypto-js';
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

/**
 * Secure Buffer implementation for sensitive data
 * Provides explicit memory clearing capability
 */
class SecureBuffer {
  private buffer: Buffer | null;
  private _isCleared = false;

  constructor(data: string | Buffer) {
    if (typeof data === 'string') {
      this.buffer = Buffer.from(data, 'utf8');
    } else {
      this.buffer = Buffer.from(data);
    }
  }

  get(): Buffer {
    if (this._isCleared || !this.buffer) {
      throw new Error('SecureBuffer has been cleared');
    }
    return Buffer.from(this.buffer); // Return copy
  }

  toString(): string {
    if (this._isCleared || !this.buffer) {
      throw new Error('SecureBuffer has been cleared');
    }
    return this.buffer.toString('utf8');
  }

  clear(): void {
    if (!this._isCleared && this.buffer) {
      // Overwrite with random data first
      crypto.randomFillSync(this.buffer);
      // Then fill with zeros
      this.buffer.fill(0);
      this.buffer = null;
      this._isCleared = true;
    }
  }

  isCleared(): boolean {
    return this._isCleared;
  }
}

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

  // Secure session data - using Buffers that can be explicitly cleared
  private sessionPassword: SecureBuffer | null = null;
  private sessionMnemonic: SecureBuffer | null = null; // can be a mnemonic or a zprv, can be changed to a zprv when using an imported wallet

  constructor(opts?: IkeyringManagerOpts | null) {
    this.storage = sysweb3.sysweb3Di.getStateStorageDb();
    // Don't initialize secure buffers in constructor - they're created on unlock
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
    // sessionMnemonic is initialized as null - created on unlock
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

    // Use the new secure initialization method (eliminates temporary plaintext storage)
    await keyringManager.initializeWalletSecurely(seed, password);

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
    // Set the network if provided (this is crucial for proper address derivation)
    if (network) {
      await this.setSignerNetwork(network);
    }

    // Use the new secure initialization method (eliminates temporary plaintext storage)
    const account = await this.initializeWalletSecurely(seed, password);

    // Set the created account as active (this is already done in initializeWalletSecurely, but ensure it's set correctly)
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

  public isUnlocked = () =>
    !!this.sessionPassword && !this.sessionPassword.isCleared();
  public lockWallet = () => {
    // Clear secure session data
    if (this.sessionPassword) {
      this.sessionPassword.clear();
      this.sessionPassword = null;
    }
    if (this.sessionMnemonic) {
      this.sessionMnemonic.clear();
      this.sessionMnemonic = null;
    }
    // Clear HD signers to remove decrypted keys from memory
    this.hd = null;
    this.hdMain = null;
    this.hdImportedByAccountId.clear();
    this.syscoinSigner = undefined;
  };

  // Direct secure transfer of session data to another keyring
  public transferSessionTo = (targetKeyring: IKeyringManager): void => {
    if (!this.isUnlocked()) {
      throw new Error('Source keyring must be unlocked to transfer session');
    }

    // Cast to access the receiveSessionOwnership method
    const targetKeyringImpl = targetKeyring as KeyringManager;

    // Transfer ownership of our buffers to the target
    if (!this.sessionPassword || !this.sessionMnemonic) {
      throw new Error('Session data is missing during transfer');
    }

    targetKeyringImpl.receiveSessionOwnership(
      this.sessionPassword,
      this.sessionMnemonic
    );

    // Null out our references (do NOT clear buffers - target owns them now)
    this.sessionPassword = null;
    this.sessionMnemonic = null;
  };

  // Private method for zero-copy transfer - takes ownership of buffers
  public receiveSessionOwnership = (
    sessionPassword: SecureBuffer,
    sessionMnemonic: SecureBuffer
  ): void => {
    // Clear any existing data first
    if (this.sessionPassword) {
      this.sessionPassword.clear();
    }
    if (this.sessionMnemonic) {
      this.sessionMnemonic.clear();
    }

    // Take ownership of the actual SecureBuffer objects
    // No copying - these are the original objects
    this.sessionPassword = sessionPassword;
    this.sessionMnemonic = sessionMnemonic;
  };

  public addNewAccount = async (
    label?: string
  ): Promise<IKeyringAccountState> => {
    // Check if wallet is unlocked
    if (!this.isUnlocked()) {
      throw new Error('Wallet must be unlocked to add new accounts');
    }

    // addNewAccount should only create accounts from the main seed
    // For importing accounts (including zprvs), use importAccount
    if (this.activeChain === INetworkType.Syscoin) {
      return await this.addNewAccountToSyscoinChain(label);
    } else {
      // EVM chainType
      return await this.addNewAccountToEth(label);
    }
  };

  public async unlock(password: string): Promise<{
    canLogin: boolean;
    wallet?: IWalletState | null;
  }> {
    try {
      const vaultKeys = await this.storage.get('vault-keys');

      if (!vaultKeys) {
        return {
          canLogin: false,
        };
      }

      // FIRST: Validate password against stored hash
      const { hash, salt } = vaultKeys;
      const saltedHashPassword = this.encryptSHA512(password, salt);

      if (saltedHashPassword !== hash) {
        // Password is wrong - return immediately
        return {
          canLogin: false,
        };
      }

      // If session data missing or corrupted, recreate from vault
      if (!this.sessionMnemonic) {
        await this.recreateSessionFromVault(password, saltedHashPassword);
      }

      // Initialize active account after unlock
      if (
        this.wallet.activeAccountId !== undefined &&
        this.wallet.activeAccountType
      ) {
        await this.setActiveAccount(
          this.wallet.activeAccountId,
          this.wallet.activeAccountType
        );
        console.log(
          `[KeyringManager] Active account ${this.wallet.activeAccountId} initialized after unlock`
        );
      }

      return {
        canLogin: true,
      };
    } catch (error) {
      console.log('ERROR unlock', {
        error,
      });
      return {
        canLogin: false,
      };
    }
  }

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
            this.getSessionPasswordString()
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

  public getPrivateKeyByAccountId = async (
    id: number,
    accountType: KeyringAccountType,
    pwd: string
  ): Promise<string> => {
    try {
      // Validate password using vault salt (same pattern as getSeed)
      if (!this.sessionPassword) {
        throw new Error('Unlock wallet first');
      }

      // Get vault salt for password validation
      const vaultKeys = await this.storage.get('vault-keys');
      if (!vaultKeys || !vaultKeys.salt) {
        throw new Error('Vault keys not found');
      }

      const genPwd = this.encryptSHA512(pwd, vaultKeys.salt);
      if (this.getSessionPasswordString() !== genPwd) {
        throw new Error('Invalid password');
      }

      const accounts = this.wallet.accounts[accountType];

      const account = Object.values(accounts).find(
        (account) => account.id === id
      );

      if (!account) {
        throw new Error('Account not found');
      }
      const decryptedPrivateKey = CryptoJS.AES.decrypt(
        account.xprv,
        this.getSessionPasswordString()
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

  public getEncryptedXprv = (hd?: SyscoinHDSigner) => {
    return CryptoJS.AES.encrypt(
      this.getSysActivePrivateKey(hd),
      this.getSessionPasswordString()
    ).toString();
  };

  public getSeed = async (pwd: string) => {
    if (!this.sessionPassword) {
      throw new Error('Unlock wallet first');
    }

    // Get vault salt for password validation (consistent with getPrivateKeyByAccountId)
    const vaultKeys = await this.storage.get('vault-keys');
    if (!vaultKeys || !vaultKeys.salt) {
      throw new Error('Vault keys not found');
    }

    const genPwd = this.encryptSHA512(pwd, vaultKeys.salt);
    if (this.getSessionPasswordString() !== genPwd) {
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

  public updateNetworkConfig = async (data: INetwork) => {
    if (
      data.kind !== INetworkType.Syscoin &&
      data.kind !== INetworkType.Ethereum
    ) {
      throw new Error('Invalid chain type');
    }

    // For UTXO networks, only allow updating the same network (e.g., changing RPC URL)
    if (data.kind === INetworkType.Syscoin) {
      if (data.chainId !== this.wallet.activeNetwork.chainId) {
        throw new Error(
          'Cannot change UTXO network. Each UTXO network has its own keyring instance.'
        );
      }
    }

    if (!this.wallet.networks[data.kind][data.chainId]) {
      throw new Error('Network does not exist');
    }
    if (
      this.wallet.activeNetwork.chainId === data.chainId &&
      this.activeChain === data.kind
    ) {
      if (
        data.kind === INetworkType.Syscoin &&
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
        [data.kind]: {
          ...this.wallet.networks[data.kind],
          [data.chainId]: data,
        },
      },
      // If this is the active network, update it as well
      activeNetwork:
        this.wallet.activeNetwork.chainId === data.chainId &&
        this.activeChain === data.kind
          ? data
          : this.wallet.activeNetwork,
    };
  };

  public addCustomNetwork = (network: INetwork) => {
    // Only EVM networks can be added dynamically
    if (network.kind !== INetworkType.Ethereum) {
      throw new Error(
        'Custom networks can only be added for EVM. UTXO networks require separate keyring instances.'
      );
    }

    const networkIdentifier = network.key ? network.key : network.chainId;

    this.wallet = {
      ...this.wallet,
      networks: {
        ...this.wallet.networks,
        [network.kind]: {
          ...this.wallet.networks[network.kind],
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
    network: INetwork
  ): Promise<{
    activeChain?: INetworkType;
    success: boolean;
    wallet?: IWalletState;
  }> => {
    // With multi-keyring architecture, each keyring is dedicated to specific slip44
    if (
      INetworkType.Ethereum !== network.kind &&
      INetworkType.Syscoin !== network.kind
    ) {
      throw new Error('Unsupported chain');
    }

    // Validate network/chain type compatibility
    if (
      network.kind === INetworkType.Ethereum &&
      this.activeChain === INetworkType.Syscoin
    ) {
      throw new Error('Cannot use Ethereum chain type with Syscoin network');
    }
    if (
      network.kind === INetworkType.Syscoin &&
      this.activeChain === INetworkType.Ethereum
    ) {
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

    const networkChain = network.kind;

    try {
      // With multi-keyring architecture:
      // - UTXO: Each keyring is dedicated to one network (slip44), so this is only called during initialization
      // - EVM: All EVM networks share slip44=60, so network can change within the same keyring

      if (network.kind === INetworkType.Syscoin) {
        // Ensure the active account exists before setting up signers
        const accountId = this.wallet.activeAccountId || 0;
        const accountType =
          this.wallet.activeAccountType || KeyringAccountType.HDAccount;
        const accounts = this.wallet.accounts[accountType];

        // Check if account doesn't exist OR exists but is empty (placeholder)
        if (!accounts[accountId] || !accounts[accountId].xpub) {
          if (accountType === KeyringAccountType.HDAccount) {
            await this.createUTXOAccountAtIndex(accountId);
          } else {
            throw new Error(
              `Active account ${accountType}:${accountId} does not exist and cannot be created automatically. Imported and hardware accounts must be explicitly added.`
            );
          }
        }
        // Set up signers for the active account
        if (!this.hd || !this.syscoinSigner) {
          await this.setActiveAccount(accountId, accountType);
          if (!this.hd) throw new Error('Error initialising HD');
        }
      } else if (network.kind === INetworkType.Ethereum) {
        // Ensure the active account exists before setting up signers
        const accountId = this.wallet.activeAccountId || 0;
        const accountType =
          this.wallet.activeAccountType || KeyringAccountType.HDAccount;
        const accounts = this.wallet.accounts[accountType];

        // Check if account doesn't exist OR exists but is empty (placeholder)
        if (!accounts[accountId] || !accounts[accountId].xpub) {
          if (accountType === KeyringAccountType.HDAccount) {
            await this.setDerivedWeb3Accounts(
              accountId,
              `Account ${accountId + 1}`
            );
          } else {
            throw new Error(
              `Active account ${accountType}:${accountId} does not exist and cannot be created automatically. Imported and hardware accounts must be explicitly added.`
            );
          }
        }

        // Set up EVM provider
        await this.setSignerEVM(network);
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
    const vaultKeys = await this.storage.get('vault-keys');
    if (!vaultKeys || !vaultKeys.salt) {
      throw new Error('Vault keys not found');
    }
    const genPwd = this.encryptSHA512(pwd, vaultKeys.salt);
    if (!this.sessionPassword) {
      throw new Error('Unlock wallet first');
    } else if (this.getSessionPasswordString() !== genPwd) {
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
    const currency = this.wallet.activeNetwork.currency;
    if (!currency) {
      throw new Error('Active network currency is not defined');
    }

    // Use getNextAccountId to filter out placeholder accounts
    const nextIndex = this.getNextAccountId(
      this.wallet.accounts[KeyringAccountType.Trezor]
    );

    const importedAccount = await this._createTrezorAccount(
      currency,
      this.wallet.activeNetwork.slip44,
      nextIndex
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
        const currency = this.wallet.activeNetwork.currency;
        if (!currency) {
          throw new Error('Active network currency is not defined');
        }

        const importedAccount = await this._createLedgerAccount(
          currency,
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
    this.lockWallet();
  };

  public async importAccount(privKey: string, label?: string) {
    // Check if wallet is unlocked
    if (!this.isUnlocked()) {
      throw new Error('Wallet must be unlocked to import accounts');
    }

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
      // Determine key type: zprv = mainnet key, vprv = testnet key
      const keyIsTestnet = prefix === 'vprv';

      // Determine target network type: testnet networks typically have chainId 5700+ or slip44 1
      const targetIsTestnet =
        networkToValidateAgainst.chainId >= 5700 ||
        networkToValidateAgainst.slip44 === 1;

      // Cross-network validation: reject if key type doesn't match target network
      if (keyIsTestnet && !targetIsTestnet) {
        throw new Error(
          `Extended private key is not compatible with ${networkToValidateAgainst.label}. ` +
            `This appears to be a testnet key (${prefix}) but the target network is mainnet.`
        );
      }

      if (!keyIsTestnet && targetIsTestnet) {
        throw new Error(
          `Extended private key is not compatible with ${networkToValidateAgainst.label}. ` +
            `This appears to be a mainnet key (${prefix}) but the target network is testnet.`
        );
      }

      const pubTypes = keyIsTestnet
        ? (types.zPubType as any).testnet
        : types.zPubType.mainnet;
      const baseNetwork = keyIsTestnet ? networks.testnet : networks.mainnet;

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
          this.getSessionPasswordString()
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
        'Wallet is not initialised yet call initializeWalletSecurely first'
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

  private getSysActivePrivateKey = (hd?: SyscoinHDSigner) => {
    const hdSigner = hd || this.hd;
    if (hdSigner === null) throw new Error('No HD Signer');

    const accountIndex = hdSigner.Signer.accountIndex;

    // Verify the account exists now
    if (!hdSigner.Signer.accounts.has(accountIndex)) {
      throw new Error(`Account at index ${accountIndex} could not be created`);
    }

    return hdSigner.Signer.accounts.get(accountIndex).getAccountPrivateKey();
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

    // Use getNextAccountId to properly handle placeholder accounts
    const id = this.getNextAccountId(accounts[KeyringAccountType.Trezor]);

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
    hd,
  }: {
    id: number;
    xpub: string;
    hd: SyscoinHDSigner;
  }): ISysAccount => {
    // Get address from existing account if it exists, otherwise derive it
    let address: string;
    const existingAccount =
      this.wallet.accounts[this.wallet.activeAccountType][id];
    if (existingAccount && existingAccount.address) {
      address = existingAccount.address;
    } else {
      // For new accounts, we need to derive the address
      if (!hd.Signer.accounts.has(id)) {
        throw new Error('Account not found');
      }

      address = hd.Signer.accounts.get(id).getAddress(0, false, 84);
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

  // Common helper method for UTXO account creation
  private async createUTXOAccountAtIndex(accountId: number, label?: string) {
    try {
      const { rpc } = await this.getSignerUTXO(this.wallet.activeNetwork);

      if (!this.hdMain) {
        this.hdMain = await this.createHDSignerFromMainSeed(accountId, rpc);
      } else {
        await this.hdMain.createAccountAtIndex(accountId, 84);
      }

      const xpub = this.hdMain.getAccountXpub();
      const sysAccount = this.getFormattedBackendAccount({
        xpub,
        id: accountId,
        hd: this.hdMain,
      });

      const encryptedXprv = this.getEncryptedXprv(this.hdMain);

      const accountData = this.getInitialAccountData({
        label: label || `Account ${accountId + 1}`,
        signer: this.hdMain,
        sysAccount,
        xprv: encryptedXprv,
      });

      // Store the new account
      this.wallet.accounts[KeyringAccountType.HDAccount][accountId] =
        accountData;

      return accountData;
    } catch (error) {
      console.log('ERROR createUTXOAccountAtIndex', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
      throw error;
    }
  }

  private async addNewAccountToSyscoinChain(label?: string) {
    try {
      // Get next available account ID
      const accounts = this.wallet.accounts[KeyringAccountType.HDAccount];
      const nextId = this.getNextAccountId(accounts);

      return await this.createUTXOAccountAtIndex(nextId, label);
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
    const existingIds = Object.values(accounts)
      .filter((account: any) => {
        // Only count accounts that have been properly initialized
        // Placeholder accounts from initialWalletState have empty addresses/xprv/xpub
        return account && account.address && account.xpub;
      })
      .map((account: any) => account.id)
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

  private setDerivedWeb3Accounts = async (id: number, label: string) => {
    try {
      // Decrypt the mnemonic directly instead of using seed
      const decryptedMnemonic = CryptoJS.AES.decrypt(
        this.getSessionMnemonicString(),
        this.getSessionPasswordString()
      ).toString(CryptoJS.enc.Utf8);

      if (!decryptedMnemonic) {
        throw new Error(
          'Failed to decrypt mnemonic. Invalid password or corrupted data.'
        );
      }

      // Use ethers.js HD derivation directly from mnemonic
      const hdNode = ethers.utils.HDNode.fromMnemonic(decryptedMnemonic);

      // Use dynamic path generation for ETH addresses
      const ethDerivationPath = getAddressDerivationPath(
        'eth',
        60,
        0,
        false,
        id
      );

      const derivedAccount = hdNode.derivePath(ethDerivationPath);

      const address = derivedAccount.address;
      const xprv = derivedAccount.privateKey;
      const xpub = derivedAccount.publicKey;

      const basicAccountInfo = this.getBasicWeb3AccountInfo(id, label);

      const createdAccount = {
        address,
        xpub,
        xprv: CryptoJS.AES.encrypt(
          xprv,
          this.getSessionPasswordString()
        ).toString(),
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
    this.wallet = JSON.parse(JSON.stringify(initialWalletState));

    await setEncryptedVault(
      {
        mnemonic: '',
      },
      pwd
    );

    this.logout();
  };

  private async recreateSessionFromVault(
    password: string,
    saltedHashPassword: string
  ): Promise<void> {
    try {
      const { mnemonic } = await getDecryptedVault(password);

      if (!mnemonic) {
        throw new Error('Mnemonic not found in vault');
      }

      // Encrypt session data with sessionPassword hash for consistency
      // This allows createKeyringVaultFromSession to decrypt with this.sessionPassword
      this.sessionPassword = new SecureBuffer(saltedHashPassword);
      // Encrypt the mnemonic with session password for consistency with the rest of the code
      const encryptedMnemonic = CryptoJS.AES.encrypt(
        mnemonic,
        saltedHashPassword
      ).toString();
      this.sessionMnemonic = new SecureBuffer(encryptedMnemonic);
      console.log('[KeyringManager] Session data recreated from vault');
    } catch (error) {
      console.error('ERROR recreateSessionFromVault', { error });
      throw error;
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

    const id = this.getNextAccountId(accounts[KeyringAccountType.Imported]);

    return {
      ...initialActiveImportedAccountState,
      address,
      label: label ? label : `Imported ${id + 1}`,
      id,
      balances,
      isImported: true,
      xprv: CryptoJS.AES.encrypt(
        privateKey,
        this.getSessionPasswordString()
      ).toString(),
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
    if (!this.sessionMnemonic) {
      throw new Error('Main mnemonic not available');
    }

    const mnemonic = CryptoJS.AES.decrypt(
      this.getSessionMnemonicString(),
      this.getSessionPasswordString()
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

  // NEW: Secure initialization method that eliminates temporary plaintext storage
  public initializeWalletSecurely = async (
    seedPhrase: string,
    password: string
  ): Promise<IKeyringAccountState> => {
    // Validate inputs first
    if (!validateMnemonic(seedPhrase)) {
      throw new Error('Invalid Seed');
    }
    let foundVaultKeys = true;
    let salt = '';
    const vaultKeys = await this.storage.get('vault-keys');
    if (!vaultKeys || !vaultKeys.salt) {
      foundVaultKeys = false;
      salt = crypto.randomBytes(16).toString('hex');
    } else {
      salt = vaultKeys.salt;
    }
    const sessionPasswordSaltedHash = this.encryptSHA512(password, salt);
    if (!foundVaultKeys) {
      // Store vault-keys using the storage abstraction
      await this.storage.set('vault-keys', {
        hash: sessionPasswordSaltedHash,
        salt,
      });
    }

    // Check if already initialized with the same password (idempotent behavior)
    if (this.sessionPassword) {
      if (sessionPasswordSaltedHash === this.getSessionPasswordString()) {
        // Same password - check if it's the same mnemonic to ensure full idempotency
        try {
          const currentMnemonic = CryptoJS.AES.decrypt(
            this.getSessionMnemonicString(),
            this.getSessionPasswordString()
          ).toString(CryptoJS.enc.Utf8);

          if (currentMnemonic === seedPhrase) {
            // Same mnemonic and password - idempotent call, return existing account
            return await this.createKeyringVaultFromSession();
          }
        } catch (error) {
          // If we can't decrypt, fall through to error
        }
      }

      // Different password or mnemonic - this is not a simple re-initialization
      throw new Error(
        'Wallet already initialized with different parameters. Create a new keyring instance for different parameters.'
      );
    }

    // Encrypt and store vault (mnemonic storage) - now uses single vault for all networks
    await setEncryptedVault(
      {
        mnemonic: seedPhrase, // Store plain mnemonic - setEncryptedVault will encrypt the entire vault
      },
      password
    );

    await this.recreateSessionFromVault(password, sessionPasswordSaltedHash);
    // Create the keyring vault directly with the encrypted session mnemonic
    return await this.createKeyringVaultFromSession();
  };

  // Simplified createKeyringVault using existing proven methods
  public createKeyringVaultFromSession =
    async (): Promise<IKeyringAccountState> => {
      try {
        if (!this.sessionPassword || !this.sessionMnemonic) {
          throw new Error('Wallet must be initialized first');
        }

        // Let setSignerNetwork handle everything - account creation and signer setup
        const result = await this.setSignerNetwork(this.wallet.activeNetwork);
        if (!result.success) {
          throw new Error('Failed to set up signer network');
        }

        // Get active account info
        const activeAccountId = this.wallet.activeAccountId || 0;
        const activeAccountType =
          this.wallet.activeAccountType || KeyringAccountType.HDAccount;
        return this.wallet.accounts[activeAccountType][activeAccountId];
      } catch (error) {
        console.log('ERROR createKeyringVaultFromSession', {
          error,
        });
        this.validateAndHandleErrorByMessage(error.message);
        throw error;
      }
    };

  // Helper methods for secure buffer operations
  private getSessionPasswordString(): string {
    if (!this.sessionPassword || this.sessionPassword.isCleared()) {
      throw new Error('Session password not available');
    }
    return this.sessionPassword.toString();
  }

  private getSessionMnemonicString(): string {
    if (!this.sessionMnemonic || this.sessionMnemonic.isCleared()) {
      throw new Error('Session mnemonic not available');
    }
    return this.sessionMnemonic.toString();
  }
}

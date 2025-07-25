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
} from './initial-state';
import { LedgerKeyring } from './ledger';
import { getSyscoinSigners, SyscoinHDSigner } from './signers';
import { getDecryptedVault, setEncryptedVault } from './storage';
import { EthereumTransactions, SyscoinTransactions } from './transactions';
import { TrezorKeyring } from './trezor';
import {
  IKeyringAccountState,
  ISyscoinTransactions,
  KeyringAccountType,
  IEthereumTransactions,
  IKeyringManager,
} from './types';
import { getAddressDerivationPath, isEvmCoin } from './utils/derivation-paths';
import * as sysweb3 from '@pollum-io/sysweb3-core';
import {
  INetwork,
  INetworkType,
  getNetworkConfig,
} from '@pollum-io/sysweb3-network';

export interface ISysAccount {
  address: string;
  label?: string;
  xprv?: string;
  xpub: string;
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
  // NOTE: activeChain removed - now derived from vault.activeNetwork.kind
  public initialTrezorAccountState: IKeyringAccountState;
  public initialLedgerAccountState: IKeyringAccountState;
  public utf8Error: boolean;
  //transactions objects
  public ethereumTransaction: IEthereumTransactions;
  public syscoinTransaction: ISyscoinTransactions;
  private storage: any; // Should be IKeyValueDb but import issue - provides deleteItem(), get(), set(), setClient(), setPrefix()

  // Store getter function for accessing Redux state
  private getVaultState: (() => any) | null = null;

  // Method to inject store getter from Pali side
  public setVaultStateGetter = (getter: () => any) => {
    this.getVaultState = getter;
  };

  // Helper method to get current vault state
  private getVault = () => {
    if (!this.getVaultState) {
      throw new Error(
        'Vault state getter not configured. Call setVaultStateGetter() first.'
      );
    }

    const vault = this.getVaultState();

    // DEFENSIVE CHECK: Ensure vault state is properly structured
    if (!vault) {
      throw new Error(
        'Vault state is undefined. Ensure Redux store is properly initialized with vault state.'
      );
    }

    if (!vault.activeNetwork) {
      throw new Error(
        'Vault state is missing activeNetwork. Ensure vault state is properly initialized before keyring operations.'
      );
    }

    if (!vault.activeAccount) {
      throw new Error(
        'Vault state is missing activeAccount. Ensure vault state is properly initialized before keyring operations.'
      );
    }

    return vault;
  };

  // Helper to get active chain from vault state (replaces this.activeChain)
  private getActiveChain = (): INetworkType => {
    return this.getVault().activeNetwork.kind;
  };

  // Secure session data - using Buffers that can be explicitly cleared
  private sessionPassword: SecureBuffer | null = null;
  private sessionMnemonic: SecureBuffer | null = null; // can be a mnemonic or a zprv, can be changed to a zprv when using an imported wallet

  constructor() {
    this.storage = sysweb3.sysweb3Di.getStateStorageDb();
    // Don't initialize secure buffers in constructor - they're created on unlock
    this.storage.set('utf8Error', {
      hasUtf8Error: false,
    });

    // NOTE: activeChain is now derived from vault state, not stored locally
    // NOTE: No more persistent signers - use getSigner() for fresh on-demand signers

    this.utf8Error = false;
    // sessionMnemonic is initialized as null - created on unlock
    this.initialTrezorAccountState = initialActiveTrezorAccountState;
    this.initialLedgerAccountState = initialActiveLedgerAccountState;
    this.trezorSigner = new TrezorKeyring(this.getSigner);
    this.ledgerSigner = new LedgerKeyring();

    // this.syscoinTransaction = SyscoinTransactions();
    this.syscoinTransaction = new SyscoinTransactions(
      this.getSigner,
      this.getReadOnlySigner,
      this.getAccountsState,
      this.getAddress,
      this.ledgerSigner,
      this.trezorSigner
    );
    this.ethereumTransaction = new EthereumTransactions(
      this.getNetwork,
      this.getDecryptedPrivateKey,
      this.getAccountsState,
      this.ledgerSigner,
      this.trezorSigner
    );
  }

  // Static factory method for creating a fully initialized KeyringManager with slip44 support
  public static async createInitialized(
    seed: string,
    password: string,
    vaultStateGetter: () => any
  ): Promise<KeyringManager> {
    const keyringManager = new KeyringManager();

    // Set the vault state getter
    keyringManager.setVaultStateGetter(vaultStateGetter);

    // Use the new secure initialization method (eliminates temporary plaintext storage)
    await keyringManager.initializeWalletSecurely(seed, password);

    // NOTE: Active account management is now handled by vault state/Redux
    // No need to explicitly set active account - it's managed externally

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

    // NOTE: Active account management is now handled by vault state/Redux
    // No need to explicitly set active account - it's managed externally

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

    // Clean up hardware wallet connections
    if (this.ledgerSigner) {
      this.ledgerSigner.destroy().catch((error) => {
        console.error('Error destroying Ledger connection:', error);
      });
    }
    if (this.trezorSigner) {
      this.trezorSigner.destroy().catch((error) => {
        console.error('Error destroying Trezor connection:', error);
      });
    }
  };

  // Direct secure transfer of session data to another keyring
  public transferSessionTo = (targetKeyring: IKeyringManager): void => {
    if (!this.isUnlocked()) {
      throw new Error('Source keyring must be unlocked to transfer session');
    }

    // Cast to access the receiveSessionOwnership method
    const targetKeyringImpl = targetKeyring as unknown as KeyringManager;

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
    if (this.getActiveChain() === INetworkType.Syscoin) {
      return await this.addNewAccountToSyscoinChain(label);
    } else {
      // EVM chainType
      return await this.addNewAccountToEth(label);
    }
  };

  public async unlock(password: string): Promise<{
    canLogin: boolean;
    needsAccountCreation?: boolean;
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
      // Handle migration from old vault format with currentSessionSalt
      if (vaultKeys.currentSessionSalt) {
        console.log(
          '[KeyringManager] Detected old vault format, handling session migration...'
        );

        // The old format used currentSessionSalt for session data encryption
        // We need to use it temporarily to decrypt the mnemonic correctly
        const oldSessionPassword = this.encryptSHA512(
          password,
          vaultKeys.currentSessionSalt
        );

        // Get the vault and check if mnemonic needs migration
        const { mnemonic } = await getDecryptedVault(password);

        if (mnemonic) {
          // Check if mnemonic is double-encrypted (old format behavior)
          const isLikelyPlainMnemonic =
            mnemonic.includes(' ') &&
            (mnemonic.split(' ').length === 12 ||
              mnemonic.split(' ').length === 24);

          let decryptedMnemonic = mnemonic;
          if (!isLikelyPlainMnemonic) {
            try {
              // Try to decrypt with raw password first (as vault stores it)
              decryptedMnemonic = CryptoJS.AES.decrypt(
                mnemonic,
                password
              ).toString(CryptoJS.enc.Utf8);
            } catch (e) {
              console.warn(
                '[KeyringManager] Failed to decrypt mnemonic with password, trying old session password'
              );
              // If that fails, try with old session password
              try {
                decryptedMnemonic = CryptoJS.AES.decrypt(
                  mnemonic,
                  oldSessionPassword
                ).toString(CryptoJS.enc.Utf8);
              } catch (e2) {
                // If both fail, assume it's already decrypted
                decryptedMnemonic = mnemonic;
              }
            }
          }

          // Re-save the vault with properly formatted mnemonic (single encryption)
          await setEncryptedVault({ mnemonic: decryptedMnemonic }, password);
          console.log('[KeyringManager] Vault mnemonic format normalized');
        }

        // Remove currentSessionSalt from vault-keys
        const migratedVaultKeys = {
          hash: vaultKeys.hash,
          salt: vaultKeys.salt,
        };
        await this.storage.set('vault-keys', migratedVaultKeys);
        console.log('[KeyringManager] Old vault format migration completed');
      }

      // If session data missing or corrupted, recreate from vault
      if (!this.sessionMnemonic) {
        await this.recreateSessionFromVault(password, saltedHashPassword);
      }

      // NOTE: Active account management is now handled by vault state/Redux
      // No need to explicitly set active account after unlock - it's managed externally
      const vault = this.getVault();
      if (vault.activeAccount?.id !== undefined && vault.activeAccount?.type) {
        // Check if the active account actually exists in the accounts map
        const accountType = vault.activeAccount.type;
        const accountId = vault.activeAccount.id;
        const accountExists = vault.accounts?.[accountType]?.[accountId];

        if (!accountExists) {
          console.log(
            `[KeyringManager] Active account ${accountType}:${accountId} not found in accounts map. This may indicate a migration from old vault format.`
          );
          // Signal that accounts need to be created after migration
          return {
            canLogin: true,
            needsAccountCreation: true,
          };
        }

        console.log(
          `[KeyringManager] Active account ${vault.activeAccount.id} available after unlock`
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
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const account = accounts[activeAccount.type]?.[activeAccount.id];
    if (!account) {
      throw new Error('Active account not found');
    }
    const { xpub } = account;
    return await this.getAddress(xpub, true); // Don't skip increment - get next unused
  };

  public getChangeAddress = async (id: number): Promise<string> => {
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const account = accounts[activeAccount.type]?.[id];
    if (!account) {
      throw new Error(`Account with id ${id} not found`);
    }
    const { xpub } = account;

    return await this.getAddress(xpub, true);
  };

  public getPubkey = async (
    id: number,
    isChangeAddress: boolean
  ): Promise<string> => {
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const account = accounts[activeAccount.type]?.[id];
    if (!account) {
      throw new Error(`Account with id ${id} not found`);
    }
    const { xpub } = account;

    return await this.getCurrentAddressPubkey(xpub, isChangeAddress);
  };

  public getBip32Path = async (
    id: number,
    isChangeAddress: boolean
  ): Promise<string> => {
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const account = accounts[activeAccount.type]?.[id];
    if (!account) {
      throw new Error(`Account with id ${id} not found`);
    }
    const { xpub } = account;

    return await this.getCurrentAddressBip32Path(xpub, isChangeAddress);
  };

  public updateReceivingAddress = async (): Promise<string> => {
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const account = accounts[activeAccount.type]?.[activeAccount.id];
    if (!account) {
      throw new Error('Active account not found');
    }
    const { xpub } = account;

    const address = await this.getAddress(xpub, false);
    // NOTE: Address updates should be dispatched to Redux store, not updated here
    // The calling code should handle the Redux dispatch
    return address;
  };

  public getAccountById = (
    id: number,
    accountType: KeyringAccountType
  ): Omit<IKeyringAccountState, 'xprv'> => {
    const vault = this.getVault();
    const accounts = vault.accounts[accountType];

    const account = accounts[id];

    if (!account) {
      throw new Error('Account not found');
    }

    return omit(account as IKeyringAccountState, 'xprv');
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

      const vault = this.getVault();
      const account = vault.accounts[accountType][id];
      if (!account) {
        throw new Error('Account not found');
      }

      // Decrypt the stored private key (works for both HD and imported accounts)
      const decryptedPrivateKey = CryptoJS.AES.decrypt(
        (account as IKeyringAccountState).xprv,
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
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const activeAccountId = activeAccount.id;
    const activeAccountType = activeAccount.type;

    return {
      activeAccount: omit(
        accounts[activeAccountType][activeAccountId] as IKeyringAccountState,
        'xprv'
      ),
      activeAccountType,
    };
  };

  public getEncryptedXprv = (hd: SyscoinHDSigner) => {
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

  public setSignerNetwork = async (
    network: INetwork
  ): Promise<{
    activeChain?: INetworkType;
    success: boolean;
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
      this.getActiveChain() === INetworkType.Syscoin
    ) {
      throw new Error('Cannot use Ethereum chain type with Syscoin network');
    }
    if (
      network.kind === INetworkType.Syscoin &&
      this.getActiveChain() === INetworkType.Ethereum
    ) {
      throw new Error('Cannot use Syscoin chain type with Ethereum network');
    }

    // CRITICAL: Prevent UTXO-to-UTXO network switching within same keyring
    // Each UTXO network should have its own KeyringManager instance based on slip44
    const vault = this.getVault();
    if (this.getActiveChain() === INetworkType.Syscoin && vault.activeNetwork) {
      const currentSlip44 = vault.activeNetwork.slip44;
      const newSlip44 = network.slip44;

      if (currentSlip44 !== newSlip44) {
        throw new Error(
          `Cannot switch between different UTXO networks within the same keyring. ` +
            `Current network uses slip44=${currentSlip44}, target network uses slip44=${newSlip44}. ` +
            `Each UTXO network requires a separate KeyringManager instance.`
        );
      }
    }

    try {
      // With multi-keyring architecture:
      // - UTXO: Each keyring is dedicated to one network (slip44), so this is only called during initialization
      // - EVM: All EVM networks share slip44=60, so network can change within the same keyring

      if (network.kind === INetworkType.Syscoin) {
        // For UTXO networks: validate that active account exists (accounts should be created via addNewAccount/initialize)
        const accountId = vault.activeAccount.id || 0;
        const accountType =
          vault.activeAccount.type || KeyringAccountType.HDAccount;
        const accounts = vault.accounts[accountType];

        if (!accounts[accountId] || !accounts[accountId].xpub) {
          throw new Error(
            `Active account ${accountType}:${accountId} does not exist. Create accounts using addNewAccount() or initializeWalletSecurely() first.`
          );
        }

        // No additional setup needed - on-demand signers will be created when needed
      } else if (network.kind === INetworkType.Ethereum) {
        // For EVM networks: validate that active account exists
        const accountId = vault.activeAccount.id || 0;
        const accountType =
          vault.activeAccount.type || KeyringAccountType.HDAccount;
        const accounts = vault.accounts[accountType];

        if (!accounts[accountId] || !accounts[accountId].xpub) {
          throw new Error(
            `Active account ${accountType}:${accountId} does not exist. Create accounts using addNewAccount() or initializeWalletSecurely() first.`
          );
        }

        // Set up EVM provider for network switching
        await this.setSignerEVM(network);
      }

      return {
        success: true,
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
    const vault = this.getVault();
    const { activeAccount } = vault;
    const account = vault.accounts[activeAccount.type]?.[activeAccount.id];
    if (!account) {
      throw new Error('Active account not found');
    }
    return account.xpub;
  };

  public isSeedValid = (seedPhrase: string) => validateMnemonic(seedPhrase);

  public createNewSeed = () => generateMnemonic();

  public getUTXOState = () => {
    const vault = this.getVault();
    if (vault.activeNetwork.kind !== INetworkType.Syscoin) {
      throw new Error('Cannot get state in a ethereum network');
    }

    const utxOAccounts = mapValues(vault.accounts.HDAccount, (value) =>
      omit(value, 'xprv')
    );

    return {
      ...vault,
      accounts: {
        [KeyringAccountType.HDAccount]: utxOAccounts,
        [KeyringAccountType.Imported]: {},
        [KeyringAccountType.Trezor]: {},
        [KeyringAccountType.Ledger]: {},
      },
    };
  };

  public async importTrezorAccount(label?: string) {
    const vault = this.getVault();
    const currency = vault.activeNetwork.currency;
    if (!currency) {
      throw new Error('Active network currency is not defined');
    }

    // Use getNextAccountId to filter out placeholder accounts
    const nextIndex = this.getNextAccountId(
      vault.accounts[KeyringAccountType.Trezor]
    );

    const importedAccount = await this._createTrezorAccount(
      currency,
      vault.activeNetwork.slip44,
      nextIndex
    );
    importedAccount.label = label ? label : `Trezor ${importedAccount.id + 1}`;

    // NOTE: Account creation should be dispatched to Redux store, not updated here
    // The calling code should handle the Redux dispatch
    // Return the created account for Pali to add to store
    return importedAccount;
  }

  public async importLedgerAccount(label?: string) {
    try {
      const vault = this.getVault();
      const currency = vault.activeNetwork.currency;
      if (!currency) {
        throw new Error('Active network currency is not defined');
      }

      // Use getNextAccountId to filter out placeholder accounts
      const nextIndex = this.getNextAccountId(
        vault.accounts[KeyringAccountType.Ledger]
      );

      const importedAccount = await this._createLedgerAccount(
        currency,
        vault.activeNetwork.slip44,
        nextIndex
      );
      importedAccount.label = label
        ? label
        : `Ledger ${importedAccount.id + 1}`;

      // NOTE: Account creation should be dispatched to Redux store, not updated here
      // The calling code should handle the Redux dispatch
      // Return the created account for Pali to add to store
      return importedAccount;
    } catch (error) {
      console.log({ error });
      throw error;
    }
  }

  public getActiveUTXOAccountState = () => {
    const vault = this.getVault();
    const { activeAccount } = vault;
    return {
      ...vault.accounts.HDAccount[activeAccount.id],
      xprv: undefined,
    };
  };

  public getNetwork = () => this.getVault().activeNetwork;

  public createEthAccount = (privateKey: string) =>
    new ethers.Wallet(privateKey);

  // Helper to get current account data from backend
  private fetchCurrentAccountData = async (
    xpub: string,
    isChangeAddress: boolean
  ) => {
    const vault = this.getVault();
    const { activeNetwork } = vault;

    // Use read-only signer for backend calls - works for all account types including hardware wallets
    const { main } = this.getReadOnlySigner();
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

    // Get network configuration for BIP84
    const networkConfig = getNetworkConfig(
      activeNetwork.slip44,
      activeNetwork.currency
    );

    // BIP84 needs pubTypes and networks config
    // For read-only operations, we construct these from networkConfig
    const pubTypes = networkConfig?.types?.zPubType || {
      mainnet: { zprv: 0x04b2430c, zpub: 0x04b24746 },
      testnet: { vprv: 0x045f18bc, vpub: 0x045f1cf6 },
    };
    const networks = networkConfig?.networks || {
      mainnet: {},
      testnet: {},
    };

    const currentAccount = new BIP84.fromZPub(xpub, pubTypes, networks);

    const addressIndex = isChangeAddress ? changeIndex : receivingIndex;

    return {
      currentAccount,
      addressIndex,
      main,
    };
  };

  public getAddress = async (xpub: string, isChangeAddress: boolean) => {
    const { currentAccount, addressIndex } = await this.fetchCurrentAccountData(
      xpub,
      isChangeAddress
    );

    const address = currentAccount.getAddress(
      addressIndex,
      isChangeAddress,
      84
    ) as string;

    return address;
  };

  public getCurrentAddressPubkey = async (
    xpub: string,
    isChangeAddress: boolean
  ): Promise<string> => {
    const { currentAccount, addressIndex } = await this.fetchCurrentAccountData(
      xpub,
      isChangeAddress
    );

    // BIP84 returns the public key as a hex string directly
    return currentAccount.getPublicKey(addressIndex, isChangeAddress);
  };

  public getCurrentAddressBip32Path = async (
    xpub: string,
    isChangeAddress: boolean
  ): Promise<string> => {
    const vault = this.getVault();
    const { activeAccount, activeNetwork } = vault;

    const { addressIndex } = await this.fetchCurrentAccountData(
      xpub,
      isChangeAddress
    );

    // Use the utility function to generate the proper derivation path
    const coinShortcut = activeNetwork.currency.toLowerCase(); // e.g., 'sys', 'btc'
    const path = getAddressDerivationPath(
      coinShortcut,
      activeNetwork.slip44,
      activeAccount.id,
      isChangeAddress,
      addressIndex
    );

    return path;
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

    // NOTE: Account creation should be dispatched to Redux store, not updated here
    // The calling code should handle the Redux dispatch
    // Return the created account for Pali to add to store
    return importedAccount;
  }

  public validateZprv(zprv: string, targetNetwork?: INetwork) {
    // Use the active network if targetNetwork is not provided
    const networkToValidateAgainst =
      targetNetwork || this.getVault().activeNetwork;

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
      const vault = this.getVault();
      const { accounts, activeAccount } = vault;
      const activeAccountId = activeAccount.id;
      const activeAccountType = activeAccount.type;
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
      if (this.getActiveChain() === INetworkType.Ethereum) {
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
      const vaultForLogging = this.getVault();
      console.error('ERROR getDecryptedPrivateKey', {
        error: error.message,
        activeChain: this.getActiveChain(),
        vault: {
          activeAccountId: vaultForLogging?.activeAccount?.id,
          activeAccountType: vaultForLogging?.activeAccount?.type,
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
    if (this.getActiveChain() !== INetworkType.Syscoin) {
      throw new Error('Switch to UTXO chain');
    }

    // Create fresh on-demand signer for active account (now synchronous!)
    const freshHDSigner = this.createOnDemandSignerForActiveAccount();

    // Create fresh syscoinjs instance with current network
    const vault = this.getVault();
    const network = vault.activeNetwork;
    const networkConfig = getNetworkConfig(network.slip44, network.currency);

    const syscoinMainSigner = new syscoinjs.SyscoinJSLib(
      freshHDSigner,
      network.url,
      networkConfig?.networks?.mainnet || undefined
    );

    return {
      hd: freshHDSigner,
      main: syscoinMainSigner,
    };
  };

  // Read-only version that works when wallet is locked
  private getReadOnlySigner = (): {
    main: any; //TODO: Type this following syscoinJSLib interface
  } => {
    if (this.getActiveChain() !== INetworkType.Syscoin) {
      throw new Error('Switch to UTXO chain');
    }

    // Create syscoinjs instance without HD signer for read-only operations
    const vault = this.getVault();
    const network = vault.activeNetwork;
    const networkConfig = getNetworkConfig(network.slip44, network.currency);

    const syscoinMainSigner = new syscoinjs.SyscoinJSLib(
      null, // No HD signer needed for read-only operations
      network.url,
      networkConfig?.networks?.mainnet || undefined
    );

    return {
      main: syscoinMainSigner,
    };
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
    const vault = this.getVault();
    const { accounts, activeAccount, activeNetwork } = vault;
    return {
      activeAccountId: activeAccount.id,
      accounts,
      activeAccountType: activeAccount.type,
      activeNetwork,
    };
  };

  /**
   *
   * @param password
   * @param salt
   * @returns hash: string
   */
  private encryptSHA512 = (password: string, salt: string) =>
    crypto.createHmac('sha512', salt).update(password).digest('hex');

  private getSysActivePrivateKey = (hd: SyscoinHDSigner) => {
    if (hd === null) throw new Error('No HD Signer');

    const accountIndex = hd.Signer.accountIndex;

    // Verify the account exists now
    if (!hd.Signer.accounts.has(accountIndex)) {
      throw new Error(`Account at index ${accountIndex} could not be created`);
    }

    return hd.Signer.accounts.get(accountIndex).getAccountPrivateKey();
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
    const { address, xpub } = sysAccount;

    return {
      id: signer.Signer.accountIndex,
      label: label || `Account ${signer.Signer.accountIndex + 1}`,
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
    const vault = this.getVault();
    const { accounts } = vault;
    let xpub, balance;

    // For EVM networks, Trezor expects 'eth' regardless of the network's currency
    const trezorCoin = slip44 === 60 ? 'eth' : coin;

    try {
      const { descriptor, balance: _balance } =
        await this.trezorSigner.getAccountInfo({
          coin: trezorCoin,
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

    // For EVM networks, we need to get the actual address from Trezor
    let address: string;
    if (isEVM) {
      // For EVM, the descriptor from getAccountInfo is the address
      address = xpub;

      // Get the public key for EVM
      const response = await this.trezorSigner.getPublicKey({
        coin: trezorCoin,
        slip44,
        index: +index,
      });
      ethPubKey = response.publicKey;
    } else {
      // For UTXO, use the xpub to derive the address
      address = await this.getAddress(xpub, false);
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

    // Use getNextAccountId to properly handle placeholder accounts
    const id = this.getNextAccountId(accounts[KeyringAccountType.Trezor]);

    const trezorAccount = {
      ...this.initialTrezorAccountState,
      balances: {
        syscoin: isEVM ? 0 : +balance / 1e8,
        ethereum: 0,
      },
      address,
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
    const vault = this.getVault();
    const { accounts } = vault;
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
        });
        xpub = ledgerXpub;
        // Use the generic getAddress method like Trezor does - no need to query device again
        address = await this.getAddress(xpub, false);
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

    // Use getNextAccountId to properly handle placeholder accounts
    const id = this.getNextAccountId(accounts[KeyringAccountType.Ledger]);

    const currentBalances = { syscoin: 0, ethereum: 0 };

    const ledgerAccount = {
      ...this.initialLedgerAccountState,
      balances: currentBalances,
      address,
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
    signer,
  }: {
    signer: SyscoinHDSigner;
  }): Promise<ISysAccount> => {
    // MUCH SIMPLER: Just use the signer directly - no BIP84 needed!
    // Get address directly from the signer (always correct for current network)
    const address = signer.createAddress(0, false, 84) as string;
    const xpub = signer.getAccountXpub();

    return {
      address,
      xpub,
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
      // Create fresh signer just for this account creation operation
      const freshHDSigner = this.createOnDemandUTXOSigner(accountId);

      const sysAccount = await this.getFormattedBackendAccount({
        signer: freshHDSigner,
      });

      const encryptedXprv = this.getEncryptedXprv(freshHDSigner);

      // Generate network-aware label if none provided
      const vault = this.getVault();
      const network = vault.activeNetwork;
      const defaultLabel = this.generateNetworkAwareLabel(accountId, network);

      return {
        ...this.getInitialAccountData({
          label: label || defaultLabel,
          signer: freshHDSigner,
          sysAccount,
          xprv: encryptedXprv,
        }),
        balances: { syscoin: 0, ethereum: 0 },
      } as IKeyringAccountState;
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
      const vault = this.getVault();
      const accounts = vault.accounts[KeyringAccountType.HDAccount];
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
      const vault = this.getVault();
      const accounts = vault.accounts[KeyringAccountType.HDAccount];
      const nextId = this.getNextAccountId(accounts);

      // EVM accounts should use generic labels since they work across all EVM networks
      const defaultLabel = `Account ${nextId + 1}`;

      const newAccount = await this.setDerivedWeb3Accounts(
        nextId,
        label || defaultLabel
      );

      return newAccount;
    } catch (error) {
      console.log('ERROR addNewAccountToEth', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
      throw error;
    }
  }

  // Helper method to get next available account ID - fills gaps when accounts are deleted
  private getNextAccountId(accounts: any): number {
    const existingIds = Object.values(accounts)
      .filter((account: any) => {
        // Only count accounts that have been properly initialized
        // Placeholder accounts have empty addresses/xprv/xpub
        return account && account.address && account.xpub;
      })
      .map((account: any) => account.id)
      .filter((id) => !isNaN(id))
      .sort((a, b) => a - b); // Sort to find gaps efficiently

    if (existingIds.length === 0) {
      return 0;
    }

    // Find the first gap in the sequence
    for (let i = 0; i < existingIds.length; i++) {
      if (existingIds[i] !== i) {
        // Found a gap at position i
        return i;
      }
    }

    // No gaps found, return next sequential ID
    return existingIds.length;
  }

  private getBasicWeb3AccountInfo = (id: number, label?: string) => {
    return {
      id,
      isTrezorWallet: false,
      isLedgerWallet: false,
      label: label ? label : `Account ${id + 1}`,
    };
  };

  private setDerivedWeb3Accounts = async (
    id: number,
    label: string
  ): Promise<IKeyringAccountState> => {
    try {
      // For account creation, derive from mnemonic (since account doesn't exist yet)
      const mnemonic = this.getDecryptedMnemonic();
      const hdNode = ethers.utils.HDNode.fromMnemonic(mnemonic);
      const derivationPath = getAddressDerivationPath('eth', 60, 0, false, id);
      const derivedAccount = hdNode.derivePath(derivationPath);

      const basicAccountInfo = this.getBasicWeb3AccountInfo(id, label);

      const createdAccount = {
        address: derivedAccount.address,
        xpub: derivedAccount.publicKey,
        xprv: CryptoJS.AES.encrypt(
          derivedAccount.privateKey,
          this.getSessionPasswordString()
        ).toString(),
        isImported: false,
        ...basicAccountInfo,
        balances: { syscoin: 0, ethereum: 0 },
      };

      // NOTE: Account creation should be dispatched to Redux store, not stored here
      // Return the account data for Pali to add to store
      return createdAccount;
    } catch (error) {
      console.log('ERROR setDerivedWeb3Accounts', {
        error,
      });
      this.validateAndHandleErrorByMessage(error.message);
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
    // Clear the vault completely (set empty mnemonic)
    await setEncryptedVault(
      {
        mnemonic: '',
      },
      pwd
    );

    // Remove vault-keys from storage so no vault exists at all
    await this.storage.deleteItem('vault-keys');

    console.log('[KeyringManager] Temporary local keys cleared');
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
      // This allows keyring manager to decrypt with this.sessionPassword
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
    const vault = this.getVault();
    const { accounts } = vault;
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
    const networkToUse = vault.activeNetwork;
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

    // Generate appropriate label based on account type
    const network = vault.activeNetwork;
    let defaultLabel: string;
    if (zprvValidation.isValid) {
      // UTXO imported account - use network-aware label
      const networkPrefix = network.label;
      defaultLabel = label || `${networkPrefix} Imported ${id + 1}`;
    } else {
      // EVM imported account - use generic label
      defaultLabel = label || `Imported ${id + 1}`;
    }

    return {
      ...initialActiveImportedAccountState,
      address,
      label: defaultLabel,
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

  // NEW: On-demand signer creation methods

  /**
   * Common method to decrypt mnemonic from session
   * Eliminates code duplication across multiple methods
   */
  private getDecryptedMnemonic(): string {
    if (!this.sessionMnemonic || !this.sessionPassword) {
      throw new Error('Session information not available');
    }

    const mnemonic = CryptoJS.AES.decrypt(
      this.getSessionMnemonicString(),
      this.getSessionPasswordString()
    ).toString(CryptoJS.enc.Utf8);

    if (!mnemonic) {
      throw new Error('Failed to decrypt mnemonic');
    }

    return mnemonic;
  }

  /**
   * Creates network RPC config from current active network without making RPC calls
   * Common utility for all on-demand signer creation
   */
  private createNetworkRpcConfig() {
    const network = this.getVault().activeNetwork;

    return {
      formattedNetwork: network,
      networkConfig: getNetworkConfig(network.slip44, network.currency),
    };
  }

  /**
   * Common signer creation logic - takes decrypted mnemonic/zprv and creates fresh signer
   * OPTIMIZED: No RPC call needed - uses network config directly
   */
  private createFreshUTXOSigner(
    mnemonicOrZprv: string,
    accountId: number
  ): SyscoinHDSigner {
    // Create signer using network config directly (no RPC call)
    const rpcConfig = this.createNetworkRpcConfig();
    // Type assertion to match getSyscoinSigners expected interface
    const { hd } = getSyscoinSigners({
      mnemonic: mnemonicOrZprv,
      rpc: rpcConfig as any,
    });

    // Create account at the specified index and set it as active
    // Note: createAccountAtIndex is synchronous despite TypeScript types
    hd.createAccountAtIndex(accountId, 84);

    // Verify the account was created correctly
    if (!hd.Signer.accounts.has(accountId)) {
      throw new Error(`Failed to create account at index ${accountId}`);
    }

    // Verify the correct account is active
    if (hd.Signer.accountIndex !== accountId) {
      throw new Error(
        `Account index mismatch: expected ${accountId}, got ${hd.Signer.accountIndex}`
      );
    }

    return hd;
  }

  /**
   * Creates a fresh UTXO signer for HD accounts derived from the main seed
   * OPTIMIZED: No RPC call needed - uses network config directly
   */
  private createOnDemandUTXOSigner(accountId: number): SyscoinHDSigner {
    // Use common method to avoid code duplication
    const mnemonic = this.getDecryptedMnemonic();
    return this.createFreshUTXOSigner(mnemonic, accountId);
  }

  /**
   * Creates a fresh UTXO signer for imported accounts from stored zprv
   * OPTIMIZED: No RPC call needed - uses network config directly
   */
  private createOnDemandUTXOSignerFromImported(
    accountId: number
  ): SyscoinHDSigner {
    if (!this.sessionPassword) {
      throw new Error('Session password not available');
    }

    const vault = this.getVault();
    const account = vault.accounts[KeyringAccountType.Imported][accountId];

    if (!account) {
      throw new Error(`Imported account ${accountId} not found`);
    }

    // Decrypt the stored zprv
    const zprv = CryptoJS.AES.decrypt(
      account.xprv,
      this.getSessionPasswordString()
    ).toString(CryptoJS.enc.Utf8);

    if (!zprv) {
      throw new Error('Failed to decrypt imported account private key');
    }

    if (!this.isZprv(zprv)) {
      throw new Error('Imported account does not contain a valid zprv');
    }

    return this.createFreshUTXOSigner(zprv, accountId);
  }

  /**
   * Common method to create on-demand signer for active account
   * Handles account type determination and delegates to appropriate method
   */
  private createOnDemandSignerForActiveAccount(): SyscoinHDSigner {
    const vault = this.getVault();
    const { activeAccount } = vault;
    const accountId = activeAccount.id;
    const accountType = activeAccount.type;

    if (accountType === KeyringAccountType.HDAccount) {
      return this.createOnDemandUTXOSigner(accountId);
    } else if (accountType === KeyringAccountType.Imported) {
      return this.createOnDemandUTXOSignerFromImported(accountId);
    } else {
      throw new Error(
        `Unsupported account type for UTXO signing: ${accountType}`
      );
    }
  }

  // NEW: Helper methods for HD signer management
  private isZprv(key: string): boolean {
    const zprvPrefixes = ['zprv', 'tprv', 'vprv', 'xprv'];
    return zprvPrefixes.some((prefix) => key.startsWith(prefix));
  }
  // NEW: Separate session initialization from account creation
  public initializeSession = async (
    seedPhrase: string,
    password: string
  ): Promise<void> => {
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
            // Same mnemonic and password - already initialized
            return;
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
  };

  // NEW: Create first account without signer setup
  public createFirstAccount = async (
    label?: string
  ): Promise<IKeyringAccountState> => {
    if (!this.sessionPassword || !this.sessionMnemonic) {
      throw new Error(
        'Session must be initialized first. Call initializeSession.'
      );
    }

    const vault = this.getVault();
    const network = vault.activeNetwork;

    if (network.kind === INetworkType.Syscoin) {
      // UTXO accounts get network-aware labels since each network has separate keyrings
      const defaultLabel = label || this.generateNetworkAwareLabel(0, network);

      // Create UTXO account using on-demand signer
      const freshHDSigner = this.createOnDemandUTXOSigner(0);

      const sysAccount = await this.getFormattedBackendAccount({
        signer: freshHDSigner,
      });

      const encryptedXprv = this.getEncryptedXprv(freshHDSigner);

      return {
        ...this.getInitialAccountData({
          label: defaultLabel,
          signer: freshHDSigner,
          sysAccount,
          xprv: encryptedXprv,
        }),
        balances: { syscoin: 0, ethereum: 0 },
      } as IKeyringAccountState;
    } else {
      // EVM accounts get generic labels since they work across all EVM networks
      const defaultLabel = label || 'Account 1';
      return await this.setDerivedWeb3Accounts(0, defaultLabel);
    }
  };

  public initializeWalletSecurely = async (
    seedPhrase: string,
    password: string
  ): Promise<IKeyringAccountState> => {
    // Use new separated approach
    await this.initializeSession(seedPhrase, password);
    return await this.createFirstAccount();
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

  private generateNetworkAwareLabel(
    accountId: number,
    network: INetwork
  ): string {
    // Generate concise network-specific labels using actual network config
    const { label, chainId, kind, currency } = network;

    // Create a shortened network identifier based on actual network configurations
    let networkPrefix = '';

    if (kind === INetworkType.Syscoin) {
      // UTXO networks (slip44 = 57 for mainnet, 1 for testnet)
      if (chainId === 57) {
        networkPrefix = 'SYS'; // Syscoin UTXO Mainnet
      } else if (chainId === 5700) {
        networkPrefix = 'SYS-T'; // Syscoin UTXO Testnet (slip44=1)
      } else {
        // Other UTXO networks - use currency shortcut (e.g., "btc" -> "BTC")
        if (currency) {
          networkPrefix = currency.toUpperCase();
        } else {
          // Fallback to first word from label if no currency
          const firstWord = label.split(' ')[0];
          networkPrefix =
            firstWord.length > 6 ? firstWord.substring(0, 6) : firstWord;
        }
      }
    } else {
      // EVM networks (all use slip44=60)
      if (chainId === 1) {
        networkPrefix = 'ETH'; // Ethereum Mainnet
      } else if (chainId === 11155111) {
        networkPrefix = 'ETH-T'; // Ethereum Sepolia Testnet
      } else if (chainId === 137) {
        networkPrefix = 'POLY'; // Polygon Mainnet
      } else if (chainId === 80001) {
        networkPrefix = 'POLY-T'; // Polygon Mumbai Testnet
      } else if (chainId === 57) {
        networkPrefix = 'NEVM'; // Syscoin NEVM Mainnet
      } else if (chainId === 5700) {
        networkPrefix = 'NEVM-T'; // Syscoin NEVM Testnet
      } else if (chainId === 570) {
        networkPrefix = 'ROLLUX'; // Rollux Mainnet
      } else if (chainId === 57000) {
        networkPrefix = 'ROLLUX-T'; // Rollux Testnet
      } else {
        // Other EVM networks - use currency shortcut if available
        if (currency) {
          // Check if it's a testnet network
          if (
            label.toLowerCase().includes('testnet') ||
            label.toLowerCase().includes('test')
          ) {
            networkPrefix = `${currency.toUpperCase()}-T`;
          } else {
            networkPrefix = currency.toUpperCase();
          }
        } else {
          // Fallback to extracting meaningful prefix from label
          const firstWord = label.split(' ')[0];
          if (
            firstWord.toLowerCase().includes('testnet') ||
            firstWord.toLowerCase().includes('test')
          ) {
            const baseWord = label.split(' ')[0];
            networkPrefix = `${baseWord.substring(0, 4).toUpperCase()}-T`;
          } else {
            networkPrefix =
              firstWord.length > 6
                ? firstWord.substring(0, 6).toUpperCase()
                : firstWord.toUpperCase();
          }
        }
      }
    }

    return `${networkPrefix} ${accountId + 1}`;
  }

  /**
   * Clean up all resources
   */
  public async destroy(): Promise<void> {
    this.lockWallet();

    // Clear any remaining references
    this.ethereumTransaction = {} as EthereumTransactions;
    this.syscoinTransaction = {} as SyscoinTransactions;
  }
}

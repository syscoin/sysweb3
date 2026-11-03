import ecc from '@bitcoinerlab/secp256k1';
import {
  INetwork,
  INetworkType,
  getNetworkConfig,
} from '@sidhujag/sysweb3-network';
import { BIP32Factory } from 'bip32';
import { Psbt } from 'bitcoinjs-lib';
import bs58check from 'bs58check';
import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import mapValues from 'lodash/mapValues';
import omit from 'lodash/omit';
import * as syscoinjs from 'syscoinjs-lib';
import * as BIP84 from 'syscoinjs-lib/bip84-replacement';

// Reference embedded bitcoinjs from syscoinjs-lib
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bjs: any = (syscoinjs.utils as any).bitcoinjs;

const LEGACY_ENCRYPTION_KDF = 'pbkdf2-sha512-20000';
const SLH_DSA_DERIVATION_VERSION = 1;
// Preserve Pali v1 SLH derivation: first 32 bytes of the account-scoped HMAC.
// Pali expands this setup secret into the 48-byte SLH skSeed/skPrf/pkSeed tuple.
const SLH_DSA_SETUP_SECRET_HEX_LENGTH = 64;
const SLH_DSA_PARAMETER_SET = 'SLH-DSA-SHA2-128-24';

import { getAddress, isHexString } from './ethers-v6';
import {
  initialActiveImportedAccountState,
  initialActiveLedgerAccountState,
  initialActiveTrezorAccountState,
} from './initial-state';
import {
  decryptPrivateRecordBytes,
  encryptPrivateRecordBytes,
  privateRecordProfileId,
  IDecryptPrivateRecordParams,
  IEncryptedPrivateRecord,
  IEncryptPrivateRecordParams,
} from './private-records';
import { getSyscoinSigners, SyscoinHDSigner } from './signers';
import { snapshotEvmHdIndex } from './software-hd-account';
import { VaultAuthenticationError } from './storage-core';
import { EthereumTransactions } from './transactions/ethereum';
import {
  deriveEvmAccountFromMnemonic,
  privateKeyToAccount,
} from './transactions/evm-local-signer';
import {
  preparedEvmGuard,
  signPreparedEvmEnvelope,
  snapshotPreparedEvmRequest,
} from './transactions/prepared-evm';
import {
  SyscoinTransactionsCore,
  createHardwareSignerUnavailableError,
  type ISyscoinHardwareSigners,
} from './transactions/syscoin-core';
import {
  IKeyringAccountState,
  ICreateSmartAccountParams,
  ISyscoinTransactions,
  KeyringAccountType,
  IEthereumTransactions,
  IEvmReplacementOptions,
} from './types';
import { fetchBackendAccountCached as fetchBlockbookAccountCached } from './utils/blockbook-cache';
import {
  getAddressDerivationPath,
  isEvmCoin,
  convertExtendedKeyVersion,
} from './utils/derivation-paths';
import {
  assertPsbtAccountScope,
  createPsbtDerivationGuard,
} from './utils/psbt-account-scope';
import { deriveDescriptorAddress } from './utils/watch-descriptor';

import type { LedgerKeyring } from './ledger';
import type {
  EncryptedEvmHdRuntimeAccount,
  EvmHdRuntimeAccountOptions,
  EvmHdRuntimeAccountRequest,
} from './software-hd-account';
import type { VaultPersistence, VaultStoragePort } from './storage-core';
import type {
  PreparedEvmSigningOptions,
  PreparedSoftwareEvmSigningRequest,
  SignedPreparedEvmTransaction,
} from './transactions/prepared-evm';
import type { TrezorKeyring } from './trezor';

/** Explicit asynchronous host storage; no browser or global DI fallback. */
export interface KeyringStoragePort extends VaultStoragePort {
  get(key: string): Promise<any>;
  deleteItem(key: string): Promise<void>;
  /** Legacy adapter capability; fixed native hosts can omit it. */
  setClient?(client: any): void;
}

/** Only the device capabilities consumed by the wallet authority. */
export interface KeyringLedgerSigner {
  destroy: LedgerKeyring['destroy'];
  evm: Pick<
    LedgerKeyring['evm'],
    | 'getEvmAddressAndPubKey'
    | 'signTypedData'
    | 'signPersonalMessage'
    | 'signEVMTransaction'
  >;
  utxo: Pick<LedgerKeyring['utxo'], 'getXpub'>;
  verifyUtxoAddress: LedgerKeyring['verifyUtxoAddress'];
}

export type KeyringTrezorSigner = Pick<
  TrezorKeyring,
  | 'destroy'
  | 'getAccountInfo'
  | 'getPublicKey'
  | 'signTypedData'
  | 'signMessage'
  | 'signEthTransaction'
  | 'verifyUtxoAddress'
>;

export interface KeyringCoreDependencies<
  TLedger extends KeyringLedgerSigner | undefined,
  TTrezor extends KeyringTrezorSigner | undefined
> {
  /** Immutable identity shared only by keyrings in the same wallet authority. */
  authority: object;
  storage: KeyringStoragePort;
  /** Must be bound to this authority's storage and shared across its keyrings. */
  vaultPersistence: VaultPersistence;
  ledgerSigner: TLedger;
  trezorSigner: TTrezor;
  /** Trusted host adapters; absent device capabilities fail closed. */
  syscoinHardwareSigners?: ISyscoinHardwareSigners;
}

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
      // Zeroing must not depend on a working platform random source.
      this.buffer.fill(0);
      this.buffer = null;
      this._isCleared = true;
    }
  }

  isCleared(): boolean {
    return this._isCleared;
  }
}

export class KeyringCore<
  TLedger extends KeyringLedgerSigner | undefined =
    | KeyringLedgerSigner
    | undefined,
  TTrezor extends KeyringTrezorSigner | undefined =
    | KeyringTrezorSigner
    | undefined
> {
  public trezorSigner: TTrezor;
  public ledgerSigner: TLedger;
  // NOTE: activeChain removed - now derived from vault.activeNetwork.kind
  public initialTrezorAccountState: IKeyringAccountState;
  public initialLedgerAccountState: IKeyringAccountState;
  public utf8Error: boolean;
  //transactions objects
  public ethereumTransaction: IEthereumTransactions;
  public syscoinTransaction: ISyscoinTransactions;
  private readonly authority: object;
  private readonly storage: KeyringStoragePort;
  private readonly vaultPersistence: VaultPersistence;
  private readonly syscoinHardwareSigners: ISyscoinHardwareSigners;

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

  private accountAddressExists = (
    accounts: Record<string, Record<number, IKeyringAccountState>>,
    address: string,
    caseInsensitive = false
  ): boolean => {
    const expectedAddress = caseInsensitive ? address.toLowerCase() : address;

    return Object.values(accounts || {}).some((accountsByType) =>
      Object.values(accountsByType || {}).some((account) => {
        if (!account?.address) {
          return false;
        }

        const accountAddress = caseInsensitive
          ? account.address.toLowerCase()
          : account.address;

        return accountAddress === expectedAddress;
      })
    );
  };

  // Secure session data - using Buffers that can be explicitly cleared
  private sessionPassword: SecureBuffer | null = null;
  private sessionMnemonic: SecureBuffer | null = null; // can be a mnemonic or a zprv, can be changed to a zprv when using an imported wallet
  private privateRecordSessionRevision = 0;

  constructor(dependencies: KeyringCoreDependencies<TLedger, TTrezor>) {
    if (
      !dependencies ||
      typeof dependencies.authority !== 'object' ||
      dependencies.authority === null
    ) {
      throw new TypeError('Keyring core requires an explicit wallet authority');
    }
    if (
      typeof dependencies.vaultPersistence?.getDecryptedVault !== 'function' ||
      typeof dependencies.vaultPersistence?.setEncryptedVault !== 'function'
    ) {
      throw new TypeError('Keyring core requires bound vault persistence');
    }
    this.authority = dependencies.authority;
    this.storage = dependencies.storage;
    this.vaultPersistence = dependencies.vaultPersistence;
    this.ledgerSigner = dependencies.ledgerSigner;
    this.trezorSigner = dependencies.trezorSigner;
    this.syscoinHardwareSigners = { ...dependencies.syscoinHardwareSigners };
    this.writeUtf8Diagnostic(false);
    this.utf8Error = false;
    this.initialTrezorAccountState = initialActiveTrezorAccountState;
    this.initialLedgerAccountState = initialActiveLedgerAccountState;
    this.syscoinTransaction = this.createSyscoinTransactions();
    this.ethereumTransaction = new EthereumTransactions(
      this.getNetwork,
      this.getDecryptedPrivateKey,
      this.getAccountsState,
      this.ledgerSigner,
      this.trezorSigner,
      this.capturePsbtSigningContext
    );
  }

  private createSyscoinTransactions = () =>
    new SyscoinTransactionsCore(
      this.getSigner,
      this.getReadOnlySigner,
      this.getAccountsState,
      this.getAddress,
      this.syscoinHardwareSigners,
      this.capturePsbtSigningContext
    );

  private requireLedgerSigner = (): KeyringLedgerSigner => {
    if (!this.ledgerSigner)
      throw createHardwareSignerUnavailableError('Ledger');
    return this.ledgerSigner;
  };

  private requireTrezorSigner = (): KeyringTrezorSigner => {
    if (!this.trezorSigner)
      throw createHardwareSignerUnavailableError('Trezor');
    return this.trezorSigner;
  };

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

  public setStorage = (client: any) => {
    if (!this.storage.setClient) {
      throw new Error('Storage replacement is unavailable in this host');
    }
    this.storage.setClient(client);
  };

  public validateAccountType = (account: IKeyringAccountState) => {
    return account.isImported === true
      ? KeyringAccountType.Imported
      : KeyringAccountType.HDAccount;
  };

  public isUnlocked = () =>
    !!this.sessionPassword && !this.sessionPassword.isCleared();

  public lockWallet = async () => {
    this.privateRecordSessionRevision++;
    // Clear secure session data
    if (this.sessionPassword) {
      this.sessionPassword.clear();
      this.sessionPassword = null;
    }
    if (this.sessionMnemonic) {
      this.sessionMnemonic.clear();
      this.sessionMnemonic = null;
    }

    // Clear transaction handlers that may hold HD signers
    if (this.syscoinTransaction) {
      // Replace with empty object to clear references
      this.syscoinTransaction = {} as ISyscoinTransactions;
    }
    // NOTE: We intentionally don't clear ethereumTransaction here because
    // polling needs the web3Provider even when the wallet is locked.

    // Clean up hardware wallet connections (await to ensure HID is released)
    if (this.ledgerSigner) {
      try {
        await this.ledgerSigner.destroy();
      } catch (_) {
        // ignore
      }
    }
    if (this.trezorSigner) {
      try {
        await this.trezorSigner.destroy();
      } catch (_) {
        // ignore
      }
    }
  };

  // Direct secure transfer of session data to another keyring
  public transferSessionTo = (
    targetKeyring: Pick<KeyringCore, 'receiveSessionOwnership'>
  ): void => {
    if (!this.isUnlocked()) {
      throw new Error('Source keyring must be unlocked to transfer session');
    }

    // Cross-wallet transfers must fail before either keyring's buffers change.
    if (
      !(targetKeyring instanceof KeyringCore) ||
      targetKeyring.authority !== this.authority ||
      targetKeyring.storage !== this.storage ||
      targetKeyring.vaultPersistence !== this.vaultPersistence
    ) {
      throw new Error(
        'Cannot transfer session between different wallet authorities'
      );
    }
    if (targetKeyring === this) return;

    // Transfer ownership of our buffers to the target
    if (!this.sessionPassword || !this.sessionMnemonic) {
      throw new Error('Session data is missing during transfer');
    }
    this.privateRecordSessionRevision++;

    targetKeyring.acceptSessionFrom(this);

    // Null out our references (do NOT clear buffers - target owns them now)
    this.sessionPassword = null;
    this.sessionMnemonic = null;
  };

  // The checked transfer path never dispatches through a public host receiver.
  private acceptSessionFrom = (source: KeyringCore): void => {
    if (
      source.authority !== this.authority ||
      source.storage !== this.storage ||
      source.vaultPersistence !== this.vaultPersistence
    ) {
      throw new Error(
        'Cannot transfer session between different wallet authorities'
      );
    }
    if (!source.sessionPassword || !source.sessionMnemonic) {
      throw new Error('Session data is missing during transfer');
    }
    this.replaceSessionBuffers(source.sessionPassword, source.sessionMnemonic);
  };

  // Legacy trusted-host API. SoftwareKeyring disables direct buffer injection.
  public receiveSessionOwnership = (
    sessionPassword: SecureBuffer,
    sessionMnemonic: SecureBuffer
  ): void => this.replaceSessionBuffers(sessionPassword, sessionMnemonic);

  private replaceSessionBuffers = (
    sessionPassword: SecureBuffer,
    sessionMnemonic: SecureBuffer
  ): void => {
    this.privateRecordSessionRevision++;
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

  public createSmartAccount = async ({
    address,
    deriveAccount,
    label,
    metadata,
  }: ICreateSmartAccountParams): Promise<IKeyringAccountState> => {
    const vault = this.getVault();
    const { accounts } = vault;

    const smartAccounts = accounts[KeyringAccountType.SmartAccount] || {};
    const nextId = this.getNextAccountId(smartAccounts);
    const derived = deriveAccount
      ? await deriveAccount(nextId)
      : { address, metadata };
    if (!derived.address) {
      throw new Error('Smart account address is required');
    }

    if (this.accountAddressExists(accounts, derived.address, true)) {
      throw new Error('Account already exists on your Wallet.');
    }

    return {
      address: derived.address,
      balances: {
        [INetworkType.Syscoin]: 0,
        [INetworkType.Ethereum]: 0,
      },
      id: nextId,
      isImported: false,
      isLedgerWallet: false,
      isSmartAccount: true,
      isTrezorWallet: false,
      label: label || `Smart Account ${nextId + 1}`,
      smartAccount: derived.metadata,
      xprv: '',
      xpub: derived.address,
    };
  };

  /**
   * Returns canLogin:false only when the first vault authentication fails.
   * Storage, platform and session restoration failures reject so callers do
   * not charge a failed password attempt for an operational error.
   */
  public async unlock(password: string): Promise<{
    canLogin: boolean;
    needsAccountCreation?: boolean;
  }> {
    let authenticated = false;
    try {
      const vaultKeys = await this.storage.get('vault-keys');

      if (!vaultKeys) {
        throw new Error(
          'Vault keys not found. Reload the wallet and try again.'
        );
      }
      // v4: Validate password by deriving the session key once and decrypting the vault with it.
      // This avoids an extra KDF pass just for a stored verifier.
      const { salt } = vaultKeys;

      // Derive session encryption key (in-memory only) used to encrypt/decrypt xprv fields
      // IMPORTANT: This MUST NOT be the same value as the stored verifier above.
      let sessionPasswordKey = await this.deriveStoredSessionKey(
        password,
        vaultKeys
      );
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

        // v3 CBC vaults use the raw password; migrated GCM vaults use the
        // derived key. Selecting by stored format also permits a safe retry
        // if the vault write succeeded but the metadata write was interrupted.
        const { mnemonic } = await this.vaultPersistence.getDecryptedVault(
          sessionPasswordKey,
          password
        );
        authenticated = true;

        const isValidSecret = (value: unknown): value is string => {
          if (typeof value !== 'string' || !value) return false;
          if (this.isSeedValid(value)) return true;
          // Imported extended private keys can also be stored as the secret.
          if (!/^(xprv|yprv|zprv|tprv|uprv|vprv)/.test(value)) return false;
          try {
            const decoded = bs58check.decode(value);
            return (
              decoded.length === 78 &&
              decoded[45] === 0 &&
              ecc.isPrivate(decoded.subarray(46))
            );
          } catch {
            return false;
          }
        };

        let decryptedMnemonic = mnemonic;
        if (!isValidSecret(decryptedMnemonic) && typeof mnemonic === 'string') {
          for (const legacyKey of [password, oldSessionPassword]) {
            try {
              const candidate = CryptoJS.AES.decrypt(
                mnemonic,
                legacyKey
              ).toString(CryptoJS.enc.Utf8);
              if (isValidSecret(candidate)) {
                decryptedMnemonic = candidate;
                break;
              }
            } catch (error) {
              if (error?.message !== 'Malformed UTF-8 data') throw error;
            }
          }
        }
        if (!isValidSecret(decryptedMnemonic)) {
          throw new Error(
            'Legacy vault secret could not be recovered. Existing vault preserved.'
          );
        }

        // Do not change either stored record until a valid secret is recovered.
        await this.vaultPersistence.setEncryptedVault(
          { mnemonic: decryptedMnemonic },
          sessionPasswordKey
        );
        console.log('[KeyringManager] Vault mnemonic format normalized');

        // Remove currentSessionSalt from vault-keys (v4 keeps only the salt on disk)
        const migratedVaultKeys = {
          salt: vaultKeys.salt,
        };
        await this.storage.set('vault-keys', migratedVaultKeys);
        console.log('[KeyringManager] Old vault format migration completed');
      }

      // v4 vault is encrypted with the derived session password key (PBKDF2 output).
      // If the password is wrong, this will throw and we return canLogin:false below.
      let decryptedVault: any;
      let legacyProfile = vaultKeys.keyDerivation === LEGACY_ENCRYPTION_KDF;
      try {
        decryptedVault = await this.vaultPersistence.getDecryptedVault(
          sessionPasswordKey
        );
      } catch (error) {
        // Only the historical CBC fallback used the 20k key without metadata.
        // Never try it for GCM, malformed records, or platform/storage failures.
        const rawVault =
          error instanceof VaultAuthenticationError &&
          !vaultKeys.keyDerivation &&
          !vaultKeys.currentSessionSalt
            ? await this.storage.get('vault')
            : undefined;
        if (typeof rawVault !== 'string' || rawVault.trim().startsWith('{')) {
          throw error;
        }
        const legacyKey = await this.deriveLegacySessionKey(password, salt);
        decryptedVault = await this.vaultPersistence.getDecryptedVault(
          legacyKey
        );
        authenticated = true;
        sessionPasswordKey = legacyKey;
        // Keep the historical account wrapping key. Persist its profile before
        // GCM rewrapping so either interrupted write remains recoverable.
        await this.storage.set('vault-keys', {
          ...vaultKeys,
          keyDerivation: LEGACY_ENCRYPTION_KDF,
        });
        legacyProfile = true;
      }
      authenticated = true;
      if (legacyProfile && this.hasWebCrypto()) {
        const storedVault = await this.storage.get('vault');
        if (
          typeof storedVault === 'string' &&
          !storedVault.trim().startsWith('{')
        ) {
          // A failed earlier rewrap can leave the authenticated profile plus
          // CBC. Retry that write without changing the account wrapping key.
          await this.vaultPersistence.setEncryptedVault(
            decryptedVault,
            sessionPasswordKey
          );
        }
      }

      // If session data missing or corrupted, recreate from vault
      if (!this.sessionMnemonic) {
        await this.recreateSessionFromVault(sessionPasswordKey);
      }

      // Re-initialize syscoin transaction handler if it was cleared on lock.
      // `lockWallet()` intentionally replaces it with a plain object to drop signer references,
      // so we must restore the real class instance on unlock.
      if (
        !this.syscoinTransaction ||
        typeof (this.syscoinTransaction as any).getRecommendedFee !== 'function'
      ) {
        this.syscoinTransaction = this.createSyscoinTransactions();
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
      if (!authenticated && error instanceof VaultAuthenticationError) {
        return { canLogin: false };
      }
      if (authenticated) {
        // lockWallet clears secret buffers synchronously; hardware cleanup
        // is best effort and must not hide the original operational error.
        void this.lockWallet().catch(() => undefined);
      }
      throw error;
    }
  }

  public getNewChangeAddress = async (): Promise<string> => {
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const account = accounts[activeAccount.type]?.[activeAccount.id];
    if (!account) {
      throw new Error('Active account not found');
    }
    const { xpub, isImported, address } = account as any;
    // For imported single-address accounts, always return the single address
    const looksLikeSingleAddress =
      isImported &&
      xpub === address &&
      !this.isDescriptor(xpub) &&
      !this.isXpubLike(xpub);
    if (looksLikeSingleAddress) return address;
    return await this.getAddress(xpub, true); // Don't skip increment - get next unused
  };

  public getChangeAddress = async (id: number): Promise<string> => {
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const account = accounts[activeAccount.type]?.[id];
    if (!account) {
      throw new Error(`Account with id ${id} not found`);
    }
    const { xpub, isImported, address } = account as any;
    if (
      isImported &&
      xpub === address &&
      !this.isDescriptor(xpub) &&
      !this.isXpubLike(xpub)
    )
      return address;
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
    const { xpub, isImported, address } = account as any;
    // Guard: single-address imported are watch-only
    if (isImported && xpub === address) {
      throw new Error(
        'Public key not available for single-address imported accounts'
      );
    }
    // Guard: descriptor/xpub watch-only (no xprv and not hardware)
    if (this.isWatchOnlyAccount(account as any)) {
      throw new Error('Public key not available for watch-only accounts');
    }
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
    const { xpub, isImported, address } = account as any;
    // Guard: single-address imported are watch-only
    if (isImported && xpub === address) {
      throw new Error(
        'BIP32 path not available for single-address imported accounts'
      );
    }
    // Guard: descriptor/xpub watch-only (no xprv and not hardware)
    if (this.isWatchOnlyAccount(account as any)) {
      throw new Error('BIP32 path not available for watch-only accounts');
    }
    return await this.getCurrentAddressBip32Path(xpub, isChangeAddress);
  };

  public updateReceivingAddress = async (): Promise<string> => {
    const vault = this.getVault();
    const { accounts, activeAccount } = vault;
    const account = accounts[activeAccount.type]?.[activeAccount.id];
    if (!account) {
      throw new Error('Active account not found');
    }
    const { xpub, isImported, address } = account as any;
    if (
      isImported &&
      xpub === address &&
      !this.isDescriptor(xpub) &&
      !this.isXpubLike(xpub)
    )
      return address;
    const nextAddress = await this.getAddress(xpub, false);
    // NOTE: Address updates should be dispatched to Redux store, not updated here
    // The calling code should handle the Redux dispatch
    return nextAddress;
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

      const genPwd = await this.deriveStoredSessionKey(pwd, vaultKeys);
      if (this.getSessionPasswordString() !== genPwd) {
        throw new Error('Invalid password');
      }

      const vault = this.getVault();
      const account = vault.accounts[accountType][id];
      if (!account) {
        throw new Error('Account not found');
      }

      // Decrypt the stored private key using secure method
      const decryptedPrivateKey = this.withSecureData((sessionPwd) => {
        const decrypted = CryptoJS.AES.decrypt(
          (account as IKeyringAccountState).xprv,
          sessionPwd
        ).toString(CryptoJS.enc.Utf8);

        if (!decrypted) {
          throw new Error(
            'Failed to decrypt private key. Invalid password or corrupted data.'
          );
        }

        return decrypted;
      });

      // NOTE: Returning decrypted private key as string is necessary for compatibility
      // Callers should handle this sensitive data carefully
      return decryptedPrivateKey;
    } catch (error) {
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

  private isDescriptor = (s: string): boolean =>
    /^(addr|pkh|wpkh|sh|wsh|tr|combo|multi|sortedmulti)\s*\(/i.test(s || '');

  private isXpubLike = (s: string): boolean =>
    /^(xpub|tpub|zpub|vpub)/i.test(s || '');

  private isWatchOnlyAccount(a: IKeyringAccountState): boolean {
    if (a.isLedgerWallet || a.isTrezorWallet) return false;
    if (!a.xprv || a.xprv === '') {
      if (a.xpub === a.address) return true; // single-address imported
      if (this.isXpubLike(a.xpub) || this.isDescriptor(a.xpub)) return true; // xpub/descriptor watch-only
    }
    return false;
  }

  public getEncryptedXprv = (hd: SyscoinHDSigner) => {
    return this.withSecureData((sessionPwd) => {
      return CryptoJS.AES.encrypt(
        this.getSysActivePrivateKey(hd),
        sessionPwd
      ).toString();
    });
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

    const genPwd = await this.deriveStoredSessionKey(pwd, vaultKeys);
    if (this.getSessionPasswordString() !== genPwd) {
      throw new Error('Invalid password');
    }
    // v4 vault is encrypted with the derived session password key (PBKDF2 output)
    let { mnemonic } = await this.vaultPersistence.getDecryptedVault(genPwd);

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

  public deriveSLHDSASetupSecretForAccount = async ({
    accountIndex,
  }: {
    accountIndex: number;
  }): Promise<{
    derivationLabel: string;
    setupSecretHex: string;
  }> => {
    if (!this.sessionPassword) {
      throw new Error('Unlock wallet first');
    }

    const mnemonic = this.getDecryptedMnemonic();
    const normalizedMnemonic = mnemonic.normalize('NFKD');
    const seed = CryptoJS.PBKDF2(
      normalizedMnemonic,
      `mnemonic`.normalize('NFKD'),
      {
        hasher: CryptoJS.algo.SHA512,
        iterations: 2048,
        keySize: 512 / 32,
      }
    );
    const derivationLabel = `PALI/${SLH_DSA_PARAMETER_SET}/v${SLH_DSA_DERIVATION_VERSION}/account/${accountIndex}`;
    const digest = CryptoJS.HmacSHA512(
      derivationLabel,
      CryptoJS.enc.Hex.parse(seed.toString(CryptoJS.enc.Hex))
    );

    return {
      derivationLabel,
      setupSecretHex: digest
        .toString(CryptoJS.enc.Hex)
        .slice(0, SLH_DSA_SETUP_SECRET_HEX_LENGTH),
    };
  };

  public encryptSLHDSASessionState = (plainText: string): string => {
    return this.withSecureData((sessionPwd) =>
      CryptoJS.AES.encrypt(plainText, sessionPwd).toString()
    );
  };

  public decryptSLHDSASessionState = (cipherText: string): string => {
    return this.withSecureData((sessionPwd) => {
      const plainText = CryptoJS.AES.decrypt(cipherText, sessionPwd).toString(
        CryptoJS.enc.Utf8
      );
      if (!plainText) {
        throw new Error('Failed to decrypt SLH-DSA session state');
      }
      return plainText;
    });
  };

  private privateRecordSession() {
    const password = this.sessionPassword;
    const mnemonic = this.sessionMnemonic;
    const revision = this.privateRecordSessionRevision;
    const assertCurrent = () => {
      if (
        !password ||
        !mnemonic ||
        password.isCleared() ||
        mnemonic.isCleared() ||
        this.sessionPassword !== password ||
        this.sessionMnemonic !== mnemonic ||
        this.privateRecordSessionRevision !== revision
      ) {
        throw new Error('Private record session changed');
      }
    };
    assertCurrent();
    const root = this.getDecryptedMnemonic().normalize('NFKD');
    if (!root || root.length > 4096)
      throw new Error('Invalid private record root');
    return { secret: new TextEncoder().encode(root), assertCurrent };
  }

  /** Stable local profile identifier; never an account address or a key. */
  public async getPrivateRecordProfileId(): Promise<string> {
    const session = this.privateRecordSession();
    try {
      const profile = await privateRecordProfileId(
        session.secret,
        session.assertCurrent
      );
      session.assertCurrent();
      return profile;
    } finally {
      session.secret.fill(0);
    }
  }

  /** Encrypt caller-owned bytes; persistence and encrypted backup belong to the caller. */
  public async encryptPrivateRecord(
    params: IEncryptPrivateRecordParams
  ): Promise<IEncryptedPrivateRecord> {
    const session = this.privateRecordSession();
    try {
      const envelope = await encryptPrivateRecordBytes(
        session.secret,
        params,
        session.assertCurrent
      );
      session.assertCurrent();
      return envelope;
    } finally {
      session.secret.fill(0);
    }
  }

  public async decryptPrivateRecord(
    params: IDecryptPrivateRecordParams
  ): Promise<Uint8Array> {
    const session = this.privateRecordSession();
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = await decryptPrivateRecordBytes(
        session.secret,
        params,
        session.assertCurrent
      );
      session.assertCurrent();
      return plaintext;
    } catch (error) {
      plaintext?.fill(0);
      throw error;
    } finally {
      session.secret.fill(0);
    }
  }

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
        // For EVM networks: we primarily need a correct provider for the active network.
        // Active account validation can be temporarily inconsistent during network switching
        // (e.g., placeholder activeAccount like Trezor:0 before accounts hydrate), and provider
        // setup does not depend on it. So treat missing active account as a warning, not a hard error.
        const accountId = vault.activeAccount.id || 0;
        const accountType =
          vault.activeAccount.type || KeyringAccountType.HDAccount;
        const accounts = vault.accounts[accountType];

        if (!accounts?.[accountId]) {
          console.warn(
            `[KeyringManager] Active account ${accountType}:${accountId} not found while setting EVM network; continuing to set provider`
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
    const genPwd = await this.deriveStoredSessionKey(pwd, vaultKeys);
    if (!this.sessionPassword) {
      throw new Error('Unlock wallet first');
    } else if (this.getSessionPasswordString() !== genPwd) {
      throw new Error('Invalid password');
    }

    await this.clearTemporaryLocalKeys();
  };

  public importWeb3Account = (mnemonicOrPrivKey: string) => {
    // Check if it's a hex string (Ethereum private key)
    if (isHexString(mnemonicOrPrivKey)) {
      return privateKeyToAccount(mnemonicOrPrivKey);
    }

    // Check if it's a zprv/tprv (Syscoin private key)
    const zprvPrefixes = ['zprv', 'tprv', 'vprv', 'xprv'];
    if (zprvPrefixes.some((prefix) => mnemonicOrPrivKey.startsWith(prefix))) {
      throw new Error(
        'Syscoin extended private keys (zprv/tprv) should be imported using importAccount, not importWeb3Account'
      );
    }

    // Otherwise, assume it's a mnemonic
    return deriveEvmAccountFromMnemonic(
      mnemonicOrPrivKey,
      getAddressDerivationPath('eth', 60, 0, false, 0)
    );
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

  public isSeedValid = (seedPhrase: string) =>
    BIP84.validateMnemonic(seedPhrase);

  public createNewSeed = (wordCount?: number) => {
    // Map BIP39 word counts to entropy strength
    const wordCountToStrength: Record<number, number> = {
      12: 128,
      15: 160,
      18: 192,
      21: 224,
      24: 256,
    };
    const strength = wordCount ? wordCountToStrength[wordCount] : 128;
    return strength
      ? BIP84.generateMnemonic(strength)
      : BIP84.generateMnemonic();
  };

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
    privateKeyToAccount(privateKey);

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

    // In-flight deduplicated: concurrent callers within a send flow
    // (fee estimation, PSBT creation, signing) share a single request
    const { tokens } = await fetchBlockbookAccountCached(
      main.blockbookURL,
      xpub,
      options
    );

    const { receivingIndex, changeIndex } =
      this.setLatestIndexesFromXPubTokens(tokens);

    // Get network configuration for BIP84 using network-provided pub type macros
    const networkConfig = getNetworkConfig(
      activeNetwork.slip44,
      activeNetwork.currency
    );

    const pubTypes = networkConfig?.types?.zPubType;
    if (!pubTypes) {
      throw new Error('Missing zPubType in network configuration');
    }
    const networks = networkConfig.networks;

    const currentAccount = new BIP84.fromZPub(xpub, pubTypes, networks);

    const addressIndex = isChangeAddress ? changeIndex : receivingIndex;

    return {
      currentAccount,
      addressIndex,
      main,
    };
  };

  public getAddress = async (
    xpub: string,
    isChangeAddress: boolean,
    options?: { forceIndex0?: boolean }
  ) => {
    if (this.isDescriptor(xpub)) {
      // The BIP84 history scanner below cannot choose a descriptor's next
      // unused index. Import can derive index zero locally, but rotation must
      // not reinterpret a descriptor as a BIP84 extended key.
      if (!options?.forceIndex0) {
        throw new Error(
          'Address rotation is not supported for watch-only descriptors'
        );
      }
      return deriveDescriptorAddress(xpub, this.getVault().activeNetwork, {
        change: isChangeAddress,
      });
    }
    const { currentAccount, addressIndex } = await this.fetchCurrentAccountData(
      xpub,
      isChangeAddress
    );

    const effectiveIndex = options?.forceIndex0 ? 0 : addressIndex;

    const address = currentAccount.getAddress(
      effectiveIndex,
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

  public async importAccount(
    privKey: string,
    label?: string,
    options?: { utxoAddressType?: 'p2wpkh' | 'p2pkh' | 'p2tr' }
  ) {
    // Check if wallet is unlocked
    if (!this.isUnlocked()) {
      throw new Error('Wallet must be unlocked to import accounts');
    }

    const importedAccount = await this._getPrivateKeyAccountInfos(
      privKey,
      label,
      options
    );

    // NOTE: Account creation should be dispatched to Redux store, not updated here
    // The calling code should handle the Redux dispatch
    // Return the created account for Pali to add to store
    return importedAccount;
  }

  // Import a WIF on UTXO networks and force legacy P2PKH address/type.
  // Keeps it as a single-address Imported account, storing the address in both xpub and address.

  public async importWatchOnly(identifier: string, label?: string) {
    // Validate via Blockbook and create a watch-only Imported account
    const vault = this.getVault();
    const { accounts, activeNetwork } = vault;

    if (!identifier || typeof identifier !== 'string') {
      throw new Error('Identifier is required');
    }

    const isXpub = this.isXpubLike(identifier);
    const isDesc = this.isDescriptor(identifier);
    const isAddress = !isXpub && !isDesc;

    // Compute address field
    let addressToStore = identifier;
    if (isDesc) {
      // Keep the descriptor as the history reference, never as a recipient.
      // Backend-provided address metadata must not select the deposit address.
      addressToStore = deriveDescriptorAddress(identifier, activeNetwork);
    } else if (isXpub) {
      // Minimal approach: treat any extended pubkey as BIP84 by converting to zpub/vpub
      const { types } = getNetworkConfig(
        activeNetwork.slip44,
        activeNetwork.currency || 'Syscoin'
      );
      const target =
        activeNetwork.slip44 === 1
          ? (types.zPubType as any).testnet.vpub
          : types.zPubType.mainnet.zpub;
      const bip84Key = convertExtendedKeyVersion(identifier, target);
      addressToStore = await this.getAddress(bip84Key, false, {
        forceIndex0: true,
      });
    }

    // Validate duplicates across all account buckets, including passkey smart accounts.
    if (
      this.accountAddressExists(accounts, addressToStore) ||
      ((isXpub || isDesc) &&
        Object.values(accounts || {}).some((bucket) =>
          Object.values(bucket || {}).some(
            (account) => account?.xpub === identifier
          )
        ))
    ) {
      throw new Error('Account already exists on your Wallet.');
    }
    // Confirm with Blockbook
    const options = 'details=basic';
    // Validate against Blockbook directly to capture precise error details (e.g., checksum mismatch)
    const baseUrl = activeNetwork.url.replace(/\/$/, '');
    const path = isXpub || isDesc ? '/api/v2/xpub/' : '/api/v2/address/';
    const url = `${baseUrl}${path}${encodeURIComponent(identifier)}?${options}`;
    let res: any = null;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        let errorText = response.statusText || 'Request failed';
        try {
          const bodyText = await response.text();
          if (bodyText) {
            try {
              const json = JSON.parse(bodyText);
              if (json && json.error) {
                errorText = json.error;
              } else {
                errorText = bodyText;
              }
            } catch {
              errorText = bodyText;
            }
          }
        } catch (parseError) {
          // ignore body parse error; fall back to statusText
        }
        throw new Error(errorText);
      }
      res = await response.json();
    } catch (e: any) {
      throw new Error(e?.message || 'Identifier validation failed');
    }
    if (!res) {
      throw new Error('Identifier not found on the active network');
    }

    const id = this.getNextAccountId(accounts[KeyringAccountType.Imported]);
    const defaultLabel = label || `Watch-only ${id + 1}`;

    const balances = { syscoin: 0, ethereum: 0 };

    const watchOnlyAccount = {
      ...initialActiveImportedAccountState,
      address: addressToStore,
      label: defaultLabel,
      id,
      balances,
      isImported: true,
      xprv: '',
      xpub: isAddress ? addressToStore : identifier,
      assets: {
        syscoin: [],
        ethereum: [],
      },
    } as IKeyringAccountState;

    return watchOnlyAccount;
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

      // Determine target network type: testnet networks typically have slip44 1
      const targetIsTestnet = networkToValidateAgainst.slip44 === 1;

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

  public validateWif(wif: string, targetNetwork?: INetwork) {
    // Use the active network if targetNetwork is not provided
    const networkToValidateAgainst =
      targetNetwork || this.getVault().activeNetwork;

    if (!networkToValidateAgainst) {
      throw new Error('No network available for validation');
    }

    try {
      // Get bitcoinjs network for the target network (Syscoin/BTC etc.)
      const { networks } = getNetworkConfig(
        networkToValidateAgainst.slip44,
        networkToValidateAgainst.currency || 'Bitcoin'
      );

      const isTestnet = networkToValidateAgainst.slip44 === 1;
      const bitcoinNetwork = isTestnet ? networks.testnet : networks.mainnet;

      // Try to parse the WIF for the given network
      const keyPair = (syscoinjs.utils as any).bitcoinjs.ECPair.fromWIF(
        wif,
        bitcoinNetwork
      );
      if (!keyPair || !keyPair.privateKey)
        throw new Error('Invalid WIF private key');

      // Derive an address based on network capability
      // Try different address types to ensure the key can derive addresses
      let address: string | undefined;
      try {
        // Try P2TR (Taproot) first if bech32 is supported
        if ((bitcoinNetwork as any).bech32) {
          try {
            address = bjs.payments.p2wpkh({
              pubkey: keyPair.publicKey,
              network: bitcoinNetwork,
            }).address as string | undefined;
          } catch (e) {
            // P2TR might not be supported, try P2WPKH
          }
        }
        if (!address) {
          address = bjs.payments.p2pkh({
            pubkey: keyPair.publicKey,
            network: bitcoinNetwork,
          }).address as string | undefined;
        }
      } catch (e) {
        // ignore and handle below
      }
      if (!address) throw new Error('Failed to derive address from WIF');

      return { isValid: true };
    } catch (error) {
      return { isValid: false, message: error.message };
    }
  }

  /**
   * PRIVATE METHODS
   */

  // ===================================== AUXILIARY METHOD - FOR TRANSACTIONS CLASSES ===================================== //
  private getDecryptedPrivateKey = (
    targetAccount?: IEvmReplacementOptions['targetAccount']
  ): {
    address: string;
    decryptedPrivateKey: string;
  } => {
    try {
      const vault = this.getVault();
      const { accounts } = vault;
      const activeAccount = targetAccount || vault.activeAccount;
      const activeAccountId = activeAccount.id;
      const activeAccountType = activeAccount.type;
      const isLedger = activeAccountType === KeyringAccountType.Ledger;
      const isTrezor = activeAccountType === KeyringAccountType.Trezor;

      const isHardwareWallet = isTrezor || isLedger;

      if (!this.sessionPassword)
        throw new Error('Wallet is locked cant proceed with transaction');

      const activeAccountData = accounts[activeAccountType][activeAccountId];
      if (!activeAccountData) {
        throw new Error(
          `Active account (${activeAccountType}:${activeAccountId}) not found. Account switching may be in progress.`
        );
      }

      const { xprv, address } = activeAccountData;
      if (isLedger || activeAccountData.isLedgerWallet)
        this.requireLedgerSigner();
      if (isTrezor || activeAccountData.isTrezorWallet)
        this.requireTrezorSigner();

      if (isHardwareWallet) {
        return {
          address,
          decryptedPrivateKey: '',
        };
      }

      if (!xprv) {
        throw new Error(
          `Private key not found for account ${activeAccountType}:${activeAccountId}. Account may not be fully initialized.`
        );
      }

      let decryptedPrivateKey: string;
      try {
        decryptedPrivateKey = this.withSecureData((sessionPwd) => {
          return CryptoJS.AES.decrypt(xprv, sessionPwd).toString(
            CryptoJS.enc.Utf8
          );
        });
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
          const derivedAccount = privateKeyToAccount(decryptedPrivateKey);
          if (derivedAccount.address.toLowerCase() !== address.toLowerCase()) {
            throw new Error(
              `Address mismatch for account ${activeAccountType}:${activeAccountId}. Expected ${address} but derived ${derivedAccount.address}. Account switching may be in progress.`
            );
          }
        } catch (addressError) {
          throw new Error(
            `Failed to validate EVM address for account ${activeAccountType}:${activeAccountId}: ${addressError.message}`
          );
        }
      }

      return {
        address,
        decryptedPrivateKey,
      };
    } catch (error) {
      const vaultForLogging = this.getVault();
      const isTestEnv =
        typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test';
      if (!isTestEnv) {
        console.error('ERROR getDecryptedPrivateKey', {
          error: error.message,
          activeChain: this.getActiveChain(),
          vault: {
            activeAccountId: vaultForLogging?.activeAccount?.id,
            activeAccountType: vaultForLogging?.activeAccount?.type,
          },
        });
      }
      this.validateAndHandleErrorByMessage(error.message);
      throw error;
    }
  };

  private capturePsbtSigningContext = (): (() => void) => {
    const session = this.sessionPassword;
    const vault = this.getVault();
    const selected = { ...vault.activeAccount };
    const account = vault.accounts[selected.type]?.[selected.id];
    const identity = { address: account?.address, xpub: account?.xpub };
    const network = { ...vault.activeNetwork };
    const assertCurrent = () => {
      const current = this.getVault();
      const currentAccount = current.accounts[selected.type]?.[selected.id];
      if (
        !session ||
        session.isCleared() ||
        this.sessionPassword !== session ||
        current.activeAccount.id !== selected.id ||
        current.activeAccount.type !== selected.type ||
        currentAccount?.address !== identity.address ||
        currentAccount?.xpub !== identity.xpub ||
        current.activeNetwork.kind !== network.kind ||
        current.activeNetwork.chainId !== network.chainId ||
        current.activeNetwork.slip44 !== network.slip44 ||
        current.activeNetwork.url !== network.url
      ) {
        throw new Error('Wallet signing context changed');
      }
    };
    assertCurrent();
    return assertCurrent;
  };

  /** Fixed-path derivation for an authenticated software host; no persistence. */
  protected async deriveSoftwareEvmHdRuntimeAccount(
    input: EvmHdRuntimeAccountRequest,
    options: EvmHdRuntimeAccountOptions
  ): Promise<EncryptedEvmHdRuntimeAccount> {
    // Capture the session and selection before inspecting caller-owned objects.
    // Hydration may have no account records yet; account existence is not a guard.
    const session = this.sessionPassword;
    const mnemonic = this.sessionMnemonic;
    const revision = this.privateRecordSessionRevision;
    const vault = this.getVault();
    const selected = { ...vault.activeAccount };
    const network = { ...vault.activeNetwork };
    const assertCurrent = () => {
      const current = this.getVault();
      if (
        !session ||
        session.isCleared() ||
        this.sessionPassword !== session ||
        !mnemonic ||
        mnemonic.isCleared() ||
        this.sessionMnemonic !== mnemonic ||
        this.privateRecordSessionRevision !== revision ||
        network.kind !== INetworkType.Ethereum ||
        network.slip44 !== 60 ||
        !Number.isSafeInteger(network.chainId) ||
        network.chainId <= 0 ||
        typeof network.url !== 'string' ||
        !network.url ||
        current.activeAccount.id !== selected.id ||
        current.activeAccount.type !== selected.type ||
        current.activeNetwork.kind !== network.kind ||
        current.activeNetwork.chainId !== network.chainId ||
        current.activeNetwork.slip44 !== network.slip44 ||
        current.activeNetwork.url !== network.url
      )
        throw new Error(
          'Ethereum HD derivation context changed or is unsupported'
        );
    };
    assertCurrent();
    const index = snapshotEvmHdIndex(input);
    const hostGuard = preparedEvmGuard(options);
    hostGuard();
    assertCurrent();
    const account = await this.setDerivedWeb3Accounts(
      index,
      `Account ${index + 1}`
    );
    hostGuard();
    assertCurrent();
    return account;
  }

  /** The software facade owns this public capability; no device fallback. */
  protected signPreparedSoftwareEvmTransaction(
    input: PreparedSoftwareEvmSigningRequest,
    options: PreparedEvmSigningOptions
  ): SignedPreparedEvmTransaction {
    // Capture authority before parsing caller data or invoking host callbacks.
    const assertSession = this.capturePsbtSigningContext();
    const vault = this.getVault();
    const selected = { ...vault.activeAccount };
    const selectedAccount = vault.accounts[selected.type]?.[selected.id];
    const encryptedKey = selectedAccount?.xprv;
    const request = snapshotPreparedEvmRequest(input);
    const hostGuard = preparedEvmGuard(options);
    const assertCurrent = () => {
      assertSession();
      const current = this.getVault();
      const account = current.accounts[selected.type]?.[selected.id];
      if (
        (selected.type !== KeyringAccountType.HDAccount &&
          selected.type !== KeyringAccountType.Imported) ||
        !account ||
        account.id !== selected.id ||
        account.isLedgerWallet ||
        account.isTrezorWallet ||
        account.isSmartAccount ||
        typeof encryptedKey !== 'string' ||
        encryptedKey.length === 0 ||
        account.xprv !== encryptedKey ||
        request.account.type !== selected.type ||
        request.account.id !== selected.id ||
        request.account.expectedAddress !== getAddress(account.address) ||
        current.activeNetwork.kind !== INetworkType.Ethereum ||
        current.activeNetwork.slip44 !== 60 ||
        !Number.isSafeInteger(current.activeNetwork.chainId) ||
        current.activeNetwork.chainId <= 0 ||
        BigInt(current.activeNetwork.chainId).toString() !==
          request.network.chainId ||
        current.activeNetwork.url !== request.network.url
      )
        throw new Error(
          'Prepared EVM signing context changed or is unsupported'
        );
    };
    assertCurrent();
    hostGuard();
    assertCurrent();
    const key = this.getDecryptedPrivateKey();
    if (getAddress(key.address) !== request.account.expectedAddress)
      throw new Error('Prepared EVM signer address mismatch');
    assertCurrent();
    const signed = signPreparedEvmEnvelope(
      request.transaction,
      key.decryptedPrivateKey
    );
    hostGuard();
    assertCurrent();
    return signed;
  }

  private getSigner = (): {
    hd: any; // SyscoinHDSigner or WIFSigner wrapper with sign(psbt)
    main: any; // syscoinjs-lib Syscoin instance
  } => {
    if (!this.sessionPassword) {
      throw new Error('Wallet is locked cant proceed with transaction');
    }
    if (this.getActiveChain() !== INetworkType.Syscoin) {
      throw new Error('Switch to UTXO chain');
    }

    const vault = this.getVault();
    const { activeAccount } = vault;
    const accountId = activeAccount.id;
    const accountType = activeAccount.type;
    const assertCurrent = this.capturePsbtSigningContext();

    // Determine signer type: HD or WIF single-address
    let signerForUse: any;
    if (accountType === KeyringAccountType.HDAccount) {
      signerForUse = this.createOnDemandUTXOSigner(accountId);
    } else if (accountType === KeyringAccountType.Imported) {
      // Decrypt stored key material
      const decrypted = this.withSecureData((sessionPwd) => {
        const account = vault.accounts[KeyringAccountType.Imported][accountId];
        const res = CryptoJS.AES.decrypt(account.xprv, sessionPwd).toString(
          CryptoJS.enc.Utf8
        );
        if (!res) throw new Error('Failed to decrypt imported account key');
        return res;
      });

      if (this.isZprv(decrypted)) {
        signerForUse = this.createFreshUTXOSigner(decrypted, accountId);
      } else {
        // Treat as WIF single-address signer wrapper exposing sign(psbt)
        const network = vault.activeNetwork;
        const { networks } = getNetworkConfig(network.slip44, network.currency);
        const isTestnet = network.slip44 === 1;
        const bitcoinjsNetwork = isTestnet
          ? networks.testnet
          : networks.mainnet;

        signerForUse = {
          sign: async (psbt: Psbt) => {
            return await (syscoinjs.utils as any).signWithWIF(
              psbt,
              decrypted,
              bitcoinjsNetwork
            );
          },
        };
      }
    } else {
      throw new Error(
        `Unsupported account type for UTXO signing: ${accountType}`
      );
    }

    const scope = {
      account: vault.accounts[accountType][accountId],
      accountId,
      accountType,
      network: vault.activeNetwork,
    };
    if (typeof signerForUse.getRootNode === 'function') {
      const getRootNode = signerForUse.getRootNode.bind(signerForUse);
      const guardPath = createPsbtDerivationGuard(scope);
      signerForUse.getRootNode = () => {
        const root = getRootNode();
        const scopedRoot = Object.create(root);
        scopedRoot.derivePath = (path: string) => {
          guardPath(path);
          return root.derivePath(path);
        };
        return scopedRoot;
      };
    }
    const sign = signerForUse.sign.bind(signerForUse);
    signerForUse.sign = async (psbt: Psbt) => {
      assertCurrent();
      assertPsbtAccountScope(psbt, scope);
      const result = await sign(psbt);
      assertCurrent();
      return result;
    };

    // Create syscoinjs instance with current network (no need to attach signer for signing flow)
    const network = vault.activeNetwork;
    const networkConfig = getNetworkConfig(network.slip44, network.currency);
    const isTestnet = network.slip44 === 1;
    const bitcoinjsNetwork = isTestnet
      ? networkConfig?.networks?.testnet
      : networkConfig?.networks?.mainnet;

    const syscoinMainSigner = new syscoinjs.SyscoinJSLib(
      null,
      network.url,
      bitcoinjsNetwork
    );

    return {
      hd: signerForUse,
      main: syscoinMainSigner,
    };
  };

  // Read-only version that works when wallet is locked
  private getReadOnlySigner = (): {
    main: any; // syscoinjs-lib Syscoin instance (read-only)
  } => {
    if (this.getActiveChain() !== INetworkType.Syscoin) {
      throw new Error('Switch to UTXO chain');
    }

    // Create syscoinjs instance without HD signer for read-only operations
    const vault = this.getVault();
    const network = vault.activeNetwork;
    const networkConfig = getNetworkConfig(network.slip44, network.currency);
    const isTestnet = network.slip44 === 1;
    const bitcoinjsNetwork = isTestnet
      ? networkConfig?.networks?.testnet
      : networkConfig?.networks?.mainnet;

    const syscoinMainSigner = new syscoinjs.SyscoinJSLib(
      null, // No HD signer needed for read-only operations
      network.url,
      bitcoinjsNetwork
    );

    return {
      main: syscoinMainSigner,
    };
  };

  private writeUtf8Diagnostic(hasUtf8Error: boolean): void {
    try {
      void Promise.resolve(
        this.storage.set('utf8Error', { hasUtf8Error })
      ).catch(() => undefined);
    } catch {
      // This diagnostic must not interrupt authentication or become an
      // unhandled rejection when an asynchronous storage client is offline.
    }
  }

  private validateAndHandleErrorByMessage(message: string) {
    const utf8ErrorMessage = 'Malformed UTF-8 data';
    if (
      message.includes(utf8ErrorMessage) ||
      message.toLowerCase().includes(utf8ErrorMessage.toLowerCase())
    ) {
      this.writeUtf8Diagnostic(true);
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
   * @returns derived key: hex string
   */
  private encryptSHA512 = (password: string, salt: string): string => {
    // Session/encryption key derivation (used to encrypt/decrypt xprv in-memory and persisted state).
    // PBKDF2 with SHA-512, 20,000 iterations (prod default), 256-bit output.
    // NOTE: Tests override iterations to keep CI fast.
    const isTestEnv =
      typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test';
    const iterations =
      Number.parseInt(process?.env?.SYSWEB3_PBKDF2_ENC_ITERS || '', 10) ||
      (isTestEnv ? 1_000 : 20_000);
    const key = CryptoJS.PBKDF2(password, CryptoJS.enc.Hex.parse(salt), {
      keySize: 256 / 32, // 256 bits
      iterations,
      hasher: CryptoJS.algo.SHA512,
    });
    return key.toString();
  };

  private hasWebCrypto = (): boolean => {
    // MV3 service worker & extension pages: globalThis.crypto.subtle exists.
    // Jest tests mock global.crypto without subtle -> fallback to CryptoJS.
    return !!(globalThis as any)?.crypto?.subtle;
  };

  private hexToBytes = (hex: string): Uint8Array => {
    const clean = (hex || '').trim();
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
      throw new Error('Invalid hex string');
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };

  private bytesToHex = (bytes: ArrayBuffer): string => {
    const u8 = new Uint8Array(bytes);
    let hex = '';
    for (let i = 0; i < u8.length; i++) {
      hex += u8[i].toString(16).padStart(2, '0');
    }
    return hex;
  };

  private getEncIterations = (): number => {
    const isTestEnv =
      typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test';
    return (
      Number.parseInt(process?.env?.SYSWEB3_PBKDF2_ENC_ITERS || '', 10) ||
      (isTestEnv ? 1_000 : 900_000)
    );
  };

  private async pbkdf2WebCryptoHex(params: {
    password: string;
    saltHex: string;
    iterations: number;
    lengthBytes: number;
    hash: 'SHA-256' | 'SHA-512';
  }): Promise<string> {
    const subtle = (globalThis as any).crypto.subtle as SubtleCrypto;
    const enc = new TextEncoder();
    const passBytes = enc.encode(params.password);
    const saltBytes = this.hexToBytes(params.saltHex);

    const keyMaterial = await subtle.importKey(
      'raw',
      passBytes as unknown as BufferSource,
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    const bits = await subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBytes as unknown as BufferSource,
        iterations: params.iterations,
        hash: params.hash,
      },
      keyMaterial,
      params.lengthBytes * 8
    );

    return this.bytesToHex(bits);
  }

  private async encryptSHA512Async(
    password: string,
    salt: string
  ): Promise<string> {
    if (this.hasWebCrypto()) {
      // Match CryptoJS PBKDF2 output format: hex string
      return await this.pbkdf2WebCryptoHex({
        password,
        saltHex: salt,
        iterations: this.getEncIterations(),
        lengthBytes: 32, // 256-bit
        hash: 'SHA-512',
      });
    }

    throw new Error('WebCrypto is required for vault key derivation');
  }

  private async deriveLegacySessionKey(
    password: string,
    salt: string
  ): Promise<string> {
    if (this.hasWebCrypto()) {
      return this.pbkdf2WebCryptoHex({
        password,
        saltHex: salt,
        iterations: 20_000,
        lengthBytes: 32,
        hash: 'SHA-512',
      });
    }
    // Read compatibility only; new vault writes still require WebCrypto.
    return CryptoJS.PBKDF2(password, CryptoJS.enc.Hex.parse(salt), {
      keySize: 256 / 32,
      iterations: 20_000,
      hasher: CryptoJS.algo.SHA512,
    }).toString();
  }

  private async deriveStoredSessionKey(
    password: string,
    vaultKeys: any
  ): Promise<string> {
    if (vaultKeys.keyDerivation === LEGACY_ENCRYPTION_KDF) {
      return this.deriveLegacySessionKey(password, vaultKeys.salt);
    }
    if (vaultKeys.keyDerivation !== undefined) {
      throw new Error('Unsupported vault key derivation profile');
    }
    return this.encryptSHA512Async(password, vaultKeys.salt);
  }

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

    // For EVM networks, Trezor expects 'eth' regardless of the network's currency
    const trezorCoin = slip44 === 60 ? 'eth' : coin;

    const { descriptor, balance: _balance } =
      await this.requireTrezorSigner().getAccountInfo({
        coin: trezorCoin,
        slip44,
        index,
      });
    const xpub = descriptor;
    const balance = _balance;

    let ethPubKey = '';

    const isEVM = isEvmCoin(coin, slip44);

    // For EVM networks, we need to get the actual address from Trezor
    let address: string;
    if (isEVM) {
      // For EVM, the descriptor from getAccountInfo is the address
      address = xpub;

      // Get the public key for EVM
      const response = await this.requireTrezorSigner().getPublicKey({
        coin: trezorCoin,
        slip44,
        index: +index,
      });
      ethPubKey = response.publicKey;
    } else {
      // For UTXO, use the xpub to derive the address
      // Always use first receive address (index 0) for imported account display
      address = await this.getAddress(xpub, false, { forceIndex0: true });
    }

    if (this.accountAddressExists(accounts, address, isEVM))
      throw new Error('Account already exists on your Wallet.');
    if (!xpub || !address)
      throw new Error(
        'Something wrong happened. Please, try again or report it'
      );

    // Use getNextAccountId to properly handle placeholder accounts
    const id = this.getNextAccountId(accounts[KeyringAccountType.Trezor]);

    // Convert balance from satoshis to SYS safely
    // Using string manipulation to avoid precision loss
    let syscoinBalance = 0;
    if (!isEVM && balance) {
      const balanceStr = balance.toString();
      // Handle conversion without division to preserve precision
      if (balanceStr.length > 8) {
        // Has whole SYS part
        const wholePart = balanceStr.slice(0, -8);
        const decimalPart = balanceStr.slice(-8);
        syscoinBalance = parseFloat(`${wholePart}.${decimalPart}`);
      } else {
        // Less than 1 SYS
        const paddedBalance = balanceStr.padStart(8, '0');
        syscoinBalance = parseFloat(`0.${paddedBalance}`);
      }
    }

    const trezorAccount = {
      ...this.initialTrezorAccountState,
      balances: {
        syscoin: isEVM ? 0 : syscoinBalance,
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
        await this.requireLedgerSigner().evm.getEvmAddressAndPubKey({
          accountIndex: index,
        });
      address = ethAddress;
      xpub = publicKey;
    } else {
      const ledgerXpub = await this.requireLedgerSigner().utxo.getXpub({
        index: index,
        coin,
        slip44,
      });

      // Convert device-returned extended key to BIP84 zpub/vpub for storage/backend usage
      const { types } = getNetworkConfig(slip44, coin);
      const bip84Target =
        slip44 === 1
          ? (types.zPubType as any).testnet.vpub
          : types.zPubType.mainnet.zpub;
      xpub = convertExtendedKeyVersion(ledgerXpub, bip84Target);

      // Always use first receive address (index 0) for imported account display
      address = await this.getAddress(xpub, false, { forceIndex0: true });
    }

    if (this.accountAddressExists(accounts, address, isEvmCoin(coin, slip44)))
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
      const derivationPath = getAddressDerivationPath('eth', 60, 0, false, id);
      const derivedAccount = deriveEvmAccountFromMnemonic(
        mnemonic,
        derivationPath
      );

      const basicAccountInfo = this.getBasicWeb3AccountInfo(id, label);

      const createdAccount = {
        address: derivedAccount.address,
        xpub: derivedAccount.publicKey,
        xprv: this.withSecureData((sessionPwd) => {
          return CryptoJS.AES.encrypt(
            derivedAccount.privateKey,
            sessionPwd
          ).toString();
        }),
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

  private clearTemporaryLocalKeys = async () => {
    // Clear the vault completely.
    // For v4, the vault is encrypted with a derived key, so the safest wipe is to delete the stored blob.
    await this.storage.deleteItem('vault');

    // Remove vault-keys from storage so no vault exists at all
    await this.storage.deleteItem('vault-keys');

    console.log('[KeyringManager] Temporary local keys cleared');
    this.logout();
  };

  private async recreateSessionFromVault(
    saltedHashPassword: string
  ): Promise<void> {
    try {
      // v4 vault is encrypted with the derived session password key (PBKDF2 output)
      // `saltedHashPassword` is the derived session password key passed by caller.
      const { mnemonic } = await this.vaultPersistence.getDecryptedVault(
        saltedHashPassword
      );

      if (!mnemonic) {
        throw new Error('Mnemonic not found in vault');
      }

      // Encrypt session data with sessionPassword hash for consistency
      // This allows keyring manager to decrypt with this.sessionPassword
      this.privateRecordSessionRevision++;
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

  private async _getPrivateKeyAccountInfos(
    privKey: string,
    label?: string,
    options?: { utxoAddressType?: 'p2wpkh' | 'p2pkh' | 'p2tr' }
  ) {
    const vault = this.getVault();
    const { accounts } = vault;
    let importedAccountValue: {
      address: string;
      privateKey: string;
      publicKey: string;
    } | null = null;

    const balances = {
      syscoin: 0,
      ethereum: 0,
    };

    // Try to validate as extended private key first
    const networkToUse = vault.activeNetwork;
    const zprvValidation = this.validateZprv(privKey, networkToUse);

    // Check if we're on an EVM network (slip44 = 60) or UTXO network
    const isEvmNetwork = networkToUse.slip44 === 60;

    if (zprvValidation.isValid) {
      // This is a valid UTXO extended private key
      if (isEvmNetwork) {
        throw new Error(
          'Cannot import UTXO private key on EVM network. Please switch to a UTXO network (Bitcoin/Syscoin) first.'
        );
      }
      const { node, network } = zprvValidation;

      if (!node || !network) {
        throw new Error('Failed to validate extended private key');
      }

      // Always use index 0 for consistency
      const nodeChild = node.derivePath(`0/0`);
      if (!nodeChild) {
        throw new Error('Failed to derive child node');
      }

      // Choose address type based on options or default to p2wpkh
      let addrObj;
      if (options?.utxoAddressType === 'p2pkh') {
        addrObj = bjs.payments.p2pkh({
          pubkey: nodeChild.publicKey,
          network,
        });
      } else if (options?.utxoAddressType === 'p2tr') {
        // For taproot, use x-only public key (32 bytes instead of 33)
        const xOnly =
          nodeChild.publicKey.length === 33
            ? nodeChild.publicKey.slice(1, 33)
            : nodeChild.publicKey;
        addrObj = bjs.payments.p2tr({
          internalPubkey: xOnly,
          network,
        });
      } else {
        // Default to SegWit (p2wpkh)
        addrObj = bjs.payments.p2wpkh({
          pubkey: nodeChild.publicKey,
          network,
        });
      }

      const { address } = addrObj;
      if (!address) {
        throw new Error('Failed to generate address');
      }

      importedAccountValue = {
        address,
        // IMPORTANT: Store BIP84 extended *public* key (zpub/vpub), not device-style xpub/tpub.
        // Blockbook derives different address branches depending on version bytes.
        // Using zpub/vpub ensures UTXO discovery and `input.path` match BIP84 (m/84'/slip44'/...),
        // which is required for HD signing.
        publicKey: (() => {
          try {
            const { types } = getNetworkConfig(
              networkToUse.slip44,
              networkToUse.currency || 'Bitcoin'
            );
            const target =
              networkToUse.slip44 === 1
                ? (types.zPubType as any).testnet.vpub
                : types.zPubType.mainnet.zpub;
            return convertExtendedKeyVersion(
              node.neutered().toBase58(),
              target
            );
          } catch (_e) {
            // Fall back to the default neutered key if conversion fails.
            return node.neutered().toBase58();
          }
        })(),
        privateKey: privKey,
      };

      balances.syscoin = 0;
    } else {
      // If not a valid zprv/vprv, on UTXO networks try WIF
      const isEvmNetwork = networkToUse.slip44 === 60;
      let handledAsUtxo = false;
      if (!isEvmNetwork) {
        const wifValidation = this.validateWif(privKey, networkToUse);
        if (wifValidation.isValid) {
          // Create address from WIF and treat as single-address imported account
          const { networks } = getNetworkConfig(
            networkToUse.slip44,
            networkToUse.currency || 'Bitcoin'
          );
          const isTestnet = networkToUse.slip44 === 1;
          const bitcoinNetwork = isTestnet
            ? networks.testnet
            : networks.mainnet;

          const keyPair = (syscoinjs.utils as any).bitcoinjs.ECPair.fromWIF(
            privKey,
            bitcoinNetwork
          );
          // Choose address type based on options or default behavior
          let addrObj;
          if (options?.utxoAddressType === 'p2pkh') {
            addrObj = bjs.payments.p2pkh({
              pubkey: keyPair.publicKey,
              network: bitcoinNetwork,
            });
          } else if (options?.utxoAddressType === 'p2tr') {
            // For taproot, use x-only public key (32 bytes instead of 33)
            const xOnly =
              keyPair.publicKey.length === 33
                ? keyPair.publicKey.slice(1, 33)
                : keyPair.publicKey;
            addrObj = bjs.payments.p2tr({
              internalPubkey: xOnly,
              network: bitcoinNetwork,
            });
          } else {
            // Default to SegWit (p2wpkh)
            addrObj = bjs.payments.p2wpkh({
              pubkey: keyPair.publicKey,
              network: bitcoinNetwork,
            });
          }
          const address = addrObj.address;
          if (!address) {
            throw new Error('Failed to generate address from WIF');
          }

          importedAccountValue = {
            address,
            // For single-address WIF accounts, store xpub as the address marker
            publicKey: address,
            privateKey: privKey,
          };

          // Set UTXO balance bucket
          balances.syscoin = 0;
          handledAsUtxo = true;

          // Proceed to account creation below
        } else if (!isEvmNetwork && wifValidation.message) {
          // Provide useful feedback on UTXO network if WIF was attempted and failed
          // Continue to EVM handling only if actually EVM network
        }
      }

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

      // Check if it looks like an extended key that failed validation
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
      const prefix = privKey.substring(0, 4);
      const looksLikeExtendedKey = knownExtendedKeyPrefixes.includes(prefix);

      if (looksLikeExtendedKey) {
        // This looks like a UTXO extended key, but it failed validation
        // Don't try to import it as an EVM key
        if (isEvmNetwork) {
          throw new Error(
            'Cannot import UTXO private key on EVM network. Please switch to a UTXO network (Bitcoin/Syscoin) first.'
          );
        }
        // For UTXO networks, throw the original validation error
        throw new Error(
          zprvValidation.message || 'Invalid extended private key'
        );
      }

      // If it's not an extended key and not a valid WIF, treat it as an Ethereum private key
      // But first check if we're on an EVM network
      if (!isEvmNetwork && !handledAsUtxo) {
        throw new Error(
          'Cannot import EVM private key on UTXO network. Please switch to an EVM network first.'
        );
      }

      if (!handledAsUtxo) {
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
    }

    if (!importedAccountValue) {
      throw new Error(
        'Invalid private key format. Expected WIF, extended private key, or 32-byte hex.'
      );
    }

    const { address, publicKey, privateKey } = importedAccountValue;

    // Validate duplicates across all account buckets, including passkey smart accounts.
    if (this.accountAddressExists(accounts, address, isEvmNetwork))
      throw new Error(
        'Account already exists, try again with another Private Key.'
      );

    const id = this.getNextAccountId(accounts[KeyringAccountType.Imported]);
    const defaultLabel: string = label || `Imported ${id + 1}`;
    return {
      ...initialActiveImportedAccountState,
      address,
      label: defaultLabel,
      id,
      balances,
      isImported: true,
      xprv: this.withSecureData((sessionPwd) => {
        return CryptoJS.AES.encrypt(privateKey, sessionPwd).toString();
      }),
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

    const mnemonic = this.withSecureData((sessionPwd, sessionMnemonic) => {
      const decrypted = CryptoJS.AES.decrypt(
        sessionMnemonic,
        sessionPwd
      ).toString(CryptoJS.enc.Utf8);

      if (!decrypted) {
        throw new Error('Failed to decrypt mnemonic');
      }

      return decrypted;
    });

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
    if (!BIP84.validateMnemonic(seedPhrase)) {
      throw new Error('Invalid Seed');
    }

    const [vault, vaultKeys] = await Promise.all([
      this.storage.get('vault'),
      this.storage.get('vault-keys'),
    ]);
    const hasVault = vault !== undefined && vault !== null;
    const hasVaultKeys = vaultKeys !== undefined && vaultKeys !== null;
    const livePassword = this.sessionPassword;
    const liveMnemonic = this.sessionMnemonic;

    // Only an already-unlocked, matching session may repeat initialization.
    // Restoring any existing wallet must use unlock(), never rewrite its vault.
    if (
      livePassword &&
      liveMnemonic &&
      !livePassword.isCleared() &&
      !liveMnemonic.isCleared()
    ) {
      if (!hasVault || !hasVaultKeys || !vaultKeys.salt) {
        throw new Error(
          'Cannot initialize a new vault over existing wallet storage'
        );
      }
      const sessionPasswordSaltedHash = await this.deriveStoredSessionKey(
        password,
        vaultKeys
      );
      if (
        livePassword === this.sessionPassword &&
        liveMnemonic === this.sessionMnemonic &&
        sessionPasswordSaltedHash === this.getSessionPasswordString()
      ) {
        // Same password - check if it's the same mnemonic to ensure full idempotency
        let currentMnemonic: string | undefined;
        try {
          currentMnemonic = this.withSecureData(
            (sessionPwd, sessionMnemonic) => {
              return CryptoJS.AES.decrypt(sessionMnemonic, sessionPwd).toString(
                CryptoJS.enc.Utf8
              );
            }
          );
        } catch (error) {
          // If we can't decrypt, fall through to error
        }
        if (currentMnemonic === seedPhrase) {
          const storedVault = await this.vaultPersistence.getDecryptedVault(
            sessionPasswordSaltedHash
          );
          if (
            livePassword === this.sessionPassword &&
            liveMnemonic === this.sessionMnemonic &&
            !livePassword.isCleared() &&
            !liveMnemonic.isCleared() &&
            storedVault?.mnemonic === seedPhrase
          ) {
            // This is a read-only identity check, not a second vault write.
            return;
          }
        }
      }

      // Different password or mnemonic - this is not a simple re-initialization
      throw new Error(
        'Wallet already initialized with different parameters. Unlock the existing wallet or explicitly remove it before starting setup.'
      );
    }

    if (hasVault || hasVaultKeys) {
      throw new Error(
        'Cannot initialize a new vault over existing wallet storage'
      );
    }

    const salt = crypto.randomBytes(16).toString('hex');
    // v4 stores only the salt on disk. A genuinely fresh initialization always
    // commits its own salt and ciphertext together under the vault mutex.
    const sessionPasswordSaltedHash = await this.deriveStoredSessionKey(
      password,
      { salt }
    );

    // Encrypt and store vault (mnemonic storage) - now uses single vault for all networks
    await this.vaultPersistence.setEncryptedVault(
      {
        mnemonic: seedPhrase, // Store plain mnemonic - setEncryptedVault will encrypt the entire vault
      },
      // v4 vault is encrypted with the derived session password key (PBKDF2 output)
      sessionPasswordSaltedHash,
      { salt }
    );

    await this.recreateSessionFromVault(sessionPasswordSaltedHash);
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
    // WARNING: This exposes sensitive data as a string
    // Use only for CryptoJS operations that require string input
    return this.sessionPassword.toString();
  }

  private getSessionMnemonicString(): string {
    if (!this.sessionMnemonic || this.sessionMnemonic.isCleared()) {
      throw new Error('Session mnemonic not available');
    }
    // WARNING: This exposes sensitive data as a string
    // Use only for CryptoJS operations that require string input
    return this.sessionMnemonic.toString();
  }

  // Secure method to perform cryptographic operations without exposing strings
  private withSecureData<T>(
    operation: (password: string, mnemonic: string) => T
  ): T {
    if (!this.sessionPassword || !this.sessionMnemonic) {
      throw new Error('Session data not available');
    }

    // Perform operation with minimal exposure
    const result = operation(
      this.getSessionPasswordString(),
      this.getSessionMnemonicString()
    );

    // Clear any temporary variables if needed
    return result;
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
    await this.lockWallet();

    // Clear any remaining references
    this.ethereumTransaction = {} as EthereumTransactions;
    this.syscoinTransaction = {} as ISyscoinTransactions;
  }
}

import { KeyringManager, KeyringAccountType } from '../../../src';
import {
  FAKE_PASSWORD,
  PEACE_SEED_PHRASE,
  SECOND_FAKE_SEED_PHRASE,
} from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('KeyringManager - Initialization', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);
  });

  describe('Seed Management', () => {
    it('should create a new valid seed phrase', () => {
      keyringManager = new KeyringManager();
      const seed = keyringManager.createNewSeed();

      expect(seed).toBeDefined();
      expect(seed.split(' ')).toHaveLength(12);
      expect(keyringManager.isSeedValid(seed)).toBe(true);
    });

    it('should validate seed phrases correctly', () => {
      keyringManager = new KeyringManager();

      expect(keyringManager.isSeedValid(PEACE_SEED_PHRASE)).toBe(true);
      expect(keyringManager.isSeedValid('invalid seed phrase')).toBe(false);
      expect(keyringManager.isSeedValid('')).toBe(false);
    });

    it('should retrieve the seed after initialization', async () => {
      keyringManager = new KeyringManager();

      // Set up mock vault state getter for initializeWalletSecurely
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      const retrievedSeed = await keyringManager.getSeed(FAKE_PASSWORD);
      expect(retrievedSeed).toBe(PEACE_SEED_PHRASE);
    });

    it('should reject seed retrieval with wrong password', async () => {
      keyringManager = new KeyringManager();

      // Set up mock vault state getter for initializeWalletSecurely
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      await expect(keyringManager.getSeed('wrong_password')).rejects.toThrow(
        'Invalid password'
      );
    });
  });

  describe('Wallet Initialization', () => {
    it('should initialize wallet for EVM chain', async () => {
      // Set up EVM vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      expect(keyringManager.isUnlocked()).toBe(true);

      const { activeAccount } = keyringManager.getActiveAccount();
      expect(activeAccount.address).toBeDefined();
      expect(activeAccount.address.startsWith('0x')).toBe(true);
    });

    it('should initialize wallet for UTXO chain', async () => {
      // Set up UTXO vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      expect(keyringManager.isUnlocked()).toBe(true);

      const { activeAccount } = keyringManager.getActiveAccount();
      expect(activeAccount.address).toBeDefined();
      expect(activeAccount.address.match(/^(sys1|tsys1)/)).toBeTruthy();
    });

    it('should create deterministic addresses from the same seed', async () => {
      // Set up EVM vault state for both keyrings
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });

      // First EVM keyring
      const mockVaultStateGetter1 = jest.fn(() => currentVaultState);
      const keyring1 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter1
      );

      // Second EVM keyring with same seed
      const mockVaultStateGetter2 = jest.fn(() => currentVaultState);
      const keyring2 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter2
      );

      const account1 = keyring1.getActiveAccount().activeAccount;
      const account2 = keyring2.getActiveAccount().activeAccount;

      expect(account1.address).toBe(account2.address);
      expect(account1.xpub).toBe(account2.xpub);
    });

    it('should handle initialization with invalid seed', async () => {
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      await expect(
        KeyringManager.createInitialized(
          'invalid seed phrase',
          FAKE_PASSWORD,
          mockVaultStateGetter
        )
      ).rejects.toThrow('Invalid Seed');
    });

    it('should be idempotent for multiple initializations with same parameters', async () => {
      keyringManager = new KeyringManager();

      // Set up mock vault state getter for initializeWalletSecurely
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      // First initialization
      const account1 = await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      // Second initialization with same parameters should return same account
      const account2 = await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      expect(account1.address).toBe(account2.address);
      expect(account1.id).toBe(account2.id);
    });

    it('should reject re-initialization with different parameters', async () => {
      keyringManager = new KeyringManager();

      // Set up mock vault state getter for initializeWalletSecurely
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      // First initialization
      await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      // Try to initialize with different seed
      await expect(
        keyringManager.initializeWalletSecurely(
          SECOND_FAKE_SEED_PHRASE,
          FAKE_PASSWORD
        )
      ).rejects.toThrow('Wallet already initialized with different parameters');
    });
  });

  describe('Lock/Unlock', () => {
    beforeEach(async () => {
      // Set up UTXO vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );
    });

    it('should lock and unlock wallet with correct password', async () => {
      expect(keyringManager.isUnlocked()).toBe(true);

      keyringManager.lockWallet();
      expect(keyringManager.isUnlocked()).toBe(false);

      const unlockResult = await keyringManager.unlock(FAKE_PASSWORD);
      expect(unlockResult.canLogin).toBe(true);
      expect(keyringManager.isUnlocked()).toBe(true);
    });

    it('should reject unlock with wrong password', async () => {
      keyringManager.lockWallet();

      const unlockResult = await keyringManager.unlock('wrong_password');
      expect(unlockResult.canLogin).toBe(false);
      expect(keyringManager.isUnlocked()).toBe(false);
    });

    it('should clear session data on lock', () => {
      expect(keyringManager.isUnlocked()).toBe(true);

      keyringManager.lockWallet();

      // After locking, keyring should not be unlocked
      expect(keyringManager.isUnlocked()).toBe(false);
    });

    it('should restore functionality after unlock', async () => {
      const initialAccount = keyringManager.getActiveAccount().activeAccount;

      keyringManager.lockWallet();
      await keyringManager.unlock(FAKE_PASSWORD);

      const accountAfterUnlock =
        keyringManager.getActiveAccount().activeAccount;
      expect(accountAfterUnlock.address).toBe(initialAccount.address);
    });

    it('should handle multiple lock/unlock cycles', async () => {
      for (let i = 0; i < 3; i++) {
        keyringManager.lockWallet();
        expect(keyringManager.isUnlocked()).toBe(false);

        const result = await keyringManager.unlock(FAKE_PASSWORD);
        expect(result.canLogin).toBe(true);
        expect(keyringManager.isUnlocked()).toBe(true);
      }
    });
  });

  describe('Session Management', () => {
    it('should transfer session data between keyrings', async () => {
      // Set up EVM vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });

      // Create first keyring
      const mockVaultStateGetter1 = jest.fn(() => currentVaultState);
      const keyring1 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter1
      );

      // Create second keyring
      const keyring2 = new KeyringManager();

      // Transfer session from first to second keyring
      keyring1.transferSessionTo(keyring2);

      // Both should be unlocked (first should be locked after transfer, second should be unlocked)
      expect(keyring1.isUnlocked()).toBe(false); // Source keyring is locked after transfer
      expect(keyring2.isUnlocked()).toBe(true); // Target keyring is unlocked

      // Second keyring should be able to perform operations with transferred session
      const seed2 = await keyring2.getSeed(FAKE_PASSWORD);
      expect(seed2).toBe(PEACE_SEED_PHRASE);
    });

    it('should throw when transferring from locked keyring', () => {
      const keyring1 = new KeyringManager();
      const keyring2 = new KeyringManager();

      expect(() => keyring1.transferSessionTo(keyring2)).toThrow(
        'Source keyring must be unlocked to transfer session'
      );
    });
  });

  describe('Wallet Reset', () => {
    beforeEach(async () => {
      // Set up EVM vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );
    });

    it('should forget wallet with correct password', async () => {
      await keyringManager.forgetMainWallet(FAKE_PASSWORD);

      // After forgetting, wallet should be locked and empty
      expect(keyringManager.isUnlocked()).toBe(false);
      const unlockResult = await keyringManager.unlock(FAKE_PASSWORD);
      expect(unlockResult.canLogin).toBe(false); // No vault to unlock
    });

    it('should reject forget wallet with wrong password', async () => {
      await expect(
        keyringManager.forgetMainWallet('wrong_password')
      ).rejects.toThrow('Invalid password');
    });

    it('should require unlock before forget wallet', async () => {
      keyringManager.lockWallet();

      await expect(
        keyringManager.forgetMainWallet(FAKE_PASSWORD)
      ).rejects.toThrow('Unlock wallet first');
    });
  });

  describe('Edge Cases', () => {
    it('should handle vault recreation from corrupted session', async () => {
      // Set up EVM vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Simulate corrupted session by clearing internal state
      keyringManager.lockWallet();

      // Should recreate session from vault on unlock
      const result = await keyringManager.unlock(FAKE_PASSWORD);
      expect(result.canLogin).toBe(true);

      // Verify functionality is restored
      const seed = await keyringManager.getSeed(FAKE_PASSWORD);
      expect(seed).toBe(PEACE_SEED_PHRASE);
    });

    it("should create vault keys when they don't exist", async () => {
      // Use a keyring with proper UTXO setup
      keyringManager = new KeyringManager();

      // Set up mock vault state getter for initializeWalletSecurely
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      // Get the actual storage instance
      const keyringStorage = (keyringManager as any).storage;

      // Ensure no vault-keys exist initially (clean state)
      await keyringStorage.set('vault-keys', null);

      // Should create vault-keys and initialize successfully
      const result = await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      expect(result).toBeDefined();
      expect(result.address).toBeDefined();

      // Verify vault-keys were actually created by checking storage
      const vaultKeys = await keyringStorage.get('vault-keys');
      expect(vaultKeys).toBeDefined();
      expect(vaultKeys.hash).toBeDefined();
      expect(vaultKeys.salt).toBeDefined();
      expect(typeof vaultKeys.hash).toBe('string');
      expect(typeof vaultKeys.salt).toBe('string');
      expect(vaultKeys.hash.length).toBeGreaterThan(0);
      expect(vaultKeys.salt.length).toBeGreaterThan(0);

      // Verify keyring is now unlocked and functional
      expect(keyringManager.isUnlocked()).toBe(true);
      const seed = await keyringManager.getSeed(FAKE_PASSWORD);
      expect(seed).toBe(PEACE_SEED_PHRASE);
    });

    it('should re-initialize from vault when Trezor account was active', async () => {
      // Set up UTXO vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Mock Trezor import
      keyringManager.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: 'xpub_trezor_test',
        balance: 100000000,
      });
      keyringManager.trezorSigner.getPublicKey = jest.fn().mockResolvedValue({
        publicKey: '0x04...',
      });
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1q_trezor_test');

      // Import and activate Trezor account
      const trezorAccount = await keyringManager.importTrezorAccount(
        'Test Trezor'
      );

      // Update vault state with Trezor account
      currentVaultState.accounts[KeyringAccountType.Trezor][trezorAccount.id] =
        {
          id: trezorAccount.id,
          label: 'Test Trezor',
          address: trezorAccount.address,
          xpub: trezorAccount.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
      currentVaultState.activeAccount = {
        id: trezorAccount.id,
        type: KeyringAccountType.Trezor,
      };

      // Account switch is handled by vault state update

      // Verify Trezor is active
      const activeBefore = keyringManager.getActiveAccount();
      expect(activeBefore.activeAccountType).toBe(KeyringAccountType.Trezor);
      expect(activeBefore.activeAccount.isTrezorWallet).toBe(true);

      // Lock keyring and create new instance (simulates app restart)
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager();
      const newMockVaultStateGetter = jest.fn(() => currentVaultState);
      newKeyringManager.setVaultStateGetter(newMockVaultStateGetter);

      // Mock Trezor for new keyring
      newKeyringManager.trezorSigner.getAccountInfo = jest
        .fn()
        .mockResolvedValue({
          descriptor: 'xpub_trezor_test',
          balance: 100000000,
        });

      // Unlock and verify Trezor account is restored as active
      const unlockResult = await newKeyringManager.unlock(FAKE_PASSWORD);
      expect(unlockResult.canLogin).toBe(true);

      const activeAfter = newKeyringManager.getActiveAccount();
      expect(activeAfter.activeAccountType).toBe(KeyringAccountType.Trezor);
      expect(activeAfter.activeAccount.isTrezorWallet).toBe(true);
      expect(activeAfter.activeAccount.id).toBe(trezorAccount.id);
    });

    it('should re-initialize from vault when Ledger account was active', async () => {
      // Set up UTXO vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Mock Ledger import
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('xpub_ledger_test'),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_ledger_test'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_ledger_test'),
      };

      const ledgerAccount = await keyringManager.importLedgerAccount(
        true,
        'Test Ledger'
      );
      expect(ledgerAccount).toBeDefined();
      if (!ledgerAccount) {
        throw new Error('Ledger account creation failed');
      }

      // Update vault state with Ledger account
      currentVaultState.accounts[KeyringAccountType.Ledger][ledgerAccount.id] =
        {
          id: ledgerAccount.id,
          label: 'Test Ledger',
          address: ledgerAccount.address,
          xpub: ledgerAccount.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: true,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
      currentVaultState.activeAccount = {
        id: ledgerAccount.id,
        type: KeyringAccountType.Ledger,
      };

      // Account switch is handled by vault state update

      // Lock and recreate keyring
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager();
      const newMockVaultStateGetter = jest.fn(() => currentVaultState);
      newKeyringManager.setVaultStateGetter(newMockVaultStateGetter);

      // Mock Ledger for new keyring
      newKeyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('xpub_ledger_test'),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_ledger_test'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_ledger_test'),
      };

      const unlockResult = await newKeyringManager.unlock(FAKE_PASSWORD);
      expect(unlockResult.canLogin).toBe(true);

      const activeAfter = newKeyringManager.getActiveAccount();
      expect(activeAfter.activeAccountType).toBe(KeyringAccountType.Ledger);
      expect(activeAfter.activeAccount.isLedgerWallet).toBe(true);
    });

    it('should re-initialize from vault when imported account was active', async () => {
      // Set up UTXO vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Import zprv account
      const mainnetZprv =
        'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR';
      const importedAccount = await keyringManager.importAccount(
        mainnetZprv,
        'Test Imported'
      );

      // Update vault state with imported account
      currentVaultState.accounts[KeyringAccountType.Imported][
        importedAccount.id
      ] = {
        id: importedAccount.id,
        label: 'Test Imported',
        address: importedAccount.address,
        xpub: importedAccount.xpub,
        xprv: importedAccount.xprv,
        isImported: true,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };
      currentVaultState.activeAccount = {
        id: importedAccount.id,
        type: KeyringAccountType.Imported,
      };

      // Account switch is handled by vault state update

      // Lock and recreate keyring
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager();
      const newMockVaultStateGetter = jest.fn(() => currentVaultState);
      newKeyringManager.setVaultStateGetter(newMockVaultStateGetter);

      const unlockResult = await newKeyringManager.unlock(FAKE_PASSWORD);
      expect(unlockResult.canLogin).toBe(true);

      const activeAfter = newKeyringManager.getActiveAccount();
      expect(activeAfter.activeAccountType).toBe(KeyringAccountType.Imported);
      expect(activeAfter.activeAccount.isImported).toBe(true);
      expect(activeAfter.activeAccount.id).toBe(importedAccount.id);
    });

    it('should handle missing hardware wallet during re-init gracefully', async () => {
      // Set up UTXO vault state
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Import Trezor
      keyringManager.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: 'xpub_trezor_missing',
        balance: 100000000,
      });
      keyringManager.trezorSigner.getPublicKey = jest.fn().mockResolvedValue({
        publicKey: '0x04...',
      });
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1q_trezor_missing');

      const trezorAccount = await keyringManager.importTrezorAccount(
        'Missing Trezor'
      );

      // Update vault state with Trezor account
      currentVaultState.accounts[KeyringAccountType.Trezor][trezorAccount.id] =
        {
          id: trezorAccount.id,
          label: 'Missing Trezor',
          address: trezorAccount.address,
          xpub: trezorAccount.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
      currentVaultState.activeAccount = {
        id: trezorAccount.id,
        type: KeyringAccountType.Trezor,
      };

      // Recreate keyring with Trezor as active but hardware not available
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager();
      const newMockVaultStateGetter = jest.fn(() => currentVaultState);
      newKeyringManager.setVaultStateGetter(newMockVaultStateGetter);

      // Mock hardware wallet communication error
      newKeyringManager.trezorSigner.getAccountInfo = jest
        .fn()
        .mockRejectedValue(new Error('Trezor device not found'));

      // Should still unlock successfully
      const unlockResult = await newKeyringManager.unlock(FAKE_PASSWORD);
      expect(unlockResult.canLogin).toBe(true);

      // Account info should still be accessible from vault
      const activeAfter = newKeyringManager.getActiveAccount();
      expect(activeAfter.activeAccount.label).toBe('Missing Trezor');
    });
  });
});

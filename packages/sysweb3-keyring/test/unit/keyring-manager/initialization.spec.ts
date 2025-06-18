import {
  KeyringManager,
  initialWalletState,
  KeyringAccountType,
} from '../../../src';
import {
  FAKE_PASSWORD,
  PEACE_SEED_PHRASE,
  SECOND_FAKE_SEED_PHRASE,
} from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('KeyringManager - Initialization', () => {
  let keyringManager: KeyringManager;

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
      await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      const retrievedSeed = await keyringManager.getSeed(FAKE_PASSWORD);
      expect(retrievedSeed).toBe(PEACE_SEED_PHRASE);
    });

    it('should reject seed retrieval with wrong password', async () => {
      keyringManager = new KeyringManager();
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
      const ethereumMainnet = initialWalletState.networks.ethereum[1];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethereumMainnet,
        },
        INetworkType.Ethereum
      );

      expect(keyringManager.isUnlocked()).toBe(true);
      expect(keyringManager.activeChain).toBe(INetworkType.Ethereum);

      const { activeAccount } = keyringManager.getActiveAccount();
      expect(activeAccount.address).toBeDefined();
      expect(activeAccount.address.startsWith('0x')).toBe(true);
    });

    it('should initialize wallet for UTXO chain', async () => {
      const syscoinMainnet = initialWalletState.networks.syscoin[57];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
        },
        INetworkType.Syscoin
      );

      expect(keyringManager.isUnlocked()).toBe(true);
      expect(keyringManager.activeChain).toBe(INetworkType.Syscoin);

      const { activeAccount } = keyringManager.getActiveAccount();
      expect(activeAccount.address).toBeDefined();
      expect(activeAccount.address.match(/^(sys1|tsys1)/)).toBeTruthy();
    });

    it('should create deterministic addresses from the same seed', async () => {
      // First EVM keyring
      const ethereumMainnet = initialWalletState.networks.ethereum[1];
      const keyring1 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethereumMainnet,
        },
        INetworkType.Ethereum
      );

      // Second EVM keyring with same seed
      const keyring2 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethereumMainnet,
        },
        INetworkType.Ethereum
      );

      const account1 = keyring1.getActiveAccount().activeAccount;
      const account2 = keyring2.getActiveAccount().activeAccount;

      expect(account1.address).toBe(account2.address);
      expect(account1.xpub).toBe(account2.xpub);
    });

    it('should handle initialization with invalid seed', async () => {
      const ethereumMainnet = initialWalletState.networks.ethereum[1];
      await expect(
        KeyringManager.createInitialized(
          'invalid seed phrase',
          FAKE_PASSWORD,
          {
            ...initialWalletState,
            activeNetwork: ethereumMainnet,
          },
          INetworkType.Ethereum
        )
      ).rejects.toThrow('Invalid Seed');
    });

    it('should be idempotent for multiple initializations with same parameters', async () => {
      keyringManager = new KeyringManager();

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
      const syscoinMainnet = initialWalletState.networks.syscoin[57];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
        },
        INetworkType.Syscoin
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

      expect(() => keyringManager.getSessionData()).toThrow(
        'Keyring must be unlocked'
      );
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
    it('should get and set session data between keyrings', async () => {
      // Create first keyring
      const ethereumMainnet = initialWalletState.networks.ethereum[1];
      const keyring1 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethereumMainnet,
        },
        INetworkType.Ethereum
      );

      // Get session data from first keyring
      const sessionData = keyring1.getSessionData();
      expect(sessionData.sessionPassword).toBeDefined();
      expect(sessionData.sessionMnemonic).toBeDefined();

      // Create second keyring and set session data
      const keyring2 = new KeyringManager();
      keyring2.setSessionData(sessionData);

      // Second keyring should now be unlocked with same session
      expect(keyring2.isUnlocked()).toBe(true);
    });

    it('should throw when getting session data from locked keyring', () => {
      keyringManager = new KeyringManager();

      expect(() => keyringManager.getSessionData()).toThrow(
        'Keyring must be unlocked'
      );
    });
  });

  describe('Wallet Reset', () => {
    beforeEach(async () => {
      const ethereumMainnet = initialWalletState.networks.ethereum[1];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethereumMainnet,
        },
        INetworkType.Ethereum
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
      const ethereumMainnet = initialWalletState.networks.ethereum[1];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethereumMainnet,
        },
        INetworkType.Ethereum
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

    it('should handle missing vault keys gracefully', async () => {
      keyringManager = new KeyringManager();

      // Mock storage to return no vault keys
      const mockStorage = (keyringManager as any).storage;
      mockStorage.get = jest.fn().mockResolvedValue(null);

      await expect(
        keyringManager.initializeWalletSecurely(
          PEACE_SEED_PHRASE,
          FAKE_PASSWORD
        )
      ).rejects.toThrow('Vault keys not found');
    });

    it('should re-initialize from vault when Trezor account was active', async () => {
      // Test Trezor account preservation across vault re-initialization
      const syscoinMainnet = initialWalletState.networks.syscoin[57];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
        },
        INetworkType.Syscoin
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
      await keyringManager.setActiveAccount(
        trezorAccount.id,
        KeyringAccountType.Trezor
      );

      // Verify Trezor is active
      const activeBefore = keyringManager.getActiveAccount();
      expect(activeBefore.activeAccountType).toBe(KeyringAccountType.Trezor);
      expect(activeBefore.activeAccount.isTrezorWallet).toBe(true);

      // Lock keyring and create new instance (simulates app restart)
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
          activeAccountId: trezorAccount.id,
          activeAccountType: KeyringAccountType.Trezor,
          accounts: keyringManager.wallet.accounts,
        },
        activeChain: INetworkType.Syscoin,
        slip44: 57,
      });

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
      // Test Ledger account preservation across vault re-initialization
      const syscoinMainnet = initialWalletState.networks.syscoin[57];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
        },
        INetworkType.Syscoin
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
      await keyringManager.setActiveAccount(
        ledgerAccount!.id,
        KeyringAccountType.Ledger
      );

      // Lock and recreate keyring
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
          activeAccountId: ledgerAccount!.id,
          activeAccountType: KeyringAccountType.Ledger,
          accounts: keyringManager.wallet.accounts,
        },
        activeChain: INetworkType.Syscoin,
        slip44: 57,
      });

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
      // Test imported account preservation across vault re-initialization
      const syscoinMainnet = initialWalletState.networks.syscoin[57];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
        },
        INetworkType.Syscoin
      );

      // Import zprv account
      const mainnetZprv =
        'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR';
      const importedAccount = await keyringManager.importAccount(
        mainnetZprv,
        'Test Imported'
      );
      await keyringManager.setActiveAccount(
        importedAccount.id,
        KeyringAccountType.Imported
      );

      // Lock and recreate keyring
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
          activeAccountId: importedAccount.id,
          activeAccountType: KeyringAccountType.Imported,
          accounts: keyringManager.wallet.accounts,
        },
        activeChain: INetworkType.Syscoin,
        slip44: 57,
      });

      const unlockResult = await newKeyringManager.unlock(FAKE_PASSWORD);
      expect(unlockResult.canLogin).toBe(true);

      const activeAfter = newKeyringManager.getActiveAccount();
      expect(activeAfter.activeAccountType).toBe(KeyringAccountType.Imported);
      expect(activeAfter.activeAccount.isImported).toBe(true);
      expect(activeAfter.activeAccount.id).toBe(importedAccount.id);
    });

    it('should re-init to HD account then switch to Trezor from vault', async () => {
      // Test switching to preserved Trezor account after HD initialization
      const syscoinMainnet = initialWalletState.networks.syscoin[57];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
        },
        INetworkType.Syscoin
      );

      // Mock and import Trezor
      keyringManager.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: 'xpub_trezor_preserved',
        balance: 100000000,
      });
      keyringManager.trezorSigner.getPublicKey = jest.fn().mockResolvedValue({
        publicKey: '0x04...',
      });
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1q_trezor_preserved');

      const trezorAccount = await keyringManager.importTrezorAccount(
        'Preserved Trezor'
      );
      await keyringManager.setActiveAccount(
        trezorAccount.id,
        KeyringAccountType.Trezor
      );

      // Lock and recreate keyring (should default to HD account 0)
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
          // Note: Not setting activeAccountId/Type - should default to HD account 0
          accounts: keyringManager.wallet.accounts, // Preserve imported accounts
        },
        activeChain: INetworkType.Syscoin,
        slip44: 57,
      });

      const unlockResult = await newKeyringManager.unlock(FAKE_PASSWORD);
      expect(unlockResult.canLogin).toBe(true);

      // Should default to HD account
      const activeAfterUnlock = newKeyringManager.getActiveAccount();
      expect(activeAfterUnlock.activeAccountType).toBe(
        KeyringAccountType.HDAccount
      );
      expect(activeAfterUnlock.activeAccount.id).toBe(0);

      // Switch back to previously imported Trezor account
      newKeyringManager.trezorSigner.getAccountInfo = jest
        .fn()
        .mockResolvedValue({
          descriptor: 'xpub_trezor_preserved',
          balance: 100000000,
        });

      await newKeyringManager.setActiveAccount(
        trezorAccount.id,
        KeyringAccountType.Trezor
      );

      // Verify account state is preserved and functional
      const finalActive = newKeyringManager.getActiveAccount();
      expect(finalActive.activeAccountType).toBe(KeyringAccountType.Trezor);
      expect(finalActive.activeAccount.isTrezorWallet).toBe(true);
      expect(finalActive.activeAccount.label).toBe('Preserved Trezor');
      expect(finalActive.activeAccount.id).toBe(trezorAccount.id);
    });

    it('should handle missing hardware wallet during re-init gracefully', async () => {
      // Test edge case where hardware wallet is not available after vault re-init
      const syscoinMainnet = initialWalletState.networks.syscoin[57];
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
        },
        INetworkType.Syscoin
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

      // Recreate keyring with Trezor as active but hardware not available
      keyringManager.lockWallet();
      const newKeyringManager = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: syscoinMainnet,
          activeAccountId: trezorAccount.id,
          activeAccountType: KeyringAccountType.Trezor,
          accounts: keyringManager.wallet.accounts,
        },
        activeChain: INetworkType.Syscoin,
        slip44: 57,
      });

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

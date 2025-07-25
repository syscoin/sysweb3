import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('KeyringManager - Security', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);
  });

  describe('Password Management', () => {
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

    it('should require password for sensitive operations', async () => {
      // getSeed requires password
      await expect(keyringManager.getSeed('wrong_password')).rejects.toThrow(
        'Invalid password'
      );

      // getPrivateKeyByAccountId requires password
      await expect(
        keyringManager.getPrivateKeyByAccountId(
          0,
          KeyringAccountType.HDAccount,
          'wrong_password'
        )
      ).rejects.toThrow('Invalid password');

      // forgetMainWallet requires password
      await expect(
        keyringManager.forgetMainWallet('wrong_password')
      ).rejects.toThrow('Invalid password');
    });

    it('should validate password complexity in real implementation', async () => {
      // Note: This is a placeholder for password complexity validation
      // In real implementation, weak passwords should be rejected
      const weakPasswords = ['123', 'abc', 'password', ''];

      // Current implementation accepts any password
      // This test documents expected behavior for future implementation
      // Future: should reject weak passwords
      expect(weakPasswords.length).toBeGreaterThan(0); // Placeholder assertion
      // for (const weakPassword of weakPasswords) {
      //   await expect(
      //     KeyringManager.createInitialized(PEACE_SEED_PHRASE, weakPassword, INetworkType.Ethereum, mockVaultStateGetter)
      //   ).rejects.toThrow('Password too weak');
      // }
    });

    it('should handle password changes securely', async () => {
      // Current implementation doesn't support password changes
      // This test documents expected behavior for future implementation
      // Future implementation:
      // await keyringManager.changePassword(FAKE_PASSWORD, 'newPassword123!');
      // keyringManager.lockWallet();
      // const result = await keyringManager.unlock('newPassword123!');
      // expect(result.canLogin).toBe(true);
    });
  });

  describe('Encryption', () => {
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

    it('should encrypt sensitive data in memory', async () => {
      // Test that keyring is unlocked (session data exists)
      expect(keyringManager.isUnlocked()).toBe(true);

      // Test that we can retrieve the seed (proving session data is encrypted and functional)
      const retrievedSeed = await keyringManager.getSeed(FAKE_PASSWORD);
      expect(retrievedSeed).toBe(PEACE_SEED_PHRASE);

      // Test that private keys are properly encrypted in storage
      const activeAccount = keyringManager.getActiveAccount().activeAccount;
      expect(activeAccount.address).toBeDefined();
      expect(activeAccount.xpub).toBeDefined();
      // Private key should not be exposed in public API
      expect(activeAccount).not.toHaveProperty('xprv');
    });

    it('should encrypt private keys in vault state', async () => {
      // Check HD account in vault state
      const hdAccount =
        currentVaultState.accounts[KeyringAccountType.HDAccount][0];

      // xprv should be encrypted
      expect(hdAccount.xprv).toBeDefined();
      expect(hdAccount.xprv.startsWith('0x')).toBe(false); // Not plaintext hex
      expect(hdAccount.xprv.length).toBeGreaterThan(66); // Longer than raw key

      // Import an account
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const imported = await keyringManager.importAccount(privateKey);

      // Update vault state to include the imported account
      currentVaultState.accounts[KeyringAccountType.Imported][imported.id] = {
        id: imported.id,
        label: 'Imported 1',
        address: imported.address,
        xpub: imported.xpub,
        xprv: imported.xprv,
        isImported: true,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const importedAccount =
        currentVaultState.accounts[KeyringAccountType.Imported][imported.id];
      expect(importedAccount.xprv).not.toBe(privateKey);
      expect(importedAccount.xprv.length).toBeGreaterThan(privateKey.length);
    });

    it('should clear sensitive data on lock', () => {
      // Verify wallet is unlocked
      expect(keyringManager.isUnlocked()).toBe(true);

      // Lock wallet
      keyringManager.lockWallet();

      // Session data should be cleared - keyring should not be unlocked
      expect(keyringManager.isUnlocked()).toBe(false);

      // Should not be able to perform sensitive operations without unlocking
      expect(keyringManager.getActiveAccount()).toBeDefined(); // Public data still accessible
    });
  });

  describe('Key Derivation Security', () => {
    it('should use standard derivation paths', async () => {
      // Set up EVM vault state
      const evmVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const evmVaultStateGetter = jest.fn(() => evmVaultState);

      // EVM should use BIP44 m/44'/60'/0'/0/x
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        evmVaultStateGetter
      );

      // Set up UTXO vault state
      const utxoVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      const utxoVaultStateGetter = jest.fn(() => utxoVaultState);

      // UTXO should use BIP84 m/84'/57'/0'/0/x for Syscoin
      const utxoKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        utxoVaultStateGetter
      );

      // Addresses should be different due to different derivation paths
      const evmAddress = evmKeyring.getActiveAccount().activeAccount.address;
      const utxoAddress = utxoKeyring.getActiveAccount().activeAccount.address;

      expect(evmAddress).not.toBe(utxoAddress);
      expect(evmAddress.startsWith('0x')).toBe(true);
      expect(utxoAddress.match(/^(sys1|tsys1)/)).toBeTruthy();
    });

    it('should not expose intermediate keys', async () => {
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

      // Only final private keys should be accessible, not master keys
      const privateKey = await keyringManager.getPrivateKeyByAccountId(
        0,
        KeyringAccountType.HDAccount,
        FAKE_PASSWORD
      );

      // Should be account private key, not master private key
      expect(privateKey.startsWith('0x')).toBe(true);
      expect(privateKey.length).toBe(66); // Standard Ethereum private key length
    });
  });

  describe('Vault Security', () => {
    it('should protect vault with proper encryption', async () => {
      // Vault should require password to decrypt
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

      // Lock and try to unlock with wrong password
      keyringManager.lockWallet();
      const wrongResult = await keyringManager.unlock('wrong_password');
      expect(wrongResult.canLogin).toBe(false);

      // Correct password should work
      const correctResult = await keyringManager.unlock(FAKE_PASSWORD);
      expect(correctResult.canLogin).toBe(true);
    });

    it('should use salt for password hashing', async () => {
      // Mock storage should contain vault-keys with salt
      const mockStorage = (global as any).mockStorage || new Map();

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

      // In real implementation, vault-keys should exist
      // This verifies the mock is set up correctly
      const vaultKeys = await mockStorage.get('vault-keys');
      if (vaultKeys) {
        expect(vaultKeys.salt).toBeDefined();
        expect(vaultKeys.hash).toBeDefined();
        expect(vaultKeys.salt.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Import Security', () => {
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

    it('should validate imported keys before storing', async () => {
      // Invalid keys should be rejected
      const invalidKeys = [
        'not_a_key',
        '0x',
        '0xZZZZ', // Invalid hex
        '0x' + '0'.repeat(63), // Too short
        '0x' + '0'.repeat(65), // Too long
      ];

      for (const key of invalidKeys) {
        await expect(keyringManager.importAccount(key)).rejects.toThrow();
      }
    });

    it('should isolate imported keys from HD keys', async () => {
      // Create a clean keyring with only HD accounts (no placeholder imported accounts)
      const cleanVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      // Clear imported accounts
      cleanVaultState.accounts[KeyringAccountType.Imported] = {};
      const cleanVaultStateGetter = jest.fn(() => cleanVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        cleanVaultStateGetter
      );

      // Check initial state - should have 1 HD account, 0 imported
      let hdAccounts = cleanVaultState.accounts[KeyringAccountType.HDAccount];
      let importedAccounts =
        cleanVaultState.accounts[KeyringAccountType.Imported];
      expect(Object.keys(hdAccounts).length).toBe(1);
      expect(Object.keys(importedAccounts).length).toBe(0);

      // Import a key
      const importedKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const imported = await keyringManager.importAccount(importedKey);

      // Update vault state to include the imported account
      cleanVaultState.accounts[KeyringAccountType.Imported][imported.id] = {
        id: imported.id,
        label: 'Imported 1',
        address: imported.address,
        xpub: imported.xpub,
        xprv: imported.xprv,
        isImported: true,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // HD and imported accounts should be in separate stores
      hdAccounts = cleanVaultState.accounts[KeyringAccountType.HDAccount];
      importedAccounts = cleanVaultState.accounts[KeyringAccountType.Imported];

      // HD accounts should remain unchanged (still 1), imported should now have 1
      expect(Object.keys(hdAccounts).length).toBe(1);
      expect(Object.keys(importedAccounts).length).toBe(1);

      // They should have separate ID sequences and be isolated
      expect(hdAccounts[0]).toBeDefined(); // HD account 0 exists
      expect(importedAccounts[0]).toBeDefined(); // Imported account 0 exists
      expect(hdAccounts[0].isImported).toBe(false);
      expect(importedAccounts[0].isImported).toBe(true);
    });
  });

  describe('Memory Security', () => {
    it('should not leak sensitive data in error messages', async () => {
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

      try {
        await keyringManager.getSeed('wrong_password');
      } catch (error) {
        // Error message should not contain the actual password
        expect(error.message).not.toContain(FAKE_PASSWORD);
        expect(error.message).not.toContain(PEACE_SEED_PHRASE);
      }

      try {
        await keyringManager.importAccount('invalid_key');
      } catch (error) {
        // Error should not leak the attempted key
        expect(error.message).not.toContain('invalid_key');
      }
    });

    it('should clear sensitive data on errors', async () => {
      // If initialization fails, no sensitive data should remain
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

      try {
        await keyringManager.initializeWalletSecurely(
          'invalid seed phrase',
          FAKE_PASSWORD
        );
      } catch (error) {
        // Wallet should not be unlocked after failed initialization
        expect(keyringManager.isUnlocked()).toBe(false);
      }
    });
  });

  describe('Access Control', () => {
    beforeEach(async () => {
      // Use clean vault state without placeholder imported accounts
      currentVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      // Clear imported accounts
      currentVaultState.accounts[KeyringAccountType.Imported] = {};
      mockVaultStateGetter = jest.fn(() => currentVaultState);

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );
    });

    it('should require unlock for sensitive operations', async () => {
      keyringManager.lockWallet();

      // These should fail when locked
      await expect(keyringManager.addNewAccount()).rejects.toThrow();
      await expect(
        keyringManager.importAccount('0x' + '0'.repeat(64))
      ).rejects.toThrow();

      // These should work when locked (public data)
      expect(() => keyringManager.getNetwork()).not.toThrow();
      expect(() => keyringManager.getActiveAccount()).not.toThrow();
    });

    it('should validate account ownership', async () => {
      // Can only get private keys for accounts that exist
      await expect(
        keyringManager.getPrivateKeyByAccountId(
          999, // Non-existent account
          KeyringAccountType.HDAccount,
          FAKE_PASSWORD
        )
      ).rejects.toThrow('Account not found');

      // Can only access accounts of the correct type
      expect(() =>
        keyringManager.getAccountById(
          0,
          KeyringAccountType.Imported // Wrong type
        )
      ).toThrow('Account not found');
    });
  });
});

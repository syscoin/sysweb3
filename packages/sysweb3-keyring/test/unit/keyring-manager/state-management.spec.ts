import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType, INetwork } from '@pollum-io/sysweb3-network';

describe('KeyringManager - State Management', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentMockVaultState: any;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);

    // Use global mockVaultState from setup.ts as starting point
    currentMockVaultState = { ...mockVaultState };

    // Mock vault state getter function (from Pali Redux store)
    mockVaultStateGetter = jest.fn(() => currentMockVaultState);
  });

  describe('Initial State', () => {
    it('should initialize with default state when no options provided', () => {
      keyringManager = new KeyringManager();

      // Set up vault state getter for stateless keyring
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      // activeChain is now derived from vault state, not stored locally
      expect(keyringManager.isUnlocked()).toBe(false);

      // Vault state should be accessible via getter, not internal wallet property
      expect(mockVaultStateGetter).not.toHaveBeenCalled(); // Not called yet
    });

    it('should access vault state through getter', () => {
      keyringManager = new KeyringManager();
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      // Access network through getNetwork (which calls vault getter)
      const network = keyringManager.getNetwork();
      expect(mockVaultStateGetter).toHaveBeenCalled();
      expect(network).toBeDefined();
      expect(network.chainId).toBe(currentMockVaultState.activeNetwork.chainId);
    });

    it('should derive active chain from vault state', () => {
      // Test with Syscoin network
      currentMockVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.syscoin[57], // UTXO network
      };

      keyringManager = new KeyringManager();
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      const network = keyringManager.getNetwork();
      expect(network.kind).toBe(INetworkType.Syscoin);

      // Test with Ethereum network
      currentMockVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.ethereum[1], // EVM network
      };

      const evmNetwork = keyringManager.getNetwork();
      expect(evmNetwork.kind).toBe(INetworkType.Ethereum);
    });

    it('should initialize UTXO keyring with syscoin as active network', async () => {
      currentMockVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.syscoin[57],
      };

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      const network = keyringManager.getNetwork();
      expect(network.kind).toBe(INetworkType.Syscoin);
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      // For UTXO networks, xpub should be defined (exact format may vary based on derivation)
      expect(xpub.length).toBeGreaterThan(50); // Reasonable length check
    });

    it('should initialize EVM keyring with ethereum as active network', async () => {
      currentMockVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.ethereum[1],
      };

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      const network = keyringManager.getNetwork();
      expect(network.kind).toBe(INetworkType.Ethereum);
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      expect(xpub.substring(0, 2)).toEqual('0x');
    });

    it('should require vault state getter to be set', () => {
      keyringManager = new KeyringManager();

      // Should throw error when trying to access vault without getter
      expect(() => keyringManager.getNetwork()).toThrow(
        'Vault state getter not configured. Call setVaultStateGetter() first.'
      );
    });
  });

  describe('State Persistence', () => {
    beforeEach(async () => {
      currentMockVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.ethereum[1],
      };

      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );
    });

    it('should handle network configuration updates', async () => {
      const initialNetwork = keyringManager.getNetwork();

      // Update network configuration
      const updatedNetwork: INetwork = {
        ...initialNetwork,
        url: 'https://new-rpc.example.com',
        label: 'Updated Ethereum',
      };

      // In stateless architecture, updateNetworkConfig updates signers but doesn't change vault state
      // Vault state changes would be handled by Pali dispatching to Redux
      await keyringManager.updateNetworkConfig(updatedNetwork);

      // Network from vault state should remain unchanged (since we didn't update mock vault state)
      const network = keyringManager.getNetwork();
      expect(network.url).toBe(initialNetwork.url); // Should remain unchanged
      expect(network.label).toBe(initialNetwork.label); // Should remain unchanged

      // But the method should complete successfully without error
      expect(network).toBeDefined();
    });

    it('should create accounts and return data for Redux dispatch', async () => {
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const importedAccount = await keyringManager.importAccount(
        privateKey,
        'My Import'
      );

      // Should return account data for Pali to dispatch to Redux
      expect(importedAccount).toBeDefined();
      expect(importedAccount.label).toBe('My Import');
      expect(importedAccount.address).toBeDefined();

      // NOTE: In stateless architecture, keyring returns data but doesn't store it
      // The actual storage would be handled by Pali dispatching to Redux
    });

    it('should maintain keyring functionality without internal state', async () => {
      // Add account via keyring (returns data for Redux)
      const newAccount = await keyringManager.addNewAccount('Account 2');
      expect(newAccount).toBeDefined();
      expect(newAccount.label).toBe('Account 2');

      // Import account via keyring (returns data for Redux)
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const importedAccount = await keyringManager.importAccount(privateKey);
      expect(importedAccount).toBeDefined();

      // Network switching should work
      const polygon = mockVaultState.networks.ethereum[137];
      const result = await keyringManager.setSignerNetwork(polygon);
      expect(result.success).toBe(true);
    });
  });

  describe('Multi-Keyring State Isolation', () => {
    it('should maintain separate session data for different keyring instances', async () => {
      // Create EVM keyring with EVM vault state
      const evmVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.ethereum[1],
      };
      const evmVaultGetter = jest.fn(() => evmVaultState);

      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        evmVaultGetter
      );

      // Create UTXO keyring with UTXO vault state
      const utxoVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.syscoin[57],
      };
      const utxoVaultGetter = jest.fn(() => utxoVaultState);

      const utxoKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        utxoVaultGetter
      );

      // Each keyring should access its own vault state
      const evmNetwork = evmKeyring.getNetwork();
      const utxoNetwork = utxoKeyring.getNetwork();

      expect(evmNetwork.kind).toBe(INetworkType.Ethereum);
      expect(utxoNetwork.kind).toBe(INetworkType.Syscoin);

      // Should have called their respective getters
      expect(evmVaultGetter).toHaveBeenCalled();
      expect(utxoVaultGetter).toHaveBeenCalled();
    });

    it('should share session data between keyrings', async () => {
      const keyring1 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Create new keyring for Syscoin
      const utxoVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.syscoin[57],
      };
      const utxoVaultGetter = jest.fn(() => utxoVaultState);

      const keyring2 = new KeyringManager();
      keyring2.setVaultStateGetter(utxoVaultGetter);

      // Transfer session from keyring1 to keyring2
      keyring1.transferSessionTo(keyring2);

      // After transfer: keyring1 should be locked, keyring2 should be unlocked
      expect(keyring1.isUnlocked()).toBe(false);
      expect(keyring2.isUnlocked()).toBe(true);

      // Should be able to perform operations with keyring2
      const seed2 = await keyring2.getSeed(FAKE_PASSWORD);
      expect(seed2).toBe(PEACE_SEED_PHRASE);
    });
  });

  describe('State Recovery', () => {
    it('should handle state recovery after errors', async () => {
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Simulate error during account creation
      const originalAddNewAccount = keyringManager.addNewAccount;
      keyringManager.addNewAccount = jest
        .fn()
        .mockRejectedValue(new Error('Test error'));

      try {
        await keyringManager.addNewAccount('Failed Account');
      } catch (error) {
        // Expected error
      }

      // Restore original method
      keyringManager.addNewAccount = originalAddNewAccount;

      // Should be able to continue operations
      const newAccount = await keyringManager.addNewAccount('Success Account');
      expect(newAccount).toBeDefined();
      expect(newAccount.label).toBe('Success Account');
    });

    it('should handle network switching rollback on failure', async () => {
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      const originalNetwork = keyringManager.getNetwork();

      // Try to switch to invalid network
      const invalidNetwork: INetwork = {
        chainId: 999,
        currency: 'INVALID',
        label: 'Invalid Network',
        url: 'http://invalid',
        kind: 'INVALID' as any,
        explorer: '',
        slip44: 60,
      };

      try {
        await keyringManager.setSignerNetwork(invalidNetwork);
      } catch (error) {
        // Expected error
      }

      // Network should remain unchanged in vault state
      const currentNetwork = keyringManager.getNetwork();
      expect(currentNetwork.chainId).toBe(originalNetwork.chainId);
    });
  });

  describe('State Validation', () => {
    it('should validate account access through vault state', async () => {
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Should be able to get account via vault state
      const account = keyringManager.getAccountById(
        0,
        KeyringAccountType.HDAccount
      );
      expect(account).toBeDefined();
      expect(account.id).toBe(0);

      // Should not allow accessing non-existent account
      expect(() =>
        keyringManager.getAccountById(999, KeyringAccountType.HDAccount)
      ).toThrow('Account not found');
    });

    it('should validate active account through vault state', async () => {
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mockVaultStateGetter
      );

      // Should get active account from vault state
      const { activeAccount } = keyringManager.getActiveAccount();
      expect(activeAccount).toBeDefined();
      expect(activeAccount.id).toBe(currentMockVaultState.activeAccount.id);
    });
  });

  describe('Vault State Integration', () => {
    it('should read all state from vault getter, not internal storage', () => {
      keyringManager = new KeyringManager();
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      // Every state access should call the vault getter
      mockVaultStateGetter.mockClear();

      keyringManager.getNetwork();
      expect(mockVaultStateGetter).toHaveBeenCalledTimes(1);

      keyringManager.getAccountById(0, KeyringAccountType.HDAccount);
      expect(mockVaultStateGetter).toHaveBeenCalledTimes(2);

      keyringManager.getActiveAccount();
      expect(mockVaultStateGetter).toHaveBeenCalledTimes(3);
    });

    it('should work with dynamic vault state changes', () => {
      keyringManager = new KeyringManager();
      keyringManager.setVaultStateGetter(mockVaultStateGetter);

      // Initially get Ethereum network
      const ethNetwork = keyringManager.getNetwork();
      expect(ethNetwork.kind).toBe(INetworkType.Ethereum);

      // Change vault state to Syscoin
      currentMockVaultState = {
        ...mockVaultState,
        activeNetwork: mockVaultState.networks.syscoin[57],
      };

      // Should now get Syscoin network
      const sysNetwork = keyringManager.getNetwork();
      expect(sysNetwork.kind).toBe(INetworkType.Syscoin);
    });
  });
});

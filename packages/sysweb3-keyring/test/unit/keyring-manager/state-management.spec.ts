import {
  KeyringManager,
  initialWalletState,
  KeyringAccountType,
} from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType, INetwork } from '@pollum-io/sysweb3-network';

describe('KeyringManager - State Management', () => {
  let keyringManager: KeyringManager;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);
  });

  describe('Initial State', () => {
    it('should initialize with default state when no options provided', () => {
      keyringManager = new KeyringManager();

      expect(keyringManager.activeChain).toBe(INetworkType.Syscoin);
      expect(keyringManager.wallet).toBeDefined();
      expect(keyringManager.wallet.activeAccountId).toBe(0);
      expect(keyringManager.wallet.activeAccountType).toBe(
        KeyringAccountType.HDAccount
      );
      expect(keyringManager.isUnlocked()).toBe(false);
    });

    it('should initialize with provided wallet state', async () => {
      // Create account 2 that will be set as active
      const account2 = {
        id: 2,
        address: '0x2FcE6c46Ca027d3C29f88d7BC5AB3a8a1C76EfA1',
        xpub: '0x0296f97f5e69b3c7e6dac3e5a8f82aef8b12e79c4dd91e8e5d6e7c8f9a0b1c2d3e4f5',
        xprv: '',
        label: 'Account 3',
        balances: { syscoin: 0, ethereum: 0 },
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        assets: { syscoin: [], ethereum: [] },
      };

      const customWalletState = {
        ...initialWalletState,
        activeAccountId: 2,
        activeNetwork: initialWalletState.networks.ethereum[137], // Polygon
        accounts: {
          ...initialWalletState.accounts,
          [KeyringAccountType.HDAccount]: {
            ...initialWalletState.accounts[KeyringAccountType.HDAccount],
            2: account2,
          },
        },
      };

      keyringManager = new KeyringManager({
        wallet: customWalletState,
        activeChain: INetworkType.Ethereum,
      });

      await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      expect(keyringManager.wallet.activeAccountId).toBe(2);
      expect(keyringManager.wallet.activeNetwork.chainId).toBe(137);
      expect(keyringManager.activeChain).toBe(INetworkType.Ethereum);
    });

    it('should initialize UTXO keyring with syscoin as active chain', async () => {
      const syscoinWalletState = {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.syscoin[57],
      };

      keyringManager = new KeyringManager({
        wallet: syscoinWalletState,
        activeChain: INetworkType.Syscoin,
      });

      await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      expect(keyringManager.activeChain).toBe(INetworkType.Syscoin);
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      expect(xpub.substring(1, 4)).toEqual('pub');
    });

    it('should initialize EVM keyring with ethereum as active chain', async () => {
      const ethereumWalletState = {
        ...initialWalletState,
        activeNetwork: initialWalletState.networks.ethereum[1],
      };

      keyringManager = new KeyringManager({
        wallet: ethereumWalletState,
        activeChain: INetworkType.Ethereum,
      });

      await keyringManager.initializeWalletSecurely(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD
      );

      expect(keyringManager.activeChain).toBe(INetworkType.Ethereum);
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      expect(xpub.substring(0, 2)).toEqual('0x');
    });

    it('should use active chain from options', async () => {
      // Test with explicit activeChain
      const keyringWithActiveChain = new KeyringManager({
        wallet: initialWalletState,
        activeChain: INetworkType.Syscoin,
      });

      expect(keyringWithActiveChain.activeChain).toBe(INetworkType.Syscoin);

      // Test with EVM
      const keyringWithEVM = new KeyringManager({
        wallet: initialWalletState,
        activeChain: INetworkType.Ethereum,
      });

      expect(keyringWithEVM.activeChain).toBe(INetworkType.Ethereum);
    });
  });

  describe('State Persistence', () => {
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

    it('should persist account state changes', async () => {
      // Add accounts
      await keyringManager.addNewAccount('Account 2');
      await keyringManager.addNewAccount('Account 3');

      // Update labels
      keyringManager.updateAccountLabel(
        'Updated Account 2',
        1,
        KeyringAccountType.HDAccount
      );

      // Verify changes persist
      const updatedAccount = keyringManager.getAccountById(
        1,
        KeyringAccountType.HDAccount
      );
      expect(updatedAccount.label).toBe('Updated Account 2');

      // Switch active account
      await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
      expect(keyringManager.wallet.activeAccountId).toBe(2);
    });

    it('should persist network configuration changes', async () => {
      const initialNetwork = keyringManager.getNetwork();

      // Update network configuration
      const updatedNetwork: INetwork = {
        ...initialNetwork,
        url: 'https://new-rpc.example.com',
        label: 'Updated Ethereum',
      };

      await keyringManager.updateNetworkConfig(updatedNetwork);

      const network = keyringManager.getNetwork();
      expect(network.url).toBe('https://new-rpc.example.com');
      expect(network.label).toBe('Updated Ethereum');
    });

    it('should persist imported accounts', async () => {
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      await keyringManager.importAccount(privateKey, 'My Import');

      // Verify account exists in state
      const importedAccounts =
        keyringManager.wallet.accounts[KeyringAccountType.Imported];
      expect(Object.keys(importedAccounts)).toHaveLength(1);
      expect(importedAccounts[0].label).toBe('My Import');
    });

    it('should maintain state integrity across operations', async () => {
      // Perform multiple operations
      await keyringManager.addNewAccount('Account 2');

      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      await keyringManager.importAccount(privateKey);

      const polygon = initialWalletState.networks.ethereum[137];
      await keyringManager.setSignerNetwork(polygon);

      // Verify state consistency
      const state = keyringManager.wallet;
      expect(
        Object.keys(state.accounts[KeyringAccountType.HDAccount])
      ).toHaveLength(2);
      expect(
        Object.keys(state.accounts[KeyringAccountType.Imported])
      ).toHaveLength(1);
      expect(state.activeNetwork.chainId).toBe(137);
    });
  });

  describe('Multi-Keyring State Isolation', () => {
    it('should maintain separate state for different keyring instances', async () => {
      // Create EVM keyring
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.ethereum[1],
        },
        INetworkType.Ethereum
      );

      // Create UTXO keyring
      const utxoKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.syscoin[57],
        },
        INetworkType.Syscoin
      );

      // Add accounts to each
      await evmKeyring.addNewAccount('EVM Account 2');
      await utxoKeyring.addNewAccount('UTXO Account 2');

      // Verify state isolation
      const evmAccounts = Object.keys(
        evmKeyring.wallet.accounts[KeyringAccountType.HDAccount]
      );
      const utxoAccounts = Object.keys(
        utxoKeyring.wallet.accounts[KeyringAccountType.HDAccount]
      );

      expect(evmAccounts).toHaveLength(2);
      expect(utxoAccounts).toHaveLength(2);

      // Labels should be different
      const evmAccount1 = evmKeyring.getAccountById(
        1,
        KeyringAccountType.HDAccount
      );
      const utxoAccount1 = utxoKeyring.getAccountById(
        1,
        KeyringAccountType.HDAccount
      );

      expect(evmAccount1.label).toBe('EVM Account 2');
      expect(utxoAccount1.label).toBe('UTXO Account 2');
    });

    it('should share session data between keyrings', async () => {
      const keyring1 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.ethereum[1],
        },
        INetworkType.Ethereum
      );

      // Create new keyring - use Syscoin for second keyring
      const keyring2 = new KeyringManager({
        wallet: {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.syscoin[57],
        },
        activeChain: INetworkType.Syscoin,
      });

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
        {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.ethereum[1],
        },
        INetworkType.Ethereum
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

      // State should still be valid
      const accounts = Object.keys(
        keyringManager.wallet.accounts[KeyringAccountType.HDAccount]
      );
      expect(accounts).toHaveLength(1); // Only initial account

      // Should be able to continue operations
      const newAccount = await keyringManager.addNewAccount('Success Account');
      expect(newAccount).toBeDefined();
      expect(newAccount.label).toBe('Success Account');
    });

    it('should handle network switching rollback on failure', async () => {
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.ethereum[1],
        },
        INetworkType.Ethereum
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

      // Network should remain unchanged
      const currentNetwork = keyringManager.getNetwork();
      expect(currentNetwork.chainId).toBe(originalNetwork.chainId);
    });
  });

  describe('State Validation', () => {
    it('should validate account type consistency', async () => {
      keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.ethereum[1],
        },
        INetworkType.Ethereum
      );

      // Should not allow setting active account with wrong type
      await expect(
        keyringManager.setActiveAccount(0, KeyringAccountType.Imported)
      ).rejects.toThrow('Account not found');
    });

    it('should ensure all account types exist in wallet state', () => {
      const minimalWalletState = {
        ...initialWalletState,
        accounts: {
          [KeyringAccountType.HDAccount]: {},
          // Missing other account types
        },
      };

      keyringManager = new KeyringManager({
        wallet: minimalWalletState as any,
        activeChain: INetworkType.Ethereum,
      });

      // Constructor should add missing account types
      expect(
        keyringManager.wallet.accounts[KeyringAccountType.Imported]
      ).toBeDefined();
      expect(
        keyringManager.wallet.accounts[KeyringAccountType.Trezor]
      ).toBeDefined();
      expect(
        keyringManager.wallet.accounts[KeyringAccountType.Ledger]
      ).toBeDefined();
    });
  });

  describe('Deep Copy Protection', () => {
    it('should deep copy wallet state to prevent contamination', async () => {
      const sharedWalletState = {
        ...initialWalletState,
        activeAccountId: 0,
        activeNetwork: initialWalletState.networks.ethereum[1], // Use Ethereum network
      };

      // Create two keyrings with same wallet state reference
      const keyring1 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        sharedWalletState,
        INetworkType.Ethereum
      );

      const keyring2 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        sharedWalletState,
        INetworkType.Ethereum
      );

      // Modify keyring1
      await keyring1.addNewAccount('Keyring1 Account');
      await keyring1.setActiveAccount(1, KeyringAccountType.HDAccount);

      // keyring2 should not be affected
      expect(keyring1.wallet.activeAccountId).toBe(1);
      expect(keyring2.wallet.activeAccountId).toBe(0);

      const keyring1Accounts = Object.keys(
        keyring1.wallet.accounts[KeyringAccountType.HDAccount]
      );
      const keyring2Accounts = Object.keys(
        keyring2.wallet.accounts[KeyringAccountType.HDAccount]
      );

      expect(keyring1Accounts).toHaveLength(2);
      expect(keyring2Accounts).toHaveLength(1);
    });
  });
});

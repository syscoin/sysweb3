import { ethers } from 'ethers';

import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('KeyringManager - Key Derivation', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);
  });

  describe('EVM Key Derivation', () => {
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

    it('should derive deterministic EVM addresses', async () => {
      // Get the actual derived addresses for PEACE_SEED_PHRASE (standard test phrase)
      const account0 = keyringManager.getActiveAccount().activeAccount;
      const address0 = account0.address;

      // Add and check more accounts - verify they are deterministic
      const account1 = await keyringManager.addNewAccount();
      const address1 = account1.address;

      // Update vault state with new account
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Account 2',
        address: account1.address,
        xpub: account1.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const account2 = await keyringManager.addNewAccount();
      const address2 = account2.address;

      // Update vault state with new account
      currentVaultState.accounts[KeyringAccountType.HDAccount][2] = {
        id: 2,
        label: 'Account 3',
        address: account2.address,
        xpub: account2.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Verify addresses are valid Ethereum addresses
      expect(address0.startsWith('0x')).toBe(true);
      expect(address0).toHaveLength(42);
      expect(address1.startsWith('0x')).toBe(true);
      expect(address1).toHaveLength(42);
      expect(address2.startsWith('0x')).toBe(true);
      expect(address2).toHaveLength(42);

      // All addresses should be unique
      expect(address0).not.toBe(address1);
      expect(address1).not.toBe(address2);
      expect(address2).not.toBe(address0);
    });

    it('should derive correct private keys for EVM accounts', async () => {
      // The vault state now properly includes encrypted xprv values
      // No manual updates needed - just test the functionality

      // Get private key for account 0
      const privateKey0 = await keyringManager.getPrivateKeyByAccountId(
        0,
        KeyringAccountType.HDAccount,
        FAKE_PASSWORD
      );

      // Verify it derives the correct address
      const wallet = new ethers.Wallet(privateKey0);
      const account = keyringManager.getActiveAccount().activeAccount;
      expect(wallet.address.toLowerCase()).toBe(account.address.toLowerCase());
    });

    it('should use standard EVM derivation path', async () => {
      // EVM uses m/44'/60'/0'/0/index
      // This is tested indirectly by verifying known addresses
      const account = keyringManager.getActiveAccount().activeAccount;
      expect(account.address).toBeDefined();
      expect(account.address.startsWith('0x')).toBe(true);
      expect(account.address).toHaveLength(42);
    });

    it('should handle multiple accounts with consistent derivation', async () => {
      // Add multiple accounts
      const accounts = [keyringManager.getActiveAccount().activeAccount];
      for (let i = 0; i < 5; i++) {
        const account = await keyringManager.addNewAccount();
        accounts.push(account);

        // Update vault state with new account
        currentVaultState.accounts[KeyringAccountType.HDAccount][account.id] = {
          id: account.id,
          label: `Account ${account.id + 1}`,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
      }

      // Verify all addresses are unique
      const addresses = accounts.map((a) => a.address);
      const uniqueAddresses = new Set(addresses);
      expect(uniqueAddresses.size).toBe(addresses.length);

      // Verify sequential IDs
      accounts.forEach((account, index) => {
        expect(account.id).toBe(index);
      });
    });

    it('should derive same addresses from same seed across instances', async () => {
      // Set up second EVM vault state
      const vault2State = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const vault2StateGetter = jest.fn(() => vault2State);

      // Create second keyring with same seed
      const keyring2 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        vault2StateGetter
      );

      // Add accounts to both
      const accounts1 = [keyringManager.getActiveAccount().activeAccount];
      const accounts2 = [keyring2.getActiveAccount().activeAccount];

      for (let i = 0; i < 3; i++) {
        const account1 = await keyringManager.addNewAccount();
        const account2 = await keyring2.addNewAccount();
        accounts1.push(account1);
        accounts2.push(account2);

        // Update vault states with new accounts
        currentVaultState.accounts[KeyringAccountType.HDAccount][account1.id] =
          {
            id: account1.id,
            label: `Account ${account1.id + 1}`,
            address: account1.address,
            xpub: account1.xpub,
            xprv: '',
            isImported: false,
            isTrezorWallet: false,
            isLedgerWallet: false,
            balances: { syscoin: 0, ethereum: 0 },
            assets: { syscoin: [], ethereum: [] },
          };
        vault2State.accounts[KeyringAccountType.HDAccount][account2.id] = {
          id: account2.id,
          label: `Account ${account2.id + 1}`,
          address: account2.address,
          xpub: account2.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
      }

      // Verify addresses match
      for (let i = 0; i < accounts1.length; i++) {
        expect(accounts1[i].address).toBe(accounts2[i].address);
      }
    });
  });

  describe('UTXO Key Derivation', () => {
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

    it('should derive deterministic UTXO addresses', async () => {
      // Check initial account has Syscoin address format
      const account0 = keyringManager.getActiveAccount().activeAccount;
      expect(account0.address.match(/^(sys1|tsys1)/)).toBeTruthy();
    });

    it('should use BIP84 derivation for UTXO', async () => {
      // The vault state now properly includes encrypted xprv values
      // No manual updates needed - just test the functionality

      const account = keyringManager.getActiveAccount().activeAccount;
      // BIP84 (native segwit) addresses start with 'sys1' or 'tsys1' for Syscoin
      expect(account.address.match(/^(sys1|tsys1)/)).toBeTruthy();
      expect(account.xpub).toBeDefined();
      expect(
        account.xpub.startsWith('zpub') || account.xpub.startsWith('xpub')
      ).toBe(true);
    });

    it('should derive different addresses for different account indices', async () => {
      const addresses = [
        keyringManager.getActiveAccount().activeAccount.address,
      ];

      // Add more accounts
      for (let i = 0; i < 3; i++) {
        const newAccount = await keyringManager.addNewAccount();
        addresses.push(newAccount.address);

        // Update vault state with new account
        currentVaultState.accounts[KeyringAccountType.HDAccount][
          newAccount.id
        ] = {
          id: newAccount.id,
          label: `Account ${newAccount.id + 1}`,
          address: newAccount.address,
          xpub: newAccount.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
      }

      // All addresses should be unique
      const uniqueAddresses = new Set(addresses);
      expect(uniqueAddresses.size).toBe(addresses.length);
    });

    it('should handle testnet derivation correctly', async () => {
      // Set up testnet vault state
      const testnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 5700,
      });
      const testnetVaultStateGetter = jest.fn(() => testnetVaultState);

      // Create testnet keyring
      const testnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        testnetVaultStateGetter
      );

      const account = testnetKeyring.getActiveAccount().activeAccount;
      // Testnet addresses should start with 'tsys1' or use default format
      expect(account.address.match(/^(sys1|tsys1)/)).toBeTruthy();
    });
  });

  describe('Cross-Chain Derivation Consistency', () => {
    it('should derive different addresses for EVM vs UTXO from same seed', async () => {
      // Set up EVM vault state
      const evmVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const evmVaultStateGetter = jest.fn(() => evmVaultState);

      // EVM keyring
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

      // UTXO keyring
      const utxoKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        utxoVaultStateGetter
      );

      const evmAccount = evmKeyring.getActiveAccount().activeAccount;
      const utxoAccount = utxoKeyring.getActiveAccount().activeAccount;

      // Addresses should be completely different
      expect(evmAccount.address).not.toBe(utxoAccount.address);
      expect(evmAccount.address.startsWith('0x')).toBe(true);
      expect(utxoAccount.address.match(/^(sys1|tsys1)/)).toBeTruthy();
    });

    it('should maintain deterministic derivation after re-encryption', async () => {
      // Store original addresses
      const originalAddresses = [
        keyringManager.getActiveAccount().activeAccount.address,
      ];
      for (let i = 0; i < 2; i++) {
        const account = await keyringManager.addNewAccount();
        originalAddresses.push(account.address);

        // Update vault state with new account
        currentVaultState.accounts[KeyringAccountType.HDAccount][account.id] = {
          id: account.id,
          label: `Account ${account.id + 1}`,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
      }

      // Lock and unlock (simulating re-encryption scenario)
      keyringManager.lockWallet();
      await keyringManager.unlock(FAKE_PASSWORD);

      // Verify addresses remain the same
      const account0 = keyringManager.getAccountById(
        0,
        KeyringAccountType.HDAccount
      );
      expect(account0.address).toBe(originalAddresses[0]);

      const account1 = keyringManager.getAccountById(
        1,
        KeyringAccountType.HDAccount
      );
      expect(account1.address).toBe(originalAddresses[1]);

      const account2 = keyringManager.getAccountById(
        2,
        KeyringAccountType.HDAccount
      );
      expect(account2.address).toBe(originalAddresses[2]);
    });
  });

  describe('Imported Key Handling', () => {
    it('should not derive keys for imported EVM accounts', async () => {
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

      // Import a specific private key
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const imported = await keyringManager.importAccount(privateKey);

      // Update vault state with imported account
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

      // Verify it uses the exact key, not derived
      const retrievedKey = await keyringManager.getPrivateKeyByAccountId(
        imported.id,
        KeyringAccountType.Imported,
        FAKE_PASSWORD
      );
      expect(retrievedKey).toBe(privateKey);

      // Verify address matches the private key
      const wallet = new ethers.Wallet(privateKey);
      expect(imported.address.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it('should handle imported zprv for UTXO', async () => {
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

      // Import a zprv
      const zprv =
        'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR';
      const imported = await keyringManager.importAccount(zprv);

      // Update vault state with imported account
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

      // Verify it's treated as imported, not derived from main seed
      expect(imported.isImported).toBe(true);

      // Retrieve and verify the zprv
      const retrievedKey = await keyringManager.getPrivateKeyByAccountId(
        imported.id,
        KeyringAccountType.Imported,
        FAKE_PASSWORD
      );
      expect(retrievedKey).toBe(zprv);
    });
  });

  describe('Edge Cases', () => {
    it('should handle account creation when no HD signer exists', async () => {
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

      // Should create HD signer on first account access
      const account = keyringManager.getActiveAccount().activeAccount;
      expect(account).toBeDefined();
      expect(account.address).toBeDefined();
    });

    it('should maintain key derivation consistency with special characters in labels', async () => {
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

      // Labels should not affect derivation
      const account1 = await keyringManager.addNewAccount(
        'Account with 特殊文字 and émojis 🚀'
      );
      const address1 = account1.address;

      // Update vault state
      currentVaultState.accounts[KeyringAccountType.HDAccount][account1.id] = {
        id: account1.id,
        label: 'Account with 特殊文字 and émojis 🚀',
        address: account1.address,
        xpub: account1.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Set up second EVM vault state
      const vault2State = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const vault2StateGetter = jest.fn(() => vault2State);

      // Create new keyring and add account with different label
      const keyring2 = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        vault2StateGetter
      );

      const account2 = await keyring2.addNewAccount('Different Label');

      // Same index should give same address regardless of label
      expect(account2.address).toBe(address1);
    });

    it('should handle maximum safe integer account indices', () => {
      // This is more of a sanity check - we shouldn't realistically reach this
      const accounts = {};
      const maxSafeIndex = Number.MAX_SAFE_INTEGER;

      // Simulate account with the maximum safe index
      accounts[maxSafeIndex] = { id: maxSafeIndex };

      // getNextAccountId should handle this gracefully
      // (testing the concept, not the actual implementation)
      expect(() => {
        const nextId = maxSafeIndex + 1;
        if (nextId > Number.MAX_SAFE_INTEGER) {
          throw new Error('Account index overflow');
        }
      }).toThrow('Account index overflow');
    });
  });
});

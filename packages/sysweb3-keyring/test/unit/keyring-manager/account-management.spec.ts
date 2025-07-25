import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('KeyringManager - Account Management', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();

    // Set up mock vault state for testing
    currentVaultState = createMockVaultState({
      activeAccountId: 0,
      activeAccountType: KeyringAccountType.HDAccount,
      networkType: INetworkType.Ethereum,
      chainId: 1,
    });

    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);

    // Create mock vault getter that returns the current state
    mockVaultStateGetter = jest.fn(() => currentVaultState);

    // Create keyring manager with vault getter
    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      mockVaultStateGetter
    );
  });

  describe('HD Account Management', () => {
    it('should add new HD accounts with sequential IDs', async () => {
      // Initial account should be 0
      const initialAccount = keyringManager.getActiveAccount().activeAccount;
      expect(initialAccount.id).toBe(0);
      expect(initialAccount.label).toBe('Account 1');

      // Add second account
      const account2 = await keyringManager.addNewAccount();
      expect(account2.id).toBe(1);
      expect(account2.label).toBe('Account 2');
      expect(account2.isImported).toBe(false);

      // Update vault state to include the new account
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Account 2',
        address: account2.address,
        xpub: account2.xpub,
        xprv: account2.xprv,
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Add third account with custom label
      const account3 = await keyringManager.addNewAccount('My Custom Account');
      expect(account3.id).toBe(2);
      expect(account3.label).toBe('My Custom Account');

      // Update vault state for account 3
      currentVaultState.accounts[KeyringAccountType.HDAccount][2] = {
        id: 2,
        label: 'My Custom Account',
        address: account3.address,
        xpub: account3.xpub,
        xprv: account3.xprv,
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };
    });

    it('should switch between HD accounts', async () => {
      // First create the accounts and update vault state
      const account2 = await keyringManager.addNewAccount();
      const account3 = await keyringManager.addNewAccount();

      // Update vault state to include all accounts
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Account 2',
        address: account2.address,
        xpub: account2.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };
      currentVaultState.accounts[KeyringAccountType.HDAccount][2] = {
        id: 2,
        label: 'Account 3',
        address: account3.address,
        xpub: account3.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Switch to account 1 (only update vault state - no setActiveAccount needed)
      currentVaultState.activeAccount = {
        id: 1,
        type: KeyringAccountType.HDAccount,
      };
      let active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(1);
      expect(active.activeAccountType).toBe(KeyringAccountType.HDAccount);

      // Switch to account 2 (only update vault state)
      currentVaultState.activeAccount = {
        id: 2,
        type: KeyringAccountType.HDAccount,
      };
      active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(2);

      // Switch back to account 0 (only update vault state)
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.HDAccount,
      };
      active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(0);
    });

    it('should get account by ID', async () => {
      // Add account and update vault state
      const newAccount = await keyringManager.addNewAccount('Test Account');
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Test Account',
        address: newAccount.address,
        xpub: newAccount.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const account0 = keyringManager.getAccountById(
        0,
        KeyringAccountType.HDAccount
      );
      expect(account0.id).toBe(0);
      expect(account0.label).toBe('Account 1');

      const account1 = keyringManager.getAccountById(
        1,
        KeyringAccountType.HDAccount
      );
      expect(account1.id).toBe(1);
      expect(account1.label).toBe('Test Account');
    });

    it('should throw when getting non-existent account', () => {
      expect(() =>
        keyringManager.getAccountById(999, KeyringAccountType.HDAccount)
      ).toThrow('Account not found');
    });

    it('should generate correct network-specific addresses when switching between different slip44 networks', async () => {
      // This test verifies the fix for the bug where cached accounts
      // retained stale addresses from previous networks

      // Step 1: Create keyring for Syscoin mainnet (slip44=57)
      const mainnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57, // Syscoin mainnet
      });
      const mainnetVaultStateGetter = jest.fn(() => mainnetVaultState);

      const mainnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mainnetVaultStateGetter
      );

      // Get mainnet account with sys1... address
      const mainnetAccount = mainnetKeyring.getActiveAccount().activeAccount;
      expect(mainnetAccount.address.startsWith('sys1')).toBe(true);

      // Step 2: Simulate caching this account in vault state
      // This represents what happens when we cache vault state
      mainnetVaultState.accounts[KeyringAccountType.HDAccount][0] = {
        ...mainnetAccount,
        address: mainnetAccount.address, // This will be sys1... address
        xpub: mainnetAccount.xpub,
        balances: { syscoin: 10, ethereum: 0 }, // Some mainnet balance
      } as any;

      // Step 3: Create keyring for Syscoin testnet (slip44=1) with SAME vault state
      // This simulates loading cached vault state that has stale mainnet addresses
      const testnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 5700, // Syscoin testnet
      });

      // CRITICAL: Inject the stale mainnet account into testnet vault state
      // This represents the bug scenario where cached vault has wrong addresses
      testnetVaultState.accounts[KeyringAccountType.HDAccount][0] = {
        ...mainnetVaultState.accounts[KeyringAccountType.HDAccount][0],
        // This account still has sys1... address but we're now on testnet
      };

      const testnetVaultStateGetter = jest.fn(() => testnetVaultState);

      const testnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        testnetVaultStateGetter
      );

      // Step 4: Create/load account on testnet - this should generate fresh tsys1... address
      // With the bug: would reuse cached sys1... address
      // With the fix: should derive fresh tsys1... address
      const testnetAccount = await testnetKeyring.createFirstAccount(
        'Test Account'
      );

      // Step 5: Verify addresses are network-specific
      expect(mainnetAccount.address.startsWith('sys1')).toBe(true);
      expect(testnetAccount.address.startsWith('tsys1')).toBe(true);

      // Step 6: Addresses should be different (different networks)
      expect(mainnetAccount.address).not.toBe(testnetAccount.address);

      // Step 7: xpub formats should also be different
      expect(mainnetAccount.xpub.startsWith('zpub')).toBe(true); // Mainnet format
      expect(testnetAccount.xpub.startsWith('vpub')).toBe(true); // Testnet format

      // Step 8: Verify testnet account has fresh balance, not cached mainnet balance
      expect(testnetAccount.balances.syscoin).toBe(0); // Fresh account
      expect(testnetAccount.balances.ethereum).toBe(0);
    });

    it('should handle address generation consistently across multiple account operations', async () => {
      // Test that all account operations use fresh derived addresses

      const testnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 5700,
      });

      // Inject stale mainnet address to simulate the bug condition
      testnetVaultState.accounts[KeyringAccountType.HDAccount][0] = {
        id: 0,
        label: 'Account 1',
        address: 'sys1qbuggyaddressfromcachedmainnetstate', // Wrong network address
        xpub: 'zpub6rSLPXDUvvuy5VEPMUTkiTYfpr7vYACJKsySDMgng1rwEU', // Wrong format
        xprv: 'encrypted_xprv',
        balances: { syscoin: 5, ethereum: 0 }, // Stale balance
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
      } as any;

      const vaultStateGetter = jest.fn(() => testnetVaultState);

      const keyringManager = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        vaultStateGetter
      );

      // All these operations should use correctly derived testnet addresses
      const firstAccount = await keyringManager.createFirstAccount();

      // Update the vault state to reflect the correctly generated first account
      // This simulates what would happen in real usage where the vault state gets updated
      testnetVaultState.accounts[KeyringAccountType.HDAccount][0] = {
        id: 0,
        label: 'Account 1',
        address: firstAccount.address, // Now has correct tsys1... address
        xpub: firstAccount.xpub,
        xprv: 'encrypted_xprv',
        balances: { syscoin: 0, ethereum: 0 },
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
      } as any;

      const newAccount = await keyringManager.addNewAccount('Account 2');
      const activeAccount = keyringManager.getActiveAccount().activeAccount;

      // All should have correct testnet addresses
      expect(firstAccount.address.startsWith('tsys1')).toBe(true);
      expect(newAccount.address.startsWith('tsys1')).toBe(true);
      expect(activeAccount.address.startsWith('tsys1')).toBe(true);

      // Should not have the buggy cached address
      expect(firstAccount.address).not.toBe(
        'sys1qbuggyaddressfromcachedmainnetstate'
      );
      expect(activeAccount.address).not.toBe(
        'sys1qbuggyaddressfromcachedmainnetstate'
      );
    });
  });

  describe('Imported Account Management', () => {
    describe('EVM Import', () => {
      it('should import account from private key', async () => {
        const privateKey =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
        const expectedAddress = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

        const imported = await keyringManager.importAccount(privateKey);

        // Update vault state to reflect import
        currentVaultState.accounts[KeyringAccountType.Imported][0] = {
          id: 0,
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

        expect(imported.isImported).toBe(true);
        expect(imported.address.toLowerCase()).toBe(
          expectedAddress.toLowerCase()
        );
        expect(imported.id).toBe(0);
        expect(imported.label).toBe('Imported 1');
      });

      it('should import account with custom label', async () => {
        const privateKey =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
        const imported = await keyringManager.importAccount(
          privateKey,
          'My Hardware Wallet'
        );
        expect(imported.label).toBe('My Hardware Wallet');
      });

      it('should handle multiple imported accounts', async () => {
        const privateKey1 =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
        const privateKey2 =
          '0x1234567890123456789012345678901234567890123456789012345678901234';

        const imported1 = await keyringManager.importAccount(privateKey1);

        // Update vault state for first import
        currentVaultState.accounts[KeyringAccountType.Imported][0] = {
          id: 0,
          label: 'Imported 1',
          address: imported1.address,
          xpub: imported1.xpub,
          xprv: imported1.xprv,
          isImported: true,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

        const imported2 = await keyringManager.importAccount(privateKey2);

        // Update vault state for second import
        currentVaultState.accounts[KeyringAccountType.Imported][1] = {
          id: 1,
          label: 'Imported 2',
          address: imported2.address,
          xpub: imported2.xpub,
          xprv: imported2.xprv,
          isImported: true,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

        expect(imported1.id).toBe(0);
        expect(imported2.id).toBe(1);
        expect(imported2.label).toBe('Imported 2');
      });

      it('should get private key for imported account', async () => {
        const privateKey =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
        const imported = await keyringManager.importAccount(privateKey);

        // Update vault state
        currentVaultState.accounts[KeyringAccountType.Imported][imported.id] = {
          id: imported.id,
          label: imported.label,
          address: imported.address,
          xpub: imported.xpub,
          xprv: imported.xprv,
          isImported: true,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

        const retrievedKey = await keyringManager.getPrivateKeyByAccountId(
          imported.id,
          KeyringAccountType.Imported,
          FAKE_PASSWORD
        );

        expect(retrievedKey).toBe(privateKey);
      });

      it('should reject private key retrieval with wrong password', async () => {
        const privateKey =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
        const imported = await keyringManager.importAccount(privateKey);

        // Update vault state
        currentVaultState.accounts[KeyringAccountType.Imported][imported.id] = {
          id: imported.id,
          label: imported.label,
          address: imported.address,
          xpub: imported.xpub,
          xprv: imported.xprv,
          isImported: true,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

        await expect(
          keyringManager.getPrivateKeyByAccountId(
            imported.id,
            KeyringAccountType.Imported,
            'wrong_password'
          )
        ).rejects.toThrow('Invalid password');
      });
    });

    describe('UTXO Import', () => {
      beforeEach(() => {
        // Set up UTXO network state
        currentVaultState = createMockVaultState({
          activeAccountId: 0,
          activeAccountType: KeyringAccountType.HDAccount,
          networkType: INetworkType.Syscoin,
          chainId: 57,
        });
        mockVaultStateGetter.mockReturnValue(currentVaultState);
      });

      it('should import UTXO account from mainnet zprv', async () => {
        const mainnetZprv =
          'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR';
        const imported = await keyringManager.importAccount(mainnetZprv);

        expect(imported.isImported).toBe(true);
        expect(imported.address.startsWith('sys1')).toBe(true);
        expect(imported.id).toBe(0);
        expect(imported.label).toBe('Syscoin Mainnet Imported 1');
      });

      it('should validate zprv before import', async () => {
        const invalidZprv = 'invalid_zprv_string';
        await expect(
          keyringManager.importAccount(invalidZprv)
        ).rejects.toThrow();
      });

      it('should switch between HD and imported UTXO accounts', async () => {
        const mainnetZprv =
          'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR';
        const imported = await keyringManager.importAccount(mainnetZprv);

        // Update vault state with imported account
        currentVaultState.accounts[KeyringAccountType.Imported][imported.id] = {
          id: imported.id,
          label: imported.label,
          address: imported.address,
          xpub: imported.xpub,
          xprv: imported.xprv,
          isImported: true,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

        // Switch to imported account (only update vault state)
        currentVaultState.activeAccount = {
          id: imported.id,
          type: KeyringAccountType.Imported,
        };
        let active = keyringManager.getActiveAccount();
        expect(active.activeAccount.id).toBe(imported.id);
        expect(active.activeAccountType).toBe(KeyringAccountType.Imported);
        expect(active.activeAccount.address).toBe(imported.address);

        // Switch back to HD account (only update vault state)
        currentVaultState.activeAccount = {
          id: 0,
          type: KeyringAccountType.HDAccount,
        };
        active = keyringManager.getActiveAccount();
        expect(active.activeAccount.id).toBe(0);
        expect(active.activeAccountType).toBe(KeyringAccountType.HDAccount);
      });
    });
  });

  describe('Mixed Account Types', () => {
    it('should handle switching between different account types', async () => {
      // Add HD accounts
      const hdAccount2 = await keyringManager.addNewAccount('HD Account 2');

      // Import account
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const imported = await keyringManager.importAccount(
        privateKey,
        'Imported Account'
      );

      // Update vault state with all accounts
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'HD Account 2',
        address: hdAccount2.address,
        xpub: hdAccount2.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };
      currentVaultState.accounts[KeyringAccountType.Imported][imported.id] = {
        id: imported.id,
        label: 'Imported Account',
        address: imported.address,
        xpub: imported.xpub,
        xprv: imported.xprv,
        isImported: true,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Test switching between all accounts
      const switches = [
        { id: 0, type: KeyringAccountType.HDAccount, label: 'Account 1' },
        { id: 1, type: KeyringAccountType.HDAccount, label: 'HD Account 2' },
        {
          id: imported.id,
          type: KeyringAccountType.Imported,
          label: 'Imported Account',
        },
      ];

      for (const { id, type, label } of switches) {
        currentVaultState.activeAccount = { id, type };
        const active = keyringManager.getActiveAccount();
        expect(active.activeAccount.id).toBe(id);
        expect(active.activeAccountType).toBe(type);
        expect(active.activeAccount.label).toBe(label);
      }
    });

    it('should maintain separate ID sequences for each account type', async () => {
      // Add HD accounts
      const hd1 = await keyringManager.addNewAccount();

      // Update vault state to include hd1 so hd2 gets the right ID
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Account 2',
        address: hd1.address,
        xpub: hd1.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const hd2 = await keyringManager.addNewAccount();

      // Import accounts
      const imported1 = await keyringManager.importAccount(
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
      );

      // Update vault state to include imported1 so imported2 gets the right ID
      currentVaultState.accounts[KeyringAccountType.Imported][0] = {
        id: 0,
        label: 'Imported 1',
        address: imported1.address,
        xpub: imported1.xpub,
        xprv: imported1.xprv,
        isImported: true,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const imported2 = await keyringManager.importAccount(
        '0x1234567890123456789012345678901234567890123456789012345678901234'
      );

      // HD accounts should have sequential IDs starting from 0
      expect(hd1.id).toBe(1);
      expect(hd2.id).toBe(2);

      // Imported accounts should have their own ID sequence starting from 0
      expect(imported1.id).toBe(0);
      expect(imported2.id).toBe(1);
    });
  });

  describe('Account State Management', () => {
    it('should preserve account state across lock/unlock', async () => {
      // Add accounts
      const hdAccount = await keyringManager.addNewAccount('Test Account');
      const imported = await keyringManager.importAccount(
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
        'Imported Test'
      );

      // Update vault state
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Test Account',
        address: hdAccount.address,
        xpub: hdAccount.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };
      currentVaultState.accounts[KeyringAccountType.Imported][imported.id] = {
        id: imported.id,
        label: 'Imported Test',
        address: imported.address,
        xpub: imported.xpub,
        xprv: imported.xprv,
        isImported: true,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Switch to imported account (only update vault state)
      currentVaultState.activeAccount = {
        id: imported.id,
        type: KeyringAccountType.Imported,
      };

      // Lock and unlock
      keyringManager.lockWallet();
      await keyringManager.unlock(FAKE_PASSWORD);

      // Active account should still be the imported one
      const active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(imported.id);
      expect(active.activeAccountType).toBe(KeyringAccountType.Imported);
      expect(active.activeAccount.label).toBe('Imported Test');
    });

    it('should get account xpub', async () => {
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      expect(typeof xpub).toBe('string');
    });

    it('should not expose private key in account data', async () => {
      const account = keyringManager.getActiveAccount().activeAccount;
      expect(account).not.toHaveProperty('xprv');
      expect(account).toHaveProperty('xpub');
    });
  });

  describe('Edge Cases', () => {
    it('should handle invalid account type when getting account', async () => {
      expect(() =>
        keyringManager.getAccountById(0, 'INVALID_TYPE' as any)
      ).toThrow();
    });

    it('should handle getting non-existent account', async () => {
      expect(() =>
        keyringManager.getAccountById(999, KeyringAccountType.HDAccount)
      ).toThrow('Account not found');
    });

    it('should reject import of invalid private key', async () => {
      await expect(
        keyringManager.importAccount('not_a_valid_key')
      ).rejects.toThrow();
    });

    it('should handle getNextAccountId with empty accounts', () => {
      // This is a private method, but we can test it indirectly
      // by checking that first account gets ID 0
      const account = keyringManager.getActiveAccount().activeAccount;
      expect(account.id).toBe(0);
    });

    it('should fill gaps in account IDs when accounts are removed', async () => {
      // Create multiple accounts to simulate a scenario where some are removed
      const account1 = await keyringManager.addNewAccount('Account 1');
      expect(account1.id).toBe(1);

      // Update vault state to include account1
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Account 1',
        address: account1.address,
        xpub: account1.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const account2 = await keyringManager.addNewAccount('Account 2');
      expect(account2.id).toBe(2);

      // Update vault state to include account2
      currentVaultState.accounts[KeyringAccountType.HDAccount][2] = {
        id: 2,
        label: 'Account 2',
        address: account2.address,
        xpub: account2.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const account3 = await keyringManager.addNewAccount('Account 3');
      expect(account3.id).toBe(3);

      // Update vault state to include account3
      currentVaultState.accounts[KeyringAccountType.HDAccount][3] = {
        id: 3,
        label: 'Account 3',
        address: account3.address,
        xpub: account3.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Simulate account deletion by removing account with ID 1 from vault state
      // (In real usage, this would be done by the removeAccount controller method)
      delete currentVaultState.accounts[KeyringAccountType.HDAccount][1];

      // Now when we create a new account, it should fill the gap at ID 1
      const newAccount = await keyringManager.addNewAccount('New Account');
      expect(newAccount.id).toBe(1); // Should reuse the deleted account's ID

      // Update vault state to include the new account
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'New Account',
        address: newAccount.address,
        xpub: newAccount.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // At this point we have accounts: [0, 1, 2, 3] - no gaps
      // Next account should get the next sequential ID
      const anotherAccount = await keyringManager.addNewAccount(
        'Another Account'
      );
      expect(anotherAccount.id).toBe(4); // Should continue sequence after 3

      // Update vault state to include anotherAccount
      currentVaultState.accounts[KeyringAccountType.HDAccount][4] = {
        id: 4,
        label: 'Another Account',
        address: anotherAccount.address,
        xpub: anotherAccount.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Simulate removing the middle account (ID 2)
      delete currentVaultState.accounts[KeyringAccountType.HDAccount][2];

      // Now we have accounts: [0, 1, 3, 4] - gap at ID 2
      // Next account should fill that gap
      const gapFillerAccount = await keyringManager.addNewAccount('Gap Filler');
      expect(gapFillerAccount.id).toBe(2); // Should reuse ID 2
    });
  });

  describe('Account Label Consistency', () => {
    it('should create EVM accounts with generic labels regardless of network', async () => {
      // Test that EVM accounts always get generic "Account N" labels
      // regardless of which specific EVM network they're created on

      // Set up NEVM Testnet vault state
      const nevmTestnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 5700, // Syscoin NEVM Testnet
      });
      const nevmTestnetVaultGetter = jest.fn(() => nevmTestnetVaultState);

      // Create keyring on NEVM Testnet
      const nevmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        nevmTestnetVaultGetter
      );

      // Create accounts on NEVM Testnet
      const account1 = nevmKeyring.getActiveAccount().activeAccount;
      const account2 = await nevmKeyring.addNewAccount();

      // Update vault state to include account2 BEFORE creating account3
      nevmTestnetVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: account2.label,
        address: account2.address,
        xpub: account2.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const account3 = await nevmKeyring.addNewAccount();

      // Update vault state to include account3
      nevmTestnetVaultState.accounts[KeyringAccountType.HDAccount][2] = {
        id: 2,
        label: account3.label,
        address: account3.address,
        xpub: account3.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // BUG TEST: EVM accounts should have generic labels, not network-specific ones
      expect(account1.label).toBe('Account 1'); // Should be generic
      expect(account2.label).toBe('Account 2'); // Should be generic
      expect(account3.label).toBe('Account 3'); // Should be generic

      // These should NOT happen (network-specific labels for EVM accounts)
      expect(account1.label).not.toContain('NEVM');
      expect(account1.label).not.toContain('Testnet');
      expect(account2.label).not.toContain('NEVM');
      expect(account2.label).not.toContain('Testnet');
      expect(account3.label).not.toContain('NEVM');
      expect(account3.label).not.toContain('Testnet');

      // Verify accounts work across EVM networks (same slip44=60)
      expect(account1.address.startsWith('0x')).toBe(true);
      expect(account2.address.startsWith('0x')).toBe(true);
      expect(account3.address.startsWith('0x')).toBe(true);
    });

    it('should create UTXO accounts with network-specific labels', async () => {
      // Test the keyring manager's actual label generation logic

      // Set up empty Syscoin Testnet vault state (no pre-existing accounts)
      const sysTestnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 5700, // Syscoin UTXO Testnet
      });

      // Clear pre-existing accounts to let keyring manager create them
      sysTestnetVaultState.accounts[KeyringAccountType.HDAccount] = {};

      const sysTestnetVaultGetter = jest.fn(() => sysTestnetVaultState);

      // Create keyring - this should call createFirstAccount internally
      const sysKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        sysTestnetVaultGetter
      );

      // The first account should be created by keyring manager's createFirstAccount method
      const firstAccount = await sysKeyring.createFirstAccount();

      // Add to vault state so addNewAccount can find existing accounts for ID calculation
      sysTestnetVaultState.accounts[KeyringAccountType.HDAccount][0] = {
        id: 0,
        label: firstAccount.label,
        address: firstAccount.address,
        xpub: firstAccount.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Create second account using addNewAccount
      const secondAccount = await sysKeyring.addNewAccount();

      // Test that the keyring manager generates network-specific labels for UTXO accounts
      expect(firstAccount.label).toContain('SYS'); // Should be "SYS-T 1" for testnet
      expect(secondAccount.label).toContain('SYS'); // Should be "SYS-T 2" for testnet

      // Verify accounts are UTXO format
      expect(firstAccount.address.startsWith('tsys1')).toBe(true); // Testnet format
      expect(secondAccount.address.startsWith('tsys1')).toBe(true); // Testnet format
    });
  });
});

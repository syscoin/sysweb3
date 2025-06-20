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

      // Switch to account 1
      currentVaultState.activeAccount = {
        id: 1,
        type: KeyringAccountType.HDAccount,
      };
      await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
      let active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(1);
      expect(active.activeAccountType).toBe(KeyringAccountType.HDAccount);

      // Switch to account 2
      currentVaultState.activeAccount = {
        id: 2,
        type: KeyringAccountType.HDAccount,
      };
      await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
      active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(2);

      // Switch back to account 0
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.HDAccount,
      };
      await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
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
        expect(imported.label).toBe('Imported 1');
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

        // Switch to imported account
        currentVaultState.activeAccount = {
          id: imported.id,
          type: KeyringAccountType.Imported,
        };
        await keyringManager.setActiveAccount(
          imported.id,
          KeyringAccountType.Imported
        );
        let active = keyringManager.getActiveAccount();
        expect(active.activeAccount.id).toBe(imported.id);
        expect(active.activeAccountType).toBe(KeyringAccountType.Imported);
        expect(active.activeAccount.address).toBe(imported.address);

        // Switch back to HD account
        currentVaultState.activeAccount = {
          id: 0,
          type: KeyringAccountType.HDAccount,
        };
        await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
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
        await keyringManager.setActiveAccount(id, type);
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

      // Switch to imported account
      currentVaultState.activeAccount = {
        id: imported.id,
        type: KeyringAccountType.Imported,
      };
      await keyringManager.setActiveAccount(
        imported.id,
        KeyringAccountType.Imported
      );

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
    it('should handle invalid account type when switching', async () => {
      await expect(
        keyringManager.setActiveAccount(0, 'INVALID_TYPE' as any)
      ).rejects.toThrow();
    });

    it('should handle switching to non-existent account', async () => {
      await expect(
        keyringManager.setActiveAccount(999, KeyringAccountType.HDAccount)
      ).rejects.toThrow('Account not found');
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
  });
});

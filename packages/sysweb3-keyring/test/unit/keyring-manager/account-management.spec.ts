import {
  KeyringManager,
  initialWalletState,
  KeyringAccountType,
} from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('KeyringManager - Account Management', () => {
  let keyringManager: KeyringManager;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);
  });

  describe('HD Account Management', () => {
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

      // Add third account with custom label
      const account3 = await keyringManager.addNewAccount('My Custom Account');
      expect(account3.id).toBe(2);
      expect(account3.label).toBe('My Custom Account');
    });

    it('should switch between HD accounts', async () => {
      // Add multiple accounts
      await keyringManager.addNewAccount();
      await keyringManager.addNewAccount();

      // Switch to account 1
      await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);
      let active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(1);
      expect(active.activeAccountType).toBe(KeyringAccountType.HDAccount);

      // Switch to account 2
      await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);
      active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(2);

      // Switch back to account 0
      await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
      active = keyringManager.getActiveAccount();
      expect(active.activeAccount.id).toBe(0);
    });

    it('should get account by ID', async () => {
      await keyringManager.addNewAccount('Test Account');

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

    it('should update account label', () => {
      keyringManager.updateAccountLabel(
        'New Label',
        0,
        KeyringAccountType.HDAccount
      );

      const account = keyringManager.getAccountById(
        0,
        KeyringAccountType.HDAccount
      );
      expect(account.label).toBe('New Label');
    });
  });

  describe('Imported Account Management', () => {
    describe('EVM Import', () => {
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

      it('should import account from private key', async () => {
        const privateKey =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
        const expectedAddress = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

        const imported = await keyringManager.importAccount(privateKey);

        expect(imported.isImported).toBe(true);
        expect(imported.address.toLowerCase()).toBe(
          expectedAddress.toLowerCase()
        );
        expect(imported.id).toBe(0); // First imported account
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

      it('should reject duplicate import', async () => {
        const privateKey =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

        await keyringManager.importAccount(privateKey);

        await expect(keyringManager.importAccount(privateKey)).rejects.toThrow(
          'Account already exists'
        );
      });

      it('should handle multiple imported accounts', async () => {
        const privateKey1 =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
        const privateKey2 =
          '0x1234567890123456789012345678901234567890123456789012345678901234';

        const imported1 = await keyringManager.importAccount(privateKey1);
        const imported2 = await keyringManager.importAccount(privateKey2);

        expect(imported1.id).toBe(0);
        expect(imported2.id).toBe(1);
        expect(imported2.label).toBe('Imported 2');
      });

      it('should get private key for imported account', async () => {
        const privateKey =
          '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
        const imported = await keyringManager.importAccount(privateKey);

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

        // Import account
        const imported = await keyringManager.importAccount(mainnetZprv);

        // Switch to imported account
        await keyringManager.setActiveAccount(
          imported.id,
          KeyringAccountType.Imported
        );
        let active = keyringManager.getActiveAccount();
        expect(active.activeAccount.id).toBe(imported.id);
        expect(active.activeAccountType).toBe(KeyringAccountType.Imported);
        expect(active.activeAccount.address).toBe(imported.address);

        // Switch back to HD account
        await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
        active = keyringManager.getActiveAccount();
        expect(active.activeAccount.id).toBe(0);
        expect(active.activeAccountType).toBe(KeyringAccountType.HDAccount);
      });
    });
  });

  describe('Mixed Account Types', () => {
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

    it('should handle switching between different account types', async () => {
      // Add HD accounts
      await keyringManager.addNewAccount('HD Account 2');

      // Import account
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const imported = await keyringManager.importAccount(
        privateKey,
        'Imported Account'
      );

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
      const hd2 = await keyringManager.addNewAccount();

      // Import accounts
      const imported1 = await keyringManager.importAccount(
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
      );
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

    it('should preserve account state across lock/unlock', async () => {
      // Add accounts
      await keyringManager.addNewAccount('Test Account');
      const imported = await keyringManager.importAccount(
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
        'Imported Test'
      );

      // Switch to imported account
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

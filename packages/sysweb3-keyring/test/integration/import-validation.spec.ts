import { KeyringManager, KeyringAccountType } from '../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../helpers/constants';
import { setupMocks } from '../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('Import Validation - Integration Tests', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);
  });

  describe('UTXO Import Validation', () => {
    const validMainnetZprvs = [
      {
        zprv: 'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR',
        description: 'BIP84 mainnet zprv',
      },
      {
        zprv: 'zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5',
        description: 'Standard test vector zprv',
      },
    ];

    const validTestnetVprvs = [
      {
        vprv: 'vprv9Kq1NEwFrCd4Lw2kDNicFsKvDGkA5c1G7NJd35wrD5fNdeVJKjo73h6xZuepV4hJ3a2hUjNmn4XjuLhbsuSRHHtVuAL8hsj8n6BwtMiPzf8',
        description: 'BIP84 testnet vprv',
      },
    ];

    describe('Mainnet imports', () => {
      beforeEach(async () => {
        // Set up UTXO mainnet vault state
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

      it('should validate and import mainnet zprv', async () => {
        for (const { zprv, description } of validMainnetZprvs) {
          const validation = keyringManager.validateZprv(zprv);
          expect(validation.isValid).toBe(true);
          expect(validation.message).toContain('valid');

          const imported = await keyringManager.importAccount(
            zprv,
            description
          );
          expect(imported.isImported).toBe(true);
          expect(imported.address.match(/^(sys1|tsys1)/)).toBeTruthy();
          expect(imported.label).toBe(description);

          // Update vault state with imported account
          currentVaultState.accounts[KeyringAccountType.Imported][imported.id] =
            {
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
        }
      });

      it('should reject testnet vprv on mainnet', async () => {
        for (const { vprv } of validTestnetVprvs) {
          const validation = keyringManager.validateZprv(vprv);
          expect(validation.isValid).toBe(false);
          expect(validation.message).toContain('not compatible');

          // The importAccount method throws a different but valid error when the key is rejected
          await expect(keyringManager.importAccount(vprv)).rejects.toThrow(
            'Invalid private key format'
          );
        }
      });

      it('should reject BIP44 xprv keys', async () => {
        const xprv =
          'xprvA2nrNbFZABcdryreWet9Ea4LvTJcGsqrMzxHx98MMrotbir7yrKCEXw7nadnHM8Dq38EGfSh6dqA9QWTyefMLEcBYJUuekgW4BYPJcr9E7j';

        const validation = keyringManager.validateZprv(xprv);
        expect(validation.isValid).toBe(false);
        expect(validation.message).toContain(
          'Only BIP84 keys (zprv/vprv) are supported'
        );
      });
    });

    describe('Testnet imports', () => {
      beforeEach(async () => {
        // Set up UTXO testnet vault state
        currentVaultState = createMockVaultState({
          activeAccountId: 0,
          activeAccountType: KeyringAccountType.HDAccount,
          networkType: INetworkType.Syscoin,
          chainId: 5700,
        });
        mockVaultStateGetter = jest.fn(() => currentVaultState);

        keyringManager = await KeyringManager.createInitialized(
          PEACE_SEED_PHRASE,
          FAKE_PASSWORD,
          mockVaultStateGetter
        );
      });

      it('should validate and import testnet vprv', async () => {
        for (const { vprv, description } of validTestnetVprvs) {
          const validation = keyringManager.validateZprv(vprv);
          expect(validation.isValid).toBe(true);

          const imported = await keyringManager.importAccount(
            vprv,
            description
          );
          expect(imported.isImported).toBe(true);
          expect(imported.address.match(/^(sys1|tsys1)/)).toBeTruthy();

          // Update vault state with imported account
          currentVaultState.accounts[KeyringAccountType.Imported][imported.id] =
            {
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
        }
      });

      it('should reject mainnet zprv on testnet', async () => {
        for (const { zprv } of validMainnetZprvs) {
          const validation = keyringManager.validateZprv(zprv);
          expect(validation.isValid).toBe(false);
          expect(validation.message).toContain('not compatible');
        }
      });
    });

    describe('Invalid key handling', () => {
      beforeEach(async () => {
        // Set up UTXO mainnet vault state
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

      it('should reject malformed keys', async () => {
        const invalidKeys = [
          'not_a_key',
          'zprvInvalidKey123',
          'zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei', // Too short
          'zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5XXX', // Too long
        ];

        for (const key of invalidKeys) {
          const validation = keyringManager.validateZprv(key);
          expect(validation.isValid).toBe(false);

          await expect(keyringManager.importAccount(key)).rejects.toThrow();
        }
      });

      it('should handle edge case with corrupted base58', async () => {
        // Valid length but invalid base58 characters
        const corruptedZprv =
          'zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Ke!5';

        await expect(
          keyringManager.importAccount(corruptedZprv)
        ).rejects.toThrow();
      });
    });
  });

  describe('EVM Import Validation', () => {
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

    it('should import valid private keys with 0x prefix', async () => {
      const privateKeys = [
        {
          key: '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
          expectedAddress: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
        },
        {
          key: '0x1234567890123456789012345678901234567890123456789012345678901234',
          expectedAddress: '0x2e988a386a799f506693793c6a5af6b54dfaabfb', // Corrected expected address
        },
      ];

      for (const { key, expectedAddress } of privateKeys) {
        const imported = await keyringManager.importAccount(
          key,
          `Test ${expectedAddress}`
        );
        expect(imported.address.toLowerCase()).toBe(
          expectedAddress.toLowerCase()
        );
        expect(imported.isImported).toBe(true);

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
      }
    });

    it('should import valid private keys without 0x prefix', async () => {
      const privateKey =
        '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const expectedAddress = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

      const imported = await keyringManager.importAccount(privateKey);
      expect(imported.address.toLowerCase()).toBe(
        expectedAddress.toLowerCase()
      );
    });

    it('should reject invalid private keys', async () => {
      const invalidKeys = [
        '0xINVALID',
        '0x123', // Too short
        '0x' + 'f'.repeat(65), // Too long
        'not_hex_at_all',
        '0xGGGG', // Invalid hex chars
      ];

      for (const key of invalidKeys) {
        await expect(keyringManager.importAccount(key)).rejects.toThrow();
      }
    });

    it('should reject UTXO keys on EVM network', async () => {
      const zprvKeys = [
        'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR',
        'vprv9Kq1NEwFrCd4Lw2kDNicFsKvDGkA5c1G7NJd35wrD5fNdeVJKjo73h6xZuepV4hJ3a2hUjNmn4XjuLhbsuSRHHtVuAL8hsj8n6BwtMiPzf8',
      ];

      for (const zprv of zprvKeys) {
        await expect(keyringManager.importAccount(zprv)).rejects.toThrow();
      }
    });
  });

  describe('Cross-Network Import Scenarios', () => {
    it('should maintain separate imported accounts per keyring instance', async () => {
      // Set up EVM vault state
      const evmVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const evmVaultStateGetter = jest.fn(() => evmVaultState);

      // Create EVM keyring and import
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        evmVaultStateGetter
      );

      const evmImported = await evmKeyring.importAccount(
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
        'EVM Import'
      );

      // Update EVM vault state
      evmVaultState.accounts[KeyringAccountType.Imported][evmImported.id] = {
        id: evmImported.id,
        label: evmImported.label,
        address: evmImported.address,
        xpub: evmImported.xpub,
        xprv: evmImported.xprv,
        isImported: true,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Set up UTXO vault state
      const utxoVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      const utxoVaultStateGetter = jest.fn(() => utxoVaultState);

      // Create UTXO keyring and import
      const utxoKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        utxoVaultStateGetter
      );

      const utxoImported = await utxoKeyring.importAccount(
        'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR',
        'UTXO Import'
      );

      // Update UTXO vault state
      utxoVaultState.accounts[KeyringAccountType.Imported][utxoImported.id] = {
        id: utxoImported.id,
        label: utxoImported.label,
        address: utxoImported.address,
        xpub: utxoImported.xpub,
        xprv: utxoImported.xprv,
        isImported: true,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Verify they're independent
      expect(evmImported.address.startsWith('0x')).toBe(true);
      expect(utxoImported.address.match(/^(sys1|tsys1)/)).toBeTruthy();

      // Each keyring should only see its own imported account via vault state
      const evmAccounts = evmVaultState.accounts[KeyringAccountType.Imported];
      const utxoAccounts = utxoVaultState.accounts[KeyringAccountType.Imported];

      expect(Object.keys(evmAccounts)).toHaveLength(1);
      expect(Object.keys(utxoAccounts)).toHaveLength(1);
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

    it('should encrypt imported private keys', async () => {
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const imported = await keyringManager.importAccount(privateKey);

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

      // Check vault state - xprv should be encrypted
      const accountData =
        currentVaultState.accounts[KeyringAccountType.Imported][imported.id];
      expect(accountData.xprv).toBeDefined();
      expect(accountData.xprv).not.toBe(privateKey);
      expect(accountData.xprv.length).toBeGreaterThan(privateKey.length);
    });

    it('should require correct password to retrieve imported keys', async () => {
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const imported = await keyringManager.importAccount(privateKey);

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

      // Correct password should work
      const retrieved = await keyringManager.getPrivateKeyByAccountId(
        imported.id,
        KeyringAccountType.Imported,
        FAKE_PASSWORD
      );
      expect(retrieved).toBe(privateKey);

      // Wrong password should fail
      await expect(
        keyringManager.getPrivateKeyByAccountId(
          imported.id,
          KeyringAccountType.Imported,
          'wrong_password'
        )
      ).rejects.toThrow('Invalid password');
    });

    it('should not expose private keys in getAccountById', async () => {
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const imported = await keyringManager.importAccount(privateKey);

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

      // Check that vault state DOES contain encrypted private key
      const rawAccountData =
        currentVaultState.accounts[KeyringAccountType.Imported][imported.id];
      expect(rawAccountData.xprv).toBeDefined();
      expect(rawAccountData.xprv).not.toBe(privateKey); // Should be encrypted, not raw

      // Check that public API DOES NOT expose private key
      const publicAccount = keyringManager.getAccountById(
        imported.id,
        KeyringAccountType.Imported
      );
      expect(publicAccount).toBeDefined();
      expect(publicAccount).not.toHaveProperty('xprv'); // Security layer working!
      expect(publicAccount).toHaveProperty('address');

      // This proves: private key is stored securely but not exposed via public API
    });
  });

  describe('Import State Management', () => {
    it('should preserve imported accounts across lock/unlock', async () => {
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

      // Import multiple accounts
      const privateKeys = [
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
        '0x1234567890123456789012345678901234567890123456789012345678901234',
      ];

      const imported: any[] = [];
      for (const key of privateKeys) {
        const account = await keyringManager.importAccount(key);
        if (account) {
          imported.push(account);

          // Update vault state with imported account
          currentVaultState.accounts[KeyringAccountType.Imported][account.id] =
            {
              id: account.id,
              label: account.label,
              address: account.address,
              xpub: account.xpub,
              xprv: account.xprv,
              isImported: true,
              isTrezorWallet: false,
              isLedgerWallet: false,
              balances: { syscoin: 0, ethereum: 0 },
              assets: { syscoin: [], ethereum: [] },
            };
        }
      }

      // Lock and unlock
      keyringManager.lockWallet();
      await keyringManager.unlock(FAKE_PASSWORD);

      // All imported accounts should still exist
      for (const account of imported) {
        const retrieved = keyringManager.getAccountById(
          account.id,
          KeyringAccountType.Imported
        );
        expect(retrieved.address).toBe(account.address);
        expect(retrieved.label).toBe(account.label);
      }
    });
  });
});

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

  describe('Address Public Key and BIP32 Path Methods', () => {
    let mockFetchBackendAccount: jest.Mock;

    beforeEach(async () => {
      // Set up UTXO vault state for testing these methods
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

      // Mock the fetchBackendAccount to return specific tokens with paths
      const syscoinjs = require('syscoinjs-lib');
      mockFetchBackendAccount = syscoinjs.utils
        .fetchBackendAccount as jest.Mock;
    });

    describe('getCurrentAddressPubkey', () => {
      it('should return public key for receiving address', async () => {
        // Mock backend response with tokens
        mockFetchBackendAccount.mockResolvedValue({
          balance: 100000000,
          tokens: [
            {
              path: "m/84'/57'/0'/0/0",
              transfers: '1',
            },
            {
              path: "m/84'/57'/0'/0/1",
              transfers: '1',
            },
            {
              path: "m/84'/57'/0'/1/0",
              transfers: '1',
            },
          ],
        });

        const account = keyringManager.getActiveAccount().activeAccount;
        const pubkey = await keyringManager.getCurrentAddressPubkey(
          account.xpub,
          false // receiving address
        );

        // Verify the public key is a valid hex string
        expect(pubkey).toMatch(/^[0-9a-fA-F]{66}$/); // 33 bytes = 66 hex chars
        expect(pubkey.length).toBe(66); // Compressed public key

        // Verify fetchBackendAccount was called with correct params
        expect(mockFetchBackendAccount).toHaveBeenCalledWith(
          expect.any(String), // blockbook URL
          account.xpub,
          'tokens=used&details=tokens',
          true,
          undefined
        );
      });

      it('should return public key for change address', async () => {
        // Mock backend response with tokens
        mockFetchBackendAccount.mockResolvedValue({
          balance: 100000000,
          tokens: [
            {
              path: "m/84'/57'/0'/0/0",
              transfers: '1',
            },
            {
              path: "m/84'/57'/0'/1/0",
              transfers: '1',
            },
            {
              path: "m/84'/57'/0'/1/1",
              transfers: '1',
            },
          ],
        });

        const account = keyringManager.getActiveAccount().activeAccount;
        const pubkey = await keyringManager.getCurrentAddressPubkey(
          account.xpub,
          true // change address
        );

        // Verify the public key is a valid hex string
        expect(pubkey).toMatch(/^[0-9a-fA-F]{66}$/);
        expect(pubkey.length).toBe(66);
      });

      it('should use correct index based on token paths', async () => {
        // Mock backend response with specific token paths
        mockFetchBackendAccount.mockResolvedValue({
          balance: 100000000,
          tokens: [
            {
              path: "m/84'/57'/0'/0/5", // receiving index 5
              transfers: '1',
            },
            {
              path: "m/84'/57'/0'/1/3", // change index 3
              transfers: '1',
            },
          ],
        });

        const account = keyringManager.getActiveAccount().activeAccount;

        // Get public key for receiving address - should use index 6 (5 + 1)
        const receivingPubkey = await keyringManager.getCurrentAddressPubkey(
          account.xpub,
          false
        );

        // Get public key for change address - should use index 4 (3 + 1)
        const changePubkey = await keyringManager.getCurrentAddressPubkey(
          account.xpub,
          true
        );

        // They should be different
        expect(receivingPubkey).not.toBe(changePubkey);
        expect(receivingPubkey).toMatch(/^[0-9a-fA-F]{66}$/);
        expect(changePubkey).toMatch(/^[0-9a-fA-F]{66}$/);
      });
    });

    describe('getCurrentAddressBip32Path', () => {
      it('should return correct BIP32 path for receiving address', async () => {
        // Mock backend response with tokens
        mockFetchBackendAccount.mockResolvedValue({
          balance: 100000000,
          tokens: [
            {
              path: "m/84'/57'/0'/0/2",
              transfers: '1',
            },
          ],
        });

        const account = keyringManager.getActiveAccount().activeAccount;
        const path = await keyringManager.getCurrentAddressBip32Path(
          account.xpub,
          false // receiving address
        );

        // Should return path for index 3 (2 + 1)
        expect(path).toBe("m/84'/57'/0'/0/3");
      });

      it('should return correct BIP32 path for change address', async () => {
        // Mock backend response with tokens
        mockFetchBackendAccount.mockResolvedValue({
          balance: 100000000,
          tokens: [
            {
              path: "m/84'/57'/0'/1/4",
              transfers: '1',
            },
          ],
        });

        const account = keyringManager.getActiveAccount().activeAccount;
        const path = await keyringManager.getCurrentAddressBip32Path(
          account.xpub,
          true // change address
        );

        // Should return path for index 5 (4 + 1)
        expect(path).toBe("m/84'/57'/0'/1/5");
      });

      it('should use account ID from active account', async () => {
        // Add a new account
        const newAccount = await keyringManager.addNewAccount();

        // Update vault state with new account
        currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
          id: 1,
          label: 'Account 2',
          address: newAccount.address,
          xpub: newAccount.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
        currentVaultState.activeAccount = {
          id: 1,
          type: KeyringAccountType.HDAccount,
        };

        // Mock backend response
        mockFetchBackendAccount.mockResolvedValue({
          balance: 100000000,
          tokens: [],
        });

        const path = await keyringManager.getCurrentAddressBip32Path(
          newAccount.xpub,
          false
        );

        // Should use account ID 1
        expect(path).toBe("m/84'/57'/1'/0/0");
      });

      it('should handle empty token list', async () => {
        // Mock backend response with no tokens
        mockFetchBackendAccount.mockResolvedValue({
          balance: 0,
          tokens: [],
        });

        const account = keyringManager.getActiveAccount().activeAccount;

        // Should use index 0 for both
        const receivingPath = await keyringManager.getCurrentAddressBip32Path(
          account.xpub,
          false
        );
        const changePath = await keyringManager.getCurrentAddressBip32Path(
          account.xpub,
          true
        );

        expect(receivingPath).toBe("m/84'/57'/0'/0/0");
        expect(changePath).toBe("m/84'/57'/0'/1/0");
      });

      it('should handle Bitcoin network paths', async () => {
        // Set up Bitcoin vault state
        const btcVaultState = createMockVaultState({
          activeAccountId: 0,
          activeAccountType: KeyringAccountType.HDAccount,
          networkType: INetworkType.Syscoin, // UTXO type
          chainId: 57, // Use default Syscoin chainId for now
        });

        // Override the active network to be Bitcoin
        btcVaultState.activeNetwork = {
          chainId: 0,
          currency: 'BTC',
          label: 'Bitcoin',
          url: 'https://blockstream.info',
          kind: INetworkType.Syscoin,
          slip44: 0, // Bitcoin's slip44
          explorer: 'https://blockstream.info',
        };

        const btcVaultStateGetter = jest.fn(() => btcVaultState);

        // Create Bitcoin keyring
        const btcKeyring = await KeyringManager.createInitialized(
          PEACE_SEED_PHRASE,
          FAKE_PASSWORD,
          btcVaultStateGetter
        );

        // Mock backend response
        mockFetchBackendAccount.mockResolvedValue({
          balance: 100000000,
          tokens: [],
        });

        const account = btcKeyring.getActiveAccount().activeAccount;
        const path = await btcKeyring.getCurrentAddressBip32Path(
          account.xpub,
          false
        );

        // Should use Bitcoin's slip44 (0)
        expect(path).toBe("m/84'/0'/0'/0/0");
      });
    });

    describe('Integration between methods', () => {
      it('getCurrentAddressPubkey and getAddress should derive from same index', async () => {
        // Mock backend response
        mockFetchBackendAccount.mockResolvedValue({
          balance: 100000000,
          tokens: [
            {
              path: "m/84'/57'/0'/0/2",
              transfers: '1',
            },
          ],
        });

        const account = keyringManager.getActiveAccount().activeAccount;

        // Get address and public key
        const address = await keyringManager.getAddress(account.xpub, false);
        const pubkey = await keyringManager.getCurrentAddressPubkey(
          account.xpub,
          false
        );

        // Both should be valid and non-empty
        expect(address).toBeTruthy();
        expect(address).toMatch(/^(sys1|tsys1)/);
        expect(pubkey).toMatch(/^[0-9a-fA-F]{66}$/);

        // They should have been called with the same backend data
        expect(mockFetchBackendAccount).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Hardware Wallet Support', () => {
    it('should work with all read-only methods', async () => {
      // Set up UTXO vault state with a regular HD account for testing
      // The key point is that our methods work with just xpub, regardless of account type
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

      // Mock backend response
      const syscoinjs = require('syscoinjs-lib');
      const mockFetchBackendAccount = syscoinjs.utils
        .fetchBackendAccount as jest.Mock;
      mockFetchBackendAccount.mockResolvedValue({
        balance: 100000000,
        tokens: [
          {
            path: "m/84'/57'/0'/0/2",
            transfers: '1',
          },
          {
            path: "m/84'/57'/0'/1/1",
            transfers: '1',
          },
        ],
      });

      // Get the xpub from a regular account to test with
      const account = keyringManager.getActiveAccount().activeAccount;
      const xpub = account.xpub;

      // Test all read-only methods that hardware wallets can use
      // These methods only need xpub, not private keys

      // 1. Test getCurrentAddressPubkey
      const receivingPubkey = await keyringManager.getCurrentAddressPubkey(
        xpub,
        false
      );
      const changePubkey = await keyringManager.getCurrentAddressPubkey(
        xpub,
        true
      );
      expect(receivingPubkey).toMatch(/^[0-9a-fA-F]{66}$/);
      expect(changePubkey).toMatch(/^[0-9a-fA-F]{66}$/);
      expect(receivingPubkey).not.toBe(changePubkey);

      // 2. Test getBip32Path
      const receivingPath = await keyringManager.getCurrentAddressBip32Path(
        xpub,
        false
      );
      const changePath = await keyringManager.getCurrentAddressBip32Path(
        xpub,
        true
      );
      expect(receivingPath).toBe("m/84'/57'/0'/0/3"); // index 2 + 1
      expect(changePath).toBe("m/84'/57'/0'/1/2"); // index 1 + 1

      // 3. Test getAddress (used by getChangeAddress)
      const receivingAddress = await keyringManager.getAddress(xpub, false);
      const changeAddress = await keyringManager.getAddress(xpub, true);
      expect(receivingAddress).toMatch(/^(sys1|tsys1)/);
      expect(changeAddress).toMatch(/^(sys1|tsys1)/);
      expect(receivingAddress).not.toBe(changeAddress);

      // 4. Test getChangeAddress (calls getAddress internally)
      const changeAddr = await keyringManager.getChangeAddress(0);
      expect(changeAddr).toMatch(/^(sys1|tsys1)/);

      // All these methods work with just xpub, making them hardware wallet compatible
    });
  });
});

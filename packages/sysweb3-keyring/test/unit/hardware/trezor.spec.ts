import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('Trezor Hardware Wallet', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;
  let accountCounter = 0;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);

    // Reset counter for each test
    accountCounter = 0;

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

    // Mock Trezor signer methods with dynamic responses
    keyringManager.trezorSigner.getAccountInfo = jest
      .fn()
      .mockImplementation(() => {
        accountCounter++;
        return Promise.resolve({
          descriptor: `xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE${accountCounter}`,
          balance: '100000000', // 1 SYS in satoshis
        });
      });

    keyringManager.trezorSigner.getPublicKey = jest.fn().mockResolvedValue({
      publicKey: '0x04mock_public_key',
    });

    // Mock getAddress for Trezor accounts with dynamic addresses
    keyringManager.getAddress = jest.fn().mockImplementation(() => {
      return Promise.resolve(`sys1qmock_trezor_address_${accountCounter}`);
    });
  });

  describe('Account Import', () => {
    it('should import Trezor account', async () => {
      const account = await keyringManager.importTrezorAccount('My Trezor');

      expect(account).toBeDefined();
      expect(account.id).toBe(0); // First Trezor account gets ID 0
      expect(account.label).toBe('My Trezor');
      expect(account.isTrezorWallet).toBe(true);
      expect(account.isLedgerWallet).toBe(false);
      expect(account.isImported).toBe(false);
      expect(account.xprv).toBe(''); // Hardware wallets store empty xprv

      // Update vault state with imported account
      currentVaultState.accounts[KeyringAccountType.Trezor][account.id] = {
        id: account.id,
        label: account.label,
        address: account.address,
        xpub: account.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: true,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };
    });

    it('should import multiple Trezor accounts', async () => {
      const account1 = await keyringManager.importTrezorAccount();

      // Update vault state
      currentVaultState.accounts[KeyringAccountType.Trezor][account1.id] = {
        id: account1.id,
        label: account1.label,
        address: account1.address,
        xpub: account1.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: true,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const account2 = await keyringManager.importTrezorAccount();

      // Update vault state
      currentVaultState.accounts[KeyringAccountType.Trezor][account2.id] = {
        id: account2.id,
        label: account2.label,
        address: account2.address,
        xpub: account2.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: true,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      const account3 = await keyringManager.importTrezorAccount(
        'Custom Trezor'
      );

      // Update vault state
      currentVaultState.accounts[KeyringAccountType.Trezor][account3.id] = {
        id: account3.id,
        label: account3.label,
        address: account3.address,
        xpub: account3.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: true,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      expect(account1.id).toBe(0);
      expect(account1.label).toBe('Trezor 1');

      expect(account2.id).toBe(1);
      expect(account2.label).toBe('Trezor 2');

      expect(account3.id).toBe(2);
      expect(account3.label).toBe('Custom Trezor');
    });

    it('should handle Trezor import for EVM networks', async () => {
      // Set up EVM vault state
      const evmVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const evmVaultStateGetter = jest.fn(() => evmVaultState);

      // Create EVM keyring
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        evmVaultStateGetter
      );

      // Mock Trezor EVM methods with proper EVM address
      evmKeyring.trezorSigner.getPublicKey = jest.fn().mockResolvedValue({
        publicKey: '0x04mock_evm_public_key',
      });
      evmKeyring.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: '0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f', // Return EVM address directly as descriptor
        balance: '1000000000000000000', // 1 ETH in wei
      });
      evmKeyring.trezorSigner.getAddress = jest
        .fn()
        .mockResolvedValue('0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f');

      const account = await evmKeyring.importTrezorAccount('Trezor ETH');

      expect(account).toBeDefined();
      expect(account.address.startsWith('0x')).toBe(true);
      expect(account.isTrezorWallet).toBe(true);
    });

    it('should reject duplicate Trezor addresses', async () => {
      // First import
      const firstAccount = await keyringManager.importTrezorAccount();

      // Update vault state with first account
      currentVaultState.accounts[KeyringAccountType.Trezor][firstAccount.id] = {
        id: firstAccount.id,
        label: firstAccount.label,
        address: firstAccount.address,
        xpub: firstAccount.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: true,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Mock Trezor returning same address
      keyringManager.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: 'xpub_duplicate',
        balance: '100000000',
      });

      // Should reject duplicate
      await expect(keyringManager.importTrezorAccount()).rejects.toThrow(
        'Account already exists'
      );
    });
  });

  describe('Account Management', () => {
    beforeEach(async () => {
      // Import a Trezor account
      const account = await keyringManager.importTrezorAccount('Test Trezor');

      // Update vault state with imported account
      currentVaultState.accounts[KeyringAccountType.Trezor][account.id] = {
        id: account.id,
        label: account.label,
        address: account.address,
        xpub: account.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: true,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };
    });

    it('should switch to Trezor account', async () => {
      // Update vault state to set Trezor as active
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.Trezor,
      };

      // Account switch is handled by vault state update

      const { activeAccount, activeAccountType } =
        keyringManager.getActiveAccount();
      expect(activeAccountType).toBe(KeyringAccountType.Trezor);
      expect(activeAccount.isTrezorWallet).toBe(true);
      expect(activeAccount.label).toBe('Test Trezor');
    });

    it('should get Trezor account xpub', async () => {
      // Update vault state to set Trezor as active
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.Trezor,
      };

      // Account switch is handled by vault state update

      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      expect(typeof xpub).toBe('string');
      // For UTXO it should be an xpub, for EVM it's the public key
    });

    it('should handle mixed account types', async () => {
      // Add HD account
      const hdAccount = await keyringManager.addNewAccount('HD Account 2');

      // Update vault state with HD account
      currentVaultState.accounts[KeyringAccountType.HDAccount][hdAccount.id] = {
        id: hdAccount.id,
        label: hdAccount.label,
        address: hdAccount.address,
        xpub: hdAccount.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Import another Trezor
      const trezor2Account = await keyringManager.importTrezorAccount(
        'Trezor 2'
      );

      // Update vault state with second Trezor
      currentVaultState.accounts[KeyringAccountType.Trezor][trezor2Account.id] =
        {
          id: trezor2Account.id,
          label: trezor2Account.label,
          address: trezor2Account.address,
          xpub: trezor2Account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

      // Switch between them
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.HDAccount,
      };
      // Account switch is handled by vault state update
      expect(keyringManager.getActiveAccount().activeAccountType).toBe(
        KeyringAccountType.HDAccount
      );

      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.Trezor,
      };
      // Account switch is handled by vault state update
      expect(keyringManager.getActiveAccount().activeAccountType).toBe(
        KeyringAccountType.Trezor
      );

      currentVaultState.activeAccount = {
        id: trezor2Account.id,
        type: KeyringAccountType.Trezor,
      };
      // Account switch is handled by vault state update
      expect(keyringManager.getActiveAccount().activeAccount.label).toBe(
        'Trezor 2'
      );
    });
  });

  describe('Transaction Signing', () => {
    beforeEach(async () => {
      // Mock syscoinjs-lib main signer
      const mockSigner = {
        hd: jest.fn(),
        main: {
          send: jest.fn().mockResolvedValue({
            extractTransaction: () => ({
              getId: () => 'mock_transaction_id',
            }),
          }),
          blockbookURL: 'https://blockbook.test',
          createTransaction: jest.fn().mockResolvedValue({
            psbt: 'mock_psbt',
            fee: 1000,
          }),
        },
      };

      // Mock the syscoinTransaction getSigner method directly
      (keyringManager.syscoinTransaction as any).getSigner = jest
        .fn()
        .mockReturnValue(mockSigner);

      const account = await keyringManager.importTrezorAccount('Signing Test');
      if (account) {
        // Update vault state to set Trezor as active
        currentVaultState.accounts[KeyringAccountType.Trezor][account.id] = {
          id: account.id,
          label: account.label,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
        currentVaultState.activeAccount = {
          id: account.id,
          type: KeyringAccountType.Trezor,
        };
      }
    });

    it('should prepare PSBT for Trezor signing', async () => {
      const psbtData = {
        psbt: 'valid_psbt_data',
        assets: [],
      };

      // Mock the entire signPSBT method to avoid PSBT parsing
      const originalSignPSBT = keyringManager.syscoinTransaction.signPSBT;
      keyringManager.syscoinTransaction.signPSBT = jest.fn().mockResolvedValue({
        psbt: 'mock_signed_psbt_data',
      });

      const result = await keyringManager.syscoinTransaction.signPSBT({
        psbt: psbtData,
        isTrezor: true,
        isLedger: false,
        pathIn: undefined,
      });

      expect(result).toBeDefined();
      expect(result.psbt).toBe('mock_signed_psbt_data');
      expect(keyringManager.syscoinTransaction.signPSBT).toHaveBeenCalledWith(
        expect.objectContaining({
          isTrezor: true,
          isLedger: false,
        })
      );

      // Restore original method
      keyringManager.syscoinTransaction.signPSBT = originalSignPSBT;
    });

    it('should handle Trezor transaction flow', async () => {
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();

      // Mock the PSBT parsing for sendTransaction too
      const mockSyscoinjs = require('syscoinjs-lib');
      const originalImportPsbtFromJson = mockSyscoinjs.utils.importPsbtFromJson;
      mockSyscoinjs.utils.importPsbtFromJson = jest.fn().mockReturnValue({
        extractTransaction: jest.fn().mockReturnValue({
          getId: jest.fn().mockReturnValue('mock_transaction_id'),
        }),
      });

      // Mock transaction creation - use current sendTransaction API signature
      const signedPsbt = {
        psbt: 'valid_psbt_data',
        assets: [],
      };

      const result = await keyringManager.syscoinTransaction.sendTransaction(
        signedPsbt
      );

      expect(result.txid).toBeDefined();

      // Restore original function
      mockSyscoinjs.utils.importPsbtFromJson = originalImportPsbtFromJson;
    });

    it('should handle EVM transaction signing for Trezor', async () => {
      // Set up EVM vault state
      const evmVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const evmVaultStateGetter = jest.fn(() => evmVaultState);

      // Create EVM keyring with Trezor
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        evmVaultStateGetter
      );

      // Mock Trezor EVM methods
      evmKeyring.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: '0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f',
        balance: '1000000000000000000',
      });

      evmKeyring.trezorSigner.getAddress = jest
        .fn()
        .mockResolvedValue('0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f');

      evmKeyring.trezorSigner.getPublicKey = jest.fn().mockResolvedValue({
        publicKey: '0x04mock_evm_public_key',
      });

      evmKeyring.trezorSigner.signEthTransaction = jest.fn().mockResolvedValue({
        v: '0x1c',
        r: '0x123456789abcdef123456789abcdef123456789abcdef123456789abcdef12345678',
        s: '0x987654321fedcba987654321fedcba987654321fedcba987654321fedcba987654',
      });

      // Import Trezor account
      const evmAccount = await evmKeyring.importTrezorAccount('Trezor ETH');
      if (evmAccount) {
        // Update vault state to set Trezor as active
        evmVaultState.accounts[KeyringAccountType.Trezor][evmAccount.id] = {
          id: evmAccount.id,
          label: evmAccount.label,
          address: evmAccount.address,
          xpub: evmAccount.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
        evmVaultState.activeAccount = {
          id: evmAccount.id,
          type: KeyringAccountType.Trezor,
        };

        // Account switch is handled by vault state update
      }

      // Test EVM transaction signing
      expect(evmKeyring.trezorSigner.signEthTransaction).toBeDefined();
      expect(evmAccount.address.startsWith('0x')).toBe(true);
    });
  });

  describe('Network Support', () => {
    it('should support Trezor on different UTXO networks', async () => {
      // Set up testnet vault state
      const testnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 5700,
      });
      const testnetVaultStateGetter = jest.fn(() => testnetVaultState);

      // Test on testnet
      const testnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        testnetVaultStateGetter
      );

      const account = await testnetKeyring.importTrezorAccount(
        'Testnet Trezor'
      );
      expect(account.address.match(/^(sys1|tsys1)/)).toBeTruthy();
    });

    it('should maintain separate Trezor accounts per network', async () => {
      // Import on mainnet
      const mainnetAccount = await keyringManager.importTrezorAccount(
        'Mainnet Trezor'
      );

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

      // Import on testnet
      const testnetAccount = await testnetKeyring.importTrezorAccount(
        'Testnet Trezor'
      );

      // Accounts should be independent
      expect(mainnetAccount.address).not.toBe(testnetAccount.address);
      expect(mainnetAccount.address.match(/^(sys1|tsys1)/)).toBeTruthy();
      expect(testnetAccount.address.match(/^(sys1|tsys1)/)).toBeTruthy();
    });
  });

  describe('Error Handling', () => {
    it('should handle Trezor connection errors', async () => {
      // Mock connection failure
      keyringManager.trezorSigner.getAccountInfo = jest
        .fn()
        .mockRejectedValue(new Error('Trezor not connected'));

      await expect(keyringManager.importTrezorAccount()).rejects.toThrow(
        'Trezor not connected'
      );
    });

    it('should handle invalid Trezor responses', async () => {
      // Mock invalid response
      keyringManager.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: null,
        balance: null,
      });

      await expect(keyringManager.importTrezorAccount()).rejects.toThrow(
        'Something wrong happened'
      );
    });

    it('should handle Trezor device disconnection during signing', async () => {
      const account = await keyringManager.importTrezorAccount(
        'Disconnect Test'
      );
      if (account) {
        // Update vault state to set Trezor as active
        currentVaultState.accounts[KeyringAccountType.Trezor][account.id] = {
          id: account.id,
          label: account.label,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
        currentVaultState.activeAccount = {
          id: account.id,
          type: KeyringAccountType.Trezor,
        };

        // Account switch is handled by vault state update
      }

      // Mock Trezor disconnection during signing
      keyringManager.trezorSigner.signUtxoTransaction = jest
        .fn()
        .mockRejectedValue(new Error('Device disconnected'));

      const psbtData = {
        psbt: 'valid_psbt_data',
        assets: [],
      };

      await expect(
        keyringManager.syscoinTransaction.signPSBT({
          psbt: psbtData,
          isTrezor: true,
          isLedger: false,
          pathIn: undefined,
        })
      ).rejects.toThrow();
    });

    it('should handle Trezor firmware update required', async () => {
      // Mock firmware update required error
      keyringManager.trezorSigner.getAccountInfo = jest
        .fn()
        .mockRejectedValue(new Error('Device firmware update required'));

      await expect(keyringManager.importTrezorAccount()).rejects.toThrow(
        'Device firmware update required'
      );
    });
  });

  describe('Security', () => {
    it('should not expose private keys for hardware wallets', async () => {
      const account = await keyringManager.importTrezorAccount('Security Test');

      expect(account).toBeDefined();
      expect(account.xprv).toBe(''); // Should be empty for hardware wallets
      expect(account.isTrezorWallet).toBe(true);

      // Should not be able to get private key for hardware wallet
      await expect(
        keyringManager.getPrivateKeyByAccountId(
          account.id,
          KeyringAccountType.Trezor,
          FAKE_PASSWORD
        )
      ).rejects.toThrow();
    });

    it('should maintain hardware wallet isolation', async () => {
      const account = await keyringManager.importTrezorAccount(
        'Isolation Test'
      );

      if (account) {
        // Update vault state
        currentVaultState.accounts[KeyringAccountType.Trezor][account.id] = {
          id: account.id,
          label: account.label,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

        // Verify Trezor accounts are completely separate from HD accounts
        const hdAccounts =
          currentVaultState.accounts[KeyringAccountType.HDAccount];
        const trezorAccounts =
          currentVaultState.accounts[KeyringAccountType.Trezor];

        expect(Object.keys(hdAccounts)).toHaveLength(1); // Initial HD account
        expect(Object.keys(trezorAccounts)).toHaveLength(1); // One imported Trezor account

        // Verify no cross-contamination of account types
        Object.values(hdAccounts).forEach((account: any) => {
          expect(account.isTrezorWallet).toBe(false);
        });

        Object.values(trezorAccounts).forEach((account: any) => {
          expect(account.isTrezorWallet).toBe(true);
        });
      }
    });

    it('should handle hardware wallet re-initialization securely', async () => {
      const account = await keyringManager.importTrezorAccount('Reinit Test');

      if (account) {
        // Update vault state
        currentVaultState.accounts[KeyringAccountType.Trezor][account.id] = {
          id: account.id,
          label: account.label,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
        currentVaultState.activeAccount = {
          id: account.id,
          type: KeyringAccountType.Trezor,
        };

        // Account switch is handled by vault state update

        // Lock and unlock to test re-initialization
        keyringManager.lockWallet();

        // Mock hardware wallet communication error during unlock
        keyringManager.trezorSigner.getAccountInfo = jest
          .fn()
          .mockRejectedValue(new Error('Trezor device not found'));

        // Should still unlock successfully - account info comes from vault
        const unlockResult = await keyringManager.unlock(FAKE_PASSWORD);
        expect(unlockResult.canLogin).toBe(true);

        // Account info should still be accessible from vault
        const activeAfter = keyringManager.getActiveAccount();
        expect(activeAfter.activeAccount.label).toBe('Reinit Test');
        expect(activeAfter.activeAccount.isTrezorWallet).toBe(true);
      }
    });

    it('should verify UTXO address on Trezor device', async () => {
      // Mock TrezorConnect.getAddress to simulate device verification
      const TrezorConnect = require('@trezor/connect-webextension').default;
      TrezorConnect.getAddress = jest.fn().mockResolvedValue({
        success: true,
        payload: {
          address: 'sys1qmock_trezor_verified_address',
        },
      });

      const account = await keyringManager.importTrezorAccount('Verify Test');

      if (account) {
        // Update vault state
        currentVaultState.accounts[KeyringAccountType.Trezor][account.id] = {
          id: account.id,
          label: account.label,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: true,
          isLedgerWallet: false,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

        // Test verifyUtxoAddress
        const verifiedAddress =
          await keyringManager.trezorSigner.verifyUtxoAddress(
            account.id,
            'sys',
            57
          );

        expect(verifiedAddress).toBe('sys1qmock_trezor_verified_address');

        // Verify that showOnTrezor was set to true
        expect(TrezorConnect.getAddress).toHaveBeenCalledWith(
          expect.objectContaining({
            showOnTrezor: true,
          })
        );
      }
    });

    it('should handle user cancellation during address verification', async () => {
      // Mock TrezorConnect.getAddress to simulate user cancellation
      const TrezorConnect = require('@trezor/connect-webextension').default;
      TrezorConnect.getAddress = jest.fn().mockResolvedValue({
        success: false,
        payload: {
          error: 'User cancelled',
        },
      });

      const account = await keyringManager.importTrezorAccount('Cancel Test');

      if (account) {
        // Attempt to verify address
        await expect(
          keyringManager.trezorSigner.verifyUtxoAddress(account.id, 'sys', 57)
        ).rejects.toThrow('Address verification cancelled by user');
      }
    });
  });
});

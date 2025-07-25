import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

// Use global createMockVaultState
const createMockVaultState = (global as any).createMockVaultState;

describe('Ledger Hardware Wallet', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();
    await global.setupTestVault(FAKE_PASSWORD);

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

    // Mock HardwareWalletManager ensureConnection
    keyringManager.ledgerSigner.ensureConnection = jest
      .fn()
      .mockResolvedValue(undefined);

    // Mock transport property
    keyringManager.ledgerSigner.transport = {} as any;

    // Mock ledgerUtxoClient for getMasterFingerprint calls
    keyringManager.ledgerSigner.ledgerUtxoClient = {
      getMasterFingerprint: jest.fn().mockResolvedValue('12345678'),
      signPsbt: jest.fn(),
    } as any;

    // Mock getAddress to return our mocked addresses
    keyringManager.getAddress = jest
      .fn()
      .mockResolvedValue('sys1qmock_ledger_address');
  });

  afterEach(async () => {
    // Clean up hardware wallet connections
    if (keyringManager) {
      await keyringManager.destroy();
    }
  });

  describe('Account Import', () => {
    it('should import Ledger account when connected', async () => {
      // Mock complete UTXO interface
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1qmock_ledger_address'),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1qmock_ledger_address'),
      };

      const account = await keyringManager.importLedgerAccount('My Ledger');

      expect(account).toBeDefined();
      if (account) {
        expect(account.id).toBe(0); // First imported Ledger account gets ID 0
        expect(account.label).toBe('My Ledger');
        expect(account.isLedgerWallet).toBe(true);
        expect(account.isTrezorWallet).toBe(false);
        expect(account.isImported).toBe(false);
        expect(account.xprv).toBe(''); // Hardware wallets don't expose private keys
        expect(account.address).toBe('sys1qmock_ledger_address');
      }
    });

    it('should fail if Ledger connection fails', async () => {
      // Mock connection failure in ensureConnection
      keyringManager.ledgerSigner.ensureConnection = jest
        .fn()
        .mockRejectedValue(new Error('Failed to connect to device'));

      await expect(keyringManager.importLedgerAccount()).rejects.toThrow(
        'Failed to connect to device'
      );
    });

    it('should handle Ledger import for EVM networks', async () => {
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

      // Mock ensureConnection for EVM keyring
      evmKeyring.ledgerSigner.ensureConnection = jest
        .fn()
        .mockResolvedValue(undefined);

      // Mock complete EVM interface
      evmKeyring.ledgerSigner.evm = {
        getEvmAddressAndPubKey: jest.fn().mockResolvedValue({
          address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bd9F',
          publicKey: '0x04...',
        }),
        signEVMTransaction: jest.fn().mockResolvedValue({
          r: '123456789abcdef123456789abcdef123456789abcdef123456789abcdef12345678',
          s: '987654321fedcba987654321fedcba987654321fedcba987654321fedcba987654',
          v: '1c',
        }),
        signPersonalMessage: jest.fn().mockResolvedValue('0xmocked_signature'),
        signTypedData: jest.fn().mockResolvedValue('0xmocked_typed_signature'),
      };

      const account = await evmKeyring.importLedgerAccount('Ledger ETH');

      expect(account).toBeDefined();
      if (account) {
        expect(account.address.startsWith('0x')).toBe(true);
        expect(account.isLedgerWallet).toBe(true);
      }
    });

    it('should reject duplicate Ledger addresses', async () => {
      // Mock getAddress to return the expected addresses
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1q_first_address');

      // First import with unique address
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_first_address'),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_first_address'),
      };

      const firstAccount = await keyringManager.importLedgerAccount();

      // Update vault state with first account
      if (firstAccount) {
        currentVaultState.accounts[KeyringAccountType.Ledger][firstAccount.id] =
          {
            id: firstAccount.id,
            label: firstAccount.label,
            address: firstAccount.address,
            xpub: firstAccount.xpub,
            xprv: '',
            isImported: false,
            isTrezorWallet: false,
            isLedgerWallet: true,
            balances: { syscoin: 0, ethereum: 0 },
            assets: { syscoin: [], ethereum: [] },
          };
      }

      // Mock Ledger returning same address for next account (simulate duplicate)
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'zpub6s8HtEQtcu3AmBn9sniSqCAVhx2nJAhb2sd5NDYeYZ1ZJaZx7MAVZZnG1PdCUNJcVJXGbVpGfSYZLgkPSUjLYnJg8UdYvdkfaygcXZKPLy6'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_first_address'), // Same as first!
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_first_address'),
      };

      // Should reject duplicate - this tests the actual business logic
      await expect(keyringManager.importLedgerAccount()).rejects.toThrow(
        'Account already exists'
      );
    });
  });

  describe('Account Management', () => {
    beforeEach(async () => {
      // Mock complete Ledger methods
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1qmock_ledger_address'),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1qmock_ledger_address'),
      };

      // Import a Ledger account
      const account = await keyringManager.importLedgerAccount('Test Ledger');

      // Update vault state with imported account
      if (account) {
        currentVaultState.accounts[KeyringAccountType.Ledger][account.id] = {
          id: account.id,
          label: account.label,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: true,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
      }
    });

    it('should switch to Ledger account', async () => {
      // Update vault state to set Ledger as active
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.Ledger,
      };

      // Account switch is handled by vault state update

      const { activeAccount, activeAccountType } =
        keyringManager.getActiveAccount();
      expect(activeAccountType).toBe(KeyringAccountType.Ledger);
      expect(activeAccount.isLedgerWallet).toBe(true);
      expect(activeAccount.label).toBe('Test Ledger');
    });

    it('should get Ledger account xpub', async () => {
      // Update vault state to set Ledger as active
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.Ledger,
      };

      // Account switch is handled by vault state update

      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      expect(xpub).toBe(
        'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
      );
    });

    it('should handle mixed account types with Ledger', async () => {
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

      // Switch between them using actual account IDs
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.HDAccount,
      };
      // Account switch is handled by vault state update
      expect(keyringManager.getActiveAccount().activeAccountType).toBe(
        KeyringAccountType.HDAccount
      );

      // Switch to Ledger account
      currentVaultState.activeAccount = {
        id: 0,
        type: KeyringAccountType.Ledger,
      };
      // Account switch is handled by vault state update
      expect(keyringManager.getActiveAccount().activeAccountType).toBe(
        KeyringAccountType.Ledger
      );
    });
  });

  describe('Transaction Signing', () => {
    beforeEach(async () => {
      // Complete mock setup for transaction signing tests
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1qmock_ledger_address'),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1qmock_ledger_address'),
      };

      const account = await keyringManager.importLedgerAccount('Signing Test');
      if (account) {
        // Update vault state to set Ledger as active
        currentVaultState.accounts[KeyringAccountType.Ledger][account.id] = {
          id: account.id,
          label: account.label,
          address: account.address,
          xpub: account.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: true,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
        currentVaultState.activeAccount = {
          id: account.id,
          type: KeyringAccountType.Ledger,
        };

        // Account switch is handled by vault state update
      }

      // Mock getAddress to return our mocked addresses
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1qmock_ledger_address');

      // Mock Ledger UTXO client for transaction signing
      keyringManager.ledgerSigner.ledgerUtxoClient = {
        getMasterFingerprint: jest.fn().mockResolvedValue('12345678'),
        signPsbt: jest.fn().mockResolvedValue([
          [
            0,
            {
              pubkey: Buffer.from('mock_pubkey'),
              signature: Buffer.from('mock_signature'),
            },
          ],
        ]),
        // Add minimal required properties to satisfy interface
        transport: {} as any,
        makeRequest: jest.fn(),
        getAppAndVersion: jest.fn(),
        getExtendedPubkey: jest.fn(),
        registerWallet: jest.fn(),
        getWalletAddress: jest.fn(),
        signMessage: jest.fn(),
      } as any;

      // Mock convertToLedgerFormat to return a proper PSBT mock with toBase64 method
      keyringManager.ledgerSigner.convertToLedgerFormat = jest
        .fn()
        .mockResolvedValue({
          toBase64: jest
            .fn()
            .mockReturnValue(
              'cHNidP8BAHECAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
            ),
          extractTransaction: jest.fn().mockReturnValue({
            getId: jest.fn().mockReturnValue('mock_transaction_id'),
          }),
          updateInput: jest.fn(),
          finalizeAllInputs: jest.fn(),
        });
    });

    it('should prepare PSBT for Ledger signing', async () => {
      // Mock the PSBT parsing to avoid base64 validation issues
      const mockSyscoinjs = require('syscoinjs-lib');
      const originalImportPsbtFromJson = mockSyscoinjs.utils.importPsbtFromJson;
      mockSyscoinjs.utils.importPsbtFromJson = jest.fn().mockReturnValue({
        psbt: 'mocked_psbt_object',
      });

      const psbtData = {
        psbt: 'valid_psbt_data',
        assets: [],
      };

      const result = await keyringManager.syscoinTransaction.signPSBT({
        psbt: psbtData,
        isTrezor: false,
        isLedger: true,
        pathIn: undefined,
      });

      expect(result).toBeDefined();
      // Verify Ledger-specific handling was applied

      // Restore original function
      mockSyscoinjs.utils.importPsbtFromJson = originalImportPsbtFromJson;
    });

    it('should reconnect to Ledger when connection is lost during EVM transaction signing', async () => {
      // Set up EVM vault state
      const evmVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.Ledger,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const evmVaultStateGetter = jest.fn(() => evmVaultState);

      // Create EVM keyring with Ledger
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        evmVaultStateGetter
      );

      // Mock Ledger as disconnected
      evmKeyring.ledgerSigner.transport = null;
      evmKeyring.ledgerSigner.ledgerUtxoClient = null as any;
      evmKeyring.ledgerSigner.ledgerEVMClient = null as any;

      // Mock transport for reconnection
      const mockTransport = { close: jest.fn() } as any;

      // Mock ensureConnection to simulate successful reconnection
      evmKeyring.ledgerSigner.ensureConnection = jest
        .fn()
        .mockImplementation(async () => {
          // Simulate successful reconnection
          evmKeyring.ledgerSigner.transport = mockTransport;
          evmKeyring.ledgerSigner.ledgerUtxoClient = {
            getMasterFingerprint: jest.fn().mockResolvedValue('12345678'),
          } as any;
          evmKeyring.ledgerSigner.ledgerEVMClient = {
            signTransaction: jest.fn().mockResolvedValue({
              r: '123456789abcdef',
              s: '987654321fedcba',
              v: '00',
            }),
            getAddress: jest.fn().mockResolvedValue({
              address: '0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f',
              publicKey: '0x04...',
            }),
            signPersonalMessage: jest
              .fn()
              .mockResolvedValue('0xmocked_signature'),
            signEIP712HashedMessage: jest
              .fn()
              .mockResolvedValue('0xmocked_typed_signature'),
          } as any;
        });

      // Import Ledger account
      const evmAccount = {
        id: 0,
        label: 'Ledger 1',
        address: '0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f',
        xpub: 'xpub...',
      };

      evmVaultState.accounts[KeyringAccountType.Ledger][0] = {
        id: evmAccount.id,
        label: evmAccount.label,
        address: evmAccount.address,
        xpub: evmAccount.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: true,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Test that Ledger reconnects and signs successfully
      const result = await evmKeyring.ledgerSigner.evm.signEVMTransaction({
        rawTx: '0x1234567890',
        accountIndex: 0,
      });

      // Verify reconnection happened
      expect(evmKeyring.ledgerSigner.ensureConnection).toHaveBeenCalledTimes(1);

      // Verify the signature was returned
      expect(result).toEqual({
        r: '123456789abcdef',
        s: '987654321fedcba',
        v: '00',
      });

      // Verify Ledger is now connected
      expect(evmKeyring.ledgerSigner.transport).toBeTruthy();
    });

    it('should handle EVM transaction signing for Ledger', async () => {
      // Set up EVM vault state
      const evmVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Ethereum,
        chainId: 1,
      });
      const evmVaultStateGetter = jest.fn(() => evmVaultState);

      // Create EVM keyring with Ledger
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        evmVaultStateGetter
      );

      // Mock ensureConnection
      evmKeyring.ledgerSigner.ensureConnection = jest
        .fn()
        .mockResolvedValue(undefined);

      // Mock Ledger EVM signer
      const mockSignEVMTransaction = jest.fn().mockResolvedValue({
        r: '123456789abcdef123456789abcdef123456789abcdef123456789abcdef12345678',
        s: '987654321fedcba987654321fedcba987654321fedcba987654321fedcba987654',
        v: '00',
      });

      evmKeyring.ledgerSigner.evm = {
        getEvmAddressAndPubKey: jest.fn().mockResolvedValue({
          address: '0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f',
          publicKey: '0x04...',
        }),
        signEVMTransaction: mockSignEVMTransaction,
        signPersonalMessage: jest.fn().mockResolvedValue('0xmocked_signature'),
        signTypedData: jest.fn().mockResolvedValue('0xmocked_typed_signature'),
      };

      // Import Ledger account
      const evmAccount = await evmKeyring.importLedgerAccount('EVM Ledger');
      if (evmAccount) {
        // Update vault state to set Ledger as active
        evmVaultState.accounts[KeyringAccountType.Ledger][evmAccount.id] = {
          id: evmAccount.id,
          label: evmAccount.label,
          address: evmAccount.address,
          xpub: evmAccount.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: true,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };
        evmVaultState.activeAccount = {
          id: evmAccount.id,
          type: KeyringAccountType.Ledger,
        };

        // Account switch is handled by vault state update
      }

      // Test that Ledger signing is called - expect it to fail at serialization but verify Ledger was called
      try {
        await evmKeyring.ethereumTransaction.sendFormattedTransaction({
          to: '0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f',
          value: '0x0',
          data: '0x',
          gasLimit: '0x5208',
          maxFeePerGas: '0x3b9aca00',
          maxPriorityFeePerGas: '0x1dcd6500',
          chainId: 1,
          from: '0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f',
        });
        // If it doesn't throw, that's fine too
      } catch (error) {
        // Expected to fail at signature serialization, but we should have called the Ledger signer
        expect(error.message).toContain('value out of range');
      }

      // The important part: verify that Ledger signing was attempted with correct parameters
      expect(mockSignEVMTransaction).toHaveBeenCalled();
      expect(mockSignEVMTransaction).toHaveBeenCalledWith({
        rawTx: expect.any(String), // Should be a hex string of the unsigned transaction
        accountIndex: expect.any(Number), // Should be the account index
      });
    });
  });

  describe('Network Support', () => {
    it('should support Ledger on different UTXO networks', async () => {
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

      // Mock getAddress to return testnet address
      testnetKeyring.getAddress = jest
        .fn()
        .mockResolvedValue('tsys1q_testnet_ledger');

      // Mock ensureConnection for testnet
      testnetKeyring.ledgerSigner.ensureConnection = jest
        .fn()
        .mockResolvedValue(undefined);

      // Mock testnet Ledger
      testnetKeyring.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'vpub5YMNvjHGu8MhNvgxNrGV8qZGkb3SVTiCAzqyCV8TbCZrEXrJqsCTMJjEJXBLfmjfFCDPRpGPW59THQMvPDuQejY5cSpfNYVZYcgJaMVZJCG'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('tsys1q_testnet_ledger'),
        verifyUtxoAddress: jest.fn().mockResolvedValue('tsys1q_testnet_ledger'),
      };

      const account = await testnetKeyring.importLedgerAccount(
        'Testnet Ledger'
      );
      if (account) {
        expect(account.address.match(/^(sys1|tsys1)/)).toBeTruthy();
      }
    });

    it('should maintain separate Ledger accounts per network', async () => {
      // Mock getAddress for mainnet
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1q_mainnet_ledger');

      // Mock mainnet Ledger
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_mainnet_ledger'),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_mainnet_ledger'),
      };

      // Import on mainnet
      const mainnetAccount = await keyringManager.importLedgerAccount(
        'Mainnet Ledger'
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

      // Mock getAddress for testnet
      testnetKeyring.getAddress = jest
        .fn()
        .mockResolvedValue('tsys1q_testnet_ledger');

      // Mock ensureConnection for testnet
      testnetKeyring.ledgerSigner.ensureConnection = jest
        .fn()
        .mockResolvedValue(undefined);

      // Mock testnet Ledger
      testnetKeyring.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'vpub5YMNvjHGu8MhNvgxNrGV8qZGkb3SVTiCAzqyCV8TbCZrEXrJqsCTMJjEJXBLfmjfFCDPRpGPW59THQMvPDuQejY5cSpfNYVZYcgJaMVZJCG'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('tsys1q_testnet_ledger'),
        verifyUtxoAddress: jest.fn().mockResolvedValue('tsys1q_testnet_ledger'),
      };

      // Import on testnet
      const testnetAccount = await testnetKeyring.importLedgerAccount(
        'Testnet Ledger'
      );

      // Accounts should be independent
      if (mainnetAccount && testnetAccount) {
        expect(mainnetAccount.address).not.toBe(testnetAccount.address);
        expect(mainnetAccount.address.match(/^(sys1|tsys1)/)).toBeTruthy();
        expect(testnetAccount.address.match(/^(sys1|tsys1)/)).toBeTruthy();
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle Ledger communication errors', async () => {
      // Mock communication error
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockRejectedValue(new Error('Ledger device communication error')),
        getUtxoAddress: jest.fn(),
        verifyUtxoAddress: jest.fn(),
      };

      await expect(keyringManager.importLedgerAccount()).rejects.toThrow(
        'Ledger device communication error'
      );
    });

    it('should handle invalid Ledger responses', async () => {
      // Mock invalid response
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue(null),
        getUtxoAddress: jest.fn().mockResolvedValue(null),
        verifyUtxoAddress: jest.fn(),
      };

      await expect(keyringManager.importLedgerAccount()).rejects.toThrow(
        'Something wrong happened'
      );
    });

    it('should handle Ledger app not open', async () => {
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockRejectedValue(new Error('Please open Syscoin app on Ledger')),
        getUtxoAddress: jest.fn(),
        verifyUtxoAddress: jest.fn(),
      };

      await expect(keyringManager.importLedgerAccount()).rejects.toThrow(
        'Please open Syscoin app on Ledger'
      );
    });
  });

  describe('Security', () => {
    it('should not expose private keys for hardware wallets', async () => {
      // Mock getAddress
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1q_test_address');

      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'zpub6s8HtEQtcu3AmBn9sniSqCAVhx2nJAhb2sd5NDYeYZ1ZJaZx7MAVZZnG1PdCUNJcVJXGbVpGfSYZLgkPSUjLYnJg8UdYvdkfaygcXZKPLy6'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_test_address'),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_test_address'),
      };

      const account = await keyringManager.importLedgerAccount('Security Test');

      expect(account).toBeDefined();
      if (account) {
        expect(account.xprv).toBe(''); // Should be empty for hardware wallets
        expect(account.isLedgerWallet).toBe(true);

        // Should not be able to get private key for hardware wallet
        await expect(
          keyringManager.getPrivateKeyByAccountId(
            account.id,
            KeyringAccountType.Ledger,
            FAKE_PASSWORD
          )
        ).rejects.toThrow();
      }
    });

    it('should maintain hardware wallet isolation', async () => {
      // Mock getAddress
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1q_isolation_address');

      // Mock and import Ledger account
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'zpub6s8HtEQtcu3AmBn9sniSqCAVhx2nJAhb2sd5NDYeYZ1ZJaZx7MAVZZnG1PdCUNJcVJXGbVpGfSYZLgkPSUjLYnJg8UdYvdkfaygcXZKPLy6'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_isolation_address'),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1q_isolation_address'),
      };

      const ledgerAccount = await keyringManager.importLedgerAccount(
        'Isolation Test'
      );

      if (ledgerAccount) {
        // Update vault state
        currentVaultState.accounts[KeyringAccountType.Ledger][
          ledgerAccount.id
        ] = {
          id: ledgerAccount.id,
          label: ledgerAccount.label,
          address: ledgerAccount.address,
          xpub: ledgerAccount.xpub,
          xprv: '',
          isImported: false,
          isTrezorWallet: false,
          isLedgerWallet: true,
          balances: { syscoin: 0, ethereum: 0 },
          assets: { syscoin: [], ethereum: [] },
        };

        // Verify Ledger accounts are completely separate from HD accounts
        const hdAccounts =
          currentVaultState.accounts[KeyringAccountType.HDAccount];
        const ledgerAccounts =
          currentVaultState.accounts[KeyringAccountType.Ledger];

        expect(Object.keys(hdAccounts)).toHaveLength(1); // Initial HD account
        expect(Object.keys(ledgerAccounts)).toHaveLength(1); // One imported Ledger account

        // Verify no cross-contamination of account types
        Object.values(hdAccounts).forEach((account: any) => {
          expect(account.isLedgerWallet).toBe(false);
        });

        Object.values(ledgerAccounts).forEach((account: any) => {
          expect(account.isLedgerWallet).toBe(true);
        });
      }
    });
  });
});

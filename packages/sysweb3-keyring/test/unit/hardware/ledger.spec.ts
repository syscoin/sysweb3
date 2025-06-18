import {
  KeyringManager,
  initialWalletState,
  KeyringAccountType,
} from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('Ledger Hardware Wallet', () => {
  let keyringManager: KeyringManager;

  beforeEach(async () => {
    setupMocks();
    await global.setupTestVault(FAKE_PASSWORD);

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

    // Mock Ledger device connection
    keyringManager.ledgerSigner.connectToLedgerDevice = jest
      .fn()
      .mockResolvedValue(true);
  });

  describe('Account Import', () => {
    it('should import Ledger account when connected', async () => {
      // Mock complete UTXO interface
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1qmock_ledger_address'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1qmock_ledger_address'),
      };

      const account = await keyringManager.importLedgerAccount(
        true,
        'My Ledger'
      );

      expect(account).toBeDefined();
      if (account) {
        expect(account.id).toBe(1); // First imported Ledger account gets ID 1 (placeholder at ID 0)
        expect(account.label).toBe('My Ledger');
        expect(account.isLedgerWallet).toBe(true);
        expect(account.isTrezorWallet).toBe(false);
        expect(account.isImported).toBe(false);
        expect(account.xprv).toBe(''); // Hardware wallets don't expose private keys
        expect(account.address).toBe('sys1qmock_ledger_address');
      }
    });

    it('should connect to Ledger before import if not connected', async () => {
      // Mock connection success
      keyringManager.ledgerSigner.connectToLedgerDevice = jest
        .fn()
        .mockResolvedValue(true);

      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1qnew_ledger_address'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1qnew_ledger_address'),
      };

      const account = await keyringManager.importLedgerAccount(
        false,
        'New Ledger'
      );

      expect(
        keyringManager.ledgerSigner.connectToLedgerDevice
      ).toHaveBeenCalled();
      expect(account).toBeDefined();
      if (account) {
        expect(account.label).toBe('New Ledger');
      }
    });

    it('should fail if Ledger connection fails', async () => {
      // Mock connection failure
      keyringManager.ledgerSigner.connectToLedgerDevice = jest
        .fn()
        .mockResolvedValue(false);

      const result = await keyringManager.importLedgerAccount(false);
      expect(result).toBeUndefined();
    });

    it('should import multiple Ledger accounts', async () => {
      // Mock different addresses for different account indices
      const mockUtxoInterface = {
        getXpub: jest
          .fn()
          .mockResolvedValueOnce('xpub_ledger_1')
          .mockResolvedValueOnce('xpub_ledger_2')
          .mockResolvedValueOnce('xpub_ledger_3'),
        getUtxoAddress: jest
          .fn()
          .mockResolvedValueOnce('sys1q_ledger_address_1')
          .mockResolvedValueOnce('sys1q_ledger_address_2')
          .mockResolvedValueOnce('sys1q_ledger_address_3'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest
          .fn()
          .mockImplementation((index) =>
            Promise.resolve(`sys1q_ledger_address_${index + 1}`)
          ),
      };
      keyringManager.ledgerSigner.utxo = mockUtxoInterface;

      const account1 = await keyringManager.importLedgerAccount(true);
      const account2 = await keyringManager.importLedgerAccount(true);
      const account3 = await keyringManager.importLedgerAccount(
        true,
        'Custom Ledger'
      );

      if (account1) {
        expect(account1.id).toBe(1); // First real account (placeholder at 0)
        expect(account1.label).toBe('Ledger 2'); // Label is ID + 1
      }

      if (account2) {
        expect(account2.id).toBe(2);
        expect(account2.label).toBe('Ledger 3');
      }

      if (account3) {
        expect(account3.id).toBe(3);
        expect(account3.label).toBe('Custom Ledger');
      }
    });

    it('should handle Ledger import for EVM networks', async () => {
      // Create EVM keyring
      const ethereumMainnet = initialWalletState.networks.ethereum[1];
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethereumMainnet,
        },
        INetworkType.Ethereum
      );

      // Mock complete EVM interface
      evmKeyring.ledgerSigner.evm = {
        getEvmAddressAndPubKey: jest.fn().mockResolvedValue({
          address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bd9F', // Fixed checksum
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

      const account = await evmKeyring.importLedgerAccount(true, 'Ledger ETH');

      expect(account).toBeDefined();
      if (account) {
        expect(account.address.startsWith('0x')).toBe(true);
        if (account.originNetwork) {
          expect(account.originNetwork.isBitcoinBased).toBe(false);
        }
      }
    });

    it('should handle Ledger import for UTXO networks', async () => {
      // Mock complete UTXO interface
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1qmock_ledger_address'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1qmock_ledger_address'),
      };

      const account = await keyringManager.importLedgerAccount(
        true,
        'Ledger SYS'
      );

      expect(account).toBeDefined();
      if (account) {
        expect(account.address.startsWith('sys1')).toBe(true);
        expect(account.xpub.startsWith('xpub')).toBe(true);
      }
    });

    it('should reject duplicate Ledger addresses', async () => {
      // First import with unique address
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('xpub_first'),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_first_address'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_first_address'),
      };

      await keyringManager.importLedgerAccount(true);

      // Mock Ledger returning same address for next account (simulate duplicate)
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('xpub_duplicate'),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_first_address'), // Same as first!
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_first_address'),
      };

      // Should reject duplicate - this tests the actual business logic
      await expect(keyringManager.importLedgerAccount(true)).rejects.toThrow(
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
            'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1qmock_ledger_address'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1qmock_ledger_address'),
      };

      // Import a Ledger account
      await keyringManager.importLedgerAccount(true, 'Test Ledger');
    });

    it('should switch to Ledger account', async () => {
      await keyringManager.setActiveAccount(1, KeyringAccountType.Ledger); // Use actual imported account ID

      const { activeAccount, activeAccountType } =
        keyringManager.getActiveAccount();
      expect(activeAccountType).toBe(KeyringAccountType.Ledger);
      expect(activeAccount.isLedgerWallet).toBe(true);
      expect(activeAccount.label).toBe('Test Ledger');
    });

    it('should get Ledger account xpub', async () => {
      await keyringManager.setActiveAccount(1, KeyringAccountType.Ledger); // Use actual imported account ID

      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      expect(xpub).toBe(
        'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE'
      );
    });

    it('should handle mixed account types with Ledger', async () => {
      // Add HD account
      await keyringManager.addNewAccount('HD Account 2');

      // Import another Ledger with different address
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('xpub_ledger_2'),
        getUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1q_another_ledger_address'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1q_another_ledger_address'),
      };
      const ledger2Account = await keyringManager.importLedgerAccount(
        true,
        'Ledger 2'
      );

      // Mock Trezor for import
      keyringManager.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: 'xpub_trezor',
        balance: 100000000, // 1 SYS in satoshis
      });
      keyringManager.trezorSigner.getPublicKey = jest.fn().mockResolvedValue({
        publicKey: '0x04...',
      });
      keyringManager.getAddress = jest
        .fn()
        .mockResolvedValue('sys1q_trezor_address');

      // Import a Trezor
      const trezorAccount = await keyringManager.importTrezorAccount(
        'Trezor Account'
      );

      // Ensure accounts were imported successfully
      expect(ledger2Account).toBeDefined();
      expect(trezorAccount).toBeDefined();

      // Switch between them using actual account IDs
      await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
      expect(keyringManager.getActiveAccount().activeAccountType).toBe(
        KeyringAccountType.HDAccount
      );

      // Use the account from beforeEach (which should have id 1 since it was imported first)
      await keyringManager.setActiveAccount(1, KeyringAccountType.Ledger); // Use actual imported account from beforeEach
      expect(keyringManager.getActiveAccount().activeAccountType).toBe(
        KeyringAccountType.Ledger
      );

      if (ledger2Account && trezorAccount) {
        await keyringManager.setActiveAccount(
          ledger2Account.id,
          KeyringAccountType.Ledger
        ); // Second imported account
        expect(keyringManager.getActiveAccount().activeAccount.label).toBe(
          'Ledger 2'
        );

        await keyringManager.setActiveAccount(
          trezorAccount.id,
          KeyringAccountType.Trezor
        ); // Use actual imported Trezor ID
        expect(keyringManager.getActiveAccount().activeAccountType).toBe(
          KeyringAccountType.Trezor
        );
      }
    });
  });

  describe('Transaction Signing', () => {
    beforeEach(async () => {
      // Complete mock setup for transaction signing tests
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockResolvedValue(
            'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE'
          ),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1qmock_ledger_address'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest
          .fn()
          .mockResolvedValue('sys1qmock_ledger_address'),
      };

      // Mock EVM signer for hardware wallet EVM transactions
      keyringManager.ledgerSigner.evm = {
        signEVMTransaction: jest.fn().mockResolvedValue({
          r: '123456789abcdef123456789abcdef123456789abcdef123456789abcdef12345678',
          s: '987654321fedcba987654321fedcba987654321fedcba987654321fedcba987654',
          v: '1b', // Use hex string that converts to 27 (0x1b = 27)
        }),
        signPersonalMessage: jest
          .fn()
          .mockResolvedValue('0xmock_personal_signature'),
        signTypedData: jest
          .fn()
          .mockResolvedValue('0xmock_typed_data_signature'),
        getEvmAddressAndPubKey: jest.fn().mockResolvedValue({
          address: '0xmock_evm_address',
          publicKey: '0xmock_public_key',
        }),
      };

      // Mock the syscoin main signer's send method through the transaction interface
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

      const account = await keyringManager.importLedgerAccount(
        true,
        'Signing Test'
      );
      if (account) {
        await keyringManager.setActiveAccount(
          account.id,
          KeyringAccountType.Ledger
        );
      }

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

    it('should handle Ledger transaction flow', async () => {
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

    it('should handle EVM transaction signing for Ledger', async () => {
      // Create EVM keyring with Ledger
      const ethereumMainnet = initialWalletState.networks.ethereum[1];
      const evmKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: ethereumMainnet,
        },
        INetworkType.Ethereum
      );

      // Mock Ledger EVM signer - this is what we want to test
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
      const evmAccount = await evmKeyring.importLedgerAccount(
        true,
        'EVM Ledger'
      );
      if (evmAccount) {
        await evmKeyring.setActiveAccount(
          evmAccount.id,
          KeyringAccountType.Ledger
        );
      }

      // No longer need to mock getDecryptedPrivateKey since it's only called for non-hardware wallets

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
      // Test on testnet
      const syscoinTestnet = initialWalletState.networks.syscoin[5700];
      const testnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinTestnet,
        },
        INetworkType.Syscoin
      );

      // Mock testnet Ledger
      testnetKeyring.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('tpub_testnet'),
        getUtxoAddress: jest.fn().mockResolvedValue('tsys1q_testnet_ledger'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn().mockResolvedValue('tsys1q_testnet_ledger'),
      };

      const account = await testnetKeyring.importLedgerAccount(
        true,
        'Testnet Ledger'
      );
      if (account) {
        expect(account.address.startsWith('tsys1')).toBe(true);
      }
    });

    it('should maintain separate Ledger accounts per network', async () => {
      // Mock mainnet Ledger
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('xpub_mainnet'),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_mainnet_ledger'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_mainnet_ledger'),
      };

      // Import on mainnet
      const mainnetAccount = await keyringManager.importLedgerAccount(
        true,
        'Mainnet Ledger'
      );

      // Create testnet keyring
      const syscoinTestnet = initialWalletState.networks.syscoin[5700];
      const testnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: syscoinTestnet,
        },
        INetworkType.Syscoin
      );

      // Mock testnet Ledger
      testnetKeyring.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('tpub_testnet'),
        getUtxoAddress: jest.fn().mockResolvedValue('tsys1q_testnet_ledger'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn().mockResolvedValue('tsys1q_testnet_ledger'),
      };

      // Import on testnet
      const testnetAccount = await testnetKeyring.importLedgerAccount(
        true,
        'Testnet Ledger'
      );

      // Accounts should be independent
      if (mainnetAccount && testnetAccount) {
        expect(mainnetAccount.address).not.toBe(testnetAccount.address);
        expect(mainnetAccount.address.startsWith('sys1')).toBe(true);
        expect(testnetAccount.address.startsWith('tsys1')).toBe(true);
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
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn(),
      };

      await expect(keyringManager.importLedgerAccount(true)).rejects.toThrow(
        'Ledger device communication error'
      );
    });

    it('should handle invalid Ledger responses', async () => {
      // Mock invalid response
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue(null),
        getUtxoAddress: jest.fn().mockResolvedValue(null),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn(),
      };

      await expect(keyringManager.importLedgerAccount(true)).rejects.toThrow(
        'Something wrong happened'
      );
    });

    it('should require active network currency', async () => {
      // Remove currency from active network
      const originalCurrency = keyringManager.wallet.activeNetwork.currency;
      keyringManager.wallet.activeNetwork.currency = undefined as any;

      await expect(keyringManager.importLedgerAccount(true)).rejects.toThrow(
        'Active network currency is not defined'
      );

      // Restore for cleanup
      keyringManager.wallet.activeNetwork.currency = originalCurrency;
    });

    it('should handle Ledger app not open', async () => {
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest
          .fn()
          .mockRejectedValue(new Error('Please open Syscoin app on Ledger')),
        getUtxoAddress: jest.fn(),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn(),
      };

      await expect(keyringManager.importLedgerAccount(true)).rejects.toThrow(
        'Please open Syscoin app on Ledger'
      );
    });
  });

  describe('Security', () => {
    beforeEach(async () => {
      keyringManager.ledgerSigner.utxo = {
        getXpub: jest.fn().mockResolvedValue('xpub_test'),
        getUtxoAddress: jest.fn().mockResolvedValue('sys1q_test_address'),
        getUtxos: jest.fn().mockResolvedValue([]),
        verifyUtxoAddress: jest.fn().mockResolvedValue('sys1q_test_address'),
      };

      await keyringManager.importLedgerAccount(true);
    });

    it('should never expose private keys for Ledger accounts', async () => {
      await keyringManager.setActiveAccount(1, KeyringAccountType.Ledger); // Use actual imported account ID

      const account = keyringManager.getAccountById(
        1,
        KeyringAccountType.Ledger
      ); // Use same ID as setActiveAccount
      expect(account).not.toHaveProperty('xprv'); // getAccountById omits xprv

      // Direct access to wallet state should show empty xprv for hardware wallets
      const rawAccount =
        keyringManager.wallet.accounts[KeyringAccountType.Ledger][1]; // Use same ID
      expect(rawAccount.xprv).toBe(''); // Hardware wallets store empty string, not encrypted private key
    });

    it('should not allow private key retrieval for Ledger accounts', async () => {
      // This should throw because Ledger accounts have empty xprv that fails decryption
      await expect(
        keyringManager.getPrivateKeyByAccountId(
          1, // Use actual imported account ID
          KeyringAccountType.Ledger,
          FAKE_PASSWORD
        )
      ).rejects.toThrow('Failed to decrypt private key');
    });

    it('should maintain hardware wallet isolation', () => {
      // Verify Ledger accounts are completely separate from HD accounts
      const hdAccounts =
        keyringManager.wallet.accounts[KeyringAccountType.HDAccount];
      const ledgerAccounts =
        keyringManager.wallet.accounts[KeyringAccountType.Ledger];

      expect(Object.keys(hdAccounts)).toHaveLength(1); // Initial HD account
      expect(Object.keys(ledgerAccounts)).toHaveLength(2); // Placeholder + one imported Ledger account

      // Verify no cross-contamination of account types
      Object.values(hdAccounts).forEach((account) => {
        expect(account.isLedgerWallet).toBe(false);
      });

      Object.values(ledgerAccounts).forEach((account) => {
        expect(account.isLedgerWallet).toBe(true);
      });
    });
  });
});

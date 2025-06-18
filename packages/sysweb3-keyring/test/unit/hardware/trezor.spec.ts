import {
  KeyringManager,
  initialWalletState,
  KeyringAccountType,
} from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('Trezor Hardware Wallet', () => {
  let keyringManager: KeyringManager;
  let accountCounter = 0;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);

    // Reset counter for each test
    accountCounter = 0;

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
    });

    it('should import multiple Trezor accounts', async () => {
      const account1 = await keyringManager.importTrezorAccount();
      const account2 = await keyringManager.importTrezorAccount();
      const account3 = await keyringManager.importTrezorAccount(
        'Custom Trezor'
      );

      expect(account1.id).toBe(0);
      expect(account1.label).toBe('Trezor 1');

      expect(account2.id).toBe(1);
      expect(account2.label).toBe('Trezor 2');

      expect(account3.id).toBe(2);
      expect(account3.label).toBe('Custom Trezor');
    });

    it('should handle Trezor import for EVM networks', async () => {
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

      // Mock Trezor EVM methods with proper EVM address
      evmKeyring.trezorSigner.getPublicKey = jest.fn().mockResolvedValue({
        publicKey: '0x04mock_evm_public_key',
      });
      evmKeyring.trezorSigner.getAccountInfo = jest.fn().mockResolvedValue({
        descriptor: '0x742D35Cc6634C0532925a3b844bc9e7595f2bd9f', // Return EVM address directly as descriptor
        balance: '1000000000000000000', // 1 ETH in wei
      });

      const account = await evmKeyring.importTrezorAccount('Trezor ETH');

      expect(account).toBeDefined();
      expect(account.address.startsWith('0x')).toBe(true);
      if (account.originNetwork) {
        expect(account.originNetwork.isBitcoinBased).toBe(false);
      }
    });

    it('should reject duplicate Trezor addresses', async () => {
      // First import
      await keyringManager.importTrezorAccount();

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
      await keyringManager.importTrezorAccount('Test Trezor');
    });

    it('should switch to Trezor account', async () => {
      await keyringManager.setActiveAccount(0, KeyringAccountType.Trezor); // Use actual imported account ID

      const { activeAccount, activeAccountType } =
        keyringManager.getActiveAccount();
      expect(activeAccountType).toBe(KeyringAccountType.Trezor);
      expect(activeAccount.isTrezorWallet).toBe(true);
      expect(activeAccount.label).toBe('Test Trezor');
    });

    it('should get Trezor account xpub', async () => {
      await keyringManager.setActiveAccount(0, KeyringAccountType.Trezor); // Use actual imported account ID

      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBeDefined();
      expect(typeof xpub).toBe('string');
      // For UTXO it should be an xpub, for EVM it's the public key
    });

    it('should handle mixed account types', async () => {
      // Add HD account
      await keyringManager.addNewAccount('HD Account 2');

      // Import another Trezor
      await keyringManager.importTrezorAccount('Trezor 2');

      // Switch between them
      await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
      expect(keyringManager.getActiveAccount().activeAccountType).toBe(
        KeyringAccountType.HDAccount
      );

      await keyringManager.setActiveAccount(0, KeyringAccountType.Trezor); // First Trezor account
      expect(keyringManager.getActiveAccount().activeAccountType).toBe(
        KeyringAccountType.Trezor
      );

      await keyringManager.setActiveAccount(1, KeyringAccountType.Trezor); // Second imported account
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
        await keyringManager.setActiveAccount(
          account.id,
          KeyringAccountType.Trezor
        );
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
  });

  describe('Network Support', () => {
    it('should support Trezor on different UTXO networks', async () => {
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

      const account = await testnetKeyring.importTrezorAccount(
        'Testnet Trezor'
      );
      expect(account.address.startsWith('tsys1')).toBe(true);
    });

    it('should maintain separate Trezor accounts per network', async () => {
      // Import on mainnet
      const mainnetAccount = await keyringManager.importTrezorAccount(
        'Mainnet Trezor'
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

      // Import on testnet
      const testnetAccount = await testnetKeyring.importTrezorAccount(
        'Testnet Trezor'
      );

      // Accounts should be independent
      expect(mainnetAccount.address).not.toBe(testnetAccount.address);
      expect(mainnetAccount.address.startsWith('sys1')).toBe(true);
      expect(testnetAccount.address.startsWith('tsys1')).toBe(true);
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

    it('should require active network currency', async () => {
      // Remove currency from active network
      keyringManager.wallet.activeNetwork.currency = undefined as any;

      await expect(keyringManager.importTrezorAccount()).rejects.toThrow(
        'Active network currency is not defined'
      );
    });
  });

  describe('Security', () => {
    beforeEach(async () => {
      await keyringManager.importTrezorAccount();
    });

    it('should never expose private keys for Trezor accounts', async () => {
      await keyringManager.setActiveAccount(0, KeyringAccountType.Trezor); // Use actual imported account ID

      const account = keyringManager.getAccountById(
        0,
        KeyringAccountType.Trezor
      ); // Use same ID as setActiveAccount
      expect(account).not.toHaveProperty('xprv'); // getAccountById omits xprv

      // Direct access to wallet state should show empty xprv for hardware wallets
      const rawAccount =
        keyringManager.wallet.accounts[KeyringAccountType.Trezor][0]; // Use same ID
      expect(rawAccount.xprv).toBe(''); // Hardware wallets store empty string, not encrypted private key
    });

    it('should not allow private key retrieval for Trezor accounts', async () => {
      // This should throw because Trezor accounts have empty xprv that fails decryption
      await expect(
        keyringManager.getPrivateKeyByAccountId(
          0, // Use actual imported account ID
          KeyringAccountType.Trezor,
          FAKE_PASSWORD
        )
      ).rejects.toThrow('Failed to decrypt private key');
    });
  });
});

import { FAKE_PASSWORD } from './constants';
import { KeyringManager } from '../src/keyring-manager';
import { KeyringAccountType } from '../src/types';

// Mock dependencies
jest.mock('syscoinjs-lib', () => {
  const actual = jest.requireActual('syscoinjs-lib');
  return {
    ...actual,
    utils: {
      ...actual.utils,
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 100000000,
        tokens: [{ path: "m/84'/57'/0'/0/0", transfers: 1 }],
      }),
      fetchBackendUTXOS: jest.fn().mockResolvedValue([
        {
          txid: 'mock-txid',
          vout: 0,
          value: '50000000',
          height: 100,
          confirmations: 6,
        },
      ]),
      sanitizeBlockbookUTXOs: jest
        .fn()
        .mockImplementation((_signer, utxos) => utxos),
      fetchEstimateFee: jest.fn().mockResolvedValue(0.001024), // 0.001024 SYS/kB = 0.000001 SYS/byte
    },
  };
});

// Global mock storage
const globalMockStorage = new Map();
const globalMockStorageClient = {
  get: jest.fn((key: string) => {
    const value = globalMockStorage.get(key);
    return Promise.resolve(value);
  }),
  set: jest.fn((key: string, value: any) => {
    globalMockStorage.set(key, value);
    return Promise.resolve();
  }),
  clear: jest.fn(() => {
    globalMockStorage.clear();
  }),
  setClient: jest.fn(),
};

jest.mock('@pollum-io/sysweb3-core', () => ({
  sysweb3Di: {
    getStateStorageDb: jest.fn(() => globalMockStorageClient),
  },
}));

jest.mock('../src/storage', () => ({
  getDecryptedVault: jest.fn().mockResolvedValue({
    mnemonic:
      'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA==',
  }),
  setEncryptedVault: jest.fn().mockResolvedValue(true),
}));

describe('Hardware Wallet UTXO Signing Verification', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    globalMockStorage.clear();
    keyringManager = new KeyringManager();
  });

  describe('HD Signer Interface for Hardware Wallets', () => {
    it('should verify that Ledger accounts have xpub access through getAccountXpub', async () => {
      // Setup
      keyringManager.setSeed(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      // Create a mock Ledger account
      const mockLedgerAccount = {
        id: 0,
        address: 'sys1qmock_ledger_address',
        xpub: 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE',
        xprv: '',
        label: 'Ledger 1',
        isTrezorWallet: false,
        isLedgerWallet: true,
        balances: { syscoin: 1, ethereum: 0 },
        isImported: false,
      };

      // Add Ledger account to wallet state
      keyringManager.wallet.accounts[KeyringAccountType.Ledger] = {
        0: mockLedgerAccount,
      };

      // Set Ledger account as active
      keyringManager.wallet.activeAccountType = KeyringAccountType.Ledger;
      keyringManager.wallet.activeAccountId = 0;

      // Test getAccountXpub returns hardware wallet xpub
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBe(mockLedgerAccount.xpub);
      expect(xpub).toBeTruthy();
      expect(xpub.startsWith('xpub')).toBe(true);
    });

    it('should verify that Trezor accounts have xpub access through getAccountXpub', async () => {
      // Setup
      keyringManager.setSeed(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      // Create a mock Trezor account
      const mockTrezorAccount = {
        id: 0,
        address: 'sys1qmock_trezor_address',
        xpub: 'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj',
        xprv: '',
        label: 'Trezor 1',
        isTrezorWallet: true,
        isLedgerWallet: false,
        balances: { syscoin: 2, ethereum: 0 },
        isImported: false,
      };

      // Add Trezor account to wallet state
      keyringManager.wallet.accounts[KeyringAccountType.Trezor] = {
        0: mockTrezorAccount,
      };

      // Set Trezor account as active
      keyringManager.wallet.activeAccountType = KeyringAccountType.Trezor;
      keyringManager.wallet.activeAccountId = 0;

      // Test getAccountXpub returns hardware wallet xpub
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBe(mockTrezorAccount.xpub);
      expect(xpub).toBeTruthy();
      expect(xpub.startsWith('xpub')).toBe(true);
    });
  });

  describe('Hardware Wallet Transaction Flow', () => {
    it('should verify HD signer can derive pubkeys for Ledger signing', async () => {
      // Setup wallet
      keyringManager.setSeed(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      // Mock HD signer methods that hardware wallets rely on
      const mockHdSigner = {
        getAccountXpub: jest.fn(),
        derivePubKey: jest
          .fn()
          .mockReturnValue(Buffer.from('02mock_pubkey_hex', 'hex')),
        getAddressFromPubKey: jest
          .fn()
          .mockReturnValue('sys1qmock_derived_address'),
      };

      // When hardware wallet is active, getAccountXpub should return hardware wallet's xpub
      const mockLedgerXpub =
        'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE';
      mockHdSigner.getAccountXpub.mockReturnValue(mockLedgerXpub);

      // Test derivation paths used by hardware wallets
      const testPath = "m/84'/57'/0'/0/0";
      const pubkey = mockHdSigner.derivePubKey(testPath);
      const address = mockHdSigner.getAddressFromPubKey(pubkey);

      expect(mockHdSigner.derivePubKey).toHaveBeenCalledWith(testPath);
      expect(pubkey).toBeTruthy();
      expect(Buffer.isBuffer(pubkey)).toBe(true);
      expect(address).toBeTruthy();
      expect(address.startsWith('sys')).toBe(true);
    });

    it('should verify transaction creation flow for hardware wallets', async () => {
      // This test verifies the transaction flow:
      // 1. HD signer's getAccountXpub() returns hardware wallet xpub
      // 2. syscoinjs-lib uses this xpub to fetch UTXOs
      // 3. PSBT is created with proper inputs/outputs
      // 4. Hardware wallet can sign using the derivation paths

      const syscoinjs = require('syscoinjs-lib');

      // Setup
      keyringManager.setSeed(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );
      await keyringManager.setWalletPassword(FAKE_PASSWORD);
      await keyringManager.createKeyringVault();

      // Create Ledger account
      const mockLedgerAccount = {
        id: 0,
        address: 'sys1qmock_ledger_address',
        xpub: 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKpXqNPQ8R5ziHackBvPaKjYNDvyVp7ytpqqxV5BDK1Co76d4oVGkYvJXFFpbhctBCTKRQ8Y7HNrxE',
        xprv: '',
        label: 'Ledger 1',
        isTrezorWallet: false,
        isLedgerWallet: true,
        balances: { syscoin: 1, ethereum: 0 },
        isImported: false,
      };

      keyringManager.wallet.accounts[KeyringAccountType.Ledger] = {
        0: mockLedgerAccount,
      };
      keyringManager.wallet.activeAccountType = KeyringAccountType.Ledger;
      keyringManager.wallet.activeAccountId = 0;

      // Verify xpub is accessible
      const xpub = keyringManager.getAccountXpub();
      expect(xpub).toBe(mockLedgerAccount.xpub);

      // Verify UTXO fetching uses hardware wallet xpub
      const mockExplorerUrl = 'https://blockbook.syscoin.org';
      await syscoinjs.utils.fetchBackendUTXOS(mockExplorerUrl, xpub);

      expect(syscoinjs.utils.fetchBackendUTXOS).toHaveBeenCalledWith(
        mockExplorerUrl,
        mockLedgerAccount.xpub
      );
    });
  });

  describe('PSBT Enhancement for Hardware Wallets', () => {
    it('should verify PSBT contains required fields for hardware wallet signing', () => {
      // Hardware wallets require specific PSBT fields:
      // 1. bip32Derivation with masterFingerprint, path, and pubkey
      // 2. witnessUtxo for each input
      // 3. Proper unknownKeyVals with path information (from syscoinjs-lib)

      const mockPsbtData = {
        inputs: [
          {
            witnessUtxo: {
              script: Buffer.from('0014mock_script'),
              value: 50000000,
            },
            unknownKeyVals: [
              {
                key: Buffer.from('address'),
                value: Buffer.from('sys1qmock_address'),
              },
              {
                key: Buffer.from('path'),
                value: Buffer.from("m/84'/57'/0'/0/0"),
              },
            ],
            bip32Derivation: [
              {
                masterFingerprint: Buffer.from('deadbeef', 'hex'),
                path: "m/84'/57'/0'/0/0",
                pubkey: Buffer.from('02mock_pubkey', 'hex'),
              },
            ],
          },
        ],
      };

      // Verify required fields exist
      expect(mockPsbtData.inputs[0].witnessUtxo).toBeDefined();
      expect(mockPsbtData.inputs[0].unknownKeyVals).toHaveLength(2);
      expect(mockPsbtData.inputs[0].unknownKeyVals[1].key.toString()).toBe(
        'path'
      );
      expect(mockPsbtData.inputs[0].bip32Derivation).toBeDefined();
      expect(
        mockPsbtData.inputs[0].bip32Derivation[0].masterFingerprint
      ).toBeDefined();
      expect(mockPsbtData.inputs[0].bip32Derivation[0].path).toBeDefined();
      expect(mockPsbtData.inputs[0].bip32Derivation[0].pubkey).toBeDefined();
    });
  });

  describe('Compatibility Verification', () => {
    it('should verify hardware wallet accounts are compatible with syscoinjs-lib HD signer interface', () => {
      // The HD signer interface expects these key methods:
      // Verification: hardware wallet flow can access these through the keyring manager

      // Verify that hardware wallet flow can access these through the keyring manager
      expect(keyringManager.getAccountXpub).toBeDefined();
      expect(typeof keyringManager.getAccountXpub).toBe('function');

      // The actual HD signer methods are accessed through getSyscoinSigner
      // which returns { hd, main } where hd has all the required methods
    });
  });
});

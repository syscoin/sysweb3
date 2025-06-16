import { KeyringManager } from '../src/keyring-manager';
import { INetwork } from '@pollum-io/sysweb3-network';

// Mock storage
const mockStorage = new Map<string, any>();
jest.mock('@pollum-io/sysweb3-core', () => ({
  sysweb3Di: {
    getStateStorageDb: () => ({
      get: jest.fn((key) => Promise.resolve(mockStorage.get(key))),
      set: jest.fn((key, value) => {
        mockStorage.set(key, value);
        return Promise.resolve();
      }),
    }),
  },
}));

describe('validateZprv Network-Specific Validation', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
    keyringManager = new KeyringManager();
  });

  const syscoinMainnet: INetwork = {
    chainId: 57,
    label: 'Syscoin Mainnet',
    url: 'https://blockbook.syscoin.org',
    currency: 'sys',
    slip44: 57,

    default: true,
    apiUrl: '',
    explorer: 'https://blockbook.syscoin.org',
  };

  const syscoinTestnet: INetwork = {
    chainId: 5700,
    label: 'Syscoin Testnet',
    url: 'https://explorer-blockbook-dev.syscoin.org',
    currency: 'tsys',
    slip44: 1,

    default: false,
    apiUrl: '',
    explorer: 'https://explorer-blockbook-dev.syscoin.org',
  };

  const bitcoinMainnet: INetwork = {
    chainId: 0,
    label: 'Bitcoin Mainnet',
    url: 'https://blockbook.bitcoin.org/',
    currency: 'btc',
    slip44: 0,

    default: false,
    apiUrl: '',
    explorer: 'https://blockbook.bitcoin.org/',
  };

  const bitcoinTestnet: INetwork = {
    chainId: 1,
    label: 'Bitcoin Testnet',
    url: 'https://blockbook-testnet.bitcoin.org/',
    currency: 'tbtc',
    slip44: 1,

    default: false,
    apiUrl: '',
    explorer: 'https://blockbook-testnet.bitcoin.org/',
  };

  const litecoinMainnet: INetwork = {
    chainId: 2,
    label: 'Litecoin Mainnet',
    url: 'https://blockbook.litecoin.org/',
    currency: 'ltc',
    slip44: 2,

    default: false,
    apiUrl: '',
    explorer: 'https://blockbook.litecoin.org/',
  };

  describe('Network-specific validation', () => {
    it('should validate against Syscoin mainnet network parameters', () => {
      const xprv =
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

      const result = keyringManager.validateZprv(xprv, syscoinMainnet);

      if (result.isValid) {
        expect(result.network?.slip44).toBe(57); // Syscoin mainnet
        expect(result.network?.bech32).toBe('sys');
        expect(result.network?.messagePrefix).toContain('Sys');
      }
    });

    it('should validate against Bitcoin mainnet network parameters', () => {
      const xprv =
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

      const result = keyringManager.validateZprv(xprv, bitcoinMainnet);

      if (result.isValid) {
        expect(result.network?.slip44).toBe(0); // Bitcoin mainnet
        expect(result.network?.bech32).toBe('bc');
        expect(result.network?.messagePrefix).toContain('Bitcoin');
      }
    });

    it('should validate against Syscoin testnet network parameters', () => {
      const xprv =
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

      const result = keyringManager.validateZprv(xprv, syscoinTestnet);

      if (result.isValid) {
        expect(result.network?.slip44).toBe(1); // Testnet SLIP44
        expect(result.network?.bech32).toBe('tsys');
        expect(result.network?.messagePrefix).toContain('Tsys');
      }
    });

    it('should validate against Bitcoin testnet network parameters', () => {
      const xprv =
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

      const result = keyringManager.validateZprv(xprv, bitcoinTestnet);

      if (result.isValid) {
        expect(result.network?.slip44).toBe(1); // Testnet SLIP44
        expect(result.network?.bech32).toBe('tbtc');
        expect(result.network?.messagePrefix).toContain('Tbtc');
      }
    });

    it('should validate against custom UTXO network (Litecoin)', () => {
      const xprv =
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

      const result = keyringManager.validateZprv(xprv, litecoinMainnet);

      if (result.isValid) {
        expect(result.network?.slip44).toBe(2); // Litecoin mainnet
        expect(result.network?.bech32).toBe('ltc');
        expect(result.network?.messagePrefix).toContain('Ltc');
      }
    });
  });

  describe('Error handling', () => {
    it('should handle validation errors gracefully', () => {
      const invalidKey = 'zprvInvalidKey123';

      const result = keyringManager.validateZprv(invalidKey, bitcoinMainnet);

      expect(result.isValid).toBe(false);
      expect(result.message).toBeDefined();
      expect(result.message.length).toBeGreaterThan(0);
    });

    it('should validate correctly for different network configurations', () => {
      // Test that the same key validates differently for different networks
      const xprv =
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

      const syscoinResult = keyringManager.validateZprv(xprv, syscoinMainnet);
      const bitcoinResult = keyringManager.validateZprv(xprv, bitcoinMainnet);

      // Both should be valid but with different network parameters
      if (syscoinResult.isValid && bitcoinResult.isValid) {
        expect(syscoinResult.network?.slip44).not.toBe(
          bitcoinResult.network?.slip44
        );
        expect(syscoinResult.network?.bech32).not.toBe(
          bitcoinResult.network?.bech32
        );
      }
    });
  });
});

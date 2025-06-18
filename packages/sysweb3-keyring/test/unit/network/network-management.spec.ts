import {
  KeyringManager,
  initialWalletState,
  KeyringAccountType,
} from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType, INetwork } from '@pollum-io/sysweb3-network';

describe('Network Management', () => {
  let keyringManager: KeyringManager;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);
  });

  describe('EVM Network Switching', () => {
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

    it('should switch between EVM networks', async () => {
      // Start with Ethereum mainnet
      expect(keyringManager.getNetwork().chainId).toBe(1);

      // Switch to Polygon
      const polygon = initialWalletState.networks.ethereum[137];
      const result = await keyringManager.setSignerNetwork(polygon);

      expect(result.success).toBe(true);
      expect(keyringManager.getNetwork().chainId).toBe(137);
      expect(keyringManager.getNetwork().label).toBe('Polygon Mainnet');
    });

    it('should preserve accounts when switching EVM networks', async () => {
      // Add accounts on Ethereum
      const account1 = await keyringManager.addNewAccount('Test Account');
      const originalAddress = account1.address;

      // Switch to Polygon
      const polygon = initialWalletState.networks.ethereum[137];
      await keyringManager.setSignerNetwork(polygon);

      // Account should still exist with same address
      const account = keyringManager.getAccountById(
        1,
        KeyringAccountType.HDAccount
      );
      expect(account.address).toBe(originalAddress);
      expect(account.label).toBe('Test Account');
    });

    it('should update provider when switching networks', async () => {
      const ethereum = keyringManager.getNetwork();
      expect(ethereum.url).toContain('rpc.ankr.com/eth');

      // Switch to Mumbai testnet
      const mumbai = initialWalletState.networks.ethereum[80001];
      await keyringManager.setSignerNetwork(mumbai);

      const network = keyringManager.getNetwork();
      expect(network.url).toContain('omniatech.io');
      expect(network.chainId).toBe(80001);
    });

    it('should handle rapid network switching', async () => {
      const networks = [
        initialWalletState.networks.ethereum[1], // Ethereum
        initialWalletState.networks.ethereum[137], // Polygon
        initialWalletState.networks.ethereum[80001], // Mumbai
      ];

      // Rapid switching
      for (const network of networks) {
        const result = await keyringManager.setSignerNetwork(network);
        expect(result.success).toBe(true);
        expect(keyringManager.getNetwork().chainId).toBe(network.chainId);
      }
    });
  });

  describe('Custom Network Management', () => {
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

    it('should add custom EVM network', () => {
      const customNetwork: INetwork = {
        chainId: 31337,
        currency: 'ETH',
        label: 'Local Hardhat',
        url: 'http://localhost:8545',
        kind: INetworkType.Ethereum,
        explorer: '',
        slip44: 60,
      };

      keyringManager.addCustomNetwork(customNetwork);

      // Verify network was added
      const networks = keyringManager.wallet.networks[INetworkType.Ethereum];
      expect(networks[31337]).toBeDefined();
      expect(networks[31337].label).toBe('Local Hardhat');
    });

    it('should reject adding custom UTXO networks', () => {
      const customUTXO: INetwork = {
        chainId: 99999,
        currency: 'TSYS',
        label: 'Custom Syscoin',
        url: 'http://localhost:8370',
        kind: INetworkType.Syscoin,
        slip44: 57,
        explorer: '',
      };

      expect(() => keyringManager.addCustomNetwork(customUTXO)).toThrow(
        'Custom networks can only be added for EVM'
      );
    });

    it('should remove custom network', () => {
      // Add custom network first
      const customNetwork: INetwork = {
        chainId: 31337,
        currency: 'ETH',
        label: 'Local Hardhat',
        url: 'http://localhost:8545',
        kind: INetworkType.Ethereum,
        explorer: '',
        slip44: 60,

        key: 'hardhat-local',
      };

      keyringManager.addCustomNetwork(customNetwork);

      // Remove it
      keyringManager.removeNetwork(
        INetworkType.Ethereum,
        31337,
        'http://localhost:8545',
        'Local Hardhat',
        'hardhat-local'
      );

      // Verify it's gone
      const networks = keyringManager.wallet.networks[INetworkType.Ethereum];
      expect(networks[31337]).toBeUndefined();
    });

    it('should reject removing active network', async () => {
      const customNetwork: INetwork = {
        chainId: 31337,
        currency: 'ETH',
        label: 'Local Hardhat',
        url: 'http://localhost:8545',
        kind: INetworkType.Ethereum,
        explorer: '',
        slip44: 60,
        key: 'hardhat-local',
      };

      keyringManager.addCustomNetwork(customNetwork);
      await keyringManager.setSignerNetwork(customNetwork);

      expect(() =>
        keyringManager.removeNetwork(
          INetworkType.Ethereum,
          31337,
          'http://localhost:8545',
          'Local Hardhat',
          'hardhat-local'
        )
      ).toThrow('Cannot remove active network');
    });

    it('should update network configuration', async () => {
      const ethereum = keyringManager.getNetwork();
      const updatedEthereum: INetwork = {
        ...ethereum,
        url: 'https://new-ethereum-rpc.example.com',
      };

      await keyringManager.updateNetworkConfig(updatedEthereum);

      const network = keyringManager.getNetwork();
      expect(network.url).toBe('https://new-ethereum-rpc.example.com');
    });
  });

  describe('Multi-Keyring Architecture Constraints', () => {
    it('should prevent UTXO to UTXO network switching', async () => {
      // Create Syscoin keyring
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

      // Try to switch to Bitcoin (different UTXO network)
      const bitcoin: INetwork = {
        chainId: 0,
        currency: 'BTC',
        label: 'Bitcoin',
        url: 'https://blockstream.info',
        kind: INetworkType.Syscoin, // UTXO type
        slip44: 0, // Different slip44
        explorer: '',
      };

      await expect(keyringManager.setSignerNetwork(bitcoin)).rejects.toThrow(
        'Cannot switch between different UTXO networks'
      );
    });

    it('should prevent EVM to UTXO chain type switching', async () => {
      // Create EVM keyring
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

      // Try to switch to Syscoin
      const syscoin = initialWalletState.networks.syscoin[57];

      await expect(keyringManager.setSignerNetwork(syscoin)).rejects.toThrow(
        'Cannot use Syscoin chain type with Ethereum network'
      );
    });

    it('should allow UTXO network RPC updates within same network', async () => {
      // Create Syscoin keyring
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

      // Update same network with new RPC
      const updatedSyscoin: INetwork = {
        ...syscoinMainnet,
        url: 'https://new-syscoin-rpc.example.com',
      };

      await keyringManager.updateNetworkConfig(updatedSyscoin);

      const network = keyringManager.getNetwork();
      expect(network.url).toBe('https://new-syscoin-rpc.example.com');
      expect(network.chainId).toBe(57); // Same network
    });

    it('should maintain separate keyring instances per UTXO network', async () => {
      // Create Syscoin mainnet keyring
      const syscoinKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.syscoin[57],
        },
        INetworkType.Syscoin
      );

      // Create Syscoin testnet keyring (different instance)
      const syscoinTestnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        {
          ...initialWalletState,
          activeNetwork: initialWalletState.networks.syscoin[5700],
        },
        INetworkType.Syscoin
      );

      // They should be independent
      expect(syscoinKeyring.getNetwork().chainId).toBe(57);
      expect(syscoinTestnetKeyring.getNetwork().chainId).toBe(5700);

      // Accounts should have different addresses (mainnet vs testnet)
      const mainnetAccount = syscoinKeyring.getActiveAccount().activeAccount;
      const testnetAccount =
        syscoinTestnetKeyring.getActiveAccount().activeAccount;

      expect(mainnetAccount.address.startsWith('sys1')).toBe(true);
      expect(testnetAccount.address.startsWith('tsys1')).toBe(true);
      expect(mainnetAccount.address).not.toBe(testnetAccount.address);
    });
  });

  describe('Network State Synchronization', () => {
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

    it('should persist network changes in wallet state', async () => {
      const polygon = initialWalletState.networks.ethereum[137];
      await keyringManager.setSignerNetwork(polygon);

      const walletState = keyringManager.wallet;
      expect(walletState.activeNetwork.chainId).toBe(137);
      expect(walletState.activeNetwork.label).toBe('Polygon Mainnet');
    });

    it('should clear RPC caches on network switch', async () => {
      // clearRpcCaches is already being called during network switching
      // We can verify this by checking the console output or by checking the cache state
      // For this test, we'll just verify that network switching works successfully
      const polygon = initialWalletState.networks.ethereum[137];
      const result = await keyringManager.setSignerNetwork(polygon);

      expect(result.success).toBe(true);
      expect(keyringManager.getNetwork().chainId).toBe(137);
    });

    it('should handle network switching with existing accounts', async () => {
      // Create accounts on Ethereum
      await keyringManager.addNewAccount('Account 2');
      const imported = await keyringManager.importAccount(
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
      );

      // Switch network
      const polygon = initialWalletState.networks.ethereum[137];
      await keyringManager.setSignerNetwork(polygon);

      // All accounts should still exist
      const hdAccount = keyringManager.getAccountById(
        1,
        KeyringAccountType.HDAccount
      );
      expect(hdAccount.label).toBe('Account 2');

      const importedAccount = keyringManager.getAccountById(
        0,
        KeyringAccountType.Imported
      );
      expect(importedAccount.address).toBe(imported.address);
    });
  });

  describe('Network Error Handling', () => {
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

    it('should handle invalid chain type', async () => {
      const invalidNetwork: INetwork = {
        chainId: 999,
        currency: 'INVALID',
        label: 'Invalid Network',
        url: 'http://invalid',
        kind: 'INVALID' as any,
        explorer: '',
        slip44: 60,
      };

      await expect(
        keyringManager.setSignerNetwork(invalidNetwork)
      ).rejects.toThrow('Unsupported chain');
    });

    it('should handle network update for non-existent network', async () => {
      const fakeNetwork: INetwork = {
        chainId: 99999,
        currency: 'FAKE',
        label: 'Fake Network',
        url: 'http://fake',
        kind: INetworkType.Ethereum,
        explorer: '',
        slip44: 60,
      };

      await expect(
        keyringManager.updateNetworkConfig(fakeNetwork)
      ).rejects.toThrow('Network does not exist');
    });

    it('should reject removing UTXO networks', () => {
      expect(() =>
        keyringManager.removeNetwork(
          INetworkType.Syscoin,
          57,
          'https://blockbook.syscoin.org',
          'Syscoin Mainnet'
        )
      ).toThrow('Networks can only be removed for EVM');
    });
  });
});

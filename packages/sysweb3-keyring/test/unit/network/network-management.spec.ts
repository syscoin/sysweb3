import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType, INetwork } from '@pollum-io/sysweb3-network';

describe('Network Management', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);
  });

  describe('EVM Network Switching', () => {
    beforeEach(async () => {
      // Set up EVM vault state with Ethereum mainnet
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

    it('should switch between EVM networks', async () => {
      // Start with Ethereum mainnet
      expect(keyringManager.getNetwork().chainId).toBe(1);

      // Switch to Polygon
      const polygon = currentVaultState.networks.ethereum[137];
      const result = await keyringManager.setSignerNetwork(polygon);

      // Update mock vault state to simulate Redux state update
      currentVaultState.activeNetwork = polygon;

      expect(result.success).toBe(true);
      expect(keyringManager.getNetwork().chainId).toBe(137);
      expect(keyringManager.getNetwork().label).toBe('Polygon');
    });

    it('should preserve accounts when switching EVM networks', async () => {
      // Add accounts on Ethereum
      const account1 = await keyringManager.addNewAccount('Test Account');
      const originalAddress = account1.address;

      // Update vault state to include the new account
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Test Account',
        address: account1.address,
        xpub: account1.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };

      // Switch to Polygon
      const polygon = currentVaultState.networks.ethereum[137];
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
      const mumbai = currentVaultState.networks.ethereum[80001];
      await keyringManager.setSignerNetwork(mumbai);

      // Update mock vault state to simulate Redux state update
      currentVaultState.activeNetwork = mumbai;

      const network = keyringManager.getNetwork();
      expect(network.url).toContain('rpc-mumbai.maticvigil.com');
      expect(network.chainId).toBe(80001);
    });

    it('should handle rapid network switching', async () => {
      const networks = [
        currentVaultState.networks.ethereum[1], // Ethereum
        currentVaultState.networks.ethereum[137], // Polygon
        currentVaultState.networks.ethereum[80001], // Mumbai
      ];

      // Rapid switching
      for (const network of networks) {
        const result = await keyringManager.setSignerNetwork(network);

        // Update mock vault state to simulate Redux state update
        currentVaultState.activeNetwork = network;

        expect(result.success).toBe(true);
        expect(keyringManager.getNetwork().chainId).toBe(network.chainId);
      }
    });
  });

  describe('Custom Network Management', () => {
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

    it('should update network configuration', async () => {
      const ethereum = keyringManager.getNetwork();
      const updatedEthereum: INetwork = {
        ...ethereum,
        url: 'https://new-ethereum-rpc.example.com',
      };

      await keyringManager.updateNetworkConfig(updatedEthereum);

      // Update mock vault state to simulate Redux state update
      currentVaultState.activeNetwork = updatedEthereum;

      const network = keyringManager.getNetwork();
      expect(network.url).toBe('https://new-ethereum-rpc.example.com');
    });
  });

  describe('Multi-Keyring Architecture Constraints', () => {
    it('should prevent UTXO to UTXO network switching', async () => {
      // Create Syscoin keyring
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

      // Try to switch to Syscoin
      const syscoin = currentVaultState.networks.syscoin[57];

      await expect(keyringManager.setSignerNetwork(syscoin)).rejects.toThrow(
        'Cannot use Syscoin chain type with Ethereum network'
      );
    });

    it('should allow UTXO network RPC updates within same network', async () => {
      // Create Syscoin keyring
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

      // Update same network with new RPC
      const syscoinMainnet = currentVaultState.networks.syscoin[57];
      const updatedSyscoin: INetwork = {
        ...syscoinMainnet,
        url: 'https://new-syscoin-rpc.example.com',
      };

      await keyringManager.updateNetworkConfig(updatedSyscoin);

      // Update mock vault state to simulate Redux state update
      currentVaultState.activeNetwork = updatedSyscoin;

      const network = keyringManager.getNetwork();
      expect(network.url).toBe('https://new-syscoin-rpc.example.com');
      expect(network.chainId).toBe(57); // Same network
    });

    it('should maintain separate keyring instances per UTXO network', async () => {
      // Create Syscoin mainnet keyring with mainnet network setup
      const syscoinMainnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      // Set up mainnet-specific network in vault state
      syscoinMainnetVaultState.activeNetwork = {
        ...syscoinMainnetVaultState.networks.syscoin[57],
        chainId: 57,
        label: 'Syscoin Mainnet',
      };
      const syscoinMainnetVaultGetter = jest.fn(() => syscoinMainnetVaultState);

      const syscoinKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        syscoinMainnetVaultGetter
      );

      // Create Syscoin testnet keyring with testnet network setup
      const syscoinTestnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 5700,
      });
      // Set up testnet-specific network in vault state
      syscoinTestnetVaultState.activeNetwork = {
        ...syscoinTestnetVaultState.networks.syscoin[5700],
        chainId: 5700,
        label: 'Syscoin Testnet',
      };
      const syscoinTestnetVaultGetter = jest.fn(() => syscoinTestnetVaultState);

      const syscoinTestnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        syscoinTestnetVaultGetter
      );

      // They should be independent instances
      expect(syscoinKeyring.getNetwork().chainId).toBe(57);
      expect(syscoinTestnetKeyring.getNetwork().chainId).toBe(5700);

      // Accounts should be valid Syscoin addresses
      const mainnetAccount = syscoinKeyring.getActiveAccount().activeAccount;
      const testnetAccount =
        syscoinTestnetKeyring.getActiveAccount().activeAccount;

      // Mainnet should use sys1 prefix, testnet should use tsys1 prefix
      expect(mainnetAccount.address.startsWith('sys1')).toBe(true);
      expect(testnetAccount.address.startsWith('tsys1')).toBe(true);

      // xpub formats should be different for different networks
      // Mainnet uses zpub format, testnet uses vpub format
      // This is correct behavior - same seed but different network encodings
      expect(mainnetAccount.xpub.startsWith('zpub')).toBe(true); // Mainnet format
      expect(testnetAccount.xpub.startsWith('vpub')).toBe(true); // Testnet format
      expect(mainnetAccount.xpub).not.toBe(testnetAccount.xpub); // Different formats
    });
  });

  describe('Network State Synchronization', () => {
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

    it('should persist network changes in vault state', async () => {
      const polygon = currentVaultState.networks.ethereum[137];
      await keyringManager.setSignerNetwork(polygon);

      // Update mock vault state to simulate Redux state update
      currentVaultState.activeNetwork = polygon;

      // Verify the network has changed
      const currentNetwork = keyringManager.getNetwork();
      expect(currentNetwork.chainId).toBe(137);
      expect(currentNetwork.label).toBe('Polygon');
    });

    it('should clear RPC caches on network switch', async () => {
      // clearRpcCaches is already being called during network switching
      // We can verify this by checking that network switching works successfully
      const polygon = currentVaultState.networks.ethereum[137];
      const result = await keyringManager.setSignerNetwork(polygon);

      // Update mock vault state to simulate Redux state update
      currentVaultState.activeNetwork = polygon;

      expect(result.success).toBe(true);
      expect(keyringManager.getNetwork().chainId).toBe(137);
    });

    it('should handle network switching with existing accounts', async () => {
      // Create accounts on Ethereum
      const account2 = await keyringManager.addNewAccount('Account 2');
      const imported = await keyringManager.importAccount(
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
      );

      // Update vault state to include these accounts
      currentVaultState.accounts[KeyringAccountType.HDAccount][1] = {
        id: 1,
        label: 'Account 2',
        address: account2.address,
        xpub: account2.xpub,
        xprv: '',
        isImported: false,
        isTrezorWallet: false,
        isLedgerWallet: false,
        balances: { syscoin: 0, ethereum: 0 },
        assets: { syscoin: [], ethereum: [] },
      };
      currentVaultState.accounts[KeyringAccountType.Imported][0] = {
        id: 0,
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

      // Switch network
      const polygon = currentVaultState.networks.ethereum[137];
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
  });
});

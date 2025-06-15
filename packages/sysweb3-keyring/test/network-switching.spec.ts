import {
  KeyringManager,
  KeyringAccountType,
  IKeyringAccountState,
} from '../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from './constants';

// Mock storage
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

// Mock sysweb3-core
jest.mock('@pollum-io/sysweb3-core', () => ({
  sysweb3Di: {
    getStateStorageDb: jest.fn(() => globalMockStorageClient),
  },
}));

// Mock syscoinjs-lib
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
      fetchBackendUTXOS: jest.fn().mockResolvedValue([]),
      sanitizeBlockbookUTXOs: jest.fn().mockReturnValue([]),
      fetchEstimateFee: jest.fn().mockResolvedValue(0.001024),
    },
    createTransaction: jest.fn(() => ({
      txid: '0x123',
      hex: '0x456',
      psbt: {
        toBase64: jest.fn(() => 'mock-psbt-base64'),
      },
      assets: new Map(),
    })),
    SyscoinJSLib: jest.fn().mockImplementation(() => ({
      blockbookURL: 'https://blockbook.syscoin.org/',
      createTransaction: jest.fn().mockResolvedValue({
        txid: '0x123',
        hex: '0x456',
        psbt: {
          toBase64: jest.fn(() => 'mock-psbt-base64'),
        },
        assets: new Map(),
      }),
      createPSBTFromRes: jest.fn().mockResolvedValue('mock-psbt'),
      signAndSend: jest.fn().mockResolvedValue('mock-signed-psbt'),
    })),
  };
});

// Mock storage module
jest.mock('../src/storage', () => ({
  getDecryptedVault: jest.fn().mockImplementation(async () => ({
    mnemonic:
      'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA==',
  })),
  decryptAES: jest.fn().mockImplementation((cipherText) => {
    if (
      cipherText ===
      'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA=='
    ) {
      return PEACE_SEED_PHRASE;
    }
    return cipherText;
  }),
  encryptAES: jest.fn().mockImplementation((text) => {
    return 'encrypted-' + text;
  }),
  setEncryptedVault: jest.fn().mockResolvedValue(undefined),
}));

// Mock RPC validation
jest.mock('@pollum-io/sysweb3-network', () => {
  const actual = jest.requireActual('@pollum-io/sysweb3-network');
  return {
    ...actual,
    validateSysRpc: jest.fn().mockResolvedValue({ status: 200 }),
    validateEthRpc: jest.fn().mockResolvedValue({ status: 200 }),
  };
});

// Mock providers
jest.mock('../src/providers', () => ({
  CustomJsonRpcProvider: jest.fn().mockImplementation((_signal, url) => ({
    getNetwork: jest.fn().mockResolvedValue({
      chainId:
        url.includes('mainnet.infura.io') || url.includes('alchemyapi.io')
          ? 1
          : url.includes('blockbook')
          ? 57
          : 1,
    }),
  })),
}));

describe('Network Switching UTXO/EVM Issues', () => {
  let keyringManager: KeyringManager;

  beforeEach(async () => {
    globalMockStorage.clear();
    jest.clearAllMocks();

    keyringManager = new KeyringManager();
  });

  afterEach(() => {
    keyringManager = null as any;
  });

  it('should properly derive all accounts when switching from UTXO to EVM', async () => {
    // Create wallet with seed phrase
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Create multiple accounts on Syscoin UTXO
    await keyringManager.addNewAccount();
    await keyringManager.addNewAccount();
    await keyringManager.addNewAccount();

    // Now we should have 4 accounts total
    const hdAccounts =
      keyringManager.wallet.accounts[KeyringAccountType.HDAccount];
    const accountCount = Object.keys(hdAccounts).length;
    expect(accountCount).toBe(4);

    // Store UTXO addresses and xpubs for comparison
    const utxoAddresses = Object.values(hdAccounts).map(
      (acc: IKeyringAccountState) => acc.address
    );
    const utxoXpubs = Object.values(hdAccounts).map(
      (acc: IKeyringAccountState) => acc.xpub
    );
    console.log('UTXO Addresses:', utxoAddresses);
    console.log('UTXO Xpubs:', utxoXpubs);

    // All UTXO addresses should start with appropriate prefix
    utxoAddresses.forEach((addr) => {
      expect(addr).toMatch(/^(bc1|tb1|sys1|tsys1)/);
    });

    // All UTXO xpubs should be proper Bitcoin/Syscoin xpubs
    utxoXpubs.forEach((xpub) => {
      expect(xpub).not.toMatch(/^0x/);
      expect(xpub).toMatch(/^(xpub|ypub|zpub|tpub|upub|vpub)/);
    });

    // Switch to Ethereum network
    const ethNetwork = {
      chainId: 1,
      url: 'https://eth-mainnet.alchemyapi.io/v2/test',
      label: 'Ethereum Mainnet',
      isTestnet: false,
      currency: 'ETH',
      slip44: 60,
    };

    await keyringManager.setSignerNetwork(ethNetwork, 'ethereum');

    // Get accounts after switching to EVM
    const evmHdAccounts =
      keyringManager.wallet.accounts[KeyringAccountType.HDAccount];
    const evmAccountCount = Object.keys(evmHdAccounts).length;
    console.log('EVM Accounts:', evmHdAccounts);

    // Should still have 4 accounts
    expect(evmAccountCount).toBe(4);

    // All accounts should now have Ethereum addresses and xpubs
    const evmAddresses = Object.values(evmHdAccounts).map(
      (acc: IKeyringAccountState) => acc.address
    );
    const evmXpubsAfterSwitch = Object.values(evmHdAccounts).map(
      (acc: IKeyringAccountState) => acc.xpub
    );
    console.log('EVM Addresses after switch:', evmAddresses);
    console.log('EVM Xpubs after switch:', evmXpubsAfterSwitch);

    evmAddresses.forEach((addr) => {
      expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
      // Make sure they're not UTXO addresses
      expect(addr).not.toMatch(/^(bc1|tb1|sys1|tsys1)/);
    });

    // All EVM xpubs should be Ethereum public keys (start with 0x)
    evmXpubsAfterSwitch.forEach((xpub) => {
      expect(xpub).toMatch(/^0x[a-fA-F0-9]+$/);
    });

    // Ensure xpubs actually changed from UTXO format to EVM format
    evmXpubsAfterSwitch.forEach((evmXpub, index) => {
      const utxoXpub = utxoXpubs[index];
      expect(evmXpub).not.toBe(utxoXpub);
      expect(utxoXpub).not.toMatch(/^0x/); // Was UTXO format
      expect(evmXpub).toMatch(/^0x/); // Now EVM format
    });

    // Check that account IDs are preserved
    const utxoAccountIds = Object.keys(hdAccounts)
      .map((id) => parseInt(id))
      .sort();
    const evmAccountIds = Object.keys(evmHdAccounts)
      .map((id) => parseInt(id))
      .sort();
    expect(evmAccountIds).toEqual(utxoAccountIds);
  });

  it('should properly derive all accounts when switching from EVM to UTXO', async () => {
    // Create wallet with seed phrase on Ethereum first
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Set initial network to Ethereum
    const ethNetwork = {
      chainId: 1,
      url: 'https://eth-mainnet.alchemyapi.io/v2/test',
      label: 'Ethereum Mainnet',
      isTestnet: false,
      currency: 'ETH',
      slip44: 60,
    };
    await keyringManager.setSignerNetwork(ethNetwork, 'ethereum');

    // Create multiple accounts on Ethereum
    await keyringManager.addNewAccount();
    await keyringManager.addNewAccount();
    await keyringManager.addNewAccount();

    // Now we should have 4 accounts total
    const evmAccounts =
      keyringManager.wallet.accounts[KeyringAccountType.HDAccount];
    const evmAccountCount = Object.keys(evmAccounts).length;
    expect(evmAccountCount).toBe(4);

    // Store EVM addresses and xpubs for comparison
    const evmAddresses = Object.values(evmAccounts).map(
      (acc: IKeyringAccountState) => acc.address
    );
    const evmXpubs = Object.values(evmAccounts).map(
      (acc: IKeyringAccountState) => acc.xpub
    );
    console.log('EVM Addresses:', evmAddresses);
    console.log('EVM Xpubs:', evmXpubs);

    // All EVM addresses should be valid Ethereum addresses
    evmAddresses.forEach((addr) => {
      expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    // All EVM xpubs should be Ethereum public keys (start with 0x)
    evmXpubs.forEach((xpub) => {
      expect(xpub).toMatch(/^0x[a-fA-F0-9]+$/);
    });

    // Switch to Syscoin UTXO network
    const sysNetwork = {
      chainId: 57,
      url: 'https://blockbook.syscoin.org/',
      label: 'Syscoin Mainnet',
      isTestnet: false,
      currency: 'SYS',
      slip44: 57,
    };

    await keyringManager.setSignerNetwork(sysNetwork, 'syscoin');

    // Get accounts after switching to UTXO
    const utxoAccounts =
      keyringManager.wallet.accounts[KeyringAccountType.HDAccount];
    const utxoAccountCount = Object.keys(utxoAccounts).length;
    console.log('UTXO Accounts after switch:', utxoAccounts);

    // Should still have 4 accounts
    expect(utxoAccountCount).toBe(4);

    // All accounts should now have UTXO addresses and xpubs
    const utxoAddresses = Object.values(utxoAccounts).map(
      (acc: IKeyringAccountState) => acc.address
    );
    const utxoXpubs = Object.values(utxoAccounts).map(
      (acc: IKeyringAccountState) => acc.xpub
    );
    console.log('UTXO Addresses after switch:', utxoAddresses);
    console.log('UTXO Xpubs after switch:', utxoXpubs);

    utxoAddresses.forEach((addr) => {
      expect(addr).toMatch(/^(bc1|tb1|sys1|tsys1)/);
      // Make sure they're not EVM addresses
      expect(addr).not.toMatch(/^0x/);
    });

    // All UTXO xpubs should be proper Bitcoin/Syscoin xpubs (NOT starting with 0x)
    utxoXpubs.forEach((xpub) => {
      expect(xpub).not.toMatch(/^0x/);
      // UTXO xpubs should be base58 encoded and start with proper prefix
      expect(xpub).toMatch(/^(xpub|ypub|zpub|tpub|upub|vpub)/);
    });

    // Ensure xpubs actually changed from EVM format to UTXO format
    utxoXpubs.forEach((utxoXpub, index) => {
      const evmXpub = evmXpubs[index];
      expect(utxoXpub).not.toBe(evmXpub);
      expect(evmXpub).toMatch(/^0x/); // Was EVM format
      expect(utxoXpub).not.toMatch(/^0x/); // Now UTXO format
    });

    // Check that account IDs are preserved
    const evmAccountIds = Object.keys(evmAccounts)
      .map((id) => parseInt(id))
      .sort();
    const utxoAccountIds = Object.keys(utxoAccounts)
      .map((id) => parseInt(id))
      .sort();
    expect(utxoAccountIds).toEqual(evmAccountIds);
  });

  it('should use correct account for signing after network switch', async () => {
    // Create wallet with seed phrase
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    // Create multiple accounts
    await keyringManager.addNewAccount();
    await keyringManager.addNewAccount();

    // Switch to account index 2 (third account)
    await keyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);

    const initialActiveAccount = keyringManager.getActiveAccount();
    console.log('Initial active account:', initialActiveAccount);

    // Switch to Ethereum
    const ethNetwork = {
      chainId: 1,
      url: 'https://eth-mainnet.alchemyapi.io/v2/test',
      label: 'Ethereum Mainnet',
      isTestnet: false,
      currency: 'ETH',
      slip44: 60,
    };
    await keyringManager.setSignerNetwork(ethNetwork, 'ethereum');

    // Check active account after switch
    const evmActiveAccount = keyringManager.getActiveAccount();
    console.log('EVM active account:', evmActiveAccount);

    // Should be the same account ID but different address format
    expect(evmActiveAccount.activeAccount.id).toBe(
      initialActiveAccount.activeAccount.id
    );
    expect(evmActiveAccount.activeAccount.address).toMatch(
      /^0x[a-fA-F0-9]{40}$/
    );

    // Switch back to Syscoin
    const sysNetwork = {
      chainId: 57,
      url: 'https://blockbook.syscoin.org/',
      label: 'Syscoin Mainnet',
      isTestnet: false,
      currency: 'SYS',
      slip44: 57,
    };
    await keyringManager.setSignerNetwork(sysNetwork, 'syscoin');

    // Check active account after switching back
    const utxoActiveAccount = keyringManager.getActiveAccount();
    console.log('UTXO active account after switch back:', utxoActiveAccount);

    // Should maintain the same account ID
    expect(utxoActiveAccount.activeAccount.id).toBe(
      initialActiveAccount.activeAccount.id
    );
    expect(utxoActiveAccount.activeAccount.address).toMatch(
      /^(bc1|tb1|sys1|tsys1)/
    );
  });

  it('should handle imported EVM account on EVM network, then import UTXO account on UTXO network', async () => {
    // Setup: Start on Ethereum network
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    const ethNetwork = {
      chainId: 1,
      url: 'https://eth-mainnet.alchemyapi.io/v2/test',
      label: 'Ethereum Mainnet',
      isTestnet: false,
      currency: 'ETH',
      slip44: 60,
    };
    await keyringManager.setSignerNetwork(ethNetwork, 'ethereum');

    // Import EVM account while on EVM network
    const ethPrivateKey =
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const evmImportedAccount = await keyringManager.importAccount(
      ethPrivateKey,
      'Imported EVM'
    );

    expect(evmImportedAccount.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(evmImportedAccount.xpub).toMatch(/^0x[a-fA-F0-9]+$/);
    console.log(
      'EVM imported account:',
      evmImportedAccount.address,
      evmImportedAccount.xpub
    );

    // Switch to Syscoin UTXO network
    const sysNetwork = {
      chainId: 57,
      url: 'https://blockbook.syscoin.org/',
      label: 'Syscoin Mainnet',
      isTestnet: false,
      currency: 'SYS',
      slip44: 57,
    };
    await keyringManager.setSignerNetwork(sysNetwork, 'syscoin');

    // Import UTXO account while on UTXO network
    const utxoPrivateKey =
      'zprvAWgYBBk7JR8GkraNZJeEodHp6CDV2GL61un6yyqXyKaKCpbV89hfSmNhvGpW8vnRrDYcGFbx94k6KPD1MXFWhtkdD7aQjqJw9ZAUjqWRaK9';
    const utxoImportedAccount = await keyringManager.importAccount(
      utxoPrivateKey,
      'Imported UTXO'
    );

    expect(utxoImportedAccount.address).toMatch(/^(bc1|tb1|sys1|tsys1)/);
    expect(utxoImportedAccount.xpub).toMatch(
      /^(xpub|ypub|zpub|tpub|upub|vpub)/
    );
    console.log(
      'UTXO imported account:',
      utxoImportedAccount.address,
      utxoImportedAccount.xpub
    );

    // Verify both accounts exist and are correct types
    const evmAccountAfter = keyringManager.getAccountById(
      evmImportedAccount.id,
      KeyringAccountType.Imported
    );
    const utxoAccountAfter = keyringManager.getAccountById(
      utxoImportedAccount.id,
      KeyringAccountType.Imported
    );

    expect(evmAccountAfter.address).toMatch(/^0x/); // EVM account stays EVM
    expect(utxoAccountAfter.address).toMatch(/^(bc1|tb1|sys1|tsys1)/); // UTXO account is UTXO
  });

  it('should handle imported UTXO account, then switch to EVM and back', async () => {
    // Setup: Start on Syscoin UTXO network
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    const sysNetwork = {
      chainId: 57,
      url: 'https://blockbook.syscoin.org/',
      label: 'Syscoin Mainnet',
      isTestnet: false,
      currency: 'SYS',
      slip44: 57,
    };
    await keyringManager.setSignerNetwork(sysNetwork, 'syscoin');

    // Import UTXO account while on UTXO network
    const utxoPrivateKey =
      'zprvAWgYBBk7JR8GkraNZJeEodHp6CDV2GL61un6yyqXyKaKCpbV89hfSmNhvGpW8vnRrDYcGFbx94k6KPD1MXFWhtkdD7aQjqJw9ZAUjqWRaK9';
    const utxoImportedAccount = await keyringManager.importAccount(
      utxoPrivateKey,
      'Imported UTXO'
    );

    expect(utxoImportedAccount.address).toMatch(/^(bc1|tb1|sys1|tsys1)/);
    expect(utxoImportedAccount.xpub).toMatch(
      /^(xpub|ypub|zpub|tpub|upub|vpub)/
    );
    const originalUtxoAddress = utxoImportedAccount.address;
    const originalUtxoXpub = utxoImportedAccount.xpub;
    console.log(
      'Original UTXO imported:',
      originalUtxoAddress,
      originalUtxoXpub
    );

    // Switch to Ethereum network (HD accounts switch, imported accounts remain)
    const ethNetwork = {
      chainId: 1,
      url: 'https://eth-mainnet.alchemyapi.io/v2/test',
      label: 'Ethereum Mainnet',
      isTestnet: false,
      currency: 'ETH',
      slip44: 60,
    };
    await keyringManager.setSignerNetwork(ethNetwork, 'ethereum');

    // Check imported UTXO account after switching to EVM network
    const utxoAccountOnEvm = keyringManager.getAccountById(
      utxoImportedAccount.id,
      KeyringAccountType.Imported
    );
    expect(utxoAccountOnEvm.address).toBe(originalUtxoAddress); // Should remain unchanged
    expect(utxoAccountOnEvm.xpub).toBe(originalUtxoXpub); // Should remain unchanged

    // Switch back to UTXO network
    await keyringManager.setSignerNetwork(sysNetwork, 'syscoin');

    // Check imported account after switching back
    const utxoAccountBack = keyringManager.getAccountById(
      utxoImportedAccount.id,
      KeyringAccountType.Imported
    );
    expect(utxoAccountBack.address).toBe(originalUtxoAddress);
    expect(utxoAccountBack.xpub).toBe(originalUtxoXpub);
    console.log(
      'UTXO imported after round trip:',
      utxoAccountBack.address,
      utxoAccountBack.xpub
    );
  });

  it('should handle imported UTXO account switching between mainnet and testnet', async () => {
    // Setup: Start on Syscoin mainnet
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    const sysMainnet = {
      chainId: 57,
      url: 'https://blockbook.syscoin.org/',
      label: 'Syscoin Mainnet',
      isTestnet: false,
      currency: 'SYS',
      slip44: 57,
    };
    await keyringManager.setSignerNetwork(sysMainnet, 'syscoin');

    // Import UTXO account on mainnet
    const utxoPrivateKey =
      'zprvAWgYBBk7JR8GkraNZJeEodHp6CDV2GL61un6yyqXyKaKCpbV89hfSmNhvGpW8vnRrDYcGFbx94k6KPD1MXFWhtkdD7aQjqJw9ZAUjqWRaK9';
    const utxoImportedAccount = await keyringManager.importAccount(
      utxoPrivateKey,
      'Imported UTXO'
    );

    expect(utxoImportedAccount.address).toMatch(/^sys1/); // Mainnet format
    const mainnetAddress = utxoImportedAccount.address;
    const mainnetXpub = utxoImportedAccount.xpub;
    console.log('Mainnet UTXO imported:', mainnetAddress, mainnetXpub);

    // Switch to Syscoin testnet
    const sysTestnet = {
      chainId: 5700,
      url: 'https://blockbook-dev.syscoin.org/',
      label: 'Syscoin Testnet',
      isTestnet: true,
      currency: 'SYS',
      slip44: 1,
    };
    await keyringManager.setSignerNetwork(sysTestnet, 'syscoin');

    // Check imported account after switching to testnet
    const utxoAccountTestnet = keyringManager.getAccountById(
      utxoImportedAccount.id,
      KeyringAccountType.Imported
    );

    // Address should change to testnet format, but xpub can remain the same (same private key)
    expect(utxoAccountTestnet.address).toMatch(/^tsys1/); // Testnet format
    expect(utxoAccountTestnet.address).not.toBe(mainnetAddress); // Different from mainnet
    console.log(
      'Testnet UTXO imported:',
      utxoAccountTestnet.address,
      utxoAccountTestnet.xpub
    );

    // Switch back to mainnet
    await keyringManager.setSignerNetwork(sysMainnet, 'syscoin');

    // Check account after switching back to mainnet
    const utxoAccountMainnetBack = keyringManager.getAccountById(
      utxoImportedAccount.id,
      KeyringAccountType.Imported
    );
    expect(utxoAccountMainnetBack.address).toMatch(/^sys1/); // Back to mainnet format
    expect(utxoAccountMainnetBack.address).toBe(mainnetAddress); // Should match original
    console.log(
      'Mainnet UTXO imported (back):',
      utxoAccountMainnetBack.address,
      utxoAccountMainnetBack.xpub
    );
  });

  it('should handle multiple imported EVM accounts', async () => {
    // Setup: Start on Ethereum network
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    const ethNetwork = {
      chainId: 1,
      url: 'https://eth-mainnet.alchemyapi.io/v2/test',
      label: 'Ethereum Mainnet',
      isTestnet: false,
      currency: 'ETH',
      slip44: 60,
    };
    await keyringManager.setSignerNetwork(ethNetwork, 'ethereum');

    // Import first EVM account
    const ethPrivateKey1 =
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const evmAccount1 = await keyringManager.importAccount(
      ethPrivateKey1,
      'EVM Account 1'
    );

    // Import second EVM account
    const ethPrivateKey2 =
      '0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const evmAccount2 = await keyringManager.importAccount(
      ethPrivateKey2,
      'EVM Account 2'
    );

    // Verify both accounts are different and in EVM format
    expect(evmAccount1.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(evmAccount2.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(evmAccount1.address).not.toBe(evmAccount2.address);
    expect(evmAccount1.xpub).not.toBe(evmAccount2.xpub);

    console.log('EVM Account 1:', evmAccount1.address);
    console.log('EVM Account 2:', evmAccount2.address);
  });

  it('should handle multiple imported UTXO accounts', async () => {
    // Setup: Start on Syscoin network
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();

    const sysNetwork = {
      chainId: 57,
      url: 'https://blockbook.syscoin.org/',
      label: 'Syscoin Mainnet',
      isTestnet: false,
      currency: 'SYS',
      slip44: 57,
    };
    await keyringManager.setSignerNetwork(sysNetwork, 'syscoin');

    // Import first UTXO account
    const utxoPrivateKey1 =
      'zprvAWgYBBk7JR8GkraNZJeEodHp6CDV2GL61un6yyqXyKaKCpbV89hfSmNhvGpW8vnRrDYcGFbx94k6KPD1MXFWhtkdD7aQjqJw9ZAUjqWRaK9';
    const utxoAccount1 = await keyringManager.importAccount(
      utxoPrivateKey1,
      'UTXO Account 1'
    );

    // Import second UTXO account (different key)
    const utxoPrivateKey2 =
      'zprvAhdL1VgqZGQ7UQ4yoZ4d1J8MFe3K4Rt2FBqhG7K8GtYrC9mZHdUmN2vGjbW3SJUfF7KR5cF8T9Hj6jE5RqW9C3mP6tLxV1rSF3xY4eKw7nB';
    const utxoAccount2 = await keyringManager.importAccount(
      utxoPrivateKey2,
      'UTXO Account 2'
    );

    // Verify both accounts are different and in UTXO format
    expect(utxoAccount1.address).toMatch(/^(bc1|tb1|sys1|tsys1)/);
    expect(utxoAccount2.address).toMatch(/^(bc1|tb1|sys1|tsys1)/);
    expect(utxoAccount1.address).not.toBe(utxoAccount2.address);
    expect(utxoAccount1.xpub).not.toBe(utxoAccount2.xpub);

    console.log('UTXO Account 1:', utxoAccount1.address);
    console.log('UTXO Account 2:', utxoAccount2.address);
  });
});

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

    // Store UTXO addresses for comparison
    const utxoAddresses = Object.values(hdAccounts).map(
      (acc: IKeyringAccountState) => acc.address
    );
    console.log('UTXO Addresses:', utxoAddresses);

    // All UTXO addresses should start with appropriate prefix
    utxoAddresses.forEach((addr) => {
      expect(addr).toMatch(/^(bc1|tb1|sys1|tsys1)/);
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

    // All accounts should now have Ethereum addresses
    const evmAddresses = Object.values(evmHdAccounts).map(
      (acc: IKeyringAccountState) => acc.address
    );
    evmAddresses.forEach((addr) => {
      expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
      // Make sure they're not UTXO addresses
      expect(addr).not.toMatch(/^(bc1|tb1|sys1|tsys1)/);
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

    // Store EVM addresses for comparison
    const evmAddresses = Object.values(evmAccounts).map(
      (acc: IKeyringAccountState) => acc.address
    );
    console.log('EVM Addresses:', evmAddresses);

    // All EVM addresses should be valid Ethereum addresses
    evmAddresses.forEach((addr) => {
      expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
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

    // All accounts should now have UTXO addresses
    const utxoAddresses = Object.values(utxoAccounts).map(
      (acc: IKeyringAccountState) => acc.address
    );
    utxoAddresses.forEach((addr) => {
      expect(addr).toMatch(/^(bc1|tb1|sys1|tsys1)/);
      // Make sure they're not EVM addresses
      expect(addr).not.toMatch(/^0x/);
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
});

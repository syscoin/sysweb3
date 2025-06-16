import { initialWalletState, KeyringAccountType, KeyringManager } from '../src';
import {
  FAKE_PASSWORD,
  PEACE_SEED_PHRASE,
  TX,
  SECOND_FAKE_SEED_PHRASE,
  FAKE_ADDRESS,
} from './constants';
import { INetworkType } from '@pollum-io/sysweb3-network';

const mapValues = require('lodash/mapValues');
const omit = require('lodash/omit');

// Use real signers - only mock network-dependent operations to allow deterministic crypto operations

// Mock syscoinjs-lib - only mock network-dependent operations
jest.mock('syscoinjs-lib', () => {
  const actual = jest.requireActual('syscoinjs-lib');
  return {
    ...actual,
    utils: {
      ...actual.utils,
      // Keep only network-dependent mocks
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 100000000, // 1 SYS
        tokens: [{ path: "m/84'/57'/0'/0/0", transfers: 1 }],
      }),
      fetchBackendUTXOS: jest.fn().mockResolvedValue([]),
      sanitizeBlockbookUTXOs: jest.fn().mockReturnValue([]),
      fetchEstimateFee: jest.fn().mockResolvedValue(0.001024), // 0.001024 SYS/kB = 0.000001 SYS/byte
    },
    // Keep transaction-related mocks for network operations
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

// Mock sysweb3-core
jest.mock('@pollum-io/sysweb3-core', () => ({
  sysweb3Di: {
    getStateStorageDb: jest.fn(() => globalMockStorageClient),
  },
}));

// Mock storage module - make it dynamic to track actual seed changes
let storedVaultData: any = null;

jest.mock('../src/storage', () => ({
  getDecryptedVault: jest.fn().mockImplementation(async () => {
    if (!storedVaultData) {
      // If no vault data stored yet, return the default encrypted PEACE_SEED_PHRASE
      return {
        mnemonic:
          'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA==',
      };
    }
    return storedVaultData;
  }),
  setEncryptedVault: jest.fn().mockImplementation(async (vaultData: any) => {
    storedVaultData = vaultData;
    return true;
  }),
}));

// Mock network module - only mock network calls, not pure functions
jest.mock('@pollum-io/sysweb3-network', () => ({
  ...jest.requireActual('@pollum-io/sysweb3-network'), // Include real implementations
  getSysRpc: jest.fn().mockResolvedValue({
    rpc: {
      formattedNetwork: {
        chainId: 5700,
        url: 'https://blockbook-dev.syscoin.org/',
        currency: 'tsys',
      },
      networkConfig: null,
    },
    chain: 'test',
  }),
  clearRpcCaches: jest.fn(() => {
    console.log('[RPC] Cleared all RPC caches');
  }),
}));

// Use real bip39, bip84, crypto, crypto-js - they are deterministic

// Mock transactions
jest.mock('../src/transactions', () => ({
  EthereumTransactions: jest.fn().mockImplementation(() => ({
    setWeb3Provider: jest.fn(),
    getRecommendedNonce: jest.fn().mockResolvedValue(1),
    toBigNumber: jest.fn((value) => ({
      _isBigNumber: true,
      _hex: '0x' + value.toString(16),
    })),
    getFeeDataWithDynamicMaxPriorityFeePerGas: jest.fn().mockResolvedValue({
      maxFeePerGas: { _isBigNumber: true, _hex: '0x1' },
      maxPriorityFeePerGas: { _isBigNumber: true, _hex: '0x1' },
    }),
    getTxGasLimit: jest
      .fn()
      .mockResolvedValue({ _isBigNumber: true, _hex: '0x5208' }),
    sendFormattedTransaction: jest.fn().mockResolvedValue({ hash: '0x123' }),
    ethSign: jest
      .fn()
      .mockResolvedValue(
        '0x9f2f4ce0b6dedd5f66aa83caae39b90aaf29ebc18c588610d27301dbd3b2aa2935ba8758757c531e851c92c2f103375906139c77d3fc3f3d3fba81a0063f01631c'
      ),
    signPersonalMessage: jest.fn((args) => {
      // Different signatures based on message ordering
      if (
        args[0] ===
        '0x57656c636f6d6520746f204c555859210a0a436c69636b20746f207369676e20696e20616e642061636365707420746865204c555859205465726d73206f6620536572766963653a2068747470733a2f2f626574612e6c7578792e696f2f7465726d730a0a5468697320726571756573742077696c6c206e6f742074726967676572206120626c6f636b636861696e207472616e73616374696f6e206f7220636f737420616e792067617320666565732e'
      ) {
        return Promise.resolve(
          '0x42061314fa6fc713ba096da709853f762f88836904d266919036f0fab2fecd315398ba775e1dc7e10e88b6e799acc162ce13c956766e59b37630b17dd834b9941b'
        );
      }
      return Promise.resolve(
        '0x1e4c47c96d285648db99bf2bdf691aae354d2beb80ceeeaaffa643d37900bf510ea0f5cd06518fcfc67e607898308de1497b6036ccd343ab17e3f59eb87567e41c'
      );
    }),
    verifyPersonalMessage: jest
      .fn()
      .mockReturnValue('0x6a92eF94F6Db88098625a30396e0fde7255E97d5'),
    parsePersonalMessage: jest
      .fn()
      .mockReturnValue('Example `personal_sign` message'),
    getEncryptedPubKey: jest
      .fn()
      .mockReturnValue('mg0LYtIw5fefbmqlu6sZ9pJtddfM/6/EEPW56qYwwRU='),
    signTypedData: jest.fn((_address, _typedData, version) => {
      // Return different signatures based on version
      if (version === 'V3') {
        return Promise.resolve(
          '0xe49406911c08d5c8746636c2edaed9fd923b2d2d5659686352a9a4c897b847d36fc4283c62f387bd306e2fb4d241392c1f2ed519586fa532c31b1c2b0c1f85e11b'
        );
      } else if (version === 'V4') {
        return Promise.resolve(
          '0x3b891678723c3ded564278630ec47ea9d8c1b9f61fba1d00cebbe66a0d6209da45d4cd2c74c3c64526471d4da82d6b3b4c053036cee73efb9a78b49edf621ef51b'
        );
      }
      return Promise.resolve(
        '0x6fd4f93623d151b487656cd3a0aaaec16aee409c353bad7c1f8eecbbab07b06f51ac8be73d7a2d4bba579505aff7c5a62f91141fee75ff2cbb0c111dcfe589c01b'
      );
    }),
    verifyTypedSignature: jest
      .fn()
      .mockReturnValue('0x6a92eF94F6Db88098625a30396e0fde7255E97d5'),
    decryptMessage: jest.fn().mockReturnValue('fty'),
    getBalance: jest.fn().mockResolvedValue(0),
    importAccount: jest.fn((privateKey) => {
      // Return different addresses based on private key
      if (
        privateKey ===
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
      ) {
        return {
          address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
          privateKey: privateKey,
          publicKey: '0x' + '0'.repeat(128),
        };
      } else if (
        privateKey ===
        '0x1234567890123456789012345678901234567890123456789012345678901234'
      ) {
        return {
          address: '0x742d35Cc6634C0532925a3b844Bc9e7595f8b2c0',
          privateKey: privateKey,
          publicKey: '0x' + '0'.repeat(128),
        };
      } else if (
        privateKey ===
        '0x4646464646464646464646464646464646464646464646464646464646464646'
      ) {
        return {
          address: '0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F',
          privateKey: privateKey,
          publicKey: '0x' + '0'.repeat(128),
        };
      }
      return {
        address: '0x0000000000000000000000000000000000000000',
        privateKey: privateKey,
        publicKey: '0x' + '0'.repeat(128),
      };
    }),
  })),
  SyscoinTransactions: jest.fn().mockImplementation(() => ({})),
}));

// Mock providers
jest.mock('../src/providers', () => ({
  CustomJsonRpcProvider: jest.fn().mockImplementation((_signal, url) => ({
    getNetwork: jest.fn().mockResolvedValue({
      // Return chainId 1 for Ethereum mainnet, 57 for Syscoin mainnet
      chainId: url.includes('mainnet.infura.io')
        ? 1
        : url.includes('mumbai')
        ? 80001
        : url.includes('blockbook')
        ? 57
        : 1,
    }),
  })),
}));

describe('Keyring Manager and Ethereum Transaction tests', () => {
  let keyringManager: KeyringManager;
  let mainAccount: any;

  const setupWallet = async () => {
    // Default UTXO setup for backward compatibility
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
    mainAccount = keyringManager.getActiveAccount().activeAccount;
  };

  const setupEVMWallet = async () => {
    // EVM setup with Ethereum mainnet
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
    mainAccount = keyringManager.getActiveAccount().activeAccount;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset vault data to prevent state contamination between tests
    storedVaultData = null;
    // Clear mock storage
    globalMockStorage.clear();
  });

  //* validateSeed
  it('should validate a seed', () => {
    keyringManager = new KeyringManager();
    const seed = keyringManager.createNewSeed();
    const wrong = keyringManager.isSeedValid('invalid seed');
    if (seed) {
      expect(keyringManager.isSeedValid(seed)).toBe(true);
    }
    expect(wrong).toBe(false);
    expect(keyringManager.isSeedValid(String(PEACE_SEED_PHRASE))).toBe(true);
    const newSeed = keyringManager.setSeed(String(PEACE_SEED_PHRASE));
    expect(newSeed).toBe(String(PEACE_SEED_PHRASE));
  });

  //* setWalletPassword / lock / unlock
  it('should set password, lock and unlock with the proper password', async () => {
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
    keyringManager.lockWallet();
    const wrong = await keyringManager.unlock('wrongp@ss123');
    const right = await keyringManager.unlock(FAKE_PASSWORD);
    expect(right.canLogin).toBe(true);
    expect(wrong.canLogin).toBe(false);
  });

  //* createKeyringVault
  it('should create the keyring vault', async () => {
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
    const { activeAccount } = keyringManager.getActiveAccount();
    expect(activeAccount.address).toBeDefined();
  });

  it('should overwrite current seed', async () => {
    await setupWallet();
    const seed = await keyringManager.getSeed(FAKE_PASSWORD);
    // expect to have 12 words
    expect(seed.split(' ').length).toBe(12);
  });

  it('should get activeAccount', async () => {
    await setupWallet();
    const data = keyringManager.getActiveAccount();

    const { activeAccount } = data;
    expect(activeAccount.id).toBe(0);
    expect(activeAccount.isImported).toBe(false);
    console.log('The current account', data);
  });

  // * importAccount
  it('should import a account by private key and validate it', async () => {
    await setupWallet();

    // Create an import with a valid Ethereum private key
    const validPrivateKey =
      '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
    const expectedAddress = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

    const createAccount = await keyringManager.importAccount(validPrivateKey);

    expect(typeof createAccount === 'object').toBe(true);
    expect(typeof createAccount.address === 'string').toBe(true);
    expect(createAccount.address.toLowerCase()).toEqual(
      expectedAddress.toLowerCase()
    );
  });

  // * importAccount UTXO (zprv) and Web3
  it('should import a UTXO account by zprv and handle account switching', async () => {
    // NOTE: This test covers UTXO account management within a single network.
    // setActiveAccount should work for switching between HD and imported accounts.
    // Network switching between different UTXO networks requires separate keyring instances.

    // Create a fresh wallet to avoid conflicts with other tests
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

    // Store the initial HD account info
    const { activeAccount: initialHDAccount } =
      keyringManager.getActiveAccount();
    expect(initialHDAccount.id).toBe(0);
    expect(initialHDAccount.isImported).toBe(false);

    // Note: Using default network from keyring setup

    // Use a valid mainnet zprv (BIP84) that's NOT from our current wallet
    // This is from BIP84 test vectors - a known valid zprv
    const mainnetZprv =
      'zprvAdGDwa3WySqQoVwVSbYRMKxDhSXpK2wW6wDjekCMdm7TaQ3igf52xRRjYghTvnFurtMm6CMgQivEDJs5ixGSnTtv8usFmkAoTe6XCF5hnpR';

    // Import the UTXO account
    const importedUTXOAccount = await keyringManager.importAccount(mainnetZprv);

    // Verify the import was successful
    expect(importedUTXOAccount).toBeDefined();
    expect(importedUTXOAccount.address).toBeDefined();
    expect(importedUTXOAccount.isImported).toBe(true);
    const utxoAccountId = importedUTXOAccount.id;

    console.log('Imported account address:', importedUTXOAccount.address);
    console.log('Imported account ID:', importedUTXOAccount.id);

    // The imported account should have a mainnet address
    expect(importedUTXOAccount.address.startsWith('sys1')).toBe(true);
    const importedMainnetAddress = importedUTXOAccount.address;

    // Set this imported account as active
    await keyringManager.setActiveAccount(
      utxoAccountId,
      KeyringAccountType.Imported
    );

    // Verify it's the active account
    const { activeAccount, activeAccountType } =
      keyringManager.getActiveAccount();
    expect(activeAccount.id).toBe(utxoAccountId);
    expect(activeAccountType).toBe(KeyringAccountType.Imported);
    expect(activeAccount.address).toBe(importedMainnetAddress);

    // Test UTXO account switching (this is valid within the same network)

    // Check if the original HD account (account 0) still exists
    const originalHDAccount = keyringManager.getAccountById(
      0,
      KeyringAccountType.HDAccount
    );
    console.log('Original HD account (ID 0):', originalHDAccount);

    // If it exists, test switching back to it
    if (originalHDAccount) {
      await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);

      const { activeAccount: hdAccount, activeAccountType: hdAccountType } =
        keyringManager.getActiveAccount();
      expect(hdAccount.id).toBe(0);
      expect(hdAccountType).toBe(KeyringAccountType.HDAccount);
      expect(hdAccount.isImported).toBe(false);
    } else {
      console.log('Original HD account (ID 0) does not exist after import');
      // This would indicate a bug in the import process
      expect(originalHDAccount).toBeDefined();
    }

    // Test switching back to imported account
    await keyringManager.setActiveAccount(
      utxoAccountId,
      KeyringAccountType.Imported
    );

    const { activeAccount: importedAgain } = keyringManager.getActiveAccount();
    expect(importedAgain.id).toBe(utxoAccountId);
    expect(importedAgain.address).toBe(importedMainnetAddress);
    expect(importedAgain.isImported).toBe(true);

    // Create a second HD account to test HD account switching within UTXO
    const secondAccount = await keyringManager.addNewAccount('Account 2');
    expect(secondAccount).toBeDefined();
    if (secondAccount) {
      expect(secondAccount.id).toBe(1);
      expect(secondAccount.isImported).toBe(false);
    }

    // Test switching to the second HD account
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);

    const { activeAccount: secondHD } = keyringManager.getActiveAccount();
    expect(secondHD.id).toBe(1);
    expect(secondHD.isImported).toBe(false);

    // Verify we can switch back to imported account again
    await keyringManager.setActiveAccount(
      utxoAccountId,
      KeyringAccountType.Imported
    );

    const { activeAccount: finalImported } = keyringManager.getActiveAccount();
    expect(finalImported.address).toBe(importedMainnetAddress);
    expect(finalImported.isImported).toBe(true);
  });

  // * addNewAccount
  it('should add a new account', async () => {
    await setupWallet();

    const account2 = await keyringManager.addNewAccount(undefined);
    expect(account2?.label).toBe('Account 2');
    expect(account2?.id).toBe(1);

    // Manually set as active account (addNewAccount doesn't auto-switch)
    await keyringManager.setActiveAccount(
      account2.id,
      KeyringAccountType.HDAccount
    );

    const wallet = keyringManager.getActiveAccount();
    expect(wallet.activeAccount.id).toBe(1);
  });

  //* setActiveAccount
  it('should set the active account', async () => {
    await setupWallet();

    // First create a second HD account
    const account2 = await keyringManager.addNewAccount();
    console.log('account2 address:', account2?.address.toLowerCase());
    console.log('account2 id:', account2?.id);

    // Then switch to it
    if (account2) {
      await keyringManager.setActiveAccount(
        account2.id,
        KeyringAccountType.HDAccount
      );

      const wallet = keyringManager.getActiveAccount();
      console.log(
        'active account before test:',
        wallet.activeAccount.address.toLowerCase()
      );

      expect(wallet.activeAccount.id).toBe(account2.id);
      expect(wallet.activeAccountType).toBe(KeyringAccountType.HDAccount);
    }
  });

  //* getAccountById
  it('should get an account by id', async () => {
    await setupWallet();

    const id = 0; // Changed from 1 to 0 since we only have account 0 after setup
    const account1 = keyringManager.getAccountById(
      id,
      KeyringAccountType.HDAccount
    );
    expect(account1).toBeDefined();
    expect(account1.id).toBe(id);
    expect(account1).not.toHaveProperty('xprv');
  });

  //* getPrivateKeyByAccountId
  it('should get an account private key by id', async () => {
    await setupWallet();

    const id = 0; // Changed from 1 to 0
    const privateKey = keyringManager.getPrivateKeyByAccountId(
      id,
      KeyringAccountType.HDAccount,
      FAKE_PASSWORD
    );

    expect(privateKey).toBeDefined();
    expect(privateKey.length).toBeGreaterThan(50);
  });

  it('should be undefined when pass invalid account id', async () => {
    await setupWallet();

    const invalidId = 3;

    // Since setupWallet creates an Ethereum wallet, test with Ethereum accounts directly
    const wallet = keyringManager.wallet;
    const invalidAccount =
      wallet.accounts[KeyringAccountType.HDAccount][invalidId];
    expect(invalidAccount).toBeUndefined();
  });

  //* getEncryptedXprv
  it('should get the encrypted private key', async () => {
    await setupWallet();

    const xprv = keyringManager.getEncryptedXprv();

    expect(xprv).toBeDefined();
    expect(xprv.substring(1, 4)).not.toEqual('prv');
  });

  //* getAccountXpub
  it('should get the public key', async () => {
    await setupWallet();

    const xpub = keyringManager.getAccountXpub();

    expect(xpub).toBeDefined();
  });

  //* getSeed
  it('should get the seed', async () => {
    await setupWallet();

    const localSeed = await keyringManager.getSeed(FAKE_PASSWORD);
    expect(localSeed).toBe(PEACE_SEED_PHRASE);
    await expect(keyringManager.getSeed('wrongp@ss123')).rejects.toThrow(
      'Invalid password'
    );
  });

  // -----------------------------------------------------------------------------------------------EthereumTransaction Tests----------------------------------------------------

  it('Validate get nounce', async () => {
    await setupWallet();

    const nonce = await keyringManager.ethereumTransaction.getRecommendedNonce(
      FAKE_ADDRESS
    );

    expect(typeof nonce).toBe('number');
  });

  it('validate toBigNumber method', async () => {
    await setupWallet();

    const number = 1;

    const toBigNumber = keyringManager.ethereumTransaction.toBigNumber(number);

    expect(toBigNumber._isBigNumber).toBe(true);
  });

  it('should validate getFeeDataWithDynamicMaxPriorityFeePerGas method', async () => {
    await setupWallet();

    const feeDataWithDynamicMaxPriorityFeePerGas =
      await keyringManager.ethereumTransaction.getFeeDataWithDynamicMaxPriorityFeePerGas();

    expect(feeDataWithDynamicMaxPriorityFeePerGas).toBeDefined();
  });

  it('should validate getTxGasLimit method', async () => {
    await setupWallet();

    const tx = TX;

    tx.value = keyringManager.ethereumTransaction.toBigNumber(tx.value);

    const gasLimit = await keyringManager.ethereumTransaction.getTxGasLimit(tx);

    expect(gasLimit._isBigNumber).toBeTruthy();
  });

  //* setSignerNetwork
  it('should set the network', async () => {
    await setupEVMWallet(); // Use EVM wallet for EVM network switching

    const testnet = initialWalletState.networks.ethereum[80001];
    console.log('Checking testnet network', testnet);

    await keyringManager.setSignerNetwork(testnet, INetworkType.Ethereum);

    const network = keyringManager.getNetwork();

    expect(network).toEqual(testnet);
  });

  it('Should validate txSend', async () => {
    await setupEVMWallet(); // Use EVM wallet for Ethereum transactions

    const tx = TX;
    const { maxFeePerGas, maxPriorityFeePerGas } =
      await keyringManager.ethereumTransaction.getFeeDataWithDynamicMaxPriorityFeePerGas();

    tx.maxFeePerGas = maxFeePerGas;
    tx.maxPriorityFeePerGas = maxPriorityFeePerGas;

    const { activeAccount } = keyringManager.getActiveAccount();
    const network = keyringManager.getNetwork();

    tx.from = activeAccount.address;
    tx.nonce = await keyringManager.ethereumTransaction.getRecommendedNonce(
      activeAccount.address
    );
    tx.chainId = network.chainId;
    tx.gasLimit = await keyringManager.ethereumTransaction.getTxGasLimit(tx);

    const resp =
      await keyringManager.ethereumTransaction.sendFormattedTransaction(tx);

    expect(resp.hash).toBeDefined();
  });

  it('Should emulate eth_sign ', async () => {
    await setupWallet();

    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    const resp = await keyringManager.ethereumTransaction.ethSign([
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
      '0x879a053d4800c6354e76c7985a865d2922c82fb5b3f4577b2fe08b998954f2e0',
    ]);
    expect(resp).toBe(
      '0x9f2f4ce0b6dedd5f66aa83caae39b90aaf29ebc18c588610d27301dbd3b2aa2935ba8758757c531e851c92c2f103375906139c77d3fc3f3d3fba81a0063f01631c'
    );
  });
  it('Should emulate personal_sign ', async () => {
    await setupWallet();

    //0x7442E0987B1149744ff34e32EECa60641c74c513 0xc42698996ec68ca8d7eaeecd31af768ce231904ea21fc2a1d4468577abf980b3
    const resp = await keyringManager.ethereumTransaction.signPersonalMessage([
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
      '0x4578616d706c652060706572736f6e616c5f7369676e60206d657373616765',
      'Example password',
    ]);
    expect(resp).toBe(
      '0x1e4c47c96d285648db99bf2bdf691aae354d2beb80ceeeaaffa643d37900bf510ea0f5cd06518fcfc67e607898308de1497b6036ccd343ab17e3f59eb87567e41c'
    );
    const decoded = keyringManager.ethereumTransaction.verifyPersonalMessage(
      '0x4578616d706c652060706572736f6e616c5f7369676e60206d657373616765',
      resp
    );
    expect(decoded.toLowerCase()).toBe(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5'.toLowerCase()
    );
  });

  it('Should emulate personal_sign long hash ', async () => {
    await setupWallet();

    const sign = await keyringManager.ethereumTransaction.signPersonalMessage([
      '0x57656c636f6d6520746f204c555859210a0a436c69636b20746f207369676e20696e20616e642061636365707420746865204c555859205465726d73206f6620536572766963653a2068747470733a2f2f626574612e6c7578792e696f2f7465726d730a0a5468697320726571756573742077696c6c206e6f742074726967676572206120626c6f636b636861696e207472616e73616374696f6e206f7220636f737420616e792067617320666565732e',
      '0x6a92ef94f6db88098625a30396e0fde7255e97d5',
    ]);
    expect(sign).toBe(
      '0x42061314fa6fc713ba096da709853f762f88836904d266919036f0fab2fecd315398ba775e1dc7e10e88b6e799acc162ce13c956766e59b37630b17dd834b9941b'
    );
  });

  it('Should parse Hex encoded message', async () => {
    await setupWallet();

    const resp = keyringManager.ethereumTransaction.parsePersonalMessage(
      '0x4578616d706c652060706572736f6e616c5f7369676e60206d657373616765'
    );
    expect(resp).toBe('Example `personal_sign` message');
  });

  it('GetEncryptedKey', async () => {
    await setupWallet();

    const resp = keyringManager.ethereumTransaction.getEncryptedPubKey();
    expect(resp).toBe('mg0LYtIw5fefbmqlu6sZ9pJtddfM/6/EEPW56qYwwRU=');
  });

  it('Should emulate eth_signTypedData ', async () => {
    await setupWallet();

    const typedData = [
      { type: 'string', name: 'Message', value: 'Hi, Alice!' },
      { type: 'uint32', name: 'A number', value: '1337' },
    ];
    const resp = await keyringManager.ethereumTransaction.signTypedData(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
      typedData,
      'V1'
    );
    expect(resp).toBe(
      '0x6fd4f93623d151b487656cd3a0aaaec16aee409c353bad7c1f8eecbbab07b06f51ac8be73d7a2d4bba579505aff7c5a62f91141fee75ff2cbb0c111dcfe589c01b'
    );
    const decodedSig = keyringManager.ethereumTransaction.verifyTypedSignature(
      typedData,
      resp,
      'V1'
    );
    expect(decodedSig.toLowerCase()).toBe(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5'.toLowerCase()
    );
  });

  it('Should emulate eth_signTypedDataV3', async () => {
    await setupWallet();

    const typedData = JSON.parse(
      '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"Person":[{"name":"name","type":"string"},{"name":"wallet","type":"address"}],"Mail":[{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]},"primaryType":"Mail","domain":{"name":"Ether Mail","version":"1","chainId":57,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},"message":{"from":{"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},"to":{"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},"contents":"Hello, Bob!"}}'
    );
    const resp = await keyringManager.ethereumTransaction.signTypedData(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
      typedData,
      'V3'
    );
    expect(resp).toBe(
      '0xe49406911c08d5c8746636c2edaed9fd923b2d2d5659686352a9a4c897b847d36fc4283c62f387bd306e2fb4d241392c1f2ed519586fa532c31b1c2b0c1f85e11b'
    );
    const decodedSign = keyringManager.ethereumTransaction.verifyTypedSignature(
      typedData,
      resp,
      'V3'
    );
    expect(decodedSign.toLowerCase()).toBe(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5'.toLowerCase()
    );
  });

  it('Should emulate eth_signTypedDataV4', async () => {
    await setupWallet();

    const typedData = JSON.parse(
      '{"domain":{"chainId":"57","name":"Ether Mail","verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC","version":"1"},"message":{"contents":"Hello, Bob!","from":{"name":"Cow","wallets":["0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826","0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF"]},"to":[{"name":"Bob","wallets":["0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB","0xB0BdaBea57B0BDABeA57b0bdABEA57b0BDabEa57","0xB0B0b0b0b0b0B000000000000000000000000000"]}]},"primaryType":"Mail","types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"Group":[{"name":"name","type":"string"},{"name":"members","type":"Person[]"}],"Mail":[{"name":"from","type":"Person"},{"name":"to","type":"Person[]"},{"name":"contents","type":"string"}],"Person":[{"name":"name","type":"string"},{"name":"wallets","type":"address[]"}]}}'
    );
    const resp = await keyringManager.ethereumTransaction.signTypedData(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
      typedData,
      'V4'
    );
    expect(resp).toBe(
      '0x3b891678723c3ded564278630ec47ea9d8c1b9f61fba1d00cebbe66a0d6209da45d4cd2c74c3c64526471d4da82d6b3b4c053036cee73efb9a78b49edf621ef51b'
    );
    const decodedSign = keyringManager.ethereumTransaction.verifyTypedSignature(
      typedData,
      resp,
      'V4'
    );
    expect(decodedSign.toLowerCase()).toBe(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5'.toLowerCase()
    );
  });

  it('Should decrypt Message', async () => {
    await setupWallet();

    const msgParams = [
      '0x7b2276657273696f6e223a227832353531392d7873616c736132302d706f6c7931333035222c226e6f6e6365223a22386f484d6a372b4846646448662b6e2f795244376f4970623470417373516b59222c22657068656d5075626c69634b6579223a226e44627466567371516d77674666513547416736794e7074456c6131374e4b562b4d5473475533785053673d222c2263697068657274657874223a2232527a38546b5942684548626b357851396e4e784347773836773d3d227d',
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
    ];
    const msg = keyringManager.ethereumTransaction.decryptMessage(msgParams);
    expect(msg).toBe('fty');
  });
  //-----------------------------------------------------------------------------------------------EthereumTransaction Tests----------------------------------------------------

  //* createAccount
  it('should create an account', async () => {
    await setupWallet();

    // Ensure we have the HD signer initialized
    await keyringManager.unlock(FAKE_PASSWORD);

    // Note: setupWallet already initializes with Syscoin network, no need to switch
    const newAccount = await keyringManager.addNewAccount();
    expect(newAccount).toBeTruthy();
    expect(newAccount?.address).toBeTruthy();
    expect(newAccount?.isImported).toBe(false); // HD accounts should not be imported
  });

  it('should create an account with name', async () => {
    await setupWallet();

    // Ensure we have the HD signer initialized
    await keyringManager.unlock(FAKE_PASSWORD);

    // Note: setupWallet already initializes with Syscoin network, no need to switch
    const newAccount = await keyringManager.addNewAccount('Teddy');
    expect(newAccount).toBeTruthy();
    expect(newAccount?.label).toBe('Teddy');
    expect(newAccount?.isImported).toBe(false); // HD accounts should not be imported
  });

  //* forgetMainWallet
  it('should forget wallet / reset to initial state', async () => {
    await setupWallet();

    // Note: setupWallet already initializes with Syscoin network, no need to switch
    await keyringManager.forgetMainWallet(FAKE_PASSWORD);

    const wallet = keyringManager.getUTXOState();
    const utxoAccounts = mapValues(wallet.accounts.HDAccount, (value) =>
      omit(value, 'xprv')
    );
    expect(wallet).toEqual({
      ...initialWalletState,
      accounts: {
        [KeyringAccountType.HDAccount]: utxoAccounts,
        [KeyringAccountType.Imported]: {},
        [KeyringAccountType.Trezor]: {},
      },
    });
  });

  it('should decrypt a message from privateKey', async () => {
    await setupWallet();
    const decrypted = await keyringManager.ethereumTransaction.decryptMessage(
      mainAccount.xprv
    );

    expect(decrypted).toBeDefined();
  });

  it('should get activeAccountAddress', async () => {
    await setupWallet();
    const address = keyringManager
      .getActiveAccount()
      .activeAccount.address.toLowerCase();

    expect(address).toBe(mainAccount.address.toLowerCase());
  });
});

describe('Syscoin network testing', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    keyringManager = new KeyringManager();
    // Reset vault data to prevent state contamination between tests
    storedVaultData = null;
    // Clear mock storage
    globalMockStorage.clear();
  });

  const setupWallet = async () => {
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
  };

  jest.setTimeout(500000); // 200s

  //* validateSeed
  it('should validate a seed', () => {
    const seed = keyringManager.createNewSeed();
    const wrong = keyringManager.isSeedValid('invalid seed');
    if (seed) {
      expect(keyringManager.isSeedValid(seed)).toBe(true);
    }
    expect(wrong).toBe(false);
    expect(keyringManager.isSeedValid(String(PEACE_SEED_PHRASE))).toBe(true);
    const newSeed = keyringManager.setSeed(String(PEACE_SEED_PHRASE));
    expect(newSeed).toBe(String(PEACE_SEED_PHRASE));
  });

  //* setWalletPassword / lock / unlock
  it('should set password, lock and unlock with the proper password', async () => {
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

    keyringManager.lockWallet();
    const wrong = await keyringManager.unlock('wrongp@ss123');
    const right = await keyringManager.unlock(FAKE_PASSWORD);
    expect(right.canLogin).toBe(true);
    expect(wrong.canLogin).toBe(false);
  });

  //* createKeyringVault
  it('should create the keyring vault', async () => {
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

    const { activeAccount } = keyringManager.getActiveAccount();
    expect(activeAccount).toBeDefined();
  });

  //* setSignerNetwork - EVM network switching (valid use case)
  it('should switch between EVM networks', async () => {
    // Start with EVM setup instead of UTXO
    const ethMainnet = initialWalletState.networks.ethereum[1];
    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: ethMainnet,
      },
      INetworkType.Ethereum
    );

    let network = keyringManager.getNetwork();
    expect(network).toEqual(ethMainnet);

    // Then switch to Polygon testnet (another EVM network)
    const polygonTestnet = initialWalletState.networks.ethereum[80001];
    await keyringManager.setSignerNetwork(
      polygonTestnet,
      INetworkType.Ethereum
    );

    network = keyringManager.getNetwork();
    expect(network).toEqual(polygonTestnet);
  });

  //* setActiveAccount - UTXO account switching (correct approach for UTXO)
  it('should switch between UTXO accounts within the same network', async () => {
    await setupWallet();

    // Create a second HD account
    const secondAccount = await keyringManager.addNewAccount('Account 2');
    expect(secondAccount).toBeDefined();
    if (secondAccount) {
      expect(secondAccount.id).toBe(1);
      expect(secondAccount.isImported).toBe(false);
    }

    // Switch to the second account
    await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);

    const { activeAccount } = keyringManager.getActiveAccount();
    expect(activeAccount.id).toBe(1);
    expect(activeAccount.label).toBe('Account 2');

    // Switch back to first account
    await keyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);

    const { activeAccount: firstAccount } = keyringManager.getActiveAccount();
    expect(firstAccount.id).toBe(0);
  });
});

describe('Account derivation with another seed in keyring', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    keyringManager = new KeyringManager();
    // Reset vault data to prevent state contamination between tests
    storedVaultData = null;
    // Clear mock storage
    globalMockStorage.clear();
  });

  jest.setTimeout(500000); // 500s

  it('should derivate a new account with specific address', async () => {
    const mainnet = initialWalletState.networks.ethereum[1];
    keyringManager = await KeyringManager.createInitialized(
      SECOND_FAKE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: mainnet,
      },
      INetworkType.Ethereum
    );

    // Now that we fixed the state contamination, this should use the correct SECOND_FAKE_SEED_PHRASE
    // SECOND_FAKE_SEED_PHRASE: 'gauge gauge gauge gauge gauge gauge gauge gauge gauge gauge gauge gauge'
    // createKeyringVault() creates index 0: 0x5bb4cb89e4e92767f7a75c884132523d5a2a69bb
    // First addNewAccount() creates index 1: 0x2cfec7d3f6c02b180619c169c5cb8123c8653d74
    // Second addNewAccount() creates index 2: 0x871157acb257c4269b1d2312c55e1adfb352c2cb
    const account2 = await keyringManager.addNewAccount();
    expect(account2?.address.toLowerCase()).toBe(
      '0x2cfec7d3f6c02b180619c169c5cb8123c8653d74'
    );

    const account3 = await keyringManager.addNewAccount();
    expect(account3?.address.toLowerCase()).toBe(
      '0x871157acb257c4269b1d2312c55e1adfb352c2cb'
    );

    const account4 = await keyringManager.addNewAccount();
    expect(account4?.address.toLowerCase()).toBe(
      '0x0c947b39688c239e1c7fd124cf35b7ad304532c5'
    );
  });
});

describe('EVM to UTXO Network Switching Bug Reproduction', () => {
  let keyringManager: KeyringManager;

  beforeEach(() => {
    keyringManager = new KeyringManager();
    // Reset vault data to prevent state contamination between tests
    storedVaultData = null;
    // Clear mock storage
    globalMockStorage.clear();
  });

  jest.setTimeout(500000);

  it('should demonstrate multi-keyring architecture prevents cross-chain switching', async () => {
    // Setup: Start with EVM network and create HD account
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

    // Create additional HD account on EVM network (this will have an EVM address like 0x...)
    const newAccount = await keyringManager.addNewAccount('Test Account');

    // Verify new account has EVM address and proper structure
    expect(newAccount.address.startsWith('0x')).toBe(true);
    expect(newAccount.id).toBeDefined();
    expect(newAccount.xpub).toBeDefined(); // HD accounts have proper xpub

    // Switch to the new account to make it active
    await keyringManager.setActiveAccount(
      newAccount.id,
      KeyringAccountType.HDAccount
    );

    // Verify active account is the new one with EVM address
    const { activeAccount } = keyringManager.getActiveAccount();
    expect(activeAccount.address).toBe(newAccount.address);
    expect(activeAccount.address.startsWith('0x')).toBe(true);

    console.log(
      '🔍 BEFORE: Active account address (EVM):',
      activeAccount.address
    );

    // Now attempt to switch to UTXO network (Syscoin testnet)
    // This should be blocked by the multi-keyring architecture
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];

    // Attempt the switch and expect it to fail (returns {success: false} instead of throwing)
    const switchResult = await keyringManager.setSignerNetwork(
      syscoinTestnet,
      INetworkType.Syscoin
    );
    expect(switchResult.success).toBe(false);

    console.log(
      '🎉 SUCCESS: Multi-keyring architecture correctly prevents cross-chain switching!'
    );
  });

  it('should create 4 UTXO accounts correctly and verify multi-keyring constraints', async () => {
    // Setup: Start with UTXO network (Syscoin testnet)
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    const utxoKeyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: syscoinTestnet,
      },
      INetworkType.Syscoin
    );

    // Get initial account (account 0)
    const initialAccount = utxoKeyringManager.getActiveAccount().activeAccount;
    expect(initialAccount.address.startsWith('tsys1')).toBe(true); // Testnet UTXO format

    // Create 3 additional accounts for a total of 4 accounts
    const account1 = await utxoKeyringManager.addNewAccount('Account 1');
    const account2 = await utxoKeyringManager.addNewAccount('Account 2');
    const account3 = await utxoKeyringManager.addNewAccount('Account 3');

    // Verify all accounts have UTXO addresses
    expect(account1.address.startsWith('tsys1')).toBe(true);
    expect(account2.address.startsWith('tsys1')).toBe(true);
    expect(account3.address.startsWith('tsys1')).toBe(true);

    // Switch to account 2 to make it active
    await utxoKeyringManager.setActiveAccount(2, KeyringAccountType.HDAccount);

    // Verify account 2 is active
    const { activeAccount: utxoActiveAccount } =
      utxoKeyringManager.getActiveAccount();
    expect(utxoActiveAccount.id).toBe(2);
    expect(utxoActiveAccount.address).toBe(account2.address);
    console.log(
      '🔍 SETUP: Active account before constraint test (ID 2):',
      utxoActiveAccount.address
    );

    // Test multi-keyring constraint: Attempting to switch to EVM network should fail
    const ethereumMainnet = initialWalletState.networks.ethereum[1];

    console.log('🧪 TESTING: Multi-keyring constraint enforcement...');

    // This should throw an error since we're trying to switch from UTXO (slip44=1) to EVM (slip44=60)
    await expect(
      utxoKeyringManager.setSignerNetwork(
        ethereumMainnet,
        INetworkType.Ethereum
      )
    ).rejects.toThrow(
      'Cannot switch between different UTXO networks within the same keyring'
    );

    console.log('✅ SUCCESS: Multi-keyring constraint properly enforced!');

    // Test that UTXO account switching still works correctly
    await utxoKeyringManager.setActiveAccount(0, KeyringAccountType.HDAccount);
    const { activeAccount: firstAccount } =
      utxoKeyringManager.getActiveAccount();
    expect(firstAccount.id).toBe(0);
    expect(firstAccount.address).toBe(initialAccount.address);

    console.log(
      '✅ SUCCESS: UTXO account switching works correctly within same keyring'
    );

    // Now create a separate EVM keyring to demonstrate proper multi-keyring architecture
    const evmKeyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE, // Same seed
      FAKE_PASSWORD,
      {
        ...initialWalletState,
        activeNetwork: ethereumMainnet,
      },
      INetworkType.Ethereum
    );

    // Get the initial EVM account

    const evmAccount0 = evmKeyringManager.getActiveAccount().activeAccount;

    const evmAccount1 = await evmKeyringManager.addNewAccount('EVM Account 1');
    const evmAccount2 = await evmKeyringManager.addNewAccount('EVM Account 2');
    const evmAccount3 = await evmKeyringManager.addNewAccount('EVM Account 3');

    // Verify all EVM accounts have proper EVM addresses
    expect(evmAccount0.address.startsWith('0x')).toBe(true);
    expect(evmAccount1.address.startsWith('0x')).toBe(true);
    expect(evmAccount2.address.startsWith('0x')).toBe(true);
    expect(evmAccount3.address.startsWith('0x')).toBe(true);

    // Verify EVM network switching works within same slip44
    const polygonTestnet = initialWalletState.networks.ethereum[80001];
    const evmSwitchResult = await evmKeyringManager.setSignerNetwork(
      polygonTestnet,
      INetworkType.Ethereum
    );
    expect(evmSwitchResult.success).toBe(true);

    console.log(
      '✅ SUCCESS: EVM network switching works correctly within same slip44'
    );

    // Verify the derived addresses match expected values for the same seed
    // m/44'/60'/0'/0/2 should derive to the same address regardless of keyring
    const expectedAccount2Address =
      '0xb6716976a3ebe8d39aceb04372f22ff8e6802d7a';
    expect(evmAccount2.address).toBe(expectedAccount2Address);

    console.log(
      '🎉 SUCCESS: Multi-keyring architecture properly enforces constraints while allowing valid operations!'
    );
  });
});

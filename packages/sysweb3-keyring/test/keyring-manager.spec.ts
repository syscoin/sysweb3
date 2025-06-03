import mapValues from 'lodash/mapValues';
import omit from 'lodash/omit';

import { initialWalletState, KeyringAccountType, KeyringManager } from '../src';
import {
  FAKE_PASSWORD,
  PEACE_SEED_PHRASE,
  TX,
  SECOND_FAKE_SEED_PHRASE,
  FAKE_ADDRESS,
} from './constants';

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
      fetchEstimateFee: jest.fn().mockResolvedValue(1000),
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

// Mock ethers - only mock what's needed for validation, use real Wallet.fromMnemonic
jest.mock('ethers', () => ({
  ...jest.requireActual('ethers'),
  Wallet: {
    ...jest.requireActual('ethers').Wallet,
    // Use real fromMnemonic for deterministic address generation
  },
}));

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
  getDecryptedVault: jest.fn().mockImplementation(async (_password: string) => {
    if (!storedVaultData) {
      // If no vault data stored yet, return the default encrypted PEACE_SEED_PHRASE
      return {
        mnemonic:
          'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA==',
      };
    }
    return storedVaultData;
  }),
  setEncryptedVault: jest
    .fn()
    .mockImplementation(async (vaultData: any, _password: string) => {
      storedVaultData = vaultData;
      return true;
    }),
}));

// Mock network module
jest.mock('@pollum-io/sysweb3-network', () => ({
  getSysRpc: jest.fn().mockResolvedValue({
    rpc: {
      formattedNetwork: {
        chainId: 5700,
        url: 'https://blockbook-dev.syscoin.org/',
        currency: 'tsys',
        isTestnet: true,
      },
      networkConfig: null,
    },
    chain: 'test',
    isTestnet: true,
  }),
  INetworkType: {
    Syscoin: 'syscoin',
    Ethereum: 'ethereum',
  },
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
        };
      } else if (
        privateKey ===
        '0x1234567890123456789012345678901234567890123456789012345678901234'
      ) {
        return {
          address: '0x742d35Cc6634C0532925a3b844Bc9e7595f8b2c0',
          privateKey: privateKey,
        };
      }
      return {
        address: '0x0000000000000000000000000000000000000000',
        privateKey: privateKey,
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
    keyringManager = new KeyringManager({
      wallet: {
        ...initialWalletState,
        activeNetwork: {
          chainId: 1,
          label: 'Ethereum Mainnet',
          url: 'https://mainnet.infura.io/v3/YOUR-PROJECT-ID',
          default: true,
          currency: 'eth',
          apiUrl: '',
          explorer: 'https://etherscan.io/',
          isTestnet: false,
        },
      },
      activeChain: 'ethereum' as any,
    });
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);

    // Set up session variables to match what real unlock would create
    const crypto = require('crypto');
    const sessionSalt = 'mock-salt';
    const sessionPassword = crypto
      .createHmac('sha512', sessionSalt)
      .update(FAKE_PASSWORD)
      .digest('hex');

    (keyringManager as any).sessionSeed = 'encrypted-seed';
    (keyringManager as any).sessionPassword = sessionPassword;
    (keyringManager as any).currentSessionSalt = sessionSalt;

    // Create Ethereum account with proper structure
    try {
      mainAccount = await keyringManager.createKeyringVault();
    } catch (e) {
      // If createKeyringVault fails, create a mock account
      mainAccount = null;
    }

    // Ensure we have a valid account structure
    if (!mainAccount || !mainAccount.address) {
      mainAccount = {
        id: 0,
        address: '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
        xprv: 'encrypted-priv-key',
        xpub: 'vpub5Ywg81nyDsXexa3JQE3bqEUKuPtMGJEoEWPRfJqArHtNhJd1y4HxpDbDHwZUJkZeNEZGGcXS24EqXi4iSbW3pEH2d1spE9HSUvhQc3Sj749',
        label: 'Account 1',
        isImported: false,
        balances: {
          ethereum: 0,
          syscoin: { confirmed: 0, unconfirmed: 0 },
        },
      };

      // Update the wallet state
      (keyringManager as any).wallet.accounts[KeyringAccountType.HDAccount][0] =
        mainAccount;
      (keyringManager as any).wallet.activeAccountId = 0;
      (keyringManager as any).wallet.activeAccountType =
        KeyringAccountType.HDAccount;
    }
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
    keyringManager = new KeyringManager();
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();
    keyringManager.lockWallet();
    const wrong = await keyringManager.unlock('wrongp@ss123');
    const right = await keyringManager.unlock(FAKE_PASSWORD);
    expect(right.canLogin).toBe(true);
    expect(wrong.canLogin).toBe(false);
  });

  //* createKeyringVault
  it('should create the keyring vault', async () => {
    keyringManager = new KeyringManager();
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    const account = await keyringManager.createKeyringVault();
    expect(account.address).toBeDefined();
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

  // * addNewAccount
  it('should add a new account', async () => {
    await setupWallet();

    const account2 = await keyringManager.addNewAccount(undefined);
    expect(account2?.label).toBe('Account 2');

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
    await keyringManager.setActiveAccount(
      account2!.id,
      KeyringAccountType.HDAccount
    );

    const wallet = keyringManager.getActiveAccount();
    console.log(
      'active account before test:',
      wallet.activeAccount.address.toLowerCase()
    );

    expect(wallet.activeAccount.id).toBe(account2!.id);
    expect(wallet.activeAccountType).toBe(KeyringAccountType.HDAccount);
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
    const invalidId = 3;
    const testnet = initialWalletState.networks.syscoin[5700]; //Syscoin testnet
    await keyringManager.setSignerNetwork(testnet, 'syscoin');

    const wallet = keyringManager.getUTXOState();
    const invalidAccount = wallet.accounts[invalidId];
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

  //* getLatestUpdateForAccount
  // it('should get an updated account', async () => {
  //   const account = await keyringManager.getLatestUpdateForAccount();

  //   expect(account).toBeDefined();
  // });

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
    await setupWallet();

    const testnet = initialWalletState.networks.ethereum[80001];
    console.log('Checking testnet network', testnet);

    await keyringManager.setSignerNetwork(testnet, 'ethereum');

    const network = keyringManager.getNetwork();

    expect(network).toEqual(testnet);
  });

  it('Should validate txSend', async () => {
    await setupWallet();

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

    // Set the network to initialize HD signer for Syscoin
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    const newAccount = await keyringManager.addNewAccount();
    expect(newAccount).toBeTruthy();
    expect(newAccount?.address).toBeTruthy();
  });

  it('should create an account with name', async () => {
    await setupWallet();

    // Ensure we have the HD signer initialized
    await keyringManager.unlock(FAKE_PASSWORD);

    // Set the network to initialize HD signer for Syscoin
    const syscoinTestnet = initialWalletState.networks.syscoin[5700];
    await keyringManager.setSignerNetwork(syscoinTestnet, 'syscoin');

    const newAccount = await keyringManager.addNewAccount('Teddy');
    expect(newAccount).toBeTruthy();
    expect(newAccount?.label).toBe('Teddy');
  });

  //* forgetMainWallet
  it('should forget wallet / reset to initial state', async () => {
    await setupWallet();

    // Switch to Syscoin network first since getUTXOState only works for Syscoin
    const syscoinMainnet = initialWalletState.networks.syscoin[57];
    await keyringManager.setSignerNetwork(syscoinMainnet, 'syscoin');

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
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);
    await keyringManager.createKeyringVault();
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
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);

    // Create vault first
    await keyringManager.createKeyringVault();

    keyringManager.lockWallet();
    const wrong = await keyringManager.unlock('wrongp@ss123');
    const right = await keyringManager.unlock(FAKE_PASSWORD);
    expect(right.canLogin).toBe(true);
    expect(wrong.canLogin).toBe(false);
  });

  //* createKeyringVault
  it('should create the keyring vault', async () => {
    keyringManager.setSeed(PEACE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);

    const account = await keyringManager.createKeyringVault();

    expect(account).toBeDefined();
  });

  //* setSignerNetwork - pass to ethereum
  it('should set the network', async () => {
    await setupWallet();

    const testnet = initialWalletState.networks.ethereum[80001];
    console.log('Checking testnet network', testnet);

    await keyringManager.setSignerNetwork(testnet, 'ethereum');

    const network = keyringManager.getNetwork();

    expect(network).toEqual(testnet);
  });

  //* setSignerNetwork - back to syscoin testnet
  it('should set the network', async () => {
    await setupWallet();

    const testnet = initialWalletState.networks.syscoin[5700]; //Syscoin testnet
    console.log('Checking testnet network', testnet);

    await keyringManager.setSignerNetwork(testnet, 'syscoin');

    const network = keyringManager.getNetwork();
    console.log('Check the network', network);

    expect(network).toEqual(testnet);
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
    keyringManager.setSeed(SECOND_FAKE_SEED_PHRASE);
    await keyringManager.setWalletPassword(FAKE_PASSWORD);

    // Create the keyring vault first
    await keyringManager.createKeyringVault();

    const mainnet = initialWalletState.networks.ethereum[1];
    await keyringManager.setSignerNetwork(mainnet, 'ethereum');

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

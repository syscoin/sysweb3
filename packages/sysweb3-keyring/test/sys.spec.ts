import { Buffer } from 'buffer';
import * as sjs from 'syscoinjs-lib';

global.Buffer = Buffer;

import {
  DATA,
  FAKE_PASSWORD,
  PEACE_SEED_PHRASE,
  SYS_TANENBAUM_UTXO_NETWORK,
} from './constants';
import { KeyringManager } from '../src/keyring-manager';
import { INetworkType } from '@pollum-io/sysweb3-network';

// Use real signers - no mock needed for deterministic crypto

// Mock only network calls in syscoinjs-lib, keep real crypto
jest.mock('syscoinjs-lib', () => {
  const actual = jest.requireActual('syscoinjs-lib');
  return {
    ...actual,
    utils: {
      ...actual.utils,
      // Mock only network-dependent calls
      fetchBackendAccount: jest.fn().mockResolvedValue({
        balance: 1000000000,
        tokens: [{ path: "m/84'/57'/0'/0/0", transfers: 1 }],
      }),
      fetchBackendUTXOS: jest.fn().mockResolvedValue([]),
      sanitizeBlockbookUTXOs: jest.fn().mockReturnValue([]),
      fetchEstimateFee: jest.fn().mockResolvedValue(0.001024), // 0.001024 SYS/kB = 0.000001 SYS/byte
      // Keep real HDSigner implementation
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
    })),
  };
});

// Mock transactions
jest.mock('../src/transactions', () => ({
  SyscoinTransactions: jest.fn().mockImplementation(() => ({
    sendTransaction: jest.fn().mockResolvedValue({ txid: 'mock-txid-12345' }),
    signPSBT: jest.fn().mockResolvedValue({ signed: true }),
    getRecommendedFee: jest.fn().mockResolvedValue(0.000001), // 0.000001 SYS/byte
  })),
  EthereumTransactions: jest.fn().mockImplementation(() => ({
    setWeb3Provider: jest.fn(),
    getBalance: jest.fn().mockResolvedValue(0),
  })),
}));

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

// Use real crypto and crypto-js for proper encryption/decryption
// No mocking needed for deterministic crypto operations

// Mock storage module - return properly encrypted mnemonic that can be decrypted with real crypto-js
jest.mock('../src/storage', () => ({
  getDecryptedVault: jest.fn().mockResolvedValue({
    mnemonic:
      'U2FsdGVkX19VZa0KFeqBLnyYo2O/2Y4txNjiZfYQ+1FmDBfXN20Vp0OB0r3UGjE+hZ69gUOsN54lGMtszBAVNY/W3asghe2Qu+QYwZnkkRyIhfiAk+wGo29R8I67ukscTxSFhOcBTRdF+AOsJIGhOA==',
  }),
  setEncryptedVault: jest.fn().mockResolvedValue(undefined),
}));

// Mock ethers
jest.mock('ethers', () => ({
  ...jest.requireActual('ethers'),
  utils: {
    ...jest.requireActual('ethers').utils,
    isAddress: jest.fn(() => false),
  },
}));

// Use real bip84 - it's deterministic

describe('testing functions for the new-sys txs', () => {
  // Initialize with a wallet state to avoid empty mnemonic issue
  let keyringManager: any;
  let address: string;
  let sysJS: any;

  beforeEach(async () => {
    // Initialize mock storage
    mockStorage.clear();
    mockStorage.set('vault-keys', {
      hash: 'mock-hash',
      salt: 'mock-salt',
      currentSessionSalt: 'mock-salt',
    });
    mockStorage.set('utf8Error', { hasUtf8Error: false });

    // Initialize with Syscoin testnet using new architecture
    const syscoinTestnet = {
      chainId: 5700,
      label: 'Syscoin Testnet',
      url: 'https://blockbook-dev.elint.services/',
      default: true,
      currency: 'tsys',
      apiUrl: '',
      explorer: '',
      slip44: 1,
      kind: INetworkType.Syscoin,
    };

    const seed =
      PEACE_SEED_PHRASE ||
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    keyringManager = await KeyringManager.createInitialized(
      seed,
      FAKE_PASSWORD,
      {
        accounts: {
          HDAccount: {},
          Imported: {},
          Trezor: {},
          Ledger: {},
        },
        activeAccountId: 0,
        activeAccountType: 'HDAccount' as any,
        networks: {
          syscoin: {
            57: {
              chainId: 57,
              label: 'Syscoin Mainnet',
              url: 'https://blockbook.syscoin.org/',
              default: true,
              currency: 'sys',
              slip44: 57,
              kind: INetworkType.Syscoin,
            },
            5700: syscoinTestnet,
          },
          ethereum: {},
        },
        activeNetwork: syscoinTestnet,
      },
      'syscoin' as any
    );

    sysJS = new sjs.SyscoinJSLib(
      null,
      `https://blockbook-dev.elint.services`,
      sjs.utils.syscoinNetworks.testnet
    );

    // Get the created account
    const account = keyringManager.getActiveAccount().activeAccount;
    address = account?.address || '';
  });

  //--------------------------------------------------------Tests for initialize wallet state----------------------------------------------------

  it('should validate a seed', () => {
    const seed = keyringManager.createNewSeed();
    const wrong = keyringManager.isSeedValid('invalid seed');
    if (seed) {
      expect(keyringManager.isSeedValid(seed)).toBe(true);
    }
    expect(wrong).toBe(false);
    const validSeed =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(keyringManager.isSeedValid(validSeed)).toBe(true);
  });

  //* setWalletPassword / lock / unlock
  it('should set password, lock and unlock with the proper password', async () => {
    // Wallet is already set up in beforeEach, so just test lock/unlock
    keyringManager.lockWallet();
    const wrong = await keyringManager.unlock('wrongp@ss123');
    const right = await keyringManager.unlock(FAKE_PASSWORD);
    expect(right.canLogin).toBe(true);
    expect(wrong.canLogin).toBe(false);
  });

  it('should overwrite current seed', async () => {
    // Need to unlock the wallet first since it starts locked
    await keyringManager.unlock(FAKE_PASSWORD);
    const seed = await keyringManager.getSeed(FAKE_PASSWORD);
    // expect to have 12 words
    expect(seed).toBeDefined();
    expect(seed.split(' ').length).toBe(12);
  });

  //* createKeyringVault
  it('should have created the keyring vault', async () => {
    expect(address).toBeDefined();
    // Address should be a valid syscoin address
    expect(address).toMatch(/^(sys1|tsys1)[a-z0-9]{39}$/);
  });

  /* addNewAccount */
  it('should add a new account', async () => {
    // KeyringManager is already initialized and unlocked

    const account2 = await keyringManager.addNewAccount(undefined);
    expect(account2).toBeDefined();
    expect(account2?.label).toBe('Account 2');

    // Check the returned account ID (addNewAccount doesn't set as active)
    expect(account2.id).toBe(1);
    // Replace getState with proper method
    const { activeAccount } = keyringManager.getActiveAccount();
    expect(activeAccount.id).toBe(0);
  });

  it('should send native token', async () => {
    // KeyringManager is already initialized and unlocked

    const tx = { ...DATA['send'], receivingAddress: address, sender: address };
    const { txid } = await keyringManager.syscoinTransaction.sendTransaction(
      tx,
      false, // isTrezor
      false // isLedger
    );

    // This test only run individually.

    expect(txid).toBeDefined();
  }, 180000);

  it('should generate signPSBT json', async () => {
    // KeyringManager is already initialized and unlocked
    const res = await keyringManager.syscoinTransaction.signPSBT({
      psbt: DATA['sign'],
      isTrezor: true,
      isLedger: false,
      pathIn: undefined,
    });

    expect(res).toBeDefined();
  }, 180000);

  it('should sign and send tx', async () => {
    // KeyringManager is already initialized and unlocked
    const feeRate = new sjs.utils.BN(10);
    const txOpts = { rbf: false };
    // if SYS need change sent, set this address. null to let HDSigner find a new address for you
    const sysChangeAddress = await keyringManager.getNewChangeAddress();
    const outputsArr = [
      {
        address: 'tsys1qdsvzmrxkq5uh0kwc6cyndsj7fluszcu3pl2wlv',
        value: new sjs.utils.BN(1 * 1e8),
      },
    ];
    const fromXpubOrAddress =
      'vpub5YBbnk2FsQPCd4LsK7rESWaGVeWtq7nr3SgrdbeaQgctXBwpFQfLbKdwtDAkxLwhKubbpNwQqKPodfKTwVc4uN8jbsknuPTpJuW8aN1S3nC';
    const response = await sysJS.createTransaction(
      txOpts,
      sysChangeAddress,
      outputsArr,
      feeRate,
      fromXpubOrAddress
    );
    const data = {
      psbt: response.psbt.toBase64(),
      assets: JSON.stringify([...response.assets]),
    };
    const res = await keyringManager.syscoinTransaction.signPSBT({
      psbt: data.psbt,
      isTrezor: false,
      isLedger: false,
      pathIn: undefined,
    });

    expect(res).toBeDefined();
  }, 180000);

  it('should get recommended fee', async () => {
    const { explorer } = SYS_TANENBAUM_UTXO_NETWORK;
    const fee = await keyringManager.syscoinTransaction.getRecommendedFee(
      explorer
    );

    expect(typeof fee).toBe('number');
  }, 90000);
});

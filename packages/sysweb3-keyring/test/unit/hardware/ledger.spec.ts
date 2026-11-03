import { SignTypedDataVersion, TypedDataUtils } from '@metamask/eth-sig-util';
import { INetworkType } from '@sidhujag/sysweb3-network';
import { Transaction, Wallet } from 'ethers';

import { KeyringManager, KeyringAccountType } from '../../../src';
import { LedgerKeyring } from '../../../src/ledger';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { createFreshTestKeyring, setupMocks } from '../../helpers/setup';

import type { LedgerHost } from '../../../src/ledger/host-types';

const wallet = new Wallet(`0x${'11'.repeat(32)}`);
const transactionHex = Transaction.from({
  type: 2,
  chainId: 1,
  nonce: 0,
  gasLimit: 21000,
  maxFeePerGas: 100,
  maxPriorityFeePerGas: 1,
  to: `0x${'22'.repeat(20)}`,
  value: 1,
}).unsignedSerialized.slice(2);
const signDigest = (digest: string) => {
  const signature = wallet.signingKey.sign(digest);
  return {
    r: signature.r.slice(2),
    s: signature.s.slice(2),
    v: signature.v.toString(16),
  };
};

const mockHost = () => {
  let connected = true;
  const host = {
    connect: jest.fn(async () => {
      connected = true;
    }),
    disconnect: jest.fn(async () => {
      connected = false;
    }),
    getStatus: jest.fn(() => ({ connected })),
    evm: {
      getAddress: jest.fn().mockResolvedValue({
        address: wallet.address,
        publicKey: wallet.signingKey.publicKey.slice(2),
      }),
      signTransaction: jest.fn(async ({ unsignedTxHex }) =>
        signDigest(
          Transaction.from(`0x${unsignedTxHex.replace(/^0x/, '')}`).unsignedHash
        )
      ),
      signPersonalMessage: jest.fn(async ({ messageHex }) =>
        wallet.signMessage(Buffer.from(messageHex, 'hex'))
      ),
      signTypedData: jest.fn(
        async ({ data, version }) =>
          wallet.signingKey.sign(
            `0x${TypedDataUtils.eip712Hash(data, version).toString('hex')}`
          ).serialized
      ),
    },
    utxo: {
      getXpub: jest
        .fn()
        .mockResolvedValue(
          'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
        ),
      getAddress: jest.fn().mockResolvedValue('sys1qmock_ledger_address'),
      getAccount: jest.fn(),
      signMessage: jest.fn().mockResolvedValue('signed-message'),
      signPsbt: jest
        .fn()
        .mockResolvedValue({ fingerprint: '12345678', signatures: [] }),
    },
  };
  return {
    host,
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
};

describe('Ledger semantic host integration', () => {
  let keyring: KeyringManager;
  let state: any;
  let fixture: ReturnType<typeof mockHost>;
  const additional: KeyringManager[] = [];

  beforeEach(async () => {
    setupMocks();
    await global.setupTestVault(FAKE_PASSWORD);
    fixture = mockHost();
    state = global.createMockVaultState({
      activeAccountId: 0,
      activeAccountType: KeyringAccountType.HDAccount,
      networkType: INetworkType.Syscoin,
      chainId: 57,
    });
    keyring = await createFreshTestKeyring(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      () => state,
      fixture.host as LedgerHost
    );
    keyring.getAddress = jest
      .fn()
      .mockResolvedValue('sys1qmock_ledger_address');
  });

  afterEach(async () => {
    for (const item of additional.splice(0)) await item.destroy();
    await keyring?.destroy();
  });

  it('imports a UTXO account through the injected host without private keys', async () => {
    const account = await keyring.importLedgerAccount('My Ledger');
    expect(account).toMatchObject({
      id: 0,
      label: 'My Ledger',
      isLedgerWallet: true,
      xprv: '',
      address: 'sys1qmock_ledger_address',
    });
    expect(fixture.host.utxo.getXpub).toHaveBeenCalledWith({
      currency: state.activeNetwork.currency,
      slip44: state.activeNetwork.slip44,
      accountIndex: 0,
    });
  });

  it('propagates connection failure without retrying', async () => {
    fixture.setConnected(false);
    fixture.host.connect.mockRejectedValue(new Error('Device unavailable'));
    await expect(keyring.importLedgerAccount()).rejects.toThrow(
      'Device unavailable'
    );
    expect(fixture.host.connect).toHaveBeenCalledTimes(1);
    expect(fixture.host.utxo.getXpub).not.toHaveBeenCalled();
  });

  it('imports an EVM account from the host address and public key', async () => {
    const evmState = global.createMockVaultState({
      activeAccountId: 0,
      activeAccountType: KeyringAccountType.HDAccount,
      networkType: INetworkType.Ethereum,
      chainId: 1,
    });
    const evm = await createFreshTestKeyring(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      () => evmState,
      fixture.host as LedgerHost
    );
    additional.push(evm);
    const account = await evm.importLedgerAccount('Ledger ETH');
    expect(account).toMatchObject({
      id: 0,
      label: 'Ledger ETH',
      isLedgerWallet: true,
      xprv: '',
      address: wallet.address,
    });
    expect(fixture.host.evm.getAddress).toHaveBeenCalledWith({
      accountIndex: 0,
    });
  });

  it('rejects duplicate imported addresses', async () => {
    const account = await keyring.importLedgerAccount();
    state.accounts[KeyringAccountType.Ledger][account.id] = account;
    await expect(keyring.importLedgerAccount()).rejects.toThrow(
      'Account already exists'
    );
  });

  it('keeps Ledger accounts separate and uses the next account index', async () => {
    const first = await keyring.importLedgerAccount();
    state.accounts[KeyringAccountType.Ledger][first.id] = first;
    (keyring.getAddress as jest.Mock).mockResolvedValue('sys1q_second_ledger');
    const second = await keyring.importLedgerAccount('Second');
    expect(second.id).toBe(1);
    expect(fixture.host.utxo.getXpub).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountIndex: 1 })
    );
    expect(
      Object.keys(state.accounts[KeyringAccountType.HDAccount])
    ).toHaveLength(1);
    expect(state.accounts[KeyringAccountType.HDAccount][0].isLedgerWallet).toBe(
      false
    );
  });

  it('selects the imported account and returns its stored public xpub', async () => {
    const account = await keyring.importLedgerAccount('Selected');
    state.accounts[KeyringAccountType.Ledger][account.id] = account;
    state.activeAccount = { id: account.id, type: KeyringAccountType.Ledger };
    expect(keyring.getActiveAccount().activeAccount).toMatchObject({
      label: 'Selected',
      isLedgerWallet: true,
    });
    expect(keyring.getAccountXpub()).toBe(account.xpub);
  });

  it('uses testnet identity without changing the account index', async () => {
    const testState = global.createMockVaultState({
      activeAccountId: 0,
      activeAccountType: KeyringAccountType.HDAccount,
      networkType: INetworkType.Syscoin,
      chainId: 5700,
    });
    const testnet = await createFreshTestKeyring(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      () => testState,
      fixture.host as LedgerHost
    );
    additional.push(testnet);
    testnet.getAddress = jest.fn().mockResolvedValue('tsys1qledger');
    await testnet.importLedgerAccount();
    expect(fixture.host.utxo.getXpub).toHaveBeenCalledWith({
      currency: testState.activeNetwork.currency,
      slip44: testState.activeNetwork.slip44,
      accountIndex: 0,
    });
  });

  it('cannot export a Ledger private key', async () => {
    const account = await keyring.importLedgerAccount('Private key isolation');
    state.accounts[KeyringAccountType.Ledger][account.id] = account;
    await expect(
      keyring.getPrivateKeyByAccountId(
        account.id,
        KeyringAccountType.Ledger,
        FAKE_PASSWORD
      )
    ).rejects.toThrow();
    expect(account.xprv).toBe('');
  });

  it('does not retry hardware refusal or malformed import output', async () => {
    fixture.host.utxo.getXpub.mockRejectedValue(new Error('User rejected'));
    await expect(keyring.importLedgerAccount()).rejects.toThrow(
      'User rejected'
    );
    expect(fixture.host.utxo.getXpub).toHaveBeenCalledTimes(1);
    fixture.host.utxo.getXpub.mockResolvedValue('');
    await expect(keyring.importLedgerAccount()).rejects.toThrow();
  });
});

describe('Ledger authority facade', () => {
  const address = wallet.address;
  it('fails closed without an injected host', async () => {
    const ledger = new LedgerKeyring();
    await expect(
      ledger.evm.getEvmAddressAndPubKey({ accountIndex: 0 })
    ).rejects.toMatchObject({ code: 'HARDWARE_SIGNER_UNAVAILABLE' });
  });

  it('reconnects only through the authorized host and preserves approved EVM identity', async () => {
    const { host, setConnected } = mockHost();
    setConnected(false);
    const ledger = new LedgerKeyring(undefined, host as LedgerHost);
    const request = {
      accountIndex: 2,
      rawTx: transactionHex,
      expectedAddress: address,
    };
    await expect(ledger.evm.signEVMTransaction(request)).resolves.toEqual(
      signDigest(Transaction.from(`0x${transactionHex}`).unsignedHash)
    );
    expect(host.connect).toHaveBeenCalledWith({ useGrantedDevices: true });
    expect(host.evm.signTransaction).toHaveBeenCalledWith({
      accountIndex: 2,
      unsignedTxHex: transactionHex,
      expectedAddress: address,
    });
  });

  it('forwards message bytes and typed-data version without changing their payload', async () => {
    const { host } = mockHost();
    const ledger = new LedgerKeyring(undefined, host as LedgerHost);
    await ledger.evm.signPersonalMessage({
      accountIndex: 1,
      message: '00ff',
      expectedAddress: address,
    });
    expect(host.evm.signPersonalMessage).toHaveBeenCalledWith({
      accountIndex: 1,
      messageHex: '00ff',
      expectedAddress: address,
    });
    const data = {
      domain: {},
      types: { EIP712Domain: [] },
      primaryType: 'EIP712Domain',
      message: {},
    };
    await ledger.evm.signTypedData({
      accountIndex: 1,
      data,
      version: SignTypedDataVersion.V4,
      expectedAddress: address,
    });
    expect(host.evm.signTypedData).toHaveBeenCalledWith({
      accountIndex: 1,
      data,
      version: 'V4',
      expectedAddress: address,
    });
  });

  it('rejects legacy typed data before reaching the host', async () => {
    const { host } = mockHost();
    const ledger = new LedgerKeyring(undefined, host as LedgerHost);
    await expect(
      ledger.evm.signTypedData({
        accountIndex: 0,
        data: [] as any,
        version: SignTypedDataVersion.V1,
        expectedAddress: address,
      })
    ).rejects.toMatchObject({ code: 'LEDGER_INVALID_REQUEST' });
    expect(host.evm.signTypedData).not.toHaveBeenCalled();
  });

  it('requires on-device verification for verify address', async () => {
    const { host } = mockHost();
    const ledger = new LedgerKeyring(undefined, host as LedgerHost);
    await ledger.verifyUtxoAddress(3, 'tSYS', 1);
    expect(host.utxo.getAddress).toHaveBeenCalledWith({
      accountIndex: 3,
      currency: 'tSYS',
      slip44: 1,
      checkOnDevice: true,
    });
  });

  it('invalidates a pending result synchronously when destroyed', async () => {
    const { host } = mockHost();
    let resolve!: (value: any) => void;
    host.evm.getAddress.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const ledger = new LedgerKeyring(undefined, host as LedgerHost);
    const pending = ledger.evm.getEvmAddressAndPubKey({ accountIndex: 0 });
    await ledger.destroy();
    resolve({ address, publicKey: '04' });
    await expect(pending).rejects.toMatchObject({
      code: 'HARDWARE_REQUEST_CANCELLED',
    });
    expect(host.disconnect).toHaveBeenCalledTimes(1);
  });
});

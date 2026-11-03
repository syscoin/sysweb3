import { TypedDataUtils, SignTypedDataVersion } from '@metamask/eth-sig-util';
import { hashMessage, Signature, Transaction, Wallet } from 'ethers';

import {
  createLedgerEvmAdapter,
  offlineLedgerContext,
} from '../../../src/ledger/dmk-evm';
import {
  ledgerCancelledError,
  type LedgerTypedData,
} from '../../../src/ledger/host-types';

import type { LedgerDmkSession } from '../../../src/ledger/dmk-session';

const mockContexts: unknown[] = [];
const mockSigner = {
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  signMessage: jest.fn(),
  signTypedData: jest.fn(),
};
jest.mock(
  '@ledgerhq/device-signer-kit-ethereum',
  () => ({
    SignerEthBuilder: class {
      withContextModule(context: unknown) {
        mockContexts.push(context);
        return this;
      }
      build() {
        return mockSigner;
      }
    },
  }),
  { virtual: true }
);
jest.mock(
  '@ledgerhq/context-module',
  () => ({
    ClearSignContextType: { ERROR: 'error' },
  }),
  { virtual: true }
);

// Public synthetic key used only to verify fixture signatures locally.
const wallet = new Wallet(`0x${'11'.repeat(32)}`);
const address = wallet.address;
const publicKey = wallet.signingKey.publicKey.slice(2);
const typed = (): LedgerTypedData => ({
  domain: {
    name: 'Public fixture',
    version: '1',
    chainId: 57,
    verifyingContract: `0x${'22'.repeat(20)}`,
  },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Request: [
      { name: 'memo', type: 'string' },
      { name: 'value', type: 'uint256' },
    ],
  },
  primaryType: 'Request',
  message: { memo: 'Unicode 雪', value: '123456789012345678901234567890' },
});
const rawTransaction = (type = 2) =>
  Transaction.from({
    type,
    chainId: 57,
    nonce: 3,
    to: `0x${'22'.repeat(20)}`,
    value: 123n,
    gasLimit: 21000n,
    ...(type === 0
      ? { gasPrice: 3n }
      : { maxFeePerGas: 5n, maxPriorityFeePerGas: 2n }),
  }).unsignedSerialized;
const typedDigest = (data: LedgerTypedData, version: 'V3' | 'V4') =>
  `0x${TypedDataUtils.eip712Hash(
    data as any,
    version as SignTypedDataVersion.V3 | SignTypedDataVersion.V4
  ).toString('hex')}`;

const session = () => {
  let current = true;
  const controller = new AbortController();
  const assertCurrent = () => {
    if (!current || controller.signal.aborted) throw ledgerCancelledError();
  };
  const runExclusive = jest.fn(async (run: any) =>
    run({
      dmk: {},
      sessionId: 'public-fixture',
      generation: 1,
      signal: controller.signal,
      assertCurrent,
      runAction: async (createAction: () => Promise<unknown>) => {
        assertCurrent();
        const result = await createAction();
        assertCurrent();
        return result;
      },
    })
  );
  return {
    value: { runExclusive } as unknown as LedgerDmkSession,
    runExclusive,
    signal: controller.signal,
    cancel: () => {
      current = false;
      controller.abort();
    },
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockContexts.length = 0;
  mockSigner.getAddress.mockResolvedValue({ address, publicKey });
  mockSigner.signTransaction.mockImplementation(
    async (_path: string, bytes: Uint8Array) => {
      const tx = Transaction.from(`0x${Buffer.from(bytes).toString('hex')}`);
      const signature = wallet.signingKey.sign(tx.unsignedHash);
      return {
        r: signature.r,
        s: signature.s,
        v:
          tx.type === 0
            ? Number(tx.chainId) * 2 + 35 + signature.yParity
            : signature.yParity,
      };
    }
  );
  mockSigner.signMessage.mockImplementation(
    async (_path: string, bytes: Uint8Array) => {
      const signature = Signature.from(await wallet.signMessage(bytes));
      return { r: signature.r, s: signature.s, v: signature.v };
    }
  );
  mockSigner.signTypedData.mockImplementation(
    async (_path: string, data: LedgerTypedData) => {
      const signature = wallet.signingKey.sign(typedDigest(data, 'V4'));
      return { r: signature.r, s: signature.s, v: signature.v };
    }
  );
});

it('preserves address-index derivation and validates the returned public key', async () => {
  const host = createLedgerEvmAdapter(session().value);
  await expect(
    host.getAddress({ accountIndex: 3, checkOnDevice: true, chainId: 57 })
  ).resolves.toEqual({ address, publicKey });
  expect(mockSigner.getAddress).toHaveBeenCalledWith("44'/60'/0'/0/3", {
    checkOnDevice: true,
    chainId: 57,
  });
  mockSigner.getAddress.mockResolvedValueOnce({
    address,
    publicKey: `04${'00'.repeat(64)}`,
  });
  await expect(host.getAddress({ accountIndex: 0 })).rejects.toMatchObject({
    code: 'LEDGER_INVALID_RESPONSE',
  });
});

it('denies transaction and typed signing without trusted per-operation approval', async () => {
  const current = session();
  const host = createLedgerEvmAdapter(current.value);
  await expect(
    host.signTransaction({
      accountIndex: 0,
      expectedAddress: address,
      unsignedTxHex: rawTransaction(),
    })
  ).rejects.toMatchObject({ code: 'HARDWARE_CLEAR_SIGNING_UNAVAILABLE' });
  await expect(
    host.signTypedData({
      accountIndex: 0,
      expectedAddress: address,
      data: typed(),
      version: 'V4',
    })
  ).rejects.toMatchObject({ code: 'HARDWARE_CLEAR_SIGNING_UNAVAILABLE' });
  expect(current.runExclusive).not.toHaveBeenCalled();
  expect(mockSigner.signTransaction).not.toHaveBeenCalled();
  expect(mockSigner.signTypedData).not.toHaveBeenCalled();
});

it('does not sign when the trusted host declines its exact frozen intent', async () => {
  const current = session();
  const approve = jest.fn(async (intent, signal) => {
    expect(intent.unsignedTxHex).toBe(rawTransaction());
    expect(intent.derivationPath).toBe("44'/60'/0'/0/4");
    expect(intent.expectedAddress).toBe(address);
    expect(signal).toBe(current.signal);
    expect(Object.isFrozen(intent)).toBe(true);
    return false;
  });
  const host = createLedgerEvmAdapter(current.value, {
    confirmBlindSigning: approve,
  });
  await expect(
    host.signTransaction({
      accountIndex: 4,
      expectedAddress: address,
      unsignedTxHex: rawTransaction(),
    })
  ).rejects.toMatchObject({ code: 'HARDWARE_CLEAR_SIGNING_UNAVAILABLE' });
  expect(approve).toHaveBeenCalledTimes(1);
  expect(mockSigner.signTransaction).not.toHaveBeenCalled();
});

it.each([0, 2])(
  'retains legacy facade signature encoding for transaction type %s',
  async (type) => {
    const approve = jest.fn(async () => true);
    const host = createLedgerEvmAdapter(session().value, {
      confirmBlindSigning: approve,
    });
    const result = await host.signTransaction({
      accountIndex: 2,
      expectedAddress: address,
      unsignedTxHex: rawTransaction(type),
    });
    expect(result.r).toMatch(/^[0-9a-f]{64}$/);
    expect(result.s).toMatch(/^[0-9a-f]{64}$/);
    const expected = wallet.signingKey.sign(
      Transaction.from(rawTransaction(type)).unsignedHash
    );
    expect(parseInt(result.v, 16)).toBe(
      type === 0 ? 57 * 2 + 35 + expected.yParity : expected.yParity
    );
    expect(mockSigner.signTransaction).toHaveBeenCalledWith(
      "44'/60'/0'/0/2",
      expect.any(Uint8Array)
    );
    expect(approve).toHaveBeenCalledTimes(1);
  }
);

it.each([
  '',
  '00fffe80',
  Buffer.from('Unicode 雪 / \u0000', 'utf8').toString('hex'),
])('signs the exact personal-message bytes %s offline', async (messageHex) => {
  const host = createLedgerEvmAdapter(session().value);
  const result = await host.signPersonalMessage({
    accountIndex: 1,
    expectedAddress: address,
    messageHex,
  });
  expect(result).toBe(await wallet.signMessage(Buffer.from(messageHex, 'hex')));
  expect(mockSigner.signMessage).toHaveBeenCalledWith(
    "44'/60'/0'/0/1",
    Uint8Array.from(Buffer.from(messageHex, 'hex'))
  );
  expect(hashMessage(Buffer.from(messageHex, 'hex'))).toMatch(
    /^0x[0-9a-f]{64}$/
  );
  expect(mockContexts).toEqual([offlineLedgerContext]);
});

it('has no remote metadata or reporting behavior in the default context', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Network forbidden'));
  await expect(offlineLedgerContext.getContexts({}, [])).resolves.toEqual([]);
  await expect(
    offlineLedgerContext.getFieldContext({}, 'error' as any)
  ).resolves.toMatchObject({ type: 'error' });
  await expect(
    offlineLedgerContext.getTypedDataFilters({} as any)
  ).resolves.toMatchObject({ type: 'error' });
  await offlineLedgerContext.report({} as any);
  await offlineLedgerContext.signReport?.({} as any);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});

it.each(['V3', 'V4'] as const)(
  'preserves typed-data %s digest and protects caller data from mutation',
  async (version) => {
    const data = typed();
    const before = JSON.stringify(data);
    const approve = jest.fn(async (intent) => {
      expect(intent.digest).toBe(typedDigest(data, version));
      expect(Object.isFrozen(intent.data.message)).toBe(true);
      return true;
    });
    mockSigner.signTypedData.mockImplementationOnce(
      async (_path, deviceData) => {
        const signature = wallet.signingKey.sign(
          typedDigest(deviceData, version)
        );
        deviceData.types.AddedByDevice = [];
        return { r: signature.r, s: signature.s, v: signature.v };
      }
    );
    const host = createLedgerEvmAdapter(session().value, {
      confirmBlindSigning: approve,
    });
    const result = await host.signTypedData({
      accountIndex: 0,
      expectedAddress: address,
      version,
      data,
    });
    expect(result).toBe(
      wallet.signingKey.sign(typedDigest(data, version)).serialized
    );
    expect(JSON.stringify(data)).toBe(before);
    expect(approve).toHaveBeenCalledTimes(1);
  }
);

it('rejects V3 arrays, unsupported versions and malformed bytes before any signing action', async () => {
  const host = createLedgerEvmAdapter(session().value, {
    confirmBlindSigning: async () => true,
  });
  const data = typed();
  data.types.Request = [{ name: 'values', type: 'uint256[]' }];
  data.message = { values: ['1', '2'] };
  await expect(
    host.signTypedData({
      accountIndex: 0,
      expectedAddress: address,
      version: 'V3',
      data,
    })
  ).rejects.toMatchObject({ code: 'LEDGER_INVALID_REQUEST' });
  await expect(
    host.signTypedData({
      accountIndex: 0,
      expectedAddress: address,
      version: 'V1' as any,
      data,
    })
  ).rejects.toMatchObject({ code: 'LEDGER_INVALID_REQUEST' });
  await expect(
    host.signPersonalMessage({
      accountIndex: 0,
      expectedAddress: address,
      messageHex: '0x123',
    })
  ).rejects.toMatchObject({ code: 'LEDGER_INVALID_REQUEST' });
  expect(mockSigner.signTypedData).not.toHaveBeenCalled();
  expect(mockSigner.signMessage).not.toHaveBeenCalled();
});

it('does not create a signing action after cancellation while host approval is pending', async () => {
  const current = session();
  let approve!: (value: boolean) => void;
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const host = createLedgerEvmAdapter(current.value, {
    confirmBlindSigning: () => {
      notify();
      return new Promise((done) => {
        approve = done;
      });
    },
  });
  const pending = host.signTransaction({
    accountIndex: 0,
    expectedAddress: address,
    unsignedTxHex: rawTransaction(),
  });
  await started;
  current.cancel();
  approve(true);
  await expect(pending).rejects.toMatchObject({
    code: 'HARDWARE_REQUEST_CANCELLED',
  });
  expect(mockSigner.signTransaction).not.toHaveBeenCalled();
});

it('rejects mismatched device identity and a signature from a different key', async () => {
  const host = createLedgerEvmAdapter(session().value, {
    confirmBlindSigning: async () => true,
  });
  await expect(
    host.signPersonalMessage({
      accountIndex: 0,
      expectedAddress: new Wallet(`0x${'22'.repeat(32)}`).address,
      messageHex: '01',
    })
  ).rejects.toMatchObject({ code: 'HARDWARE_ACCOUNT_MISMATCH' });
  expect(mockSigner.signMessage).not.toHaveBeenCalled();
  const other = new Wallet(`0x${'22'.repeat(32)}`);
  mockSigner.signMessage.mockResolvedValueOnce(
    Signature.from(await other.signMessage(Uint8Array.of(1)))
  );
  await expect(
    host.signPersonalMessage({
      accountIndex: 0,
      expectedAddress: address,
      messageHex: '01',
    })
  ).rejects.toMatchObject({ code: 'LEDGER_INVALID_SIGNATURE' });
});

it('asks the trusted host again for each operation instead of caching approval', async () => {
  const confirmBlindSigning = jest.fn(async () => true);
  const host = createLedgerEvmAdapter(session().value, { confirmBlindSigning });
  const request = {
    accountIndex: 0,
    expectedAddress: address,
    unsignedTxHex: rawTransaction(),
  };
  await host.signTransaction(request);
  await host.signTransaction(request);
  expect(confirmBlindSigning).toHaveBeenCalledTimes(2);
  expect(mockSigner.signTransaction).toHaveBeenCalledTimes(2);
});

it('does not let a caller replace the payload while trusted approval is pending', async () => {
  let accept!: (value: boolean) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const request = {
    accountIndex: 0,
    expectedAddress: address,
    unsignedTxHex: rawTransaction(0),
  };
  const original = request.unsignedTxHex;
  const host = createLedgerEvmAdapter(session().value, {
    confirmBlindSigning: async (intent) => {
      expect(intent.kind).toBe('transaction');
      expect(Object.isFrozen(intent)).toBe(true);
      ready();
      return new Promise((resolve) => {
        accept = resolve;
      });
    },
  });
  const pending = host.signTransaction(request);
  await started;
  request.accountIndex = 9;
  request.unsignedTxHex = rawTransaction(2);
  accept(true);
  await pending;
  expect(mockSigner.signTransaction).toHaveBeenCalledWith(
    "44'/60'/0'/0/0",
    Uint8Array.from(Buffer.from(original.slice(2), 'hex'))
  );
});

it('rejects malformed signature fields instead of exposing a partially formatted signature', async () => {
  const host = createLedgerEvmAdapter(session().value);
  mockSigner.signMessage.mockResolvedValueOnce({
    r: '0x01',
    s: `0x${'22'.repeat(32)}`,
    v: 27,
  });
  await expect(
    host.signPersonalMessage({
      accountIndex: 0,
      expectedAddress: address,
      messageHex: '01',
    })
  ).rejects.toMatchObject({ code: 'LEDGER_INVALID_SIGNATURE' });
});

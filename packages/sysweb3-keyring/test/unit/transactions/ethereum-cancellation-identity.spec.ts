// Precomputed public fixtures only. Every signing and network boundary is denied.
jest.resetModules();
(global as any).window.location = { href: 'http://localhost/' };

import { Transaction } from 'ethers/transaction';

import { BigNumber } from '../../../src/ethers-v6';
import { EthereumTransactions } from '../../../src/transactions/ethereum';
import { sendLocalEvmTransaction } from '../../../src/transactions/evm-local-signer';
import { KeyringAccountType } from '../../../src/types';

jest.mock('../../../src/providers', () => ({
  ...jest.requireActual('../../../src/providers'),
  CustomJsonRpcProvider: jest.fn(),
}));
jest.mock('../../../src/transactions/evm-local-signer', () => ({
  ...jest.requireActual('../../../src/transactions/evm-local-signer'),
  sendLocalEvmTransaction: jest.fn(),
}));

// These are existing evm-local-signer.spec.ts public vectors, not live accounts.
const RAW_LEGACY =
  '0xf865018504a817c800825208942c7536e3605d9c16a7a3d7b1898e529396a65c2301808196a09e45c98f8c125ec111da1ee78c493e4a81c6f395001db83c8d12e15a86bb6699a0395567d28d51d925f906ff930731a589c78138326bcce5687ce2b1697176ae9e';
const RAW_DYNAMIC =
  '0x02f86b018084773594008504a817c800825208942c7536e3605d9c16a7a3d7b1898e529396a65c238080c001a00e649d7c30947b140969ffd55afacebbfb1ad9a3f2598b46c9a7c83ea4b12d71a02e6f269af1511ca6337cc35761707c8459e7781502050ac87a9f8c1fe1e76c31';
const RAW_ACCESS_LIST =
  '0x01f89f01028504a817c800825208942c7536e3605d9c16a7a3d7b1898e529396a65c238080f838f7940000000000000000000000000000000000000001e1a0000000000000000000000000000000000000000000000000000000000000000080a08916200a771d6a544bc65b882ef2d78502b7c0d0822d723d0a9179f580e00dbea07b9ba2f6d11d1b0ac05e52273126193e0c23a7c4edf6bbc6e1d506066808017f';
const parsed = Transaction.from(RAW_LEGACY);
const PAYER = parsed.from!;
const CHAIN = Number(parsed.chainId);
const HASH = parsed.hash!;
const row = (raw = RAW_LEGACY) => {
  const tx = Transaction.from(raw);
  return {
    ...tx.toJSON(),
    hash: tx.hash,
    from: tx.from,
    signature: tx.signature,
    gasPrice: tx.gasPrice == null ? null : BigNumber.from(tx.gasPrice),
    maxFeePerGas:
      tx.maxFeePerGas == null ? null : BigNumber.from(tx.maxFeePerGas),
    maxPriorityFeePerGas:
      tx.maxPriorityFeePerGas == null
        ? null
        : BigNumber.from(tx.maxPriorityFeePerGas),
    gasLimit: BigNumber.from(tx.gasLimit),
    value: BigNumber.from(tx.value),
    blockNumber: null,
    blockHash: null,
  };
};

describe('cancellation original identity admission', () => {
  let sdk: EthereumTransactions;
  let state: any;
  let provider: any;
  let deny: jest.Mock;
  let getKey: jest.Mock;
  let hostCurrent: boolean;
  let validateOriginal: jest.Mock;
  const options = () => ({
    approvedMaximumFee: '9'.repeat(78),
    assertCurrentContext: () => {
      if (!hostCurrent) throw new Error('Host original changed');
    },
    validateOriginal,
  });
  const run = (fallback: any = undefined) =>
    sdk.cancelSentTransaction(HASH, true, fallback, options());

  beforeEach(() => {
    jest.clearAllMocks();
    hostCurrent = true;
    deny = jest.fn(() => {
      throw new Error('FORBIDDEN_SIGN_OR_NETWORK');
    });
    jest.spyOn(global, 'fetch').mockImplementation(deny);
    jest.mocked(sendLocalEvmTransaction).mockImplementation(() => {
      throw new Error('UNSIGNED_BOUNDARY_HARD_STOP');
    });
    getKey = jest.fn(() => ({
      address: PAYER,
      decryptedPrivateKey: 'not-a-key',
    }));
    state = {
      activeAccountType: KeyringAccountType.HDAccount,
      activeAccountId: 0,
      accounts: { HDAccount: { 0: { address: PAYER } } },
      activeNetwork: {
        kind: 'ethereum',
        chainId: CHAIN,
        slip44: 60,
        url: 'https://synthetic.invalid',
      },
    };
    provider = {
      getTransaction: jest.fn().mockResolvedValue(row()),
      getGasPrice: jest.fn().mockResolvedValue(BigNumber.from(1)),
      send: deny,
      sendTransaction: deny,
      broadcastTransaction: deny,
    };
    validateOriginal = jest.fn();
    sdk = new EthereumTransactions(
      () => state.activeNetwork,
      getKey,
      () => state,
      { evm: { signEVMTransaction: deny } } as any,
      { signEthTransaction: deny } as any
    );
    Object.defineProperty(sdk, 'web3Provider', { get: () => provider });
  });
  afterEach(() => jest.restoreAllMocks());

  it('healthy control: admits the authenticated original only to the denied unsigned boundary', async () => {
    expect(await run()).toEqual({ isCanceled: false, error: true });
    expect(sendLocalEvmTransaction).toHaveBeenCalledTimes(1);
    expect(jest.mocked(sendLocalEvmTransaction).mock.calls[0][2]).toMatchObject(
      { nonce: parsed.nonce, from: PAYER, to: PAYER }
    );
    expect(validateOriginal).toHaveBeenCalledTimes(1);
    expect(validateOriginal.mock.calls[0][0]).toMatchObject({
      hash: HASH,
      from: PAYER,
      nonce: parsed.nonce,
    });
    expect(validateOriginal.mock.calls[0][0]).not.toBe(
      await provider.getTransaction.mock.results[0].value
    );
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['hash', { hash: `0x${'22'.repeat(32)}` }],
    ['sender', { from: `0x${'33'.repeat(20)}` }],
    ['chain', { chainId: CHAIN + 1 }],
    ['nonce', { nonce: 19 }],
    ['payload', { data: '0x1234' }],
    ['unsigned original', { signature: undefined }],
    ['unsupported type', { type: 0x7f }],
    ['mined original', { blockNumber: 12, blockHash: `0x${'44'.repeat(32)}` }],
  ])(
    'rejects invalid %s before fees, credentials, signing or fallback',
    async (_label, fields) => {
      provider.getTransaction.mockResolvedValue({ ...row(), ...fields });
      await expect(run(parsed.nonce)).rejects.toThrow();
      expect(validateOriginal).not.toHaveBeenCalled();
      expect(provider.getGasPrice).not.toHaveBeenCalled();
      expect(getKey).not.toHaveBeenCalled();
      expect(deny).not.toHaveBeenCalled();
    }
  );

  it('refuses an authenticated different original despite a forged requested hash', async () => {
    provider.getTransaction.mockResolvedValue({
      ...row(RAW_DYNAMIC),
      hash: HASH,
    });
    await expect(run()).rejects.toThrow();
    expect(getKey).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it.each([RAW_DYNAMIC, RAW_ACCESS_LIST])(
    'admits supported authenticated typed original %s',
    async (raw) => {
      const original = row(raw);
      state.activeNetwork.chainId = Number(original.chainId);
      state.accounts.HDAccount[0].address = original.from;
      provider.getTransaction.mockResolvedValue(original);
      jest
        .spyOn(sdk, 'getFeeDataWithDynamicMaxPriorityFeePerGas')
        .mockResolvedValue({
          maxFeePerGas: BigNumber.from('20000000000'),
          maxPriorityFeePerGas: BigNumber.from('2000000000'),
        } as any);
      expect(
        await sdk.cancelSentTransaction(
          original.hash!,
          false,
          undefined,
          options()
        )
      ).toEqual({ isCanceled: false, error: true });
      expect(validateOriginal).toHaveBeenCalledWith(
        expect.objectContaining({ hash: original.hash, nonce: original.nonce })
      );
      expect(sendLocalEvmTransaction).toHaveBeenCalledTimes(1);
      expect(deny).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, false, 0, ''])(
    'does not treat malformed non-null lookup %p as a fallback',
    async (response) => {
      provider.getTransaction.mockResolvedValue(response);
      await expect(run(0)).rejects.toThrow();
      expect(validateOriginal).not.toHaveBeenCalled();
      expect(getKey).not.toHaveBeenCalled();
      expect(deny).not.toHaveBeenCalled();
    }
  );

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '1'])(
    'rejects invalid fallback nonce %p before lookup',
    async (nonce) => {
      provider.getTransaction.mockResolvedValue(null);
      await expect(run(nonce)).rejects.toThrow(
        'Invalid cancellation fallback nonce'
      );
      expect(provider.getTransaction).not.toHaveBeenCalled();
      expect(getKey).not.toHaveBeenCalled();
      expect(deny).not.toHaveBeenCalled();
    }
  );

  it('requires a host original validator before lookup', async () => {
    await expect(
      sdk.cancelSentTransaction(HASH, true, 0, {
        assertCurrentContext: () => undefined,
      } as any)
    ).rejects.toThrow('Cancellation original validator required');
    expect(provider.getTransaction).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it('passes explicit null to the host before admitting fallback nonce zero', async () => {
    provider.getTransaction.mockResolvedValue(null);
    expect(await run(0)).toEqual({ isCanceled: false, error: true });
    expect(validateOriginal).toHaveBeenCalledWith(null);
    expect(jest.mocked(sendLocalEvmTransaction).mock.calls[0][2].nonce).toBe(0);
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('lets the host reject unavailable-original fallback before fees or credentials', async () => {
    provider.getTransaction.mockResolvedValue(null);
    validateOriginal.mockImplementation(() => {
      throw new Error('Untrusted fallback');
    });
    await expect(run(0)).rejects.toThrow('Untrusted fallback');
    expect(validateOriginal).toHaveBeenCalledWith(null);
    expect(provider.getGasPrice).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it('retains missing-original/no-fallback behavior after explicit null validation', async () => {
    provider.getTransaction.mockResolvedValue(null);
    expect(await run()).toEqual({ isCanceled: false, error: true });
    expect(validateOriginal).toHaveBeenCalledWith(null);
    expect(getKey).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it('checks a changed host original after a delayed fee read', async () => {
    provider.getGasPrice.mockImplementation(async () => {
      hostCurrent = false;
      return BigNumber.from(1);
    });
    await expect(run()).rejects.toThrow('Host original changed');
    expect(getKey).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it('rejects a host-disallowed authenticated original before fees or credentials', async () => {
    validateOriginal.mockImplementation(() => {
      throw new Error('Reviewed nonce changed');
    });
    await expect(run()).rejects.toThrow('Reviewed nonce changed');
    expect(provider.getGasPrice).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it('keeps the authenticated nonce when the retained RPC object changes during the fee read', async () => {
    const original = row();
    provider.getTransaction.mockResolvedValue(original);
    provider.getGasPrice.mockImplementation(async () => {
      original.nonce = 19;
      original.from = `0x${'44'.repeat(20)}`;
      return BigNumber.from(1);
    });
    expect(await run()).toEqual({ isCanceled: false, error: true });
    expect(jest.mocked(sendLocalEvmTransaction).mock.calls[0][2]).toMatchObject(
      {
        nonce: parsed.nonce,
        from: PAYER,
        to: PAYER,
      }
    );
    expect(deny).not.toHaveBeenCalled();
  });

  it.each([
    ['lookup', 'resolve'],
    ['lookup', 'reject'],
    ['fallback', 'resolve'],
    ['fallback', 'reject'],
  ])(
    'rejects async %s admission before a delayed %s',
    async (source, outcome) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validation = (async () => {
        await held;
        if (outcome === 'reject') throw new Error('Delayed host rejection');
      })();
      const then = jest.spyOn(validation, 'then');
      validateOriginal.mockReturnValue(validation);
      if (source === 'fallback')
        provider.getTransaction.mockResolvedValue(null);
      try {
        await expect(
          run(source === 'fallback' ? 0 : undefined)
        ).rejects.toThrow('Original transaction validator must be synchronous');
        // The SDK attaches rejection handling before declining asynchronous
        // admission, even though the callback has not settled yet.
        expect(then).toHaveBeenCalled();
        expect(provider.getGasPrice).not.toHaveBeenCalled();
        expect(getKey).not.toHaveBeenCalled();
        expect(sendLocalEvmTransaction).not.toHaveBeenCalled();
        expect(deny).not.toHaveBeenCalled();
      } finally {
        // Only the pre-fix run needs test-owned cleanup. The passing run must
        // rely on the SDK's handler for the delayed rejection below.
        if (then.mock.calls.length === 0) validation.catch(() => undefined);
        release();
        await held;
        await Promise.resolve();
      }
    }
  );

  it('declines a custom thenable and consumes its eventual rejection', async () => {
    const then = jest.fn((_resolve, reject) =>
      reject(new Error('Thenable rejection'))
    );
    validateOriginal.mockReturnValue({ then });
    await expect(run()).rejects.toThrow(
      'Original transaction validator must be synchronous'
    );
    await Promise.resolve();
    expect(then).toHaveBeenCalledTimes(1);
    expect(provider.getGasPrice).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
    expect(sendLocalEvmTransaction).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])(
    'rejects async speed-up validation before a delayed %s',
    async (outcome) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validation = (async () => {
        await held;
        if (outcome === 'reject') throw new Error('Delayed speed-up rejection');
      })();
      const then = jest.spyOn(validation, 'then');
      validateOriginal.mockReturnValue(validation);
      provider.getBalance = jest
        .fn()
        .mockResolvedValue(BigNumber.from('1000000000000000000000000'));
      try {
        await expect(
          sdk.sendTransactionWithEditedFee(HASH, true, {
            previewOnly: true,
            validateOriginal,
          })
        ).rejects.toThrow('Original transaction validator must be synchronous');
        expect(then).toHaveBeenCalled();
        expect(provider.getBalance).not.toHaveBeenCalled();
        expect(provider.getGasPrice).not.toHaveBeenCalled();
        expect(getKey).not.toHaveBeenCalled();
        expect(sendLocalEvmTransaction).not.toHaveBeenCalled();
        expect(deny).not.toHaveBeenCalled();
      } finally {
        if (then.mock.calls.length === 0) validation.catch(() => undefined);
        release();
        await held;
        await Promise.resolve();
      }
    }
  );
});

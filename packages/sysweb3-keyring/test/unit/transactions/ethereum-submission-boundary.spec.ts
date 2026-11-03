import { INetworkType } from '@sidhujag/sysweb3-network';
import { Transaction, Wallet } from 'ethers';

import { BigNumber, serializeTransaction } from '../../../src/ethers-v6';
import { EthereumTransactions } from '../../../src/transactions/ethereum';
import { KeyringAccountType } from '../../../src/types';

const PRIVATE_KEY =
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ADDRESS = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c';
const HASH = `0x${'12'.repeat(32)}`;
const wallet = new Wallet(PRIVATE_KEY);

describe('formatted EVM transaction submission boundary', () => {
  let transaction: EthereumTransactions;
  let provider: any;
  let state: any;
  let ledger: any;
  let trezor: any;
  const request = () => ({
    from: ADDRESS,
    to: ADDRESS,
    chainId: 1,
    value: '0x0',
    gasLimit: '0x5208',
    gasPrice: '0x1',
    nonce: 0,
  });

  beforeEach(() => {
    const network = {
      kind: INetworkType.Ethereum,
      chainId: 1,
      url: 'https://rpc.ankr.com/eth',
      currency: 'eth',
    } as any;
    state = {
      activeAccountType: KeyringAccountType.HDAccount,
      activeAccountId: 0,
      activeNetwork: network,
      accounts: {
        HDAccount: { 0: { address: ADDRESS } },
        Imported: { 0: { address: ADDRESS } },
        Ledger: { 0: { address: ADDRESS } },
        Trezor: { 0: { address: ADDRESS } },
      },
    };
    ledger = {
      evm: {
        signEVMTransaction: jest.fn(async ({ rawTx }) => {
          const signature = wallet.signingKey.sign(
            Transaction.from(`0x${rawTx}`).unsignedHash
          );
          return {
            r: signature.r.slice(2),
            s: signature.s.slice(2),
            v: signature.v.toString(16),
          };
        }),
      },
    };
    trezor = {
      signEthTransaction: jest.fn().mockImplementation(async ({ tx }) => ({
        success: true,
        payload: wallet.signingKey.sign(
          Transaction.from(
            serializeTransaction({
              ...tx,
              type: tx.gasPrice === undefined ? 2 : 0,
            })
          ).unsignedHash
        ),
      })),
    };
    transaction = new EthereumTransactions(
      () => network,
      () => ({ address: ADDRESS, decryptedPrivateKey: PRIVATE_KEY }),
      () => state,
      ledger,
      trezor
    );
    provider = transaction.web3Provider as any;
    provider.getFeeData = jest.fn().mockResolvedValue({
      gasPrice: BigNumber.from(100),
      maxFeePerGas: BigNumber.from(300),
      maxPriorityFeePerGas: BigNumber.from(20),
    });
    provider.sendTransaction.mockResolvedValue({ hash: HASH });
  });

  it.each(['estimateGas', 'getFeeData', 'getGasPrice'])(
    'marks a %s failure as definitely not broadcast',
    async (method) => {
      state.activeAccountType = KeyringAccountType.Trezor;
      const failure = Object.assign(new Error('RPC temporarily unavailable'), {
        code: 'NETWORK_ERROR',
      });
      provider[method].mockRejectedValueOnce(failure);
      const params: any = request();
      if (method === 'estimateGas') delete params.gasLimit;
      if (method === 'getGasPrice') delete params.gasPrice;
      await expect(
        transaction.sendFormattedTransaction(params, method !== 'getFeeData')
      ).rejects.toMatchObject({
        message: failure.message,
        code: failure.code,
        transactionNotBroadcast: true,
      });
      expect(provider.sendTransaction).not.toHaveBeenCalled();
      expect(trezor.signEthTransaction).not.toHaveBeenCalled();
    }
  );

  it.each([KeyringAccountType.Trezor, KeyringAccountType.Ledger])(
    'marks %s signing rejection as definitely not broadcast',
    async (type) => {
      state.activeAccountType = type;
      if (type === KeyringAccountType.Trezor) {
        trezor.signEthTransaction.mockResolvedValueOnce({
          success: false,
          payload: { error: 'Cancelled' },
        });
      } else {
        ledger.evm.signEVMTransaction.mockRejectedValueOnce(
          Object.assign(new Error('Device rejected signing'), { code: 4001 })
        );
      }
      await expect(
        transaction.sendFormattedTransaction(request(), true)
      ).rejects.toMatchObject({ transactionNotBroadcast: true });
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it.each([KeyringAccountType.Trezor, KeyringAccountType.Ledger])(
    'marks a mismatched %s signature as definitely not broadcast',
    async (type) => {
      state.activeAccountType = type;
      state.accounts[type][0].address = new Wallet(
        `0x${'11'.repeat(32)}`
      ).address;
      await expect(
        transaction.sendFormattedTransaction(
          { ...request(), from: state.accounts[type][0].address },
          true
        )
      ).rejects.toMatchObject({
        code: 'HARDWARE_ACCOUNT_MISMATCH',
        transactionNotBroadcast: true,
      });
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it('marks a local signer chain-verification failure as definitely not broadcast', async () => {
    provider.verifyConfiguredChainId.mockRejectedValueOnce(
      Error('RPC chain id changed')
    );
    await expect(
      transaction.sendFormattedTransaction(request(), true)
    ).rejects.toMatchObject({ transactionNotBroadcast: true });
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    KeyringAccountType.HDAccount,
    KeyringAccountType.Trezor,
    KeyringAccountType.Ledger,
  ])(
    'keeps a failed %s broadcast ambiguous despite a reused true marker',
    async (type) => {
      state.activeAccountType = type;
      const failure = Object.freeze(
        Object.assign(new Error('RPC acknowledgement was lost'), {
          code: 'NETWORK_ERROR',
          transactionNotBroadcast: true,
        })
      );
      provider.sendTransaction.mockRejectedValueOnce(failure);
      await expect(
        transaction.sendFormattedTransaction(request(), true)
      ).rejects.toMatchObject({
        message: failure.message,
        code: failure.code,
        transactionNotBroadcast: false,
      });
      expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
      expect(failure.transactionNotBroadcast).toBe(true);
    }
  );

  it('keeps the broadcast flag isolated between concurrent calls', async () => {
    let rejectBroadcast!: (error: Error) => void;
    let started!: () => void;
    const broadcastStarted = new Promise<void>(
      (resolve) => (started = resolve)
    );
    provider.sendTransaction.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectBroadcast = reject;
          started();
        })
    );
    const first = transaction.sendFormattedTransaction(request(), true);
    const firstRejected = expect(first).rejects.toMatchObject({
      transactionNotBroadcast: false,
    });
    await broadcastStarted;
    provider.estimateGas.mockRejectedValueOnce(Error('Estimate unavailable'));
    await expect(
      transaction.sendFormattedTransaction(
        { ...request(), gasLimit: undefined },
        true
      )
    ).rejects.toMatchObject({ transactionNotBroadcast: true });
    rejectBroadcast(Error('Broadcast acknowledgement lost'));
    await firstRejected;
    expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    KeyringAccountType.HDAccount,
    KeyringAccountType.Trezor,
    KeyringAccountType.Ledger,
  ])('preserves the successful %s response', async (type) => {
    state.activeAccountType = type;
    await expect(
      transaction.sendFormattedTransaction(request(), true)
    ).resolves.toEqual({ hash: HASH });
    expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

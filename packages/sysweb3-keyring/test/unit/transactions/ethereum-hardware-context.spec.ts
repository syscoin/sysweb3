jest.resetModules();
(global as any).window.location = { href: 'http://localhost/' };
jest.mock('../../../src/providers', () => ({
  ...jest.requireActual('../../../src/providers'),
  CustomJsonRpcProvider: jest.fn(),
}));

import { Interface } from 'ethers/abi';
import { Transaction } from 'ethers/transaction';
import { Wallet } from 'ethers/wallet';

import { BigNumber, serializeTransaction } from '../../../src/ethers-v6';
import { EthereumTransactions } from '../../../src/transactions/ethereum';
import { KeyringAccountType } from '../../../src/types';

// The public key is an offline device response fixture, never a live wallet.
// SDK serialization/context/broadcast classification are real; physical I/O and
// RPC are deterministic in-memory boundaries. Pali additionally tests the real
// Ledger APDU encoder and Trezor adapter against these same signing scenarios.
const wallet = new Wallet(`0x${'11'.repeat(32)}`);
const recipient = `0x${'22'.repeat(20)}`;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe.each([KeyringAccountType.Ledger, KeyringAccountType.Trezor])(
  'ordinary %s EVM approval context',
  (kind) => {
    let sdk: EthereumTransactions;
    let state: any;
    let provider: any;
    let otherProvider: any;
    let device: jest.Mock;
    let getKey: jest.Mock;
    let sessionGeneration: number;
    let softwareUsed: boolean;
    const request = (legacy = false) => ({
      from: wallet.address,
      to: recipient,
      value: '12345',
      data: '0x',
      gasLimit: '21000',
      ...(legacy
        ? { gasPrice: '100' }
        : { maxFeePerGas: '100', maxPriorityFeePerGas: '2' }),
    });
    const send = (legacy = false) =>
      sdk.sendFormattedTransaction(request(legacy), legacy);

    beforeEach(() => {
      state = {
        activeAccountType: kind,
        activeAccountId: 0,
        activeNetwork: {
          kind: 'ethereum',
          chainId: 57057,
          slip44: 60,
          currency: 'tsys',
          url: 'https://rpc-a.invalid',
        },
        accounts: {
          [kind]: {
            0: { id: 0, address: wallet.address },
            1: { id: 1, address: new Wallet(`0x${'33'.repeat(32)}`).address },
          },
        },
      };
      const makeProvider = () => ({
        getTransactionCount: jest.fn().mockResolvedValue(7),
        sendTransaction: jest.fn(async (raw: string) => ({
          hash: Transaction.from(raw).hash,
        })),
      });
      provider = makeProvider();
      otherProvider = makeProvider();
      device = jest.fn(async (raw: string) =>
        wallet.signingKey.sign(Transaction.from(raw).unsignedHash)
      );
      const ledger: any = {
        evm: {
          signEVMTransaction: jest.fn(async ({ rawTx }) => {
            const signature = await device(`0x${rawTx}`);
            return {
              r: signature.r.slice(2),
              s: signature.s.slice(2),
              v: signature.v.toString(16),
            };
          }),
        },
      };
      const trezor: any = {
        signEthTransaction: jest.fn(async ({ tx }) => {
          const signature = await device(
            serializeTransaction({
              ...tx,
              type: tx.gasPrice === undefined ? 2 : 0,
            })
          );
          return {
            success: true,
            payload: {
              r: signature.r,
              s: signature.s,
              v: signature.v.toString(16),
            },
          };
        }),
      };
      getKey = jest.fn(() => {
        throw new Error('Hardware account must not access a software key');
      });
      sessionGeneration = 1;
      softwareUsed = false;
      sdk = new EthereumTransactions(
        () => state.activeNetwork,
        getKey,
        () => state,
        ledger,
        trezor,
        () => {
          const captured = sessionGeneration;
          return () => {
            if (sessionGeneration !== captured)
              throw new Error('Wallet signing context changed');
          };
        }
      );
      jest.spyOn(sdk, 'setWeb3Provider').mockImplementation((network: any) => {
        (sdk as any)._web3Provider =
          network.url === 'https://rpc-a.invalid' ? provider : otherProvider;
        (sdk as any)._web3ProviderKey = `${network.chainId}|${network.url}`;
      });
    });
    afterEach(() => {
      if (!softwareUsed) expect(getKey).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it.each([false, true])(
      'preserves exact valid fields and one broadcast (legacy %s)',
      async (legacy) => {
        const response = await send(legacy);
        expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
        expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
        const tx = Transaction.from(provider.sendTransaction.mock.calls[0][0]);
        expect(tx).toMatchObject({
          from: wallet.address,
          to: recipient,
          chainId: BigInt(57057),
          nonce: 7,
          value: BigInt(12345),
          gasLimit: BigInt(21000),
          data: '0x',
          type: legacy ? 0 : 2,
        });
        expect(response.hash).toBe(tx.hash);
        expect(device).toHaveBeenCalledTimes(1);
      }
    );

    it.each([
      'account',
      'network',
      'in-place network',
      'in-place address',
      'session',
    ])('discards a valid signature after pending %s switch', async (change) => {
      const entered = deferred<void>();
      const resume = deferred<void>();
      const implementation = device.getMockImplementation()!;
      device.mockImplementationOnce(async (raw: string) => {
        entered.resolve();
        await resume.promise;
        return implementation(raw);
      });
      const signing = send();
      const rejection = expect(signing).rejects.toMatchObject({
        transactionNotBroadcast: true,
      });
      await entered.promise;
      if (change === 'account') state.activeAccountId = 1;
      if (change === 'network')
        state.activeNetwork = {
          ...state.activeNetwork,
          url: 'https://rpc-b.invalid',
        };
      if (change === 'in-place network') state.activeNetwork.chainId = 1;
      if (change === 'in-place address')
        state.accounts[kind][0].address = recipient;
      if (change === 'session') sessionGeneration += 1;
      resume.resolve();
      await rejection;
      expect(provider.sendTransaction).not.toHaveBeenCalled();
      expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
    });

    it('does not ask the device to sign after the account changes during nonce lookup', async () => {
      const entered = deferred<void>();
      const nonce = deferred<number>();
      provider.getTransactionCount.mockImplementationOnce(() => {
        entered.resolve();
        return nonce.promise;
      });
      const signing = send();
      const rejection = expect(signing).rejects.toMatchObject({
        transactionNotBroadcast: true,
      });
      await entered.promise;
      state.activeAccountId = 1;
      nonce.resolve(7);
      await rejection;
      expect(device).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
      expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
    });

    it.each(['estimateGas', 'getFeeData'])(
      'stops before the device after context changes during %s',
      async (method) => {
        const entered = deferred<void>();
        const read = deferred<any>();
        provider[method] = jest.fn(() => {
          entered.resolve();
          return read.promise;
        });
        const params: any = request();
        if (method === 'estimateGas') delete params.gasLimit;
        else {
          delete params.maxFeePerGas;
          delete params.maxPriorityFeePerGas;
        }
        const signing = sdk.sendFormattedTransaction(params, false);
        const rejection = expect(signing).rejects.toMatchObject({
          transactionNotBroadcast: true,
        });
        await entered.promise;
        state.activeNetwork = {
          ...state.activeNetwork,
          url: 'https://rpc-b.invalid',
        };
        read.resolve(
          method === 'estimateGas'
            ? '21000'
            : { maxFeePerGas: '100', maxPriorityFeePerGas: '2' }
        );
        await rejection;
        expect(device).not.toHaveBeenCalled();
        expect(provider.sendTransaction).not.toHaveBeenCalled();
        expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
      }
    );

    it('retains the acknowledged hash when selection changes only after publication starts', async () => {
      const entered = deferred<void>();
      const ack = deferred<any>();
      let hash: string;
      provider.sendTransaction.mockImplementationOnce((raw: string) => {
        hash = Transaction.from(raw).hash!;
        entered.resolve();
        return ack.promise;
      });
      const signing = send();
      await entered.promise;
      state.activeAccountId = 1;
      state.activeNetwork = {
        ...state.activeNetwork,
        url: 'https://rpc-b.invalid',
      };
      ack.resolve({ hash: hash! });
      await expect(signing).resolves.toEqual({ hash: hash! });
      expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
      expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
      expect(device).toHaveBeenCalledTimes(1);
    });

    describe.each([
      [
        'ERC20 zero decimals',
        'sendSignedErc20Transaction',
        'transfer(address,uint256)',
        ['2'],
        0,
      ],
      [
        'ERC20 eight decimals',
        'sendSignedErc20Transaction',
        'transfer(address,uint256)',
        ['200000001'],
        8,
      ],
      [
        'ERC721 large id',
        'sendSignedErc721Transaction',
        'transferFrom(address,address,uint256)',
        ['9007199254740993'],
        0,
      ],
      [
        'ERC1155 large integer',
        'sendSignedErc1155Transaction',
        'safeTransferFrom(address,address,uint256,uint256,bytes)',
        ['9007199254740993'],
        0,
      ],
    ] as const)(
      '%s token approval',
      (_name, method, fragment, [atomic], decimals) => {
        const tokenAddress = `0x${'44'.repeat(20)}`;
        const sendToken = (legacy = false) => {
          // Model the old hardware getter's real empty-key return, not a fake
          // software key. New code must not ask for it on hardware routes at all.
          getKey.mockReturnValue({
            address: wallet.address,
            decryptedPrivateKey: softwareUsed ? wallet.privateKey : '',
          });
          return sdk[method]({
            tokenAddress,
            receiver: recipient,
            tokenAmount:
              method === 'sendSignedErc1155Transaction'
                ? atomic
                : decimals === 8
                ? '2.00000001'
                : '2',
            tokenId: '9007199254740993',
            decimals,
            gasLimit: '200000',
            isLegacy: legacy,
            ...(legacy
              ? { gasPrice: '100' }
              : { maxFeePerGas: '100', maxPriorityFeePerGas: '2' }),
          });
        };

        it.each([false, true])(
          'preserves exact standard calldata and fee fields (legacy %s)',
          async (legacy) => {
            const response = await sendToken(legacy);
            expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
            const tx = Transaction.from(
              provider.sendTransaction.mock.calls[0][0]
            );
            expect(tx).toMatchObject({
              from: wallet.address,
              to: tokenAddress,
              value: BigInt(0),
              nonce: 7,
              chainId: BigInt(57057),
              gasLimit: BigInt(200000),
              type: legacy ? 0 : 2,
            });
            const parsed = new Interface([
              `function ${fragment}`,
            ]).parseTransaction({ data: tx.data })!;
            if (method === 'sendSignedErc20Transaction')
              expect(Array.from(parsed.args)).toEqual([
                recipient,
                BigInt(atomic),
              ]);
            else if (method === 'sendSignedErc721Transaction')
              expect(Array.from(parsed.args)).toEqual([
                wallet.address,
                recipient,
                BigInt(atomic),
              ]);
            else
              expect(Array.from(parsed.args)).toEqual([
                wallet.address,
                recipient,
                BigInt('9007199254740993'),
                BigInt(atomic),
                '0x',
              ]);
            expect(response.hash).toBe(tx.hash);
            expect(device).toHaveBeenCalledTimes(1);
            expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
          }
        );

        it.each(['rejection', 'disconnect'])(
          'does not send after device %s',
          async (failure) => {
            const error = Object.assign(
              new Error(
                failure === 'rejection'
                  ? 'User rejected'
                  : 'Device disconnected'
              ),
              {
                name: failure === 'rejection' ? 'UserCancel' : 'TransportError',
              }
            );
            device.mockRejectedValueOnce(error);
            await expect(sendToken()).rejects.toBe(error);
            expect(device).toHaveBeenCalledTimes(1);
            expect(provider.sendTransaction).not.toHaveBeenCalled();
            expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
          }
        );

        it.each(['account', 'network', 'session'])(
          'discards the valid signature after pending %s switch',
          async (change) => {
            const entered = deferred<void>();
            const resume = deferred<void>();
            const implementation = device.getMockImplementation()!;
            device.mockImplementationOnce(async (raw: string) => {
              entered.resolve();
              await resume.promise;
              return implementation(raw);
            });
            const signing = sendToken();
            const rejection = expect(signing).rejects.toThrow(
              'Wallet signing context changed'
            );
            await entered.promise;
            if (change === 'account') state.activeAccountId = 1;
            if (change === 'network')
              state.activeNetwork = {
                ...state.activeNetwork,
                url: 'https://rpc-b.invalid',
              };
            if (change === 'session') sessionGeneration += 1;
            resume.resolve();
            await rejection;
            expect(provider.sendTransaction).not.toHaveBeenCalled();
            expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
          }
        );

        it('stops before hardware when selection changes during pending nonce read', async () => {
          const entered = deferred<void>();
          const nonce = deferred<number>();
          provider.getTransactionCount.mockImplementationOnce(() => {
            entered.resolve();
            return nonce.promise;
          });
          const signing = sendToken();
          const rejection = expect(signing).rejects.toThrow(
            'Wallet signing context changed'
          );
          await entered.promise;
          state.activeAccountId = 1;
          nonce.resolve(7);
          await rejection;
          expect(device).not.toHaveBeenCalled();
          expect(provider.sendTransaction).not.toHaveBeenCalled();
        });

        if (kind === KeyringAccountType.Ledger)
          describe('software route controls (no physical hardware)', () => {
            beforeEach(() => {
              softwareUsed = true;
              state.activeAccountType = KeyringAccountType.HDAccount;
              state.accounts.HDAccount = { ...state.accounts[kind] };
              provider.verifyConfiguredChainId = jest
                .fn()
                .mockResolvedValue(undefined);
            });

            it('retains the real local-signing success path without requesting a device', async () => {
              const response = await sendToken();
              expect(getKey).toHaveBeenCalledTimes(1);
              expect(device).not.toHaveBeenCalled();
              expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
              const tx = Transaction.from(
                provider.sendTransaction.mock.calls[0][0]
              );
              expect(tx.from).toBe(wallet.address);
              expect(response.hash).toBe(tx.hash);
            });

            it.each(['getTransactionCount', 'verifyConfiguredChainId'])(
              'refuses a stale software result after %s is pending',
              async (method) => {
                const entered = deferred<void>();
                const reply = deferred<any>();
                provider[method].mockImplementationOnce(() => {
                  entered.resolve();
                  return reply.promise;
                });
                const signing = sendToken();
                const rejection = expect(signing).rejects.toThrow(
                  'Wallet signing context changed'
                );
                await entered.promise;
                state.activeAccountId = 1;
                reply.resolve(method === 'getTransactionCount' ? 7 : undefined);
                await rejection;
                expect(getKey).toHaveBeenCalledTimes(1);
                expect(device).not.toHaveBeenCalled();
                expect(provider.sendTransaction).not.toHaveBeenCalled();
                expect(otherProvider.sendTransaction).not.toHaveBeenCalled();
              }
            );
          });
      }
    );
  }
);

describe('EVM cancellation signing context', () => {
  // Public deterministic fixtures, never real wallet keys. Software signing and
  // device transaction encoders are real; provider and device I/O stay in memory.
  const wallet = new Wallet(`0x${'01'.repeat(32)}`);
  const otherWallet = new Wallet(`0x${'02'.repeat(32)}`);
  const PAYER = wallet.address;
  let HASH: string;
  const CHAIN = 5700;
  const accountTypes = [
    KeyringAccountType.HDAccount,
    KeyringAccountType.Imported,
    KeyringAccountType.Ledger,
    KeyringAccountType.Trezor,
  ];
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  };
  const deviceSignature = (params: any) => {
    const tx = Transaction.from(
      typeof params === 'string' ? params : serializeTransaction(params)
    );
    return wallet.signingKey.sign(tx.unsignedHash);
  };

  let state: any;
  let session: object;
  let sdk: EthereumTransactions;
  let provider: any;
  let currentProvider: any;
  let getKey: jest.Mock;
  let ledger: any;
  let trezor: any;
  let signed: Transaction[];
  let hostCurrent: boolean;
  let assertHostContext: () => void;

  const run = (legacy = true, fallbackNonce?: number) =>
    sdk.cancelSentTransaction(HASH, legacy, fallbackNonce, {
      assertCurrentContext: assertHostContext,
      approvedMaximumFee: '9'.repeat(78),
      validateOriginal: () => undefined,
    });
  const original = (nonce = 7, fields: any = {}) => {
    const type = fields.type ?? 2;
    const tx = Transaction.from({
      type,
      chainId: CHAIN,
      nonce,
      to: PAYER,
      value: 0,
      data: '0x',
      gasLimit: 21000,
      ...(type === 0
        ? { gasPrice: (fields.gasPrice ?? 100).toString() }
        : {
            maxFeePerGas: (fields.maxFeePerGas ?? 100).toString(),
            maxPriorityFeePerGas: (
              fields.maxPriorityFeePerGas ?? 10
            ).toString(),
          }),
    });
    tx.signature = wallet.signingKey.sign(tx.unsignedHash);
    HASH = tx.hash!;
    return {
      ...tx.toJSON(),
      signature: tx.signature,
      hash: HASH,
      from: PAYER,
      nonce,
      gasPrice: BigNumber.from(tx.gasPrice ?? fields.gasPrice ?? 100),
      maxFeePerGas:
        tx.maxFeePerGas === null ? undefined : BigNumber.from(tx.maxFeePerGas),
      maxPriorityFeePerGas:
        tx.maxPriorityFeePerGas === null
          ? undefined
          : BigNumber.from(tx.maxPriorityFeePerGas),
      gasLimit: BigNumber.from(21000),
    };
  };
  const mutate = (change: string) => {
    switch (change) {
      case 'account':
        state.activeAccountId = 1;
        break;
      case 'account type':
        state.activeAccountType = KeyringAccountType.Imported;
        break;
      case 'address':
        state.accounts[state.activeAccountType][0].address =
          otherWallet.address;
        break;
      case 'chain':
        state.activeNetwork.chainId += 1;
        break;
      case 'network kind':
        state.activeNetwork.kind = 'syscoin';
        break;
      case 'RPC':
        state.activeNetwork.url += '/changed';
        break;
      case 'slip44':
        state.activeNetwork.slip44 += 1;
        break;
      case 'provider':
        currentProvider = { ...provider };
        break;
      case 'session':
        session = {};
        break;
      default:
        throw new Error(`Unknown fixture mutation: ${change}`);
    }
  };
  const changes = [
    'account',
    'account type',
    'address',
    'chain',
    'network kind',
    'RPC',
    'slip44',
    'provider',
    'session',
  ];

  beforeEach(() => {
    signed = [];
    session = {};
    hostCurrent = true;
    assertHostContext = () => {
      if (!hostCurrent) throw new Error('Host selection changed');
    };
    state = {
      activeAccountType: KeyringAccountType.HDAccount,
      activeAccountId: 0,
      activeNetwork: {
        chainId: CHAIN,
        kind: 'ethereum',
        slip44: 60,
        currency: 'tsys',
        url: 'https://rpc.invalid',
      },
      accounts: Object.fromEntries(
        accountTypes.map((type) => [
          type,
          { 0: { address: PAYER }, 1: { address: otherWallet.address } },
        ])
      ),
    };
    provider = {
      getTransaction: jest.fn().mockResolvedValue(original()),
      getGasPrice: jest.fn().mockResolvedValue(BigNumber.from(100)),
      getNetwork: jest.fn().mockResolvedValue({ chainId: CHAIN }),
      getTransactionCount: jest.fn().mockResolvedValue(99),
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      sendTransaction: jest.fn(async (raw: string) => {
        const tx = Transaction.from(raw);
        signed.push(tx);
        return { hash: tx.hash, from: tx.from, nonce: tx.nonce };
      }),
    };
    currentProvider = provider;
    getKey = jest.fn(() => ({
      address: PAYER,
      decryptedPrivateKey: wallet.privateKey,
    }));
    ledger = {
      evm: {
        signEVMTransaction: jest.fn(async ({ rawTx }) => {
          const signature = deviceSignature(`0x${rawTx}`);
          return {
            r: signature.r.slice(2),
            s: signature.s.slice(2),
            v: signature.v.toString(16),
          };
        }),
      },
    };
    trezor = {
      signEthTransaction: jest.fn(async ({ tx }) => {
        const signature = deviceSignature(tx);
        return {
          success: true,
          payload: { r: signature.r, s: signature.s, v: signature.v },
        };
      }),
    };
    sdk = new EthereumTransactions(
      () => state.activeNetwork,
      getKey,
      () => state,
      ledger,
      trezor,
      () => {
        const captured = session;
        return () => {
          if (captured !== session) throw new Error('Session changed');
        };
      }
    );
    Object.defineProperty(sdk, 'web3Provider', {
      get: () => currentProvider,
    });
    jest
      .spyOn(sdk, 'getFeeDataWithDynamicMaxPriorityFeePerGas')
      .mockResolvedValue({
        gasPrice: BigNumber.from(100),
        baseFeePerGas: BigNumber.from(1),
        maxFeePerGas: BigNumber.from(100),
        maxPriorityFeePerGas: BigNumber.from(10),
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(
    accountTypes.flatMap((type) =>
      [true, false].flatMap((legacy) =>
        [0, 7].flatMap((nonce) =>
          [true, false].map((missing) => ({ type, legacy, nonce, missing }))
        )
      )
    )
  )('preserves cancellation payload and exact fees for %j', async (test) => {
    state.activeAccountType = test.type;
    provider.getTransaction.mockResolvedValue(
      test.missing ? null : original(test.nonce, { type: test.legacy ? 0 : 2 })
    );
    sdk.setGasOverrides({ minGasLimit: '99999' });
    const result = await run(test.legacy, test.nonce);
    expect(result.isCanceled).toBe(true);
    expect(signed).toHaveLength(1);
    const tx = signed[0];
    expect(tx.from).toBe(PAYER);
    expect(tx.to).toBe(PAYER);
    expect(tx.nonce).toBe(test.nonce);
    expect(tx.chainId).toBe(BigInt(CHAIN));
    expect(tx.gasLimit).toBe(BigInt(42000));
    expect(tx.value).toBe(BigInt(0));
    expect(tx.data).toBe('0x');
    expect(tx.type).toBe(test.legacy ? 0 : 2);
    if (test.legacy) expect(tx.gasPrice).toBe(BigInt(120));
    else {
      expect(tx.maxFeePerGas).toBe(BigInt(120));
      expect(tx.maxPriorityFeePerGas).toBe(BigInt(12));
    }
    expect(provider.getTransactionCount).not.toHaveBeenCalled();
    if (!test.legacy)
      expect(
        sdk.getFeeDataWithDynamicMaxPriorityFeePerGas
      ).toHaveBeenCalledWith(provider);
    if (
      [KeyringAccountType.Ledger, KeyringAccountType.Trezor].includes(test.type)
    )
      expect(getKey).not.toHaveBeenCalled();
  });

  it.each(changes)(
    'rejects changed %s after original lookup, before any signing',
    async (change) => {
      const held = deferred<any>();
      provider.getTransaction.mockReturnValue(held.promise);
      const result = run();
      const rejected = expect(result).rejects.toThrow();
      mutate(change);
      held.resolve(original());
      await rejected;
      expect(getKey).not.toHaveBeenCalled();
      expect(ledger.evm.signEVMTransaction).not.toHaveBeenCalled();
      expect(trezor.signEthTransaction).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it.each(
    [true, false].flatMap((legacy) =>
      [true, false].map((missing) => ({ legacy, missing }))
    )
  )(
    'rejects a changed session after delayed fee lookup for %j',
    async ({ legacy, missing }) => {
      provider.getTransaction.mockResolvedValue(missing ? null : original());
      const started = deferred<void>();
      const held = deferred<any>();
      const lookup = () => {
        started.resolve();
        return held.promise;
      };
      if (legacy) provider.getGasPrice.mockImplementation(lookup);
      else
        jest
          .mocked(sdk.getFeeDataWithDynamicMaxPriorityFeePerGas)
          .mockImplementation(lookup);
      const result = run(legacy, 7);
      const rejected = expect(result).rejects.toThrow('Session changed');
      await started.promise;
      session = {};
      held.resolve(
        legacy
          ? BigNumber.from(100)
          : {
              maxFeePerGas: BigNumber.from(100),
              maxPriorityFeePerGas: BigNumber.from(10),
            }
      );
      await rejected;
      expect(getKey).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it.each(changes)(
    'rejects changed %s before software signing after provider preflight',
    async (change) => {
      const started = deferred<void>();
      const held = deferred<void>();
      provider.verifyConfiguredChainId.mockImplementation(() => {
        started.resolve();
        return held.promise;
      });
      const result = run();
      await started.promise;
      mutate(change);
      held.resolve();
      expect(await result).toEqual({ isCanceled: false, error: true });
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it.each(
    [KeyringAccountType.Ledger, KeyringAccountType.Trezor].flatMap((type) =>
      changes.map((change) => ({ type, change }))
    )
  )(
    'does not broadcast delayed hardware approval after %j',
    async ({ type, change }) => {
      state.activeAccountType = type;
      const started = deferred<void>();
      const held = deferred<void>();
      const device =
        type === KeyringAccountType.Ledger
          ? ledger.evm.signEVMTransaction
          : trezor.signEthTransaction;
      const implementation = device.getMockImplementation();
      device.mockImplementation(async (params: any) => {
        started.resolve();
        await held.promise;
        return implementation(params);
      });
      const result = run();
      await started.promise;
      mutate(change);
      held.resolve();
      expect(await result).toEqual({ isCanceled: false, error: true });
      expect(provider.sendTransaction).not.toHaveBeenCalled();
      expect(getKey).not.toHaveBeenCalled();
    }
  );

  it('rejects a private-key lookup returning another account', async () => {
    getKey.mockReturnValue({
      address: otherWallet.address,
      decryptedPrivateKey: otherWallet.privateKey,
    });
    expect(await run()).toEqual({ isCanceled: false, error: true });
    expect(provider.verifyConfiguredChainId).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it.each(accountTypes)(
    'retains a %s acknowledged hash when context changes after submission',
    async (type) => {
      state.activeAccountType = type;
      provider.sendTransaction.mockImplementation(async (raw: string) => {
        state.activeNetwork.chainId += 1;
        return { hash: Transaction.from(raw).hash };
      });
      const result = await run();
      expect(result.isCanceled).toBe(true);
      expect(result.transaction?.hash).toMatch(/^0x[\da-f]{64}$/);
    }
  );

  it('preserves missing-original/no-fallback behavior without signing', async () => {
    provider.getTransaction.mockResolvedValue(null);
    expect(await run()).toEqual({ isCanceled: false, error: true });
    expect(getKey).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'keeps the one-wei minimum bump (legacy=%s)',
    async (legacy) => {
      provider.getTransaction.mockResolvedValue({
        ...original(7, {
          type: legacy ? 0 : 2,
          gasPrice: BigNumber.from(0),
          maxFeePerGas: BigNumber.from(1),
          maxPriorityFeePerGas: BigNumber.from(0),
        }),
      });
      provider.getGasPrice.mockResolvedValue(BigNumber.from(0));
      jest
        .mocked(sdk.getFeeDataWithDynamicMaxPriorityFeePerGas)
        .mockResolvedValue({
          gasPrice: BigNumber.from(0),
          baseFeePerGas: BigNumber.from(0),
          maxFeePerGas: BigNumber.from(1),
          maxPriorityFeePerGas: BigNumber.from(0),
        });
      expect((await run(legacy)).isCanceled).toBe(true);
      if (legacy) expect(signed[0].gasPrice).toBe(BigInt(1));
      else {
        expect(signed[0].maxFeePerGas).toBe(BigInt(2));
        expect(signed[0].maxPriorityFeePerGas).toBe(BigInt(1));
      }
    }
  );

  it.each([true, false])(
    'retains large integer fee precision (legacy=%s)',
    async (legacy) => {
      const large = BigNumber.from('1000000000000000003');
      provider.getTransaction.mockResolvedValue({
        ...original(7, {
          type: legacy ? 0 : 2,
          gasPrice: large,
          maxFeePerGas: large,
        }),
      });
      expect((await run(legacy)).isCanceled).toBe(true);
      const fee = legacy ? signed[0].gasPrice : signed[0].maxFeePerGas;
      expect(fee).toBe(BigInt('1200000000000000003'));
    }
  );

  it.each([
    { legacy: true, fee: -1 },
    { legacy: true, fee: Number.MAX_SAFE_INTEGER + 1 },
    { legacy: true, fee: 'not-a-fee' },
    { legacy: false, maximum: 0, priority: 0 },
    { legacy: false, maximum: 1, priority: 2 },
    { legacy: false, maximum: 1, priority: -1 },
    { legacy: false, maximum: 'not-a-fee', priority: 0 },
  ])(
    'rejects invalid cancellation fee data %j before signing',
    async (test) => {
      if (test.legacy) provider.getGasPrice.mockResolvedValue(test.fee);
      else {
        jest
          .mocked(sdk.getFeeDataWithDynamicMaxPriorityFeePerGas)
          .mockResolvedValue({
            maxFeePerGas: test.maximum,
            maxPriorityFeePerGas: test.priority,
          } as any);
      }
      await expect(run(test.legacy)).rejects.toThrow();
      expect(getKey).not.toHaveBeenCalled();
      expect(ledger.evm.signEVMTransaction).not.toHaveBeenCalled();
      expect(trezor.signEthTransaction).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it.each(['lookup', 'legacy fee', 'dynamic fee'])(
    'does not sign after %s failure',
    async (step) => {
      const error = new Error('Synthetic unavailable RPC');
      if (step === 'lookup') provider.getTransaction.mockRejectedValue(error);
      if (step === 'legacy fee') provider.getGasPrice.mockRejectedValue(error);
      if (step === 'dynamic fee')
        jest
          .mocked(sdk.getFeeDataWithDynamicMaxPriorityFeePerGas)
          .mockRejectedValue(error);
      await expect(run(step !== 'dynamic fee')).rejects.toBe(error);
      expect(getKey).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it.each([KeyringAccountType.Ledger, KeyringAccountType.Trezor])(
    'preserves %s device rejection without broadcast',
    async (type) => {
      state.activeAccountType = type;
      const device =
        type === KeyringAccountType.Ledger
          ? ledger.evm.signEVMTransaction
          : trezor.signEthTransaction;
      device.mockRejectedValue(new Error('Synthetic device rejection'));
      expect(await run()).toEqual({ isCanceled: false, error: true });
      expect(getKey).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it.each(accountTypes)(
    'checks a host selection hidden by the %s keyring payer selection',
    async (type) => {
      state.activeAccountType = type;
      let hostScope = 'smart-account-a';
      const assertCurrentContext = jest.fn(() => {
        if (hostScope !== 'smart-account-a')
          throw new Error('Host selection changed');
      });
      const entered = deferred<void>();
      const held = deferred<void>();
      provider.getTransaction.mockImplementation(async () => {
        entered.resolve();
        await held.promise;
        return original();
      });
      const pending = sdk.cancelSentTransaction(HASH, true, 7, {
        assertCurrentContext,
        approvedMaximumFee: '9'.repeat(78),
        validateOriginal: () => undefined,
      });
      const rejected = expect(pending).rejects.toThrow(
        'Host selection changed'
      );
      await entered.promise;
      hostScope = 'smart-account-b';
      held.resolve();
      await rejected;
      expect(state.activeAccountType).toBe(type);
      expect(state.activeAccountId).toBe(0);
      expect(assertCurrentContext).toHaveBeenCalled();
      expect(getKey).not.toHaveBeenCalled();
      expect(ledger.evm.signEVMTransaction).not.toHaveBeenCalled();
      expect(trezor.signEthTransaction).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it.each(accountTypes)(
    'keeps a %s acknowledged hash after the host selection changes at submission',
    async (type) => {
      state.activeAccountType = type;
      let current = true;
      provider.sendTransaction.mockImplementation(async (raw: string) => {
        current = false;
        return { hash: Transaction.from(raw).hash };
      });
      const result = await sdk.cancelSentTransaction(HASH, true, 7, {
        approvedMaximumFee: '9'.repeat(78),
        validateOriginal: () => undefined,
        assertCurrentContext: () => {
          if (!current) throw new Error('Host selection changed');
        },
      });
      expect(result.isCanceled).toBe(true);
      expect(result.transaction?.hash).toMatch(/^0x[\da-f]{64}$/);
    }
  );

  it.each([KeyringAccountType.Ledger, KeyringAccountType.Trezor])(
    'checks the host guard after a pending %s device response',
    async (type) => {
      state.activeAccountType = type;
      let current = true;
      const entered = deferred<void>();
      const held = deferred<void>();
      const device =
        type === KeyringAccountType.Ledger
          ? ledger.evm.signEVMTransaction
          : trezor.signEthTransaction;
      const implementation = device.getMockImplementation();
      device.mockImplementation(async (params: any) => {
        entered.resolve();
        await held.promise;
        return implementation(params);
      });
      const pending = sdk.cancelSentTransaction(HASH, true, 7, {
        approvedMaximumFee: '9'.repeat(78),
        validateOriginal: () => undefined,
        assertCurrentContext: () => {
          if (!current) throw new Error('Host selection changed');
        },
      });
      await entered.promise;
      current = false;
      held.resolve();
      expect(await pending).toEqual({ isCanceled: false, error: true });
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it('checks the host guard before private-key signing after provider preflight', async () => {
    let current = true;
    provider.verifyConfiguredChainId.mockImplementation(async () => {
      current = false;
    });
    const result = await sdk.cancelSentTransaction(HASH, true, 7, {
      approvedMaximumFee: '9'.repeat(78),
      validateOriginal: () => undefined,
      assertCurrentContext: () => {
        if (!current) throw new Error('Host selection changed');
      },
    });
    expect(result).toEqual({ isCanceled: false, error: true });
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { assertCurrentContext: null },
    { assertCurrentContext: true },
  ])(
    'rejects missing or invalid required host context %p before runtime access',
    async (options) => {
      const capture = jest.spyOn(sdk as any, 'captureEvmSigningContext');
      await expect(
        sdk.cancelSentTransaction(HASH, true, 7, options as any)
      ).rejects.toThrow('Cancellation context required');
      expect(capture).not.toHaveBeenCalled();
      expect(provider.getTransaction).not.toHaveBeenCalled();
      expect(provider.getGasPrice).not.toHaveBeenCalled();
      expect(getKey).not.toHaveBeenCalled();
      expect(ledger.evm.signEVMTransaction).not.toHaveBeenCalled();
      expect(trezor.signEthTransaction).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it('rejects the former three-argument invocation before runtime access', async () => {
    await expect(
      (sdk.cancelSentTransaction as any)(HASH, true, 7)
    ).rejects.toThrow('Cancellation context required');
    expect(provider.getTransaction).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects an already-stale explicit host context before runtime access', async () => {
    hostCurrent = false;
    await expect(run()).rejects.toThrow('Host selection changed');
    expect(provider.getTransaction).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });
});

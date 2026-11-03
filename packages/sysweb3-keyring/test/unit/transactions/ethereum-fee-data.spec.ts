jest.resetModules();
(global as any).window.location = { href: 'http://localhost/' };
jest.mock('../../../src/transactions/evm-local-signer', () => ({
  ...jest.requireActual('../../../src/transactions/evm-local-signer'),
  sendLocalEvmTransaction: jest.fn(),
}));
jest.mock('../../../src/providers', () => ({
  ...jest.requireActual('../../../src/providers'),
  CustomJsonRpcProvider: jest.fn(),
}));

import { INetworkType } from '@sidhujag/sysweb3-network';
import { spawnSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Transaction } from 'ethers/transaction';
import { Wallet } from 'ethers/wallet';

import { BigNumber, normalizeTransactionRequest } from '../../../src/ethers-v6';
import { EthereumTransactions } from '../../../src/transactions/ethereum';
import { sendLocalEvmTransaction } from '../../../src/transactions/evm-local-signer';
import { KeyringAccountType } from '../../../src/types';

const originalWallet = new Wallet(`0x${'11'.repeat(32)}`);
const FROM = originalWallet.address;
const TO = `0x${'22'.repeat(20)}`;
let HASH = `0x${'33'.repeat(32)}`;
const network = {
  chainId: 5700,
  kind: INetworkType.Ethereum,
  url: 'https://unit-only.test',
} as any;
const transaction = {
  from: FROM,
  to: TO,
  chainId: 5700,
  nonce: 0,
  gasLimit: '21000',
  value: '0x7',
  data: '0x1234',
};
const localSend = sendLocalEvmTransaction as jest.Mock;
const cancellationOriginal = (fields: any = {}) => {
  const tx = Transaction.from({
    type: 2,
    chainId: network.chainId,
    nonce: 0,
    to: TO,
    value: 7,
    data: '0x1234',
    gasLimit: 21000,
    maxFeePerGas: (fields.maxFeePerGas ?? 100).toString(),
    maxPriorityFeePerGas: (fields.maxPriorityFeePerGas ?? 0).toString(),
  });
  tx.signature = originalWallet.signingKey.sign(tx.unsignedHash);
  HASH = tx.hash!;
  return {
    ...tx.toJSON(),
    hash: HASH,
    from: FROM,
    signature: tx.signature,
    gasLimit: BigNumber.from(21000),
    gasPrice: BigNumber.from(7),
    maxFeePerGas: BigNumber.from(tx.maxFeePerGas!),
    maxPriorityFeePerGas: BigNumber.from(tx.maxPriorityFeePerGas!),
  };
};

describe('package release preflight', () => {
  it('inspects only dist without lifecycle hooks, publication or a written tarball', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '../../../package.json'), 'utf8')
    );
    const [command, ...args] =
      manifest.scripts['release:preflight'].split(/\s+/);
    // Check before execution: the former Yarn recipe writes a source tarball.
    expect(command).toBe('npm');
    expect(args).toEqual([
      'pack',
      './dist',
      '--dry-run',
      '--json',
      '--ignore-scripts',
    ]);
    const directory = mkdtempSync(join(tmpdir(), 'sysweb3-release-preflight-'));
    try {
      mkdirSync(join(directory, 'dist', 'cjs'), { recursive: true });
      const scripts = {
        prepack: 'node -e "throw new Error(\'lifecycle must not run\')"',
        postpack: 'node -e "throw new Error(\'lifecycle must not run\')"',
      };
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'wrong-source-package',
          version: '1.0.0',
          scripts,
        })
      );
      writeFileSync(
        join(directory, 'dist', 'package.json'),
        JSON.stringify({
          name: 'isolated-dist-fixture',
          version: '1.0.1',
          main: 'cjs/index.js',
          scripts,
        })
      );
      writeFileSync(
        join(directory, 'dist', 'cjs', 'index.js'),
        'module.exports = {};'
      );
      const result = spawnSync(command, args, {
        cwd: directory,
        encoding: 'utf8',
        timeout: 20000,
        // No inherited npm auth environment or user/global credential files.
        env: {
          PATH: process.env.PATH,
          NPM_CONFIG_CACHE: join(directory, 'cache'),
          NPM_CONFIG_USERCONFIG: join(directory, 'empty-user-config'),
          NPM_CONFIG_GLOBALCONFIG: join(directory, 'empty-global-config'),
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const [packed] = JSON.parse(result.stdout);
      expect(packed).toMatchObject({
        name: 'isolated-dist-fixture',
        version: '1.0.1',
      });
      expect(
        packed.files.map((file: { path: string }) => file.path).sort()
      ).toEqual(['cjs/index.js', 'package.json']);
      expect(readdirSync(directory).some((file) => file.endsWith('.tgz'))).toBe(
        false
      );
      expect(
        readdirSync(join(directory, 'dist')).some((file) =>
          file.endsWith('.tgz')
        )
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function fixture() {
  const provider = {
    getTransaction: jest.fn().mockResolvedValue(cancellationOriginal()),
    getGasPrice: jest.fn().mockResolvedValue(BigNumber.from(7)),
    getBlock: jest.fn().mockResolvedValue({ baseFeePerGas: BigNumber.from(5) }),
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice: BigNumber.from(7),
      maxFeePerGas: BigNumber.from(12),
      maxPriorityFeePerGas: BigNumber.from(0),
    }),
    send: jest.fn().mockResolvedValue('0x0'),
    estimateGas: jest.fn().mockResolvedValue(BigNumber.from(21000)),
    sendTransaction: jest.fn(),
  };
  // This getter and the local sender are mocks, never a library wallet/key.
  const getKey = jest.fn(() => ({
    address: FROM,
    decryptedPrivateKey: 'unit-test-placeholder',
  }));
  const sdk = new EthereumTransactions(
    () => network,
    getKey,
    () =>
      ({
        activeNetwork: network,
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        accounts: {
          [KeyringAccountType.HDAccount]: { 0: { address: FROM } },
          Imported: {},
          Ledger: {},
          Trezor: {},
        },
      } as any),
    {} as any,
    {} as any
  );
  Object.defineProperty(sdk, 'web3Provider', { get: () => provider });
  return { sdk, provider, getKey };
}

beforeEach(() => {
  jest.clearAllMocks();
  localSend.mockImplementation(
    async (_provider, _key, _tx, beforeBroadcast) => {
      beforeBroadcast?.();
      return { hash: HASH };
    }
  );
});

describe('actual RPC fee data without a fabricated tip or model switch', () => {
  it.each([0, '0x0', '0', BigNumber.from(0)])(
    'retains a valid zero priority fee %p and the actual gas price separately',
    async (zero) => {
      const { sdk, provider } = fixture();
      provider.send.mockResolvedValue(zero);
      const fee: any = await sdk.getFeeDataWithDynamicMaxPriorityFeePerGas();
      expect(fee.maxPriorityFeePerGas.toString()).toBe('0');
      expect(fee.maxFeePerGas.toString()).toBe('12');
      expect(fee.gasPrice.toString()).toBe('7');
      expect(fee.baseFeePerGas.toString()).toBe('5');
      expect(provider.send).toHaveBeenCalledTimes(1);
      expect(provider.send).toHaveBeenCalledWith(
        'eth_maxPriorityFeePerGas',
        []
      );
    }
  );

  it('preserves a positive tip and existing maximum-fee calculation', async () => {
    const { sdk, provider } = fixture();
    provider.send.mockResolvedValue('0x2');
    const fee: any = await sdk.getFeeDataWithDynamicMaxPriorityFeePerGas();
    expect(fee.maxPriorityFeePerGas.toString()).toBe('2');
    expect(fee.maxFeePerGas.toString()).toBe('14');
    expect(fee.gasPrice.toString()).toBe('7');
  });

  it('classifies a zero base fee as EIP-1559 rather than legacy', async () => {
    const { sdk, provider } = fixture();
    provider.getBlock.mockResolvedValue({ baseFeePerGas: BigNumber.from(0) });
    const fee: any = await sdk.getFeeDataWithDynamicMaxPriorityFeePerGas();
    expect(fee.baseFeePerGas.toString()).toBe('0');
    expect(fee.maxPriorityFeePerGas.toString()).toBe('0');
    expect(fee.maxFeePerGas.gt(0)).toBe(true);
  });

  it('uses the legacy sentinel only for an actual header without a base fee', async () => {
    const { sdk, provider } = fixture();
    provider.getBlock.mockResolvedValue({} as any);
    const fee: any = await sdk.getFeeDataWithDynamicMaxPriorityFeePerGas();
    expect(fee.maxFeePerGas.toString()).toBe('0');
    expect(fee.maxPriorityFeePerGas.toString()).toBe('0');
    expect(fee.gasPrice.toString()).toBe('7');
    expect(fee.baseFeePerGas).toBeUndefined();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('preserves an explicitly configured priority floor, rather than inventing one', async () => {
    const { sdk } = fixture();
    sdk.setGasOverrides({ minPriorityFee: '2' });
    const fee = await sdk.getFeeDataWithDynamicMaxPriorityFeePerGas();
    expect(fee.maxPriorityFeePerGas.toString()).toBe('2');
  });

  it.each([null, undefined, 'corrupt', -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unavailable or corrupt baseline fee data %p',
    async (gasPrice) => {
      const { sdk, provider } = fixture();
      provider.getGasPrice.mockResolvedValue(gasPrice as any);
      await expect(
        sdk.getFeeDataWithDynamicMaxPriorityFeePerGas()
      ).rejects.toThrow();
      expect(provider.send).not.toHaveBeenCalled();
    }
  );

  it.each([null, undefined])(
    'does not mistake an absent block %p for legacy support',
    async (block) => {
      const { sdk, provider } = fixture();
      provider.getBlock.mockResolvedValue(block as any);
      await expect(
        sdk.getFeeDataWithDynamicMaxPriorityFeePerGas()
      ).rejects.toThrow('Block not found');
      expect(provider.send).not.toHaveBeenCalled();
    }
  );

  it('preserves the explicit force-legacy fee recommendation', async () => {
    const { sdk, provider } = fixture();
    provider.getGasPrice.mockResolvedValue(BigNumber.from(100));
    const safe = await sdk.getSafeFeeData(true);
    expect(safe.gasPrice.toString()).toBe('110');
    expect(safe.maxFeePerGas).toBeUndefined();
    expect(provider.getBlock).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('permits zero observed fee-history rewards when the priority RPC is explicitly unsupported', async () => {
    const { sdk, provider } = fixture();
    provider.send.mockRejectedValueOnce(
      Object.assign(new Error('unsupported method'), { code: -32601 })
    );
    provider.send.mockResolvedValueOnce({
      reward: [
        ['0x0', '0x0', '0x0'],
        ['0x1', '0x0', '0x2'],
      ],
    });
    const fee = await sdk.getFeeDataWithDynamicMaxPriorityFeePerGas();
    expect(fee.maxPriorityFeePerGas.toString()).toBe('0');
    expect(fee.maxFeePerGas.toString()).toBe('12');
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it.each(['gas', 'block', 'priority'])(
    'does not turn a failed %s RPC into zeros, a minimum tip or legacy pricing',
    async (stage) => {
      const { sdk, provider } = fixture();
      const error = new Error('RPC unavailable');
      if (stage === 'gas') provider.getGasPrice.mockRejectedValue(error);
      if (stage === 'block') provider.getBlock.mockRejectedValue(error);
      if (stage === 'priority') provider.send.mockRejectedValue(error);
      await expect(
        sdk.getFeeDataWithDynamicMaxPriorityFeePerGas()
      ).rejects.toBe(error);
      expect(
        provider.send.mock.calls.some(([method]) => method === 'eth_feeHistory')
      ).toBe(false);
    }
  );

  it.each([null, 'corrupt', '-1', BigNumber.from(-1)])(
    'rejects malformed or negative priority data %p without guessing',
    async (priority) => {
      const { sdk, provider } = fixture();
      provider.send.mockResolvedValue(priority);
      await expect(
        sdk.getFeeDataWithDynamicMaxPriorityFeePerGas()
      ).rejects.toThrow();
    }
  );

  it.each([
    null,
    {},
    { reward: [] },
    { reward: [['0x0']] },
    { reward: [['0x0', '-1', '0x0']] },
  ])(
    'rejects unavailable or malformed history %p without a hardcoded tip',
    async (history) => {
      const { sdk, provider } = fixture();
      provider.send.mockRejectedValueOnce(
        Object.assign(new Error('unsupported method'), { code: -32601 })
      );
      provider.send.mockResolvedValueOnce(history);
      await expect(
        sdk.getFeeDataWithDynamicMaxPriorityFeePerGas()
      ).rejects.toThrow();
    }
  );

  it('getSafeFeeData retains a valid zero-tip EIP-1559 quote', async () => {
    const { sdk, provider } = fixture();
    const safe = await sdk.getSafeFeeData();
    expect(safe.maxFeePerGas.toString()).toBe('12');
    expect(safe.maxPriorityFeePerGas.toString()).toBe('0');
    expect(provider.getGasPrice).toHaveBeenCalledTimes(1);
  });

  it('getSafeFeeData preserves discovery failures rather than rereading a different legacy price', async () => {
    const { sdk, provider } = fixture();
    const error = new Error('RPC unavailable');
    jest
      .spyOn(sdk, 'getFeeDataWithDynamicMaxPriorityFeePerGas')
      .mockRejectedValue(error);
    await expect(sdk.getSafeFeeData()).rejects.toBe(error);
    expect(provider.getGasPrice).not.toHaveBeenCalled();
  });
});

describe('formatted standard transaction fee-model retention', () => {
  it.each([
    [{ hex: '0x64' }, { hex: '0x0' }],
    [{ _hex: '0x64' }, { _hex: '0x0' }],
    [{ toString: () => '100' }, { toString: () => '0' }],
    [
      { type: 'BigNumber', hex: '0x64' },
      { type: 'BigNumber', hex: '0x2' },
    ],
  ])(
    'accepts the exported object-form BigNumberish fee contract: %p / %p',
    async (maximum, priority) => {
      const { sdk, provider } = fixture();
      await expect(
        sdk.sendFormattedTransaction(
          {
            ...transaction,
            type: 2,
            maxFeePerGas: maximum,
            maxPriorityFeePerGas: priority,
          } as any,
          false
        )
      ).resolves.toMatchObject({ hash: HASH });
      const sent = localSend.mock.calls[0][2];
      expect(BigNumber.from(sent.maxFeePerGas).toString()).toBe('100');
      expect(BigNumber.from(sent.maxPriorityFeePerGas).toString()).toBe(
        BigNumber.from(priority).toString()
      );
      expect(normalizeTransactionRequest(sent).maxFeePerGas).toBe(100n);
      expect(normalizeTransactionRequest(sent).maxPriorityFeePerGas).toBe(
        BigInt(BigNumber.from(priority).toString())
      );
      expect(provider.getFeeData).not.toHaveBeenCalled();
      expect(provider.getGasPrice).not.toHaveBeenCalled();
    }
  );

  it.each([
    { hex: '-0x1' },
    { _hex: '-1' },
    { hex: '' },
    { _hex: 'broken' },
    { hex: 100 },
    { toString: () => '-1' },
    { toString: () => '' },
    {},
    { _isBigNumber: true },
    { _hex: 'broken', hex: '0x64' },
  ])(
    'rejects negative or malformed object-form fees before key access: %p',
    async (maximum) => {
      const { sdk, getKey } = fixture();
      await expect(
        sdk.sendFormattedTransaction(
          {
            ...transaction,
            type: 2,
            maxFeePerGas: maximum,
            maxPriorityFeePerGas: { hex: '0x0' },
          } as any,
          false
        )
      ).rejects.toMatchObject({ transactionNotBroadcast: true });
      expect(getKey).not.toHaveBeenCalled();
      expect(localSend).not.toHaveBeenCalled();
    }
  );

  it('does not silently convert an explicit type-2 request through a legacy flag', async () => {
    const { sdk, getKey } = fixture();
    await expect(
      sdk.sendFormattedTransaction(
        {
          ...transaction,
          type: 2,
          maxFeePerGas: '100',
          maxPriorityFeePerGas: '0',
        } as any,
        true
      )
    ).rejects.toMatchObject({ transactionNotBroadcast: true });
    expect(getKey).not.toHaveBeenCalled();
    expect(localSend).not.toHaveBeenCalled();
  });
  it.each([0, '0x0', '0', BigNumber.from(0)])(
    'does not downgrade an explicit type-2 zero tip %p or fetch another price',
    async (zero) => {
      const { sdk, provider } = fixture();
      await expect(
        sdk.sendFormattedTransaction(
          {
            ...transaction,
            type: 2,
            maxFeePerGas: '100',
            maxPriorityFeePerGas: zero,
          } as any,
          false
        )
      ).resolves.toMatchObject({ hash: HASH });
      const sent = localSend.mock.calls[0][2];
      expect(sent.type).toBe(2);
      expect(BigNumber.from(sent.maxPriorityFeePerGas).isZero()).toBe(true);
      expect(BigNumber.from(sent.maxFeePerGas).toString()).toBe('100');
      expect(provider.getGasPrice).not.toHaveBeenCalled();
      expect(provider.getFeeData).not.toHaveBeenCalled();
    }
  );

  it.each([
    { maxFeePerGas: '0', maxPriorityFeePerGas: '0' },
    { maxFeePerGas: '-1', maxPriorityFeePerGas: '0' },
    { maxFeePerGas: '100', maxPriorityFeePerGas: '-1' },
    { maxFeePerGas: '100', maxPriorityFeePerGas: '101' },
  ])(
    'rejects invalid explicit EIP fees before key access or any signer/send: %p',
    async (fields) => {
      const { sdk, getKey } = fixture();
      await expect(
        sdk.sendFormattedTransaction(
          { ...transaction, type: 2, ...fields } as any,
          false
        )
      ).rejects.toMatchObject({ transactionNotBroadcast: true });
      expect(getKey).not.toHaveBeenCalled();
      expect(localSend).not.toHaveBeenCalled();
    }
  );

  it('refuses unavailable explicit EIP fees instead of silently falling back to legacy', async () => {
    const { sdk, provider, getKey } = fixture();
    provider.getFeeData.mockResolvedValue({
      gasPrice: BigNumber.from(7),
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    } as any);
    await expect(
      sdk.sendFormattedTransaction({ ...transaction, type: 2 } as any, false)
    ).rejects.toMatchObject({ transactionNotBroadcast: true });
    expect(getKey).not.toHaveBeenCalled();
    expect(localSend).not.toHaveBeenCalled();
    expect(provider.getGasPrice).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'retains complete ordinary legacy=%s pricing',
    async (legacy) => {
      const { sdk, provider } = fixture();
      const fields = legacy
        ? { gasPrice: '7' }
        : { maxFeePerGas: '100', maxPriorityFeePerGas: '2' };
      await sdk.sendFormattedTransaction(
        { ...transaction, ...fields } as any,
        legacy
      );
      const sent = localSend.mock.calls[0][2];
      if (legacy) expect(BigNumber.from(sent.gasPrice).toString()).toBe('7');
      else
        expect(BigNumber.from(sent.maxPriorityFeePerGas).toString()).toBe('2');
      expect(provider.getGasPrice).not.toHaveBeenCalled();
      expect(provider.getFeeData).not.toHaveBeenCalled();
    }
  );
});

describe('cancellation recommendations keep base fee separate from replacement tip', () => {
  const cancelFields = () => localSend.mock.calls[0][2];
  const contextFor = (sdk: EthereumTransactions, provider: unknown) => ({
    approvedMaximumFee: '9'.repeat(78),
    validateOriginal: () => undefined,
    assertCurrentContext: () => {
      if (sdk.web3Provider !== provider)
        throw new Error('Fixture provider changed');
    },
  });

  it('bumps a zero-tip original by one wei, never by the full gas-price recommendation', async () => {
    const { sdk, provider } = fixture();
    await expect(
      sdk.cancelSentTransaction(
        HASH,
        false,
        undefined,
        contextFor(sdk, provider)
      )
    ).resolves.toMatchObject({ isCanceled: true });
    expect(cancelFields().maxFeePerGas.toString()).toBe('120');
    expect(cancelFields().maxPriorityFeePerGas.toString()).toBe('1');
    expect(cancelFields()).toMatchObject({ from: FROM, to: FROM, nonce: 0 });
    expect(provider.getGasPrice).toHaveBeenCalledTimes(1);
  });

  it.each([
    [10, '0x2', '12'],
    [10, '0xc', '14'],
    [1, '0x0', '2'],
  ])(
    'retains the real positive replacement tip bump: original %s / recommendation %s',
    async (oldTip, recommendation, expected) => {
      const { sdk, provider } = fixture();
      provider.getTransaction.mockResolvedValue(
        cancellationOriginal({
          maxPriorityFeePerGas: BigNumber.from(oldTip),
        })
      );
      provider.send.mockResolvedValue(recommendation);
      await sdk.cancelSentTransaction(
        HASH,
        false,
        undefined,
        contextFor(sdk, provider)
      );
      expect(cancelFields().maxPriorityFeePerGas.toString()).toBe(expected);
      expect(cancelFields().maxFeePerGas.toString()).toBe('120');
    }
  );

  it('keeps exact integer replacement arithmetic above the safe-number range', async () => {
    const { sdk, provider } = fixture();
    const oldMaximum = (1n << 60n) + 3n;
    provider.getTransaction.mockResolvedValue(
      cancellationOriginal({
        maxFeePerGas: BigNumber.from(oldMaximum),
      })
    );
    await sdk.cancelSentTransaction(
      HASH,
      false,
      undefined,
      contextFor(sdk, provider)
    );
    expect(cancelFields().maxFeePerGas.toString()).toBe(
      ((oldMaximum * 120n) / 100n).toString()
    );
    expect(cancelFields().maxPriorityFeePerGas.toString()).toBe('1');
  });

  it('uses actual zero-tip fees for a missing-original nonce cancellation without inventing a network tip', async () => {
    const { sdk, provider } = fixture();
    provider.getTransaction.mockResolvedValue(null as any);
    await expect(
      sdk.cancelSentTransaction(HASH, false, 9, contextFor(sdk, provider))
    ).resolves.toMatchObject({ isCanceled: true });
    expect(cancelFields().nonce).toBe(9);
    expect(cancelFields().maxPriorityFeePerGas.toString()).toBe('1');
    expect(cancelFields().maxFeePerGas.toString()).toBe('14');
  });

  it('does not request fees or sign when the original and fallback nonce are both absent', async () => {
    const { sdk, provider, getKey } = fixture();
    provider.getTransaction.mockResolvedValue(null as any);
    await expect(
      sdk.cancelSentTransaction(
        HASH,
        false,
        undefined,
        contextFor(sdk, provider)
      )
    ).resolves.toEqual({
      isCanceled: false,
      error: true,
    });
    expect(provider.getGasPrice).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
    expect(localSend).not.toHaveBeenCalled();
  });

  it.each(['gas', 'block', 'priority'])(
    'refuses unavailable %s data before cancellation key access',
    async (stage) => {
      const { sdk, provider, getKey } = fixture();
      const error = new Error('Cancellation fee RPC unavailable');
      if (stage === 'gas') provider.getGasPrice.mockRejectedValue(error);
      if (stage === 'block') provider.getBlock.mockRejectedValue(error);
      if (stage === 'priority') provider.send.mockRejectedValue(error);
      await expect(
        sdk.cancelSentTransaction(
          HASH,
          false,
          undefined,
          contextFor(sdk, provider)
        )
      ).rejects.toBe(error);
      expect(getKey).not.toHaveBeenCalled();
      expect(localSend).not.toHaveBeenCalled();
    }
  );

  it.each([
    { maxFeePerGas: null },
    { maxFeePerGas: undefined },
    { maxFeePerGas: 'broken' },
    { maxFeePerGas: BigNumber.from(0) },
    { maxFeePerGas: BigNumber.from(-1) },
    { maxPriorityFeePerGas: null },
    { maxPriorityFeePerGas: undefined },
    { maxPriorityFeePerGas: 'broken' },
    { maxPriorityFeePerGas: BigNumber.from(-1) },
    {
      maxFeePerGas: BigNumber.from(1),
      maxPriorityFeePerGas: BigNumber.from(2),
    },
  ])(
    'rejects missing or corrupt current EIP recommendations without a zero/default substitution: %p',
    async (fields) => {
      const { sdk, provider, getKey } = fixture();
      jest
        .spyOn(sdk, 'getFeeDataWithDynamicMaxPriorityFeePerGas')
        .mockResolvedValue({
          gasPrice: BigNumber.from(7),
          maxFeePerGas: BigNumber.from(12),
          maxPriorityFeePerGas: BigNumber.from(0),
          ...fields,
        } as any);
      await expect(
        sdk.cancelSentTransaction(
          HASH,
          false,
          undefined,
          contextFor(sdk, provider)
        )
      ).rejects.toThrow();
      expect(getKey).not.toHaveBeenCalled();
      expect(localSend).not.toHaveBeenCalled();
    }
  );

  it('preserves a normal positive legacy cancellation price and self-transfer nonce', async () => {
    const { sdk, provider } = fixture();
    provider.getGasPrice.mockResolvedValue(BigNumber.from(10));
    await sdk.cancelSentTransaction(
      HASH,
      true,
      undefined,
      contextFor(sdk, provider)
    );
    expect(cancelFields().gasPrice.toString()).toBe('12');
    expect(cancelFields()).toMatchObject({
      type: 0,
      from: FROM,
      to: FROM,
      nonce: 0,
    });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'broken', BigNumber.from(-1)])(
    'rejects corrupt legacy cancellation prices %p before signing',
    async (price) => {
      const { sdk, provider, getKey } = fixture();
      provider.getGasPrice.mockResolvedValue(price as any);
      await expect(
        sdk.cancelSentTransaction(
          HASH,
          true,
          undefined,
          contextFor(sdk, provider)
        )
      ).rejects.toThrow();
      expect(getKey).not.toHaveBeenCalled();
      expect(localSend).not.toHaveBeenCalled();
    }
  );
});

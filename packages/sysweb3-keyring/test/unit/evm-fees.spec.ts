import {
  getEvmFeeData,
  parseEvmFeeQuantity,
  EvmFeeReader,
} from '../../src/evm-fees';

const fixture = () => ({
  getGasPrice: jest.fn().mockResolvedValue('0x7'),
  getBlock: jest.fn().mockResolvedValue({ baseFeePerGas: '0x5' }),
  send: jest.fn().mockResolvedValue('0x0'),
});

describe('restricted shared EVM fee discovery', () => {
  it('preserves type-2 zero tips, exact math and a frozen bigint DTO', async () => {
    const reader = fixture();
    const fee = await getEvmFeeData(reader);
    expect(fee).toEqual({
      gasPrice: 7n,
      baseFeePerGas: 5n,
      maxFeePerGas: 12n,
      maxPriorityFeePerGas: 0n,
    });
    expect(Object.isFrozen(fee)).toBe(true);
    expect(reader.send.mock.calls).toEqual([['eth_maxPriorityFeePerGas', []]]);
  });

  it('returns legacy only for an actual block without a base fee', async () => {
    const reader = fixture();
    reader.getBlock.mockResolvedValue({});
    expect(await getEvmFeeData(reader)).toEqual({
      gasPrice: 7n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    });
    expect(reader.send).not.toHaveBeenCalled();
  });

  it('uses the actual median history reward only for unsupported priority RPC', async () => {
    const reader = fixture();
    reader.send.mockRejectedValueOnce(
      Object.assign(new Error('unsupported'), { code: -32601 })
    );
    reader.send.mockResolvedValueOnce({
      reward: [
        ['0x0', '0xa', '0x14'],
        ['0x0', '0x2', '0x4'],
        ['0x0', '0x4', '0x8'],
      ],
    });
    expect(await getEvmFeeData(reader)).toEqual({
      gasPrice: 7n,
      baseFeePerGas: 5n,
      maxFeePerGas: 18n,
      maxPriorityFeePerGas: 6n,
    });
    expect(reader.send.mock.calls[1]).toEqual([
      'eth_feeHistory',
      ['0x5', 'latest', [25, 50, 75]],
    ]);
  });

  it.each([
    { code: -32000 },
    { code: 'SYSWEB3_RPC_RESPONSE_INVALID' },
    { code: 'UNSUPPORTED_OPERATION' },
    {
      code: 'UNKNOWN_ERROR',
      error: { code: -32601 },
      payload: { method: 'eth_getBalance', params: [] },
    },
    { name: 'AbortError', code: -32601 },
  ])(
    'never converts another failure to history or legacy: %p',
    async (fields) => {
      const reader = fixture();
      const error = Object.assign(new Error('failed'), fields);
      reader.send.mockRejectedValue(error);
      await expect(getEvmFeeData(reader)).rejects.toBe(error);
      expect(reader.send).toHaveBeenCalledTimes(1);
    }
  );

  it('takes an immutable snapshot of the supplied override values', async () => {
    const reader = fixture();
    const options = { minPriorityFee: '3', feeMultiplier: 300 };
    reader.getGasPrice.mockImplementation(async () => {
      options.minPriorityFee = '99';
      options.feeMultiplier = 999;
      return '0x7';
    });
    expect(await getEvmFeeData(reader, options)).toEqual({
      gasPrice: 7n,
      baseFeePerGas: 5n,
      maxFeePerGas: 18n,
      maxPriorityFeePerGas: 3n,
    });
  });

  it('rejects changed ownership after a read before issuing the next read', async () => {
    const reader = fixture();
    let current = true;
    reader.getGasPrice.mockImplementation(async () => {
      current = false;
      return '0x7';
    });
    await expect(
      getEvmFeeData(reader, {
        assertCurrent: () => {
          if (!current) throw new Error('changed owner');
        },
      })
    ).rejects.toThrow('changed owner');
    expect(reader.getBlock).not.toHaveBeenCalled();
    expect(reader.send).not.toHaveBeenCalled();
  });

  it('rejects an asynchronous guard before any provider read', async () => {
    const reader = fixture();
    await expect(
      getEvmFeeData(reader, { assertCurrent: async () => undefined })
    ).rejects.toThrow('must be synchronous');
    expect(reader.getGasPrice).not.toHaveBeenCalled();
  });

  it.each(['option', 'reader'])(
    'promptly rejects pending %s cancellation without issuing another read',
    async (where) => {
      const reader = fixture();
      const controller = new AbortController();
      let finish!: (value: unknown) => void;
      reader.getGasPrice.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      const pending = getEvmFeeData(
        where === 'reader' ? { ...reader, signal: controller.signal } : reader,
        where === 'option' ? { signal: controller.signal } : {}
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      finish('0x7');
      await Promise.resolve();
      expect(reader.getBlock).not.toHaveBeenCalled();
      expect(reader.send).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    undefined,
    '0x',
    '-1',
    '1'.repeat(81),
    2n ** 256n,
    NaN,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    { _hex: '' },
  ])('rejects invalid or excessive quantities: %p', (value) => {
    expect(() => parseEvmFeeQuantity(value)).toThrow('Invalid');
  });

  it.each([
    { reward: Array.from({ length: 6 }, () => ['0x0', '0x1', '0x2']) },
    { reward: [['bad', '0x1', '0x2']] },
    { reward: [['0x0', '0x1', 'bad']] },
  ])(
    'bounds and validates the complete returned history: %p',
    async (history) => {
      const reader = fixture();
      reader.send.mockRejectedValueOnce(
        Object.assign(new Error('unsupported'), { code: -32601 })
      );
      reader.send.mockResolvedValueOnce(history);
      await expect(getEvmFeeData(reader)).rejects.toThrow();
    }
  );

  it('rejects overflow instead of returning a fee above uint256', async () => {
    const reader = fixture();
    reader.getBlock.mockResolvedValue({ baseFeePerGas: 2n ** 256n - 1n });
    await expect(getEvmFeeData(reader)).rejects.toThrow('Invalid maximum fee');
  });

  it('admits the existing SDK BigNumberish forms without imports', () => {
    for (const value of [
      1n,
      1,
      '1',
      '0x1',
      { _hex: '0x1' },
      { hex: '0x1' },
      { toString: () => '1' },
    ])
      expect(parseEvmFeeQuantity(value)).toBe(1n);
  });

  it('rechecks ownership before returning a legacy result', async () => {
    const reader = fixture();
    let current = true;
    reader.getBlock.mockResolvedValue(
      Object.defineProperty({}, 'baseFeePerGas', {
        get() {
          current = false;
          return null;
        },
      })
    );
    await expect(
      getEvmFeeData(reader, {
        assertCurrent: () => {
          if (!current) throw new Error('changed owner');
        },
      })
    ).rejects.toThrow('changed owner');
  });

  it('does not dispatch when the ownership guard aborts the signal', async () => {
    const reader = fixture();
    const controller = new AbortController();
    await expect(
      getEvmFeeData(reader, {
        signal: controller.signal,
        assertCurrent: () => {
          controller.abort();
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reader.getGasPrice).not.toHaveBeenCalled();
  });

  it('does not need a complete provider or signing capability', async () => {
    const reader: EvmFeeReader = fixture();
    await expect(getEvmFeeData(reader)).resolves.toMatchObject({
      maxFeePerGas: 12n,
    });
  });
});

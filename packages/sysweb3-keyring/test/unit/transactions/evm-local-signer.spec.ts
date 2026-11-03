import { recoverPersonalSignature } from '@metamask/eth-sig-util';
import { Transaction } from 'ethers';

import { BigNumber, serializeTransaction } from '../../../src/ethers-v6';
import {
  deriveEvmAccountFromMnemonic,
  hashPersonalMessage,
  parsePersonalMessage,
  privateKeyToAccount,
  sendLocalEvmTransaction,
  signDigestHex,
  signPersonalMessage,
  signTransaction,
} from '../../../src/transactions/evm-local-signer';

const PRIVATE_KEY =
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ADDRESS = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c';
const PERSONAL_MESSAGE =
  '0x4578616d706c652060706572736f6e616c5f7369676e60206d657373616765';
const PERSONAL_SIGNATURE =
  '0x51da3570312f459585790825e3ba282376271e18a77845cb01a4adea9cf7d0f0496866d454d74361b4ca286623f0fb91fd9fa3519c79f343215e736bcac50f061b';
const DIGEST =
  '0x00000000000000000000000000000000000000000048656c6c6f20576f726c64';
const DIGEST_SIGNATURE =
  '0x1562194d8ae416bc5da2a06d7853fe26ce3c0ac0ead654505e6fca52c079cf2e063a90d5b6e8fdc8d9fc108aef36c203736c65fef90b54b9284ece28b90b2e141c';

describe('EVM local signer', () => {
  it('derives the expected checksummed address and public key from a private key', () => {
    const account = privateKeyToAccount(PRIVATE_KEY);

    expect(account.address).toBe(ADDRESS);
    expect(account.privateKey).toBe(PRIVATE_KEY);
    expect(account.publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
  });

  it('derives the expected first EVM account from a mnemonic and path', () => {
    const account = deriveEvmAccountFromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      "m/44'/60'/0'/0/0"
    );

    expect(account.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(account.privateKey).toBe(
      '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727'
    );
  });

  it('rejects invalid mnemonic phrases before deriving EVM accounts', () => {
    expect(() =>
      deriveEvmAccountFromMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
        "m/44'/60'/0'/0/0"
      )
    ).toThrow('Invalid EVM mnemonic');
  });

  it('rejects invalid private keys before signing or deriving', () => {
    expect(() => privateKeyToAccount('0x' + '00'.repeat(32))).toThrow(
      'Invalid EVM private key'
    );
    expect(() => privateKeyToAccount('0x1234')).toThrow(
      'Invalid EVM private key'
    );
    expect(() => privateKeyToAccount(PRIVATE_KEY + 'f')).toThrow(
      'Invalid EVM private key'
    );
    expect(() => privateKeyToAccount(PRIVATE_KEY + 'zz')).toThrow(
      'Invalid EVM private key'
    );
  });

  it('signs a raw 32-byte eth_sign digest deterministically', () => {
    expect(signDigestHex(DIGEST, PRIVATE_KEY)).toBe(DIGEST_SIGNATURE);
  });

  it('rejects non-32-byte digests', () => {
    expect(() => signDigestHex('0x1234', PRIVATE_KEY)).toThrow(
      'EVM signatures require a 32-byte digest'
    );
  });

  it('rejects local transaction signing when from does not match the private key', async () => {
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      getTransactionCount: jest.fn(),
      estimateGas: jest.fn(),
      getGasPrice: jest.fn(),
      sendTransaction: jest.fn(),
    } as any;

    await expect(
      sendLocalEvmTransaction(provider, PRIVATE_KEY, {
        from: '0x0000000000000000000000000000000000000001',
        to: ADDRESS,
        value: '0x0',
        gasLimit: '0x5208',
        gasPrice: '0x01',
        nonce: 0,
        chainId: 1,
        type: 0,
        data: '0x',
      })
    ).rejects.toThrow('Transaction from does not match EVM private key');
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('populates EIP-1559 fees before signing local transactions', async () => {
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      resolveName: jest.fn(),
      getTransactionCount: jest.fn().mockResolvedValue(7),
      estimateGas: jest.fn().mockResolvedValue(BigNumber.from(21000)),
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: BigNumber.from(100),
        maxFeePerGas: BigNumber.from(300),
        maxPriorityFeePerGas: BigNumber.from(20),
      }),
      getGasPrice: jest.fn(),
      sendTransaction: jest
        .fn()
        .mockImplementation(async (signedTx: string) => {
          const decoded = Transaction.from(signedTx);
          expect(decoded.type).toBe(2);
          expect(decoded.maxFeePerGas).toBe(300n);
          expect(decoded.maxPriorityFeePerGas).toBe(20n);
          return {
            hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
          };
        }),
    } as any;

    await sendLocalEvmTransaction(provider, PRIVATE_KEY, {
      to: ADDRESS,
      value: '0x0',
      data: '0x',
    });

    expect(provider.getFeeData).toHaveBeenCalledTimes(1);
    expect(provider.getGasPrice).not.toHaveBeenCalled();
    expect(provider.verifyConfiguredChainId).toHaveBeenCalledTimes(1);
    expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('resolves named recipients before signing local transactions', async () => {
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      resolveName: jest.fn().mockResolvedValue(ADDRESS),
      getTransactionCount: jest.fn().mockResolvedValue(7),
      estimateGas: jest.fn().mockResolvedValue(BigNumber.from(21000)),
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: BigNumber.from(100),
        maxFeePerGas: BigNumber.from(300),
        maxPriorityFeePerGas: BigNumber.from(20),
      }),
      getGasPrice: jest.fn(),
      sendTransaction: jest
        .fn()
        .mockImplementation(async (signedTx: string) => {
          const decoded = Transaction.from(signedTx);
          expect(decoded.to).toBe(ADDRESS);
          return {
            hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
          };
        }),
    } as any;

    await sendLocalEvmTransaction(provider, PRIVATE_KEY, {
      to: 'alice.eth',
      value: '0x0',
      data: '0x',
    });

    expect(provider.resolveName).toHaveBeenCalledWith('alice.eth');
    expect(provider.verifyConfiguredChainId).toHaveBeenCalledTimes(1);
    expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects local transactions with unresolved named recipients', async () => {
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      resolveName: jest.fn().mockResolvedValue(null),
      getTransactionCount: jest.fn(),
      estimateGas: jest.fn(),
      getFeeData: jest.fn(),
      getGasPrice: jest.fn(),
      sendTransaction: jest.fn(),
    } as any;

    await expect(
      sendLocalEvmTransaction(provider, PRIVATE_KEY, {
        to: 'missing.eth',
        value: '0x0',
        data: '0x',
      })
    ).rejects.toThrow('Unable to resolve EVM transaction recipient');

    expect(provider.resolveName).toHaveBeenCalledWith('missing.eth');
    expect(provider.verifyConfiguredChainId).toHaveBeenCalledTimes(1);
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('populates gasPrice for explicit EIP-2930 local transactions', async () => {
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      getTransactionCount: jest.fn().mockResolvedValue(7),
      estimateGas: jest.fn().mockResolvedValue(BigNumber.from(21000)),
      getFeeData: jest.fn(),
      getGasPrice: jest.fn().mockResolvedValue(BigNumber.from(100)),
      sendTransaction: jest
        .fn()
        .mockImplementation(async (signedTx: string) => {
          const decoded = Transaction.from(signedTx);
          expect(decoded.type).toBe(1);
          expect(decoded.gasPrice).toBe(100n);
          expect(decoded.maxFeePerGas).toBe(null);
          expect(decoded.maxPriorityFeePerGas).toBe(null);
          return {
            hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
          };
        }),
    } as any;

    await sendLocalEvmTransaction(provider, PRIVATE_KEY, {
      type: '0x1',
      to: ADDRESS,
      value: '0x0',
      data: '0x',
      accessList: [],
    });

    expect(provider.getGasPrice).toHaveBeenCalledTimes(1);
    expect(provider.getFeeData).not.toHaveBeenCalled();
    expect(provider.verifyConfiguredChainId).toHaveBeenCalledTimes(1);
    expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('validates the fully populated transaction after the context guard and before signing', async () => {
    const order: string[] = [];
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      resolveName: jest.fn().mockResolvedValue(ADDRESS),
      getTransactionCount: jest.fn().mockResolvedValue(7),
      estimateGas: jest.fn().mockResolvedValue(BigNumber.from(21000)),
      getFeeData: jest.fn().mockResolvedValue({
        maxFeePerGas: BigNumber.from(300),
        maxPriorityFeePerGas: BigNumber.from(20),
      }),
      sendTransaction: jest.fn(async (signed: string) => {
        order.push('broadcast');
        const transaction = Transaction.from(signed);
        expect(transaction).toMatchObject({
          to: ADDRESS,
          chainId: 1n,
          nonce: 7,
          gasLimit: 21000n,
          type: 2,
          maxFeePerGas: 300n,
          maxPriorityFeePerGas: 20n,
          value: 0n,
          data: '0x',
        });
        return { hash: '0x' + '12'.repeat(32) };
      }),
    } as any;
    const beforeSign = jest.fn(() => {
      order.push('context');
    });
    const beforeBroadcast = jest.fn(() => {
      order.push('beforeBroadcast');
    });
    const validate = jest.fn((transaction) => {
      order.push('validate');
      expect(provider.resolveName).toHaveBeenCalledWith('alice.eth');
      expect(provider.getTransactionCount).toHaveBeenCalledWith(
        ADDRESS,
        'pending'
      );
      expect(provider.estimateGas).toHaveBeenCalledTimes(1);
      expect(provider.getFeeData).toHaveBeenCalledTimes(1);
      expect(transaction).toMatchObject({
        to: ADDRESS,
        chainId: 1,
        nonce: 7,
        type: 2,
        value: '0x0',
        data: '0x',
      });
      expect(transaction.gasLimit.toString()).toBe('21000');
      expect(transaction.maxFeePerGas.toString()).toBe('300');
      expect(transaction.maxPriorityFeePerGas.toString()).toBe('20');
      expect(transaction).not.toHaveProperty('from');
      expect(transaction).not.toHaveProperty('ccipReadEnabled');
      expect(transaction).not.toHaveProperty('customData');
    });

    await sendLocalEvmTransaction(
      provider,
      PRIVATE_KEY,
      {
        from: Promise.resolve(ADDRESS),
        to: Promise.resolve('alice.eth'),
        ccipReadEnabled: true,
        customData: { ignored: true },
      },
      beforeBroadcast,
      beforeSign,
      validate
    );

    expect(validate).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'context',
      'validate',
      'beforeBroadcast',
      'broadcast',
    ]);
  });

  it('rejects a populated envelope before signing or broadcasting when final validation fails', async () => {
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      getTransactionCount: jest.fn().mockResolvedValue(0),
      estimateGas: jest.fn().mockResolvedValue(BigNumber.from(42000)),
      getFeeData: jest.fn().mockResolvedValue({
        maxFeePerGas: BigNumber.from(301),
        maxPriorityFeePerGas: BigNumber.from(20),
      }),
      sendTransaction: jest.fn(),
    } as any;
    const error = new Error('Final fee exceeds approval');
    const beforeSign = jest.fn();
    const beforeBroadcast = jest.fn();
    const validate = jest.fn((transaction) => {
      expect(beforeSign).toHaveBeenCalledTimes(1);
      expect(
        transaction.gasLimit.mul(transaction.maxFeePerGas).toString()
      ).toBe('12642000');
      throw error;
    });
    const signer = jest.spyOn(
      // Observe the actual exported signing boundary; no successful signing mock.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../../src/transactions/evm-local-signer'),
      'signTransaction'
    );
    try {
      await expect(
        sendLocalEvmTransaction(
          provider,
          PRIVATE_KEY,
          { to: ADDRESS },
          beforeBroadcast,
          beforeSign,
          validate
        )
      ).rejects.toBe(error);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(signer).not.toHaveBeenCalled();
      expect(beforeBroadcast).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    } finally {
      signer.mockRestore();
    }
  });

  it.each(['resolve', 'reject'])(
    'rejects an async final validator before its pending decision (%s)',
    async (decision) => {
      const provider = {
        verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
        sendTransaction: jest.fn(),
      } as any;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const validate = jest.fn(async () => {
        entered();
        await pending;
        if (decision === 'reject') throw new Error('Late validator rejection');
      });
      const beforeBroadcast = jest.fn();
      const signer = jest.spyOn(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../../../src/transactions/evm-local-signer'),
        'signTransaction'
      );
      try {
        const result = sendLocalEvmTransaction(
          provider,
          PRIVATE_KEY,
          {
            to: ADDRESS,
            nonce: 0,
            chainId: 1,
            gasLimit: 21000,
            gasPrice: 100,
            type: 0,
          },
          beforeBroadcast,
          undefined,
          validate
        );
        const rejected = expect(result).rejects.toThrow(
          'Transaction validation must be synchronous'
        );
        await ready;
        // The call must reject while the validator still has no decision.
        await rejected;
        expect(signer).not.toHaveBeenCalled();
        expect(beforeBroadcast).not.toHaveBeenCalled();
        expect(provider.sendTransaction).not.toHaveBeenCalled();
        release();
        // Let the delayed rejection run; it must already have a rejection handler.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        release();
        signer.mockRestore();
      }
    }
  );

  it('rejects a custom final-validation thenable and consumes its rejection', async () => {
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      sendTransaction: jest.fn(),
    } as any;
    const then = jest.fn((_resolve, reject) => {
      reject(new Error('Thenable rejection'));
    });
    const validate = jest.fn(() => ({ then }));
    const beforeBroadcast = jest.fn();
    const signer = jest.spyOn(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../../src/transactions/evm-local-signer'),
      'signTransaction'
    );
    try {
      await expect(
        sendLocalEvmTransaction(
          provider,
          PRIVATE_KEY,
          {
            to: ADDRESS,
            nonce: 0,
            chainId: 1,
            gasLimit: 21000,
            gasPrice: 100,
            type: 0,
          },
          beforeBroadcast,
          undefined,
          validate
        )
      ).rejects.toThrow('Transaction validation must be synchronous');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(then).toHaveBeenCalledTimes(1);
      expect(signer).not.toHaveBeenCalled();
      expect(beforeBroadcast).not.toHaveBeenCalled();
      expect(provider.sendTransaction).not.toHaveBeenCalled();
    } finally {
      signer.mockRestore();
    }
  });

  it('preserves the five-argument send API when no final validator is supplied', async () => {
    const order: string[] = [];
    const provider = {
      verifyConfiguredChainId: jest.fn().mockResolvedValue(undefined),
      sendTransaction: jest.fn(async () => {
        order.push('broadcast');
        return { hash: '0x' + '34'.repeat(32) };
      }),
    } as any;
    await sendLocalEvmTransaction(
      provider,
      PRIVATE_KEY,
      {
        to: ADDRESS,
        nonce: 0,
        chainId: 1,
        gasLimit: 21000,
        gasPrice: 100,
        type: 0,
      },
      () => {
        order.push('beforeBroadcast');
      },
      () => {
        order.push('context');
      }
    );
    expect(order).toEqual(['context', 'beforeBroadcast', 'broadcast']);
    expect(provider.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('signs personal messages in MetaMask-compatible format', () => {
    const signature = signPersonalMessage(PERSONAL_MESSAGE, PRIVATE_KEY);
    const recovered = recoverPersonalSignature({
      data: PERSONAL_MESSAGE,
      signature,
    });

    expect(signature).toBe(PERSONAL_SIGNATURE);
    expect(recovered.toLowerCase()).toBe(ADDRESS.toLowerCase());
    expect(parsePersonalMessage(PERSONAL_MESSAGE)).toBe(
      'Example `personal_sign` message'
    );
  });

  it('hashes personal messages with the EIP-191 prefix', () => {
    expect(hashPersonalMessage(Buffer.from('hello'))).toBe(
      '0x50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750'
    );
  });
});

describe('EVM transaction serializer', () => {
  it('signs an EIP-1559 transaction byte-for-byte against a fixed vector', () => {
    expect(
      signTransaction(
        {
          to: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
          value: '0x0',
          gasLimit: '0x5208',
          maxFeePerGas: '0x4a817c800',
          maxPriorityFeePerGas: '0x77359400',
          nonce: 0,
          chainId: 1,
          type: 2,
          data: '0x',
        },
        PRIVATE_KEY
      )
    ).toBe(
      '0x02f86b018084773594008504a817c800825208942c7536e3605d9c16a7a3d7b1898e529396a65c238080c001a00e649d7c30947b140969ffd55afacebbfb1ad9a3f2598b46c9a7c83ea4b12d71a02e6f269af1511ca6337cc35761707c8459e7781502050ac87a9f8c1fe1e76c31'
    );
  });

  it('signs a legacy EIP-155 transaction byte-for-byte against a fixed vector', () => {
    expect(
      signTransaction(
        {
          to: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
          value: '0x01',
          gasLimit: '0x5208',
          gasPrice: '0x4a817c800',
          nonce: 1,
          chainId: 57,
          type: 0,
          data: '0x',
        },
        PRIVATE_KEY
      )
    ).toBe(
      '0xf865018504a817c800825208942c7536e3605d9c16a7a3d7b1898e529396a65c2301808196a09e45c98f8c125ec111da1ee78c493e4a81c6f395001db83c8d12e15a86bb6699a0395567d28d51d925f906ff930731a589c78138326bcce5687ce2b1697176ae9e'
    );
  });

  it('serializes legacy EIP-155 signatures for Syscoin NEVM chain 57', () => {
    const transaction = {
      to: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      value: '0x01',
      gasLimit: '0x5208',
      gasPrice: '0x01',
      nonce: 1,
      chainId: 57,
      type: 0,
      data: '0x',
    };
    const signature = {
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
      v: 149,
    };

    expect(() => serializeTransaction(transaction, signature)).not.toThrow();
    expect(serializeTransaction(transaction, signature)).toContain('8195');
  });

  it('signs an EIP-2930 transaction with access list byte-for-byte', () => {
    expect(
      signTransaction(
        {
          to: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
          value: '0x0',
          gasLimit: '0x5208',
          gasPrice: '0x4a817c800',
          nonce: 2,
          chainId: 1,
          type: 1,
          data: '0x',
          accessList: [
            {
              address: '0x0000000000000000000000000000000000000001',
              storageKeys: [
                '0x0000000000000000000000000000000000000000000000000000000000000000',
              ],
            },
          ],
        },
        PRIVATE_KEY
      )
    ).toBe(
      '0x01f89f01028504a817c800825208942c7536e3605d9c16a7a3d7b1898e529396a65c238080f838f7940000000000000000000000000000000000000001e1a0000000000000000000000000000000000000000000000000000000000000000080a08916200a771d6a544bc65b882ef2d78502b7c0d0822d723d0a9179f580e00dbea07b9ba2f6d11d1b0ac05e52273126193e0c23a7c4edf6bbc6e1d506066808017f'
    );
  });

  it('infers EIP-2930 type for access-list transactions', () => {
    const unsigned = serializeTransaction({
      to: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      value: '0x0',
      gasLimit: '0x5208',
      gasPrice: '0x4a817c800',
      nonce: 2,
      chainId: 1,
      data: '0x',
      accessList: [
        {
          address: '0x0000000000000000000000000000000000000001',
          storageKeys: [
            '0x0000000000000000000000000000000000000000000000000000000000000000',
          ],
        },
      ],
    });

    expect(Transaction.from(unsigned).type).toBe(1);
  });

  it('rejects unsupported transaction shapes', () => {
    expect(() =>
      serializeTransaction({ type: 5, chainId: 1, data: '0x' })
    ).toThrow('unsupported transaction type');

    expect(() =>
      serializeTransaction({
        type: 2,
        chainId: 1,
        gasPrice: '0x1',
        maxFeePerGas: '0x2',
      })
    ).toThrow('mismatch EIP-1559 gasPrice != maxFeePerGas');

    expect(() =>
      serializeTransaction({
        type: 0,
        accessList: [
          {
            address: '0x0000000000000000000000000000000000000001',
            storageKeys: [],
          },
        ],
      })
    ).toThrow('legacy transactions do not support accessList');
  });
});

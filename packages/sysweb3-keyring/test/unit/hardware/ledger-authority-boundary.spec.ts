import { SignTypedDataVersion, TypedDataUtils } from '@metamask/eth-sig-util';
import { hashMessage, Transaction, Wallet } from 'ethers';

import { HardwareWalletManager } from '../../../src/hardware-wallet-manager';
import { KeyringManager } from '../../../src/keyring-manager';
import { LedgerKeyring } from '../../../src/ledger';

import type { LedgerHost } from '../../../src/ledger/host-types';

const hostFixture = (): LedgerHost => ({
  connect: jest.fn(async () => undefined),
  disconnect: jest.fn(async () => undefined),
  getStatus: () => ({ connected: true }),
  evm: {} as LedgerHost['evm'],
  utxo: {} as LedgerHost['utxo'],
});

test('rejects separate manager and host injection before opening either device authority', () => {
  const host = hostFixture();
  const manager = { destroy: jest.fn() } as unknown as HardwareWalletManager;
  expect(() => new KeyringManager(manager, host)).toThrow(
    'Supply a shared hardware manager or a Ledger host, not both'
  );
  expect(host.connect).not.toHaveBeenCalled();
  expect(host.disconnect).not.toHaveBeenCalled();
  expect(manager.destroy).not.toHaveBeenCalled();
});

test('host-only injection binds the facade and its manager to the same host', async () => {
  const host = hostFixture();
  const keyring = new KeyringManager(undefined, host);
  try {
    await expect(
      keyring.ledgerSigner.ensureConnection()
    ).resolves.toBeUndefined();
    expect(keyring.ledgerSigner.getStatus().connected).toBe(true);
    const manager = (keyring.ledgerSigner as any).sharedHardwareWalletManager;
    expect(manager).toBeInstanceOf(HardwareWalletManager);
    expect(manager.isConnected('ledger')).toBe(true);
  } finally {
    await keyring.destroy();
  }
  expect(host.disconnect).toHaveBeenCalled();
});

const signingWallet = new Wallet(`0x${'11'.repeat(32)}`);
const otherWallet = new Wallet(`0x${'22'.repeat(32)}`);
const tx = (value = 1, chainId = 1) =>
  Transaction.from({
    type: 2,
    chainId,
    nonce: 3,
    gasLimit: 21000,
    maxFeePerGas: 10,
    maxPriorityFeePerGas: 1,
    to: otherWallet.address,
    value,
  });
const fields = (
  signature: ReturnType<typeof signingWallet.signingKey.sign>
) => ({
  r: signature.r.slice(2),
  s: signature.s.slice(2),
  v: signature.v.toString(16),
});
const typed = () => ({
  domain: { name: 'Public fixture', chainId: 1 },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    Message: [{ name: 'value', type: 'string' }],
  },
  primaryType: 'Message',
  message: { value: 'approved' },
});
const typedHash = (
  data: any,
  version: SignTypedDataVersion.V3 | SignTypedDataVersion.V4
) => `0x${TypedDataUtils.eip712Hash(data, version).toString('hex')}`;
const cryptoHost = () => {
  const host = hostFixture();
  host.evm = {
    getAddress: jest.fn(async () => ({
      address: signingWallet.address,
      publicKey: signingWallet.signingKey.publicKey,
    })),
    signTransaction: jest.fn(async ({ unsignedTxHex }) =>
      fields(
        signingWallet.signingKey.sign(
          Transaction.from(`0x${unsignedTxHex}`).unsignedHash
        )
      )
    ),
    signPersonalMessage: jest.fn(async ({ messageHex }) =>
      signingWallet.signMessage(Buffer.from(messageHex, 'hex'))
    ),
    signTypedData: jest.fn(
      async ({ data, version }) =>
        signingWallet.signingKey.sign(
          typedHash(
            data,
            version as SignTypedDataVersion.V3 | SignTypedDataVersion.V4
          )
        ).serialized
    ),
  };
  return { host, ledger: new LedgerKeyring(undefined, host) };
};

test('validates address/public-key equality at the authority boundary', async () => {
  const { host, ledger } = cryptoHost();
  await expect(
    ledger.evm.getEvmAddressAndPubKey({ accountIndex: 0 })
  ).resolves.toEqual({
    address: signingWallet.address,
    publicKey: signingWallet.signingKey.publicKey.slice(2),
  });
  (host.evm.getAddress as jest.Mock).mockResolvedValueOnce({
    address: signingWallet.address,
    publicKey: otherWallet.signingKey.publicKey,
  });
  await expect(
    ledger.evm.getEvmAddressAndPubKey({ accountIndex: 0 })
  ).rejects.toMatchObject({ code: 'LEDGER_INVALID_RESPONSE' });
});

test.each(['valid', 'wrong-account', 'different-transaction', 'wrong-chain-v'])(
  'validates the approved transaction signature (%s)',
  async (response) => {
    const { host, ledger } = cryptoHost();
    const approved = tx();
    if (response === 'wrong-account')
      (host.evm.signTransaction as jest.Mock).mockResolvedValueOnce(
        fields(otherWallet.signingKey.sign(approved.unsignedHash))
      );
    if (response === 'different-transaction')
      (host.evm.signTransaction as jest.Mock).mockResolvedValueOnce(
        fields(signingWallet.signingKey.sign(tx(2).unsignedHash))
      );
    if (response === 'wrong-chain-v') {
      const signature = fields(
        signingWallet.signingKey.sign(approved.unsignedHash)
      );
      signature.v = (Number.parseInt(signature.v, 16) + 12).toString(16); // EIP155 chain 2, approved chain 1.
      (host.evm.signTransaction as jest.Mock).mockResolvedValueOnce(signature);
    }
    const pending = ledger.evm.signEVMTransaction({
      accountIndex: 0,
      expectedAddress: signingWallet.address,
      rawTx: approved.unsignedSerialized,
    });
    if (response === 'valid')
      await expect(pending).resolves.toEqual(
        fields(signingWallet.signingKey.sign(approved.unsignedHash))
      );
    else
      await expect(pending).rejects.toMatchObject({
        code: 'LEDGER_INVALID_SIGNATURE',
      });
  }
);

test.each(['', '00ff80', Buffer.from('Pali 💚').toString('hex')])(
  'verifies exact personal-message bytes %s',
  async (message) => {
    const { ledger } = cryptoHost();
    await expect(
      ledger.evm.signPersonalMessage({
        accountIndex: 0,
        expectedAddress: signingWallet.address,
        message,
      })
    ).resolves.toBe(
      await signingWallet.signMessage(Buffer.from(message, 'hex'))
    );
  }
);

test.each(['wrong-account', 'wrong-bytes'])(
  'rejects a personal signature for %s',
  async (response) => {
    const { host, ledger } = cryptoHost();
    (host.evm.signPersonalMessage as jest.Mock).mockResolvedValueOnce(
      (response === 'wrong-account'
        ? otherWallet
        : signingWallet
      ).signingKey.sign(
        hashMessage(
          Buffer.from(response === 'wrong-bytes' ? '00' : 'ff', 'hex')
        )
      ).serialized
    );
    await expect(
      ledger.evm.signPersonalMessage({
        accountIndex: 0,
        expectedAddress: signingWallet.address,
        message: 'ff',
      })
    ).rejects.toMatchObject({ code: 'LEDGER_INVALID_SIGNATURE' });
  }
);

test.each([SignTypedDataVersion.V3, SignTypedDataVersion.V4])(
  'validates %s typed-data signature and rejects a different payload',
  async (version) => {
    const { host, ledger } = cryptoHost();
    const data = typed();
    await expect(
      ledger.evm.signTypedData({
        accountIndex: 0,
        expectedAddress: signingWallet.address,
        version,
        data,
      })
    ).resolves.toBe(
      signingWallet.signingKey.sign(typedHash(data, version)).serialized
    );
    (host.evm.signTypedData as jest.Mock).mockResolvedValueOnce(
      signingWallet.signingKey.sign(
        typedHash({ ...data, message: { value: 'different' } }, version)
      ).serialized
    );
    await expect(
      ledger.evm.signTypedData({
        accountIndex: 0,
        expectedAddress: signingWallet.address,
        version,
        data,
      })
    ).rejects.toMatchObject({ code: 'LEDGER_INVALID_SIGNATURE' });
  }
);

test('captures typed data before pending connection and exposes no mutable approval object', async () => {
  const { host, ledger } = cryptoHost();
  let complete!: () => void;
  host.getStatus = () => ({ connected: false });
  host.connect = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  const data = typed();
  const pending = ledger.evm.signTypedData({
    accountIndex: 0,
    expectedAddress: signingWallet.address,
    version: SignTypedDataVersion.V4,
    data,
  });
  data.message.value = 'changed after request';
  complete();
  await pending;
  const approved = (host.evm.signTypedData as jest.Mock).mock.calls[0][0].data;
  expect(approved.message.value).toBe('approved');
  expect(Object.isFrozen(approved.message)).toBe(true);
});

test.each(['signPsbt', 'signUtxoMessage'] as const)(
  'captures %s request fields before a pending connection',
  async (method) => {
    const host = hostFixture();
    const ledger = new LedgerKeyring(undefined, host);
    let complete!: () => void;
    host.getStatus = () => ({ connected: false });
    host.connect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const request = {
      currency: 'tSYS',
      slip44: 1,
      accountIndex: 0,
      accountXpub: 'approved account xpub',
      ...(method === 'signPsbt'
        ? { psbtBase64: 'approved psbt' }
        : { message: 'approved message', addressIndex: 2, change: false }),
    };
    const expected = { ...request };
    const sign: jest.Mock = jest.fn(async () => {
      return method === 'signPsbt'
        ? { fingerprint: '01020304', signatures: [] }
        : 'signature';
    });
    if (method === 'signPsbt') host.utxo.signPsbt = sign as any;
    else host.utxo.signMessage = sign as any;
    const pending = ledger[method](request as any);
    Object.assign(request, {
      currency: 'BTC',
      slip44: 0,
      accountIndex: 1,
      accountXpub: 'replaced account xpub',
      psbtBase64: 'replaced psbt',
      message: 'replaced message',
      addressIndex: 7,
      change: true,
    });
    complete();
    await pending;
    expect(sign).toHaveBeenCalledWith(expected);
    expect(Object.isFrozen(sign.mock.calls[0][0])).toBe(true);
  }
);

test('discards a queued valid personal signature after synchronous destruction', async () => {
  const { host, ledger } = cryptoHost();
  let complete!: (signature: string) => void;
  (host.evm.signPersonalMessage as jest.Mock).mockReturnValue(
    new Promise<string>((resolve) => {
      complete = resolve;
    })
  );
  const pending = ledger.evm.signPersonalMessage({
    accountIndex: 0,
    expectedAddress: signingWallet.address,
    message: 'ff',
  });
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'HARDWARE_REQUEST_CANCELLED',
  });
  await ledger.destroy();
  complete(
    signingWallet.signingKey.sign(hashMessage(Buffer.from('ff', 'hex')))
      .serialized
  );
  await rejected;
});

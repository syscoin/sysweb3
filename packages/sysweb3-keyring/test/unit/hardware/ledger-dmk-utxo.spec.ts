import {
  ApduResponse,
  isSuccessCommandResult,
} from '@ledgerhq/device-management-kit';
import { getNetworkConfig } from '@sidhujag/sysweb3-network';
import { payments, Psbt, Transaction } from 'bitcoinjs-lib';
import { from } from 'rxjs';

import { AppClient } from '../../../src/ledger/bitcoin_client/lib/appClient';
import {
  createBitcoinAppTransport,
  LedgerBitcoinCommand,
  ledgerUtxoApp,
  createLedgerUtxoAdapter,
} from '../../../src/ledger/dmk-utxo';

jest.unmock('syscoinjs-lib');

const response = (data: number[], status: number) =>
  new ApduResponse({
    data: Uint8Array.from(data),
    statusCode: Uint8Array.of(status >> 8, status & 255),
  });

describe('Ledger DMK Syscoin/Bitcoin APDU adapter', () => {
  it('preserves exact short APDUs and response status bytes', async () => {
    const command = new LedgerBitcoinCommand(
      0xe1,
      4,
      0,
      1,
      Uint8Array.of(1, 2, 3),
      [0x9000, 0xe000]
    );
    expect(Buffer.from(command.getApdu().getRawApdu()).toString('hex')).toBe(
      'e104000103010203'
    );
    const parsed = command.parseResponse(response([5, 6], 0xe000));
    expect(isSuccessCommandResult(parsed)).toBe(true);
    if (isSuccessCommandResult(parsed))
      expect(parsed.data.toString('hex')).toBe('0506e000');
    expect(() =>
      new LedgerBitcoinCommand(0xe1, 4, 0, 1, new Uint8Array(256)).getApdu()
    ).toThrow();
  });

  it('preserves user rejection as a non-success status without retrying', async () => {
    const sendCommand = jest.fn(async (command) =>
      command.parseResponse(response([], 0x6985))
    );
    const transport = createBitcoinAppTransport(
      { sendCommand } as any,
      () => undefined
    );
    await expect(transport.send(0xe1, 5, 0, 1)).rejects.toMatchObject({
      statusCode: 0x6985,
      code: 'HARDWARE_REQUEST_REJECTED',
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('continues an interrupted exchange in the same internal API', async () => {
    const raw: string[] = [];
    const sendCommand = jest.fn(async (command) => {
      raw.push(Buffer.from(command.getApdu().getRawApdu()).toString('hex'));
      return command.parseResponse(
        raw.length === 1 ? response([0x40], 0xe000) : response([0xaa], 0x9000)
      );
    });
    const client = new AppClient(
      createBitcoinAppTransport({ sendCommand } as any, () => undefined)
    );
    const execute = jest.fn(() => Buffer.from([0x55]));
    const result = await (client as any).makeRequest(4, Buffer.from([0x22]), {
      execute,
    });
    expect(result.toString('hex')).toBe('aa');
    expect(execute).toHaveBeenCalledWith(Buffer.from([0x40]));
    expect(raw).toEqual(['e10400010122', 'f80100000155']);
  });

  it('does not issue a continuation APDU when its generation was revoked', async () => {
    let current = true;
    const sendCommand = jest.fn(async (command) => {
      current = false;
      return command.parseResponse(response([0x40], 0xe000));
    });
    const client = new AppClient(
      createBitcoinAppTransport({ sendCommand } as any, () => {
        if (!current) throw new Error('revoked');
      })
    );
    await expect(
      (client as any).makeRequest(4, Buffer.from([]), { execute: jest.fn() })
    ).rejects.toThrow('revoked');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('selects Syscoin and the explicit Bitcoin main/test applications', () => {
    expect(
      ledgerUtxoApp({ currency: 'SYS', slip44: 57, accountIndex: 0 })
    ).toBe('Syscoin');
    expect(ledgerUtxoApp({ currency: 'SYS', slip44: 1, accountIndex: 0 })).toBe(
      'Syscoin'
    );
    expect(ledgerUtxoApp({ currency: 'BTC', slip44: 0, accountIndex: 0 })).toBe(
      'Bitcoin'
    );
    expect(ledgerUtxoApp({ currency: 'BTC', slip44: 1, accountIndex: 0 })).toBe(
      'Bitcoin Test'
    );
    expect(() =>
      ledgerUtxoApp({ currency: 'SYS', slip44: 60, accountIndex: 0 })
    ).toThrow();
    expect(() =>
      ledgerUtxoApp({ currency: 'SYS', slip44: 57, accountIndex: -1 })
    ).toThrow();
  });

  const signingFixture = (currency = 'tSYS', slip44 = 1) => {
    const config = getNetworkConfig(slip44, currency);
    const actual = jest.requireActual('syscoinjs-lib');
    const hd = new actual.utils.HDSigner(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      null,
      slip44 === 1,
      config.networks,
      slip44,
      config.types.zPubType,
      84
    );
    const root = hd.getRootNode();
    const key = root.derivePath(`m/84'/${slip44}'/0'/0/0`);
    const payment = payments.p2wpkh({
      pubkey: key.publicKey,
      network: slip44 === 1 ? config.networks.testnet : config.networks.mainnet,
    });
    const previous = new Transaction();
    previous.addInput(Buffer.alloc(32), 0xffffffff);
    previous.addOutput(payment.output!, 100000n);
    const psbt = new Psbt({
      network: slip44 === 1 ? config.networks.testnet : config.networks.mainnet,
    });
    psbt.addInput({
      hash: previous.getId(),
      index: 0,
      nonWitnessUtxo: previous.toBuffer(),
      witnessUtxo: { script: payment.output!, value: 100000n },
    });
    psbt.addUnknownKeyValToInput(0, {
      key: Buffer.from('path'),
      value: Buffer.from(`m/84'/${slip44}'/0'/0/0`),
    });
    psbt.addOutput({ address: payment.address!, value: 99000n });
    const actions: any[] = [];
    const operation = {
      generation: 1,
      sessionId: 'session',
      assertCurrent: jest.fn(),
      dmk: {
        executeDeviceAction: jest.fn(({ deviceAction }) => {
          actions.push(deviceAction);
          return {
            observable: from(
              deviceAction.input.task({}).then((result: any) => {
                return result.status === 'SUCCESS'
                  ? { status: 'completed', output: result.data }
                  : { status: 'error', error: result.error };
              })
            ),
            cancel: jest.fn(),
          };
        }),
      },
      runAction: async (createAction: () => any) => {
        const action = createAction();
        return new Promise((resolve, reject) =>
          action.observable.subscribe({
            next: (state: any) => {
              if (state.status === 'completed') resolve(state.output);
              else reject(state.error);
            },
            error: reject,
          })
        );
      },
    };
    const session: any = {
      onInvalidated: jest.fn(),
      runExclusive: async (run: any) => run(operation),
    };
    const adapter = createLedgerUtxoAdapter(session);
    return {
      adapter,
      actions,
      operation,
      key,
      address: payment.address!,
      request: {
        currency,
        slip44,
        accountIndex: 0,
        accountXpub: hd.getAccountXpub(),
        psbtBase64: psbt.toBase64(),
      },
    };
  };

  describe.each([
    ['SYS', 57],
    ['tSYS', 1],
    ['BTC', 0],
    ['tBTC', 1],
  ])('%s account addresses', (currency, slip44) => {
    it.each(['getAddress', 'getAccount'] as const)(
      '%s binds the device response to receive address 0/0',
      async (method) => {
        const { adapter, request, address } = signingFixture(
          currency as string,
          slip44 as number
        );
        const fingerprint = jest
          .spyOn(AppClient.prototype, 'getMasterFingerprint')
          .mockResolvedValue('01020304');
        const xpub = jest
          .spyOn(AppClient.prototype, 'getExtendedPubkey')
          .mockResolvedValue(request.accountXpub);
        const registration = jest
          .spyOn(AppClient.prototype, 'registerWallet')
          .mockImplementation(async (policy) => [
            policy.getId(),
            Buffer.alloc(32, 0x55),
          ]);
        const deviceAddress = jest
          .spyOn(AppClient.prototype, 'getWalletAddress')
          .mockResolvedValue(address.toUpperCase());
        try {
          const output = await adapter[method]({
            currency: request.currency,
            slip44: request.slip44,
            accountIndex: request.accountIndex,
            checkOnDevice: true,
          });
          expect(output).toEqual(
            method === 'getAddress'
              ? address
              : { fingerprint: '01020304', xpub: request.accountXpub, address }
          );
          expect(deviceAddress).toHaveBeenCalledWith(
            expect.anything(),
            Buffer.alloc(32, 0x55),
            0,
            0,
            true
          );
        } finally {
          fingerprint.mockRestore();
          xpub.mockRestore();
          registration.mockRestore();
          deviceAddress.mockRestore();
        }
      }
    );
  });

  it.each(['SYS', 'BTC'])(
    'uses the test network for a %s alias with slip44 1',
    async (currency) => {
      const { adapter, request, address } = signingFixture(`t${currency}`, 1);
      const fingerprint = jest
        .spyOn(AppClient.prototype, 'getMasterFingerprint')
        .mockResolvedValue('01020304');
      const xpub = jest
        .spyOn(AppClient.prototype, 'getExtendedPubkey')
        .mockResolvedValue(request.accountXpub);
      const registration = jest
        .spyOn(AppClient.prototype, 'registerWallet')
        .mockImplementation(async (policy) => [
          policy.getId(),
          Buffer.alloc(32, 0x55),
        ]);
      const deviceAddress = jest
        .spyOn(AppClient.prototype, 'getWalletAddress')
        .mockResolvedValue(address);
      try {
        await expect(
          adapter.getAddress({ currency, slip44: 1, accountIndex: 0 })
        ).resolves.toBe(address);
      } finally {
        fingerprint.mockRestore();
        xpub.mockRestore();
        registration.mockRestore();
        deviceAddress.mockRestore();
      }
    }
  );

  it.each(['getAddress', 'getAccount'] as const)(
    '%s rejects an unrelated device address',
    async (method) => {
      const { adapter, request, key } = signingFixture();
      const config = getNetworkConfig(request.slip44, request.currency);
      const unrelatedAddress = payments.p2wpkh({
        pubkey: key.derive(1).publicKey,
        network: config.networks.testnet,
      }).address!;
      const fingerprint = jest
        .spyOn(AppClient.prototype, 'getMasterFingerprint')
        .mockResolvedValue('01020304');
      const xpub = jest
        .spyOn(AppClient.prototype, 'getExtendedPubkey')
        .mockResolvedValue(request.accountXpub);
      const registration = jest
        .spyOn(AppClient.prototype, 'registerWallet')
        .mockImplementation(async (policy) => [
          policy.getId(),
          Buffer.alloc(32, 0x55),
        ]);
      const deviceAddress = jest
        .spyOn(AppClient.prototype, 'getWalletAddress')
        .mockResolvedValue(unrelatedAddress);
      try {
        await expect(adapter[method](request)).rejects.toMatchObject({
          code: 'LEDGER_INVALID_RESPONSE',
        });
      } finally {
        fingerprint.mockRestore();
        xpub.mockRestore();
        registration.mockRestore();
        deviceAddress.mockRestore();
      }
    }
  );

  it('gets identity, registers policy and signs a prepared PSBT inside one app action', async () => {
    const { adapter, request, operation, key, actions } = signingFixture();
    const calls: string[] = [];
    const fingerprint = jest
      .spyOn(AppClient.prototype, 'getMasterFingerprint')
      .mockImplementation(async () => {
        calls.push('fingerprint');
        return '01020304';
      });
    const xpub = jest
      .spyOn(AppClient.prototype, 'getExtendedPubkey')
      .mockImplementation(async () => {
        calls.push('xpub');
        return request.accountXpub;
      });
    const registration = jest
      .spyOn(AppClient.prototype, 'registerWallet')
      .mockImplementation(async (policy) => {
        calls.push('register');
        return [policy.getId(), Buffer.alloc(32, 0x55)];
      });
    const sign = jest
      .spyOn(AppClient.prototype, 'signPsbt')
      .mockImplementation(async (psbt: any) => {
        calls.push('sign');
        expect(
          psbt.getInputBip32Derivation(0, Buffer.from(key.publicKey))
            .masterFingerprint
        ).toEqual(Buffer.from('01020304', 'hex'));
        return [
          [
            0,
            {
              pubkey: Buffer.from(key.publicKey),
              signature: Buffer.from('abcd', 'hex'),
            },
          ],
        ];
      });
    try {
      const output = await adapter.signPsbt(request);
      expect(output).toEqual({
        fingerprint: '01020304',
        signatures: [
          {
            inputIndex: 0,
            pubkeyHex: Buffer.from(key.publicKey).toString('hex'),
            signatureHex: 'abcd',
          },
        ],
      });
      expect(calls).toEqual(['fingerprint', 'xpub', 'register', 'sign']);
      expect(operation.dmk.executeDeviceAction).toHaveBeenCalledTimes(1);
      expect(actions[0].input.appName).toBe('Syscoin');
    } finally {
      fingerprint.mockRestore();
      xpub.mockRestore();
      registration.mockRestore();
      sign.mockRestore();
    }
  });

  it('propagates rejected policy registration without signing or null-HMAC fallback', async () => {
    const { adapter, request } = signingFixture();
    const fingerprint = jest
      .spyOn(AppClient.prototype, 'getMasterFingerprint')
      .mockResolvedValue('01020304');
    const xpub = jest
      .spyOn(AppClient.prototype, 'getExtendedPubkey')
      .mockResolvedValue(request.accountXpub);
    const rejection = Object.assign(new Error('rejected'), {
      statusCode: 0x6985,
    });
    const registration = jest
      .spyOn(AppClient.prototype, 'registerWallet')
      .mockRejectedValue(rejection);
    const sign = jest.spyOn(AppClient.prototype, 'signPsbt');
    try {
      await expect(adapter.signPsbt(request)).rejects.toMatchObject({
        statusCode: 0x6985,
      });
      expect(registration).toHaveBeenCalledTimes(1);
      expect(sign).not.toHaveBeenCalled();
    } finally {
      fingerprint.mockRestore();
      xpub.mockRestore();
      registration.mockRestore();
      sign.mockRestore();
    }
  });
});

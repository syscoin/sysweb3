/* eslint-disable camelcase */
import ecc from '@bitcoinerlab/secp256k1';
import TrezorConnect from '@trezor/connect-webextension';
import * as syscoinjs from 'syscoinjs-lib';

import { TrezorKeyring } from '../../../src/trezor';

const bitcoinjs: any = (syscoinjs.utils as any).bitcoinjs;
const privateKey = Buffer.alloc(32, 1);
const publicKey = Buffer.from(ecc.pointFromScalar(privateKey)!);
const signer = {
  publicKey,
  sign: (hash: Buffer) => Buffer.from(ecc.sign(hash, privateKey)),
};
const network = bitcoinjs.networks.testnet;
const payment = bitcoinjs.payments.p2wpkh({ pubkey: publicKey, network });

const fixture = (locktime = 12345, sequence = 0) => {
  const psbt = new bitcoinjs.Psbt({ network });
  psbt.setVersion(2);
  psbt.setLocktime(locktime);
  psbt.addInput({
    hash: Buffer.alloc(32, 2),
    index: 1,
    sequence,
    witnessUtxo: { script: payment.output, value: 100000n },
    bip32Derivation: [
      {
        masterFingerprint: Buffer.alloc(4),
        path: "m/84'/1'/0'/0/0",
        pubkey: publicKey,
      },
    ],
  });
  psbt.addOutput({ address: payment.address, value: 99000n });
  return psbt;
};
const signedTransaction = (psbt: any) => {
  const signed = psbt.clone();
  signed.signInput(0, signer);
  signed.finalizeAllInputs();
  return signed.extractTransaction().toHex();
};
const finalizedExternalFixture = (
  type: 'witness' | 'legacy',
  includeNonWitness = true
) => {
  const externalPrivateKey = Buffer.alloc(32, 3);
  const externalPublicKey = Buffer.from(
    ecc.pointFromScalar(externalPrivateKey)!
  );
  const externalPayment =
    type === 'witness'
      ? bitcoinjs.payments.p2wpkh({ pubkey: externalPublicKey, network })
      : bitcoinjs.payments.p2pkh({ pubkey: externalPublicKey, network });
  const previous = new bitcoinjs.Transaction();
  previous.addInput(Buffer.alloc(32, 5), 0xffffffff);
  previous.addOutput(externalPayment.output, 100000n);
  const psbt = fixture();
  psbt.addInput({
    hash: previous.getId(),
    index: 0,
    sequence: 0xfffffffd,
    ...(includeNonWitness ? { nonWitnessUtxo: previous.toBuffer() } : {}),
    ...(type === 'witness'
      ? { witnessUtxo: { script: externalPayment.output, value: 100000n } }
      : {}),
  });
  psbt.addOutput({ address: payment.address, value: 99000n });
  psbt.signInput(1, {
    publicKey: externalPublicKey,
    sign: (hash: Buffer) => Buffer.from(ecc.sign(hash, externalPrivateKey)),
  });
  psbt.finalizeInput(1);
  // Even stale metadata must never turn a finalized input into a new signing
  // request for a different account on the connected device.
  psbt.data.inputs[1].bip32Derivation = [
    {
      masterFingerprint: Buffer.alloc(4, 9),
      path: "m/84'/1'/9'/0/0",
      pubkey: externalPublicKey,
    },
  ];
  return { psbt, externalPayment };
};
const signedJointTransaction = (psbt: any) => {
  const signed = psbt.clone();
  signed.signInput(0, signer);
  signed.finalizeInput(0);
  return signed.extractTransaction().toHex();
};

describe('Trezor unsigned transaction integrity', () => {
  let receiver: TrezorKeyring;

  beforeEach(() => {
    receiver = Object.create(TrezorKeyring.prototype);
    (receiver as any).executeWithRetry = jest.fn((operation) => operation());
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [0, 0xffffffff],
    [0, 0xfffffffd],
    [0, 0],
    [12345, 0xfffffffd],
    [12345, 0],
  ])(
    'preserves exact locktime %i and sequence %i in the device request',
    (locktime, sequence) => {
      const psbt = fixture(locktime, sequence);
      const before = psbt.toBase64();
      const request = receiver.convertToTrezorFormat({
        psbt,
        coin: 'testnet',
        network,
      });
      expect(request.version).toBe(2);
      expect(request.locktime).toBe(locktime);
      expect(request.inputs[0].sequence).toBe(sequence);
      expect(psbt.toBase64()).toBe(before);
    }
  );

  it('accepts a real SegWit signature for the exact approved transaction', async () => {
    const psbt = fixture();
    const serializedTx = signedTransaction(psbt);
    jest
      .spyOn(TrezorConnect, 'signTransaction')
      .mockResolvedValue({ success: true, payload: { serializedTx } } as any);
    const signed = await receiver.signUtxoTransaction({}, psbt);
    expect(signed.extractTransaction().toHex()).toBe(serializedTx);
  });

  it.each([
    'version',
    'locktime',
    'sequence',
    'outpoint',
    'inputIndex',
    'amount',
    'script',
    'inputCount',
    'outputCount',
  ])(
    'rejects a changed %s before importing any device signature',
    async (field) => {
      const psbt = fixture();
      const tx = bitcoinjs.Transaction.fromHex(signedTransaction(psbt));
      if (field === 'version') tx.version = 1;
      if (field === 'locktime') tx.locktime = 0;
      if (field === 'sequence') tx.ins[0].sequence = 0xffffffff;
      if (field === 'outpoint') tx.ins[0].hash = Buffer.alloc(32, 9);
      if (field === 'inputIndex') tx.ins[0].index = 2;
      if (field === 'amount') tx.outs[0].value = 98000n;
      if (field === 'script') tx.outs[0].script = Buffer.from([0x51]);
      if (field === 'inputCount') tx.addInput(Buffer.alloc(32, 3), 0);
      if (field === 'outputCount') tx.addOutput(Buffer.from([0x51]), 0n);
      jest.spyOn(TrezorConnect, 'signTransaction').mockResolvedValue({
        success: true,
        payload: { serializedTx: tx.toHex() },
      } as any);
      const update = jest.spyOn(psbt, 'updateInput');
      await expect(receiver.signUtxoTransaction({}, psbt)).rejects.toThrow(
        'different unsigned transaction'
      );
      expect(update).not.toHaveBeenCalled();
      expect(TrezorConnect.signTransaction).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects even a valid signature over the device-default locktime and sequence', async () => {
    const approved = fixture(12345, 0);
    const deviceDefault = fixture(0, 0xffffffff);
    const serializedTx = signedTransaction(deviceDefault);
    jest
      .spyOn(TrezorConnect, 'signTransaction')
      .mockResolvedValue({ success: true, payload: { serializedTx } } as any);
    const update = jest.spyOn(approved, 'updateInput');
    await expect(receiver.signUtxoTransaction({}, approved)).rejects.toThrow(
      'different unsigned transaction'
    );
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['inputs', 'outputs'])('rejects reordered %s', async (field) => {
    const psbt = fixture();
    psbt.addInput({
      hash: Buffer.alloc(32, 3),
      index: 0,
      sequence: 0,
      witnessUtxo: { script: payment.output, value: 100000n },
    });
    psbt.addOutput({ script: Buffer.from([0x51]), value: 99000n });
    const signed = psbt.clone();
    signed.signAllInputs(signer);
    signed.finalizeAllInputs();
    const tx = signed.extractTransaction();
    if (field === 'inputs') tx.ins.reverse();
    else tx.outs.reverse();
    jest.spyOn(TrezorConnect, 'signTransaction').mockResolvedValue({
      success: true,
      payload: { serializedTx: tx.toHex() },
    } as any);
    const update = jest.spyOn(psbt, 'updateInput');
    await expect(receiver.signUtxoTransaction({}, psbt)).rejects.toThrow(
      'different unsigned transaction'
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a PSBT mutated while device approval was pending', async () => {
    const psbt = fixture();
    const serializedTx = signedTransaction(psbt);
    jest
      .spyOn(TrezorConnect, 'signTransaction')
      .mockImplementation(async () => {
        psbt.setLocktime(999);
        return { success: true, payload: { serializedTx } } as any;
      });
    const update = jest.spyOn(psbt, 'updateInput');
    await expect(receiver.signUtxoTransaction({}, psbt)).rejects.toThrow(
      'different unsigned transaction'
    );
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['witness', 'legacy'] as const)(
    'maps an already-finalized %s co-signer input to EXTERNAL without a device path',
    (type) => {
      const { psbt, externalPayment } = finalizedExternalFixture(type);
      const before = psbt.toBase64();
      const request = receiver.convertToTrezorFormat({
        psbt,
        coin: 'testnet',
        network,
      });
      expect(request.inputs[0].address_n).toBeDefined();
      expect(request.inputs[1]).toMatchObject({
        prev_hash: Buffer.from(psbt.txInputs[1].hash).reverse().toString('hex'),
        prev_index: 0,
        sequence: 0xfffffffd,
        script_type: 'EXTERNAL',
        amount: '100000',
        script_pubkey: Buffer.from(externalPayment.output).toString('hex'),
      });
      expect(request.inputs[1]).not.toHaveProperty('address_n');
      if (type === 'witness')
        expect(request.inputs[1].witness).toBe(
          Buffer.from(psbt.data.inputs[1].finalScriptWitness).toString('hex')
        );
      else
        expect(request.inputs[1].script_sig).toBe(
          Buffer.from(psbt.data.inputs[1].finalScriptSig).toString('hex')
        );
      expect(psbt.toBase64()).toBe(before);
    }
  );

  it('accepts a finalized witness input with its witness prevout only', () => {
    const { psbt } = finalizedExternalFixture('witness', false);
    const request = receiver.convertToTrezorFormat({
      psbt,
      coin: 'testnet',
      network,
    });
    expect(request.inputs[1].script_type).toBe('EXTERNAL');
    expect(request.inputs[1].amount).toBe('100000');
    expect(request.inputs[1]).not.toHaveProperty('address_n');
  });

  it.each(['missing', 'contradictory'])(
    'rejects a finalized external input with a %s prevout',
    (kind) => {
      const { psbt } = finalizedExternalFixture('witness', kind !== 'missing');
      if (kind === 'missing') {
        delete psbt.data.inputs[1].witnessUtxo;
      } else psbt.data.inputs[1].witnessUtxo.value += 1n;
      expect(() =>
        receiver.convertToTrezorFormat({ psbt, coin: 'testnet', network })
      ).toThrow(/external input/);
    }
  );

  it.each(['witness', 'legacy'] as const)(
    'preserves a finalized %s input while importing only the approved device signature',
    async (type) => {
      const { psbt } = finalizedExternalFixture(type);
      const originalScript = psbt.data.inputs[1].finalScriptSig;
      const originalWitness = psbt.data.inputs[1].finalScriptWitness;
      const serializedTx = signedJointTransaction(psbt);
      jest
        .spyOn(TrezorConnect, 'signTransaction')
        .mockResolvedValue({ success: true, payload: { serializedTx } } as any);
      const update = jest.spyOn(psbt, 'updateInput');
      const signed = await receiver.signUtxoTransaction({}, psbt);
      expect(update.mock.calls.map(([index]) => index)).toEqual([0]);
      expect(signed.data.inputs[1].finalScriptSig).toEqual(originalScript);
      expect(signed.data.inputs[1].finalScriptWitness).toEqual(originalWitness);
      expect(signed.extractTransaction().toHex()).toBe(serializedTx);
    }
  );

  it.each(['witness', 'legacy'] as const)(
    'rejects a changed finalized %s input before importing any signature',
    async (type) => {
      const { psbt } = finalizedExternalFixture(type);
      const tx = bitcoinjs.Transaction.fromHex(signedJointTransaction(psbt));
      if (type === 'witness') tx.ins[1].witness[0][0] ^= 1;
      else tx.ins[1].script[0] ^= 1;
      jest.spyOn(TrezorConnect, 'signTransaction').mockResolvedValue({
        success: true,
        payload: { serializedTx: tx.toHex() },
      } as any);
      const update = jest.spyOn(psbt, 'updateInput');
      await expect(receiver.signUtxoTransaction({}, psbt)).rejects.toThrow(
        'changed an already-finalized input'
      );
      expect(update).not.toHaveBeenCalled();
    }
  );

  it('rejects finalized input data mutated while the device was signing', async () => {
    const { psbt } = finalizedExternalFixture('witness');
    const serializedTx = signedJointTransaction(psbt);
    jest
      .spyOn(TrezorConnect, 'signTransaction')
      .mockImplementation(async () => {
        psbt.data.inputs[1].finalScriptWitness = Buffer.from([0]);
        return { success: true, payload: { serializedTx } } as any;
      });
    const update = jest.spyOn(psbt, 'updateInput');
    await expect(receiver.signUtxoTransaction({}, psbt)).rejects.toThrow(
      'changed an already-finalized input'
    );
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['', 'deadbeef', '00'])(
    'rejects malformed returned transaction %p before changing the PSBT',
    async (serializedTx) => {
      const psbt = fixture();
      jest
        .spyOn(TrezorConnect, 'signTransaction')
        .mockResolvedValue({ success: true, payload: { serializedTx } } as any);
      const update = jest.spyOn(psbt, 'updateInput');
      await expect(receiver.signUtxoTransaction({}, psbt)).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
    }
  );

  it.each(['00', 'fd0000', '0101', 'fd010000'])(
    'rejects malformed or noncanonical finalized witness %s',
    async (hex) => {
      const { psbt } = finalizedExternalFixture('witness');
      const serializedTx = signedJointTransaction(psbt);
      psbt.data.inputs[1].finalScriptWitness = Buffer.from(hex, 'hex');
      jest
        .spyOn(TrezorConnect, 'signTransaction')
        .mockResolvedValue({ success: true, payload: { serializedTx } } as any);
      const update = jest.spyOn(psbt, 'updateInput');
      await expect(receiver.signUtxoTransaction({}, psbt)).rejects.toThrow(
        'changed an already-finalized input'
      );
      expect(update).not.toHaveBeenCalled();
    }
  );
});

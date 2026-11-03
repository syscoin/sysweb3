jest.unmock('syscoinjs-lib');

import { getNetworkConfig, INetworkType } from '@sidhujag/sysweb3-network';
import { payments, Psbt, Transaction } from 'bitcoinjs-lib';

import { LedgerKeyring } from '../../../src/ledger';
import { PsbtV2 } from '../../../src/ledger/bitcoin_client';
import { prepareLedgerPsbt } from '../../../src/ledger/prepare-psbt';
import { SyscoinTransactions } from '../../../src/transactions/syscoin';
import { KeyringAccountType } from '../../../src/types';
import { PsbtUtils } from '../../../src/utils/psbt';

const config = getNetworkConfig(1, 'tSYS');
const network = config.networks.testnet;
const activeNetwork = {
  kind: INetworkType.Syscoin,
  chainId: 5700,
  slip44: 1,
  currency: 'tSYS',
  url: 'https://offline.invalid',
};

const removeNonWitnessUtxo = (psbt: Psbt, index: number) => {
  // bitcoinjs installs a non-configurable cache accessor on the original input.
  const input = { ...psbt.data.inputs[index] };
  delete input.nonWitnessUtxo;
  psbt.data.inputs[index] = input;
};

const fixture = (scriptType = 'p2wpkh', sameWallet = false) => {
  const actual = jest.requireActual('syscoinjs-lib');
  const makeHd = (seed: string) =>
    new actual.utils.HDSigner(
      seed,
      null,
      true,
      config.networks,
      1,
      config.types.zPubType,
      84
    );
  const hd = makeHd(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  );
  const otherHd = makeHd(
    'legal winner thank year wave sausage worth useful legal winner thank yellow'
  );
  const root = hd.getRootNode();
  const foreignRoot = sameWallet ? root : otherHd.getRootNode();
  const path = "m/84'/1'/0'/0/0";
  const foreignPath = "m/84'/1'/1'/0/0";
  const ownedKey = root.derivePath(path);
  const foreignKey = foreignRoot.derivePath(foreignPath);
  const ownedPayment = payments.p2wpkh({
    pubkey: ownedKey.publicKey,
    network,
  });
  const foreignWitness = payments.p2wpkh({
    pubkey: foreignKey.publicKey,
    network,
  });
  const foreignPayment =
    scriptType === 'p2pkh'
      ? payments.p2pkh({ pubkey: foreignKey.publicKey, network })
      : scriptType === 'p2sh-p2wpkh'
      ? payments.p2sh({ redeem: foreignWitness, network })
      : foreignWitness;
  const account = {
    id: 0,
    address: ownedPayment.address!,
    xpub: hd.getAccountXpub(),
    isLedgerWallet: true,
  };
  const previous = new Transaction();
  previous.addInput(Buffer.alloc(32), 0xffffffff);
  previous.addOutput(ownedPayment.output!, 100000n);
  previous.addOutput(foreignPayment.output!, 100000n);
  const psbt = new Psbt({ network });
  [ownedKey, foreignKey].forEach((key, index) => {
    psbt.addInput({
      hash: previous.getId(),
      index,
      nonWitnessUtxo: previous.toBuffer(),
      witnessUtxo: {
        script: previous.outs[index].script,
        value: previous.outs[index].value,
      },
      ...(index === 1 && scriptType === 'p2sh-p2wpkh'
        ? { redeemScript: foreignWitness.output }
        : {}),
      bip32Derivation: [
        {
          pubkey: key.publicKey,
          masterFingerprint: index ? foreignRoot.fingerprint : root.fingerprint,
          path: index ? foreignPath : path,
        },
      ],
    });
  });
  psbt.addOutput({ address: account.address, value: 199000n });
  const unsigned = psbt.clone();
  psbt.signInput(1, foreignKey);
  psbt.finalizeInput(1);
  const finalScriptSig = psbt.data.inputs[1].finalScriptSig
    ? Buffer.from(psbt.data.inputs[1].finalScriptSig)
    : undefined;
  const finalScriptWitness = psbt.data.inputs[1].finalScriptWitness
    ? Buffer.from(psbt.data.inputs[1].finalScriptWitness)
    : undefined;
  // A sender can reattach hints; they must never reauthorize this input.
  psbt.addUnknownKeyValToInput(1, {
    key: Buffer.from('path'),
    value: Buffer.from(foreignPath),
  });
  psbt.updateInput(1, {
    bip32Derivation: [
      {
        pubkey: foreignKey.publicKey,
        masterFingerprint: foreignRoot.fingerprint,
        path: foreignPath,
      },
    ],
  });

  const fingerprint = Buffer.from(root.fingerprint).toString('hex');
  const devicePsbts: PsbtV2[] = [];
  const signPsbt = jest.fn(async (request: any) => {
    const prepared = actual.utils.bitcoinjs.Psbt.fromBase64(request.psbtBase64);
    prepareLedgerPsbt(
      prepared,
      account.xpub,
      0,
      activeNetwork.currency,
      1,
      fingerprint
    );
    const v2 = new PsbtV2().fromBitcoinJS(prepared);
    devicePsbts.push(v2);
    const decoded = new PsbtV2();
    decoded.deserialize(v2.serialize());
    expect(decoded.getGlobalInputCount()).toBe(2);
    expect(decoded.getInputFinalScriptsig(1)).toEqual(finalScriptSig);
    if (finalScriptWitness)
      expect(decoded.getInputFinalScriptwitness(1)).toEqual(finalScriptWitness);
    expect(
      decoded.getInputBip32Derivation(1, Buffer.from(foreignKey.publicKey))
    ).toBeUndefined();
    expect(
      decoded.getInputBip32Derivation(0, Buffer.from(ownedKey.publicKey))
    ).toBeDefined();
    const signed = unsigned.clone();
    signed.signInput(0, ownedKey);
    const signature = signed.data.inputs[0].partialSig![0];
    return {
      fingerprint,
      signatures: [
        {
          inputIndex: 0,
          pubkeyHex: Buffer.from(signature.pubkey).toString('hex'),
          signatureHex: Buffer.from(signature.signature).toString('hex'),
        },
      ],
    };
  });
  const ledger = new LedgerKeyring(undefined, {
    getStatus: () => ({ connected: true }),
    connect: jest.fn(),
    disconnect: jest.fn(),
    evm: {} as any,
    utxo: { signPsbt } as any,
  });
  const state = {
    activeNetwork,
    activeAccountId: 0,
    activeAccountType: KeyringAccountType.Ledger,
    accounts: {
      Ledger: { 0: account },
      HDAccount: {},
      Imported: {},
      Trezor: {},
    },
  };
  const getSigner = jest.fn();
  const tx = new SyscoinTransactions(
    getSigner,
    jest.fn(),
    () => state as any,
    jest.fn(),
    ledger,
    {} as any
  );
  return {
    tx,
    psbt,
    unsigned,
    ownedKey,
    foreignKey,
    finalScriptSig,
    finalScriptWitness,
    signPsbt,
    devicePsbts,
    getSigner,
  };
};

describe('Ledger finalized external inputs with real PSBT data', () => {
  it.each(['p2wpkh', 'p2sh-p2wpkh'])(
    'signs with finalized external %s witness data when the backend is unavailable',
    async (scriptType) => {
      const test = fixture(scriptType);
      removeNonWitnessUtxo(test.psbt, 1);
      const getRawTransaction = jest
        .fn()
        .mockRejectedValue(new Error('Blockbook unavailable'));
      jest
        .spyOn(test.tx, 'txUtilsFunctions')
        .mockReturnValue({ getRawTransaction });

      const signed = PsbtUtils.fromPali(
        await test.tx.signPSBT({ psbt: PsbtUtils.toPali(test.psbt) }),
        activeNetwork
      );

      expect(getRawTransaction).not.toHaveBeenCalled();
      expect(test.signPsbt).toHaveBeenCalledTimes(1);
      const devicePsbt = test.devicePsbts[0];
      expect(devicePsbt.getInputNonWitnessUtxo(1)).toBeUndefined();
      expect(devicePsbt.getInputWitnessUtxo(1)).toEqual({
        amount: 100000,
        scriptPubKey: Buffer.from(test.psbt.data.inputs[1].witnessUtxo!.script),
      });
      expect(signed.data.inputs[0].finalScriptWitness).toBeDefined();
      expect(
        signed.data.inputs[1].finalScriptSig
          ? Buffer.from(signed.data.inputs[1].finalScriptSig)
          : undefined
      ).toEqual(test.finalScriptSig);
      expect(Buffer.from(signed.data.inputs[1].finalScriptWitness!)).toEqual(
        test.finalScriptWitness
      );
      expect(signed.data.inputs[1].partialSig).toBeUndefined();
      expect(signed.extractTransaction().ins).toHaveLength(2);
    }
  );

  it('still fetches a missing previous transaction for an unfinished input', async () => {
    const test = fixture();
    removeNonWitnessUtxo(test.psbt, 0);
    const getRawTransaction = jest
      .fn()
      .mockRejectedValue(new Error('Blockbook unavailable'));
    jest
      .spyOn(test.tx, 'txUtilsFunctions')
      .mockReturnValue({ getRawTransaction });
    await expect(
      test.tx.signPSBT({ psbt: PsbtUtils.toPali(test.psbt) })
    ).rejects.toThrow('Failed to enrich 1 of 2 inputs with nonWitnessUtxo');
    expect(getRawTransaction).toHaveBeenCalledTimes(1);
    expect(getRawTransaction).toHaveBeenCalledWith(
      activeNetwork.url,
      Buffer.from(test.psbt.txInputs[0].hash).reverse().toString('hex')
    );
    expect(test.signPsbt).not.toHaveBeenCalled();
  });

  it('still requires previous-output data for a finalized legacy input', async () => {
    const test = fixture('p2pkh');
    removeNonWitnessUtxo(test.psbt, 1);
    delete test.psbt.data.inputs[1].witnessUtxo;
    const getRawTransaction = jest
      .fn()
      .mockRejectedValue(new Error('Blockbook unavailable'));
    jest
      .spyOn(test.tx, 'txUtilsFunctions')
      .mockReturnValue({ getRawTransaction });
    await expect(
      test.tx.signPSBT({ psbt: PsbtUtils.toPali(test.psbt) })
    ).rejects.toThrow('Failed to enrich 1 of 2 inputs with nonWitnessUtxo');
    expect(getRawTransaction).toHaveBeenCalledTimes(1);
    expect(getRawTransaction).toHaveBeenCalledWith(
      activeNetwork.url,
      Buffer.from(test.psbt.txInputs[1].hash).reverse().toString('hex')
    );
    expect(test.signPsbt).not.toHaveBeenCalled();
  });

  it.each(['p2wpkh', 'p2pkh', 'p2sh-p2wpkh'])(
    'preserves finalized %s scripts through device serialization and signing',
    async (scriptType) => {
      const test = fixture(scriptType);
      const signed = PsbtUtils.fromPali(
        await test.tx.signPSBT({ psbt: PsbtUtils.toPali(test.psbt) }),
        activeNetwork
      );
      expect(test.signPsbt).toHaveBeenCalledTimes(1);
      expect(test.getSigner).not.toHaveBeenCalled();
      expect(signed.data.inputs[0].finalScriptWitness).toBeDefined();
      expect(
        signed.data.inputs[1].finalScriptSig
          ? Buffer.from(signed.data.inputs[1].finalScriptSig)
          : undefined
      ).toEqual(test.finalScriptSig);
      expect(
        signed.data.inputs[1].finalScriptWitness
          ? Buffer.from(signed.data.inputs[1].finalScriptWitness)
          : undefined
      ).toEqual(test.finalScriptWitness);
      expect(signed.data.inputs[1].partialSig).toBeUndefined();
      expect(signed.data.inputs[1].bip32Derivation).toBeUndefined();
      expect(signed.extractTransaction().ins).toHaveLength(2);
    }
  );

  it('does not re-sign a finalized input from another account in the same wallet', async () => {
    const test = fixture('p2wpkh', true);
    const signed = PsbtUtils.fromPali(
      await test.tx.signPSBT({ psbt: PsbtUtils.toPali(test.psbt) }),
      activeNetwork
    );
    expect(Buffer.from(signed.data.inputs[1].finalScriptWitness!)).toEqual(
      test.finalScriptWitness
    );
    expect(signed.data.inputs[1].partialSig).toBeUndefined();
    expect(test.signPsbt).toHaveBeenCalledTimes(1);
  });

  it('rejects a device response that tries to sign the finalized foreign input', async () => {
    const test = fixture();
    const signed = test.unsigned.clone();
    signed.signInput(1, test.foreignKey);
    test.signPsbt.mockImplementationOnce(async () => ({
      fingerprint: '12345678',
      signatures: [
        {
          inputIndex: 1,
          pubkeyHex: Buffer.from(
            signed.data.inputs[1].partialSig![0].pubkey
          ).toString('hex'),
          signatureHex: Buffer.from(
            signed.data.inputs[1].partialSig![0].signature
          ).toString('hex'),
        },
      ],
    }));
    await expect(
      test.tx.signPSBT({ psbt: PsbtUtils.toPali(test.psbt) })
    ).rejects.toThrow('PSBT input is outside the approved account');
  });

  it('keeps unfinished foreign inputs outside the supported hardware path', async () => {
    const test = fixture();
    await expect(
      test.tx.signPSBT({ psbt: PsbtUtils.toPali(test.unsigned) })
    ).rejects.toThrow('Missing bip32Derivation');
    // The scoped parser strips unsupported foreign hints. The host preparation
    // still refuses that unfinished input before producing any signature.
    expect(test.signPsbt).toHaveBeenCalledTimes(1);
  });
});

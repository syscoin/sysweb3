import { getNetworkConfig } from '@sidhujag/sysweb3-network';
import { payments, Psbt } from 'bitcoinjs-lib';

import { PsbtV2 } from '../../../src/ledger/bitcoin_client';
import { prepareLedgerPsbt } from '../../../src/ledger/prepare-psbt';

test.each(['proprietary-path', 'existing-derivation'])(
  'does not forward %s output hints into the Ledger device output map',
  (hint) => {
    const syscoinjs = jest.requireActual('syscoinjs-lib');
    const config = getNetworkConfig(1, 'tSYS');
    const hd = new syscoinjs.utils.HDSigner(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      null,
      true,
      config.networks,
      1,
      config.types.zPubType,
      84
    );
    hd.createAccountAtIndex(0, 84);
    const root = hd.getRootNode();
    const child = root.derivePath("m/84'/1'/0'/1/0");
    // Deliberately different from the account-derived key claimed by metadata.
    const recipientKey = Buffer.from(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      'hex'
    );
    const script = payments.p2wpkh({ pubkey: recipientKey }).output!;
    const plain = new Psbt({ network: config.networks.testnet });
    plain.addInput({
      hash: Buffer.alloc(32),
      index: 0,
      finalScriptSig: Buffer.from([0x51]),
    });
    plain.addOutput({ script, value: 1000n });
    const tagged = plain.clone();
    if (hint === 'proprietary-path') {
      tagged.addUnknownKeyValToOutput(0, {
        key: Buffer.from('path'),
        value: Buffer.from("m/84'/1'/0'/1/0"),
      });
    } else {
      tagged.updateOutput(0, {
        bip32Derivation: [
          {
            path: "m/84'/1'/0'/1/0",
            pubkey: child.publicKey,
            masterFingerprint: root.fingerprint,
          },
        ],
      });
    }
    prepareLedgerPsbt(
      tagged,
      hd.getAccountXpub(),
      0,
      'tSYS',
      1,
      Buffer.from(root.fingerprint).toString('hex')
    );
    expect(tagged.data.outputs[0].bip32Derivation).toHaveLength(1);
    const encoded = new PsbtV2().fromBitcoinJS(tagged);
    expect(encoded.getOutputAmount(0)).toBe(1000);
    expect(Buffer.from(encoded.getOutputScript(0))).toEqual(Buffer.from(script));
    expect(() =>
      encoded.getOutputBip32Derivation(0, Buffer.from(child.publicKey))
    ).toThrow();
    expect(encoded.serialize()).toEqual(
      new PsbtV2().fromBitcoinJS(plain).serialize()
    );
  }
);

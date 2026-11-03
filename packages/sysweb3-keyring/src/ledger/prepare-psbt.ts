import { Buffer } from 'buffer';
import type { Psbt } from 'bitcoinjs-lib';
import * as syscoinjs from 'syscoinjs-lib';

import { getAccountDerivationPath } from '../utils/derivation-paths';
import { parsePsbtAccountXpub } from '../utils/psbt-account-scope';

const Transaction = (syscoinjs.utils as any).bitcoinjs.Transaction;

/** Enrich public PSBT metadata only. Callers must also enforce account scope. */
export function prepareLedgerPsbt(
  psbt: Psbt,
  accountXpub: string,
  accountId: number,
  currency: string,
  slip44: number,
  fingerprint: string
): Psbt {
  if (!/^[0-9a-fA-F]{8}$/.test(fingerprint))
    throw new Error('Invalid Ledger master fingerprint');
  const accountNode = parsePsbtAccountXpub(accountXpub);

  // Enhance each input with bip32Derivation
  const missingInputDerivations: number[] = [];
  for (let i = 0; i < psbt.inputCount; i++) {
    const dataInput = psbt.data.inputs[i];

    // External inputs are already authorized by their final scripts. Do
    // not invent wallet derivations or ask the device to sign them again.
    if (dataInput.finalScriptSig || dataInput.finalScriptWitness) continue;

    // Skip if already has bip32Derivation
    if (dataInput.bip32Derivation && dataInput.bip32Derivation.length > 0) {
      // Scope validation has already limited these hints to the approved account.
      for (const derivation of dataInput.bip32Derivation)
        derivation.masterFingerprint = Buffer.from(fingerprint, 'hex');
      continue;
    }

    // Ensure witnessUtxo is present if nonWitnessUtxo exists
    if (!dataInput.witnessUtxo && dataInput.nonWitnessUtxo) {
      const txBuffer = dataInput.nonWitnessUtxo;
      const tx = Transaction.fromBuffer(txBuffer);
      const vout = psbt.txInputs[i].index;

      if (tx.outs[vout]) {
        dataInput.witnessUtxo = {
          script: tx.outs[vout].script,
          value: tx.outs[vout].value,
        };
      }
    }

    // Extract path from unknownKeyVals by searching for the key, not using hardcoded index
    let pathFromInput: string | null = null;
    if (dataInput.unknownKeyVals && dataInput.unknownKeyVals.length > 0) {
      for (const kv of dataInput.unknownKeyVals) {
        const keyStr = Buffer.from(kv.key).toString();
        if (keyStr === 'path') {
          pathFromInput = Buffer.from(kv.value).toString();
          break;
        }
      }
    }
    let bip32Derivation: any = null;
    if (pathFromInput) {
      const fullPath = pathFromInput;
      const accountPath = getAccountDerivationPath(currency, slip44, accountId);
      const relativePath = fullPath.replace(accountPath, '').replace(/^\//, '');
      const derivationTokens = relativePath.split('/').filter((t) => t);

      const derivedAccount = derivationTokens.reduce(
        (acc: any, token: string) => {
          const index = parseInt(token);
          if (isNaN(index)) {
            return acc;
          }
          return acc.derive(index);
        },
        accountNode
      );

      const rawPubkey = derivedAccount.publicKey;
      const pubkeyBuf = Buffer.isBuffer(rawPubkey)
        ? rawPubkey
        : Buffer.from(rawPubkey);

      if (pubkeyBuf && pubkeyBuf.length === 33) {
        // Add the bip32Derivation that Ledger needs
        bip32Derivation = {
          masterFingerprint: Buffer.from(fingerprint, 'hex'),
          path: fullPath,
          pubkey: pubkeyBuf,
        };

        psbt.updateInput(i, {
          bip32Derivation: [bip32Derivation],
        });
      }
    }
    // Check the updated PSBT state (avoid stale local references)
    const updatedInput = psbt.data.inputs[i];
    if (
      !updatedInput.bip32Derivation ||
      updatedInput.bip32Derivation.length === 0
    ) {
      missingInputDerivations.push(i);
    }
  }

  // Enhance each output with bip32Derivation when it's a change/output owned by the wallet
  for (let i = 0; i < psbt.data.outputs.length; i++) {
    const dataOutput = psbt.data.outputs[i];

    // Skip if derivation already present
    if (dataOutput.bip32Derivation && dataOutput.bip32Derivation.length > 0) {
      continue;
    }

    // Extract path from unknownKeyVals by searching for the key 'path'
    let pathFromOutput: string | null = null;
    if (dataOutput.unknownKeyVals && dataOutput.unknownKeyVals.length > 0) {
      for (const kv of dataOutput.unknownKeyVals) {
        const keyStr = Buffer.from(kv.key).toString();
        if (keyStr === 'path') {
          pathFromOutput = Buffer.from(kv.value).toString();
          break;
        }
      }
    }
    if (pathFromOutput) {
      let bip32Derivation: any = null;
      const fullPath = pathFromOutput;
      const accountPath = getAccountDerivationPath(currency, slip44, accountId);
      const relativePath = fullPath.replace(accountPath, '').replace(/^\//, '');
      const derivationTokens = relativePath.split('/').filter((t) => t);

      const derivedAccount = derivationTokens.reduce(
        (acc: any, token: string) => {
          const index = parseInt(token);
          if (isNaN(index)) {
            return acc;
          }
          return acc.derive(index);
        },
        accountNode
      );

      const rawOutPubkey = derivedAccount.publicKey;
      const outPubkeyBuf = Buffer.isBuffer(rawOutPubkey)
        ? rawOutPubkey
        : Buffer.from(rawOutPubkey);

      if (outPubkeyBuf && outPubkeyBuf.length === 33) {
        bip32Derivation = {
          masterFingerprint: Buffer.from(fingerprint, 'hex'),
          path: fullPath,
          pubkey: outPubkeyBuf,
        };

        psbt.updateOutput(i, {
          bip32Derivation: [bip32Derivation],
        });
      }
      // Outputs without valid derivation are allowed (external recipients)
    }
  }

  // If any wallet-owned inputs/outputs are missing bip32Derivation, fail early with a clear error
  if (missingInputDerivations.length > 0) {
    const parts: string[] = [];
    parts.push(`inputs [${missingInputDerivations.join(', ')}]`);
    throw new Error(
      `convertToLedgerFormat: Missing bip32Derivation for ${parts.join(
        ' and '
      )}. Ensure PSBT includes a 'path' unknownKeyVal or BIP32_DERIVATION for wallet-owned entries.`
    );
  }

  return psbt;
}

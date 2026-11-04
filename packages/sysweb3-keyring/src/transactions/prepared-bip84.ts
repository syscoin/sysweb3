import ecc from '@bitcoinerlab/secp256k1';
import { BIP32Interface } from 'bip32';
import { payments, script, Transaction } from 'bitcoinjs-lib';

import { parseBip84PublicAccount } from '../public-bip84';
import {
  bip84Profile,
  Bip84NativeError,
  fail,
  index,
  LIMITS,
  PreparedBip84NativeTransaction,
  record,
  validateBip84NativePlan,
  ValidatedBip84Plan,
} from './bip84-native-plan';

export type PreparedBip84SigningRequest = Readonly<{
  account: Readonly<{
    type: 'HDAccount';
    index: number;
    expectedAccountKey: string;
  }>;
  prepared: PreparedBip84NativeTransaction;
}>;
export type SignedBip84NativeTransaction = Readonly<{
  rawTransaction: string;
  txid: string;
  wtxid: string;
  unsignedTransaction: string;
  feeSatoshis: string;
  virtualSize: number;
}>;

/** Private host snapshot. A public prepared DTO never carries signing authority. */
export function snapshotPreparedBip84Request(input: unknown): {
  account: PreparedBip84SigningRequest['account'];
  validated: ValidatedBip84Plan;
} {
  const r = record(input, ['account', 'prepared']);
  const a = record(r.account, ['type', 'index', 'expectedAccountKey']);
  const p = record(r.prepared, ['plan', 'unsignedTransaction', 'feeSatoshis']);
  if (a.type !== 'HDAccount') return fail('ACCOUNT_MISMATCH');
  const accountIndex = index(a.index);
  if (
    typeof a.expectedAccountKey !== 'string' ||
    a.expectedAccountKey.length > 112 ||
    typeof p.unsignedTransaction !== 'string' ||
    p.unsignedTransaction.length > LIMITS.unsignedBytes * 2 ||
    !/^(?:[0-9a-f]{2})+$/.test(p.unsignedTransaction) ||
    typeof p.feeSatoshis !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(p.feeSatoshis)
  )
    return fail('INVALID_REQUEST');
  const validated = validateBip84NativePlan(p.plan);
  if (
    accountIndex !== validated.prepared.plan.account.accountIndex ||
    a.expectedAccountKey !== validated.prepared.plan.account.canonicalKey
  )
    return fail('ACCOUNT_MISMATCH');
  if (
    p.unsignedTransaction !== validated.prepared.unsignedTransaction ||
    p.feeSatoshis !== validated.prepared.feeSatoshis
  )
    return fail('INVALID_REQUEST');
  return {
    account: Object.freeze({
      type: 'HDAccount',
      index: accountIndex,
      expectedAccountKey: a.expectedAccountKey,
    }),
    validated,
  };
}

/** Only operation-owned nodes. No session/shared key objects may be supplied. */
export function clearBip84PrivateNodes(nodes: BIP32Interface[]): void {
  while (nodes.length) {
    const node = nodes.pop()!;
    try {
      node.privateKey?.fill(0);
    } catch {
      // Continue retiring the other owned buffers and the operation token.
      // JS/library copies and inaccessible buffers are not claimed zeroized.
    }
  }
}

const equal = (left: Uint8Array, right: Uint8Array): boolean =>
  Buffer.from(left).equals(Buffer.from(right));

/** Internally owned PSBT only. No provider, generic SDK signer or partial result. */
export function signValidatedBip84Plan(
  validated: ValidatedBip84Plan,
  accountNode: BIP32Interface,
  assertCurrent: () => void
): SignedBip84NativeTransaction {
  const nodes: BIP32Interface[] = [];
  try {
    const { prepared, psbt, previousOutputs } = validated;
    const { plan } = prepared;
    const profile = bip84Profile(plan.network.network);
    assertCurrent();
    const derivedAccount = parseBip84PublicAccount({
      network: plan.network.network,
      accountKey: accountNode.neutered().toBase58(),
    });
    if (
      derivedAccount.canonicalKey !== plan.account.canonicalKey ||
      derivedAccount.accountIndex !== plan.account.accountIndex
    )
      return fail('ACCOUNT_MISMATCH');
    const branches = new Map<number, BIP32Interface>();
    const children = new Map<string, BIP32Interface>();
    const publicKeys: Uint8Array[] = [];
    for (const [i, input] of plan.inputs.entries()) {
      assertCurrent();
      let branch = branches.get(input.branch);
      if (!branch) {
        branch = accountNode.derive(input.branch);
        nodes.push(branch);
        if (branch.index !== input.branch) return fail('ACCOUNT_MISMATCH');
        branches.set(input.branch, branch);
      }
      const path = `${input.branch}/${input.index}`;
      let child = children.get(path);
      if (!child) {
        child = branch.derive(input.index);
        nodes.push(child);
        if (child.index !== input.index) return fail('ACCOUNT_MISMATCH');
        children.set(path, child);
      }
      const pubkey = Uint8Array.from(child.publicKey);
      const payment = payments.p2wpkh({
        pubkey,
        network: profile.addressNetwork,
      });
      if (
        pubkey.length !== 33 ||
        !payment.output ||
        !equal(payment.output, previousOutputs[i].script)
      )
        return fail('INPUT_MISMATCH');
      publicKeys.push(pubkey);
      const signer = child;
      assertCurrent();
      psbt.signInput(
        i,
        {
          publicKey: pubkey,
          sign(hash: Uint8Array) {
            assertCurrent();
            const signature = signer.sign(hash);
            assertCurrent();
            return signature;
          },
        },
        [Transaction.SIGHASH_ALL]
      );
      assertCurrent();
      const partial = psbt.data.inputs[i].partialSig;
      if (
        !partial ||
        partial.length !== 1 ||
        !equal(partial[0].pubkey, pubkey) ||
        script.signature.decode(partial[0].signature).hashType !==
          Transaction.SIGHASH_ALL ||
        psbt.validateSignaturesOfInput(
          i,
          (key, hash, signature) =>
            equal(key, pubkey) && ecc.verify(hash, key, signature, true),
          pubkey
        ) !== true
      )
        return fail('SIGNATURE_INVALID');
    }
    // Verify change from the private-derived account as well as the public plan.
    if (plan.change) {
      assertCurrent();
      const branch = accountNode.neutered().derive(1);
      if (branch.index !== 1) return fail('ACCOUNT_MISMATCH');
      const child = branch.derive(plan.change.index);
      if (child.index !== plan.change.index) return fail('ACCOUNT_MISMATCH');
      const payment = payments.p2wpkh({
        pubkey: child.publicKey,
        network: profile.addressNetwork,
      });
      if (!payment.output || !equal(payment.output, psbt.txOutputs[1].script))
        return fail('INPUT_MISMATCH');
    }
    if (psbt.toBuffer().length > LIMITS.psbtBytes)
      return fail('LIMIT_EXCEEDED');
    assertCurrent();
    for (let i = 0; i < plan.inputs.length; i++) {
      psbt.finalizeInput(i);
      const input = psbt.data.inputs[i];
      if (
        !(input.finalScriptWitness instanceof Uint8Array) ||
        input.finalScriptWitness.length === 0 ||
        (input.finalScriptSig !== undefined && input.finalScriptSig.length > 0)
      )
        return fail('SIGNATURE_INVALID');
    }
    if (psbt.toBuffer().length > LIMITS.psbtBytes)
      return fail('LIMIT_EXCEEDED');
    assertCurrent();
    // SJS overrides fee/extraction helpers. Their success is not our fee proof.
    const bytes = psbt.extractTransaction().toBuffer();
    if (bytes.length > LIMITS.signedBytes) return fail('LIMIT_EXCEEDED');
    const transaction = Transaction.fromBuffer(bytes);
    if (
      !equal(transaction.toBuffer(), bytes) ||
      transaction.ins.length !== plan.inputs.length
    )
      return fail('SIGNATURE_INVALID');
    for (const [i, input] of transaction.ins.entries()) {
      assertCurrent();
      if (
        input.script.length !== 0 ||
        input.witness.length !== 2 ||
        !equal(input.witness[1], publicKeys[i])
      )
        return fail('SIGNATURE_INVALID');
      const signature = script.signature.decode(input.witness[0]);
      const scriptCode = payments.p2pkh({ pubkey: publicKeys[i] }).output;
      if (
        signature.hashType !== Transaction.SIGHASH_ALL ||
        !scriptCode ||
        !equal(
          script.signature.encode(signature.signature, signature.hashType),
          input.witness[0]
        ) ||
        !ecc.verify(
          transaction.hashForWitnessV0(
            i,
            scriptCode,
            previousOutputs[i].value,
            Transaction.SIGHASH_ALL
          ),
          publicKeys[i],
          signature.signature,
          true
        )
      )
        return fail('SIGNATURE_INVALID');
    }
    const unsigned = transaction.clone();
    unsigned.stripWitnesses();
    if (unsigned.toHex() !== prepared.unsignedTransaction)
      return fail('SIGNATURE_INVALID');
    const fee =
      previousOutputs.reduce((sum, output) => sum + output.value, 0n) -
      transaction.outs.reduce((sum, output) => sum + output.value, 0n);
    const virtualSize = transaction.virtualSize();
    if (
      fee < 0n ||
      fee.toString() !== prepared.feeSatoshis ||
      fee > LIMITS.maxFee ||
      fee > BigInt(plan.feeLimits.maxFeeSatoshis) ||
      !Number.isSafeInteger(virtualSize) ||
      virtualSize <= 0 ||
      fee > BigInt(virtualSize) * LIMITS.maxFeeRate ||
      fee > BigInt(virtualSize) * BigInt(plan.feeLimits.maxFeeRateSatPerVByte)
    )
      return fail('FEE_LIMIT');
    assertCurrent();
    return Object.freeze({
      rawTransaction: transaction.toHex(),
      txid: transaction.getId(),
      wtxid: Buffer.from(transaction.getHash(true)).reverse().toString('hex'),
      unsignedTransaction: prepared.unsignedTransaction,
      feeSatoshis: fee.toString(),
      virtualSize,
    });
  } catch (error) {
    if (error instanceof Bip84NativeError) throw error;
    return fail('SIGNATURE_INVALID');
  } finally {
    clearBip84PrivateNodes(nodes);
  }
}

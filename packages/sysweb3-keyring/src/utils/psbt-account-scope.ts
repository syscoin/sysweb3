import * as ecc from '@bitcoinerlab/secp256k1';
import { getNetworkConfig, INetwork } from '@sidhujag/sysweb3-network';
import { BIP32Factory } from 'bip32';
import { address, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib';

import { KeyringAccountType } from '../types';
import { getAccountDerivationPath } from './derivation-paths';

const bip32 = BIP32Factory(ecc);
const SCOPE_ERROR = 'PSBT input is outside the approved account';
const fail = (): never => {
  throw new Error(SCOPE_ERROR);
};
const clearSigningHints = (input: Psbt['data']['inputs'][number]) => {
  delete input.bip32Derivation;
  delete input.tapBip32Derivation;
  input.unknownKeyVals = (input.unknownKeyVals || []).filter(
    (field) => Buffer.from(field.key).toString() !== 'path'
  );
};
const equal = (a?: Uint8Array, b?: Uint8Array) =>
  Boolean(a && b && Buffer.from(a).equals(Buffer.from(b)));
const childIndex = (value: string): number => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return fail();
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index >= 0x80000000) return fail();
  return index;
};
export const parsePsbtAccountXpub = (xpub: string) => {
  // Account keys use coin-specific xpub/zpub/vpub version bytes. Preserve the
  // checked public payload instead of guessing its network from that prefix.
  const codec = require('bs58check');
  const payload = Buffer.from((codec.default || codec).decode(xpub));
  if (payload.length !== 78 || (payload[45] !== 2 && payload[45] !== 3))
    return fail();
  return bip32.fromBase58(xpub, {
    ...networks.bitcoin,
    bip32: { public: payload.readUInt32BE(0), private: 0x0488ade4 },
  });
};

export type PsbtAccountScope = {
  account: { address: string; xpub: string };
  accountId: number;
  accountType: KeyringAccountType;
  network: INetwork;
};

export function createPsbtDerivationGuard(
  scope: PsbtAccountScope
): (path: string) => string {
  const { account, accountId, accountType, network } = scope;
  const node = parsePsbtAccountXpub(account.xpub);
  const prefix =
    accountType === KeyringAccountType.HDAccount
      ? `m/84'/${network.slip44}'/${accountId}'`
      : getAccountDerivationPath(
          network.currency,
          network.slip44,
          accountType === KeyringAccountType.Imported && node.depth === 3
            ? node.index & 0x7fffffff
            : accountId
        );
  return (path) => {
    let relative = path;
    if (relative.startsWith(`${prefix}/`))
      relative = relative.slice(prefix.length + 1);
    else if (
      relative.startsWith('m/') ||
      accountType !== KeyringAccountType.Imported
    )
      return fail();
    const parts = relative.split('/');
    if (parts.length !== 2) return fail();
    if (![0, 1].includes(childIndex(parts[0]))) return fail();
    childIndex(parts[1]);
    return relative;
  };
}

/** Verify key ownership from public derivation and the actual spent script.
 * Proprietary address metadata is deliberately never an authority here.
 */
export function assertPsbtAccountScope(
  psbt: Psbt,
  scope: PsbtAccountScope
): void {
  const { account, accountType, network } = scope;
  const config = getNetworkConfig(network.slip44, network.currency);
  const bitcoinNetwork =
    network.slip44 === 1 ? config.networks.testnet : config.networks.mainnet;
  const singleAddress =
    accountType === KeyringAccountType.Imported &&
    account.xpub === account.address;
  const node = singleAddress ? undefined : parsePsbtAccountXpub(account.xpub);
  const guardPath = singleAddress
    ? undefined
    : createPsbtDerivationGuard(scope);
  if (!singleAddress && !node?.isNeutered()) return fail();
  if (!Array.isArray(psbt.data?.inputs) || psbt.data.inputs.length === 0)
    return fail();
  const derivedKeys = new Map<
    string,
    { publicKey: Uint8Array; scripts: Array<Uint8Array | undefined> }
  >();

  let ownedInputs = 0;
  let hasUnfinishedInputs = false;
  psbt.data.inputs.forEach((input, inputIndex) => {
    // Finalized co-signer inputs may remain in a PSBT. Remove signing hints so
    // even a permissive underlying signer cannot add another signature there.
    if (input.finalScriptSig || input.finalScriptWitness) {
      clearSigningHints(input);
      return;
    }
    hasUnfinishedInputs = true;
    const txInput = psbt.txInputs[inputIndex];
    let spent = input.witnessUtxo;
    if (input.nonWitnessUtxo) {
      const previous = Transaction.fromBuffer(input.nonWitnessUtxo);
      if (!equal(previous.getHash(), txInput.hash)) return fail();
      const output = previous.outs[txInput.index];
      if (
        !output ||
        (spent &&
          (!equal(output.script, spent.script) || output.value !== spent.value))
      )
        return fail();
      spent = output;
    }
    if (!spent) return fail();
    try {
      let multisigKeys: Uint8Array[] | undefined;
      const multisigScript = input.witnessScript || input.redeemScript;
      if (multisigScript) {
        try {
          // Only standard multisig is supported here. The scripts, not the
          // cosigners' supplied derivation metadata, authenticate membership.
          const multisig = payments.p2ms({
            output: multisigScript,
            network: bitcoinNetwork,
          });
          if (!multisig.pubkeys?.length) return fail();
          if (input.witnessScript) {
            const witness = payments.p2wsh({
              redeem: multisig,
              network: bitcoinNetwork,
            });
            if (
              input.redeemScript &&
              !equal(input.redeemScript, witness.output)
            )
              return fail();
            const output = input.redeemScript
              ? payments.p2sh({ redeem: witness, network: bitcoinNetwork })
                  .output
              : witness.output;
            if (!equal(output, spent.script)) return fail();
          } else if (
            !equal(
              payments.p2sh({ redeem: multisig, network: bitcoinNetwork })
                .output,
              spent.script
            )
          ) {
            // Nested single-key P2WPKH is validated below, not as multisig.
            return fail();
          }
          multisigKeys = multisig.pubkeys;
        } catch {
          // A wrapped single-key input has a redeemScript but no multisig.
          // Its normal derived-key output check below still authenticates it.
          if (input.witnessScript) return fail();
        }
      }
      if (singleAddress) {
        const approvedScript = address.toOutputScript(
          account.address,
          bitcoinNetwork
        );
        if (multisigKeys) {
          const ownsKey = multisigKeys.some((pubkey) => {
            const witness = payments.p2wpkh({
              pubkey,
              network: bitcoinNetwork,
            });
            return [
              payments.p2pkh({ pubkey, network: bitcoinNetwork }).output,
              witness.output,
              payments.p2sh({ redeem: witness, network: bitcoinNetwork })
                .output,
            ].some((output) => equal(output, approvedScript));
          });
          if (!ownsKey) return fail();
          delete input.bip32Derivation;
          delete input.tapBip32Derivation;
          input.unknownKeyVals = (input.unknownKeyVals || []).filter(
            (field) => Buffer.from(field.key).toString() !== 'path'
          );
        } else if (!equal(spent.script, approvedScript)) return fail();
        ownedInputs += 1;
        return;
      }

      const derivations = [
        ...(input.bip32Derivation || []),
        ...(input.tapBip32Derivation || []),
      ];
      const paths: Array<{
        path: string;
        pubkey?: Uint8Array;
        source: object;
      }> = derivations.map((derivation) => ({
        path: derivation.path,
        pubkey: derivation.pubkey,
        source: derivation,
      }));
      for (const field of input.unknownKeyVals || []) {
        if (Buffer.from(field.key).toString() === 'path')
          paths.push({
            path: Buffer.from(field.value).toString(),
            pubkey: undefined,
            source: field,
          });
      }
      if (!paths.length) return fail();
      const approvedHints = new Set<object>();
      for (const candidate of paths) {
        let relative: string;
        try {
          relative = guardPath!(candidate.path);
        } catch (error) {
          if (multisigKeys) continue;
          throw error;
        }
        const parts = relative.split('/');
        if (parts.length !== 2) return fail();
        const branch = childIndex(parts[0]);
        const index = childIndex(parts[1]);
        if (branch !== 0 && branch !== 1) return fail();
        let derived = derivedKeys.get(relative);
        if (!derived) {
          const publicKey = node!.derive(branch).derive(index).publicKey;
          const p2pkh = payments.p2pkh({
            pubkey: publicKey,
            network: bitcoinNetwork,
          });
          const p2wpkh = payments.p2wpkh({
            pubkey: publicKey,
            network: bitcoinNetwork,
          });
          const p2sh = payments.p2sh({
            redeem: p2wpkh,
            network: bitcoinNetwork,
          });
          derived = {
            publicKey,
            scripts: [p2pkh.output, p2wpkh.output, p2sh.output],
          };
          derivedKeys.set(relative, derived);
        }
        const { publicKey } = derived;
        if (
          candidate.pubkey &&
          !equal(candidate.pubkey, publicKey) &&
          !equal(candidate.pubkey, publicKey.slice(1))
        ) {
          if (multisigKeys) continue;
          return fail();
        }
        if (multisigKeys) {
          if (!multisigKeys.some((key) => equal(key, publicKey))) continue;
          approvedHints.add(candidate.source);
          continue;
        }
        const ordinary = derived.scripts.some((script) =>
          equal(script, spent!.script)
        );
        let taproot = false;
        // Key-path signing can reconstruct an omitted internal key from this
        // approved derivation. Commit any supplied Merkle root when checking
        // the output, but do not infer script-path keys or accept a conflicting
        // explicit internal key.
        if (
          input.tapInternalKey === undefined
            ? !ordinary &&
              !input.tapLeafScript?.length &&
              !input.tapScriptSig?.length &&
              !input.tapBip32Derivation?.some(
                (derivation) => derivation.leafHashes.length > 0
              )
            : equal(input.tapInternalKey, publicKey.slice(1))
        ) {
          const p2tr = payments.p2tr({
            internalPubkey: publicKey.slice(1),
            hash: input.tapMerkleRoot,
            network: bitcoinNetwork,
          });
          taproot = equal(p2tr.output, spent.script);
        }
        if (!ordinary && !taproot) return fail();
      }
      if (multisigKeys) {
        if (!approvedHints.size) return fail();
        // Keep cosigner signatures, but expose only the approved account's paths
        // to the underlying signer, including its full-root HD fallback.
        if (input.bip32Derivation)
          input.bip32Derivation = input.bip32Derivation.filter((value) =>
            approvedHints.has(value)
          );
        if (input.tapBip32Derivation)
          input.tapBip32Derivation = input.tapBip32Derivation.filter((value) =>
            approvedHints.has(value)
          );
        if (input.unknownKeyVals)
          input.unknownKeyVals = input.unknownKeyVals.filter(
            (field) =>
              Buffer.from(field.key).toString() !== 'path' ||
              approvedHints.has(field)
          );
      }
      ownedInputs += 1;
    } catch (error) {
      if (
        singleAddress ||
        !(error instanceof Error) ||
        error.message !== SCOPE_ERROR
      )
        throw error;
      // A joint PSBT may include inputs for another signer. Hide every HD
      // hint before our private signer runs; even another account in this
      // wallet must remain unsigned. The public API restores metadata later.
      clearSigningHints(input);
    }
  });
  if (hasUnfinishedInputs && ownedInputs === 0) return fail();
  // An imported extended key is already the account node, so the signer must
  // receive only the validated relative children, never another full root path.
  if (accountType === KeyringAccountType.Imported && !singleAddress) {
    for (const input of psbt.data.inputs) {
      for (const derivation of [
        ...(input.bip32Derivation || []),
        ...(input.tapBip32Derivation || []),
      ])
        derivation.path = guardPath!(derivation.path);
      for (const field of input.unknownKeyVals || [])
        if (Buffer.from(field.key).toString() === 'path')
          field.value = Buffer.from(
            guardPath!(Buffer.from(field.value).toString())
          );
    }
  }
}

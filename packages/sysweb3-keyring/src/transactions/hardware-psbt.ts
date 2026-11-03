import { getNetworkConfig } from '@sidhujag/sysweb3-network';

import {
  createHardwareSignerUnavailableError,
  type ISyscoinHardwareSigner,
} from './syscoin-core';
import { WalletPolicy } from '../ledger/bitcoin_client/lib/policy';
import { PsbtV2 } from '../ledger/bitcoin_client/lib/psbtv2';
import { DESCRIPTOR } from '../ledger/consts';
import {
  getAccountDerivationPath,
  convertExtendedKeyVersion,
} from '../utils/derivation-paths';
import { assertPsbtAccountScope } from '../utils/psbt-account-scope';

import type { LedgerKeyring } from '../ledger';
import type { TrezorKeyring } from '../trezor';

/** Legacy device adapter. The software transaction engine never imports it. */
export function createLedgerPsbtSigner(
  ledger: LedgerKeyring
): ISyscoinHardwareSigner {
  return async ({
    psbt,
    account,
    network: activeNetwork,
    scope,
    assertCurrent,
    getRawTransaction,
  }) => {
    if (
      typeof ledger?.convertToLedgerFormat !== 'function' ||
      typeof getRawTransaction !== 'function'
    ) {
      throw createHardwareSignerUnavailableError('Ledger');
    }
    // CRITICAL: Enhance PSBT with required Ledger fields
    const accountXpub = account.xpub;
    const accountId = account.id;

    // Enrich PSBT with nonWitnessUtxo for Ledger compatibility
    const blockbookUrl = activeNetwork.url;

    // Some unit tests mock PSBTs without bitcoinjs-lib internals (data/txInputs).
    // Only attempt enrichment when the PSBT looks like a real bitcoinjs-lib Psbt.
    const psbtAny: any = psbt as any;
    const inputMetas: any[] | undefined = psbtAny?.data?.inputs;
    const txInputs: any[] | undefined = psbtAny?.txInputs;
    if (
      Array.isArray(inputMetas) &&
      Array.isArray(txInputs) &&
      txInputs.length > 0
    ) {
      // Fetch and add nonWitnessUtxo where Ledger still needs it.
      const txFetchPromises = txInputs.map(async (_txInput, index) => {
        try {
          // Keep existing previous transactions, and finalized witness
          // inputs that already carry the prevout data needed by Ledger.
          const input = inputMetas[index];
          if (
            input?.nonWitnessUtxo ||
            (input?.witnessUtxo &&
              (input.finalScriptSig || input.finalScriptWitness))
          )
            return { index, success: true };
          const tx = txInputs[index];
          const prevTxId = Buffer.from(tx.hash).reverse().toString('hex');

          // Fetch the raw transaction
          const rawTxResponse = await getRawTransaction(blockbookUrl, prevTxId);

          // Handle different response formats (string, object with 'hex', or object with 'result')
          let rawTxHex: string;
          if (typeof rawTxResponse === 'string') {
            rawTxHex = rawTxResponse;
          } else if (
            rawTxResponse &&
            typeof rawTxResponse === 'object' &&
            'hex' in rawTxResponse
          ) {
            rawTxHex = (rawTxResponse as any).hex;
          } else if (
            rawTxResponse &&
            typeof rawTxResponse === 'object' &&
            'result' in rawTxResponse
          ) {
            rawTxHex = (rawTxResponse as any).result;
          } else {
            throw new Error(
              `Unexpected response format: ${JSON.stringify(rawTxResponse)}`
            );
          }

          if (!rawTxHex || typeof rawTxHex !== 'string') {
            throw new Error(`Invalid raw transaction hex received`);
          }

          // Convert hex to Buffer and add to PSBT
          const nonWitnessUtxo = Buffer.from(rawTxHex, 'hex');
          if (nonWitnessUtxo.length === 0) {
            throw new Error('Converted buffer is empty');
          }

          psbt.updateInput(index, { nonWitnessUtxo });
          return { index, success: true };
        } catch (error) {
          console.error(`[Ledger] Failed to enrich input ${index}:`, error);
          return { index, success: false, error };
        }
      });

      // Wait for all inputs to be enriched
      const results = await Promise.all(txFetchPromises);
      const failedInputs = results.filter((r) => !r.success);

      if (failedInputs.length > 0) {
        throw new Error(
          `Failed to enrich ${failedInputs.length} of ${results.length} inputs with nonWitnessUtxo. ` +
            `Ledger devices require this data for signing.`
        );
      }
    }

    assertCurrent();
    const enhancedPsbt = await ledger.convertToLedgerFormat(
      psbt,
      accountXpub,
      accountId,
      activeNetwork.currency,
      activeNetwork.slip44
    );
    assertCurrent();
    assertPsbtAccountScope(enhancedPsbt, scope);

    // Get wallet policy for Ledger
    const fingerprint = await ledger.ledgerUtxoClient.getMasterFingerprint();

    const hdPath = getAccountDerivationPath(
      activeNetwork.currency,
      activeNetwork.slip44,
      accountId
    );

    // For policy key preimages, match what the currently-open Ledger app expects.
    // Prefer the device-reported extended pubkey for this path (silent), and only fall back
    // to converting the stored xpub/vpub/zpub if needed.
    let deviceXpub: string | null = null;
    try {
      deviceXpub = await ledger.ledgerUtxoClient.getExtendedPubkey(
        hdPath,
        false
      );
    } catch (_e) {
      // ignore; we'll fall back
    }

    if (!deviceXpub) {
      const devicePubMagicHex =
        activeNetwork.slip44 === 1 ? '043587cf' : '0488b21e';
      deviceXpub = convertExtendedKeyVersion(accountXpub, devicePubMagicHex);
    }

    const xpubWithDescriptor = `[${hdPath}]${deviceXpub}`.replace(
      'm',
      fingerprint
    );
    const walletPolicy = new WalletPolicy(
      activeNetwork.currency.toLowerCase(),
      DESCRIPTOR as any,
      [xpubWithDescriptor]
    );

    // Register lazily and retrieve HMAC for silent operations thereafter
    let hmac: Buffer | null = null;
    if (typeof (ledger as any).getOrRegisterHmac === 'function') {
      hmac = await (ledger as any).getOrRegisterHmac(walletPolicy, fingerprint);
    }

    // Convert to PsbtV2 for direct signing without intermediate base64 encode/decode
    const psbtV2 = new PsbtV2().fromBitcoinJS(enhancedPsbt);
    assertCurrent();
    assertPsbtAccountScope(enhancedPsbt, scope);
    const signatureEntries = await ledger.ledgerUtxoClient.signPsbt(
      psbtV2,
      walletPolicy,
      hmac
    );
    assertCurrent();

    signatureEntries.forEach(([inputIndex, partialSig]) => {
      const input = enhancedPsbt.data.inputs[inputIndex];
      if (
        !input ||
        input.finalScriptSig ||
        input.finalScriptWitness ||
        !input.bip32Derivation?.some((derivation) =>
          Buffer.from(derivation.pubkey).equals(Buffer.from(partialSig.pubkey))
        )
      ) {
        throw new Error('PSBT input is outside the approved account');
      }
      enhancedPsbt.updateInput(inputIndex, {
        partialSig: [partialSig],
      });
    });

    // Preserve external inputs that were finalized before device signing.
    enhancedPsbt.data.inputs.forEach((input, index) => {
      if (!input.finalScriptSig && !input.finalScriptWitness)
        enhancedPsbt.finalizeInput(index);
    });

    return enhancedPsbt;
  };
}

/** Keep Trezor conversion and signing outside the software-only import graph. */
export function createTrezorPsbtSigner(
  trezor: TrezorKeyring
): ISyscoinHardwareSigner {
  return async ({ psbt, network: activeNetwork, assertCurrent }) => {
    if (
      typeof trezor?.convertToTrezorFormat !== 'function' ||
      typeof trezor?.signUtxoTransaction !== 'function'
    ) {
      throw createHardwareSignerUnavailableError('Trezor');
    }
    // Handle Trezor signing for UTXO
    // Get network configuration for Trezor
    const networkConfig = getNetworkConfig(
      activeNetwork.slip44,
      activeNetwork.currency
    );
    const isTestnet = activeNetwork.slip44 === 1;
    const bitcoinjsNetwork = isTestnet
      ? networkConfig?.networks?.testnet
      : networkConfig?.networks?.mainnet;

    const trezorTx = trezor.convertToTrezorFormat({
      psbt,
      coin: activeNetwork.currency.toLowerCase(),
      network: bitcoinjsNetwork || undefined, // Pass network config for isScriptHash check
    });
    assertCurrent();
    const signedPsbt = await trezor.signUtxoTransaction(trezorTx, psbt);
    assertCurrent();
    return signedPsbt;
  };
}

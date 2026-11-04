# Changelog

## 2.1.0

- Add the standalone `cjs/public-bip84` entry for strict Bitcoin/Syscoin mainnet account parsing and native SegWit address derivation. It returns public data only; an account public key does not prove ancestry or ownership.
- Add `SoftwareKeyring.deriveBip84HdPublicAccount` for guarded public derivation from an unlocked software HD wallet, without selecting accounts, writing storage or discovering addresses.
- Add the standalone `cjs/bip84-native` planner for bounded native-coin P2WPKH transactions with explicit parent data, change, RBF and exact fee limits. Asset, special and coinbase parents are excluded.
- Add `SoftwareKeyring.signPreparedBip84Transaction` for the selected Bitcoin/Syscoin mainnet HD account. It binds the account, network and synchronous host guard, verifies the rebuilt transaction and signatures, and returns immutable signed bytes, identifiers and exact fee/size data.
- These offline APIs do not unlock, access a provider, persist records or broadcast. Hosts still own input eligibility, fresh approval, change reservations and durable journaling before broadcast. Existing vault, EVM, generic PSBT and hardware APIs remain unchanged; native and live qualification remain separate.

## 2.0.0

- Add `SoftwareKeyring.deriveEvmHdRuntimeAccount` for host-allocated Ethereum BIP44 indices. It returns the existing password-encrypted runtime account record without installing an account, writing storage or querying a network. The method binds session, selection and network identity and requires a synchronous host guard. Hosts must strip encrypted `xprv` before producing public metadata.

- Add `SoftwareKeyring.signPreparedEvmTransaction` for offline signing of fully specified legacy/EIP-1559 envelopes. The request binds the selected software account and exact network/endpoint, requires synchronous host admission, validates all signed fields and recovered identity, and returns immutable signed bytes plus their local hash. It never estimates fees, resolves names, fills fields or broadcasts; hosts must durably retain the result before submission and reconcile uncertain broadcasts by hash.

- Breaking: Ledger signing requires an explicitly injected semantic `LedgerHost`. Raw LedgerJS transports/clients are removed; use the isolated browser ESM host entry for device access.
- Adopt current Device Management Kit and Ethereum signer packages while preserving the custom Syscoin/Bitcoin protocol. Serialize device operations and reject stale, wrong-account, malformed and mismatched-sighash responses.
- Disable remote Ledger metadata/transaction checks/telemetry by default. Require fresh per-intent consent for transaction/typed-data signing that may fall back to blind signing.
- Bind receive addresses to public account derivation, preserve on-device approval for unusual paths, and snapshot queued UTXO requests before connection awaits.
- Existing software-only entry, vault formats and account derivation remain compatible. Host/device and native-runtime qualification are separate requirements.

- Remove the legacy Trezor UTXO library. Reuse Bitcoinjs address decoding with a checksum-verified two-byte-version compatibility path, and encode witness vectors with the public CompactSize codec.

- Move Trezor hardware integration to Connect 10.0.1 and remove the redundant direct Connect Web dependency.
- Load the browser transport only inside a supported MV3 extension. Preserve CommonJS/ESM and software-entry imports without browser globals or device initialization.
- Preserve the existing SDK failure payload while retaining Connect error codes; stop retrying cancellations, disconnects and unsupported hosts/coins.
- Replace removed Connect device events with status updates from request outcomes and disposal. Immediate physical unplug notifications are no longer exposed by upstream.
- Reject pending calls locally on lock/disposal and discard late responses. Defer remote cleanup while requests are outstanding; return `HARDWARE_SIGNER_BUSY` until they settle rather than opening another approval prompt.
- Normalize Trezor hexadecimal recovery values without mutating signed responses; preserve approved transaction and session checks.
- Physical device qualification and consuming-extension Suite Web permissions remain release gates.

## 1.0.628

- Add the `cjs/software` entry with explicit asynchronous host storage and an opaque wallet-authority handle. Software keyrings do not load browser hardware transports or global storage.
- Keep the legacy `KeyringManager` entry and normal device defaults. The software entry rejects unavailable hardware, storage rebinding, direct session injection and cross-authority session transfer.
- Expose reusable vault persistence and software transaction cores with typed deep imports. Preserve vault encryption formats, KDF profiles, private-record domains and account derivation.
- Move Pali's existing cancellation fee-consent safeguards into source: optional unsigned preview and selected payer, required approved fee ceiling for sending, and final populated-envelope validation.
- Preserve the original value of a MAX-send replacement; return `REPLACEMENT_VALUE_WOULD_CHANGE` if the higher fee cannot be funded without reducing it.
- Add an optional synchronous final validator to local transaction sending. Promise/thenable decisions are rejected before signing; the existing five-argument call remains supported.
- Exclude compiled test fixtures from the published package; runtime code and declarations are unchanged.

### Cancellation callers

A cancellation send now requires `approvedMaximumFee` (decimal wei), in addition to the existing synchronous `assertCurrentContext` and `validateOriginal` callbacks. `previewOnly: true` returns `maximumFee` without requesting credentials, device signing or broadcast. After the user deliberately reviews and approves that fee ceiling, pass the approved value when sending; a later higher fee is rejected. `targetAccount` selects the supported outer payer while the host's selected-account context remains guarded.

Pali already enforces these rules through its 1.0.627 package patch. It may remove that patch only when adopting this release and validating the actual installed package.

### Host integration limits

The software entry is a low-level SDK, not a native-wallet security boundary by itself. The host must invalidate its authorization generation immediately on lock/background, clear late unlock results, and control public-state publication. Native cryptographic/storage adapters, biometrics, device behavior and full mobile functionality still require their own implementation and qualification. See `docs/software-entry.md` and `docs/storage-core.md` in the source repository.

## 1.0.626

- Add an optional synchronous host guard to formatted EVM transaction submission. The SDK captures it once and rechecks it with the existing account, network and session guards before signing and broadcast.
- Reject asynchronous or invalid host guards before signing. Preserve acknowledged transaction results and the existing classification of ambiguous broadcast failures.

## 1.0.625

- Add session-bound encryption for application-owned private records using native HKDF-SHA256 and AES-256-GCM, without exporting the wallet root or encryption keys.
- Authenticate record domain, ID, version and profile; reject asynchronous results when the source session is locked, replaced or transferred.
- Keep storage and backups in the host application. Random records require their encrypted backups; the seed alone cannot recreate missing records.

## 1.0.622

- Bind EVM cancellation to its captured account, network, provider and available wallet-session guard. Reject context changes after RPC reads, after hardware approval, and before signing or broadcasting.
- Require a fourth `cancelSentTransaction` argument with a synchronous `assertCurrentContext` host callback. Missing or invalid context is rejected before RPC, key or device access. Hosts whose selected account differs from a temporary keyring gas-payer selection must guard their real selection and session with this callback.
- Preserve cancellation's original/fallback nonce, zero-value self-transfer, fixed 42000 gas limit and exact replacement fee arithmetic for software, Ledger and Trezor accounts. Keep an acknowledged transaction hash if context changes after submission.
- Automated tests use deterministic public fixture keys, fake RPC providers and simulated device responses. They do not establish physical-device certification or live-network transaction acceptance.

### Required cancellation caller migration

Cancellation has one guarded entry point. Callers must supply the original transaction hash, an explicit fee-mode value, the original nonce or `undefined`, and a context guard that throws synchronously if their approved account, network or wallet session changes:

```ts
await keyring.ethereumTransaction.cancelSentTransaction(
  originalHash,
  isLegacy,
  originalNonce,
  { assertCurrentContext }
);
```

The former two/three-argument cancellation call is rejected. The host guard supplements the SDK's captured keyring context; it is not a second execution path. This release changes no deployed smart-account contract, storage layout or account migration mechanism.

## 1.0.617

- Preserve valid zero-priority EIP-1559 fees and supported BigNumberish fee overrides without silently changing the transaction fee model.
- Separate actual network gas prices from fee recommendations; only use fee history for a confirmed unsupported priority-fee RPC, and retain RPC integrity checks.
- Preserve zero priority quotes in cancellation and use exact integer replacement arithmetic. Correct dist-only, no-hook release preflight.
- Fee/RPC source validation: 373 tests passed. No new wallet RPC method or fee-bound capability is introduced.

## 1.0.615

### Current hardware connection support

- Enable Trezor Connect's stable automatic Suite Desktop route and identify Pali Wallet in its permission prompt. Safe 7 requires this Suite flow; the legacy popup remains available through Connect's established fallback for older devices.
- Retain the production Connect origin and current transports. No beta Suite Web bridge, custom pairing state or dependency upgrade is introduced.
- Add compatibility tests for Nano Gen5, Flex and Stax through the installed Ledger WebHID library. The declared WebHID minimum already includes these model identifiers.

### Host integration and validation limits

For Safe 7, open the current Trezor Suite Desktop, select and unlock the intended device/wallet, then approve Pali's request in Suite. The host must permit `ws://127.0.0.1:21335/connect-ws` in `connect-src`; allow this exact local endpoint rather than a broad `ws:` or localhost wildcard. Browser local-network permission must also permit the connection. Without Suite available, stable Connect can fall back to the legacy popup, which cannot serve Safe 7.

The current Safe family is Safe 3, Safe 5 and Safe 7. Future devices require support from Trezor's SDK and Suite; this release does not certify unannounced models. Ledger coverage is for USB/WebHID, including Nano Gen5, Flex and Stax, and retains existing signing protocols. Separate device-app availability, including the Syscoin app, must be checked per device model.

Automated validation exercises the actual installed Connect bundle and Ledger WebHID/model resolution with simulated browser/device I/O. This establishes host routing and protocol compatibility, not physical device signing, firmware certification or live transaction acceptance. The replacement signing protections from 1.0.614 remain intact.

## 1.0.614

### EVM Speed Up signing

- Authenticate the original signed transaction against its requested hash, selected gas payer and configured chain before credential or device access. Support signed types 0, 1 and 2; reject unsupported envelopes and unprotected legacy originals.
- Derive type-0/type-2 fee mode from the signed envelope. Preserve type-1 access lists; `isLegacy: true` retains type 1 for software/Ledger, while false converts it to type 2 using its signed gas price as the fee baseline. Trezor type-1 preservation is rejected before prompting; conversion to type 2 remains supported.
- Preview the maximum execution gas fee without signing or broadcasting. Sending requires an explicit approved ceiling. Final construction cannot exceed it, including when a zero-fee original needs a fresh RPC estimate.
- Select a local outer gas payer with `targetAccount` for smart-account replacements without changing the active account. Capture the provider and signed body across asynchronous work; check returned hardware signatures against the selected payer.
- Add an optional local-signing context check immediately before signing. Existing `beforeBroadcast` arguments keep their position and behavior.

### Required caller migration

The old two-argument `sendTransactionWithEditedFee(hash, isLegacy)` send now throws `Replacement fee approval required`. Hosts must preview, show the maximum fee to the user, obtain approval, then send with that exact ceiling in decimal wei:

```ts
const preview = await keyring.ethereumTransaction.sendTransactionWithEditedFee(
  originalHash,
  isLegacy,
  { previewOnly: true, assertCurrentContext }
);
if (preview.error || preview.maximumFee === undefined) {
  throw new Error('Replacement preview unavailable');
}

// Host UI displays this execution gas fee in the network's native currency.
// Approval is valid only for this original transaction and captured context.
if (await requestUserApproval(preview.maximumFee)) {
  await keyring.ethereumTransaction.sendTransactionWithEditedFee(
    originalHash,
    isLegacy,
    {
      approvedMaximumFee: preview.maximumFee,
      assertCurrentContext,
    }
  );
}
```

`assertCurrentContext` is supplied by the host and must throw when the account, network, provider or unlock session changes, or the original is mined or superseded. Invalidate the quote when the approval UI closes. For smart accounts, pass the same outer payer `{ type, id }` as `targetAccount` to both calls, plus the host's `validateOriginal` and `beforeBroadcast` guards. Authentication and fee limits apply without these optional callbacks; session and UI lifecycle checks rely on the host supplying them. Do not persist signing payloads or approvals.

The ceiling is `gasLimit × gasPrice` for type 0/1, or `gasLimit × maxFeePerGas` for type 2. It covers execution gas, not separate chain-specific fee components. Existing max-send value adjustment and contract-call rejection are retained. This change applies to Speed Up; `cancelSentTransaction` and ordinary sends retain their existing contracts.

Ledger/Trezor dependencies, transports, initialization and signing wrapper APIs are unchanged. Automated tests use real signature reconstruction and protocol serialization with mocked device I/O. Physical device signing, firmware compatibility and live broadcasts remain unverified by this release candidate.

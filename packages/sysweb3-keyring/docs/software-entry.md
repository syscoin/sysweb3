# Software keyring host boundary

`@sidhujag/sysweb3-keyring/cjs/software` provides `SoftwareKeyring` and
`createSoftwareKeyringHost`. It shares the existing account derivation, encrypted
vault, private-record and transaction engines. It does not initialize Ledger,
Trezor, browser transports, global storage or the hardware-manager singleton.
The existing package root and `KeyringManager(sharedHardwareWalletManager?)`
remain the browser compatibility entry, including `createInitialized`.

## Host storage and identity

Create one opaque host with `createSoftwareKeyringHost(storage)`, then share that
same handle among the authority's EVM and per-SLIP44 UTXO keyrings. The storage
port requires asynchronous `get`, `set`, `deleteItem`, and atomic
`createManyIfAbsent`. The factory binds the vault persistence to that storage and
keeps both in a private WeakMap. A structurally similar or mixed-storage object
is rejected before any storage operation. There is no default backend or
fallback to browser storage. The software entry rejects `setStorage` even if the
backend implements the legacy `setClient` method. The host must keep its original
port bound to the same wallet; externally mutating that port is trusted host
behavior outside the SDK boundary.

A host is one wallet authority, not a global SDK setting. Different hosts have
different session identities, even if the caller supplies the same storage
object. Session transfers require the same authority identity, storage and bound
persistence objects, and reject before modifying
either session if their authority identities differ. Direct buffer injection
through the legacy `receiveSessionOwnership` method is rejected by software
instances; same-authority transfers use a private checked handoff. Trusted low-level consumers
of `KeyringCore` supply an explicit authority identity, storage, and matching
bound vault persistence; they must not share the identity between different
wallets. The legacy wrapper uses one module-scoped identity and persistence.

The in-process persistence mutex is shared by the host's keyrings. Independent
hosts or processes do not share that mutex. The backend must implement a real
atomic absent-check-and-complete-write for `createManyIfAbsent`; read-then-write
is insufficient. Restore an existing wallet with `unlock`, not initialization.
The encrypted record schemas, PBKDF2 profiles and private-record crypto remain
unchanged.

```ts
import {
  SoftwareKeyring,
  createSoftwareKeyringHost,
} from '@sidhujag/sysweb3-keyring/cjs/software';

const host = createSoftwareKeyringHost(walletStorage);
const keyring = new SoftwareKeyring(host);
keyring.setVaultStateGetter(() => currentVaultState);
// The outer authority owns authentication, lifecycle and state publication.
```

`SoftwareKeyring` has no device signers. Existing hardware account records may be
read, but signing or device-address confirmation fails with
`HARDWARE_SIGNER_UNAVAILABLE`. EVM hardware admission runs before a private-key
getter, provider access or broadcast. The UTXO engine retains its corresponding
explicit hardware-port gate. No unavailable device falls back to seed signing.

## Required outer authority

This is a low-level SDK entry, not a qualified native custody host. In particular,
the extraction preserves the existing asynchronous unlock lifecycle: a lock does
not cancel an already-running unlock operation. A native authority must retire
its authorization generation immediately when backgrounded, locked or disposed,
call `lockWallet` immediately, and reject/clear any session recreated by a late
unlock before publishing success or permitting an operation. It must not wait
for unlock completion before enforcing background lock. The outer authority
also owns approval expiry, account/network change admission, and concurrency
across keyrings. Existing signing context guards remain in the shared engine.

Native secure storage, entropy/WebCrypto/Buffer compatibility, biometric policy,
backup flows and React Native bundler/device qualification are separate work.
Do not claim this Node-verified entry establishes those properties.

## Prepared EVM signing (2.0.0)

`SoftwareKeyring.signPreparedEvmTransaction(request, { assertCurrent })` signs a
complete type-0 or type-2 transaction synchronously. It does not contact an RPC,
estimate fees, select a nonce, resolve names, fill omitted fields or broadcast.
Only an unlocked software HD/imported account is supported. Hardware,
smart-account and watch-only records reject before key use.

```ts
const signed = keyring.signPreparedEvmTransaction(
  {
    account: {
      id: 0,
      type: 'HDAccount',
      expectedAddress: reviewedAddress,
    },
    network: {
      kind: 'ethereum',
      chainId: '1',
      slip44: 60,
      url: reviewedRpcUrl,
    },
    transaction: {
      type: 2,
      from: reviewedAddress,
      to: reviewedRecipient,
      chainId: '1',
      nonce: '7',
      value: '1000000000000000',
      gasLimit: '21000',
      data: '0x',
      maxFeePerGas: '30000000000',
      maxPriorityFeePerGas: '1000000000',
    },
  },
  {
    // Host-owned check: reject expired/replaced approval, lock, account/network
    // change, or a conflicting pending submission. Must return undefined.
    assertCurrent() {
      assertReviewStillCurrent();
    },
  }
);
```

All quantities are canonical unsigned decimal strings. Nonce is limited to
`Number.MAX_SAFE_INTEGER`; gas limit to uint64; value and fee arithmetic to
uint256. Type 0 requires `gasPrice` and rejects EIP-1559 fields; type 2 requires
both maximum and priority fees and rejects `gasPrice`. Recipient and sender
must be nonzero hex addresses. Valid address casing is normalized, but invalid
mixed-case checksums reject. Calldata is even-length `0x` hex, at most 16 KiB.
Contract creation, access lists and other transaction types are unsupported.
Unknown, hidden, accessor and asynchronous field values reject.

The request is detached before host callbacks. Its account, address, chain,
SLIP44 and exact configured endpoint must match the selected keyring context.
`assertCurrent` must be synchronous and return `undefined`; returning a Promise
rejects rather than deferring consent. The shared keyring also checks its
session/account/network identity before and after signing. The decoded signed
envelope, recovered sender, unsigned digest and transaction hash are verified
against the admitted request. The returned object and canonical transaction
fields are frozen.

**Returned signed bytes are already authorized transactions.** Anyone receiving
those bytes can submit them. A later lock cannot invalidate a returned signature.
Keep them inside the host authority and do not send them to telemetry, logs,
ordinary UI state or arbitrary application callbacks.

The host owns durable submission and recovery:

1. Check balance, chain identity, fees, nonce, review expiry and explicit user
   authorization before signing; this signing API does not establish those facts.
2. Durably store the signed bytes and locally computed hash before network I/O.
   Use bounded journal fields: raw transaction, hash and a small public summary.
   Avoid duplicating the full calldata in the same record; a maximum-size result
   serialized wholesale can exceed a 64 KiB host storage-record limit.
3. Durably mark submission attempted, recheck current authority, and broadcast
   those exact bytes. If journal persistence fails, do not broadcast.
4. Verify the returned hash against `signed.hash`. On timeout, lost acknowledgement
   or restart, reconcile that local hash. An uncertain broadcast is not a failed
   transaction and must not trigger a newly signed transaction automatically.

The endpoint field binds configuration identity only. No network is contacted
by this API, so it cannot authenticate that endpoint or establish its live chain.
JS private-key strings retain the existing best-effort lifetime guarantees;
this API does not promise provable memory erasure.

## Validation

`test/unit/keyring-manager/software-entry.spec.ts` covers independent encrypted
stores, restart and lock/unlock, stable injected UTXO ports, forged handles,
cross-authority and same-authority transfers, and EVM operations with absent
device capabilities. Existing legacy initialization, vault/KDF and hardware
transaction tests exercise the compatibility wrapper.

After building, run `node test/software-entry-runtime.cjs` from the package
folder. Pass an alternate absolute path to the unpacked `cjs/software.js` as its
argument to verify packed output. This plain Node probe uses no Jest mocks or
TypeScript loader: it rejects global-DI/device module loads and any timers or fetch calls, then
exercises separate encrypted stores, software message and prepared-transaction signing, lock/unlock,
missing-device rejection and restart with browser globals absent. Test KDF
iterations are reduced by the existing test configuration; production KDF
qualification remains covered separately.


## Indexed Ethereum HD runtime accounts

`deriveEvmHdRuntimeAccount({ index }, { assertCurrent })` derives the existing
Ethereum BIP44 path for a nonhardened index between 0 and 0x7fffffff. The caller
allocates indices and persists its account catalogue; this method does neither.
It requires an unlocked software session on an Ethereum/SLIP-44 60 network and
rejects changed session, selection or network identity, including changes made
by the synchronous host guard. The selected account record may be absent during
initial hydration. No arbitrary derivation path, hardware access, RPC or storage
operation is introduced.

The result is an `EncryptedEvmHdRuntimeAccount`, matching the internal account
record returned by `createFirstAccount` and `addNewAccount`. Its `xprv` is
password-encrypted runtime signing state, not public metadata. Never send that
field to UI, a public snapshot or a public account catalogue. Store only the
explicit public identity/label fields required by the host, and regenerate the
runtime record after authentication. No plaintext private key, phrase or
password is returned. Account signing remains subject to the existing prepared
transaction context and approval checks.


## Prepared BIP84 native signing (2.1.0)

`SoftwareKeyring.signPreparedBip84Transaction(request, { assertCurrent })` returns
an asynchronous frozen result containing raw transaction bytes, display-order
`txid`/`wtxid`, the reviewed unsigned bytes, exact `feeSatoshis` and actual
`virtualSize`. Only Bitcoin/Syscoin mainnet HD native P2WPKH spends supported by
the standalone planner are admitted; asset/special/coinbase parents are excluded.

The request is `{ account: { type: 'HDAccount', index, expectedAccountKey },
prepared }`. `expectedAccountKey` is the planner's canonical account zpub.
The SDK selected account must exist and have that same type/index/public key;
public derivation of an arbitrary index does not select or authorize it. Keys
are derived once from the existing authenticated seed, not a caller PSBT or
per-account xprv. The method never unlocks, selects accounts, reads/writes
storage, calls a provider or broadcasts. It rebuilds the prepared plan, permits
only fully verified low-S SIGHASH_ALL witnesses and checks final unsigned bytes
and exact BigInt fee against actual finalized vsize. Existing generic PSBT,
EVM and hardware paths are unchanged.

The host must supply a synchronous guard returning exactly undefined, bind a
monotonic revision and fresh approval to the complete review, enforce expiry,
canonical/unspent/protected-input eligibility and change reservations, and check
again after awaiting. Account/network A-B-A must revoke the review. The shared
BIP84 operation gate rejects reentrancy. Failure never locks a replacement
runtime. Owned private buffers are cleared when possible; JavaScript strings,
SJS seed internals and cryptographic-library copies cannot be promised zeroized.
Returned signed bytes cannot be revoked; the host must journal before broadcast.
This SDK API does not establish mobile custody, relay eligibility, native or
live qualification.

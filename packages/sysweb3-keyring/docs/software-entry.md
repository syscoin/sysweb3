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
exercises separate encrypted stores, software message signing, lock/unlock,
missing-device rejection and restart with browser globals absent. Test KDF
iterations are reduced by the existing test configuration; production KDF
qualification remains covered separately.

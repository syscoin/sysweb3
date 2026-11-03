# Host-owned vault persistence

`src/storage-core.ts` exports `createVaultPersistence(storage)`, `VaultStoragePort`,
`VaultPersistence`, and `VaultAuthenticationError`. Import this module directly
from `@sidhujag/sysweb3-keyring/cjs/storage-core` (or the explicit `.js`
path) when a host must avoid the package root's hardware and process-global storage
initialization. This extraction does not make `KeyringManager` or the package
root suitable for native use; they retain their current dependencies.

Create one persistence object per wallet authority and share it across that
wallet's network keyrings. Its mutex orders its own reads and writes. Separate
objects do not share a mutex, even if they receive the same storage port. A host
must not accidentally create independent authorities that update the same
vault. Cross-process coordination is the storage backend's responsibility.

The required port methods are asynchronous:

- `get(key)` returns the logical stored value, or an absent value, and rejects on
  storage failure. Do not return an empty value when a read failed.
- `set(key, value)` resolves only after the backend reports write completion and
  rejects failures, including uncertain commit acknowledgements.
- `createManyIfAbsent(items)` conditionally commits the entire batch only when
  all supplied keys are absent. It returns exactly `true` on completion or
  `false` when an existing record prevented creation, and rejects other failures.
  This operation must be atomic across all clients of the same namespace. A
  sequential absence check plus individual writes does not satisfy the contract.
  Neither an instance mutex nor a batch write alone supplies this guarantee.

Keys are the existing logical names, `vault` and `vault-keys`; host prefixing is
outside this module. `vault` remains a JSON string containing the version 4
AES-GCM envelope. Initial `vault-keys` remains `{ salt }`. A host adapter that
serializes these logical values must deserialize them once on read, without
rewriting the record format. There is no default storage or fallback backend.
The legacy `storage.ts` wrapper still captures `sysweb3Di` storage once and
exposes its original singleton functions and the exact same authentication
error constructor.

Encryption, legacy CBC reads, KDF ownership, and record schema are unchanged.
New writes require the existing WebCrypto AES-GCM and secure-random interfaces.
The core accepts the existing derived 32-byte hex key; it does not derive or
retain a session key. Missing crypto and backend failures remain operational
errors. A failed write may have committed if its acknowledgement was lost;
callers must reconcile persistent state rather than assuming rollback.

This is a shared-code boundary, not a native custody qualification. A native
adapter still needs durable atomic storage, qualified crypto and random-source
behavior, lifecycle/session integration, and device testing before handling
real wallet secrets.

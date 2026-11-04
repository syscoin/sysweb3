# Sysweb3-keyring

A stateless, multi-chain keyring manager for Syscoin and Ethereum-based networks.

## Overview

The sysweb3-keyring provides a unified interface for managing accounts, transactions, and hardware wallets across Syscoin (UTXO) and Ethereum (EVM) networks. The KeyringManager operates statelessly, relying on external state providers (like Redux) for account and network data.

## Key Features

- **Stateless Architecture**: No internal state storage - integrates with external state management
- **Multi-Chain Support**: Handles both UTXO (Syscoin) and EVM (Ethereum) networks
- **Hardware Wallet Support**: Trezor and Ledger integration
- **Secure Session Management**: Encrypted private key handling with session transfer
- **Transaction Management**: Full transaction lifecycle support for both network types

## Vault encryption compatibility

New vaults require WebCrypto and use PBKDF2-HMAC-SHA-512 (900,000 production
iterations) with AES-256-GCM. Missing WebCrypto rejects the operation without
writing a weaker fallback vault. Restore WebCrypto availability before retrying
an unmarked legacy vault.

Historical fallback vaults used a 20,000-iteration key that also encrypted their
persisted account keys. After authenticating such a CBC vault, the keyring records
the explicit `pbkdf2-sha512-20000` compatibility profile and rewraps the vault with
AES-GCM. This preserves existing account access across restart; it is **not** a
full rekey of those account records to 900,000 iterations. The profile is written
before rewrapping, so interruption of either write remains recoverable. Arbitrary
KDF profiles or parameters are rejected.

Storage clients must return their asynchronous write/delete promises. The core
adapter preserves them so rejected writes do not silently advance vault migration.
Fresh wallet creation additionally requires conditional batch creation. Native
`chrome.storage.local` and `browser.storage.local` use a prefix-scoped Web Lock
around the absence check and awaited write, coordinating contexts in the same
extension origin and storage partition. Custom clients must provide an atomic
`createItemsIfAbsent(items)` backend operation over prefixed, JSON-serialized
values; the built-in memory client provides this operation synchronously.
There is no sequential or unlocked fallback. A backend shared across storage
partitions needs its own atomic implementation or a single owner.

### Release order for 1.0.613

Publish `@sidhujag/sysweb3-core@1.0.29` before `@sidhujag/sysweb3-keyring@1.0.613`.
The updated lock entry describes that intended dependency; its integrity is
intentionally absent until publication. Regenerate and verify the lockfile from
the published registry artifacts before a clean registry installation. Local
validation uses the built package tarballs and does not establish publication.

## Installation

```bash
npm install @sidhujag/sysweb3-keyring
# or
yarn add @sidhujag/sysweb3-keyring
```

## Usage

### Basic Setup

```javascript
import { KeyringManager } from '@sidhujag/sysweb3-keyring';

// Create a vault state getter function (e.g., from Redux store)
const vaultStateGetter = () => store.getState().vault;

// Initialize the keyring manager
const keyringManager = await KeyringManager.createInitialized(
  seedPhrase,
  password,
  vaultStateGetter
);
```

### Offline BIP84 public account derivation

The standalone public entry accepts a bare **mainnet xpub or zpub** for a depth-3
account whose child number is hardened. It derives only native SegWit P2WPKH
addresses at `/0/index` (receive) or `/1/index` (change), with a nonhardened index
from 0 through 2,147,483,647. Choose `bitcoin` or `syscoin` explicitly. Testnet
versions, private keys, descriptors, origin/path suffixes and arbitrary networks
are rejected. Requests must be plain own-data objects with exactly the documented
fields; inherited properties, getters and extra fields are rejected. Existing
generic watch-descriptor and keyring APIs are unchanged.

```typescript
import {
  parseBip84PublicAccount,
  deriveBip84PublicAddress,
} from '@sidhujag/sysweb3-keyring/cjs/public-bip84';

const account = parseBip84PublicAccount({
  network: 'syscoin',
  accountKey: exportedPublicAccountKey,
});
const receive = deriveBip84PublicAddress({
  network: account.network,
  accountKey: account.canonicalKey,
  branch: 0,
  index: 0,
});
// receive.address, receive.scriptPubKey; no keyring or provider required.
```

The canonical account identity is the tuple `(network, policy, canonicalKey)`.
`policy` is `bip84-p2wpkh`; `canonicalKey` normalizes xpub/zpub aliases to zpub.
`accountIndex` is the encoded hardened child number minus 2^31. Key serialization
and depth cannot prove the original purpose, coin type, full ancestry or ownership.
In particular, the same public key can be encoded for either supported network;
network selection changes the address encoding and identity, not the derived
witness program. Require the user to verify their source wallet's BIP84 account
and network, and compare a known receive address before using a watch account.

Calls are synchronous and stateless: one key of at most 112 Base58 characters,
one account parse and two requested child derivations per address; no range scan,
cache, fetch, storage, RNG or wallet signing. The upstream BIP32 factory runs
deterministic ECC known-vector self-tests at module initialization (including
fixed-fixture signatures); it never receives a wallet private key here. The
underlying BIP32 implementation can retry an invalid child internally; a returned index mismatch is rejected instead
of silently changing the requested path. There is no wall-clock guarantee for
pathological library retries. Successful outputs are frozen objects containing
only strings and numbers (including a frozen nested account), never a BIP32 node.
Invalid input throws `PublicBip84Error` with a constant `INVALID_INPUT`,
`INVALID_ACCOUNT` or `INVALID_DERIVATION` code and no echoed key.

An account public key reveals all nonhardened receive and change addresses and
allows their activity to be linked. It cannot spend funds on its own, but remains
privacy-sensitive. The API performs no discovery or history lookup. A consuming
wallet must obtain informed consent before sharing an account key or derived
addresses with an indexer, own explicit discovery/page/concurrency bounds, and
label partial or unavailable history honestly. This library slice does not
implement or qualify a complete mobile watch-account feature.

### Development BIP84 native-transfer foundation

`SoftwareKeyring.deriveBip84HdPublicAccount(request, { assertCurrent })` derives
an explicit HD index for a captured Bitcoin/Syscoin mainnet context and returns
only frozen public account and receive-address data. It requires an already
unlocked software host; it does not select accounts, update a catalogue, store an
xprv, discover addresses or contact a provider. The host must supply a synchronous
revision/consent guard and recheck it after awaiting the operation. Labels and
currency strings do not choose the derivation path.

The standalone `@sidhujag/sysweb3-keyring/cjs/bip84-native` entry exports
`prepareBip84NativeTransaction` and its types. It builds exact unsigned version-2
bytes from a bounded immutable plan: one P2WPKH recipient, optional verified
branch-1 change, explicit RBF, locktime zero, full previous transaction data and
integer fee limits. Parent transactions must be ordinary version 1/2 and
non-coinbase. All SYS special/asset parents are excluded even when a selected
output appears to be native change. Missing provider asset metadata is not proof
that an output is safe to spend.

The planner allows at most 64 inputs/parents, 1,000,000 bytes per parent and
2,000,000 aggregate parent bytes. Before decoding any parent, it also enforces
an aggregate budget of 8,192 decoded components: parent inputs, outputs, witness
vectors and witness items each consume one component, including empty items.
This is a wallet resource policy, not a consensus limit; large scripts remain
subject to the separate byte limits. Wallet policy additionally caps absolute fees
at 10,000,000 satoshis and fee rate at 1,000 sat/vB; callers must provide limits
no higher than those ceilings. Maximum signature size is used only to reject
fees that cannot possibly satisfy the rate ceiling; the prepared signer checks
that ceiling again using the actual finalized virtual size. Zero fee is arithmetic-valid, not a relay guarantee.
Oversized valid parents are unavailable to this initial planner; no data is
truncated or silently omitted. Returned bytes/data are public and privacy-sensitive.

This is a development foundation, **not a native UTXO sending capability**.
The unreleased `SoftwareKeyring.signPreparedBip84Transaction(request, { assertCurrent })`
signs only the selected HD account's exact prepared plan. It requires the SDK
selected type/index, requested account and seed-derived canonical public key to
agree. The mandatory synchronous host guard additionally binds fresh approval,
monotonic revision and review expiry. It rebuilds the plan, verifies complete
low-S SIGHASH_ALL signatures and exact unsigned bytes, and checks the final fee
against actual virtual size. It performs no unlock, storage, discovery or
broadcast and returns only frozen signed bytes, identifiers and fee/size data.
It does not consume or create per-account encrypted xprvs. The host still owns
canonical-chain/unspent checks, confirmed-input eligibility, protected collateral
and pending outpoint reservations, change-index persistence, fresh authentication,
review cancellation and eventual journal-before-broadcast behavior. Full parent
bytes prove an outpoint's content, not chain membership, maturity or spendability.
Existing generic PSBT, EVM and hardware APIs are unchanged. Native and live
qualification remain future work.

### Account Management

```javascript
// Get active account
const activeAccount = keyringManager.getActiveAccount();

// Create new account
const newAccount = await keyringManager.addNewAccount('My Account');

// Switch active account
await keyringManager.setActiveAccount(accountId, KeyringAccountType.HDAccount);

// Import account from private key
const importedAccount = await keyringManager.importAccount(
  privateKey,
  'Imported Account'
);
```

### Network Management

```javascript
// Set network (automatically switches between UTXO/EVM signers)
await keyringManager.setSignerNetwork(networkConfig);

// Get current network
const network = keyringManager.getNetwork();
```

### Transaction Operations

#### Syscoin (UTXO) Transactions

```javascript
// Estimate transaction fee
const feeEstimate =
  await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
    txOptions: {},
    amount: 1.0,
    receivingAddress: 'sys1q...',
    feeRate: 0.00001,
    token: null,
  });

// Sign PSBT
const signedPsbt = await keyringManager.syscoinTransaction.signPSBT({
  psbt: psbtData,
  isTrezor: false,
  isLedger: false,
});

// Get addresses
const receivingAddress = await keyringManager.updateReceivingAddress();
const changeAddress = await keyringManager.getNewChangeAddress();
```

#### Ethereum (EVM) Transactions

```javascript
// Send transaction
const txHash = await keyringManager.ethereumTransaction.sendTransaction({
  to: '0x...',
  value: '1000000000000000000', // 1 ETH in wei
  gasLimit: '21000',
  gasPrice: '20000000000', // 20 gwei
});

// Sign message
const signature = await keyringManager.ethereumTransaction.signPersonalMessage([
  '0x48656c6c6f', // "Hello" in hex
  accountAddress,
]);
```

### Hardware Wallet Support

Trezor uses `@trezor/connect-webextension` 10.0.1. The hardware adapter loads it
only when a supported MV3 extension invokes Trezor; ordinary Node CommonJS/ESM
imports and the software entry do not initialize browser transports. Unsupported
hosts reject hardware operations instead of falling back to software signing.

The extension must configure `externally_connectable` for
`https://suite.trezor.io/*` and host access to that origin, as required by the
[published Connect 10 webextension package](https://www.npmjs.com/package/@trezor/connect-webextension/v/10.0.1).
Connect selects Suite Desktop or the Suite Web popup. The old Connect 9 iframe,
content script, and `connectSrc` settings are not part of this integration.

Connect 10 does not expose the old device event emitter. SDK connection status
and cached model information update from request results and disposal; they are
not immediate physical unplug notifications. Disposal immediately rejects pending
SDK operations and fences late replies. Suite Web may leave its popup open; a
late approval there is discarded locally rather than treated as a fresh approval.
When an underlying request is still active, transport cleanup is deferred to avoid
triggering an automatic fallback popup. New initialization fails with
`HARDWARE_SIGNER_BUSY` until that request settles; local lock/disposal does not
wait for the remote prompt. An upstream transport failure can still trigger remote
fallback UI while that old request is pending; the local SDK will reject its result.
A failed or cancelled operation
never authorizes a cached transaction, and terminal disconnect/unsupported-host
errors are not retried. Device pairing, display verification, signing, and
reconnection still require physical-device qualification in the consuming host.

```javascript
// Import Trezor account
const trezorAccount = await keyringManager.importTrezorAccount(
  'Trezor Account'
);

// Import Ledger account
const ledgerAccount = await keyringManager.importLedgerAccount(
  false,
  'Ledger Account'
);
```

### State Management Integration

The KeyringManager requires a `vaultStateGetter` function that returns the current vault state:

```javascript
// Example with Redux
const vaultStateGetter = () => ({
  accounts: {
    [KeyringAccountType.HDAccount]: {
      /* account data */
    },
    [KeyringAccountType.Imported]: {
      /* imported accounts */
    },
  },
  activeAccount: { id: 0, type: KeyringAccountType.HDAccount },
  activeNetwork: {
    /* network config */
  },
  // ... other vault state
});

// The keyring manager will call this function to get current state
const keyringManager = new KeyringManager();
keyringManager.setVaultStateGetter(vaultStateGetter);
```

## Architecture

The stateless design means:

- **No Internal State**: The KeyringManager doesn't store account or network data
- **External State Provider**: Relies on your application's state management (Redux, Context, etc.)
- **Session Management**: Private keys are encrypted and managed securely in memory
- **Multi-Instance Support**: Multiple KeyringManager instances can operate independently

## API Reference

### KeyringManager

Main class for keyring operations:

- `createInitialized(seedPhrase, password, vaultStateGetter)` - Create and initialize keyring
- `addNewAccount(label?)` - Create new HD account
- `setActiveAccount(id, type)` - Switch active account
- `importAccount(privateKey, label?)` - Import account from private key
- `setSignerNetwork(network)` - Set active network
- `unlock(password)` - Unlock keyring
- `lockWallet()` - Lock keyring

### Transaction Managers

- `syscoinTransaction` - UTXO transaction operations
- `ethereumTransaction` - EVM transaction operations

For application-specific approval rules, pass an optional third argument to
`ethereumTransaction.sendFormattedTransaction(params, isLegacy, { assertCurrent })`.
The guard must return `undefined` synchronously or throw to deny the operation.
It supplements the SDK's account, network and session checks and is rechecked
after asynchronous preparation, immediately before signing, and before broadcast.
It is not called after a broadcast acknowledgement to reclassify a sent transaction.

### Hardware Wallet Support

- `importTrezorAccount(label?)` - Import Trezor account
- `importLedgerAccount(isConnected, label?)` - Import Ledger account

### Encrypted private records

An unlocked keyring can seal small application records without returning its
mnemonic or a derived encryption key:

```typescript
const domain = 'org.example.wallet.private-records.v1';
const recordId = crypto.randomUUID();
const profileId = await keyringManager.getPrivateRecordProfileId();
const envelope = await keyringManager.encryptPrivateRecord({
  domain,
  recordId,
  plaintext: new TextEncoder().encode('application-owned private data'),
});
// Store or back up only envelope; storage is owned by the calling application.
const plaintext = await keyringManager.decryptPrivateRecord({
  domain,
  recordId,
  envelope,
});
// Consume the bytes, then clear them when no longer needed.
plaintext.fill(0);
```

`IEncryptedPrivateRecord` contains only `version: 1`, `domain`, `recordId`,
`profileId`, a base64 nonce and base64 ciphertext including its authentication
tag. All application metadata should be encrypted inside `plaintext`. Domains
and record IDs are 1–128 ASCII characters: an alphanumeric first character,
followed by alphanumerics or `.`, `_`, `:`, `/`, `-`. Records may contain 0–65536
bytes. `MAX_PRIVATE_RECORD_BYTES` and `MAX_PRIVATE_RECORD_LABEL_BYTES` export
these bounds.

The API uses native WebCrypto HKDF-SHA256 and AES-256-GCM, with a fresh random
96-bit nonce and a 128-bit tag. The authenticated tuple binds the format version,
domain, record ID and profile ID. Profile and encryption derivations have
separate HKDF labels. The root material is the NFKD-normalized mnemonic or
extended private key already held by the unlocked session; derivation does not
depend on the selected account, network or password. Rewrapping the same root
with a new password therefore preserves access to these records.

Each operation rejects if its source session is locked, replaced or transferred
before completion, even if the same buffers are later transferred back. These
methods do not read or write wallet storage. Callers remain responsible for
record IDs, persistence, backup, rollback detection and clearing returned bytes.
**The seed alone cannot restore randomly generated records: their encrypted
backups are also required.** Temporary byte buffers are cleared; JavaScript
strings and native cryptographic allocations remain subject to runtime garbage
collection rather than guaranteed memory erasure.

## Security

- `initializeSession`, `initializeWalletSecurely`, and the initialization factories create a new wallet only when both vault records are absent. Use `unlock()` to restore an existing wallet. Repeating initialization on a matching live session verifies the stored wallet without rewriting it.
- Fresh vault salt and ciphertext are created together only if both are absent, through the core conditional-creation operation. Native extension contexts sharing an origin/storage partition are coordinated by Web Locks; custom backends must provide atomic `createItemsIfAbsent`. Unsupported adapters are rejected before writing. Existing or incomplete records are preserved.
- UTXO signing authenticates the selected account's paths, public keys and spent scripts. A joint PSBT may include unfinished inputs for another signer: their HD/path hints are removed before the selected private signer runs, then their public metadata is restored to the returned partial PSBT. Another account in the same wallet remains unsigned. At least one unfinished input must authenticate to the selected account; a wholly finalized PSBT retains its existing handling. Standard P2WSH, wrapped P2WSH and P2SH multisig preserve external cosigner signatures and continuation. Hardware paths and single-address imports can reject unsupported joint inputs rather than widening signing authority.
- Hardware signing preserves already-finalized external inputs without requesting their private derivations. Trezor receives them as `EXTERNAL` inputs; Ledger retains their final scripts in PSBTv2 and skips signing/finalizing them again. Unfinished foreign hardware inputs remain unsupported.
- Persisted wallet and account secrets are encrypted; plaintext signing material is used in memory
- Session data is cleared when the keyring is locked
- Hardware wallet integration follows device security models
- Secure memory management with explicit cleanup

## License

MIT License

### Ledger platform host

Ledger device access uses the Device Management Kit. The regular and software
entries do not load a Ledger transport or device SDK. Browser integrations must
create the heavy host from `@sidhujag/sysweb3-keyring/esm/ledger-host` in a visible
extension page and inject its semantic `LedgerHost` port into the wallet authority:

```ts
// Visible device page only:
import { createLedgerDmkHost } from '@sidhujag/sysweb3-keyring/esm/ledger-host';
const host = createLedgerDmkHost({
  confirmBlindSigning: async (intent, signal) => {
    // Show the exact immutable intent and an explicit blind-signing warning.
    // Return true only after a fresh user decision; cancellation must return false.
    return showTrustedWalletConfirmation(intent, signal);
  },
});

// Wallet authority: use a secured semantic port to that page, not a raw APDU port.
const wallet = new KeyringManager(undefined, authorizedLedgerHostPort);
```

Use only the ESM host entry with a browser bundler and its required platform
polyfills. `cjs/ledger-host` is not a supported entry. A service worker cannot own
the WebHID device picker. The platform must bind the host to its own trusted page,
revoke pending operations on lock/close, and never expose this port to dapps.
A missing host fails with `HARDWARE_SIGNER_UNAVAILABLE`; there is no legacy
LedgerJS fallback. Pass either a shared hardware manager or a Ledger host to
`KeyringManager`, not both.

The default host performs no remote metadata lookup, transaction checks, or
signing telemetry. The current Ethereum signer library can fall back to blind
signing, so transaction and typed-data signing require per-request approval
through the trusted `confirmBlindSigning` callback. Omitting it fails closed.
Personal-message signing and address retrieval remain available offline.
Signatures are checked against the expected account; UTXO signatures must also
match the approved PSBT and its requested sighash coverage. The custom UTXO host
supports the existing Syscoin and Bitcoin app protocols. Physical-device and
firmware qualification remain separate from source and mocked-device tests.

# Sysweb3 Keyring Test Suite

This directory contains the comprehensive test suite for the sysweb3-keyring package.

## Test Organization

### Directory Structure

```
test/
├── unit/                      # Unit tests for individual components
│   ├── keyring-manager/       # Core KeyringManager functionality
│   │   ├── initialization.spec.ts    # Wallet creation, unlock/lock
│   │   ├── account-management.spec.ts # Account operations
│   │   ├── key-derivation.spec.ts    # HD key derivation
│   │   ├── security.spec.ts          # Encryption, passwords
│   │   └── state-management.spec.ts  # State persistence
│   ├── network/               # Network management
│   │   ├── network-management.spec.ts # Network switching, custom networks
│   │   └── multi-keyring.spec.ts     # Multi-keyring constraints
│   ├── transactions/          # Transaction handling
│   │   ├── ethereum-transactions.spec.ts
│   │   └── syscoin-transactions.spec.ts
│   └── hardware/              # Hardware wallet integration
│       ├── trezor.spec.ts
│       └── ledger.spec.ts
├── integration/               # Integration tests
│   ├── import-validation.spec.ts     # Import flows
│   ├── cross-chain-operations.spec.ts
│   └── end-to-end-flows.spec.ts
└── helpers/                   # Test utilities
    ├── setup.ts              # Test setup and mocks
    └── constants.ts          # Test constants
```

## Test Coverage Areas

### Unit Tests

#### KeyringManager Core

- **Initialization**: Seed management, wallet creation, secure initialization
- **Account Management**: HD accounts, imported accounts, account switching
- **Key Derivation**: EVM (BIP44) and UTXO (BIP84) derivation paths
- **Security**: Password validation, encryption/decryption, session management
- **State Management**: Persistence, lock/unlock cycles, state recovery

#### Network Management

- **EVM Networks**: Switching between Ethereum, Polygon, etc.
- **Custom Networks**: Adding/removing custom RPC endpoints
- **Multi-Keyring**: UTXO network constraints, chain type validation

#### Transactions

- **Ethereum**: Transaction signing, message signing, typed data, EIP-1559
- **Syscoin**: PSBT creation, UTXO management, fee estimation

#### Hardware Wallets

- **Trezor**: Account import, transaction signing
- **Ledger**: Account import, blind signing

### Integration Tests

- **Import Validation**: Private key imports, zprv validation
- **Cross-Chain**: Multi-keyring coordination
- **End-to-End**: Complete user flows

## Running Tests

```bash
# Run all tests
yarn test

# Run specific test file
yarn test packages/sysweb3-keyring/test/unit/keyring-manager/initialization.spec.ts

# Run with coverage
yarn test --coverage

# Run unit tests only
yarn test packages/sysweb3-keyring/test/unit

# Run integration tests only
yarn test packages/sysweb3-keyring/test/integration
```

## Test Patterns

### Setup and Teardown

All tests use the `setupMocks()` helper to ensure clean state:

```typescript
beforeEach(() => {
  setupMocks();
});
```

### Creating Test Instances

```typescript
// EVM keyring
const keyringManager = await KeyringManager.createInitialized(
  PEACE_SEED_PHRASE,
  FAKE_PASSWORD,
  {
    ...initialWalletState,
    activeNetwork: initialWalletState.networks.ethereum[1],
  },
  INetworkType.Ethereum
);

// UTXO keyring
const keyringManager = await KeyringManager.createInitialized(
  PEACE_SEED_PHRASE,
  FAKE_PASSWORD,
  {
    ...initialWalletState,
    activeNetwork: initialWalletState.networks.syscoin[57],
  },
  INetworkType.Syscoin
);
```

### Common Test Constants

- `PEACE_SEED_PHRASE`: Deterministic test mnemonic
- `FAKE_PASSWORD`: Test password
- `SECOND_FAKE_SEED_PHRASE`: Alternative test mnemonic

## Mock Strategy

The test suite uses selective mocking:

- **Network calls**: Mocked to avoid external dependencies
- **Cryptographic operations**: Use real implementations for deterministic results
- **Storage**: In-memory mock implementation
- **Hardware wallets**: Mocked for unit tests, real in integration tests

## Adding New Tests

1. Determine if it's a unit or integration test
2. Place in appropriate directory
3. Use existing test patterns for consistency
4. Ensure proper setup/teardown
5. Add descriptive test names
6. Cover both success and error cases

## Test Quality Guidelines

- Each test should be independent
- Use descriptive test names that explain the scenario
- Test edge cases and error conditions
- Avoid testing implementation details
- Focus on behavior and public APIs
- Keep tests simple and readable

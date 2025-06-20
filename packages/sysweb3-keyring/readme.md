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

## Installation

```bash
npm install @pollum-io/sysweb3-keyring
# or
yarn add @pollum-io/sysweb3-keyring
```

## Usage

### Basic Setup

```javascript
import { KeyringManager } from '@pollum-io/sysweb3-keyring';

// Create a vault state getter function (e.g., from Redux store)
const vaultStateGetter = () => store.getState().vault;

// Initialize the keyring manager
const keyringManager = await KeyringManager.createInitialized(
  seedPhrase,
  password,
  vaultStateGetter
);
```

### Account Management

```javascript
// Get active account
const activeAccount = keyringManager.getActiveAccount();

// Create new account
const newAccount = await keyringManager.addNewAccount('My Account');

// Switch active account
await keyringManager.setActiveAccount(accountId, KeyringAccountType.HDAccount);

// Import account from private key
const importedAccount = await keyringManager.importAccount(privateKey, 'Imported Account');
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
const feeEstimate = await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
  txOptions: {},
  amount: 1.0,
  receivingAddress: 'sys1q...',
  feeRate: 0.00001,
  token: null
});

// Sign PSBT
const signedPsbt = await keyringManager.syscoinTransaction.signPSBT({
  psbt: psbtData,
  isTrezor: false,
  isLedger: false
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
  gasPrice: '20000000000' // 20 gwei
});

// Sign message
const signature = await keyringManager.ethereumTransaction.signPersonalMessage([
  '0x48656c6c6f', // "Hello" in hex
  accountAddress
]);
```

### Hardware Wallet Support

```javascript
// Import Trezor account
const trezorAccount = await keyringManager.importTrezorAccount('Trezor Account');

// Import Ledger account
const ledgerAccount = await keyringManager.importLedgerAccount(false, 'Ledger Account');
```

### State Management Integration

The KeyringManager requires a `vaultStateGetter` function that returns the current vault state:

```javascript
// Example with Redux
const vaultStateGetter = () => ({
  accounts: {
    [KeyringAccountType.HDAccount]: { /* account data */ },
    [KeyringAccountType.Imported]: { /* imported accounts */ }
  },
  activeAccount: { id: 0, type: KeyringAccountType.HDAccount },
  activeNetwork: { /* network config */ },
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

### Hardware Wallet Support

- `importTrezorAccount(label?)` - Import Trezor account
- `importLedgerAccount(isConnected, label?)` - Import Ledger account

## Security

- Private keys are encrypted and stored in memory only
- Session data is cleared when the keyring is locked
- Hardware wallet integration follows device security models
- Secure memory management with explicit cleanup

## License

MIT License

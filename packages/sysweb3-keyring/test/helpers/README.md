# Test Helpers

This directory contains global test utilities for the sysweb3-keyring package.

## Global Mock Utilities

### `mockVaultState`

A default mock vault state that can be used in any test file. This is automatically created with:

- Active account: ID 0, HDAccount type
- Active network: Syscoin mainnet (chainId 57)
- All default networks and accounts from `initialWalletState`

Usage:

```typescript
import { setupMocks } from '../helpers/setup';

describe('My Test', () => {
  beforeEach(() => {
    setupMocks();
  });

  it('should use global mock state', () => {
    const mockVaultStateGetter = jest.fn(() => mockVaultState);
    keyringManager.setVaultStateGetter(mockVaultStateGetter);
    // mockVaultState is now available globally
  });
});
```

### `createMockVaultState(options)`

A utility function to create custom mock vault states with different configurations.

Parameters:

- `activeAccountId` (default: 0) - The active account ID
- `activeAccountType` (default: HDAccount) - The active account type
- `networkType` (default: Syscoin) - The network type (Syscoin or Ethereum)
- `chainId` (optional) - Specific chain ID to use

Usage:

```typescript
// Create EVM mock state
const evmMockState = createMockVaultState({
  networkType: INetworkType.Ethereum,
  chainId: 1, // Ethereum mainnet
});

// Create Polygon mock state
const polygonMockState = createMockVaultState({
  networkType: INetworkType.Ethereum,
  chainId: 137,
});

// Create Bitcoin testnet mock state
const btcTestnetMockState = createMockVaultState({
  networkType: INetworkType.Syscoin,
  chainId: 1, // Bitcoin testnet uses slip44=1
});

// Use in test
const mockVaultStateGetter = jest.fn(() => evmMockState);
keyringManager.setVaultStateGetter(mockVaultStateGetter);
```

## Other Utilities

### `setupMocks()`

Clears all mocks and resets global state. Should be called in `beforeEach()`.

### `setupTestVault(password)`

Creates a test vault with encrypted mnemonic and proper vault-keys for password validation.

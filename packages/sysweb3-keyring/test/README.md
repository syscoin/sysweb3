# Keyring Manager Test Strategy

## Testing Approach

### 1. Minimal Mocking
- Only mock external dependencies (network calls, storage)
- Let crypto libraries work naturally
- Use real HD key derivation

### 2. Test Categories

#### Unit Tests
- Test individual methods with mocked dependencies
- Focus on logic, not integration

#### Integration Tests  
- Test full flows with minimal mocking
- Verify account creation, switching, and key derivation
- Use real crypto operations

#### E2E Tests
- Test against actual networks (testnet)
- Verify real transactions work

### 3. Known Issues to Test

1. **Account Index Synchronization** (Fixed)
   - Verify `setAccountIndex` is called when switching accounts
   - Test non-sequential account switching

2. **Network-Aware HD Signer**
   - Test HD signer creation with correct testnet/mainnet flag
   - Verify network switching maintains correct state

3. **Import Account Validation**
   - Test importing zprv for UTXO accounts
   - Test importing private keys for Ethereum accounts

### 4. Mock Guidelines

#### DO Mock:
- `syscoinjs.utils.fetchBackendAccount` - Network calls
- Storage operations
- Web3 provider connections

#### DON'T Mock:
- `bip32`, `bip39`, `bip84` - Crypto operations
- `syscoinjs.utils.HDSigner` - Key derivation logic
- `ethers.Wallet` - Ethereum key operations

This ensures tests verify actual functionality while avoiding network dependencies. 
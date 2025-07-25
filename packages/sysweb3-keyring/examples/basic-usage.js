/**
 * Basic usage example of the stateless KeyringManager
 */

import { KeyringManager, KeyringAccountType } from '@pollum-io/sysweb3-keyring';

// Example state structure (similar to Redux store)
let vaultState = {
  accounts: {
    [KeyringAccountType.HDAccount]: {},
    [KeyringAccountType.Imported]: {},
    [KeyringAccountType.Trezor]: {},
    [KeyringAccountType.Ledger]: {},
  },
  activeAccount: { id: 0, type: KeyringAccountType.HDAccount },
  activeNetwork: {
    chainId: 57,
    currency: 'SYS',
    kind: 'syscoin',
    label: 'Syscoin Mainnet',
    url: 'https://blockbook.syscoin.org/',
    slip44: 57,
  },
  // ... other vault properties
};

// Vault state getter function
const vaultStateGetter = () => vaultState;

// Update vault state helper (in real app, this would be Redux dispatch)
const updateVaultState = (updates) => {
  vaultState = { ...vaultState, ...updates };
};

async function example() {
  try {
    const seedPhrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const password = 'secure-password';

    // 1. Initialize KeyringManager
    console.log('Initializing KeyringManager...');
    const keyringManager = await KeyringManager.createInitialized(
      seedPhrase,
      password,
      vaultStateGetter
    );

    // 2. Create the initial account (this would be added to your state)
    const initialAccount = await keyringManager.createKeyringVaultFromSession();

    // Update your state with the new account
    updateVaultState({
      accounts: {
        ...vaultState.accounts,
        [KeyringAccountType.HDAccount]: {
          ...vaultState.accounts[KeyringAccountType.HDAccount],
          [initialAccount.id]: initialAccount,
        },
      },
    });

    console.log('Initial account created:', initialAccount.address);

    // 3. Create additional accounts
    console.log('Creating additional account...');
    const newAccount = await keyringManager.addNewAccount('My Second Account');

    // Update state with new account
    updateVaultState({
      accounts: {
        ...vaultState.accounts,
        [KeyringAccountType.HDAccount]: {
          ...vaultState.accounts[KeyringAccountType.HDAccount],
          [newAccount.id]: newAccount,
        },
      },
    });

    console.log('New account created:', newAccount.address);

    // 4. Switch active account
    console.log('Switching to new account...');
    await keyringManager.setActiveAccount(
      newAccount.id,
      KeyringAccountType.HDAccount
    );

    // Update state with new active account
    updateVaultState({
      activeAccount: { id: newAccount.id, type: KeyringAccountType.HDAccount },
    });

    console.log('Active account switched to:', newAccount.address);

    // 5. Get addresses for UTXO operations
    console.log('Getting receiving address...');
    const receivingAddress = await keyringManager.updateReceivingAddress();
    console.log('Receiving address:', receivingAddress);

    const changeAddress = await keyringManager.getNewChangeAddress();
    console.log('Change address:', changeAddress);

    // 6. Network operations
    console.log('Current network:', keyringManager.getNetwork().label);

    // 7. Transaction fee estimation example
    try {
      const feeEstimate =
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: {},
          amount: 0.1,
          receivingAddress: 'sys1qexample...',
          feeRate: 0.00001,
          token: null,
        });
      console.log('Fee estimate:', feeEstimate.fee);
    } catch (error) {
      console.log(
        'Fee estimation failed (expected in example):',
        error.message
      );
    }

    // 8. Lock the keyring
    console.log('Locking keyring...');
    keyringManager.lockWallet();
    console.log('Keyring locked:', !keyringManager.isUnlocked());

    // 9. Unlock the keyring
    console.log('Unlocking keyring...');
    await keyringManager.unlock(password);
    console.log('Keyring unlocked:', keyringManager.isUnlocked());
  } catch (error) {
    console.error('Example failed:', error);
  }
}

// Run the example
example().catch(console.error);

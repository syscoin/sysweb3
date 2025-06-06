# SysWeb3

SysWeb3 is a JavaScript API for Syscoin multi-chain, providing a collection of utilities, network management, keyring management, and core browser functions to facilitate dapp development.

## Overview

This monorepo contains the following packages:

- **@pollum-io/sysweb3-keyring**: A keyring manager for UTXO and Web3 wallets, providing functions for handling wallets, addresses, accounts, transactions, and Trezor wallet integration.
- **@pollum-io/sysweb3-network**: A network management tool for multi-chain accounts, offering functions to validate RPC URLs and manage network configurations.
- **@pollum-io/sysweb3-utils**: A helper library for multi-chain accounts, providing TypeScript interfaces and utility functions for contract interactions, token validation, and more.
- **@pollum-io/sysweb3-core**: A localStorage manager for private keys, offering browser interaction functions for setting, getting, and deleting storage.

## Setup

### Prerequisites

- Node.js 10 or later
- Yarn v1 or v2

### Installation

To install the packages, run:

```bash
yarn add @pollum-io/sysweb3-keyring @pollum-io/sysweb3-network @pollum-io/sysweb3-utils @pollum-io/sysweb3-core
```

## Usage

### SysWeb3 Keyring

The SysWeb3 Keyring package provides functions for managing accounts, addresses, and transactions. Here's a simple example:

```js
import sysweb3 from '@pollum-io/sysweb3-keyring';

console.log(sysweb3);
// Outputs available functions like Web3Accounts, SyscoinAddress, initialize, TrezorTransactions, etc.
```

### SysWeb3 Network

The SysWeb3 Network package offers functions for network management. Example:

```js
import sysweb3 from '@pollum-io/sysweb3-network';

console.log(sysweb3);
// Outputs functions like validateCurrentRpcUrl, validateSysRpc, setSignerNetwork, etc.
```

### SysWeb3 Utils

The SysWeb3 Utils package provides utility functions for multi-chain accounts. Example:

```js
import sysweb3 from '@pollum-io/sysweb3-utils';

console.log(sysweb3);
// Outputs functions like isValidSYSAddress, isValidEthereumAddress, getNftImage, createContractUsingAbi, etc.
```

### SysWeb3 Core

The SysWeb3 Core package offers browser interaction functions. Example:

```js
import sysweb3 from '@pollum-io/sysweb3-core';

console.log(sysweb3);
// Outputs functions like useLocalStorageClient, getStateStorageDb, etc.
```

## Development

### Scripts

- `yarn format`: Format code using Prettier.
- `yarn lint`: Lint code using ESLint.
- `yarn lint:fix`: Fix linting issues automatically.
- `yarn test`: Run tests using Jest.
- `yarn type-check`: Check TypeScript types.

### Configuration

- **TypeScript**: Configured in `tsconfig-package.json` and `tsconfig.json` files.
- **Babel**: Configured in `.babelrc`.
- **Jest**: Configured in `jest.config.json`.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Sysweb3-keyring

Collection of useful account functions for Syscoin multi-chain.

Here, you'll find methods that help you to handle wallet, address, accounts, transactions and trezor wallet.

Furthermore, our motivation to build these solutions is:

- centralize and support sys and web3 functions related to account
- facilitate the dapp development
- build a helpful, single, maintained and stable library

## Setup

For use this library, is nice to have:

- [Node.js](https://nodejs.org) 10 or later installed
- [Yarn](https://yarnpkg.com) v1 or v2 installed

For install, you can follow these commands:

- `yarn add @pollum-io/sysweb3-keyring`
- `npm install @pollum-io/sysweb3-keyring`

## Usage

The sysweb3-keyring was builded to have a really simple usability. For example, you can import package and console it to know what kind of functions you'll find:

```js
import sysweb3 from '@pollum-io/sysweb3-keyring';

console.log(sysweb3);

{
  Web3Accounts: function () {},
  SyscoinAddress: function () {},
  initialize: function () {},
  TrezorTransactions: function () {},
  ...
}
```

Inside of source folder, you'll find some others folders like:

- `accounts`: this folder have the `eth-accounts` file. There, you'll be able to use all the web3 functions related to web3 account, like `getBalance` and `getTokens`, `sendTransaction`
- `address`: this folder have the `syscoin` file. There, you'll be able to use all the sys functions related to sys account, like `getValidAddress` and `getChangeAddress`
- `transactions`: this folder have the `syscoin` file. There, you'll be able to use all the sys functions related to sys transactions like `signTransaction`
- `trezor`: this folder have the `init`, `transactions` and `wallet` files. There, you'll be able to use all the sys functions related to trezor wallet, like `initialize`, `TrezorTransactions` and `TrezorWallet`
- `wallets`: this folder have the `main` file. There, you'll be able to use all the sys functions related to wallet, like `getAccountXpub` and `createWallet`

## License

MIT License

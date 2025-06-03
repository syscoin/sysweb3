## Sysweb3-netowrk

Collection of helpful network functions for Syscoin multi-chain.

Here, you'll find methods that help you to develop your dapp network structure with efficiency and solidity.

## Setup

For use this library, is nice to have:

- [Node.js](https://nodejs.org) 10 or later installed
- [Yarn](https://yarnpkg.com) v1 or v2 installed

For install, you can follow these commands:

- `yarn add @pollum-io/sysweb3-network`
- `npm install @pollum-io/sysweb3-network`

## Usage

The sysweb3-network was builded to have a really simple usability. For example, you can import package and console it to know what kind of functions you'll find:

```js
import sysweb3 from '@pollum-io/sysweb3-network';

console.log(sysweb3);

{
  validateCurrentRpcUrl: function () {},
  validateSysRpc: function () {},
  setActiveNetwork: function () {},
  ...
}
```

Inside of source folder, you'll find some files like:

- `rpc.ts`: this file have some methods like `validateCurrentRpcUrl` and `validateSysRpc` . There, you'll be able to validate the your preferred RPC url. These functions will ensure that you don't have any connection issues with the chosen RPC.
- `networks.ts`: this file have `IWeb3Network` interface and `networks` object. There, you'll be able to use these datas to add type in your functions and build an network initial state.
- `web3.ts`: this file have the method `setActiveNetwork`. There, you'll be able to change the current network of your dapp.

These methods are just some of the ones available in our library.

Feel free to explore the possibilities. We hope you enjoy it.

## License

MIT License

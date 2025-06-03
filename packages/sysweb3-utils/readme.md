## Sysweb3-utils

Collection of helpful utility functions for Syscoin multi-chain.

Here, you'll find typescript interfaces and methods that help you to develop your dapp with efficiency.

Furthermore, our motivation to build these utilities is:

- centralize and support sys and web3 typescript interfaces and functions.
- facilitate the dapp development
- build a helpful, single, maintained and stable library

We know that in dapp development some methods is used with more frequency. So, we separate the main functions for you.

## Setup

For use this library, is nice to have:

- [Node.js](https://nodejs.org) 10 or later installed
- [Yarn](https://yarnpkg.com) v1 or v2 installed

For install, you can follow these commands:

- `yarn add @pollum-io/sysweb3-utils`
- `npm install @pollum-io/sysweb3-utils`

## Usage

The sysweb3-utils was builded to have a really simple usability. For example, you can import package and console it to know what kind of functions you'll find:

```js
import sysweb3 from '@pollum-io/sysweb3-utils';

console.log(sysweb3);

{
  isValidSYSAddress: function () {},
  isValidEthereumAddress: function () {},
  getNftImage: function () {},
  createContractUsingAbi: function () {},
  isContractAddress: function () {},
  ...
}
```

Inside of source folder, you'll find some files like:

- `contracts.ts`: this file have the `createContractUsingAbi`, `isContractAddress`, `getErc20Abi` and `getErc721Abi` methods. There, you'll be able to use the main abi methods with your preferred contract, besides ensuring your contract address validate.
- `tokens.ts`: this file have some methods like `getNftImage`, `getWeb3TokenData` and `validateToken`. There, you'll be able to use all functions related to tokens data like icons, token validate, if is NFT or not, price and somethings like these.

These methods are just some of the ones available in our library.

Feel free to explore the possibilities. We hope you enjoy it.

## License

MIT License

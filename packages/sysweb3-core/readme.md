## Sysweb3-core

Collection of helpful browser functions for Syscoin multi-chain.

Here, you'll find methods that help you to interact with any HTTP client easily.

## Setup

For use this library, is nice to have:

- [Node.js](https://nodejs.org) 10 or later installed
- [Yarn](https://yarnpkg.com) v1 or v2 installed

For install, you can follow these commands:

- `yarn add @pollum-io/sysweb3-core`
- `npm install @pollum-io/sysweb3-core`

## Usage

The sysweb3-core was builded to have a really simple usability. For example, you can import package and console it to know what kind of functions you'll find:

```js
import sysweb3 from '@pollum-io/sysweb3-core';

console.log(sysweb3);

{
  useLocalStorageClientl: function () {},
  getStateStorageDb: function () {},
  ...
}
```

Inside of source folder, you'll find one of the main files: `sysweb3-di.ts`

- There, you'll be able to use all methods to set, get and delete storage (session or local) in your browser. All functions inside this file was build for give an easier experience with browser interaction.

These methods are just some of the ones available in our library.

Feel free to explore the possibilities. We hope you enjoy it.

## License

MIT License

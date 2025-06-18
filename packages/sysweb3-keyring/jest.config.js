module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  testMatch: ['**/test/**/*.spec.ts'],
  moduleNameMapper: {
    '^@pollum-io/sysweb3-utils$': '<rootDir>/../sysweb3-utils/src',
    '^@pollum-io/sysweb3-network$': '<rootDir>/../sysweb3-network/src',
    '^@pollum-io/sysweb3-core$': '<rootDir>/../sysweb3-core/src',
    '^@ledgerhq/devices/hid-framing$':
      '<rootDir>/test/__mocks__/ledger-mock.js',
    '^@ledgerhq/hw-transport-webhid$':
      '<rootDir>/test/__mocks__/ledger-mock.js',
    '^@ledgerhq/evm-tools/.*$': '<rootDir>/test/__mocks__/ledger-mock.js',
    '^@ledgerhq/hw-app-eth$': '<rootDir>/test/__mocks__/ledger-mock.js',
    '^@ledgerhq/hw-app-btc$': '<rootDir>/test/__mocks__/ledger-mock.js',
    '^@trezor/connect-webextension$': '<rootDir>/test/__mocks__/trezor-mock.js',
    'isomorphic-fetch': '<rootDir>/../../__mocks__/isomorphic-fetch.js',
  },
  setupFilesAfterEnv: [
    '<rootDir>/../../jest.setup.js',
    '<rootDir>/test/helpers/setup.ts',
  ],
};

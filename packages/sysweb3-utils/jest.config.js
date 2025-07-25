module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  testMatch: ['**/test/**/*.spec.ts'],
  moduleNameMapper: {
    '^@pollum-io/sysweb3-network$': '<rootDir>/../sysweb3-network/src',
    '^@pollum-io/sysweb3-core$': '<rootDir>/../sysweb3-core/src',
    '^@pollum-io/sysweb3-keyring$': '<rootDir>/../sysweb3-keyring/src',
    'isomorphic-fetch': '<rootDir>/../../__mocks__/isomorphic-fetch.js',
  },
  setupFilesAfterEnv: [
    '<rootDir>/../../jest.setup.js',
    '<rootDir>/test/setup.ts',
  ],
};

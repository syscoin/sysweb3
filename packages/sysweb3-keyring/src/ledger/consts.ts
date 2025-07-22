export const SYSCOIN_NETWORKS = {
  mainnet: {
    messagePrefix: '\x18Syscoin Signed Message:\n',
    bech32: 'sys',
    bip32: {
      public: 0x0488b21e,
      private: 0x0488ade4,
    },
    pubKeyHash: 0x3f,
    scriptHash: 0x05,
    wif: 0x80,
  },
  testnet: {
    messagePrefix: '\x18Syscoin Signed Message:\n',
    bech32: 'tsys',
    bip32: {
      public: 0x043587cf,
      private: 0x04358394,
    },
    pubKeyHash: 0x41,
    scriptHash: 0xc4,
    wif: 0xef,
  },
};

export const BLOCKBOOK_API_URL = 'https://explorer-blockbook.syscoin.org';
export const DESCRIPTOR = 'wpkh(@0/**)';
export const RECEIVING_ADDRESS_INDEX = 0;
export const WILL_NOT_DISPLAY = false;

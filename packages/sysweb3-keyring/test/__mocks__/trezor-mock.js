// Mock for TrezorConnect
const TrezorConnect = {
  manifest: () => {},
  init: () => Promise.resolve({ success: true }),
  getDeviceId: () =>
    Promise.resolve({ success: true, payload: { deviceId: 'mock-device-id' } }),
  getPublicKey: () =>
    Promise.resolve({
      success: true,
      payload: {
        publicKey: '0x1234567890abcdef',
        chainCode: '0xabcdef1234567890',
        xpub: 'xpub1234567890',
      },
    }),
  ethereumGetAddress: () =>
    Promise.resolve({
      success: true,
      payload: { address: '0x1234567890123456789012345678901234567890' },
    }),
  signTransaction: () =>
    Promise.resolve({
      success: true,
      payload: { signedTransaction: '0xsigned' },
    }),
  getAccountInfo: () =>
    Promise.resolve({
      success: true,
      payload: {
        descriptor:
          'vpub5YBbnk2FsQPCd4LsK7rESWaGVeWtq7nr3SgrdbeaQgctXBwpFQfLbKdwtDAkxLwhKubbpNwQqKPodfKTwVc4uN8jbsknuPTpJuW8aN1S3nC',
        balance: '0',
        availableBalance: '0',
        empty: false,
        addresses: {
          change: [],
          used: [],
          unused: [],
        },
      },
    }),
  on: () => {},
  off: () => {},
  removeAllListeners: () => {},
  DEVICE_EVENT: 'DEVICE_EVENT',
  DEVICE: {
    CONNECT: 'device-connect',
    DISCONNECT: 'device-disconnect',
  },
  UI_EVENT: 'UI_EVENT',
  UI: {
    REQUEST_BUTTON: 'ui-request_button',
  },
};

module.exports = TrezorConnect;
module.exports.default = TrezorConnect;

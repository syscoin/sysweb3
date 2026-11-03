// Mock for TrezorConnect
// Define a complete mock to prevent "main.send is not a function" errors
const TrezorConnect = {
  manifest: jest.fn(),
  cancel: jest.fn(),
  init: jest.fn(() => Promise.resolve({ success: true })),
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
  getAddress: () =>
    Promise.resolve({
      success: true,
      payload: {
        address: 'sys1qmock_trezor_verified_address',
        path: "m/44'/57'/0'/0/0",
      },
    }),
  signTransaction: () =>
    Promise.resolve({
      success: true,
      payload: { signedTransaction: '0xsigned' },
    }),
  ethereumSignTypedData: () =>
    Promise.resolve({
      success: true,
      payload: {
        signature: '0xmocked_typed_data_signature',
        address: '0x1234567890123456789012345678901234567890',
      },
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
  on: jest.fn(),
  off: jest.fn(),
  removeAllListeners: jest.fn(),
  dispose: jest.fn(() => Promise.resolve()),
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

module.exports.subscribeTrezorEvents = jest.fn(() => () => {});
module.exports.trezorResponseError = (response, prefix = '') =>
  Object.assign(
    new Error(prefix + (response.payload?.error || 'Trezor request failed')),
    { code: response.payload?.code }
  );

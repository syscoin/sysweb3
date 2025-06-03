// Mock for Ledger modules
module.exports = {
  default: class MockTransport {
    constructor() {}
    static isSupported() {
      return Promise.resolve(false);
    }
    static list() {
      return Promise.resolve([]);
    }
    static listen() {
      return { unsubscribe: () => {} };
    }
  },
  // Mock for hid-framing
  createHIDframing: () => ({
    frame: () => Buffer.from([]),
    unframe: () => ({ data: Buffer.from([]), more: false }),
  }),
}; 
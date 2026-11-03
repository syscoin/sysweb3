import { execFileSync } from 'child_process';
import { join } from 'path';

// Run the installed ESM package in a fresh Node process without Jest's Connect
// mock. Browser I/O and the websocket factory are simulated; no device, network
// or physical Safe 7 compatibility claim is made by these protocol checks.
const runConnect = (scenario: Record<string, unknown> = {}) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(__dirname, '../../helpers/trezor-connect10-protocol.cjs'),
        JSON.stringify(scenario),
      ],
      { encoding: 'utf8', timeout: 10000 }
    )
  );

const manifest = {
  appName: 'Pali Wallet',
  appUrl: 'https://paliwallet.com/',
  email: 'support@syscoin.org',
};

describe('Trezor Connect 10 installed package protocol', () => {
  it('lazy-loads the real ESM client from the compiled CommonJS adapter', () => {
    const result = runConnect({ adapter: true });
    expect(result.adapterMode).toBe(true);
    expect(result.proxyListenersBeforeInit).toBe(0);
    expect(result.proxyListeners).toBe(1);
    expect(result.socketsAfterInit).toBe(1);
    expect(result.response).toEqual({
      success: true,
      payload: { model: 'T3W1' },
      device: { path: 'synthetic-device-path' },
    });
    expect(result.desktopMessages[1].payload.method).toBe('getFeatures');
    expect(result.popupUrls).toEqual([]);
  });

  it('preserves an actual Connect failure through the compiled CommonJS adapter', () => {
    const error = {
      code: 'Method_UnsupportedCoinForHost',
      message: 'Coin is not supported by Trezor Suite',
    };
    const result = runConnect({ adapter: true, error });
    expect(result.response).toEqual({
      success: false,
      error,
      payload: { error: error.message, code: error.code },
    });
    expect(
      result.desktopMessages.filter(
        (request: any) => request.type === 'iframe-call'
      )
    ).toHaveLength(1);
  });

  it('connects to Suite desktop during initialization and retains device identity', () => {
    const result = runConnect();
    expect(result.socketsAfterInit).toBe(1);
    expect(result.sockets).toEqual(['ws://127.0.0.1:21335/connect-ws']);
    expect(result.response).toEqual({
      success: true,
      payload: { model: 'T3W1' },
      device: { path: 'synthetic-device-path' },
    });
    expect(result.permissionQueries).toEqual([
      { name: 'local-network-access' },
    ]);
    expect(result.desktopMessages.map((message: any) => message.type)).toEqual([
      'popup-handshake',
      'iframe-call',
    ]);
    expect(result.desktopMessages[0].payload.settings).toMatchObject({
      manifest,
      version: '10.0.1',
    });
    expect(result.desktopMessages[1].payload.method).toBe('getFeatures');
    expect(result.popupUrls).toEqual([]);
    expect(result.exposesEventEmitter).toBe(false);
  });

  it('falls back to the fixed Suite Web external-message protocol without script injection', () => {
    const result = runConnect({ desktopAvailable: false });
    expect(result.response.success).toBe(true);
    expect(result.popupUrls).toEqual([
      'https://suite.trezor.io/web/connect-popup#extension-id=test-extension-id',
    ]);
    expect(result.proxyListeners).toBe(1);
    expect(result.popupMessages.map((message: any) => message.type)).toEqual([
      'channel-handshake-request',
      'popup-handshake',
      'iframe-call',
    ]);
    expect(result.popupMessages[1].payload).toMatchObject({
      manifest,
      version: '10.0.1',
    });
    expect(result.popupMessages[2].channel).toEqual({
      here: '@trezor/connect-webextension-externally-connectable',
      peer: '@trezor/suite-web',
    });
    expect(result.popupMessages[2].payload.method).toBe('getFeatures');
  });

  it('ignores a matching-response-id message from an untrusted popup origin', () => {
    const result = runConnect({
      desktopAvailable: false,
      injectWrongOrigin: true,
    });
    expect(result.rejectedOrigins).toBe(1);
    expect(result.response.payload.model).toBe('T3W1');
  });

  it.each([
    ['Method_Cancel', 'Canceled'],
    ['Method_Interrupted', 'Popup closed'],
    ['Method_UnsupportedCoinForHost', 'Coin is not supported by Trezor Suite'],
  ])(
    'retains a terminal %s error without converting it to a success',
    (code, message) => {
      const result = runConnect({ error: { code, message } });
      expect(result.response).toEqual({
        success: false,
        error: { code, message },
      });
      expect(result.response.payload).toBeUndefined();
      expect(
        result.desktopMessages.filter(
          (request: any) => request.type === 'iframe-call'
        )
      ).toHaveLength(1);
      expect(result.popupUrls).toEqual([]);
    }
  );

  it('disposes a pending Suite Desktop request without an unhandled cancellation promise', () => {
    const result = runConnect({ adapter: true, disposePending: true });
    expect(result.rejectedBeforeRemoteReply).toBe(true);
    expect(result.cancelledError).toMatchObject({ code: 'Method_Interrupted' });
    expect(result.unexpectedLateSuccess).toBeUndefined();
    expect(
      result.desktopMessages.some(
        (message: any) => message.type === 'core-call-cancel'
      )
    ).toBe(false);
    expect(result.notifications).not.toContainEqual(
      expect.objectContaining({ type: 'model' })
    );
    expect(result.remoteReplyDelivered).toBe(true);
    expect(result.reconnectedResponse).toMatchObject({
      success: true,
      payload: { model: 'T3W1' },
    });
    expect(result.popupUrls).toEqual([]);
  });

  it('rejects a pending Suite Web request locally before any late approval arrives', () => {
    const result = runConnect({
      adapter: true,
      desktopAvailable: false,
      disposePending: true,
    });
    expect(result.rejectedBeforeRemoteReply).toBe(true);
    expect(result.cancelledError).toMatchObject({ code: 'Method_Interrupted' });
    expect(result.unexpectedLateSuccess).toBeUndefined();
    expect(result.cancelMessages).toBe(0);
    expect(result.notifications).toContainEqual({ type: 'disconnected' });
    expect(result.notifications).not.toContainEqual(
      expect.objectContaining({ type: 'model' })
    );
    expect(result.remoteReplyDelivered).toBe(true);
    expect(result.reconnectedResponse).toMatchObject({
      success: true,
      payload: { model: 'T3W1' },
    });
    // Upstream Suite Web dispose is a no-op: local fencing is the guarantee.
    expect(result.popupStillOpenAfterDispose).toBe(true);
  });

  it('destroys the full keyring before a held Suite Web approval returns', () => {
    const result = runConnect({
      adapter: true,
      keyring: true,
      desktopAvailable: false,
      disposePending: true,
    });
    expect(result.keyringDestroyed).toBe(true);
    expect(result.busyError).toMatchObject({ code: 'HARDWARE_SIGNER_BUSY' });
    expect(result.unexpectedBusySuccess).toBeUndefined();
    expect(result.rejectedBeforeRemoteReply).toBe(true);
    expect(result.cancelledError).toMatchObject({ code: 'Method_Interrupted' });
    expect(result.unexpectedLateSuccess).toBeUndefined();
    expect(result.reconnectedResponse).toMatchObject({ success: true });
  });

  it('rejects a missing appName before connecting to either host', () => {
    const result = runConnect({ missingAppName: true });
    expect(result.initializationError.code).toBe('Init_ManifestMissing');
    expect(result.sockets).toEqual([]);
    expect(result.popupUrls).toEqual([]);
  });
});

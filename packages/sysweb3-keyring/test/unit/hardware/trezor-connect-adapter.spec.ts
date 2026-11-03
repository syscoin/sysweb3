/* eslint-disable camelcase */
import ConnectMock from '@trezor/connect-webextension';

import { HardwareWalletManager } from '../../../src/hardware-wallet-manager';

type AdapterModule = typeof import('../../../src/trezor/connect');
let adapter: AdapterModule;
const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const extensionHost = () => ({
  runtime: {
    id: 'synthetic-test-extension',
    getManifest: () => ({ manifest_version: 3 }),
    onConnect: { addListener: jest.fn() },
    onMessageExternal: { addListener: jest.fn() },
  },
  tabs: { get: jest.fn(), create: jest.fn(), update: jest.fn() },
  windows: { getCurrent: jest.fn() },
});

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  jest.isolateModules(() => {
    adapter = jest.requireActual('../../../src/trezor/connect');
  });
});
afterEach(() => {
  if (chromeDescriptor)
    Object.defineProperty(globalThis, 'chrome', chromeDescriptor);
  else delete (globalThis as any).chrome;
});

it.each(['absent', 'incomplete', 'mv2'])(
  'rejects the %s host before calling Connect',
  async (host) => {
    const chrome: any = extensionHost();
    if (host === 'absent') delete (globalThis as any).chrome;
    else {
      if (host === 'incomplete') delete chrome.runtime.onMessageExternal;
      if (host === 'mv2')
        chrome.runtime.getManifest = () => ({ manifest_version: 2 });
      (globalThis as any).chrome = chrome;
    }
    await expect(
      adapter.default.init({
        manifest: {
          appName: 'Pali',
          appUrl: 'https://paliwallet.com',
          email: 'test@example.invalid',
        },
      })
    ).rejects.toMatchObject({ code: 'HARDWARE_SIGNER_UNAVAILABLE' });
    expect(ConnectMock.init).not.toHaveBeenCalled();
    await expect(adapter.default.dispose()).resolves.toBeUndefined();
  }
);

it('loads Connect only for a supported extension and selects its webextension environment', async () => {
  (globalThis as any).chrome = extensionHost();
  await adapter.default.init({
    manifest: {
      appName: 'Pali',
      appUrl: 'https://paliwallet.com',
      email: 'test@example.invalid',
    },
    coreMode: 'auto',
  });
  expect(ConnectMock.init).toHaveBeenCalledWith({
    manifest: {
      appName: 'Pali',
      appUrl: 'https://paliwallet.com',
      email: 'test@example.invalid',
    },
    coreMode: 'auto',
    env: 'webextension',
  });
});

it('preserves Connect 10 cancellation codes and the established SDK failure payload', async () => {
  (globalThis as any).chrome = extensionHost();
  await adapter.default.init({
    manifest: {
      appName: 'Pali',
      appUrl: 'https://paliwallet.com',
      email: 'test@example.invalid',
    },
  });
  jest.spyOn(ConnectMock, 'getAccountInfo').mockResolvedValueOnce({
    success: false,
    error: { code: 'Method_Cancel', message: 'Canceled' },
  } as any);
  const result = await adapter.default.getAccountInfo({
    coin: 'sys',
    path: "m/84'/57'/0'",
  });
  expect(result).toMatchObject({
    success: false,
    error: { code: 'Method_Cancel' },
    payload: { code: 'Method_Cancel', error: 'Canceled' },
  });
  if (!result.success)
    expect(adapter.trezorResponseError(result)).toMatchObject({
      code: 'Method_Cancel',
      message: 'Canceled',
    });
});

it('isolates status observers and reports model/disconnection from actual call outcomes', async () => {
  (globalThis as any).chrome = extensionHost();
  await adapter.default.init({
    manifest: {
      appName: 'Pali',
      appUrl: 'https://paliwallet.com',
      email: 'test@example.invalid',
    },
  });
  const listener = jest.fn();
  adapter.subscribeTrezorEvents(() => {
    throw new Error('synthetic observer failure');
  });
  const stop = adapter.subscribeTrezorEvents(listener);
  jest.spyOn(ConnectMock, 'getAccountInfo').mockResolvedValueOnce({
    success: true,
    payload: { descriptor: 'synthetic' },
    device: { features: { model: 'T3W1' } },
  } as any);
  await expect(
    adapter.default.getAccountInfo({ coin: 'sys', path: "m/84'/57'/0'" })
  ).resolves.toMatchObject({ success: true });
  expect(listener).toHaveBeenCalledWith({ type: 'model', model: 'T3W1' });
  jest.spyOn(ConnectMock, 'getAccountInfo').mockResolvedValueOnce({
    success: false,
    error: { code: 'Device_Disconnected', message: 'Device disconnected' },
  } as any);
  await expect(
    adapter.default.getAccountInfo({ coin: 'sys', path: "m/84'/57'/0'" })
  ).resolves.toMatchObject({ success: false });
  expect(listener).toHaveBeenCalledWith({ type: 'disconnected' });
  stop();
});

it.each([
  'Method_Cancel',
  'Method_Interrupted',
  'Method_Unsupported',
  'Method_UnsupportedCoinForHost',
  'Device_Disconnected',
  'Device_NotFound',
  'Transport_Missing',
  'Desktop_ConnectionMissing',
  'Method_PermissionsNotGranted',
  'Browser_LocalNetworkPermissionMissing',
  'HARDWARE_SIGNER_UNAVAILABLE',
])('does not retry terminal %s errors', async (code) => {
  const manager = new HardwareWalletManager();
  const operation = jest
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('synthetic terminal error'), { code })
    );
  try {
    await expect(
      manager.retryOperation(operation, 'synthetic', {
        maxRetries: 3,
        baseDelay: 0,
      })
    ).rejects.toMatchObject({ code });
    expect(operation).toHaveBeenCalledTimes(1);
  } finally {
    await manager.destroy();
  }
});

it('reattaches connection observers after a locked wallet reuses its manager', async () => {
  const mock = jest.requireMock('../../../src/trezor/connect');
  const observers = new Set<(event: { type: string }) => void>();
  jest
    .spyOn(mock, 'subscribeTrezorEvents')
    .mockImplementation((listener: any) => {
      observers.add(listener);
      return () => observers.delete(listener);
    });
  const manager = new HardwareWalletManager();
  try {
    expect(await manager.initializeTrezor()).toBe(true);
    await manager.destroy();
    expect(observers.size).toBe(0);
    expect(await manager.initializeTrezor()).toBe(true);
    expect(observers.size).toBe(1);
    for (const listener of observers) listener({ type: 'disconnected' });
    expect(manager.getStatus()).toContainEqual(
      expect.objectContaining({ type: 'trezor', connected: false })
    );
  } finally {
    await manager.destroy();
  }
});

it('rejects a pending request immediately on disposal and ignores late approval', async () => {
  (globalThis as any).chrome = extensionHost();
  await adapter.default.init({
    manifest: {
      appName: 'Pali',
      appUrl: 'https://paliwallet.com',
      email: 'test@example.invalid',
    },
  });
  let approve!: (result: any) => void;
  jest.spyOn(ConnectMock, 'getAccountInfo').mockImplementation(
    () =>
      new Promise((resolve) => {
        approve = resolve;
      }) as any
  );
  const observer = jest.fn();
  adapter.subscribeTrezorEvents(observer);
  const request = adapter.default.getAccountInfo({
    coin: 'sys',
    path: "m/84'/57'/0'",
  });
  const rejected = expect(request).rejects.toMatchObject({
    code: 'Method_Interrupted',
  });
  await new Promise(setImmediate);
  await adapter.default.dispose();
  await rejected;
  expect(ConnectMock.cancel).not.toHaveBeenCalled();
  await expect(
    adapter.default.init({
      manifest: {
        appName: 'Pali',
        appUrl: 'https://paliwallet.com',
        email: 'test@example.invalid',
      },
    })
  ).rejects.toMatchObject({ code: 'HARDWARE_SIGNER_BUSY' });
  expect(ConnectMock.dispose).not.toHaveBeenCalled();
  approve({
    success: true,
    payload: { descriptor: 'late' },
    device: { features: { model: 'LATE' } },
  });
  await new Promise(setImmediate);
  expect(observer).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'model' })
  );
  await expect(
    adapter.default.getAccountInfo({ coin: 'sys', path: "m/84'/57'/0'" })
  ).rejects.toMatchObject({ code: 'Init_NotInitialized' });
});

it('rejects pending work without invoking unsafe upstream cancellation', async () => {
  (globalThis as any).chrome = extensionHost();
  await adapter.default.init({
    manifest: {
      appName: 'Pali',
      appUrl: 'https://paliwallet.com',
      email: 'test@example.invalid',
    },
  });
  jest.spyOn(ConnectMock, 'getAccountInfo').mockImplementation(
    () =>
      new Promise(() => {
        /* Hold the remote operation until after local disposal. */
      }) as any
  );
  jest.spyOn(ConnectMock, 'cancel').mockImplementation(() => {
    throw new Error('remote cancellation unavailable');
  });
  const request = adapter.default.getAccountInfo({
    coin: 'sys',
    path: "m/84'/57'/0'",
  });
  const rejected = expect(request).rejects.toMatchObject({
    code: 'Method_Interrupted',
  });
  await new Promise(setImmediate);
  await expect(adapter.default.dispose()).resolves.toBeUndefined();
  await rejected;
  expect(ConnectMock.dispose).not.toHaveBeenCalled();
  expect(ConnectMock.cancel).not.toHaveBeenCalled();
});

it('does not initialize or send after disposal overtakes a queued import', async () => {
  (globalThis as any).chrome = extensionHost();
  const initialization = adapter.default.init({
    manifest: {
      appName: 'Pali',
      appUrl: 'https://paliwallet.com',
      email: 'test@example.invalid',
    },
  });
  const rejected = expect(initialization).rejects.toMatchObject({
    code: 'Method_Interrupted',
  });
  await adapter.default.dispose();
  await rejected;
  expect(ConnectMock.init).not.toHaveBeenCalled();
});

it('preserves a stable busy error through manager initialization without retry', async () => {
  jest.spyOn(ConnectMock, 'init').mockRejectedValueOnce(
    Object.assign(new Error('Previous Trezor request is still pending'), {
      code: 'HARDWARE_SIGNER_BUSY',
    })
  );
  const manager = new HardwareWalletManager();
  try {
    await expect(manager.initializeTrezor()).rejects.toMatchObject({
      code: 'HARDWARE_SIGNER_BUSY',
    });
    expect(ConnectMock.init).toHaveBeenCalledTimes(1);
  } finally {
    await manager.destroy();
  }
});

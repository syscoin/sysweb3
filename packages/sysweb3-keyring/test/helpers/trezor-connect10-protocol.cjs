/*
 * Run the published Connect implementation in a fresh plain-Node process.
 * Only browser I/O and the WebsocketClient socket factory are simulated.
 * These checks do not establish pairing or signing on physical hardware.
 */
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const scenario = JSON.parse(process.argv[2] || '{}');
if (scenario.keyring) console.log = () => {};
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const nativeSetTimeout = global.setTimeout;
const nativeClearTimeout = global.clearTimeout;
const nativeSetInterval = global.setInterval;
const nativeClearInterval = global.clearInterval;
const timers = new Set();
const intervals = new Set();
const trace = {
  sockets: [],
  desktopMessages: [],
  popupUrls: [],
  popupMessages: [],
  permissionQueries: [],
  rejectedOrigins: 0,
  proxyListeners: 0,
};
const schedule = (callback, delay = 0) => {
  const timer = nativeSetTimeout(() => {
    timers.delete(timer);
    callback();
  }, delay);
  timers.add(timer);
  return timer;
};
global.setTimeout = schedule;
global.clearTimeout = (timer) => {
  timers.delete(timer);
  nativeClearTimeout(timer);
};
global.setInterval = (callback, delay) => {
  const interval = nativeSetInterval(callback, delay);
  intervals.add(interval);
  return interval;
};
global.clearInterval = (interval) => {
  intervals.delete(interval);
  nativeClearInterval(interval);
};
const response = scenario.error
  ? { success: false, error: scenario.error }
  : {
      success: true,
      payload: { model: 'T3W1', ...(scenario.payload || {}) },
      device: { path: 'synthetic-device-path' },
    };
let heldPopupReply;
const externalListeners = new Set();
const tabs = new Map([
  [
    1,
    {
      id: 1,
      index: 0,
      url: 'chrome-extension://test-extension-id/external.html',
    },
  ],
]);
const channel = {
  here: '@trezor/suite-web',
  peer: '@trezor/connect-webextension-externally-connectable',
};
function emitExternal(message, origin = 'https://suite.trezor.io') {
  const sender = { origin, tab: { id: 2, url: `${origin}/web/connect-popup` } };
  for (const listener of externalListeners) {
    const result = listener({ channel, ...message }, sender, () => {});
    if (origin !== 'https://suite.trezor.io' && result === false)
      trace.rejectedOrigins++;
  }
}
global.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: undefined,
    getURL: (suffix) => `chrome-extension://test-extension-id/${suffix}`,
    getManifest: () => ({ manifest_version: 3 }),
    onConnect: {
      addListener() {
        trace.proxyListeners++;
      },
      removeListener() {
        trace.proxyListeners--;
      },
    },
    onMessageExternal: {
      addListener: (listener) => externalListeners.add(listener),
      removeListener: (listener) => externalListeners.delete(listener),
    },
  },
  windows: { getCurrent: (callback) => callback({ type: 'normal' }) },
  tabs: {
    query: (_query, callback) => callback([tabs.get(1)]),
    get: (id, callback) => callback(tabs.get(id)),
    create: (options, callback) => {
      trace.popupUrls.push(options.url);
      const tab = { id: 2, index: 1, url: options.url };
      tabs.set(2, tab);
      callback(tab);
    },
    update: (id, options, callback) => {
      const tab = tabs.get(id);
      if (options.url) {
        tab.url = options.url;
        const encoded = new URLSearchParams(
          new URL(options.url).hash.slice(1)
        ).get('message');
        if (encoded) {
          const message = JSON.parse(encoded);
          trace.popupMessages.push(message);
          schedule(() => {
            if (message.type === 'channel-handshake-request') {
              emitExternal({ type: 'channel-handshake-confirm' });
              emitExternal({ type: 'popup-core-loaded' });
            } else if (message.type === 'popup-handshake') {
              emitExternal({
                id: message.id,
                type: 'response',
                payload: { success: true },
              });
            } else if (message.type === 'iframe-call') {
              if (scenario.injectWrongOrigin) {
                emitExternal(
                  {
                    id: message.id,
                    type: 'response',
                    payload: { success: true, payload: { model: 'UNTRUSTED' } },
                  },
                  'https://attacker.invalid'
                );
              }
              const reply = () =>
                emitExternal({
                  id: message.id,
                  type: 'response',
                  payload: response,
                });
              if (scenario.disposePending && !heldPopupReply)
                heldPopupReply = reply;
              else schedule(reply, 5);
            }
          });
        }
      }
      callback?.(tab);
    },
    remove: (id, callback) => {
      tabs.delete(id);
      callback?.();
    },
  },
};
global.self = global;
global.origin = 'chrome-extension://test-extension-id';
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: {
    permissions: {
      query: async (query) => {
        trace.permissionQueries.push(query);
        return { state: 'granted' };
      },
    },
  },
});

class SimulatedSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    trace.sockets.push('ws://127.0.0.1:21335/connect-ws');
    schedule(() => {
      if (scenario.desktopAvailable === false) {
        this.readyState = 3;
        this.emit('error', new Error('synthetic desktop unavailable'));
      } else {
        this.readyState = 1;
        this.emit('open');
      }
    });
  }
  send(raw) {
    const message = JSON.parse(raw);
    trace.desktopMessages.push(message);
    const reply =
      message.type === 'popup-handshake'
        ? { id: message.id, type: message.type, payload: 'ok' }
        : { id: message.id, ...response };
    if (
      scenario.disposePending &&
      !heldPopupReply &&
      message.type === 'iframe-call'
    ) {
      heldPopupReply = () => this.emit('message', JSON.stringify(reply));
    } else {
      schedule(() => this.emit('message', JSON.stringify(reply)));
    }
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

(async () => {
  let connect;
  let adapterModule;
  let keyring;
  if (scenario.adapter) {
    // Patch only the network boundary. The raw Connect package is first loaded
    // by the compiled adapter's lazy CommonJS require of its ESM dependency.
    const websocketPath = require.resolve('@trezor/websocket-client', {
      paths: [require.resolve('@trezor/connect-web')],
    });
    require(websocketPath).WebsocketClient.prototype.initWebsocket = () =>
      new SimulatedSocket();
    adapterModule = require(join(
      __dirname,
      '../../dist/cjs/trezor/connect.js'
    ));
    connect = adapterModule.default;
    trace.adapterMode = true;
    trace.proxyListenersBeforeInit = trace.proxyListeners;
  } else {
    ({ default: connect } = await import(
      pathToFileURL(require.resolve('@trezor/connect-webextension')).href
    ));
    connect.implementations['core-in-suite-desktop'].ws.createWebsocket = () =>
      new SimulatedSocket();
  }
  const manifest = {
    appName: 'Pali Wallet',
    appUrl: 'https://paliwallet.com/',
    email: 'support@syscoin.org',
  };
  if (scenario.missingAppName) delete manifest.appName;
  if (scenario.keyring) {
    const { TrezorKeyring } = require(join(
      __dirname,
      '../../dist/cjs/trezor/index.js'
    ));
    keyring = new TrezorKeyring();
  }
  try {
    if (keyring) await keyring.init();
    else
      await connect.init({
        manifest,
        env: 'webextension',
        coreMode: 'auto',
        debug: false,
      });
  } catch (error) {
    trace.initializationError = { code: error.code, message: error.message };
    output(trace);
    return;
  }
  trace.socketsAfterInit = trace.sockets.length;
  trace.exposesEventEmitter = typeof connect.on === 'function';
  if (scenario.disposePending) {
    const notifications = [];
    adapterModule.subscribeTrezorEvents((event) => notifications.push(event));
    const operation = keyring
      ? keyring.getAccountInfo({ coin: 'sys', slip44: 57 })
      : connect.getFeatures();
    const request = operation.then(
      (value) => {
        trace.unexpectedLateSuccess = value;
      },
      (error) => {
        trace.cancelledError = { code: error.code, message: error.message };
      }
    );
    const until = async (predicate) => {
      const deadline = Date.now() + 2000;
      while (!predicate()) {
        if (Date.now() >= deadline)
          throw new Error('Protocol fixture timed out');
        await new Promise((resolve) => nativeSetTimeout(resolve, 5));
      }
    };
    await until(() => heldPopupReply);
    if (keyring) {
      await keyring.destroy();
      trace.keyringDestroyed = true;
    } else await connect.dispose();
    await until(() => trace.cancelledError || trace.unexpectedLateSuccess);
    trace.rejectedBeforeRemoteReply = !!trace.cancelledError;
    if (keyring) {
      try {
        await keyring.getAccountInfo({ coin: 'sys', slip44: 57 });
        trace.unexpectedBusySuccess = true;
      } catch (error) {
        trace.busyError = { code: error.code, message: error.message };
      }
    }
    trace.cancelMessages = trace.popupMessages.filter(
      (message) => message.type === 'core-call-cancel'
    ).length;
    trace.popupStillOpenAfterDispose = tabs.has(2);
    heldPopupReply();
    await new Promise((resolve) => nativeSetTimeout(resolve, 20));
    await request;
    trace.notifications = [...notifications];
    trace.remoteReplyDelivered = true;
    await connect.init({
      manifest,
      env: 'webextension',
      coreMode: 'auto',
      debug: false,
    });
    trace.reconnectedResponse = await connect.getFeatures();
    await connect.dispose();
  } else {
    trace.response = await connect.getFeatures();
    await connect.dispose();
  }
  output(trace);
})()
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const timer of timers) nativeClearTimeout(timer);
    for (const interval of intervals) nativeClearInterval(interval);
  });

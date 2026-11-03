import type {
  ConnectDynamicSettings,
  TrezorConnectPublicAPI,
} from '@trezor/connect-webextension';

type Client = TrezorConnectPublicAPI<ConnectDynamicSettings>;
const methods = [
  'getFeatures',
  'getAccountInfo',
  'ethereumGetAddress',
  'ethereumGetPublicKey',
  'getPublicKey',
  'getAddress',
  'signTransaction',
  'ethereumSignTransaction',
  'signMessage',
  'ethereumSignMessage',
  'ethereumSignTypedData',
  'verifyMessage',
  'ethereumVerifyMessage',
] as const;
type Method = (typeof methods)[number];
type Compatible<T> = T extends { success: false }
  ? T & { payload: { error: string; code?: string } }
  : T;
type CompatibleCall<FunctionType> = FunctionType extends {
  (...args: infer A): infer R;
  (...args: infer B): infer S;
  (...args: infer C): infer T;
}
  ? {
      (...args: A): Promise<Compatible<Awaited<R>>>;
      (...args: B): Promise<Compatible<Awaited<S>>>;
      (...args: C): Promise<Compatible<Awaited<T>>>;
    }
  : never;
type Calls = { [Name in Method]: CompatibleCall<Client[Name]> };
type ConnectionEvent =
  | { type: 'disconnected' }
  | { type: 'model'; model: string };
const listeners = new Set<(event: ConnectionEvent) => void>();
let clientPromise: Promise<Client> | undefined;
let generation = 0;
let initialized = false;
let cleanupPromise = Promise.resolve();
let cleanupPending = false;
const inFlight = new Set<Promise<unknown>>();
const pending = new Set<(error: Error) => void>();
const interrupted = () =>
  Object.assign(new Error('Trezor operation cancelled'), {
    code: 'Method_Interrupted',
  });
const invalidate = () => {
  generation++;
  initialized = false;
  const error = interrupted();
  for (const reject of pending) reject(error);
  pending.clear();
  emit({ type: 'disconnected' });
};

export const subscribeTrezorEvents = (
  listener: (event: ConnectionEvent) => void
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const emit = (event: ConnectionEvent) => {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Status observers must not turn a completed device call into a retry.
    }
  }
};

/** Connect 10's webextension module registers Chrome listeners on import. */
const requireExtensionHost = (): void => {
  const chrome = (globalThis as any).chrome;
  if (
    !chrome?.runtime?.id ||
    chrome.runtime.getManifest?.()?.manifest_version !== 3 ||
    typeof chrome.runtime.onConnect?.addListener !== 'function' ||
    typeof chrome.runtime.onMessageExternal?.addListener !== 'function' ||
    typeof chrome.tabs?.get !== 'function' ||
    typeof chrome.tabs?.create !== 'function' ||
    typeof chrome.tabs?.update !== 'function' ||
    typeof chrome.windows?.getCurrent !== 'function'
  ) {
    throw Object.assign(
      new Error('Trezor requires a supported MV3 extension host'),
      { code: 'HARDWARE_SIGNER_UNAVAILABLE' }
    );
  }
};
const getClient = (): Promise<Client> => {
  requireExtensionHost();
  if (!clientPromise) {
    clientPromise = import('@trezor/connect-webextension')
      .then((module) => module.default)
      .catch((error) => {
        clientPromise = undefined;
        throw error;
      });
  }
  return clientPromise;
};

/** Keep the SDK's established failure payload while preserving Connect 10 codes. */
const normalize = (response: any, method: Method): any => {
  if (response?.success === false) {
    const error = response.error;
    const code = typeof error?.code === 'string' ? error.code : undefined;
    if (
      code === 'Device_Disconnected' ||
      code === 'Device_NotFound' ||
      code === 'Desktop_ConnectionMissing' ||
      code === 'Transport_Missing'
    ) {
      invalidate();
    }
    return {
      ...response,
      payload: {
        error:
          typeof error?.message === 'string'
            ? error.message
            : 'Trezor request failed',
        code,
      },
    };
  }
  const model =
    response?.device?.features?.model ??
    (method === 'getFeatures' ? response?.payload?.model : undefined);
  if (response?.success === true && typeof model === 'string') {
    emit({ type: 'model', model });
  }
  return response;
};
const withClient = async <Result>(
  operation: (client: Client) => Promise<Result>,
  requireInitialized = true
): Promise<Result> => {
  const captured = generation;
  const assertCurrent = () => {
    if (captured !== generation) throw interrupted();
    if (requireInitialized && !initialized) {
      throw Object.assign(new Error('TrezorConnect not initialized'), {
        code: 'Init_NotInitialized',
      });
    }
  };
  assertCurrent();
  let rejectPending!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectPending = reject;
  });
  pending.add(rejectPending);
  try {
    const result = await Promise.race([
      (async () => {
        await cleanupPromise;
        assertCurrent();
        const client = await getClient();
        assertCurrent();
        const request = Promise.resolve(operation(client));
        inFlight.add(request);
        try {
          return await request;
        } finally {
          inFlight.delete(request);
        }
      })(),
      cancelled,
    ]);
    // A late response must not restore a model/status or return a signature.
    assertCurrent();
    return result;
  } finally {
    pending.delete(rejectPending);
  }
};
const calls = Object.fromEntries(
  methods.map((method) => [
    method,
    async (...args: any[]) => {
      const captured = generation;
      const response = await withClient((client) =>
        (client[method] as any)(...args)
      );
      if (captured !== generation) throw interrupted();
      return normalize(response, method);
    },
  ])
) as Calls;

const TrezorConnect: Calls & {
  init: Client['init'];
  dispose: () => Promise<void>;
} = {
  ...calls,
  async init(settings: Parameters<Client['init']>[0]): Promise<void> {
    if (cleanupPending) {
      throw Object.assign(
        new Error('Previous Trezor request is still pending'),
        {
          code: 'HARDWARE_SIGNER_BUSY',
        }
      );
    }
    invalidate();
    const captured = generation;
    await withClient(
      (client) => client.init({ ...settings, env: 'webextension' }),
      false
    );
    if (captured !== generation) throw interrupted();
    initialized = true;
  },
  dispose(): Promise<void> {
    // Invalidate synchronously, before waiting for import or remote cleanup.
    // Suite Web's upstream dispose is a no-op; local invalidation is required.
    invalidate();
    if (cleanupPending) {
      return inFlight.size ? Promise.resolve() : cleanupPromise;
    }
    const loaded = clientPromise;
    if (!loaded) return Promise.resolve();
    const outstanding = [...inFlight];
    cleanupPending = true;
    cleanupPromise = cleanupPromise
      .catch(() => undefined)
      .then(async () => {
        // Closing Desktop's socket during a raw call makes Connect auto-open
        // Suite Web. Let that raw call settle while its result stays fenced.
        await Promise.allSettled(outstanding);
        const client = await loaded;
        // Desktop cancel() discards an internal Promise in Connect 10.0.1;
        // do not invoke it or claim that Suite Web's no-op dispose closes UI.
        await client.dispose();
      })
      .finally(() => {
        cleanupPending = false;
      });
    // Deferred cleanup may outlive the caller; preserve its failure for future
    // init while preventing an unhandled rejection when the host is locking.
    void cleanupPromise.catch(() => undefined);
    return outstanding.length ? Promise.resolve() : cleanupPromise;
  },
};

export const trezorResponseError = (
  response: { payload?: { error?: string; code?: string } },
  prefix = ''
): Error =>
  Object.assign(
    new Error(prefix + (response.payload?.error || 'Trezor request failed')),
    { code: response.payload?.code }
  );

export default TrezorConnect;

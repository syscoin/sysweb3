import {
  ledgerCancelledError,
  ledgerHostError,
  type LedgerOperationOptions,
} from './host-types';

import type {
  DeviceManagementKit,
  DiscoveredDevice,
} from '@ledgerhq/device-management-kit';
import type { Observable, Subscription } from 'rxjs';

type Action<Output> = {
  observable: Observable<
    | { status: 'not-started' | 'stopped' }
    | {
        status: 'pending';
        intermediateValue: { requiredUserInteraction: string; step?: string };
      }
    | { status: 'completed'; output: Output }
    | { status: 'error'; error: unknown }
  >;
  cancel(): void;
};

export interface LedgerDmkOperation {
  readonly dmk: DeviceManagementKit;
  readonly sessionId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  runAction<Output>(createAction: () => Action<Output>): Promise<Output>;
}

/** One owner and one semantic operation at a time, across EVM and UTXO apps. */
export class LedgerDmkSession {
  private generation = 0;
  private sessionId: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private activeCancel: (() => void) | undefined;
  private activeAbort: AbortController | undefined;
  private closing: Promise<void> = Promise.resolve();
  private stateSubscription: Subscription | undefined;
  private connectionAttempt: Promise<void> | undefined;
  private connectionAbort: AbortController | undefined;
  private readonly invalidationListeners = new Set<() => void>();

  constructor(readonly dmk: DeviceManagementKit) {}

  getStatus() {
    return { connected: this.sessionId !== undefined };
  }

  onInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  private invalidate(): void {
    this.generation++;
    for (const listener of this.invalidationListeners) listener();
  }

  /** Device selection belongs to the visible host, never to a dapp request. */
  connect(
    request: { useGrantedDevices?: boolean } = {},
    options: LedgerOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) return Promise.reject(ledgerCancelledError());
    if (this.sessionId) return Promise.resolve();
    if (this.connectionAttempt)
      return Promise.reject(
        ledgerHostError(
          'HARDWARE_SIGNER_BUSY',
          'Ledger connection is already pending'
        )
      );
    const controller = new AbortController();
    this.connectionAbort = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const attempt = this.connectDevice(request, controller.signal);
    this.connectionAttempt = attempt;
    return attempt.finally(() => {
      options.signal?.removeEventListener('abort', abort);
      if (this.connectionAttempt === attempt)
        this.connectionAttempt = undefined;
      if (this.connectionAbort === controller) this.connectionAbort = undefined;
    });
  }

  private async connectDevice(
    request: { useGrantedDevices?: boolean },
    signal: AbortSignal
  ): Promise<void> {
    const generation = this.generation;
    let subscription: Subscription | undefined;
    const device = await new Promise<DiscoveredDevice>((resolve, reject) => {
      let settled = false;
      const timer = request.useGrantedDevices
        ? setTimeout(
            () =>
              finish(
                ledgerHostError(
                  'HARDWARE_SIGNER_UNAVAILABLE',
                  'Select a Ledger device in the Ledger window'
                )
              ),
            3000
          )
        : undefined;
      const finish = (error?: unknown, selected?: DiscoveredDevice) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        subscription?.unsubscribe();
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(selected!);
      };
      const onAbort = () => finish(ledgerCancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
      // Calling startDiscovering synchronously preserves the click's activation.
      const discovery: Observable<DiscoveredDevice | DiscoveredDevice[]> =
        request.useGrantedDevices
          ? this.dmk.listenToAvailableDevices({})
          : this.dmk.startDiscovering({});
      subscription = discovery.subscribe({
        next: (value) => {
          const devices = Array.isArray(value) ? value : [value];
          if (!devices.length) return;
          if (devices.length !== 1) {
            finish(
              ledgerHostError(
                'HARDWARE_SIGNER_AMBIGUOUS',
                'Select one Ledger device in the Ledger window'
              )
            );
            return;
          }
          finish(undefined, devices[0]);
        },
        error: (error) => finish(error),
        complete: () => {
          if (!settled)
            finish(
              ledgerHostError(
                'HARDWARE_SIGNER_UNAVAILABLE',
                'No Ledger device selected'
              )
            );
        },
      });
      if (settled) subscription?.unsubscribe();
    });
    if (generation !== this.generation || signal.aborted)
      throw ledgerCancelledError();
    await this.closing;
    const sessionId = await this.dmk.connect({ device });
    if (generation !== this.generation || signal.aborted) {
      await this.dmk.disconnect({ sessionId }).catch(() => undefined);
      throw ledgerCancelledError();
    }
    this.sessionId = sessionId;
    this.stateSubscription = this.dmk
      .getDeviceSessionState({ sessionId })
      .subscribe({
        complete: () => {
          if (this.sessionId === sessionId) {
            this.sessionId = undefined;
            this.invalidate();
            this.activeAbort?.abort();
            this.activeCancel?.();
          }
        },
      });
  }

  /** Cancel revokes the result and closes I/O; it cannot undo on-device approval. */
  disconnect(): Promise<void> {
    this.invalidate();
    this.connectionAbort?.abort();
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    this.activeAbort?.abort();
    this.activeAbort = undefined;
    this.activeCancel?.();
    this.activeCancel = undefined;
    this.stateSubscription?.unsubscribe();
    this.stateSubscription = undefined;
    this.closing = this.closing.then(async () => {
      if (sessionId)
        await this.dmk.disconnect({ sessionId }).catch(() => undefined);
    });
    return this.closing;
  }

  runExclusive<Output>(
    operation: (session: LedgerDmkOperation) => Promise<Output>,
    options: LedgerOperationOptions = {}
  ): Promise<Output> {
    const generation = this.generation;
    const run = async () => {
      await this.closing;
      const sessionId = this.sessionId;
      const assertCurrent = () => {
        if (generation !== this.generation || options.signal?.aborted)
          throw ledgerCancelledError();
        if (!sessionId || this.sessionId !== sessionId)
          throw ledgerHostError(
            'HARDWARE_SIGNER_UNAVAILABLE',
            'Connect a Ledger device first'
          );
      };
      assertCurrent();
      const controller = new AbortController();
      this.activeAbort = controller;
      let rejectCancellation: (error: Error) => void = () => undefined;
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancellation = reject;
      });
      controller.signal.addEventListener(
        'abort',
        () => rejectCancellation(ledgerCancelledError()),
        { once: true }
      );
      const onAbort = () => {
        rejectCancellation(ledgerCancelledError());
        void this.disconnect();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        assertCurrent();
        const context: LedgerDmkOperation = {
          dmk: this.dmk,
          sessionId: sessionId!,
          generation,
          signal: controller.signal,
          assertCurrent,
          runAction: <T>(createAction: () => Action<T>) => {
            assertCurrent();
            return this.awaitAction(createAction(), assertCurrent, options);
          },
        };
        const result = await Promise.race([operation(context), cancelled]);
        assertCurrent();
        return result;
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        if (this.activeAbort === controller) this.activeAbort = undefined;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  runAction<Output>(
    createAction: (session: LedgerDmkOperation) => Action<Output>,
    options?: LedgerOperationOptions
  ): Promise<Output> {
    return this.runExclusive(
      (session) => session.runAction(() => createAction(session)),
      options
    );
  }

  private awaitAction<Output>(
    action: Action<Output>,
    assertCurrent: () => void,
    options: LedgerOperationOptions
  ): Promise<Output> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const subscription: { current?: Subscription } = {};
      const finish = (error?: unknown, output?: Output) => {
        if (settled) return;
        settled = true;
        subscription.current?.unsubscribe();
        if (this.activeCancel === cancel) this.activeCancel = undefined;
        if (error) reject(error);
        else resolve(output as Output);
      };
      const cancel = () => {
        // cancel() may synchronously emit Stopped. Revoke this callback first
        // so that a stale-state observer cannot recursively cancel it.
        if (this.activeCancel === cancel) this.activeCancel = undefined;
        try {
          action.cancel();
        } catch {
          // The generation is already revoked; cleanup cannot revive it.
        } finally {
          finish(ledgerCancelledError());
        }
      };
      this.activeCancel = cancel;
      subscription.current = action.observable.subscribe({
        next: (state) => {
          try {
            assertCurrent();
            options.onProgress?.({
              status: state.status,
              ...(state.status === 'pending'
                ? {
                    requiredUserInteraction:
                      state.intermediateValue.requiredUserInteraction,
                    ...(typeof state.intermediateValue.step === 'string'
                      ? { step: state.intermediateValue.step }
                      : {}),
                  }
                : {}),
            });
            switch (state.status) {
              case 'completed':
                finish(undefined, state.output);
                break;
              case 'error':
                finish(
                  state.error ??
                    ledgerHostError(
                      'LEDGER_ACTION_FAILED',
                      'Ledger action failed'
                    )
                );
                break;
              case 'stopped':
                finish(ledgerCancelledError());
                break;
            }
          } catch (error) {
            // A broken progress consumer must not release our queue while the
            // device still has a signing operation in flight.
            void this.disconnect();
            finish(error);
          }
        },
        error: (error) => finish(error),
        complete: () => {
          if (!settled)
            finish(
              ledgerHostError(
                'LEDGER_INCOMPLETE_ACTION',
                'Ledger action ended without a result'
              )
            );
        },
      });
      if (settled) subscription.current.unsubscribe();
    });
  }
}

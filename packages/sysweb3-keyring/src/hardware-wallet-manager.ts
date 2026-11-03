import Transport from '@ledgerhq/hw-transport';
import HIDTransport from '@ledgerhq/hw-transport-webhid';
import { listen } from '@ledgerhq/logs';
import { EventEmitter } from 'events';

import TrezorConnect, { subscribeTrezorEvents } from './trezor/connect';

export enum HardwareWalletType {
  LEDGER = 'ledger',
  TREZOR = 'trezor',
}

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

interface ConnectionPoolEntry {
  transport?: Transport | null;
  status: ConnectionStatus;
  lastActivity: number;
  retryCount: number;
  error?: Error;
}

interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

export interface HardwareWalletStatus {
  type: HardwareWalletType;
  status: ConnectionStatus;
  connected: boolean;
  lastSeen?: number;
  error?: string;
  deviceInfo?: {
    model?: string;
    firmwareVersion?: string;
  };
}

/**
 * Hardware Wallet Manager with connection pooling, status monitoring, and error recovery
 */
export class HardwareWalletManager extends EventEmitter {
  private connectionPool: Map<string, ConnectionPoolEntry> = new Map();
  private statusMonitorInterval: NodeJS.Timeout | null = null;
  private unsubscribeTrezor?: () => void;
  private lifecycleGeneration = 0;
  private trezorInitialization?: object;
  private destruction?: Promise<void>;
  private readonly CONNECTION_TIMEOUT = 30000; // 30 seconds
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly STATUS_CHECK_INTERVAL = 5000; // 5 seconds

  private readonly retryConfig: RetryConfig = {
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 10000, // 10 seconds
    backoffMultiplier: 2,
  };

  constructor() {
    super();
    this.observeTrezor();
    this.startStatusMonitoring();

    // Set up Ledger debug logging
    if (process.env.NODE_ENV === 'development') {
      listen((log) => {
        console.log(`[Ledger] ${log.type}: ${log.message}`);
      });
    }
  }

  private observeTrezor(): void {
    if (this.unsubscribeTrezor) return;
    this.unsubscribeTrezor = subscribeTrezorEvents((event) => {
      if (event.type === 'disconnected') {
        // Our pre-init disposal and Connect initialization invalidate the
        // adapter too. Keep this attempt owned until it settles or is revoked.
        if (
          this.connectionPool.get('trezor-default')?.status ===
          ConnectionStatus.CONNECTING
        )
          return;
        this.handleDisconnect('trezor-default', HardwareWalletType.TREZOR);
      }
    });
  }

  /**
   * Get or create a Ledger connection with retry logic
   */
  async getLedgerConnection(): Promise<Transport> {
    const key = `${HardwareWalletType.LEDGER}-default`;
    const existing = this.connectionPool.get(key);

    if (existing?.transport && existing.status === ConnectionStatus.CONNECTED) {
      existing.lastActivity = Date.now();
      return existing.transport;
    }

    return this.createLedgerConnectionWithRetry(key);
  }

  /**
   * Create Ledger connection with exponential backoff retry
   */
  private async createLedgerConnectionWithRetry(
    key: string
  ): Promise<Transport> {
    const entry: ConnectionPoolEntry = {
      status: ConnectionStatus.CONNECTING,
      lastActivity: Date.now(),
      retryCount: 0,
    };
    this.connectionPool.set(key, entry);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        this.emit('connectionAttempt', {
          type: HardwareWalletType.LEDGER,
          attempt: attempt + 1,
          maxAttempts: this.retryConfig.maxRetries + 1,
        });

        const transport = await this.createLedgerTransport();

        entry.transport = transport;
        entry.status = ConnectionStatus.CONNECTED;
        entry.retryCount = 0;
        entry.error = undefined;

        this.emit('connected', { type: HardwareWalletType.LEDGER });

        // Set up disconnect handler
        transport.on('disconnect', () => {
          this.handleDisconnect(key, HardwareWalletType.LEDGER);
        });

        return transport;
      } catch (error) {
        lastError = error as Error;
        entry.retryCount = attempt + 1;
        entry.error = lastError;

        if (attempt < this.retryConfig.maxRetries) {
          const delay = this.calculateBackoffDelay(attempt);

          this.emit('retrying', {
            type: HardwareWalletType.LEDGER,
            attempt: attempt + 1,
            nextRetryIn: delay,
            error: lastError.message,
          });

          await this.delay(delay);
        }
      }
    }

    entry.status = ConnectionStatus.ERROR;
    this.emit('connectionFailed', {
      type: HardwareWalletType.LEDGER,
      error: lastError?.message,
    });

    throw new Error(
      `Failed to connect to Ledger after ${
        this.retryConfig.maxRetries + 1
      } attempts: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Create Ledger transport with timeout
   */
  private async createLedgerTransport(): Promise<Transport> {
    return Promise.race([
      HIDTransport.create(),
      this.createTimeoutPromise<Transport>(
        this.CONNECTION_TIMEOUT,
        'Ledger connection timeout'
      ),
    ]);
  }

  /**
   * Initialize Trezor with retry logic
   */
  async initializeTrezor(): Promise<boolean> {
    if (this.destruction) {
      throw Object.assign(new Error('Trezor connection is closing'), {
        code: 'Method_Interrupted',
      });
    }
    const generation = this.lifecycleGeneration;
    this.observeTrezor();
    this.startStatusMonitoring();
    const key = `${HardwareWalletType.TREZOR}-default`;
    const existing = this.connectionPool.get(key);

    if (existing?.status === ConnectionStatus.CONNECTED) {
      existing.lastActivity = Date.now();
      return true;
    }

    // Check if we're already trying to connect
    if (
      this.trezorInitialization ||
      existing?.status === ConnectionStatus.CONNECTING
    ) {
      console.log(
        '[HardwareWalletManager] Trezor connection already in progress'
      );
      // Wait a bit and check again
      await this.delay(1000);
      if (generation !== this.lifecycleGeneration || this.destruction)
        return false;
      const updated = this.connectionPool.get(key);
      return updated?.status === ConnectionStatus.CONNECTED || false;
    }

    const owner = {};
    this.trezorInitialization = owner;
    try {
      return await this.initializeTrezorWithRetry(key, owner, generation);
    } finally {
      if (this.trezorInitialization === owner)
        this.trezorInitialization = undefined;
    }
  }

  /**
   * Initialize Trezor with exponential backoff retry
   */
  private async initializeTrezorWithRetry(
    key: string,
    owner: object,
    generation: number
  ): Promise<boolean> {
    const entry: ConnectionPoolEntry = {
      status: ConnectionStatus.CONNECTING,
      lastActivity: Date.now(),
      retryCount: 0,
    };
    this.connectionPool.set(key, entry);
    const isCurrent = () =>
      generation === this.lifecycleGeneration &&
      this.trezorInitialization === owner &&
      this.connectionPool.get(key) === entry &&
      !this.destruction;

    let lastError: Error | undefined;

    // Reduce retry attempts for Trezor to prevent repeated popups
    const trezorRetryConfig = {
      ...this.retryConfig,
      maxRetries: 1, // Only retry once for Trezor
    };

    for (let attempt = 0; attempt <= trezorRetryConfig.maxRetries; attempt++) {
      if (!isCurrent()) return false;
      try {
        this.emit('connectionAttempt', {
          type: HardwareWalletType.TREZOR,
          attempt: attempt + 1,
          maxAttempts: trezorRetryConfig.maxRetries + 1,
        });
        if (!isCurrent()) return false;

        // Dispose the previous Suite connection before initialization
        try {
          await TrezorConnect.dispose();
        } catch (disposeError) {
          console.log(
            '[HardwareWalletManager] Dispose error (safe to ignore):',
            disposeError
          );
        }
        if (!isCurrent()) return false;

        await TrezorConnect.init({
          manifest: {
            appName: 'Pali Wallet',
            appUrl: 'https://paliwallet.com/',
            email: 'support@syscoin.org',
          },
          debug: false, // Disable debug mode to prevent extra logs
          // Connect chooses Suite Desktop, then the supported Suite Web fallback.
          coreMode: 'auto',
        });
        if (!isCurrent()) return false;

        entry.status = ConnectionStatus.CONNECTED;
        entry.retryCount = 0;
        entry.error = undefined;

        this.emit('connected', { type: HardwareWalletType.TREZOR });

        return isCurrent();
      } catch (error) {
        // Teardown or a newer owner revoked this attempt. Its continuation
        // must not mutate status, retry, or dispose the newer connection.
        if (!isCurrent()) return false;
        lastError = error as Error;
        if ((lastError as any).code === 'HARDWARE_SIGNER_BUSY') {
          entry.status = ConnectionStatus.ERROR;
          entry.error = lastError;
          this.emit('connectionFailed', {
            type: HardwareWalletType.TREZOR,
            error: lastError.message,
          });
          throw lastError;
        }
        if ((lastError as any).code === 'HARDWARE_SIGNER_UNAVAILABLE') break;

        // Check if already initialized - this is actually OK
        if (
          lastError.message.includes(
            'TrezorConnect has been already initialized'
          )
        ) {
          // Instead of just marking as connected, verify the connection
          try {
            // Test the connection with a simple call
            const testResponse = await TrezorConnect.getFeatures();
            if (!isCurrent()) return false;
            if (testResponse.success) {
              entry.status = ConnectionStatus.CONNECTED;
              entry.retryCount = 0;
              entry.error = undefined;
              this.emit('connected', { type: HardwareWalletType.TREZOR });
              return isCurrent();
            }
          } catch (testError) {
            console.log(
              '[HardwareWalletManager] Trezor test connection failed:',
              testError
            );
          }
          if (!isCurrent()) return false;

          // If test failed, dispose and retry
          try {
            await TrezorConnect.dispose();
            if (!isCurrent()) return false;
            await this.delay(500);
          } catch (disposeError) {
            console.log(
              '[HardwareWalletManager] Error disposing for retry:',
              disposeError
            );
          }
          if (!isCurrent()) return false;
        }

        entry.retryCount = attempt + 1;
        entry.error = lastError;

        // Check for specific Trezor errors
        if (
          lastError.message.includes('device is already in use') ||
          lastError.message.includes('Device is being used in another window')
        ) {
          console.log(
            '[HardwareWalletManager] Trezor device is in use by another application'
          );

          // Try to dispose and reinitialize
          try {
            await TrezorConnect.dispose();
            if (!isCurrent()) return false;
            await this.delay(2000); // Wait 2 seconds before retry
          } catch (disposeError) {
            console.log(
              '[HardwareWalletManager] Error during dispose:',
              disposeError
            );
          }
          if (!isCurrent()) return false;
        }

        // Don't retry if user cancelled
        if (this.isUserCancellationError(lastError)) {
          console.log(
            '[HardwareWalletManager] User cancelled Trezor connection'
          );
          break; // Exit retry loop
        }

        if (attempt < trezorRetryConfig.maxRetries) {
          const delay = this.calculateBackoffDelay(attempt);

          this.emit('retrying', {
            type: HardwareWalletType.TREZOR,
            attempt: attempt + 1,
            nextRetryIn: delay,
            error: lastError.message,
          });

          await this.delay(delay);
          if (!isCurrent()) return false;
        }
      }
    }

    if (!isCurrent()) return false;
    entry.status = ConnectionStatus.ERROR;
    this.emit('connectionFailed', {
      type: HardwareWalletType.TREZOR,
      error: lastError?.message,
    });
    if (!isCurrent()) return false;

    // Clean up on failure
    try {
      await TrezorConnect.dispose();
    } catch (disposeError) {
      console.log(
        '[HardwareWalletManager] Failed to dispose on error:',
        disposeError
      );
    }

    return false;
  }

  /**
   * Handle device disconnect
   */
  private handleDisconnect(key: string, type: HardwareWalletType): void {
    const entry = this.connectionPool.get(key);
    if (entry) {
      entry.status = ConnectionStatus.DISCONNECTED;
      entry.transport = null;
      this.emit('disconnected', { type });
    }
  }

  /**
   * Start real-time status monitoring
   */
  private startStatusMonitoring(): void {
    if (this.statusMonitorInterval) {
      return;
    }

    this.statusMonitorInterval = setInterval(() => {
      this.checkAllConnections();
    }, this.STATUS_CHECK_INTERVAL);
  }

  /**
   * Check all connections and clean up idle ones
   */
  private async checkAllConnections(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const isCurrent = () =>
      generation === this.lifecycleGeneration && !this.destruction;
    if (!isCurrent()) return;
    const now = Date.now();
    const statuses: HardwareWalletStatus[] = [];

    for (const [key, entry] of this.connectionPool.entries()) {
      if (!isCurrent()) return;
      const type = key.startsWith(HardwareWalletType.LEDGER)
        ? HardwareWalletType.LEDGER
        : HardwareWalletType.TREZOR;

      // Clean up idle connections
      if (
        entry.status === ConnectionStatus.CONNECTED &&
        now - entry.lastActivity > this.IDLE_TIMEOUT
      ) {
        await this.closeConnection(key, entry);
        if (!isCurrent()) return;
        continue;
      }

      // Build status
      const status: HardwareWalletStatus = {
        type,
        status: entry.status,
        connected: entry.status === ConnectionStatus.CONNECTED,
        lastSeen: entry.lastActivity,
        error: entry.error?.message,
      };

      statuses.push(status);
    }

    if (isCurrent()) this.emit('statusUpdate', statuses);
  }

  /**
   * Get current status of all hardware wallets
   */
  getStatus(): HardwareWalletStatus[] {
    const statuses: HardwareWalletStatus[] = [];

    // Check Ledger
    const ledgerEntry = this.connectionPool.get(
      `${HardwareWalletType.LEDGER}-default`
    );
    statuses.push({
      type: HardwareWalletType.LEDGER,
      status: ledgerEntry?.status || ConnectionStatus.DISCONNECTED,
      connected: ledgerEntry?.status === ConnectionStatus.CONNECTED,
      lastSeen: ledgerEntry?.lastActivity,
      error: ledgerEntry?.error?.message,
    });

    // Check Trezor
    const trezorEntry = this.connectionPool.get(
      `${HardwareWalletType.TREZOR}-default`
    );
    statuses.push({
      type: HardwareWalletType.TREZOR,
      status: trezorEntry?.status || ConnectionStatus.DISCONNECTED,
      connected: trezorEntry?.status === ConnectionStatus.CONNECTED,
      lastSeen: trezorEntry?.lastActivity,
      error: trezorEntry?.error?.message,
    });

    return statuses;
  }

  /**
   * Check if a specific device is connected
   */
  isConnected(type: HardwareWalletType): boolean {
    const key = `${type}-default`;
    const entry = this.connectionPool.get(key);
    return entry?.status === ConnectionStatus.CONNECTED;
  }

  /**
   * Ensure connection before operation
   */
  async ensureConnection(type: HardwareWalletType): Promise<void> {
    if (type === HardwareWalletType.LEDGER) {
      await this.getLedgerConnection();
    } else if (type === HardwareWalletType.TREZOR) {
      const initialized = await this.initializeTrezor();
      if (!initialized) {
        throw new Error('Failed to initialize Trezor');
      }
    }
  }

  /**
   * Close a specific connection
   */
  private async closeConnection(
    key: string,
    entry = this.connectionPool.get(key)
  ): Promise<void> {
    if (!entry || this.connectionPool.get(key) !== entry) return;

    // Handle Trezor connections
    if (key.startsWith(HardwareWalletType.TREZOR)) {
      try {
        await TrezorConnect.dispose();
      } catch (error) {
        console.error('Error disposing Trezor:', error);
      }
    }

    // Handle Ledger connections
    if (entry?.transport) {
      try {
        await entry.transport.close();
      } catch (error) {
        console.error('Error closing transport:', error);
      }
    }

    if (this.connectionPool.get(key) === entry) this.connectionPool.delete(key);
  }

  /**
   * Close all connections and stop monitoring
   */
  destroy(): Promise<void> {
    if (this.destruction) return this.destruction;
    // Revoke pending initialization synchronously, before closing any transport.
    this.lifecycleGeneration++;
    this.trezorInitialization = undefined;
    this.unsubscribeTrezor?.();
    this.unsubscribeTrezor = undefined;
    // Stop monitoring
    if (this.statusMonitorInterval) {
      clearInterval(this.statusMonitorInterval);
      this.statusMonitorInterval = null;
    }

    const entries = [...this.connectionPool.entries()];
    const trezor = this.connectionPool.get('trezor-default');
    if (trezor) trezor.status = ConnectionStatus.DISCONNECTED;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const destruction = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.destruction = destruction;
    // Start synchronously after installing the gate. Trezor disposal revokes
    // queued replies before this method returns, even if Ledger teardown waits.
    const ordered = [
      ...entries.filter(([key]) => key.startsWith(HardwareWalletType.TREZOR)),
      ...entries.filter(([key]) => !key.startsWith(HardwareWalletType.TREZOR)),
    ];
    const close = async () => {
      try {
        for (const [key, entry] of ordered) {
          await this.closeConnection(key, entry);
        }
        this.removeAllListeners();
      } finally {
        if (this.destruction === destruction) this.destruction = undefined;
      }
    };
    void close().then(resolve, reject);
    return destruction;
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoffDelay(attempt: number): number {
    const delay = Math.min(
      this.retryConfig.baseDelay *
        Math.pow(this.retryConfig.backoffMultiplier, attempt),
      this.retryConfig.maxDelay
    );
    // Add jitter (±20%)
    const jitter = delay * 0.2 * (Math.random() - 0.5);
    return Math.round(delay + jitter);
  }

  /**
   * Create a timeout promise
   */
  private createTimeoutPromise<T>(ms: number, message: string): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Retry an operation with exponential backoff
   */
  async retryOperation<T>(
    operation: () => Promise<T>,
    operationName: string,
    customRetryConfig?: Partial<RetryConfig>
  ): Promise<T> {
    const config = { ...this.retryConfig, ...customRetryConfig };
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // Do not retry on explicit user cancellations (Ledger/Trezor)
        if (this.isUserCancellationError(lastError)) {
          throw lastError;
        }

        if (attempt < config.maxRetries) {
          const delay = this.calculateBackoffDelay(attempt);

          this.emit('operationRetry', {
            operation: operationName,
            attempt: attempt + 1,
            nextRetryIn: delay,
            error: lastError.message,
          });

          await this.delay(delay);
        }
      }
    }

    throw new Error(
      `${operationName} failed after ${config.maxRetries + 1} attempts: ${
        lastError?.message || 'Unknown error'
      }`
    );
  }

  /**
   * Detects common user-cancellation errors to avoid pointless retries
   */
  private isUserCancellationError(err: Error): boolean {
    const message = (err?.message || '').toLowerCase();
    const name = (err as any)?.name || '';
    const statusCode = (err as any)?.statusCode;
    const code = (err as any)?.code;
    if (
      code === 'HARDWARE_SIGNER_UNAVAILABLE' ||
      code === 'HARDWARE_SIGNER_BUSY' ||
      code === 'Method_Cancel' ||
      code === 'Method_Interrupted' ||
      code === 'Method_PermissionsNotGranted' ||
      code === 'Method_Unsupported' ||
      code === 'Method_UnsupportedCoinForHost' ||
      code === 'Device_Disconnected' ||
      code === 'Device_NotFound' ||
      code === 'Device_CallInProgress' ||
      code === 'Transport_Missing' ||
      code === 'Desktop_ConnectionMissing' ||
      code === 'Browser_LocalNetworkPermissionMissing'
    )
      return true;

    // Ledger: 0x6985 (Conditions of use not satisfied) on rejection
    if (statusCode === 0x6985) return true;

    // Message-based heuristics across vendors
    if (
      message.includes('0x6985') ||
      (message.includes('condition') &&
        message.includes('not') &&
        message.includes('satisf')) ||
      message.includes('not allowed') ||
      message.includes('permission denied') ||
      message.includes('permissions not granted') ||
      message.includes('user rejected') ||
      message.includes('denied by the user') ||
      message.includes('failure_actioncancelled') ||
      message.includes('denied') ||
      message.includes('rejected') ||
      message.includes('refused') ||
      message.includes('cancelled') ||
      message.includes('canceled') ||
      message.includes('popup closed')
    ) {
      return true;
    }

    // Name-based checks (align with frontend utilities)
    if (
      name === 'NotAllowedError' ||
      name === 'AbortError' ||
      name === 'UserCancel' ||
      name === 'TransportError' ||
      name === 'DOMException'
    ) {
      return true;
    }

    return false;
  }
}

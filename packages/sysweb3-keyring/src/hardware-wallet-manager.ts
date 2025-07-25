import Transport from '@ledgerhq/hw-transport';
import HIDTransport from '@ledgerhq/hw-transport-webhid';
import { listen } from '@ledgerhq/logs';
import TrezorConnect from '@trezor/connect-webextension';
import { EventEmitter } from 'events';

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
    this.startStatusMonitoring();

    // Set up Ledger debug logging
    if (process.env.NODE_ENV === 'development') {
      listen((log) => {
        console.log(`[Ledger] ${log.type}: ${log.message}`);
      });
    }
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
    const key = `${HardwareWalletType.TREZOR}-default`;
    const existing = this.connectionPool.get(key);

    if (existing?.status === ConnectionStatus.CONNECTED) {
      existing.lastActivity = Date.now();
      return true;
    }

    // Check if we're already trying to connect
    if (existing?.status === ConnectionStatus.CONNECTING) {
      console.log(
        '[HardwareWalletManager] Trezor connection already in progress'
      );
      // Wait a bit and check again
      await this.delay(1000);
      const updated = this.connectionPool.get(key);
      return updated?.status === ConnectionStatus.CONNECTED || false;
    }

    return this.initializeTrezorWithRetry(key);
  }

  /**
   * Initialize Trezor with exponential backoff retry
   */
  private async initializeTrezorWithRetry(key: string): Promise<boolean> {
    const entry: ConnectionPoolEntry = {
      status: ConnectionStatus.CONNECTING,
      lastActivity: Date.now(),
      retryCount: 0,
    };
    this.connectionPool.set(key, entry);

    let lastError: Error | undefined;

    // Reduce retry attempts for Trezor to prevent repeated popups
    const trezorRetryConfig = {
      ...this.retryConfig,
      maxRetries: 1, // Only retry once for Trezor
    };

    for (let attempt = 0; attempt <= trezorRetryConfig.maxRetries; attempt++) {
      try {
        this.emit('connectionAttempt', {
          type: HardwareWalletType.TREZOR,
          attempt: attempt + 1,
          maxAttempts: trezorRetryConfig.maxRetries + 1,
        });

        // Dispose any existing iframe before initialization
        try {
          await TrezorConnect.dispose();
        } catch (disposeError) {
          console.log(
            '[HardwareWalletManager] Dispose error (safe to ignore):',
            disposeError
          );
        }

        await TrezorConnect.init({
          manifest: {
            appUrl: 'https://paliwallet.com/',
            email: 'support@syscoin.org',
          },
          lazyLoad: true,
          popup: true,
          connectSrc: 'https://connect.trezor.io/9/',
          _extendWebextensionLifetime: true,
          transports: ['BridgeTransport', 'WebUsbTransport'],
          debug: false, // Disable debug mode to prevent extra logs
          coreMode: 'popup', // Use popup mode for webUSB support in Chrome extension
        });

        entry.status = ConnectionStatus.CONNECTED;
        entry.retryCount = 0;
        entry.error = undefined;

        this.emit('connected', { type: HardwareWalletType.TREZOR });

        // Set up device event listeners
        TrezorConnect.on('DEVICE_EVENT', (event: any) => {
          if (event.type === 'device-disconnect') {
            this.handleDisconnect(key, HardwareWalletType.TREZOR);
          }
        });

        return true;
      } catch (error) {
        lastError = error as Error;

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
            if (testResponse.success) {
              entry.status = ConnectionStatus.CONNECTED;
              entry.retryCount = 0;
              entry.error = undefined;
              this.emit('connected', { type: HardwareWalletType.TREZOR });
              return true;
            }
          } catch (testError) {
            console.log(
              '[HardwareWalletManager] Trezor test connection failed:',
              testError
            );
          }

          // If test failed, dispose and retry
          try {
            await TrezorConnect.dispose();
            await this.delay(500);
          } catch (disposeError) {
            console.log(
              '[HardwareWalletManager] Error disposing for retry:',
              disposeError
            );
          }
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
            await this.delay(2000); // Wait 2 seconds before retry
          } catch (disposeError) {
            console.log(
              '[HardwareWalletManager] Error during dispose:',
              disposeError
            );
          }
        }

        // Don't retry if user cancelled
        if (
          lastError.message.includes('Popup closed') ||
          lastError.message.includes('cancelled') ||
          lastError.message.includes('denied')
        ) {
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
        }
      }
    }

    entry.status = ConnectionStatus.ERROR;
    this.emit('connectionFailed', {
      type: HardwareWalletType.TREZOR,
      error: lastError?.message,
    });

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
    const now = Date.now();
    const statuses: HardwareWalletStatus[] = [];

    for (const [key, entry] of this.connectionPool.entries()) {
      const type = key.startsWith(HardwareWalletType.LEDGER)
        ? HardwareWalletType.LEDGER
        : HardwareWalletType.TREZOR;

      // Clean up idle connections
      if (
        entry.status === ConnectionStatus.CONNECTED &&
        now - entry.lastActivity > this.IDLE_TIMEOUT
      ) {
        await this.closeConnection(key);
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

    this.emit('statusUpdate', statuses);
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
  private async closeConnection(key: string): Promise<void> {
    const entry = this.connectionPool.get(key);

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

    this.connectionPool.delete(key);
  }

  /**
   * Close all connections and stop monitoring
   */
  async destroy(): Promise<void> {
    // Stop monitoring
    if (this.statusMonitorInterval) {
      clearInterval(this.statusMonitorInterval);
      this.statusMonitorInterval = null;
    }

    // Close all connections
    for (const key of this.connectionPool.keys()) {
      await this.closeConnection(key);
    }

    this.removeAllListeners();
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
}

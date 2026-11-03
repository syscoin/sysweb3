import {
  HardwareWalletManager,
  HardwareWalletType,
} from '../../../src/hardware-wallet-manager';
import {
  ledgerHostError,
  type LedgerHost,
} from '../../../src/ledger/host-types';

const fixture = (initiallyConnected = false) => {
  let connected = initiallyConnected;
  const host: LedgerHost = {
    connect: jest.fn(async () => {
      connected = true;
    }),
    disconnect: jest.fn(async () => {
      connected = false;
    }),
    getStatus: () => ({ connected }),
    evm: {} as LedgerHost['evm'],
    utxo: {} as LedgerHost['utxo'],
  };
  return {
    host,
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
};
const held = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const managers: HardwareWalletManager[] = [];
const manager = (host?: LedgerHost) => {
  const value = new HardwareWalletManager(host);
  managers.push(value);
  return value;
};
afterEach(async () => {
  for (const value of managers.splice(0)) await value.destroy();
});

describe('semantic Ledger host boundary', () => {
  it('fails closed without an injected host instead of opening a raw transport', async () => {
    const value = manager();
    await expect(
      value.ensureConnection(HardwareWalletType.LEDGER)
    ).rejects.toMatchObject({ code: 'HARDWARE_SIGNER_UNAVAILABLE' });
    await expect(value.getLedgerConnection()).rejects.toMatchObject({
      code: 'HARDWARE_SIGNER_UNAVAILABLE',
    });
    expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(false);
  });

  it('delegates only granted-device connection to the host and reflects its live status', async () => {
    const current = fixture();
    const value = manager(current.host);
    await value.ensureConnection(HardwareWalletType.LEDGER);
    expect(current.host.connect).toHaveBeenCalledTimes(1);
    expect(current.host.connect).toHaveBeenCalledWith({
      useGrantedDevices: true,
    });
    expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(true);
    expect(value.getStatus()).toContainEqual(
      expect.objectContaining({
        type: 'ledger',
        connected: true,
        status: 'connected',
      })
    );
    await value.ensureConnection(HardwareWalletType.LEDGER);
    expect(current.host.connect).toHaveBeenCalledTimes(1);
    current.setConnected(false);
    expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(false);
    expect(value.getStatus()).toContainEqual(
      expect.objectContaining({
        type: 'ledger',
        connected: false,
        status: 'disconnected',
      })
    );
    await expect(value.getLedgerConnection()).rejects.toMatchObject({
      code: 'HARDWARE_SIGNER_UNAVAILABLE',
    });
  });

  it('coalesces connection requests without a second host prompt', async () => {
    const current = fixture();
    const pending = held();
    (current.host.connect as jest.Mock).mockImplementation(async () => {
      await pending.promise;
      current.setConnected(true);
    });
    const value = manager(current.host);
    const first = value.ensureConnection(HardwareWalletType.LEDGER);
    const second = value.ensureConnection(HardwareWalletType.LEDGER);
    await tick();
    expect(current.host.connect).toHaveBeenCalledTimes(1);
    pending.resolve();
    await Promise.all([first, second]);
    expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(true);
  });

  it('rejects a late connection after destruction without reviving its entry', async () => {
    const current = fixture();
    const pending = held();
    (current.host.connect as jest.Mock).mockImplementationOnce(async () => {
      await pending.promise;
    });
    const value = manager(current.host);
    const first = value.ensureConnection(HardwareWalletType.LEDGER);
    const rejected = expect(first).rejects.toMatchObject({
      code: 'HARDWARE_REQUEST_CANCELLED',
    });
    await tick();
    await value.destroy();
    pending.resolve();
    await rejected;
    expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(false);
    await value.ensureConnection(HardwareWalletType.LEDGER);
    expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(true);
  });

  it('revokes status synchronously and shares host cleanup completion', async () => {
    const current = fixture(true);
    const cleanup = held();
    (current.host.disconnect as jest.Mock).mockImplementationOnce(
      () => cleanup.promise
    );
    const value = manager(current.host);
    const destroying = value.destroy();
    expect(value.destroy()).toBe(destroying);
    expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(false);
    await expect(
      value.ensureConnection(HardwareWalletType.LEDGER)
    ).rejects.toMatchObject({ code: 'HARDWARE_REQUEST_CANCELLED' });
    cleanup.resolve();
    current.setConnected(false);
    await destroying;
    expect(current.host.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects a host selected outside the manager even without a pool entry', async () => {
    const current = fixture(true);
    const value = manager(current.host);
    await value.destroy();
    expect(current.host.disconnect).toHaveBeenCalledTimes(1);
    expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(false);
  });

  it('does not retry a refused host connection', async () => {
    const current = fixture();
    const failure = ledgerHostError('HARDWARE_REQUEST_CANCELLED', 'Cancelled');
    (current.host.connect as jest.Mock).mockRejectedValue(failure);
    const value = manager(current.host);
    await expect(
      value.ensureConnection(HardwareWalletType.LEDGER)
    ).rejects.toBe(failure);
    await tick();
    expect(current.host.connect).toHaveBeenCalledTimes(1);
  });

  it.each([
    'HARDWARE_REQUEST_CANCELLED',
    'HARDWARE_CLEAR_SIGNING_UNAVAILABLE',
    'HARDWARE_ACCOUNT_MISMATCH',
    'LEDGER_INVALID_REQUEST',
    'LEDGER_INVALID_RESPONSE',
    'LEDGER_INVALID_SIGNATURE',
  ])('never retries terminal host error %s', async (code) => {
    const value = manager();
    const failure = ledgerHostError(code, 'Terminal host failure');
    const operation = jest.fn().mockRejectedValue(failure);
    await expect(value.retryOperation(operation, 'fixture')).rejects.toBe(
      failure
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

it('revokes Ledger in the same call stack after Trezor revocation without waiting for Trezor cleanup', async () => {
  const TrezorConnect = require('../../../src/trezor/connect').default;
  const trezorCleanup = held();
  const order: string[] = [];
  const dispose = jest
    .spyOn(TrezorConnect, 'dispose')
    .mockImplementationOnce(() => {
      order.push('trezor');
      return trezorCleanup.promise;
    });
  const current = fixture(true);
  (current.host.disconnect as jest.Mock).mockImplementationOnce(async () => {
    order.push('ledger');
    current.setConnected(false);
  });
  const value = manager(current.host);
  (value as any).connectionPool.set('trezor-default', {
    status: 'connected',
    lastActivity: Date.now(),
    retryCount: 0,
  });
  const closing = value.destroy();
  expect(order).toEqual(['trezor', 'ledger']);
  expect(value.isConnected(HardwareWalletType.LEDGER)).toBe(false);
  trezorCleanup.resolve();
  await closing;
  dispose.mockRestore();
});

it('installs connection ownership before a synchronous observer can re-enter', async () => {
  const current = fixture();
  const value = manager(current.host);
  let second: Promise<void> | undefined;
  value.once('connectionAttempt', () => {
    second = value.ensureConnection(HardwareWalletType.LEDGER);
  });
  await value.ensureConnection(HardwareWalletType.LEDGER);
  await second;
  expect(current.host.connect).toHaveBeenCalledTimes(1);
});

it('does not open a connection when destruction overtakes its queued start', async () => {
  const current = fixture();
  const value = manager(current.host);
  const pending = value.ensureConnection(HardwareWalletType.LEDGER);
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'HARDWARE_REQUEST_CANCELLED',
  });
  await value.destroy();
  await rejected;
  expect(current.host.connect).not.toHaveBeenCalled();
});

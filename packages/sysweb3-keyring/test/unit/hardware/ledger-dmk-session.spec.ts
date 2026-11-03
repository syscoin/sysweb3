import { of, Subject } from 'rxjs';

import { LedgerDmkSession } from '../../../src/ledger/dmk-session';

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const mockDmk = () => {
  const state = new Subject<any>();
  const discovered = new Subject<any[]>();
  const dmk = {
    startDiscovering: jest.fn(() =>
      of({ id: 'selected', transport: 'WEB-HID' })
    ),
    listenToAvailableDevices: jest.fn(() => discovered),
    connect: jest.fn().mockResolvedValue('session'),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getDeviceSessionState: jest.fn(() => state),
  };
  return { dmk, state, discovered, session: new LedgerDmkSession(dmk as any) };
};

describe('Ledger DMK session ownership', () => {
  it('connects the selected device and refuses concurrent pickers', async () => {
    const { dmk, session } = mockDmk();
    const pending = new Subject<any>();
    dmk.startDiscovering.mockReturnValue(pending as any);
    const connection = session.connect();
    await expect(session.connect()).rejects.toMatchObject({
      code: 'HARDWARE_SIGNER_BUSY',
    });
    pending.next({ id: 'chosen', transport: 'WEB-HID' });
    await connection;
    expect(dmk.connect).toHaveBeenCalledWith({
      device: { id: 'chosen', transport: 'WEB-HID' },
    });
    await session.disconnect();
  });

  it('waits past the initial empty granted-device emission and rejects ambiguity', async () => {
    const { dmk, discovered, session } = mockDmk();
    const connection = session.connect({ useGrantedDevices: true });
    discovered.next([]);
    expect(dmk.connect).not.toHaveBeenCalled();
    discovered.next([{ id: 'one' }, { id: 'two' }]);
    await expect(connection).rejects.toMatchObject({
      code: 'HARDWARE_SIGNER_AMBIGUOUS',
    });
    expect(dmk.startDiscovering).not.toHaveBeenCalled();
  });

  it('serializes complete operations rather than their individual APDUs', async () => {
    const { session } = mockDmk();
    await session.connect();
    const first = new Subject<any>();
    const second = new Subject<any>();
    const createFirst = jest.fn(() => ({
      observable: first,
      cancel: jest.fn(),
    }));
    const createSecond = jest.fn(() => ({
      observable: second,
      cancel: jest.fn(),
    }));
    const p1 = session.runAction(createFirst);
    const p2 = session.runAction(createSecond);
    await tick();
    expect(createFirst).toHaveBeenCalledTimes(1);
    expect(createSecond).not.toHaveBeenCalled();
    first.next({ status: 'completed', output: 'first' });
    await expect(p1).resolves.toBe('first');
    await tick();
    expect(createSecond).toHaveBeenCalledTimes(1);
    second.next({ status: 'completed', output: 'second' });
    await expect(p2).resolves.toBe('second');
    await session.disconnect();
  });

  it('aborts active I/O, ignores late output, and revokes queued requests', async () => {
    const { session, dmk } = mockDmk();
    await session.connect();
    const result = new Subject<any>();
    const cancel = jest.fn();
    const signal = new AbortController();
    const first = session.runAction(() => ({ observable: result, cancel }), {
      signal: signal.signal,
    });
    const queuedFactory = jest.fn(() => ({
      observable: of({ status: 'completed' as const, output: 'stale' }),
      cancel: jest.fn(),
    }));
    const queued = session.runAction(queuedFactory);
    await tick();
    signal.abort();
    result.next({ status: 'completed', output: 'late signature' });
    await expect(first).rejects.toMatchObject({
      code: 'HARDWARE_REQUEST_CANCELLED',
    });
    await expect(queued).rejects.toMatchObject({
      code: 'HARDWARE_REQUEST_CANCELLED',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(dmk.disconnect).toHaveBeenCalledTimes(1);
    expect(queuedFactory).not.toHaveBeenCalled();
  });

  it('never creates a new device action from a cancelled async continuation', async () => {
    const { session } = mockDmk();
    await session.connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = jest.fn(() => ({
      observable: of({ status: 'completed' as const, output: 'bad' }),
      cancel: jest.fn(),
    }));
    const pending = session.runExclusive(async (operation) => {
      await gate;
      return operation.runAction(factory);
    });
    await tick();
    await session.disconnect();
    release();
    await expect(pending).rejects.toMatchObject({
      code: 'HARDWARE_REQUEST_CANCELLED',
    });
    await tick();
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects an observable that completes without a terminal result', async () => {
    const { session } = mockDmk();
    await session.connect();
    const result = new Subject<any>();
    const pending = session.runAction(() => ({
      observable: result,
      cancel: jest.fn(),
    }));
    await tick();
    result.complete();
    await expect(pending).rejects.toMatchObject({
      code: 'LEDGER_INCOMPLETE_ACTION',
    });
    await session.disconnect();
  });

  it('closes the session if a progress consumer fails, without recursive cancellation', async () => {
    const { session, dmk } = mockDmk();
    await session.connect();
    const result = new Subject<any>();
    const cancel = jest.fn(() => result.next({ status: 'stopped' }));
    const pending = session.runAction(() => ({ observable: result, cancel }), {
      onProgress: () => {
        throw new Error('closed UI');
      },
    });
    await tick();
    result.next({
      status: 'pending',
      intermediateValue: { requiredUserInteraction: 'sign-transaction' },
    });
    await expect(pending).rejects.toMatchObject({
      code: 'HARDWARE_REQUEST_CANCELLED',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(dmk.disconnect).toHaveBeenCalledTimes(1);
    expect(session.getStatus().connected).toBe(false);
  });
});

/** Heavy browser host entry. Do not import from the wallet worker or software entry. */
import {
  DeviceManagementKitBuilder,
  type DeviceManagementKit,
} from '@ledgerhq/device-management-kit';
import { webHidTransportFactory } from '@ledgerhq/device-transport-kit-web-hid';

import { createLedgerEvmAdapter } from './ledger/dmk-evm';
import { LedgerDmkSession } from './ledger/dmk-session';
import { createLedgerUtxoAdapter } from './ledger/dmk-utxo';
import { ledgerHostError } from './ledger/host-types';

import type { LedgerHost, LedgerEvmConfig } from './ledger/host-types';

export interface LedgerDmkHostConfig extends LedgerEvmConfig {
  /** Platform-owned DMK, allowing a future host to register its own transports. */
  dmk?: object;
}

export function createLedgerDmkHost(
  config: LedgerDmkHostConfig = {}
): LedgerHost {
  const candidate =
    config.dmk ??
    new DeviceManagementKitBuilder()
      .addTransport(webHidTransportFactory)
      .build();
  for (const method of [
    'connect',
    'disconnect',
    'executeDeviceAction',
    'startDiscovering',
    'listenToAvailableDevices',
    'getDeviceSessionState',
  ]) {
    if (typeof (candidate as Record<string, unknown>)[method] !== 'function')
      throw ledgerHostError(
        'LEDGER_INVALID_HOST',
        'Invalid Ledger device manager'
      );
  }
  // Keep upstream exports-only types out of this public declaration. A trusted
  // platform supplies its concrete DMK here; dapps cannot select this object.
  const dmk = candidate as DeviceManagementKit;
  const session = new LedgerDmkSession(dmk);
  return {
    connect: (request, options) => session.connect(request, options),
    disconnect: () => session.disconnect(),
    getStatus: () => session.getStatus(),
    evm: createLedgerEvmAdapter(session, config),
    utxo: createLedgerUtxoAdapter(session),
  };
}

export type {
  LedgerEvmConfig,
  LedgerBlindSigningIntent,
  LedgerHost,
  LedgerEvmHost,
  LedgerUtxoHost,
  LedgerUtxoAccount,
  LedgerPartialSignature,
  LedgerTypedData,
  LedgerOperationOptions,
  LedgerProgress,
} from './ledger/host-types';

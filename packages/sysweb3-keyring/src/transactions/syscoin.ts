import {
  createLedgerPsbtSigner,
  createTrezorPsbtSigner,
} from './hardware-psbt';
import { SyscoinTransactionsCore } from './syscoin-core';

import type { LedgerKeyring } from '../ledger';
import type { TrezorKeyring } from '../trezor';

type CoreArguments = ConstructorParameters<typeof SyscoinTransactionsCore>;

/** Legacy constructor: preserve device arguments while composing shared logic. */
export class SyscoinTransactions extends SyscoinTransactionsCore {
  constructor(
    getSyscoinSigner: CoreArguments[0],
    getReadOnlySigner: CoreArguments[1],
    getState: CoreArguments[2],
    getAddress: CoreArguments[3],
    ledgerSigner: LedgerKeyring,
    trezorSigner: TrezorKeyring,
    captureSigningContext?: CoreArguments[5]
  ) {
    super(
      getSyscoinSigner,
      getReadOnlySigner,
      getState,
      getAddress,
      {
        ledger: ledgerSigner ? createLedgerPsbtSigner(ledgerSigner) : undefined,
        trezor: trezorSigner ? createTrezorPsbtSigner(trezorSigner) : undefined,
      },
      captureSigningContext
    );
  }
}

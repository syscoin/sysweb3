import { getNetworkConfig, INetworkType } from '@sidhujag/sysweb3-network';
import { Psbt, Transaction, payments } from 'bitcoinjs-lib';

import { SyscoinTransactionsCore } from '../../../src/transactions/syscoin-core';
import { KeyringAccountType } from '../../../src/types';
import { PsbtUtils } from '../../../src/utils/psbt';

import type { ISyscoinHardwareSigners } from '../../../src/transactions/syscoin-core';

jest.mock('../../../src/utils/blockbook-cache', () => ({
  fetchBackendAccountCached: jest.fn().mockResolvedValue({ tokens: [] }),
}));

const network = {
  kind: INetworkType.Syscoin,
  chainId: 5700,
  slip44: 1,
  currency: 'tSYS',
  url: 'https://offline.invalid',
} as any;

function fixture(hardware?: ISyscoinHardwareSigners) {
  const syscoinjs = jest.requireActual('syscoinjs-lib');
  const config = getNetworkConfig(1, 'tSYS');
  const hd = new syscoinjs.utils.HDSigner(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    null,
    true,
    config.networks,
    1,
    config.types.zPubType,
    84
  );
  hd.createAccountAtIndex(0, 84);
  const root = hd.getRootNode();
  const path = "m/84'/1'/0'/0/0";
  const child = root.derivePath(path);
  const payment = payments.p2wpkh({
    pubkey: child.publicKey,
    network: config.networks.testnet,
  });
  const account = {
    id: 0,
    address: payment.address!,
    xpub: hd.getAccountXpub(),
  };
  const state = {
    activeNetwork: network,
    activeAccountId: 0,
    activeAccountType: KeyringAccountType.HDAccount,
    accounts: {
      HDAccount: { 0: account },
      Imported: {},
      Ledger: {},
      Trezor: {},
    } as any,
  };
  const getSigner = jest.fn(() => ({ hd, main: {} }));
  let generation = 0;
  const capture = () => {
    const atStart = generation;
    return () => {
      if (atStart !== generation)
        throw new Error('Wallet signing context changed');
    };
  };
  const tx = new SyscoinTransactionsCore(
    getSigner,
    () => ({ main: {} }),
    () => state,
    jest.fn(),
    hardware,
    capture
  );
  const makePsbt = () => {
    const previous = new Transaction();
    previous.addInput(Buffer.alloc(32), 0xffffffff);
    previous.addOutput(payment.output!, 100000n);
    const psbt = new Psbt({ network: config.networks.testnet });
    psbt.addInput({
      hash: previous.getId(),
      index: 0,
      nonWitnessUtxo: previous.toBuffer(),
      bip32Derivation: [
        { masterFingerprint: root.fingerprint, path, pubkey: child.publicKey },
      ],
    });
    psbt.addOutput({ script: payment.output!, value: 99000n });
    return psbt;
  };
  return {
    tx,
    state,
    account,
    child,
    root,
    getSigner,
    makePsbt,
    cycle: () => {
      generation += 2;
    },
  };
}

test('software core signs the existing authenticated HD PSBT without a hardware adapter', async () => {
  const f = fixture();
  const result = await f.tx.signPSBT({ psbt: PsbtUtils.toPali(f.makePsbt()) });
  const signed = PsbtUtils.fromPali(result, network);
  expect(signed.data.inputs[0].finalScriptWitness).toBeDefined();
  expect(f.getSigner).toHaveBeenCalledTimes(1);
});

test.each([KeyringAccountType.Ledger, KeyringAccountType.Trezor])(
  'missing %s adapter cannot fall through to the HD signer despite caller flags',
  async (kind) => {
    const f = fixture();
    f.state.activeAccountType = kind;
    f.state.accounts[kind][0] = { ...f.account };
    await expect(
      f.tx.signPSBT({
        psbt: PsbtUtils.toPali(f.makePsbt()),
        isLedger: false,
        isTrezor: false,
      })
    ).rejects.toMatchObject({ code: 'HARDWARE_SIGNER_UNAVAILABLE' });
    expect(f.getSigner).not.toHaveBeenCalled();
  }
);

test('hardware metadata on an otherwise software account cannot select a software fallback', async () => {
  const f = fixture();
  f.state.accounts.HDAccount[0].isLedgerWallet = true;
  await expect(
    f.tx.signPSBT({ psbt: PsbtUtils.toPali(f.makePsbt()) })
  ).rejects.toMatchObject({ code: 'HARDWARE_SIGNER_UNAVAILABLE' });
  expect(f.getSigner).not.toHaveBeenCalled();
});

test('hardware adapters cannot mutate wallet network or signing context snapshots', async () => {
  const originalUrl = network.url;
  const ledger: ISyscoinHardwareSigners['ledger'] = async (request) => {
    expect(request.network).not.toBe(network);
    expect(Object.isFrozen(request.network)).toBe(true);
    expect(Object.isFrozen(request.scope)).toBe(true);
    expect(Object.isFrozen(request.scope.account)).toBe(true);
    expect(() => {
      (request.network as any).url = 'https://attacker.invalid';
    }).toThrow(TypeError);
    expect(() => {
      (request.scope.network as any).url = 'https://attacker.invalid';
    }).toThrow(TypeError);
    request.assertCurrent();
    return request.psbt;
  };
  const f = fixture({ ledger });
  f.state.activeAccountType = KeyringAccountType.Ledger;
  f.state.accounts.Ledger[0] = { ...f.account };
  await f.tx.signPSBT({ psbt: PsbtUtils.toPali(f.makePsbt()) });
  expect(f.state.activeNetwork.url).toBe(originalUrl);
  expect(f.getSigner).not.toHaveBeenCalled();
});

test('injected hardware completion is rejected after a session cycle', async () => {
  let complete!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const ledger = jest.fn(async ({ psbt }) => {
    entered();
    await wait;
    return psbt;
  });
  const f = fixture({ ledger });
  f.state.activeAccountType = KeyringAccountType.Ledger;
  f.state.accounts.Ledger[0] = { ...f.account, xprv: 'encrypted-test-secret' };
  const result = f.tx.signPSBT({ psbt: PsbtUtils.toPali(f.makePsbt()) });
  const rejected = expect(result).rejects.toThrow(
    'Wallet signing context changed'
  );
  await ready;
  f.cycle();
  complete();
  await rejected;
  expect(ledger).toHaveBeenCalledTimes(1);
  expect(ledger.mock.calls[0][0].account).toEqual({
    id: f.account.id,
    xpub: f.account.xpub,
  });
  expect(f.getSigner).not.toHaveBeenCalled();
});

test.each([false, true])(
  'legacy Ledger adapter validates returned keys (foreign key: %s)',
  async (foreignKey) => {
    // Exercise the old public constructor through real PSBT conversion/finalization.
    // Only physical device I/O is replaced with a deterministic signature fixture.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      SyscoinTransactions,
    } = require('../../../src/transactions/syscoin');
    const f = fixture();
    f.state.activeAccountType = KeyringAccountType.Ledger;
    f.state.accounts.Ledger[0] = { ...f.account };
    const deviceSignature = f.makePsbt();
    deviceSignature.signInput(0, f.child);
    const signature = deviceSignature.data.inputs[0].partialSig![0];
    const getRawTransaction = jest.fn();
    const signPsbt = jest.fn(async () => [
      [
        0,
        {
          ...signature,
          pubkey: foreignKey ? Buffer.alloc(33, 2) : signature.pubkey,
        },
      ],
    ]);
    const ledger = {
      convertToLedgerFormat: jest.fn(async (psbt) => psbt),
      ledgerUtxoClient: {
        getMasterFingerprint: jest.fn(async () =>
          f.root.fingerprint.toString('hex')
        ),
        getExtendedPubkey: jest.fn(async () => f.account.xpub),
        signPsbt,
      },
    };
    const tx = new SyscoinTransactions(
      f.getSigner,
      () => ({ main: {} }),
      () => f.state,
      jest.fn(),
      ledger,
      undefined
    );
    jest.spyOn(tx, 'txUtilsFunctions').mockReturnValue({ getRawTransaction });
    const pending = tx.signPSBT({
      psbt: PsbtUtils.toPali(f.makePsbt()),
      isLedger: false,
    });
    if (foreignKey) {
      await expect(pending).rejects.toThrow(
        'PSBT input is outside the approved account'
      );
    } else {
      const result = PsbtUtils.fromPali(await pending, network);
      expect(result.data.inputs[0].finalScriptWitness).toBeDefined();
    }
    expect(signPsbt).toHaveBeenCalledTimes(1);
    expect(getRawTransaction).not.toHaveBeenCalled();
    expect(f.getSigner).not.toHaveBeenCalled();
  }
);

test('software transaction entries do not import browser hardware or Ledger protocol adapters', () => {
  const browserGlobals = ['window', 'document', 'self', 'chrome'];
  const descriptors = browserGlobals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  );
  for (const name of browserGlobals) delete (globalThis as any)[name];
  jest.resetModules();
  const forbidden = [
    '../../../src/ledger',
    '../../../src/trezor',
    '../../../src/hardware-wallet-manager',
    '../../../src/hardware-wallet-manager-singleton',
    '../../../src/ledger/bitcoin_client',
    '../../../src/ledger/bitcoin_client/lib/policy',
    '../../../src/ledger/bitcoin_client/lib/psbtv2',
    '../../../src/transactions/hardware-psbt',
    '@trezor/connect-web',
    '@trezor/connect-webextension',
    '@ledgerhq/hw-transport-webhid',
  ];
  for (const module of forbidden)
    jest.doMock(module, () => {
      throw new Error('Browser hardware imported');
    });
  try {
    jest.isolateModules(() => {
      // Test the runtime graph rather than relying on erased type imports.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      expect(
        require('../../../src/transactions/syscoin-core')
          .SyscoinTransactionsCore
      ).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      expect(
        require('../../../src/transactions/ethereum').EthereumTransactions
      ).toBeDefined();
    });
  } finally {
    for (const module of forbidden) jest.dontMock(module);
    browserGlobals.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    });
  }
});


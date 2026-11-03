import { SignTypedDataVersion, TypedDataUtils } from '@metamask/eth-sig-util';
import {
  computeAddress,
  getAddress,
  hashMessage,
  recoverAddress,
  Signature,
  Transaction,
} from 'ethers';

import {
  ConnectionStatus,
  HardwareWalletType,
} from '../hardware-wallet-manager';
import { ledgerCancelledError, ledgerHostError } from './host-types';

import type { HardwareWalletManager } from '../hardware-wallet-manager';
import type { LedgerHost, LedgerTypedData, LedgerUtxoHost } from './host-types';
import type { IEvmMethods, IUTXOMethods } from './types';

const invalidRequest = () =>
  ledgerHostError('LEDGER_INVALID_REQUEST', 'Invalid Ledger signing request');
const invalidSignature = () =>
  ledgerHostError(
    'LEDGER_INVALID_SIGNATURE',
    'Ledger returned an invalid signature for this request'
  );

const accountIndex = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff)
    throw invalidRequest();
  return value;
};
const hexBytes = (value: string): Uint8Array => {
  if (typeof value !== 'string' || !/^(?:0x)?(?:[0-9a-f]{2})*$/i.test(value))
    throw invalidRequest();
  return Uint8Array.from(Buffer.from(value.replace(/^0x/i, ''), 'hex'));
};
const approvedAddress = (value: string) => {
  try {
    return getAddress(value);
  } catch {
    throw invalidRequest();
  }
};
const checkedSignature = (
  value: string | { r: string; s: string; v: string },
  digest: string,
  expected: string
) => {
  try {
    let signature: Signature;
    if (typeof value === 'string') {
      if (!/^0x[0-9a-f]{130}$/i.test(value)) throw invalidSignature();
      signature = Signature.from(value);
    } else {
      if (
        !value ||
        !/^[0-9a-f]{64}$/i.test(value.r) ||
        !/^[0-9a-f]{64}$/i.test(value.s) ||
        !/^[0-9a-f]+$/i.test(value.v)
      )
        throw invalidSignature();
      const v = Number.parseInt(value.v, 16);
      if (!Number.isSafeInteger(v) || v < 0) throw invalidSignature();
      signature = Signature.from({ r: `0x${value.r}`, s: `0x${value.s}`, v });
    }
    if (recoverAddress(digest, signature) !== expected)
      throw invalidSignature();
    return signature;
  } catch {
    throw invalidSignature();
  }
};
// Detach the approved typed data before connection or host code can await/mutate it.
const copyTypedData = (
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): any => {
  if (depth > 64) throw invalidRequest();
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidRequest();
    return value;
  }
  if (value instanceof Uint8Array)
    return `0x${Buffer.from(value).toString('hex')}`;
  if (!value || typeof value !== 'object' || seen.has(value))
    throw invalidRequest();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null)
    throw invalidRequest();
  seen.add(value);
  try {
    const result: any = array ? [] : Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw invalidRequest();
      if (descriptor.value !== undefined)
        result[key] = copyTypedData(descriptor.value, seen, depth + 1);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
};

/** Small authority-side facade. Device SDKs belong exclusively in ledger-host. */
export class LedgerKeyring {
  public readonly evm: IEvmMethods;
  public readonly utxo: IUTXOMethods;
  private generation = 0;

  // Retain the first constructor position for existing shared-manager callers.
  // A manager alone cannot grant a new device capability.
  constructor(
    private readonly sharedHardwareWalletManager?: HardwareWalletManager,
    private readonly host?: LedgerHost
  ) {
    this.evm = {
      getEvmAddressAndPubKey: async (request) => {
        const approved = { accountIndex: accountIndex(request.accountIndex) };
        return this.run(async (host, assertCurrent) => {
          const result = await host.evm.getAddress(approved);
          assertCurrent();
          try {
            const address = getAddress(result.address);
            const publicKey = result.publicKey.replace(/^0x/i, '');
            if (computeAddress(`0x${publicKey}`) !== address)
              throw invalidRequest();
            return { address, publicKey };
          } catch {
            throw ledgerHostError(
              'LEDGER_INVALID_RESPONSE',
              'Ledger returned an invalid address or public key'
            );
          }
        });
      },
      signEVMTransaction: async (request) => {
        const index = accountIndex(request.accountIndex);
        const expected = approvedAddress(request.expectedAddress);
        let transaction: Transaction;
        try {
          transaction = Transaction.from(
            `0x${Buffer.from(hexBytes(request.rawTx)).toString('hex')}`
          );
          if (transaction.signature || transaction.chainId <= 0n)
            throw invalidRequest();
        } catch {
          throw invalidRequest();
        }
        const approved = {
          accountIndex: index,
          expectedAddress: expected,
          unsignedTxHex: transaction.unsignedSerialized.replace(/^0x/, ''),
        };
        const digest = transaction.unsignedHash;
        return this.run(async (host, assertCurrent) => {
          const result = await host.evm.signTransaction(approved);
          assertCurrent();
          const signature = checkedSignature(result, digest, expected);
          if (
            signature.legacyChainId !== null &&
            signature.legacyChainId !== transaction.chainId
          )
            throw invalidSignature();
          return {
            r: signature.r.slice(2),
            s: signature.s.slice(2),
            v: signature.v.toString(16),
          };
        });
      },
      signPersonalMessage: async (request) => {
        const expected = approvedAddress(request.expectedAddress);
        const messageHex = Buffer.from(hexBytes(request.message)).toString(
          'hex'
        );
        const digest = hashMessage(hexBytes(messageHex));
        const approved = {
          accountIndex: accountIndex(request.accountIndex),
          expectedAddress: expected,
          messageHex,
        };
        return this.run(
          async (host) =>
            checkedSignature(
              await host.evm.signPersonalMessage(approved),
              digest,
              expected
            ).serialized
        );
      },
      signTypedData: async (request) => {
        const { version } = request;
        if (
          version !== SignTypedDataVersion.V3 &&
          version !== SignTypedDataVersion.V4
        )
          throw invalidRequest();
        const expected = approvedAddress(request.expectedAddress);
        const index = accountIndex(request.accountIndex);
        let data: LedgerTypedData, digest: string;
        try {
          data = copyTypedData(request.data);
          digest = `0x${TypedDataUtils.eip712Hash(
            data as any,
            version
          ).toString('hex')}`;
        } catch {
          throw invalidRequest();
        }
        const approved = {
          accountIndex: index,
          expectedAddress: expected,
          data,
          version,
        };
        return this.run(
          async (host) =>
            checkedSignature(
              await host.evm.signTypedData(approved),
              digest,
              expected
            ).serialized
        );
      },
    };
    this.utxo = {
      getUtxoAddress: ({ coin, index, slip44 }) =>
        this.run((host) =>
          host.utxo.getAddress({ currency: coin, accountIndex: index, slip44 })
        ),
      getXpub: ({ coin, index, slip44 }) =>
        this.run((host) =>
          host.utxo.getXpub({
            currency: coin,
            accountIndex: index,
            slip44,
            // Import must remain available for paths the device classifies as
            // unusual. Ask for its confirmation once, without retrying denial.
            checkOnDevice: true,
          })
        ),
      verifyUtxoAddress: this.verifyUtxoAddress,
    };
  }

  private requireHost(): LedgerHost {
    if (!this.host)
      throw ledgerHostError(
        'HARDWARE_SIGNER_UNAVAILABLE',
        'Ledger requires an authorized device host'
      );
    return this.host;
  }

  private async run<T>(
    operation: (host: LedgerHost, assertCurrent: () => void) => Promise<T>
  ): Promise<T> {
    const generation = this.generation;
    const host = this.requireHost();
    // A visible platform host owns discovery, permission and device selection.
    if (!host.getStatus().connected)
      await host.connect({ useGrantedDevices: true });
    const assertCurrent = () => {
      if (generation !== this.generation) throw ledgerCancelledError();
    };
    assertCurrent();
    try {
      const result = await operation(host, assertCurrent);
      assertCurrent();
      return result;
    } catch (error) {
      assertCurrent();
      throw error;
    }
  }

  public ensureConnection = async (): Promise<void> =>
    this.run(async () => undefined);

  public verifyUtxoAddress = (
    accountIndex: number,
    currency: string,
    slip44: number
  ): Promise<string> =>
    this.run((host) =>
      host.utxo.getAddress({
        accountIndex,
        currency,
        slip44,
        checkOnDevice: true,
      })
    );

  public signUtxoMessage = (
    request: Parameters<LedgerUtxoHost['signMessage']>[0]
  ): Promise<string> => {
    const approved = Object.freeze({
      currency: request.currency,
      slip44: request.slip44,
      accountIndex: request.accountIndex,
      message: request.message,
      addressIndex: request.addressIndex,
      change: request.change,
      accountXpub: request.accountXpub,
    });
    return this.run((host) => host.utxo.signMessage(approved));
  };

  public signPsbt = (
    request: Parameters<LedgerUtxoHost['signPsbt']>[0]
  ): ReturnType<LedgerUtxoHost['signPsbt']> => {
    const approved = Object.freeze({
      currency: request.currency,
      slip44: request.slip44,
      accountIndex: request.accountIndex,
      accountXpub: request.accountXpub,
      psbtBase64: request.psbtBase64,
    });
    return this.run((host) => host.utxo.signPsbt(approved));
  };

  public getStatus() {
    const connected = this.host?.getStatus().connected === true;
    return {
      type: HardwareWalletType.LEDGER,
      connected,
      status: connected
        ? ConnectionStatus.CONNECTED
        : ConnectionStatus.DISCONNECTED,
    };
  }

  public async destroy(): Promise<void> {
    // Revoke pending responses synchronously, before platform teardown awaits.
    this.generation++;
    const cleanup = this.sharedHardwareWalletManager?.destroy();
    const disconnect = this.host?.disconnect();
    await Promise.all([cleanup, disconnect]);
  }
}

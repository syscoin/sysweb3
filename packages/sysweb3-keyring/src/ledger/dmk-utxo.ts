import {
  ApduBuilder,
  CallTaskInAppDeviceAction,
  CommandResultFactory,
  DeviceExchangeError,
  DmkResultFactory,
  InvalidResponseFormatError,
  UserInteractionRequired,
  isSuccessCommandResult,
  type ApduResponse,
  type Command,
  type DmkError,
  type InternalApi,
} from '@ledgerhq/device-management-kit';
import bs58check from 'bs58check';
import * as syscoinjs from 'syscoinjs-lib';

import {
  AppClient,
  type BitcoinAppTransport,
} from './bitcoin_client/lib/appClient';
import { WalletPolicy } from './bitcoin_client/lib/policy';
import { PsbtV2 } from './bitcoin_client/lib/psbtv2';
import { DESCRIPTOR } from './consts';
import { LedgerDmkSession, type LedgerDmkOperation } from './dmk-session';
import {
  ledgerHostError,
  type LedgerOperationOptions,
  type LedgerUtxoAccount,
  type LedgerUtxoHost,
} from './host-types';
import { prepareLedgerPsbt } from './prepare-psbt';
import {
  getAccountDerivationPath,
  getAddressDerivationPath,
} from '../utils/derivation-paths';
import {
  assertPsbtAccountScope,
  type PsbtAccountScope,
} from '../utils/psbt-account-scope';

export class LedgerProtocolError extends DeviceExchangeError<number> {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number) {
    super({
      tag: 'LedgerProtocolError',
      errorCode: statusCode,
      message: `Ledger returned status 0x${statusCode
        .toString(16)
        .padStart(4, '0')}`,
    });
    this.statusCode = statusCode;
    this.code =
      statusCode === 0x6985
        ? 'HARDWARE_REQUEST_REJECTED'
        : 'LEDGER_DEVICE_ERROR';
  }
}

/** Preserves the existing Bitcoin/Syscoin APDU contract, including 0xe000. */
export class LedgerBitcoinCommand implements Command<Buffer, void, number> {
  readonly name = 'PaliBitcoinProtocol';

  constructor(
    private readonly cla: number,
    private readonly ins: number,
    private readonly p1: number,
    private readonly p2: number,
    private readonly data: Uint8Array = new Uint8Array(),
    private readonly acceptedStatusCodes: number[] = [0x9000]
  ) {}

  getApdu() {
    const builder = new ApduBuilder({
      cla: this.cla,
      ins: this.ins,
      p1: this.p1,
      p2: this.p2,
    });
    builder.addBufferToData(this.data);
    if (builder.getErrors().length) throw new Error('Invalid Ledger APDU');
    return builder.build();
  }

  parseResponse(response: ApduResponse) {
    if (response.statusCode.length !== 2)
      return CommandResultFactory<Buffer, number>({
        error: new InvalidResponseFormatError('Invalid Ledger status word'),
      });
    const status = (response.statusCode[0] << 8) | response.statusCode[1];
    if (!this.acceptedStatusCodes.includes(status))
      return CommandResultFactory<Buffer, number>({
        error: new LedgerProtocolError(status),
      });
    return CommandResultFactory<Buffer, number>({
      data: Buffer.concat([
        Buffer.from(response.data),
        Buffer.from(response.statusCode),
      ]),
    });
  }
}

/** Must be used inside a single DeviceAction; public dmk.sendCommand would requeue. */
export function createBitcoinAppTransport(
  internalApi: InternalApi,
  assertCurrent: () => void
): BitcoinAppTransport {
  return {
    async send(cla, ins, p1, p2, data, acceptedStatusCodes) {
      assertCurrent();
      const response = await internalApi.sendCommand(
        new LedgerBitcoinCommand(cla, ins, p1, p2, data, acceptedStatusCodes)
      );
      assertCurrent();
      if (!isSuccessCommandResult(response)) throw response.error;
      return response.data;
    },
  };
}

const childIndex = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 0x80000000)
    throw ledgerHostError(
      'LEDGER_INVALID_REQUEST',
      'Invalid Ledger account or address index'
    );
};

export function ledgerUtxoApp(request: LedgerUtxoAccount): string {
  childIndex(request.accountIndex);
  const currency = request.currency.toLowerCase();
  if (
    ['sys', 'tsys', 'syscoin'].includes(currency) &&
    [1, 57].includes(request.slip44)
  )
    return 'Syscoin';
  if (
    ['btc', 'tbtc', 'bitcoin'].includes(currency) &&
    [0, 1].includes(request.slip44)
  )
    return request.slip44 === 1 ? 'Bitcoin Test' : 'Bitcoin';
  throw ledgerHostError(
    'HARDWARE_SIGNER_UNAVAILABLE',
    'This Ledger UTXO app is not supported'
  );
}

const publicKeyPayload = (xpub: string) => {
  const payload = Buffer.from(bs58check.decode(xpub));
  if (payload.length !== 78 || ![2, 3].includes(payload[45]))
    throw ledgerHostError(
      'LEDGER_INVALID_REQUEST',
      'Invalid Ledger account public key'
    );
  return payload.subarray(4); // Ignore only the public version (xpub/zpub/vpub).
};

const asDmkError = (error: unknown): DmkError => {
  if (error && typeof error === 'object' && '_tag' in error)
    return error as DmkError;
  return Object.assign(
    error instanceof Error ? error : new Error(String(error)),
    { _tag: 'LedgerUtxoError' }
  );
};

export function createLedgerUtxoAdapter(
  session: LedgerDmkSession
): LedgerUtxoHost {
  const hmacs = new Map<string, Buffer>();
  session.onInvalidated(() => hmacs.clear());
  let cacheGeneration = -1;

  const run = async <Request extends LedgerUtxoAccount, T>(
    request: Request,
    interaction: UserInteractionRequired,
    task: (
      client: AppClient,
      operation: LedgerDmkOperation,
      approved: Readonly<Request>
    ) => Promise<T>,
    options?: LedgerOperationOptions
  ): Promise<T> => {
    const approved = Object.freeze({ ...request });
    const appName = ledgerUtxoApp(approved);
    return session.runExclusive(
      (operation) =>
        operation.runAction(() => {
          if (cacheGeneration !== operation.generation) {
            hmacs.clear();
            cacheGeneration = operation.generation;
          }
          return operation.dmk.executeDeviceAction({
            sessionId: operation.sessionId,
            deviceAction: new CallTaskInAppDeviceAction({
              input: {
                appName,
                skipOpenApp: false,
                requiredUserInteraction: interaction,
                task: async (internalApi: InternalApi) => {
                  try {
                    const client = new AppClient(
                      createBitcoinAppTransport(
                        internalApi,
                        operation.assertCurrent
                      )
                    );
                    const value = await task(client, operation, approved);
                    operation.assertCurrent();
                    return DmkResultFactory({ data: value });
                  } catch (error) {
                    return DmkResultFactory<T, DmkError>({
                      error: asDmkError(error),
                    });
                  }
                },
              },
            }),
          });
        }),
      options
    );
  };

  const account = async (
    client: AppClient,
    request: LedgerUtxoAccount,
    expectedXpub?: string
  ) => {
    const path = getAccountDerivationPath(
      request.currency,
      request.slip44,
      request.accountIndex
    );
    const fingerprint = await client.getMasterFingerprint();
    if (!/^[0-9a-f]{8}$/i.test(fingerprint))
      throw new Error('Invalid Ledger fingerprint');
    const xpub = await client.getExtendedPubkey(path, false);
    const payload = publicKeyPayload(xpub);
    if (expectedXpub && !payload.equals(publicKeyPayload(expectedXpub)))
      throw ledgerHostError(
        'HARDWARE_ACCOUNT_MISMATCH',
        'Connected Ledger does not match the approved account'
      );
    const policy = new WalletPolicy(
      request.currency.toLowerCase(),
      DESCRIPTOR,
      [`[${fingerprint}${path.slice(1)}]${xpub}`]
    );
    return { fingerprint, xpub, policy };
  };

  const register = async (
    client: AppClient,
    fingerprint: string,
    policy: WalletPolicy,
    options?: LedgerOperationOptions
  ) => {
    const key = `${fingerprint}|${policy.getId().toString('hex')}`;
    const existing = hmacs.get(key);
    if (existing) return existing;
    options?.onProgress?.({
      status: 'pending',
      requiredUserInteraction: 'register-wallet',
    });
    const [id, hmac] = await client.registerWallet(policy);
    if (!id.equals(policy.getId()) || hmac.length !== 32)
      throw new Error('Invalid Ledger wallet registration');
    hmacs.set(key, hmac);
    return hmac;
  };

  return {
    getXpub: (request, options) =>
      run(
        request,
        request.checkOnDevice
          ? UserInteractionRequired.VerifyAddress
          : UserInteractionRequired.None,
        (client, _operation, approved) =>
          client.getExtendedPubkey(
            getAccountDerivationPath(
              approved.currency,
              approved.slip44,
              approved.accountIndex
            ),
            !!approved.checkOnDevice
          ),
        options
      ),
    getAddress: (request, options) =>
      run(
        request,
        request.checkOnDevice
          ? UserInteractionRequired.VerifyAddress
          : UserInteractionRequired.None,
        async (client, _operation, approved) => {
          const { fingerprint, policy } = await account(client, approved);
          const hmac = await register(client, fingerprint, policy, options);
          return client.getWalletAddress(
            policy,
            hmac,
            0,
            0,
            !!approved.checkOnDevice
          );
        },
        options
      ),
    getAccount: (request, options) =>
      run(
        request,
        request.checkOnDevice
          ? UserInteractionRequired.VerifyAddress
          : UserInteractionRequired.None,
        async (client, _operation, approved) => {
          const { fingerprint, xpub, policy } = await account(client, approved);
          const hmac = await register(client, fingerprint, policy, options);
          const address = await client.getWalletAddress(
            policy,
            hmac,
            0,
            0,
            !!approved.checkOnDevice
          );
          return { fingerprint, xpub, address };
        },
        options
      ),
    signMessage: (request, options) =>
      run(
        request,
        UserInteractionRequired.SignPersonalMessage,
        async (client, _operation, approved) => {
          publicKeyPayload(approved.accountXpub);
          await account(client, approved, approved.accountXpub);
          childIndex(approved.addressIndex ?? 0);
          return client.signMessage(
            Buffer.from(approved.message),
            getAddressDerivationPath(
              approved.currency,
              approved.slip44,
              approved.accountIndex,
              !!approved.change,
              approved.addressIndex ?? 0
            )
          );
        },
        options
      ),
    signPsbt: async (request, options) => {
      if (!request.psbtBase64 || request.psbtBase64.length > 4 * 1024 * 1024)
        return Promise.reject(
          ledgerHostError('LEDGER_INVALID_REQUEST', 'Invalid Ledger PSBT')
        );
      const encoded = Buffer.from(request.psbtBase64, 'base64');
      if (encoded.toString('base64') !== request.psbtBase64)
        return Promise.reject(
          ledgerHostError(
            'LEDGER_INVALID_REQUEST',
            'Invalid Ledger PSBT encoding'
          )
        );
      // Preserve the Syscoin fork's transaction and asset serialization.
      const psbt = (syscoinjs.utils as any).bitcoinjs.Psbt.fromBase64(
        request.psbtBase64
      );
      const scope = {
        account: { address: '', xpub: request.accountXpub },
        accountId: request.accountIndex,
        accountType: 'Ledger',
        network: { currency: request.currency, slip44: request.slip44 },
      } as PsbtAccountScope;
      assertPsbtAccountScope(psbt, scope);
      return run(
        request,
        UserInteractionRequired.SignTransaction,
        async (client, _operation, approved) => {
          const { fingerprint, policy } = await account(
            client,
            approved,
            approved.accountXpub
          );
          prepareLedgerPsbt(
            psbt,
            approved.accountXpub,
            approved.accountIndex,
            approved.currency,
            approved.slip44,
            fingerprint
          );
          assertPsbtAccountScope(psbt, scope);
          const hmac = await register(client, fingerprint, policy, options);
          options?.onProgress?.({
            status: 'pending',
            requiredUserInteraction: 'sign-transaction',
          });
          const signatures = await client.signPsbt(
            new PsbtV2().fromBitcoinJS(psbt),
            policy,
            hmac
          );
          return {
            fingerprint,
            signatures: signatures.map(([inputIndex, signature]) => ({
              inputIndex,
              pubkeyHex: signature.pubkey.toString('hex'),
              signatureHex: signature.signature.toString('hex'),
              ...(signature.tapleafHash
                ? { tapleafHashHex: signature.tapleafHash.toString('hex') }
                : {}),
            })),
          };
        },
        options
      );
    },
  };
}

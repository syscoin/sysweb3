/** Serializable Ledger requests. This module must remain free of device SDK imports. */
export interface LedgerProgress {
  status: 'not-started' | 'pending' | 'stopped' | 'completed' | 'error';
  requiredUserInteraction?: string;
  step?: string;
}

export interface LedgerOperationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LedgerProgress) => void;
}

export interface LedgerUtxoAccount {
  currency: string;
  slip44: number;
  accountIndex: number;
}

export interface LedgerPartialSignature {
  inputIndex: number;
  pubkeyHex: string;
  signatureHex: string;
  tapleafHashHex?: string;
}

export interface LedgerTypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export type LedgerBlindSigningIntent = Readonly<
  | {
      kind: 'transaction';
      accountIndex: number;
      derivationPath: string;
      expectedAddress: string;
      unsignedTxHex: string;
      chainId: string;
      digest: string;
    }
  | {
      kind: 'typed-data';
      accountIndex: number;
      derivationPath: string;
      expectedAddress: string;
      version: 'V3' | 'V4';
      data: LedgerTypedData;
      digest: string;
    }
>;

/** Trusted host policy, never a field accepted from a dapp request. */
export interface LedgerEvmConfig {
  /**
   * The public DSK may fall back to blind signing. The host must disclose that
   * limitation and approve this exact intent each time. No callback means deny.
   */
  confirmBlindSigning?: (
    intent: LedgerBlindSigningIntent,
    signal: AbortSignal
  ) => boolean | Promise<boolean>;
}

export interface LedgerEvmHost {
  getAddress(
    request: {
      accountIndex: number;
      checkOnDevice?: boolean;
      chainId?: number;
    },
    options?: LedgerOperationOptions
  ): Promise<{ address: string; publicKey: string }>;
  signTransaction(
    request: {
      accountIndex: number;
      unsignedTxHex: string;
      expectedAddress: string;
    },
    options?: LedgerOperationOptions
  ): Promise<{ r: string; s: string; v: string }>;
  signPersonalMessage(
    request: {
      accountIndex: number;
      messageHex: string;
      expectedAddress: string;
    },
    options?: LedgerOperationOptions
  ): Promise<string>;
  signTypedData(
    request: {
      accountIndex: number;
      version: 'V3' | 'V4';
      data: LedgerTypedData;
      expectedAddress: string;
    },
    options?: LedgerOperationOptions
  ): Promise<string>;
}

export interface LedgerUtxoHost {
  getXpub(
    request: LedgerUtxoAccount & { checkOnDevice?: boolean },
    options?: LedgerOperationOptions
  ): Promise<string>;
  getAddress(
    request: LedgerUtxoAccount & { checkOnDevice?: boolean },
    options?: LedgerOperationOptions
  ): Promise<string>;
  getAccount(
    request: LedgerUtxoAccount & { checkOnDevice?: boolean },
    options?: LedgerOperationOptions
  ): Promise<{ xpub: string; fingerprint: string; address: string }>;
  signMessage(
    request: LedgerUtxoAccount & {
      message: string;
      addressIndex?: number;
      change?: boolean;
      accountXpub: string;
    },
    options?: LedgerOperationOptions
  ): Promise<string>;
  signPsbt(
    request: LedgerUtxoAccount & {
      psbtBase64: string;
      accountXpub: string;
    },
    options?: LedgerOperationOptions
  ): Promise<{ fingerprint: string; signatures: LedgerPartialSignature[] }>;
}

/** The wallet authority injects this port; an absent host never opens a device. */
export interface LedgerHost {
  connect(
    request?: { useGrantedDevices?: boolean },
    options?: LedgerOperationOptions
  ): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): { connected: boolean };
  readonly evm: LedgerEvmHost;
  readonly utxo: LedgerUtxoHost;
}

export function ledgerHostError(
  code: string,
  message: string
): Error & {
  code: string;
} {
  return Object.assign(new Error(message), { code });
}

export const ledgerCancelledError = () =>
  ledgerHostError('HARDWARE_REQUEST_CANCELLED', 'Ledger request cancelled');

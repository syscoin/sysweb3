import ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory, BIP32Interface } from 'bip32';
import { address as bitcoinAddress, payments, Network } from 'bitcoinjs-lib';
import bs58check from 'bs58check';

export type Bip84PublicNetwork = 'bitcoin' | 'syscoin';
export type Bip84PublicAccountRequest = Readonly<{
  network: Bip84PublicNetwork;
  accountKey: string;
}>;
export type Bip84PublicAccount = Readonly<{
  network: Bip84PublicNetwork;
  policy: 'bip84-p2wpkh';
  canonicalKey: string;
  accountIndex: number;
}>;
export type Bip84PublicAddressRequest = Bip84PublicAccountRequest &
  Readonly<{
    branch: 0 | 1;
    index: number;
  }>;
export type Bip84PublicAddress = Readonly<{
  account: Bip84PublicAccount;
  branch: 0 | 1;
  index: number;
  address: string;
  scriptPubKey: string;
}>;
export class PublicBip84Error extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_ACCOUNT'
      | 'INVALID_DERIVATION'
  ) {
    super(code);
    this.name = 'PublicBip84Error';
  }
}

const bip32 = BIP32Factory(ecc);
const HARDENED = 0x80000000;
const XPUB = 0x0488b21e;
const ZPUB = 0x04b24746;
// Fixed mainnet encodings, independent of mutable external network objects.
// These match the Bitcoin/Syscoin registries; no BIP32 node escapes this entry.
const bitcoin = Object.freeze({
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  bech32: 'bc',
  bip32: Object.freeze({ public: XPUB, private: 0x0488ade4 }),
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
});
const syscoin = Object.freeze({
  ...bitcoin,
  messagePrefix: '\x18Syscoin Signed Message:\n',
  bech32: 'sys',
  pubKeyHash: 0x3f,
});
const addressNetworks: Readonly<Record<Bip84PublicNetwork, Network>> =
  Object.freeze({ bitcoin, syscoin });
const fail = (code: PublicBip84Error['code']): never => {
  throw new PublicBip84Error(code);
};

function snapshot(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length
    )
      return fail('INVALID_INPUT');
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      )
        return fail('INVALID_INPUT');
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return fail('INVALID_INPUT');
  }
}

function parse(input: Record<string, unknown>): {
  account: Bip84PublicAccount;
  node: BIP32Interface;
  network: Network;
} {
  if (input.network !== 'bitcoin' && input.network !== 'syscoin')
    return fail('INVALID_INPUT');
  const { accountKey } = input;
  if (
    typeof accountKey !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{100,112}$/.test(accountKey)
  )
    return fail('INVALID_ACCOUNT');
  try {
    const payload = Buffer.from(bs58check.decode(accountKey));
    if (
      payload.length !== 78 ||
      payload[4] !== 3 ||
      ![2, 3].includes(payload[45])
    )
      return fail('INVALID_ACCOUNT');
    const version = payload.readUInt32BE(0);
    const child = payload.readUInt32BE(9);
    if ((version !== XPUB && version !== ZPUB) || child < HARDENED)
      return fail('INVALID_ACCOUNT');
    const network = addressNetworks[input.network];
    const node = bip32.fromBase58(accountKey, {
      ...network,
      bip32: { public: version, private: network.bip32.private },
    });
    if (!node.isNeutered() || node.depth !== 3 || node.index !== child)
      return fail('INVALID_ACCOUNT');
    // Change serialization only after all account/public checks succeeded. No
    // descriptor, coin path or historical purpose can be proven from this key.
    payload.writeUInt32BE(ZPUB, 0);
    const account: Bip84PublicAccount = Object.freeze({
      network: input.network,
      policy: 'bip84-p2wpkh',
      canonicalKey: bs58check.encode(payload),
      accountIndex: child - HARDENED,
    });
    return { account, node, network };
  } catch {
    return fail('INVALID_ACCOUNT');
  }
}

/**
 * Validate one public account and normalize xpub/zpub aliases. The chosen
 * network and BIP84 policy are explicit; ancestry/purpose is not attested.
 * No keyring, storage, provider, randomness or wallet signing is involved.
 * BIP32Factory runs its upstream deterministic ECC self-tests at module load.
 */
export function parseBip84PublicAccount(
  request: Bip84PublicAccountRequest
): Bip84PublicAccount {
  return parse(snapshot(request, ['network', 'accountKey'])).account;
}

/**
 * Derive only /0/index or /1/index from a validated mainnet account key.
 * One bounded input and two child derivations; no discovery, cache or range
 * iteration. Callers own scan limits and privacy consent. Returned data is public.
 */
export function deriveBip84PublicAddress(
  request: Bip84PublicAddressRequest
): Bip84PublicAddress {
  const input = snapshot(request, ['network', 'accountKey', 'branch', 'index']);
  if (
    (input.branch !== 0 && input.branch !== 1) ||
    !Number.isInteger(input.index) ||
    (input.index as number) < 0 ||
    (input.index as number) >= HARDENED
  )
    return fail('INVALID_INPUT');
  const { account, node, network } = parse(input);
  const branch = input.branch;
  const index = input.index as number;
  try {
    const branchNode = node.derive(branch);
    if (branchNode.index !== branch) return fail('INVALID_DERIVATION');
    const child = branchNode.derive(index);
    // BIP32 implementations can retry an invalid child at index + 1. Such a
    // retry must never silently change the address requested by the caller.
    if (child.index !== index) return fail('INVALID_DERIVATION');
    const payment = payments.p2wpkh({ pubkey: child.publicKey, network });
    if (
      !payment.address ||
      !payment.output ||
      !Buffer.from(
        bitcoinAddress.toOutputScript(payment.address, network)
      ).equals(Buffer.from(payment.output))
    )
      return fail('INVALID_DERIVATION');
    return Object.freeze({
      account,
      branch,
      index,
      address: payment.address,
      scriptPubKey: Buffer.from(payment.output).toString('hex'),
    });
  } catch {
    return fail('INVALID_DERIVATION');
  }
}

/* eslint-disable camelcase */
import { bech32 } from 'bech32';
import bs58check from 'bs58check';
import { utils } from 'syscoinjs-lib';

import { TrezorKeyring } from '../../../src/trezor';

const bitcoinjs = (utils as any).bitcoinjs;
const receiver = Object.create(TrezorKeyring.prototype) as TrezorKeyring;
const hash = Buffer.from(Array.from({ length: 20 }, (_, index) => index));
const bitcoin = { pubKeyHash: 0, scriptHash: 5, bech32: 'bc' };
const syscoin = { pubKeyHash: 63, scriptHash: 5, bech32: 'sys' };
const testnet = { pubKeyHash: 111, scriptHash: 196, bech32: 'tb' };

it.each([bitcoin, syscoin, testnet])(
  'preserves standard Base58 classifications for %j',
  (network) => {
    const publicKey = bitcoinjs.address.toBase58Check(hash, network.pubKeyHash);
    const script = bitcoinjs.address.toBase58Check(hash, network.scriptHash);
    expect(receiver.isScriptHash(publicKey, network)).toBe(false);
    expect(receiver.isScriptHash(script, network)).toBe(true);
    expect(receiver.isBech32(publicKey)).toBe(false);
    expect(receiver.isBech32(script)).toBe(false);
  }
);

it('preserves checksum-verified two-byte versions and leading zero bytes', () => {
  const network = { pubKeyHash: 0x1cb8, scriptHash: 0x1cbd };
  for (const [version, expected] of [
    [network.pubKeyHash, false],
    [network.scriptHash, true],
  ] as const) {
    const address = bs58check.encode(
      Buffer.concat([Buffer.from([version >>> 8, version & 0xff]), hash])
    );
    expect(receiver.isScriptHash(address, network)).toBe(expected);
  }
  const leadingZeroVersion = bs58check.encode(Buffer.alloc(22));
  expect(receiver.isScriptHash(leadingZeroVersion, bitcoin)).toBe(false);
  expect(
    receiver.isScriptHash(
      bitcoinjs.address.toBase58Check(Buffer.alloc(20), 0),
      bitcoin
    )
  ).toBe(false);
});

it.each(['bc', 'tb', 'sys', 'tsys'])(
  'preserves SegWit classification for %s',
  (prefix) => {
    const keyHash = bitcoinjs.address.toBech32(hash, 0, prefix);
    const scriptHash = bitcoinjs.address.toBech32(
      Buffer.alloc(32, 1),
      0,
      prefix
    );
    const taproot = bitcoinjs.address.toBech32(Buffer.alloc(32, 2), 1, prefix);
    expect(receiver.isBech32(keyHash)).toBe(true);
    expect(receiver.isScriptHash(keyHash, { bech32: prefix })).toBe(false);
    expect(receiver.isScriptHash(scriptHash, { bech32: prefix })).toBe(true);
    // Preserve the existing helper's 32-byte-program classification.
    expect(receiver.isScriptHash(taproot, { bech32: prefix })).toBe(true);
    expect(receiver.isBech32(keyHash.toUpperCase())).toBe(true);
  }
);

it.each([20, 23])(
  'rejects a checksum-valid Base58 payload of invalid length %i',
  (length) => {
    const value = bs58check.encode(Buffer.alloc(length));
    expect(() => receiver.isScriptHash(value, bitcoin)).toThrow(TypeError);
    expect(() => receiver.isScriptHash(value, bitcoin)).toThrow(
      length < 21 ? 'too short' : 'too long'
    );
  }
);

it('rejects invalid checksums, mixed-case Bech32, wrong encodings and invalid script programs', () => {
  const value = bitcoinjs.address.toBase58Check(hash, 0);
  expect(() =>
    receiver.isScriptHash(
      value.slice(0, -1) + (value.endsWith('1') ? '2' : '1'),
      bitcoin
    )
  ).toThrow();
  const witness = bitcoinjs.address.toBech32(hash, 0, 'bc');
  expect(receiver.isBech32('B' + witness.slice(1))).toBe(false);
  const wrongEncoding = bech32.encode('bc', [
    1,
    ...bech32.toWords(Buffer.alloc(32)),
  ]);
  expect(receiver.isBech32(wrongEncoding)).toBe(false);
  for (const length of [19, 21]) {
    const malformed = bitcoinjs.address.toBech32(Buffer.alloc(length), 0, 'bc');
    expect(() => receiver.isScriptHash(malformed, bitcoin)).toThrow(
      'Unknown address type'
    );
  }
});

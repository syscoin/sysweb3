import { serializeWitness } from '../../../src/trezor/witness';

const compactSizes = [
  [0, '00'],
  [1, '01'],
  [252, 'fc'],
  [253, 'fdfd00'],
  [65535, 'fdffff'],
  [65536, 'fe00000100'],
] as const;

it.each(compactSizes)(
  'encodes a witness item of %i bytes with canonical CompactSize',
  (length, prefix) => {
    const value = Buffer.alloc(length, 0x5a);
    const expected = Buffer.concat([Buffer.from('01' + prefix, 'hex'), value]);
    expect(serializeWitness([value])).toEqual(expected);
  }
);

it.each(compactSizes)(
  'encodes a witness vector of %i empty items with canonical CompactSize',
  (length, prefix) => {
    expect(
      serializeWitness(Array.from({ length }, () => new Uint8Array()))
    ).toEqual(
      Buffer.concat([Buffer.from(prefix, 'hex'), Buffer.alloc(length)])
    );
  }
);

it('preserves empty items, byte order and byte ownership', () => {
  const item = Uint8Array.from([0, 1, 2]);
  const encoded = serializeWitness([
    new Uint8Array(),
    Buffer.from([0xab]),
    item,
  ]);
  expect(encoded.toString('hex')).toBe('030001ab03000102');
  item[0] = 0xff;
  expect(encoded.toString('hex')).toBe('030001ab03000102');
});

it.each([null, undefined, {}])(
  'rejects a malformed witness item %p',
  (value) => {
    expect(() => serializeWitness([value as any])).toThrow(/first argument/);
  }
);

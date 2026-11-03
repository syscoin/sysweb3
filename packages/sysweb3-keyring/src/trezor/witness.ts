import { Buffer } from 'buffer';
import { encode, encodingLength } from 'varuint-bitcoin';

/** Canonical Bitcoin witness-vector encoding (CompactSize count and lengths). */
export const serializeWitness = (witness: readonly Uint8Array[]): Buffer => {
  const stack = witness.map((item) => Buffer.from(item));
  const size =
    encodingLength(stack.length) +
    stack.reduce(
      (total, item) => total + encodingLength(item.length) + item.length,
      0
    );
  const result = Buffer.alloc(size);
  let offset = 0;
  const writeLength = (value: number) => {
    offset += encode(value, result, offset).bytes;
  };
  writeLength(stack.length);
  for (const item of stack) {
    writeLength(item.length);
    result.set(item, offset);
    offset += item.length;
  }
  return result;
};

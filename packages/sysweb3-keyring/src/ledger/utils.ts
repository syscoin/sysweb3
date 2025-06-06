export const getXpubWithDescriptor = (
  xpub: string,
  path: string,
  fingerprint: string
) => `wpkh([${path.replace('m', fingerprint)}]${xpub})`;

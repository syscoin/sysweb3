export const isBase64 = (string: string) => {
  try {
    const b = Buffer.from(string, 'base64');
    return b.toString('base64') === string;
  } catch (err) {
    return false;
  }
};

export const isPrefixedFormattedHexString = (value: number | string) => {
  if (typeof value !== 'string') {
    return false;
  }
  return /^0x[1-9a-f]+[0-9a-f]*$/iu.test(value);
};

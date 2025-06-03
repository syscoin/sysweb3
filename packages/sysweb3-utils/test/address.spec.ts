import { validateEOAAddress } from '../src';

// Helper to create mock provider
const createMockProvider = () => {
  const contracts = [
    '0x0c702f78b889f25e3347fb978345f7ecf4f3861c',
    '0xd19018f7946d518d316bb10fdff118c28835cf7a',
    '0xaa54a8e8bdea1aa7e2ed7e5f681c798a8ed7e5ab',
    '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
    '0x1297228a708602b796fa16e9a7683db9cde09436',
    '0x628a9db47d7aeb6cf80ebf8c441bb72a83ddb08e',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa',
  ];

  return {
    getCode: jest.fn().mockImplementation(async (address: string) => {
      const normalizedAddress = address.toLowerCase();
      const isContract = contracts.some(
        (c) => normalizedAddress === c.toLowerCase()
      );
      return isContract ? '0x608060405234801561001057600080fd5b50' : '0x';
    }),
  };
};

//Mumbai Tests
describe('Validate Addresses at Mumbai', () => {
  // Contracts
  it('Should return a valid contract address at Mumbai', async () => {
    const provider = createMockProvider();

    // Test 1
    const validateContractAddress = await validateEOAAddress(
      '0xd19018f7946D518D316BB10FdFF118C28835cF7a',
      provider
    );

    expect(typeof validateContractAddress).toBe('object');
    expect(validateContractAddress.contract).toBe(true);
    expect(validateContractAddress.wallet).toBe(false);

    // Test 2
    const validateContractAddress2 = await validateEOAAddress(
      '0xAa54A8E8BdEA1aa7E2ed7E5F681c798a8eD7e5AB',
      provider
    );

    expect(typeof validateContractAddress2).toBe('object');
    expect(validateContractAddress2.contract).toBe(true);
    expect(validateContractAddress2.wallet).toBe(false);

    // Test 3
    const validateContractAddress3 = await validateEOAAddress(
      '0x0c702F78b889f25E3347fb978345F7eCF4F3861C',
      provider
    );

    expect(typeof validateContractAddress3).toBe('object');
    expect(validateContractAddress3.contract).toBe(true);
    expect(validateContractAddress3.wallet).toBe(false);
  });

  //Wallets
  it('Should return a valid wallet address at Mumbai', async () => {
    const provider = createMockProvider();

    // Test 1
    const validateWalletAddress = await validateEOAAddress(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
      provider
    );

    expect(typeof validateWalletAddress).toBe('object');
    expect(validateWalletAddress.contract).toBe(false);
    expect(validateWalletAddress.wallet).toBe(true);

    // Test 2
    const validateWalletAddress2 = await validateEOAAddress(
      '0x7BFCe3CFE987Ca195404A57cdaF2210c2d131998',
      provider
    );

    expect(typeof validateWalletAddress2).toBe('object');
    expect(validateWalletAddress2.contract).toBe(false);
    expect(validateWalletAddress2.wallet).toBe(true);

    // Test 3
    const validateWalletAddress3 = await validateEOAAddress(
      '0xd5e66A5D61690Dd4d6675D1E9eB480ddd640Fe06',
      provider
    );

    expect(typeof validateWalletAddress3).toBe('object');
    expect(validateWalletAddress3.contract).toBe(false);
    expect(validateWalletAddress3.wallet).toBe(true);
  });

  //Undefineds
  it('Should return a invalid (undefined) address for both at Mumbai', async () => {
    const provider = createMockProvider();

    // Test 1
    const validateInvalidAddress = await validateEOAAddress(
      '0xd19018f7946D518D316BB10FdFF118C28835c2345',
      provider
    );

    expect(typeof validateInvalidAddress).toBe('object');
    expect(validateInvalidAddress.contract).toBe(undefined);
    expect(validateInvalidAddress.wallet).toBe(undefined);

    // Test 2
    const validateInvalidAddress2 = await validateEOAAddress(
      '0xd5e66A5D61690Dd4d6675D1E9eB480ddd640Fg84',
      provider
    );

    expect(typeof validateInvalidAddress2).toBe('object');
    expect(validateInvalidAddress2.contract).toBe(undefined);
    expect(validateInvalidAddress2.wallet).toBe(undefined);
  });
});

// Goerli Tests
describe('Validate Addresses at Goerli', () => {
  // Contracts
  it('Should return a valid contract address at Goerli', async () => {
    const provider = createMockProvider();

    // Test 1
    const validateContractAddress = await validateEOAAddress(
      '0x07865c6E87B9F70255377e024ace6630C1Eaa37F',
      provider
    );

    expect(typeof validateContractAddress).toBe('object');
    expect(validateContractAddress.contract).toBe(true);
    expect(validateContractAddress.wallet).toBe(false);

    // Test 2
    const validateContractAddress2 = await validateEOAAddress(
      '0x1297228A708602B796fa16E9A7683db9Cde09436',
      provider
    );

    expect(typeof validateContractAddress2).toBe('object');
    expect(validateContractAddress2.contract).toBe(true);
    expect(validateContractAddress2.wallet).toBe(false);

    // Test 3
    const validateContractAddress3 = await validateEOAAddress(
      '0x628a9dB47D7aEB6CF80ebF8C441BB72A83Ddb08e',
      provider
    );

    expect(typeof validateContractAddress3).toBe('object');
    expect(validateContractAddress3.contract).toBe(true);
    expect(validateContractAddress3.wallet).toBe(false);
  });

  //Wallets
  it('Should return a valid wallet address at Goerli', async () => {
    const provider = createMockProvider();

    // Test 1
    const validateWalletAddress = await validateEOAAddress(
      '0x6a702c81d969627021c118b72f67d8bd70534c77',
      provider
    );

    expect(typeof validateWalletAddress).toBe('object');
    expect(validateWalletAddress.contract).toBe(false);
    expect(validateWalletAddress.wallet).toBe(true);

    // Test 2
    const validateWalletAddress2 = await validateEOAAddress(
      '0xd5e66a5d61690dd4d6675d1e9eb480ddd640fe06',
      provider
    );

    expect(typeof validateWalletAddress2).toBe('object');
    expect(validateWalletAddress2.contract).toBe(false);
    expect(validateWalletAddress2.wallet).toBe(true);

    // Test 3
    const validateWalletAddress3 = await validateEOAAddress(
      '0x6a92eF94F6Db88098625a30396e0fde7255E97d5',
      provider
    );

    expect(typeof validateWalletAddress3).toBe('object');
    expect(validateWalletAddress3.contract).toBe(false);
    expect(validateWalletAddress3.wallet).toBe(true);
  });

  //Undefineds
  it('Should return a invalid (undefined) address for both at Goerli', async () => {
    const provider = createMockProvider();

    // Test 1
    const validateInvalidAddress = await validateEOAAddress(
      '0xd19018f7946D518D316BB10FdFF118C28835c2345',
      provider
    );

    expect(typeof validateInvalidAddress).toBe('object');
    expect(validateInvalidAddress.contract).toBe(undefined);
    expect(validateInvalidAddress.wallet).toBe(undefined);

    // Test 2
    const validateInvalidAddress2 = await validateEOAAddress(
      '0xd5e66A5D61690Dd4d6675D1E9eB480ddd640Fg84',
      provider
    );

    expect(typeof validateInvalidAddress2).toBe('object');
    expect(validateInvalidAddress2.contract).toBe(undefined);
    expect(validateInvalidAddress2.wallet).toBe(undefined);
  });
});

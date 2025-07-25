import { contractChecker, isContractAddress } from '../src/contracts';
import { getContractType } from '../src/getContract';

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

describe('Validate is Contract Test', () => {
  it('Should return true from  is contract verification', async () => {
    const provider = createMockProvider();
    const isContract = await isContractAddress(
      '0x0c702F78b889f25E3347fb978345F7eCF4F3861C', // Correctly address
      provider
    );
    expect(typeof isContract).toBe('boolean');
    expect(isContract).toBe(true);
  });

  it('Should return false from  is contract verification', async () => {
    const provider = createMockProvider();
    const isContract = await isContractAddress(
      '0x0c702F78b889f25E3347fb978345F7eCF4F38443', // Bad Address
      provider
    );
    expect(typeof isContract).toBe('boolean');
    expect(isContract).toBe(false);
  });
});

describe('Validate Contract Type in Mumbai Network using contractType function', () => {
  it('Should return Undefined Contract', async () => {
    const provider = createMockProvider();
    const handleContractType = await getContractType(
      '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
      provider
    );

    expect(typeof handleContractType).toBe('object');
    expect(handleContractType).toBeDefined();
    if (handleContractType) {
      expect(typeof handleContractType.type).toBe('string');
      if (handleContractType.message) {
        expect(typeof handleContractType.message).toBe('string');
      }
      expect(handleContractType.type).toBe('Unknown');
    }
  });

  it('Should return ERC 20 Contract', async () => {
    const provider = createMockProvider();
    const handleContractType = await getContractType(
      '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa',
      provider
    );

    expect(typeof handleContractType).toBe('object');
    expect(handleContractType).toBeDefined();
    if (handleContractType) {
      expect(typeof handleContractType.type).toBe('string');
      // This address is configured as ERC-20 in the mock
      expect(handleContractType.type).toBe('ERC-20');
    }
  });

  it('Should return ERC 721 Contract', async () => {
    const provider = createMockProvider();
    const handleContractType = await getContractType(
      '0x0c702F78b889f25E3347fb978345F7eCF4F3861C',
      provider
    );

    expect(typeof handleContractType).toBe('object');
    expect(handleContractType).toBeDefined();
    if (handleContractType) {
      expect(typeof handleContractType.type).toBe('string');
      expect(handleContractType.type).toBe('ERC-721');
    }
  });

  it('Should return WETH ERC 1155 Contract', async () => {
    const provider = createMockProvider();
    const handleContractType = await getContractType(
      '0xAa54A8E8BdEA1aa7E2ed7E5F681c798a8ed7e5AB',
      provider
    );

    expect(typeof handleContractType).toBe('object');
    expect(handleContractType).toBeDefined();
    if (handleContractType) {
      expect(typeof handleContractType.type).toBe('string');
      expect(handleContractType.type).toBe('ERC-1155');
    }
  });
});

describe('Validate Contracts in Mumbai Network using contractChecker function', () => {
  it('Should return Undefined Contract', async () => {
    const provider = createMockProvider();
    const handleContractType = await contractChecker(
      '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
      provider
    );

    expect(typeof handleContractType).toBe('object');
    if (handleContractType && 'type' in handleContractType) {
      expect(typeof handleContractType.type).toBe('string');
      if (handleContractType.message) {
        expect(typeof handleContractType.message).toBe('string');
      }
      expect(handleContractType.type).toBe('Unknown');
    }
  });

  it('Should return ERC 20 Contract', async () => {
    const provider = createMockProvider();
    const handleContractType = await contractChecker(
      '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa',
      provider
    );

    expect(typeof handleContractType).toBe('object');
    if (handleContractType && 'type' in handleContractType) {
      expect(typeof handleContractType.type).toBe('string');
      expect(handleContractType.type).toBe('ERC-20');
    }
  });

  it('Should return ERC 721 Contract', async () => {
    const provider = createMockProvider();
    const handleContractType = await contractChecker(
      '0x0c702F78b889f25E3347fb978345F7eCF4F3861C',
      provider
    );

    expect(typeof handleContractType).toBe('object');
    if (handleContractType && 'type' in handleContractType) {
      expect(typeof handleContractType.type).toBe('string');
      expect(handleContractType.type).toBe('ERC-721');
    }
  });

  it('Should return WETH ERC 1155 Contract', async () => {
    const provider = createMockProvider();
    const handleContractType = await contractChecker(
      '0xAa54A8E8BdEA1aa7E2ed7E5F681c798a8ed7e5AB',
      provider
    );

    expect(typeof handleContractType).toBe('object');
    if (handleContractType && 'type' in handleContractType) {
      expect(typeof handleContractType.type).toBe('string');
      expect(handleContractType.type).toBe('ERC-1155');
    }
  });
});

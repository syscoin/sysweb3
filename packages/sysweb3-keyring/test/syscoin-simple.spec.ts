import * as sjs from 'syscoinjs-lib';

import { SyscoinTransactions } from '../src/transactions/syscoin';
import { KeyringAccountType } from '../src/types';

// Mock dependencies
jest.mock('@pollum-io/sysweb3-core', () => ({
  sysweb3Di: {
    getStateStorageDb: () => ({
      get: jest.fn(),
      set: jest.fn(),
      setClient: jest.fn(),
    }),
  },
}));

jest.mock('../src/ledger', () => ({
  LedgerKeyring: jest.fn(),
}));

jest.mock('../src/trezor', () => ({
  TrezorKeyring: jest.fn().mockImplementation(() => ({
    convertToTrezorFormat: jest.fn(),
    signUtxoTransaction: jest.fn(),
  })),
}));

describe('SyscoinTransactions', () => {
  let syscoinTransactions: SyscoinTransactions;
  let mockGetSigner: jest.Mock;
  let mockGetState: jest.Mock;
  let mockGetAddress: jest.Mock;
  let mockLedgerSigner: any;
  let mockHdSign: jest.Mock;
  let mockMainSignAndSend: jest.Mock;

  beforeEach(() => {
    // Create stable mocks
    mockHdSign = jest.fn(() => 'signed-psbt');
    mockMainSignAndSend = jest.fn(() => 'signed-and-sent-psbt');

    // Mock the signer
    mockGetSigner = jest.fn(() => ({
      hd: {
        Signer: {
          network: sjs.utils.syscoinNetworks.testnet,
          accountIndex: 0,
        },
        getAccountXpub: () =>
          'vpub5YBbnk2FsQPCd4LsK7rESWaGVeWtq7nr3SgrdbeaQgctXBwpFQfLbKdwtDAkxLwhKubbpNwQqKPodfKTwVc4uN8jbsknuPTpJuW8aN1S3nC',
        getNewChangeAddress: jest.fn(
          () => 'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4'
        ),
        sign: mockHdSign,
      },
      main: {
        blockbookURL: 'https://blockbook-dev.elint.services/',
        send: jest.fn(() => ({
          extractTransaction: () => ({
            getId: () => 'mock-txid-12345',
          }),
        })),
        createTransaction: jest.fn(() => ({
          toBase64: () => 'mock-base64',
          txInputs: [{ index: 0, hash: Buffer.alloc(32) }],
          txOutputs: [{ value: 1000000, address: 'tsys1test' }],
          data: { inputs: [{}] },
          extractTransaction: () => ({
            getId: () => 'mock-txid-12345',
            virtualSize: () => 250,
          }),
        })),
        createPSBTFromRes: jest.fn(() => 'mock-psbt'),
        signAndSend: mockMainSignAndSend,
      },
    }));

    // Mock the state
    mockGetState = jest.fn(() => ({
      activeAccountId: 0,
      accounts: {
        [KeyringAccountType.HDAccount]: {
          0: {
            id: 0,
            xpub: 'vpub5YBbnk2FsQPCd4LsK7rESWaGVeWtq7nr3SgrdbeaQgctXBwpFQfLbKdwtDAkxLwhKubbpNwQqKPodfKTwVc4uN8jbsknuPTpJuW8aN1S3nC',
            balances: { syscoin: 10 },
          },
        },
      },
      activeAccountType: KeyringAccountType.HDAccount,
      activeNetwork: {
        chainId: 5700,
        currency: 'tsys',
        url: 'https://blockbook-dev.elint.services/',
      },
    }));

    mockGetAddress = jest.fn(() =>
      Promise.resolve('tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4')
    );
    mockLedgerSigner = {};

    syscoinTransactions = new SyscoinTransactions(
      mockGetSigner,
      mockGetState,
      mockGetAddress,
      mockLedgerSigner
    );
  });

  describe('getRecommendedFee', () => {
    it('should return a recommended fee', async () => {
      // Mock the fetchEstimateFee function - returns SYS per kilobyte
      jest.spyOn(sjs.utils, 'fetchEstimateFee').mockResolvedValue(0.00088641);

      const fee = await syscoinTransactions.getRecommendedFee(
        'https://blockbook-dev.elint.services/'
      );

      expect(fee).toBeCloseTo(0.00088641 / 1024, 10); // 0.00088641 / 1024 (convert from SYS/kB to SYS/byte)
      expect(sjs.utils.fetchEstimateFee).toHaveBeenCalledWith(
        'https://blockbook-dev.elint.services/',
        1,
        undefined
      );
    });
  });

  describe('signPSBT', () => {
    it('should sign a PSBT', async () => {
      // Mock PSBT in Pali JSON format (what PsbtUtils.fromPali expects)
      const mockPaliPsbt = JSON.stringify({
        psbt: 'cHNidP8BANmCAAAAAXV1yEYFkSVeffIhpGoiJeEYWdwHtfutBmNrQq9Y3+yXAgAAAAD/////A6AJAQAAAAAAFgAUZMBLT7xge2bLcHuAmhtOdCUnv4kA4fUFAAAAAF9qTFwCg7Wg6XcBAAAAhsNAAQIJAAjBCGNHRnNhVEU9CTt7ImRlc2MiOiJjR0ZzYVNCa1pXMXZJR1JoY0hBZ2RHOXJaVzRnWTNKbFlYUmxJSFJsYzNRZ01RPT0ifQB/APS5PDADAAAAFgAUtji2FZyTh0hQCpxBnA47GNrn9fQAAAAAAAEBH/R8NzYDAAAAFgAUTTxsbg+2G8pcJY7dAQcZx1QtYHEBCGsCRzBEAiB8cJut6NP2IOGiFgAD2/0YM2otMAgvYlY51VyEoYWl0gIgYHXg85w1sJsHXuklbBYFarSVeYAuxoCIeU39HkLiO+IBIQKDuln5k6NYVB+eI+UIS6GMvaICoPDxp892khDysiiybgdhZGRyZXNzLHRzeXMxcWY1N3hjbXMwa2NkdTVocDkzbXdzenBjZWNhMno2Y3IzcjNjamNzBHBhdGgSbS84NCcvMScvMCcvMS8xNjU0AAAAAA==',
        // Additional properties that might be in Pali format
      });

      // Mock importPsbtFromJson to return a mock PSBT object
      const mockPsbtObj = {
        toBase64: () => 'mock-base64',
        txInputs: [],
        txOutputs: [],
        data: { inputs: [] },
      };
      jest.spyOn(sjs.utils, 'importPsbtFromJson').mockReturnValue(mockPsbtObj);

      // Mock exportPsbtToJson
      jest
        .spyOn(sjs.utils, 'exportPsbtToJson')
        .mockReturnValue({ signed: true } as any);

      const result = await syscoinTransactions.signPSBT({
        psbt: mockPaliPsbt,
        isTrezor: false,
        isLedger: false,
        pathIn: undefined,
      });

      expect(result).toBeDefined();
      expect(mockHdSign).toHaveBeenCalledWith(mockPsbtObj, ''); // pathIn defaults to empty string
    });

    it('should reject invalid PSBT format', async () => {
      // Mock importPsbtFromJson to throw error for invalid format
      jest.spyOn(sjs.utils, 'importPsbtFromJson').mockImplementation(() => {
        throw new Error('Invalid PSBT format');
      });

      await expect(
        syscoinTransactions.signPSBT({
          psbt: 'invalid-format!',
          pathIn: undefined,
        })
      ).rejects.toThrow('Invalid PSBT format');
    });
  });

  describe('estimateSysTransactionFee', () => {
    it('should estimate transaction fee', async () => {
      // The mockGetSigner().main.createTransaction is already mocked to return a proper PSBT object

      // Mock exportPsbtToJson for the return value conversion
      jest.spyOn(sjs.utils, 'exportPsbtToJson').mockReturnValue({
        psbt: 'mock-base64-psbt',
        fee: 0.00001,
      });

      const fee = await syscoinTransactions.getEstimateSysTransactionFee({
        txOptions: {},
        amount: 0.01,
        receivingAddress: 'tsys1test',
        feeRate: 0.0000001, // 10 sat/byte in SYS/byte
        token: null,
      });

      expect(fee.fee).toBeGreaterThan(0);
      expect(fee.psbt).toBeDefined();
    });
  });
});

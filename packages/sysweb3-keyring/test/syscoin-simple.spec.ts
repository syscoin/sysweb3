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
          extractTransaction: () => ({
            getId: () => 'mock-txid-12345',
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
      // Mock the fetchEstimateFee function
      jest.spyOn(sjs.utils, 'fetchEstimateFee').mockResolvedValue(10000);

      const fee = await syscoinTransactions.getRecommendedFee(
        'https://blockbook-dev.elint.services/'
      );

      expect(fee).toBe(0.0001); // 10000 / 10^8
      expect(sjs.utils.fetchEstimateFee).toHaveBeenCalledWith(
        'https://blockbook-dev.elint.services/',
        1,
        undefined
      );
    });
  });

  describe('signTransaction', () => {
    it('should sign a PSBT', async () => {
      const mockPsbt =
        'cHNidP8BANmCAAAAAXV1yEYFkSVeffIhpGoiJeEYWdwHtfutBmNrQq9Y3+yXAgAAAAD/////A6AJAQAAAAAAFgAUZMBLT7xge2bLcHuAmhtOdCUnv4kA4fUFAAAAAF9qTFwCg7Wg6XcBAAAAhsNAAQIJAAjBCGNHRnNhVEU9CTt7ImRlc2MiOiJjR0ZzYVNCa1pXMXZJR1JoY0hBZ2RHOXJaVzRnWTNKbFlYUmxJSFJsYzNRZ01RPT0ifQB/APS5PDADAAAAFgAUtji2FZyTh0hQCpxBnA47GNrn9fQAAAAAAAEBH/R8NzYDAAAAFgAUTTxsbg+2G8pcJY7dAQcZx1QtYHEBCGsCRzBEAiB8cJut6NP2IOGiFgAD2/0YM2otMAgvYlY51VyEoYWl0gIgYHXg85w1sJsHXuklbBYFarSVeYAuxoCIeU39HkLiO+IBIQKDuln5k6NYVB+eI+UIS6GMvaICoPDxp892khDysiiybgdhZGRyZXNzLHRzeXMxcWY1N3hjbXMwa2NkdTVocDkzbXdzenBjZWNhMno2Y3IzcjNjamNzBHBhdGgSbS84NCcvMScvMCcvMS8xNjU0AAAAAA==';

      // Mock exportPsbtToJson
      jest
        .spyOn(sjs.utils, 'exportPsbtToJson')
        .mockReturnValue({ signed: true } as any);

      const result = await syscoinTransactions.signTransaction(
        { psbt: mockPsbt },
        true
      );

      expect(result).toEqual({ signed: true });
      expect(mockHdSign).toHaveBeenCalledWith(mockPsbt, undefined);
    });

    it('should reject invalid base64 PSBT', async () => {
      await expect(
        syscoinTransactions.signTransaction({ psbt: 'invalid-base64!' }, true)
      ).rejects.toThrow('Bad Request: PSBT must be in Base64 format');
    });
  });

  describe('estimateSysTransactionFee', () => {
    it('should estimate transaction fee', async () => {
      // Mock the required functions
      jest.spyOn(sjs.utils, 'fetchBackendUTXOS').mockResolvedValue([
        {
          txid: 'abc123',
          vout: 0,
          value: '100000000',
          satoshis: 100000000,
        },
      ]);

      jest.spyOn(sjs.utils, 'sanitizeBlockbookUTXOs').mockReturnValue([
        {
          txid: 'abc123',
          vout: 0,
          value: 100000000,
        },
      ] as any);

      // Mock syscointx
      const syscointx = require('syscointx-js');
      syscointx.createTransaction = jest.fn(() => ({
        inputs: [{}],
        outputs: [{}, {}],
      }));

      const fee = await syscoinTransactions.estimateSysTransactionFee({
        outputs: [{ address: 'tsys1test', value: 1000000 }],
        changeAddress: 'tsys1change',
        feeRateBN: new sjs.utils.BN(10),
        xpub: 'vpub5YBbnk2FsQPCd4LsK7rESWaGVeWtq7nr3SgrdbeaQgctXBwpFQfLbKdwtDAkxLwhKubbpNwQqKPodfKTwVc4uN8jbsknuPTpJuW8aN1S3nC',
        explorerUrl: 'https://blockbook-dev.elint.services/',
      });

      expect(fee.toNumber()).toBeGreaterThan(0);
    });
  });
});

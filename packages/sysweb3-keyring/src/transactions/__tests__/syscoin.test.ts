import * as syscoinjs from 'syscoinjs-lib';

import { KeyringAccountType } from '../../types';
import { SyscoinTransactions } from '../syscoin';
import { INetworkType } from '@pollum-io/sysweb3-network';
import { getAsset } from '@pollum-io/sysweb3-utils';

// Mock dependencies
jest.mock('@pollum-io/sysweb3-utils', () => ({
  getAsset: jest.fn(),
  isBase64: jest.fn().mockReturnValue(true),
  countDecimals: jest.fn().mockReturnValue(8),
}));

jest.mock('syscoinjs-lib', () => ({
  utils: {
    BN: jest.fn().mockImplementation((value) => ({
      toNumber: () => value,
      add: jest.fn().mockReturnThis(),
      sub: jest.fn().mockReturnThis(),
      mul: jest.fn().mockReturnThis(),
    })),
    fetchBackendUTXOS: jest.fn().mockResolvedValue([]),
    sanitizeBlockbookUTXOs: jest.fn().mockReturnValue([]),
    fetchEstimateFee: jest.fn().mockResolvedValue(10000),
    importPsbtFromJson: jest.fn().mockReturnValue({
      extractTransaction: () => ({
        getId: () => 'mock-txid',
        outs: [],
      }),
      inputs: [],
      updateInput: jest.fn(),
      finalizeAllInputs: jest.fn(),
      toBase64: jest.fn().mockReturnValue('mock-signed-psbt'),
    }),
    exportPsbtToJson: jest.fn().mockReturnValue('mock-psbt-json'),
  },
  Psbt: {
    fromBase64: jest.fn().mockReturnValue({
      extractTransaction: () => ({
        getId: () => 'mock-txid',
        outs: [],
      }),
      inputs: [],
      updateInput: jest.fn(),
      finalizeAllInputs: jest.fn(),
      toBase64: jest.fn().mockReturnValue('mock-signed-psbt'),
    }),
  },
}));

jest.mock('syscointx-js', () => ({
  createTransaction: jest.fn().mockResolvedValue({
    inputs: [],
    outputs: [],
  }),
  assetAllocationSend: jest.fn().mockResolvedValue({
    extractTransaction: () => ({
      getId: () => 'mock-token-txid',
    }),
  }),
}));

jest.mock('coinselectsyscoin', () => ({
  utils: {
    transactionBytes: jest.fn().mockReturnValue(250),
  },
}));

describe('SyscoinTransactions', () => {
  let syscoinTransactions: SyscoinTransactions;
  let mockGetSigner: jest.Mock;
  let mockGetState: jest.Mock;
  let mockGetAddress: jest.Mock;
  let mockLedger: any;
  let mockTrezor: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock signers
    mockGetSigner = jest.fn().mockReturnValue({
      hd: {
        Signer: {
          network: 'mainnet',
        },
      },
      main: {
        blockbookURL: 'https://blockbook.test',
        createPSBTFromRes: jest.fn().mockResolvedValue('mock-unsigned-psbt'),
        assetAllocationSend: jest.fn().mockResolvedValue({
          psbt: 'mock-token-psbt',
        }),
        send: jest.fn().mockResolvedValue({
          extractTransaction: () => ({
            getId: () => 'broadcast-txid',
          }),
        }),
      },
    });

    // Mock state
    mockGetState = jest.fn().mockReturnValue({
      activeAccountId: 0,
      activeAccountType: KeyringAccountType.HDAccount,
      accounts: {
        [KeyringAccountType.HDAccount]: {
          0: {
            xpub: 'mock-xpub',
            id: 0,
            isTrezorWallet: false,
            isLedgerWallet: false,
          },
        },
      },
      activeNetwork: {
        currency: 'sys',
        chainId: 57,
        kind: INetworkType.Syscoin,
        url: 'https://blockbook.test',
        slip44: 57,
        label: 'Syscoin Mainnet',
      },
    });

    // Mock address getter
    mockGetAddress = jest.fn().mockResolvedValue('mock-change-address');

    // Mock Trezor
    mockTrezor = {
      init: jest.fn(),
      convertToTrezorFormat: jest.fn().mockReturnValue('mock-trezor-tx'),
      signUtxoTransaction: jest
        .fn()
        .mockResolvedValue('mock-trezor-signed-psbt'),
    };

    // Mock Ledger
    mockLedger = {
      ledgerTransport: true,
      ledgerUtxoClient: {
        getMasterFingerprint: jest.fn().mockResolvedValue('1234abcd'),
        signPsbt: jest
          .fn()
          .mockResolvedValue([
            [0, { pubkey: Buffer.from(''), signature: Buffer.from('') }],
          ]),
      },
      connectToLedgerDevice: jest.fn(),
    };

    // Create instance
    syscoinTransactions = new SyscoinTransactions(
      mockGetSigner,
      mockGetSigner,
      mockGetState,
      mockGetAddress,
      mockLedger,
      mockTrezor
    );
  });

  describe('getEstimateSysTransactionFee', () => {
    it('should create and sign a native transaction for HD wallet', async () => {
      const result = await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 1,
        receivingAddress: 'sys1qtest',
        feeRate: 0.00001,
        txOptions: { rbf: true },
      });

      expect(result).toEqual({
        fee: expect.any(Number),
        psbt: expect.any(String),
      });

      expect(mockGetSigner().main.createPSBTFromRes).toHaveBeenCalled();
    });

    it('should create and sign a token transaction', async () => {
      (getAsset as jest.Mock).mockResolvedValue({
        assetGuid: '123456',
        decimals: 8,
      });

      const result = await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 100,
        receivingAddress: 'sys1qtest',
        feeRate: 0.00001,
        token: { guid: '123456', symbol: 'TEST' },
      });

      expect(result).toEqual({
        fee: expect.any(Number),
        psbt: expect.any(String),
      });

      expect(mockGetSigner().main.assetAllocationSend).toHaveBeenCalledWith(
        { rbf: true },
        expect.any(Map),
        'mock-change-address',
        expect.any(Object),
        'mock-xpub'
      );
    });

    it('should handle Trezor signing separately', async () => {
      // First get fee estimate (unsigned PSBT)
      const feeResult = await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 1,
        receivingAddress: 'sys1qtest',
      });

      expect(feeResult.psbt).toBeDefined();
      expect(feeResult.fee).toBeGreaterThan(0);

      // Then sign separately
      const signedPsbt = await syscoinTransactions.signPSBT({
        psbt: feeResult.psbt,
        isTrezor: true,
      });

      expect(mockTrezor.init).toHaveBeenCalled();
      expect(mockTrezor.signUtxoTransaction).toHaveBeenCalled();
      expect(signedPsbt).toBe('mock-trezor-signed-psbt');
    });

    it('should handle Ledger signing separately', async () => {
      mockGetState.mockReturnValue({
        ...mockGetState(),
        accounts: {
          [KeyringAccountType.Ledger]: {
            0: {
              xpub: 'mock-xpub',
              id: 0,
              isLedgerWallet: true,
            },
          },
        },
        activeAccountType: KeyringAccountType.Ledger,
      });

      // First get fee estimate (unsigned PSBT)
      const feeResult = await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 1,
        receivingAddress: 'sys1qtest',
      });

      expect(feeResult.psbt).toBeDefined();
      expect(feeResult.fee).toBeGreaterThan(0);

      // Then sign separately
      const signedPsbt = await syscoinTransactions.signPSBT({
        psbt: feeResult.psbt,
        isLedger: true,
      });

      expect(mockLedger.ledgerUtxoClient.signPsbt).toHaveBeenCalled();
      expect(signedPsbt).toBe('mock-signed-psbt');
    });

    it('should throw error when token is not found', async () => {
      (getAsset as jest.Mock).mockResolvedValue(null);

      await expect(
        syscoinTransactions.getEstimateSysTransactionFee({
          amount: 100,
          receivingAddress: 'sys1qtest',
          token: { guid: 'invalid', symbol: 'INVALID' },
        })
      ).rejects.toThrow('Failed to create transaction: Token not found');
    });

    it('should use recommended fee when feeRate not provided', async () => {
      await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 1,
        receivingAddress: 'sys1qtest',
      });

      expect(syscoinjs.utils.fetchEstimateFee).toHaveBeenCalled();
    });
  });

  describe('sendTransaction', () => {
    it('should require pre-signed PSBT', async () => {
      await expect(syscoinTransactions.sendTransaction('')).rejects.toThrow(
        'Pre-signed PSBT is required'
      );
    });

    it('should send pre-signed PSBT', async () => {
      await syscoinTransactions.sendTransaction('mock-signed-psbt');

      // Verify the PSBT was sent correctly
      expect(mockGetSigner().main.send).toHaveBeenCalledWith(
        'mock-signed-psbt'
      );
    });

    it('should handle JSON PSBTs', async () => {
      const jsonPsbt = JSON.stringify({ test: 'psbt' });
      await syscoinTransactions.sendTransaction(jsonPsbt);

      expect(mockGetSigner().main.send).toHaveBeenCalledWith({ test: 'psbt' });
    });
  });

  describe('deprecated methods', () => {
    it('should throw error for confirmCustomTokenSend', async () => {
      await expect(
        (syscoinTransactions as any).confirmCustomTokenSend({})
      ).rejects.toThrow('This method is deprecated');
    });

    it('should throw error for confirmNativeTokenSend', async () => {
      await expect(
        (syscoinTransactions as any).confirmNativeTokenSend({})
      ).rejects.toThrow('This method is deprecated');
    });
  });

  describe('edge cases', () => {
    it('should handle signing errors gracefully', async () => {
      const mockError = new Error('Device disconnected');
      mockGetSigner.mockReturnValue({
        ...mockGetSigner(),
        hd: {
          sign: jest.fn().mockRejectedValue(mockError),
        },
      });

      await expect(
        syscoinTransactions.getEstimateSysTransactionFee({
          amount: 1,
          receivingAddress: 'sys1qtest',
        })
      ).rejects.toThrow('Failed to sign transaction');
    });

    it('should handle network errors', async () => {
      syscoinjs.utils.fetchBackendUTXOS = jest
        .fn()
        .mockRejectedValue(new Error('Network error'));

      await expect(
        syscoinTransactions.getEstimateSysTransactionFee({
          amount: 1,
          receivingAddress: 'sys1qtest',
        })
      ).rejects.toThrow('Failed to create transaction');
    });

    it('should handle Ledger not connected', async () => {
      mockLedger.ledgerTransport = null;

      const { psbt } = await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 1,
        receivingAddress: 'sys1qtest',
      });

      // Test signing which would trigger Ledger connection
      await syscoinTransactions.signPSBT({
        psbt,
        isLedger: true,
      });

      expect(mockLedger.connectToLedgerDevice).toHaveBeenCalled();
    });
  });

  describe('PSBT flow integration', () => {
    it('should maintain PSBT integrity through sign and send', async () => {
      // Create and sign
      const { psbt } = await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 1,
        receivingAddress: 'sys1qtest',
        feeRate: 0.00001,
      });

      // Send
      const result = await syscoinTransactions.sendTransaction(psbt);

      expect(result.txid).toBe('broadcast-txid');
    });

    it('should handle token transactions end-to-end', async () => {
      (getAsset as jest.Mock).mockResolvedValue({
        assetGuid: '123456',
        decimals: 8,
      });

      // Create and sign token transaction
      const { psbt, fee } =
        await syscoinTransactions.getEstimateSysTransactionFee({
          amount: 100,
          receivingAddress: 'sys1qtest',
          token: { guid: '123456', symbol: 'TEST' },
        });

      expect(fee).toBeGreaterThan(0);

      // Send token transaction
      const result = await syscoinTransactions.sendTransaction(psbt);

      expect(result.txid).toBe('broadcast-txid');
    });
  });
});

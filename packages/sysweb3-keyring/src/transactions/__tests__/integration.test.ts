import { KeyringAccountType } from '../../types';
import { SyscoinTransactions } from '../syscoin';

// Integration tests for the complete transaction flow
describe('PSBT Transaction Flow Integration', () => {
  let syscoinTransactions: SyscoinTransactions;
  let mockSigner: any;
  let mockState: any;
  let mockLedger: any;

  beforeEach(() => {
    // Setup comprehensive mocks
    mockSigner = {
      hd: {
        Signer: { network: 'mainnet' },
        sign: jest.fn().mockResolvedValue('signed-psbt'),
      },
      main: {
        blockbookURL: 'https://blockbook.test',
        createPSBTFromRes: jest.fn().mockResolvedValue('unsigned-psbt'),
        assetAllocationSend: jest.fn().mockResolvedValue({
          psbt: 'unsigned-token-psbt',
        }),
        send: jest.fn().mockResolvedValue({
          extractTransaction: () => ({ getId: () => 'final-txid' }),
        }),
      },
    };

    mockState = {
      activeAccountId: 0,
      activeAccountType: KeyringAccountType.HDAccount,
      accounts: {
        [KeyringAccountType.HDAccount]: {
          0: { xpub: 'xpub123', id: 0 },
        },
      },
      activeNetwork: { currency: 'sys', chainId: 57 },
    };

    mockLedger = {
      ledgerTransport: true,
      ledgerUtxoClient: {
        getMasterFingerprint: jest.fn().mockResolvedValue('fingerprint'),
        signPsbt: jest.fn().mockResolvedValue([[0, { signature: 'sig' }]]),
      },
    };

    const mockGetAddress = jest.fn().mockResolvedValue('change-address');

    const mockTrezor = {
      init: jest.fn(),
      convertToTrezorFormat: jest.fn(),
      signUtxoTransaction: jest.fn(),
    } as any;

    syscoinTransactions = new SyscoinTransactions(
      () => mockSigner,
      () => mockSigner, // getReadOnlySigner - same mock for testing
      () => mockState,
      mockGetAddress,
      mockLedger,
      mockTrezor
    );
  });

  describe('Complete Native Transaction Flow', () => {
    it('should handle native transaction from creation to broadcast', async () => {
      // Step 1: Create unsigned PSBT and get fee
      const { fee, psbt: unsignedPsbt } =
        await syscoinTransactions.getEstimateSysTransactionFee({
          amount: 1,
          receivingAddress: 'sys1qtest',
          feeRate: 0.00001,
        });

      expect(fee).toBeGreaterThan(0);
      expect(unsignedPsbt).toBeDefined();

      // Step 2: Sign the PSBT
      const signedPsbt = await syscoinTransactions.signPSBT({
        psbt: unsignedPsbt,
        isTrezor: false,
        isLedger: false,
      });

      // Step 3: Send the signed PSBT
      const result = await syscoinTransactions.sendTransaction(signedPsbt);

      expect(result.txid).toBe('final-txid');
      expect(mockSigner.main.send).toHaveBeenCalledWith(signedPsbt);
    });
  });

  describe('Complete Token Transaction Flow', () => {
    it('should handle token transaction from creation to broadcast', async () => {
      // Mock token lookup
      jest.doMock('@pollum-io/sysweb3-utils', () => ({
        getAsset: jest.fn().mockResolvedValue({
          assetGuid: 'token123',
          decimals: 8,
        }),
      }));

      // Step 1: Create unsigned token PSBT and get fee
      const { fee, psbt: unsignedPsbt } =
        await syscoinTransactions.getEstimateSysTransactionFee({
          amount: 100,
          receivingAddress: 'sys1qtest',
          token: { guid: 'token123', symbol: 'TEST' },
        });

      expect(fee).toBeGreaterThan(0);
      expect(unsignedPsbt).toBeDefined();
      expect(mockSigner.main.assetAllocationSend).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Map),
        'change-address',
        expect.any(Object),
        'xpub123'
      );

      // Step 2: Sign the token PSBT
      const signedPsbt = await syscoinTransactions.signPSBT({
        psbt: unsignedPsbt,
        isTrezor: false,
        isLedger: false,
      });

      // Step 3: Send the signed PSBT
      const result = await syscoinTransactions.sendTransaction(signedPsbt);

      expect(result.txid).toBe('final-txid');
    });
  });

  describe('Hardware Wallet Integration', () => {
    it('should handle Trezor transaction flow', async () => {
      const mockTrezor = {
        init: jest.fn(),
        convertToTrezorFormat: jest.fn().mockReturnValue('trezor-format'),
        signUtxoTransaction: jest.fn().mockResolvedValue('trezor-signed-psbt'),
      };
      (syscoinTransactions as any).trezor = mockTrezor;

      // Create unsigned PSBT
      const { fee, psbt: unsignedPsbt } =
        await syscoinTransactions.getEstimateSysTransactionFee({
          amount: 1,
          receivingAddress: 'sys1qtest',
        });

      expect(fee).toBeGreaterThan(0);
      expect(unsignedPsbt).toBeDefined();

      // Sign with Trezor
      const signedPsbt = await syscoinTransactions.signPSBT({
        psbt: unsignedPsbt,
        isTrezor: true,
      });

      expect(mockTrezor.init).toHaveBeenCalled();
      expect(mockTrezor.signUtxoTransaction).toHaveBeenCalled();
      expect(signedPsbt).toBe('trezor-signed-psbt');

      // Send
      const result = await syscoinTransactions.sendTransaction(signedPsbt);

      expect(result.txid).toBe('final-txid');
    });

    it('should handle Ledger transaction flow', async () => {
      mockState.activeAccountType = KeyringAccountType.Ledger;
      mockState.accounts[KeyringAccountType.Ledger] = {
        0: { xpub: 'ledger-xpub', id: 0, isLedgerWallet: true },
      };

      // Mock Psbt for Ledger
      jest.doMock('syscoinjs-lib', () => ({
        Psbt: {
          fromBase64: jest.fn().mockReturnValue({
            updateInput: jest.fn(),
            finalizeAllInputs: jest.fn(),
            toBase64: jest.fn().mockReturnValue('ledger-signed-psbt'),
          }),
        },
      }));

      // Create unsigned PSBT
      const { fee, psbt: unsignedPsbt } =
        await syscoinTransactions.getEstimateSysTransactionFee({
          amount: 1,
          receivingAddress: 'sys1qtest',
        });

      expect(fee).toBeGreaterThan(0);
      expect(unsignedPsbt).toBeDefined();

      // Sign with Ledger
      const signedPsbt = await syscoinTransactions.signPSBT({
        psbt: unsignedPsbt,
        isLedger: true,
      });

      expect(mockLedger.ledgerUtxoClient.signPsbt).toHaveBeenCalled();
      expect(signedPsbt).toBeDefined();

      // Send
      const result = await syscoinTransactions.sendTransaction(signedPsbt);

      expect(result.txid).toBe('final-txid');
    });
  });

  describe('Error Scenarios', () => {
    it('should handle signing errors separately from sending errors', async () => {
      // Test signing error
      mockSigner.hd.sign = jest
        .fn()
        .mockRejectedValue(new Error('Device disconnected'));

      await expect(
        syscoinTransactions.getEstimateSysTransactionFee({
          amount: 1,
          receivingAddress: 'sys1qtest',
        })
      ).rejects.toThrow('Failed to sign transaction: Device disconnected');

      // Test sending error
      mockSigner.main.send = jest
        .fn()
        .mockRejectedValue(new Error('Network error'));

      await expect(
        syscoinTransactions.sendTransaction('valid-psbt')
      ).rejects.toThrow('Failed to send transaction');
    });

    it('should require PSBT for sendTransaction', async () => {
      await expect(syscoinTransactions.sendTransaction('')).rejects.toThrow(
        'Pre-signed PSBT is required'
      );
    });
  });

  describe('Fee Calculation', () => {
    it('should calculate correct fees for multi-input transactions', async () => {
      // Mock multiple UTXOs
      const mockUtxos = [
        { txid: 'tx1', vout: 0, value: '50000000' },
        { txid: 'tx2', vout: 1, value: '30000000' },
        { txid: 'tx3', vout: 0, value: '20000000' },
      ];

      jest.doMock('syscoinjs-lib', () => ({
        utils: {
          fetchBackendUTXOS: jest.fn().mockResolvedValue(mockUtxos),
          sanitizeBlockbookUTXOs: jest.fn().mockReturnValue(mockUtxos),
        },
      }));

      jest.doMock('coinselectsyscoin', () => ({
        utils: {
          transactionBytes: jest.fn().mockReturnValue(500), // Larger tx with multiple inputs
        },
      }));

      const { fee } = await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 0.8, // Amount that requires multiple UTXOs
        receivingAddress: 'sys1qtest',
        feeRate: 0.00001,
      });

      // Fee should be proportional to transaction size
      expect(fee).toBeGreaterThan(0.00001); // More than minimum
    });
  });

  describe('RBF Support', () => {
    it('should create RBF-enabled transactions by default', async () => {
      await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 1,
        receivingAddress: 'sys1qtest',
      });

      // Check that RBF was enabled in the transaction options
      expect(mockSigner.main.createPSBTFromRes).toHaveBeenCalled();
      const callArgs = mockSigner.main.createPSBTFromRes.mock.calls[0];
      expect(callArgs[0]).toMatchObject({ rbf: true });
    });

    it('should disable RBF when requested', async () => {
      await syscoinTransactions.getEstimateSysTransactionFee({
        amount: 1,
        receivingAddress: 'sys1qtest',
        txOptions: { rbf: false },
      });

      const callArgs = mockSigner.main.createPSBTFromRes.mock.calls[0];
      expect(callArgs[0]).toMatchObject({ rbf: false });
    });
  });
});

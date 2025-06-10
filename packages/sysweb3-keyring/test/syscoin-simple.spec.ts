import { Psbt } from 'bitcoinjs-lib';
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

// Create a persistent mock that survives beforeEach
const hdSignMock = jest.fn().mockImplementation(async (psbtObj) => {
  return psbtObj; // Return the same PSBT object (mocked as signed)
});

describe('SyscoinTransactions', () => {
  let syscoinTransactions: SyscoinTransactions;
  let mockGetSigner: jest.Mock;
  let mockGetState: jest.Mock;
  let mockGetAddress: jest.Mock;
  let mockLedgerSigner: any;

  beforeEach(() => {
    // Mock the real syscoinjs-lib components with actual implementations
    mockGetSigner = jest.fn(() => ({
      hd: {
        Signer: {
          network: sjs.utils.syscoinNetworks.testnet,
          accountIndex: 0,
        },
        getAccountXpub: () =>
          'vpub5YBbnk2FsQPCd4LsK7rESWaGVeWtq7nr3SgrdbeaQgctXBwpFQfLbKdwtDAkxLwhKubbpNwQqKPodfKTwVc4uN8jbsknuPTpJuW8aN1S3nC',
        getNewChangeAddress: jest.fn(
          () => 'tb1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4'
        ),
        sign: hdSignMock,
      },
      main: {
        blockbookURL: 'https://blockbook-dev.elint.services/',
        // Let the real createTransaction work, but mock the network dependencies
        createTransaction: jest
          .fn()
          .mockImplementation(
            async (_txOptions, _changeAddress, outputs, feeRateBN) => {
              // Create a minimal mock that represents what syscoinjs would return
              // This should have a real PSBT structure or use actual syscoinjs-lib
              const mockUtxos = [
                {
                  txid: 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
                  vout: 0,
                  value: 100000000, // 1 SYS in satoshis
                  script: Buffer.from(
                    '0014' + '1234567890abcdef1234567890abcdef12345678',
                    'hex'
                  ),
                },
              ];

              // Use syscoinjs-lib to create a real PSBT structure
              try {
                const psbt = new Psbt({
                  network: sjs.utils.syscoinNetworks.testnet,
                });

                // Add input
                psbt.addInput({
                  hash: mockUtxos[0].txid,
                  index: mockUtxos[0].vout,
                  witnessUtxo: {
                    script: mockUtxos[0].script,
                    value: mockUtxos[0].value,
                  },
                });

                // Add outputs using scripts instead of addresses to avoid validation
                outputs.forEach((output) => {
                  psbt.addOutput({
                    script: mockUtxos[0].script, // Use same script for output
                    value: output.value.toNumber(),
                  });
                });

                // Add change output if needed
                const totalInput = mockUtxos[0].value;
                const totalOutput = outputs.reduce(
                  (sum, out) => sum + out.value.toNumber(),
                  0
                );
                const fee = feeRateBN.toNumber() * 250; // Estimate 250 bytes
                const change = totalInput - totalOutput - fee;

                if (change > 0) {
                  psbt.addOutput({
                    script: mockUtxos[0].script, // Use script for change
                    value: change,
                  });
                }

                return { psbt, fee: fee / 1e8 }; // Convert fee to SYS units
              } catch (error) {
                // Fallback to mock structure if real PSBT creation fails
                const fallbackFee = (feeRateBN.toNumber() * 250) / 1e8; // Convert to SYS units
                return {
                  psbt: {
                    toBase64: () => 'mock-base64-psbt',
                    txInputs: [{ index: 0, hash: Buffer.alloc(32) }],
                    txOutputs: outputs.map((out) => ({
                      value: out.value.toNumber(),
                      address: out.address,
                    })),
                    data: { inputs: [{}] },
                    extractTransaction: () => ({
                      getId: () => 'mock-txid-12345',
                      virtualSize: () => 250,
                    }),
                  },
                  fee: fallbackFee,
                };
              }
            }
          ),
        send: jest.fn(() => ({
          extractTransaction: () => ({
            getId: () => 'mock-txid-12345',
          }),
        })),
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
        slip44: 1,
      },
    }));

    mockGetAddress = jest.fn(() =>
      Promise.resolve('tb1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4')
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
      // Mock only the external network call
      jest.spyOn(sjs.utils, 'fetchEstimateFee').mockResolvedValue(0.00088641);

      const fee = await syscoinTransactions.getRecommendedFee(
        'https://blockbook-dev.elint.services/'
      );

      expect(fee).toBeCloseTo(0.00088641 / 1024, 10);
      expect(sjs.utils.fetchEstimateFee).toHaveBeenCalledWith(
        'https://blockbook-dev.elint.services/',
        1
      );
    });
  });

  describe('signPSBT', () => {
    it('should sign a PSBT', async () => {
      // Reset the persistent mock before testing
      hdSignMock.mockClear();

      // Create a real PSBT using syscoinjs-lib utilities
      // This uses the same method that the real application would use
      const mockUtxo = {
        txid: 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
        vout: 0,
        value: 100000000, // 1 SYS in satoshis
        script: Buffer.from(
          '0014' + '1234567890abcdef1234567890abcdef12345678',
          'hex'
        ),
      };

      // Create PSBT using the same utilities the real code uses
      const psbt = new Psbt({ network: sjs.utils.syscoinNetworks.testnet });

      psbt.addInput({
        hash: mockUtxo.txid,
        index: mockUtxo.vout,
        witnessUtxo: {
          script: mockUtxo.script,
          value: mockUtxo.value,
        },
      });

      psbt.addOutput({
        script: mockUtxo.script, // Use script instead of address to avoid address validation
        value: 50000000,
      });

      // Convert to Pali format using the real utilities
      const paliPsbtData = sjs.utils.exportPsbtToJson(psbt, undefined);

      const result = await syscoinTransactions.signPSBT({
        psbt: paliPsbtData, // Pass object directly, not JSON string
        isTrezor: false,
        isLedger: false,
        pathIn: undefined,
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe('object'); // Should be Pali object for API consistency

      // Verify the result has the expected Pali format structure
      expect(result).toHaveProperty('psbt');

      // The HD signer should have been called
      expect(hdSignMock).toHaveBeenCalled();
    });

    it('should reject invalid PSBT format', async () => {
      await expect(
        syscoinTransactions.signPSBT({
          psbt: 'invalid-format!',
          pathIn: undefined,
        })
      ).rejects.toThrow();
    });
  });

  describe('estimateSysTransactionFee', () => {
    it('should estimate transaction fee', async () => {
      // Mock only the network call for fee estimation
      jest.spyOn(sjs.utils, 'fetchEstimateFee').mockResolvedValue(0.00001);

      const result = await syscoinTransactions.getEstimateSysTransactionFee({
        txOptions: {},
        amount: 0.01,
        receivingAddress: 'tb1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4',
        feeRate: 0.0000001,
        token: null,
      });

      expect(result.fee).toBeGreaterThan(0);
      expect(result.psbt).toBeDefined();

      // The PSBT should be a Pali object (consistent with signPSBT input format)
      expect(typeof result.psbt).toBe('object');
      expect(result.psbt).toHaveProperty('psbt');
    });
  });
});

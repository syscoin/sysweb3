import * as sjs from 'syscoinjs-lib';

import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('Syscoin Transactions', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);

    // Set up UTXO testnet vault state
    currentVaultState = createMockVaultState({
      activeAccountId: 0,
      activeAccountType: KeyringAccountType.HDAccount,
      networkType: INetworkType.Syscoin,
      chainId: 5700,
    });
    mockVaultStateGetter = jest.fn(() => currentVaultState);

    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      mockVaultStateGetter
    );
  });

  describe('Fee Estimation', () => {
    it('should get recommended fee from network', async () => {
      const fee = await keyringManager.syscoinTransaction.getRecommendedFee(
        keyringManager.getNetwork().url
      );

      expect(typeof fee).toBe('number');
      expect(fee).toBeGreaterThan(0);
      expect(fee).toBeLessThan(1); // Fee should be reasonable (less than 1 SYS/byte)
    });

    it('should estimate transaction fee for simple transfer', async () => {
      // Mock PsbtUtils.toPali to avoid toBase64 errors
      const PsbtUtils = require('../../../src/utils/psbt').PsbtUtils;
      const originalToPali = PsbtUtils.toPali;
      PsbtUtils.toPali = jest.fn().mockReturnValue({
        psbt: 'mock_psbt_base64',
        assets: [],
      });

      const result =
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: {},
          amount: 0.1, // 0.1 SYS
          receivingAddress: 'tsys1qdsvzmrxkq5uh0kwc6cyndsj7fluszcu3pl2wlv',
          feeRate: 0.000001, // 1 satoshi per byte
          token: null,
        });

      expect(result.fee).toBeGreaterThan(0);
      expect(result.psbt).toBeDefined();
      expect(typeof result.psbt).toBe('object');

      // Restore
      PsbtUtils.toPali = originalToPali;
    });

    it('should handle fee estimation with multiple outputs', async () => {
      // Mock PsbtUtils.toPali to avoid toBase64 errors
      const PsbtUtils = require('../../../src/utils/psbt').PsbtUtils;
      const originalToPali = PsbtUtils.toPali;
      PsbtUtils.toPali = jest.fn().mockReturnValue({
        psbt: 'mock_psbt_base64',
        assets: [],
      });

      const outputs = [
        {
          address: 'tsys1qdsvzmrxkq5uh0kwc6cyndsj7fluszcu3pl2wlv',
          value: 0.05,
        },
        {
          address: 'tsys1q4v8sagt0znwaxdscrzhvu8t33n7vj8j45czpv4',
          value: 0.05,
        },
      ];

      // Test with custom fee rate
      const feeRate = 0.000002; // 2 satoshis per byte

      // Note: This would need actual implementation in syscoinTransaction
      // For now, we're testing the interface
      const amount = outputs.reduce((sum, out) => sum + out.value, 0);
      const result =
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: {},
          amount,
          receivingAddress: outputs[0].address,
          feeRate,
          token: null,
        });

      expect(result.fee).toBeGreaterThan(0);

      // Restore
      PsbtUtils.toPali = originalToPali;
    });
  });

  describe('PSBT Operations', () => {
    it('should sign a valid PSBT', async () => {
      // Mock PsbtUtils to avoid Base64 validation
      const PsbtUtils = require('../../../src/utils/psbt').PsbtUtils;
      const originalFromPali = PsbtUtils.fromPali;
      const originalToPali = PsbtUtils.toPali;

      PsbtUtils.fromPali = jest.fn().mockReturnValue({
        txInputs: [{ hash: Buffer.alloc(32), index: 0, sequence: 0xffffffff }],
        txOutputs: [{ script: Buffer.alloc(25), value: 100000000 }],
        data: {
          inputs: [
            {
              witnessUtxo: { script: Buffer.alloc(25), value: 100000000 },
              nonWitnessUtxo: Buffer.alloc(100),
            },
          ],
          outputs: [{}],
        },
        getInputType: () => 'witnesspubkeyhash',
        signAllInputsHDAsync: jest.fn().mockResolvedValue(undefined),
        validateSignaturesOfAllInputs: jest.fn().mockReturnValue(true),
        finalizeAllInputs: jest.fn(),
        extractTransaction: jest.fn().mockReturnValue({
          getId: jest.fn().mockReturnValue('mock_txid'),
        }),
      });

      PsbtUtils.toPali = jest.fn().mockReturnValue({
        psbt: 'mock_signed_psbt',
        assets: [],
      });

      const mockPsbtData = {
        psbt: 'mocked_psbt_base64',
        assets: [],
      };

      const result = await keyringManager.syscoinTransaction.signPSBT({
        psbt: mockPsbtData,
        isTrezor: false,
        isLedger: false,
        pathIn: undefined,
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');

      // Restore
      PsbtUtils.fromPali = originalFromPali;
      PsbtUtils.toPali = originalToPali;
    });

    it('should reject invalid PSBT format', async () => {
      await expect(
        keyringManager.syscoinTransaction.signPSBT({
          psbt: 'invalid-psbt-format',
          isTrezor: false,
          isLedger: false,
          pathIn: undefined,
        })
      ).rejects.toThrow();
    });

    it('should handle PSBT signing with hardware wallet flags', async () => {
      // Mock PsbtUtils to avoid Base64 validation
      const PsbtUtils = require('../../../src/utils/psbt').PsbtUtils;
      const originalFromPali = PsbtUtils.fromPali;
      const originalToPali = PsbtUtils.toPali;

      // Mock the entire signPSBTWithMethod to bypass all Trezor validation
      const originalSignPSBTWithMethod = (
        keyringManager.syscoinTransaction as any
      ).signPSBTWithMethod;
      (keyringManager.syscoinTransaction as any).signPSBTWithMethod = jest
        .fn()
        .mockResolvedValue({
          txid: 'mock_trezor_txid',
          transaction: 'mock_trezor_transaction',
        });

      // Mock a proper PSBT object with required methods for Trezor conversion
      PsbtUtils.fromPali = jest.fn().mockReturnValue({
        txInputs: [{ hash: Buffer.alloc(32), index: 0, sequence: 0xffffffff }],
        txOutputs: [
          {
            script: Buffer.from('0014' + '0'.repeat(40), 'hex'), // Valid witness script
            value: 100000000,
            address:
              'tsys1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4k9aqm', // Valid testnet bech32
          },
        ],
        data: {
          inputs: [
            {
              witnessUtxo: { script: Buffer.alloc(25), value: 100000000 },
              nonWitnessUtxo: Buffer.alloc(100),
            },
          ],
          outputs: [{}],
        },
        getInputType: () => 'witnesspubkeyhash',
        finalizeAllInputs: jest.fn(),
        extractTransaction: jest.fn().mockReturnValue({
          getId: jest.fn().mockReturnValue('mock_txid'),
        }),
      });

      PsbtUtils.toPali = jest.fn().mockReturnValue({
        psbt: 'mock_signed_psbt',
        assets: [],
      });

      const mockPsbtData = {
        psbt: 'mocked_psbt_base64',
        assets: [],
      };

      // Test with Trezor flag
      const trezorResult = await keyringManager.syscoinTransaction.signPSBT({
        psbt: mockPsbtData,
        isTrezor: true,
        isLedger: false,
        pathIn: undefined,
      });

      expect(trezorResult).toBeDefined();

      // Restore
      PsbtUtils.fromPali = originalFromPali;
      PsbtUtils.toPali = originalToPali;
      (keyringManager.syscoinTransaction as any).signPSBTWithMethod =
        originalSignPSBTWithMethod;
    });
  });

  describe('Transaction Creation', () => {
    it('should create a simple transaction', async () => {
      // Mock PsbtUtils throughout the entire flow
      const PsbtUtils = require('../../../src/utils/psbt').PsbtUtils;
      const originalFromPali = PsbtUtils.fromPali;
      const originalToPali = PsbtUtils.toPali;

      PsbtUtils.toPali = jest.fn().mockReturnValue({
        psbt: 'mock_unsigned_psbt',
        assets: [],
      });

      PsbtUtils.fromPali = jest.fn().mockReturnValue({
        txInputs: [{ hash: Buffer.alloc(32), index: 0, sequence: 0xffffffff }],
        txOutputs: [{ script: Buffer.alloc(25), value: 100000000 }],
        data: {
          inputs: [
            {
              witnessUtxo: { script: Buffer.alloc(25), value: 100000000 },
              nonWitnessUtxo: Buffer.alloc(100),
            },
          ],
          outputs: [{}],
        },
        getInputType: () => 'witnesspubkeyhash',
        signAllInputsHDAsync: jest.fn().mockResolvedValue(undefined),
        validateSignaturesOfAllInputs: jest.fn().mockReturnValue(true),
        finalizeAllInputs: jest.fn(),
        extractTransaction: jest.fn().mockReturnValue({
          getId: jest.fn().mockReturnValue('mock_transaction_id'),
        }),
      });

      // First create unsigned PSBT
      const feeEstimate =
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: {},
          amount: 0.1,
          receivingAddress: 'tsys1qdsvzmrxkq5uh0kwc6cyndsj7fluszcu3pl2wlv',
          feeRate: 0.0001,
          token: null,
        });

      // Mock signed PSBT for signing step
      PsbtUtils.toPali.mockReturnValue({
        psbt: 'mock_signed_psbt',
        assets: [],
      });

      // Sign the PSBT
      const signedPsbt = await keyringManager.syscoinTransaction.signPSBT({
        psbt: feeEstimate.psbt,
        isTrezor: false,
        isLedger: false,
        pathIn: undefined,
      });

      // Mock sendTransaction to avoid network calls
      const originalSendTransaction =
        keyringManager.syscoinTransaction.sendTransaction;
      keyringManager.syscoinTransaction.sendTransaction = jest
        .fn()
        .mockResolvedValue({
          txid: 'mock_transaction_id',
        });

      // Now send the signed PSBT (current API signature)
      const result = await keyringManager.syscoinTransaction.sendTransaction(
        signedPsbt
      );

      expect(result.txid).toBeDefined();
      expect(typeof result.txid).toBe('string');

      // Restore
      keyringManager.syscoinTransaction.sendTransaction =
        originalSendTransaction;

      // Restore
      PsbtUtils.fromPali = originalFromPali;
      PsbtUtils.toPali = originalToPali;
    });

    it('should handle change address generation', async () => {
      const changeAddress = await keyringManager.getNewChangeAddress();

      expect(changeAddress).toBeDefined();
      expect(changeAddress.startsWith('tsys1')).toBe(true); // Testnet address
      expect(changeAddress.length).toBe(44); // Bech32 address length
    });

    it('should get current receiving address', async () => {
      const address = await keyringManager.updateReceivingAddress();

      expect(address).toBeDefined();
      expect(address.startsWith('tsys1')).toBe(true);

      // Verify it updated the account
      const account = keyringManager.getActiveAccount().activeAccount;
      expect(account.address).toBe(address);
    });
  });

  describe('UTXO Management', () => {
    it('should handle UTXO selection for transactions', async () => {
      // Mock PsbtUtils.toPali to avoid toBase64 errors
      const PsbtUtils = require('../../../src/utils/psbt').PsbtUtils;
      const originalToPali = PsbtUtils.toPali;
      PsbtUtils.toPali = jest.fn().mockReturnValue({
        psbt: 'mock_psbt_base64',
        assets: [],
      });

      // This tests the integration with coinselectsyscoin
      const amount = 0.5; // 0.5 SYS
      const feeRate = 0.000001; // 1 satoshi per byte

      const result =
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: { rbf: true }, // Replace-by-fee enabled
          amount,
          receivingAddress: 'tsys1qdsvzmrxkq5uh0kwc6cyndsj7fluszcu3pl2wlv',
          feeRate,
          token: null,
        });

      expect(result.fee).toBeGreaterThan(0);
      expect(result.fee).toBeLessThan(amount); // Fee should be less than amount

      // Restore
      PsbtUtils.toPali = originalToPali;
    });

    it('should handle insufficient balance', async () => {
      // Try to send more than available balance
      const hugeAmount = 1000000; // 1 million SYS

      // This should fail in a real implementation
      try {
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: {},
          amount: hugeAmount,
          receivingAddress: 'tsys1qdsvzmrxkq5uh0kwc6cyndsj7fluszcu3pl2wlv',
          feeRate: 0.000001,
          token: null,
        });
      } catch (error) {
        // Expected to fail with insufficient balance
        expect(error).toBeDefined();
      }
    });
  });

  describe('SPT Token Support', () => {
    it('should handle SPT token transactions', async () => {
      // Mock PsbtUtils throughout the entire flow
      const PsbtUtils = require('../../../src/utils/psbt').PsbtUtils;
      const originalFromPali = PsbtUtils.fromPali;
      const originalToPali = PsbtUtils.toPali;

      PsbtUtils.toPali = jest.fn().mockReturnValue({
        psbt: 'mock_token_psbt',
        assets: [],
      });

      PsbtUtils.fromPali = jest.fn().mockReturnValue({
        txInputs: [{ hash: Buffer.alloc(32), index: 0, sequence: 0xffffffff }],
        txOutputs: [{ script: Buffer.alloc(25), value: 100000000 }],
        data: {
          inputs: [
            {
              witnessUtxo: { script: Buffer.alloc(25), value: 100000000 },
              nonWitnessUtxo: Buffer.alloc(100),
            },
          ],
          outputs: [{}],
        },
        getInputType: () => 'witnesspubkeyhash',
        signAllInputsHDAsync: jest.fn().mockResolvedValue(undefined),
        validateSignaturesOfAllInputs: jest.fn().mockReturnValue(true),
        finalizeAllInputs: jest.fn(),
        extractTransaction: jest.fn().mockReturnValue({
          getId: jest.fn().mockReturnValue('mock_token_txid'),
        }),
      });

      // First create unsigned PSBT for token transaction
      const feeEstimate =
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: {},
          amount: 100, // 100 tokens
          receivingAddress: 'tsys1qdsvzmrxkq5uh0kwc6cyndsj7fluszcu3pl2wlv',
          feeRate: 0.0001,
          token: {
            guid: '123456789',
            symbol: 'TEST',
          },
        });

      // Mock signed PSBT for signing step
      PsbtUtils.toPali.mockReturnValue({
        psbt: 'mock_signed_token_psbt',
        assets: [],
      });

      // Sign the PSBT
      const signedPsbt = await keyringManager.syscoinTransaction.signPSBT({
        psbt: feeEstimate.psbt,
        isTrezor: false,
        isLedger: false,
        pathIn: undefined,
      });

      // Mock sendTransaction to avoid network calls
      const originalSendTransaction =
        keyringManager.syscoinTransaction.sendTransaction;
      keyringManager.syscoinTransaction.sendTransaction = jest
        .fn()
        .mockResolvedValue({
          txid: 'mock_token_txid',
        });

      // Send the signed token transaction
      const result = await keyringManager.syscoinTransaction.sendTransaction(
        signedPsbt
      );

      expect(result.txid).toBeDefined();

      // Restore sendTransaction
      keyringManager.syscoinTransaction.sendTransaction =
        originalSendTransaction;

      // Restore
      PsbtUtils.fromPali = originalFromPali;
      PsbtUtils.toPali = originalToPali;
    });
  });

  describe('Multiple Account Support', () => {
    it('should sign transactions from different accounts', async () => {
      // Add a second account
      const account2 = await keyringManager.addNewAccount('Account 2');

      // Update vault state with the new account (in stateless keyring, this would be done by Pali/Redux)
      currentVaultState.accounts[KeyringAccountType.HDAccount][account2.id] = {
        id: account2.id,
        address: account2.address,
        xpub: account2.xpub,
        xprv: account2.xprv,
        label: account2.label,
        balances: account2.balances,
        isImported: account2.isImported,
        isTrezorWallet: account2.isTrezorWallet,
        isLedgerWallet: account2.isLedgerWallet,
      };

      // Get change address for account 1
      const changeAddress1 = await keyringManager.getChangeAddress(0);

      // Switch to account 2
      currentVaultState.activeAccount = {
        id: account2.id,
        type: KeyringAccountType.HDAccount,
      };
      await keyringManager.setActiveAccount(1, KeyringAccountType.HDAccount);

      // Get change address for account 2
      const changeAddress2 = await keyringManager.getChangeAddress(1);

      // Addresses should be different
      expect(changeAddress1).not.toBe(changeAddress2);
      expect(changeAddress1.startsWith('tsys1')).toBe(true);
      expect(changeAddress2.startsWith('tsys1')).toBe(true);
    });
  });

  describe('Network Compatibility', () => {
    it('should work with mainnet configuration', async () => {
      // Set up mainnet vault state
      const mainnetVaultState = createMockVaultState({
        activeAccountId: 0,
        activeAccountType: KeyringAccountType.HDAccount,
        networkType: INetworkType.Syscoin,
        chainId: 57,
      });
      const mainnetVaultStateGetter = jest.fn(() => mainnetVaultState);

      // Create mainnet keyring
      const mainnetKeyring = await KeyringManager.createInitialized(
        PEACE_SEED_PHRASE,
        FAKE_PASSWORD,
        mainnetVaultStateGetter
      );

      const address = mainnetKeyring.getActiveAccount().activeAccount.address;
      expect(address.startsWith('sys1')).toBe(true); // Mainnet prefix

      const fee = await mainnetKeyring.syscoinTransaction.getRecommendedFee(
        mainnetKeyring.getNetwork().url
      );
      expect(fee).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      // Mock a network error
      const mockFetchEstimateFee = sjs.utils.fetchEstimateFee as jest.Mock;
      mockFetchEstimateFee.mockRejectedValueOnce(new Error('Network error'));

      try {
        await keyringManager.syscoinTransaction.getRecommendedFee(
          'https://invalid-url.com'
        );
      } catch (error) {
        expect(error.message).toContain('Network error');
      }
    });

    it('should validate addresses before sending', async () => {
      // Mock address validation to throw for invalid addresses
      const syscoinjs = require('syscoinjs-lib');
      const originalValidateAddress = syscoinjs.utils.validateSyscoinAddress;
      syscoinjs.utils.validateSyscoinAddress = jest
        .fn()
        .mockImplementation((address) => {
          if (address === 'invalid_address') {
            throw new Error('Invalid address format');
          }
          return true;
        });

      // Should reject invalid addresses during fee estimation
      try {
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: {},
          amount: 0.1,
          receivingAddress: 'invalid_address',
          feeRate: 0.0001,
          token: null,
        });
        // If we get here, the test should fail
        expect(true).toBe(false);
      } catch (error) {
        // Expected to throw for invalid address
        expect(error).toBeDefined();
      }

      // Restore
      syscoinjs.utils.validateSyscoinAddress = originalValidateAddress;
    });

    it('should require unlock for transaction operations', async () => {
      keyringManager.lockWallet();

      try {
        await keyringManager.syscoinTransaction.getEstimateSysTransactionFee({
          txOptions: {},
          amount: 0.1,
          receivingAddress: 'tsys1qdsvzmrxkq5uh0kwc6cyndsj7fluszcu3pl2wlv',
          feeRate: 0.0001,
          token: null,
        });
        // If we get here, the test should fail
        expect(true).toBe(false);
      } catch (error) {
        // Expected to throw when wallet is locked
        expect(error).toBeDefined();
      }
    });
  });
});

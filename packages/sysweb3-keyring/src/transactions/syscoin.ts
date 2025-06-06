import coinSelectSyscoin from 'coinselectsyscoin';
import * as syscoinjs from 'syscoinjs-lib';
// import { BIP_84, ONE_HUNDRED_MILLION, SYSCOIN_BASIC_FEE } from 'utils';

import { LedgerKeyring } from '../ledger';
import { DefaultWalletPolicy } from '../ledger/bitcoin_client';
import { SyscoinHDSigner } from '../signers';
import { TrezorKeyring } from '../trezor';
import {
  ISyscoinTransactions,
  KeyringAccountType,
  accountType,
} from '../types';
import { PsbtUtils } from '../utils/psbt';
import { INetwork } from '@pollum-io/sysweb3-network';
import { ITxid, txUtils, getAsset } from '@pollum-io/sysweb3-utils';

type EstimateFeeParams = {
  changeAddress: string;
  feeRateBN: any;
  outputs: { address: string; value: number }[];
  txOptions: any;
  xpub: string;
};

export class SyscoinTransactions implements ISyscoinTransactions {
  // New separated transaction flow for better UX:
  // 1. Call getEstimateSysTransactionFee() - creates UNSIGNED PSBT and calculates fee
  // 2. Call signPSBT() - signs the PSBT with appropriate wallet (HD/Trezor/Ledger)
  // 3. Call sendTransaction() - broadcasts the signed PSBT
  //
  // This separation allows:
  // - Independent error handling for each step
  // - Better UX feedback (fee estimation, signing, broadcasting)
  // - Hardware wallet compatibility with proper PSBT enhancement

  private getSigner: () => {
    hd: SyscoinHDSigner;
    main: any;
  };
  private trezor: TrezorKeyring;
  private ledger: LedgerKeyring;
  private getState: () => {
    accounts: {
      HDAccount: accountType;
      Imported: accountType;
      Ledger: accountType;
      Trezor: accountType;
    };
    activeAccountId: number;
    activeAccountType: KeyringAccountType;
    activeNetwork: INetwork;
  };
  private getAddress: (
    xpub: string,
    isChangeAddress: boolean
  ) => Promise<string>;

  constructor(
    getSyscoinSigner: () => {
      hd: SyscoinHDSigner;
      main: any;
    },
    getState: () => {
      accounts: {
        HDAccount: accountType;
        Imported: accountType;
        Ledger: accountType;
        Trezor: accountType;
      };
      activeAccountId: number;
      activeAccountType: KeyringAccountType;
      activeNetwork: INetwork;
    },
    getAddress: (xpub: string, isChangeAddress: boolean) => Promise<string>,
    ledgerSigner: LedgerKeyring
  ) {
    this.getSigner = getSyscoinSigner;
    this.getState = getState;
    this.getAddress = getAddress;
    this.trezor = new TrezorKeyring(this.getSigner);
    this.ledger = ledgerSigner;
  }

  private getTransactionPSBT = async ({
    txOptions,
    outputs,
    changeAddress,
    xpub,
    feeRateBN,
  }: EstimateFeeParams) => {
    const { main } = this.getSigner();

    // Use syscoinjs-lib directly for transaction creation
    const psbt = await main.createTransaction(
      txOptions,
      changeAddress,
      outputs,
      feeRateBN,
      xpub // sysFromXpubOrAddress
    );

    if (psbt) {
      return psbt;
    }
    throw new Error('psbt not found');
  };

  public getRecommendedFee = async (explorerUrl: string): Promise<number> =>
    (await syscoinjs.utils.fetchEstimateFee(explorerUrl, 1, undefined)) /
    10 ** 8;

  public txUtilsFunctions = () => {
    const { getRawTransaction } = txUtils();
    return {
      getRawTransaction,
    };
  };

  // Internal method for signing with the HD signer
  private signPSBTWithSigner = async ({
    psbt,
    signer,
    pathIn,
  }: {
    pathIn?: string;
    psbt: string;
    signer: any;
  }): Promise<any> => await signer.sign(psbt, pathIn);

  // Create unsigned PSBT for any transaction type
  private createUnsignedPSBT = async ({
    txOptions = {},
    amount,
    receivingAddress,
    feeRate,
    token = null,
  }: {
    amount: number;
    feeRate: number;
    receivingAddress: string;
    token?: { guid: string; symbol?: string } | null;
    txOptions?: any;
  }): Promise<any> => {
    // Ensure RBF is enabled by default if not explicitly set
    const finalTxOptions = { rbf: true, ...txOptions };
    const { activeAccountId, accounts, activeAccountType } = this.getState();
    const { main } = this.getSigner();
    const xpub = accounts[activeAccountType][activeAccountId].xpub;
    const value = new syscoinjs.utils.BN(amount * 1e8);
    const feeRateBN = new syscoinjs.utils.BN(feeRate * 1e8);
    const changeAddress = await this.getAddress(xpub, true);

    if (token && token.guid) {
      // Token transaction: use assetAllocationSend
      const asset = await getAsset(main.blockbookURL, token.guid);

      if (!asset) {
        throw new Error('Token not found');
      }

      // Create a Map for the asset allocation
      const assetMap = new Map();
      assetMap.set(token.guid, {
        changeAddress,
        outputs: [
          {
            value: value as any,
            address: receivingAddress,
          },
        ],
      });

      // Pass xpub to get back just the PSBT without signing and sending
      const result = await main.assetAllocationSend(
        finalTxOptions,
        assetMap,
        changeAddress,
        feeRateBN,
        xpub // Pass xpub to get PSBT back
      );

      // Return PSBT in Pali format
      return result.psbt;
    } else {
      // Native transaction: use getTransactionPSBT to create unsigned PSBT
      const outputs = [
        {
          address: receivingAddress,
          value,
        },
      ];

      const psbt = await this.getTransactionPSBT({
        txOptions: finalTxOptions,
        outputs,
        changeAddress,
        feeRateBN,
        xpub,
      });

      return psbt;
    }
  };

  // Calculate fee from PSBT
  private calculateFeeFromPSBT = (psbt: any, feeRate: number): number => {
    try {
      // Method 1: Extract transaction and use coinselectsyscoin for size calculation

      // Validate PSBT structure
      if (
        !psbt.txInputs ||
        !psbt.data ||
        !psbt.data.inputs ||
        !psbt.txOutputs
      ) {
        throw new Error('Invalid PSBT structure');
      }

      // Create inputs/outputs format that coinselectsyscoin expects with bounds checking
      const inputs = psbt.txInputs.map((input: any, index: number) => {
        // Ensure data.inputs[index] exists before accessing
        const dataInput = psbt.data.inputs[index] || {};
        return {
          ...dataInput,
          ...input,
        };
      });
      const outputs = psbt.txOutputs;

      // Validate that we have matching input counts
      if (inputs.length !== psbt.txInputs.length) {
        throw new Error('Mismatch between txInputs and data.inputs length');
      }

      // Use coinselectsyscoin.utils.transactionBytes for Syscoin-compatible calculation
      const txBytes = coinSelectSyscoin.utils.transactionBytes(inputs, outputs);

      // Calculate fee: bytes * feeRate (in SYS/byte)
      const fee = txBytes * feeRate;
      return fee;
    } catch (error) {
      // Fallback: Use virtualSize as secondary method
      try {
        const tx = psbt.extractTransaction();
        const txBytes = tx.virtualSize();
        const fee = txBytes * feeRate;
        return fee;
      } catch (fallbackError) {
        // Final fallback: Use base64 size estimation
        // Base64: 4 chars = 3 bytes, so base64Length * 3/4 = actual bytes
        const psbtBase64 = psbt.toBase64();
        const psbtBytes = Math.ceil((psbtBase64.length * 3) / 4);

        const fee = psbtBytes * feeRate;
        return fee;
      }
    }
  };

  // Sign PSBT with appropriate method - separated for better error handling
  private signPSBTWithMethod = async (
    psbt: any,
    isTrezor: boolean,
    isLedger = false,
    pathIn = ''
  ): Promise<any> => {
    const { activeNetwork, activeAccountId, activeAccountType, accounts } =
      this.getState();

    try {
      if (isLedger) {
        // Initialize Ledger connection if needed
        if (!this.ledger.ledgerTransport) {
          await this.ledger.connectToLedgerDevice();
        }

        // CRITICAL: Enhance PSBT with required Ledger fields
        const accountXpub = accounts[activeAccountType][activeAccountId].xpub;
        const accountId = accounts[activeAccountType][activeAccountId].id;
        const enhancedPsbt = await this.ledger.convertToLedgerFormat(
          psbt,
          accountXpub,
          accountId
        );

        // Get wallet policy for Ledger
        const fingerprint =
          await this.ledger.ledgerUtxoClient.getMasterFingerprint();
        const hdPath = pathIn.length > 0 ? pathIn : `m/84'/57'/${accountId}'`;

        const xpubWithDescriptor = `[${hdPath}]${accountXpub}`.replace(
          'm',
          fingerprint
        );
        const walletPolicy = new DefaultWalletPolicy(
          'wpkh(@0/**)',
          xpubWithDescriptor
        );

        // Sign the enhanced PSBT with Ledger
        const signatureEntries = await this.ledger.ledgerUtxoClient.signPsbt(
          enhancedPsbt.toBase64(),
          walletPolicy,
          null // No HMAC needed for standard policy
        );

        signatureEntries.forEach(([inputIndex, partialSig]) => {
          enhancedPsbt.updateInput(inputIndex, {
            partialSig: [partialSig],
          });
        });

        // Finalize all inputs
        enhancedPsbt.finalizeAllInputs();

        return enhancedPsbt;
      } else if (isTrezor) {
        // Initialize Trezor connection before signing
        await this.trezor.init();

        // Handle Trezor signing for UTXO
        const coin = activeNetwork.currency?.toLowerCase() || 'sys';
        const trezorTx = this.trezor.convertToTrezorFormat({
          psbt,
          pathIn, // Pass pathIn to Trezor
          coin,
        });
        const signedPsbt = await this.trezor.signUtxoTransaction(
          trezorTx,
          psbt
        );
        return signedPsbt;
      } else {
        const { hd } = this.getSigner();
        const signedPsbt = await this.signPSBTWithSigner({
          psbt,
          signer: hd,
          pathIn,
        });
        return signedPsbt;
      }
    } catch (error) {
      console.error('Error signing PSBT:', error);
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }
  };

  // Create unsigned PSBT and estimate fee - NO SIGNING
  public getEstimateSysTransactionFee = async ({
    txOptions = {},
    amount,
    receivingAddress,
    feeRate,
    token = null,
  }: {
    amount: number;
    feeRate?: number;
    receivingAddress: string;
    // Optional fee rate in SYS/byte
    token?: { guid: string; symbol?: string } | null;
    txOptions?: any;
  }) => {
    // Ensure RBF is enabled by default if not explicitly set
    const finalTxOptions = { rbf: true, ...txOptions };
    const { main } = this.getSigner();

    try {
      // Step 1: Determine fee rate
      let actualFeeRate;
      if (feeRate !== undefined) {
        actualFeeRate = feeRate;
      } else {
        actualFeeRate = await this.getRecommendedFee(main.blockbookURL);
      }

      // Step 2: Create unsigned PSBT
      const unsignedPsbt = await this.createUnsignedPSBT({
        txOptions: finalTxOptions,
        amount,
        receivingAddress,
        feeRate: actualFeeRate,
        token,
      });

      // Step 3: Calculate fee from unsigned PSBT
      const fee = this.calculateFeeFromPSBT(unsignedPsbt, actualFeeRate);

      return {
        fee,
        psbt: PsbtUtils.toPali(unsignedPsbt), // Return UNSIGNED PSBT as JSON
      };
    } catch (error) {
      throw new Error(`Failed to create transaction: ${error.message}`);
    }
  };

  // Removed createAndSignSysTransaction - functionality merged into getEstimateSysTransactionFee

  private sendSignedTransaction = async (psbt): Promise<ITxid> => {
    const { main } = this.getSigner();

    try {
      // Send the transaction
      const result = await main.send(psbt);

      // Extract the transaction ID
      const txid = result.extractTransaction().getId();
      return { txid };
    } catch (error) {
      console.error('Error sending transaction:', error);
      throw new Error('Failed to send transaction');
    }
  };

  // Sign a PSBT with the appropriate wallet method
  public signPSBT = async ({
    psbt,
    isTrezor = false,
    isLedger = false,
    pathIn,
  }: {
    isLedger?: boolean;
    isTrezor?: boolean;
    pathIn?: string;
    psbt: string;
  }): Promise<string> => {
    try {
      const psbtObj = PsbtUtils.fromPali(psbt);
      const signedPsbt = await this.signPSBTWithMethod(
        psbtObj,
        isTrezor,
        isLedger,
        pathIn
      );
      return PsbtUtils.toPali(signedPsbt);
    } catch (error) {
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }
  };

  public sendTransaction = async (psbt: string): Promise<ITxid> => {
    if (!psbt) {
      throw new Error('Signed PSBT is required for broadcasting.');
    }
    return await this.sendSignedTransaction(PsbtUtils.fromPali(psbt));
  };
}

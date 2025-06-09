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
import { getAccountDerivationPath } from '../utils/derivation-paths';
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
    const result = await main.createTransaction(
      txOptions,
      changeAddress,
      outputs,
      feeRateBN,
      xpub // sysFromXpubOrAddress
    );

    if (result && result.psbt) {
      return result.psbt;
    }
    throw new Error('psbt not found');
  };

  public decodeRawTransaction = (psbt: any) => {
    const { main } = this.getSigner();
    const psbtObj = PsbtUtils.fromPali(psbt);
    return main.decodeRawTransaction(psbtObj);
  };

  public getRecommendedFee = async (explorerUrl: string): Promise<number> =>
    (await syscoinjs.utils.fetchEstimateFee(explorerUrl, 1)) / 1024;

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
    psbt: any;
    signer: any;
  }): Promise<any> => await signer.sign(psbt, pathIn);

  // Create unsigned PSBT for any transaction type
  private createUnsignedPSBT = async ({
    txOptions = {},
    amount,
    receivingAddress,
    feeRateBN,
    token = null,
  }: {
    amount: number;
    feeRateBN: any; // BigNumber in satoshis/byte
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

  // Calculate transaction size in bytes from PSBT
  private calculateTransactionSize = (psbt: any): number => {
    try {
      // Method 1: Extract transaction and use coinselectsyscoin for size calculation

      // Validate PSBT structure
      if (
        !psbt.txInputs ||
        !psbt.data ||
        !psbt.data.inputs ||
        !psbt.txOutputs
      ) {
        throw new Error('Invalid PSBT structure - missing expected properties');
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
      // This should account for signature space even on unsigned transactions
      const txBytes = coinSelectSyscoin.utils.transactionBytes(inputs, outputs);
      return txBytes;
    } catch (error) {
      console.log('DEBUG: Error calculating size from PSBT:', error);
      // Fallback: Use virtualSize as secondary method
      try {
        const tx = psbt.extractTransaction(true, true);
        const baseTxBytes = tx.virtualSize();

        // Add estimated signature overhead for unsigned transaction
        const inputCount = psbt.txInputs ? psbt.txInputs.length : 1;

        // Detect transaction type from inputs to estimate signature overhead
        let isSegwit = false;
        try {
          // Check if any input has witness data or is P2WPKH/P2WSH
          if (psbt.data?.inputs) {
            isSegwit = psbt.data.inputs.some(
              (input: any) =>
                input.witnessUtxo || input.witnessScript || input.tapInternalKey
            );
          }
        } catch (e) {
          // Default to checking address format if available
          const { activeNetwork } = this.getState();
          isSegwit = activeNetwork?.currency === 'sys'; // Syscoin uses Segwit by default
        }

        // Different overhead based on transaction type
        const signatureOverhead = isSegwit
          ? inputCount * 68 // P2WPKH: ~68 vbytes (with witness discount)
          : inputCount * 113; // P2PKH: ~113 bytes (no discount)

        const estimatedTxBytes = baseTxBytes + signatureOverhead;
        return estimatedTxBytes;
      } catch (fallbackError) {
        console.log(
          'DEBUG: Fallback Error calculating size from PSBT:',
          fallbackError
        );
        console.log('DEBUG: PSBT object type:', typeof psbt);
        console.log('DEBUG: PSBT object constructor:', psbt?.constructor?.name);
        console.log(
          'DEBUG: PSBT available methods:',
          Object.getOwnPropertyNames(psbt || {})
        );
        console.log('DEBUG: PSBT has toBase64:', typeof psbt?.toBase64);

        // Final fallback: Use base64 size estimation
        try {
          // Check if toBase64 method exists
          if (typeof psbt?.toBase64 === 'function') {
            const psbtBase64 = psbt.toBase64();
            const psbtBytes = Math.ceil((psbtBase64.length * 3) / 4);
            console.log(
              'DEBUG: Using toBase64() method, estimated bytes:',
              psbtBytes
            );
            return psbtBytes;
          } else {
            throw new Error('toBase64 method not available on PSBT object');
          }
        } catch (base64Error) {
          console.error('DEBUG: toBase64 Error:', base64Error);
          // Ultra-conservative fallback: Use fixed size estimation
          const conservativeBytes = 250;
          console.log(
            'DEBUG: Using ultra-conservative size estimation with 250 bytes'
          );
          return conservativeBytes;
        }
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
        accountId,
        activeNetwork.currency,
        activeNetwork.slip44
      );

      // Get wallet policy for Ledger
      const fingerprint =
        await this.ledger.ledgerUtxoClient.getMasterFingerprint();

      // Use dynamic path generation if no path provided
      let hdPath = pathIn;
      if (!pathIn || pathIn.length === 0) {
        hdPath = getAccountDerivationPath(
          activeNetwork.currency,
          activeNetwork.slip44,
          accountId
        );
      }

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
      const trezorTx = this.trezor.convertToTrezorFormat({
        psbt,
        pathIn, // Pass pathIn to Trezor
        coin: activeNetwork.currency.toLowerCase(),
      });
      const signedPsbt = await this.trezor.signUtxoTransaction(trezorTx, psbt);
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
    // Step 1: Determine fee rate
    let actualFeeRate;
    if (feeRate !== undefined) {
      actualFeeRate = feeRate;
    } else {
      actualFeeRate = await this.getRecommendedFee(main.blockbookURL);
    }

    // Convert fee rate to satoshis/byte for consistent usage
    const feeRateBN = new syscoinjs.utils.BN(actualFeeRate * 1e8);

    // Step 2: Create unsigned PSBT
    const unsignedPsbt = await this.createUnsignedPSBT({
      txOptions: finalTxOptions,
      amount,
      receivingAddress,
      feeRateBN,
      token,
    });

    // Step 3: Calculate transaction size and convert to fee
    const txSizeBytes = this.calculateTransactionSize(unsignedPsbt);
    const feeInSatoshis = feeRateBN.mul(new syscoinjs.utils.BN(txSizeBytes));
    const feeInSys = feeInSatoshis.toNumber() / 1e8;

    return {
      fee: feeInSys,
      psbt: PsbtUtils.toPali(unsignedPsbt), // Return UNSIGNED PSBT as JSON
    };
  };

  // Removed createAndSignSysTransaction - functionality merged into getEstimateSysTransactionFee

  private sendSignedTransaction = async (psbt): Promise<ITxid> => {
    const { main } = this.getSigner();
    // Send the transaction
    const result = await main.send(psbt);

    // Extract the transaction ID
    const txid = result.extractTransaction().getId();
    return { txid };
  };

  public signPSBT = async ({
    psbt,
    isTrezor = false,
    isLedger = false,
    pathIn,
  }: {
    psbt: any;
    isTrezor?: boolean;
    isLedger?: boolean;
    pathIn?: string;
  }): Promise<any> => {
    const psbtObj = PsbtUtils.fromPali(psbt);
    const signedPsbt = await this.signPSBTWithMethod(
      psbtObj,
      isTrezor,
      isLedger,
      pathIn
    );
    return PsbtUtils.toPali(signedPsbt);
  };

  public sendTransaction = async (psbt: any): Promise<ITxid> => {
    if (!psbt) {
      throw new Error('Signed PSBT is required for broadcasting.');
    }
    return await this.sendSignedTransaction(PsbtUtils.fromPali(psbt));
  };
}

import * as syscoinjs from 'syscoinjs-lib';

import { ITxid } from '@pollum-io/sysweb3-utils';

export class SimplifiedSyscoinTransactions {
  private getSigner: () => { hd: any; main: any };
  private getState: () => any;

  constructor(
    getSyscoinSigner: () => { hd: any; main: any },
    getState: () => any
  ) {
    this.getSigner = getSyscoinSigner;
    this.getState = getState;
  }

  /**
   * Create a transaction - returns unsigned PSBT with fee estimate
   * This replaces multiple methods with one simple flow
   */
  public createTransaction = async ({
    amount,
    receivingAddress,
    feeRate,
    token = null,
  }: {
    amount: number;
    feeRate?: number;
    receivingAddress: string;
    token?: { guid: string } | null;
  }): Promise<{ fee: number; psbt: string }> => {
    const { main } = this.getSigner();
    const { activeAccountId, accounts, activeAccountType } = this.getState();
    const xpub = accounts[activeAccountType][activeAccountId].xpub;

    // Get fee rate if not provided
    const actualFeeRate =
      feeRate ?? (await this.getRecommendedFee(main.blockbookURL));

    // Create the transaction
    const value = new syscoinjs.utils.BN(amount * 1e8);
    const feeRateBN = new syscoinjs.utils.BN(actualFeeRate * 1e8);
    const changeAddress = await main.Signer.getNewChangeAddress(true, 84);

    let psbt;

    if (token) {
      // Token transaction
      const assetMap = new Map();
      assetMap.set(token.guid, {
        changeAddress,
        outputs: [{ value, address: receivingAddress }],
      });

      const result = await main.assetAllocationSend(
        { rbf: true },
        assetMap,
        changeAddress,
        feeRateBN,
        xpub
      );
      psbt = result.psbt;
    } else {
      // Native SYS transaction
      const outputs = [{ address: receivingAddress, value }];
      const utxos = await syscoinjs.utils.fetchBackendUTXOS(
        main.blockbookURL,
        xpub
      );
      const utxosSanitized = syscoinjs.utils.sanitizeBlockbookUTXOs(
        null,
        utxos,
        main.network
      );

      // For now, using basic implementation without syscointx
      const tx = await main.createTransaction(
        { rbf: true },
        utxosSanitized,
        changeAddress,
        outputs,
        feeRateBN
      );

      psbt = await main.createPSBTFromRes(tx);
    }

    // Get PSBT as base64 string
    const psbtBase64 = typeof psbt === 'object' ? psbt.toBase64() : psbt;

    // Simple fee calculation: PSBT length / 2 * feeRate
    const fee = Math.ceil(psbtBase64.length / 2) * actualFeeRate;

    return { psbt: psbtBase64, fee };
  };

  /**
   * Sign a PSBT - handles all wallet types
   */
  public signPSBT = async (
    psbt: string,
    walletType?: 'trezor' | 'ledger'
  ): Promise<string> => {
    const { hd } = this.getSigner();

    // For regular HD wallets, just sign
    if (!walletType) {
      const signed = await hd.sign(psbt);
      return typeof signed === 'object' ? signed.toBase64() : signed;
    }

    // Hardware wallets are handled by the keyring manager
    // This is just a placeholder - actual HW signing happens elsewhere
    throw new Error(
      `Hardware wallet signing should be handled by KeyringManager`
    );
  };

  /**
   * Send a signed PSBT
   */
  public sendTransaction = async (signedPsbt: string): Promise<ITxid> => {
    const { main } = this.getSigner();

    // Import PSBT if it's base64
    const psbtObj = signedPsbt.startsWith('{')
      ? syscoinjs.utils.importPsbtFromJson(signedPsbt)
      : syscoinjs.utils.importPsbtFromJson(
          syscoinjs.utils.exportPsbtToJson(signedPsbt, undefined)
        );

    // Send it
    const result = await main.send(psbtObj);
    const txid = result.extractTransaction().getId();

    return { txid };
  };

  /**
   * Simple one-shot create, sign, and send
   * For when you don't need to review the transaction
   */
  public sendPayment = async ({
    amount,
    receivingAddress,
    feeRate,
    token = null,
  }: {
    amount: number;
    feeRate?: number;
    receivingAddress: string;
    token?: { guid: string } | null;
  }): Promise<ITxid> => {
    // Create
    const { psbt } = await this.createTransaction({
      amount,
      receivingAddress,
      feeRate,
      token,
    });

    // Sign
    const signedPsbt = await this.signPSBT(psbt);

    // Send
    return await this.sendTransaction(signedPsbt);
  };

  private getRecommendedFee = async (explorerUrl: string): Promise<number> =>
    (await syscoinjs.utils.fetchEstimateFee(explorerUrl, 1, undefined)) /
    10 ** 8;
}

/**
 * Example Pali integration:
 *
 * // Create transaction
 * const { psbt, fee } = await syscoinTx.createTransaction({
 *   amount: 1.5,
 *   receivingAddress: 'sys1q...',
 *   feeRate: 0.00001
 * });
 *
 * // Show to user for approval
 * showTransactionDetails(amount, fee, receivingAddress);
 *
 * // If approved, sign and send
 * const signedPsbt = await syscoinTx.signPSBT(psbt);
 * const { txid } = await syscoinTx.sendTransaction(signedPsbt);
 *
 * // Or for simple payments without review:
 * const { txid } = await syscoinTx.sendPayment({
 *   amount: 1.5,
 *   receivingAddress: 'sys1q...'
 * });
 */

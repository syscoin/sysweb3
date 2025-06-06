import coinSelectSyscoin from 'coinselectsyscoin';
import { ethers } from 'ethers';
import * as syscoinjs from 'syscoinjs-lib';
import syscointx from 'syscointx-js';

type EstimateFeeParams = {
  changeAddress: string;
  explorerUrl: string;
  feeRateBN: any;
  network: string;
  outputs: { address: string; value: number }[];
  xpub: string;
};

export const feeUtils = () => {
  const estimateSysTransactionFee = async ({
    outputs,
    changeAddress,
    feeRateBN,
    network,
    xpub,
    explorerUrl,
  }: EstimateFeeParams) => {
    const txOpts = { rbf: false };

    const utxos = await syscoinjs.utils.fetchBackendUTXOS(explorerUrl, xpub);
    const utxosSanitized = syscoinjs.utils.sanitizeBlockbookUTXOs(
      null,
      utxos,
      network
    );

    // 0 feerate to create tx, then find bytes and multiply feeRate by bytes to get estimated txfee
    const tx = await syscointx.createTransaction(
      txOpts,
      utxosSanitized,
      changeAddress,
      outputs,
      new syscoinjs.utils.BN(0)
    );
    const bytes = coinSelectSyscoin.utils.transactionBytes(
      tx.inputs,
      tx.outputs
    );
    const txFee = feeRateBN.mul(new syscoinjs.utils.BN(bytes));

    return txFee;
  };

  const getRecommendedFee = async (explorerUrl: string): Promise<number> =>
    (await syscoinjs.utils.fetchEstimateFee(explorerUrl, 1)) / 10 ** 8;

  const convertGasFee = (value: string) =>
    ethers.utils.formatEther(String(value));

  return {
    estimateSysTransactionFee,
    getRecommendedFee,
    convertGasFee,
  };
};

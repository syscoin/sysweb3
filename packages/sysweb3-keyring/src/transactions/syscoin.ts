import coinSelectSyscoin from 'coinselectsyscoin';
import * as syscoinjs from 'syscoinjs-lib';
import syscointx from 'syscointx-js';
// import { BIP_84, ONE_HUNDRED_MILLION, SYSCOIN_BASIC_FEE } from 'utils';

import { LedgerKeyring } from '../ledger';
import { SyscoinHDSigner } from '../signers';
import { TrezorKeyring } from '../trezor';
import {
  ISyscoinTransactions,
  KeyringAccountType,
  accountType,
} from '../types';
import { INetwork } from '@pollum-io/sysweb3-network';
import {
  isBase64,
  repairBase64,
  ITokenSend,
  ITxid,
  txUtils,
  getAsset,
  countDecimals,
} from '@pollum-io/sysweb3-utils';

type EstimateFeeParams = {
  outputs: { value: number; address: string }[];
  changeAddress: string;
  feeRateBN: any;
  xpub: string;
  explorerUrl: string;
};

export class SyscoinTransactions implements ISyscoinTransactions {
  //TODO: test and validate for general UTXO chains which will be the working methods, for now we just allow contentScripts for syscoin Chains
  private getSigner: () => {
    hd: SyscoinHDSigner;
    main: any;
  };
  private trezor: TrezorKeyring;
  private ledger: LedgerKeyring;
  private getState: () => {
    activeAccountId: number;
    accounts: {
      Trezor: accountType;
      Imported: accountType;
      HDAccount: accountType;
      Ledger: accountType;
    };
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
      activeAccountId: number;
      accounts: {
        Trezor: accountType;
        Imported: accountType;
        HDAccount: accountType;
        Ledger: accountType;
      };
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

  public estimateSysTransactionFee = async ({
    outputs,
    changeAddress,
    feeRateBN,
    xpub,
    explorerUrl,
  }: EstimateFeeParams) => {
    const { hd } = this.getSigner();

    const txOpts = { rbf: true };

    const utxos = await syscoinjs.utils.fetchBackendUTXOS(
      explorerUrl,
      xpub,
      undefined
    );
    const utxosSanitized = syscoinjs.utils.sanitizeBlockbookUTXOs(
      null,
      utxos,
      hd.Signer.network,
      undefined,
      undefined,
      undefined
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

  public getTransactionPSBT = async ({
    outputs,
    changeAddress,
    xpub,
    explorerUrl,
    feeRateBN,
  }: EstimateFeeParams) => {
    const { hd, main } = this.getSigner();

    const txOpts = { rbf: true };

    const utxos = await syscoinjs.utils.fetchBackendUTXOS(
      explorerUrl,
      xpub,
      undefined
    );
    const utxosSanitized = syscoinjs.utils.sanitizeBlockbookUTXOs(
      null,
      utxos,
      hd.Signer.network,
      undefined,
      undefined,
      undefined
    );

    const tx = await syscointx.createTransaction(
      txOpts,
      utxosSanitized,
      changeAddress,
      outputs,
      feeRateBN
    );

    const psbt = await main.createPSBTFromRes(tx);
    if (psbt) return psbt;
    throw new Error('psbt not found');
  };

  public getRecommendedFee = async (explorerUrl: string): Promise<number> => {
    return (
      (await syscoinjs.utils.fetchEstimateFee(explorerUrl, 1, undefined)) /
      10 ** 8
    );
  };

  public txUtilsFunctions = () => {
    const { getFeeRate, getRawTransaction, getTokenMap } = txUtils();
    return {
      getFeeRate,
      getRawTransaction,
      getTokenMap,
    };
  };

  public signPSBT = async ({
    psbt,
    signer,
    pathIn,
  }: {
    psbt: string;
    signer: any;
    pathIn?: string;
  }): Promise<JSON> => {
    return syscoinjs.utils.exportPsbtToJson(
      await signer.sign(psbt, pathIn),
      undefined
    ) as any;
  };

  public signAndSendPsbt = async ({
    psbt,
  }: {
    psbt: string;
  }): Promise<JSON> => {
    const { main } = this.getSigner();
    return syscoinjs.utils.exportPsbtToJson(
      await main.signAndSend(psbt),
      undefined
    ) as any;
  };

  signTransaction = async (
    data: { psbt: string },
    isSignOnly: boolean,
    pathIn?: string
  ): Promise<any> => {
    const { hd } = this.getSigner();

    if (!isBase64(data.psbt)) {
      //Trying to recover from a bad base64 string, replacing spaces with + which happens by lack of encodeURI usage
      data.psbt = repairBase64(data.psbt);
    }

    if (!isBase64(data.psbt)) {
      throw new Error(
        'Bad Request: PSBT must be in Base64 format. Please check the documentation to see the correct format.'
      );
    }

    try {
      if (isSignOnly) {
        return await this.signPSBT({
          psbt: data.psbt,
          signer: hd,
          pathIn,
        });
      }

      return await this.signAndSendPsbt({
        psbt: data.psbt,
      });
    } catch (error) {
      throw new Error(
        String('Bad Request: Could not create transaction. ' + error)
      );
    }
  };

  public confirmCustomTokenSend = async (
    temporaryTransaction: ITokenSend
  ): Promise<ITxid> => {
    const { activeAccountId, accounts, activeAccountType } = this.getState();
    const { main } = this.getSigner();
    const { xpub }: any = accounts[activeAccountType][activeAccountId];

    const { getTokenMap } = this.txUtilsFunctions();

    const { amount, rbf, receivingAddress, fee, token } = temporaryTransaction;
    const { guid } = token;
    const asset = await getAsset(main.blockbookURL, guid);

    if (!asset)
      throw new Error(
        'Bad Request: Could not create transaction. Token not found.'
      );

    const txOptions = { rbf };
    const value = new syscoinjs.utils.BN(amount * 10 ** 8);
    const valueDecimals = countDecimals(amount);
    const feeRate = new syscoinjs.utils.BN(fee * 1e8);

    const { decimals } = asset;

    if (valueDecimals > decimals) {
      throw new Error(
        `This token has ${decimals} decimals and you are trying to send a value with ${decimals} decimals, please check your tx`
      );
    }

    try {
      const changeAddress = await this.getAddress(xpub, true);
      const tokenOptions = getTokenMap({
        guid,
        changeAddress,
        amount: value as any,
        receivingAddress,
      });

      const pendingTransaction = await main.assetAllocationSend(
        txOptions,
        tokenOptions,
        null,
        feeRate
      );

      const txid = pendingTransaction.extractTransaction().getId();

      return { txid };
    } catch (error) {
      throw new Error('Bad Request: Could not create transaction.');
    }
  };

  public getEstimateSysTransactionFee = async ({
    amount,
    receivingAddress,
  }: {
    amount: number;
    receivingAddress: string;
  }) => {
    const { hd, main } = this.getSigner();
    const value = new syscoinjs.utils.BN(amount * 1e8);
    const feeRate = new syscoinjs.utils.BN(0.00001 * 1e8);
    const xpub = hd.getAccountXpub();
    const outputs = [
      {
        address: receivingAddress,
        value,
      },
    ] as any;

    const changeAddress = await hd.getNewChangeAddress(true, 84);

    try {
      const txFee = await this.estimateSysTransactionFee({
        outputs,
        changeAddress,
        feeRateBN: feeRate,
        xpub,
        explorerUrl: main.blockbookURL,
      });

      return +`${txFee.toNumber() / 1e8}`;
    } catch (error) {
      console.log(error);
      return 0.00001;
    }
  };

  public confirmNativeTokenSend = async (
    temporaryTransaction: ITokenSend,
    isTrezor?: boolean
  ): Promise<ITxid> => {
    const { activeAccountId, accounts, activeAccountType, activeNetwork } =
      this.getState();
    const { main } = this.getSigner();
    const { receivingAddress, amount, fee } = temporaryTransaction;

    const {
      xpub,
      balances: { syscoin },
    }: any = accounts[activeAccountType][activeAccountId];
    if (isTrezor) {
      try {
        const coin =
          activeNetwork.currency && activeNetwork.currency.toLocaleLowerCase();

        const feeRate = new syscoinjs.utils.BN(fee * 1e8);
        const value = new syscoinjs.utils.BN(amount * 1e8);

        let outputs = [
          {
            address: receivingAddress,
            value,
          },
        ] as any;

        const changeAddress = await this.getAddress(xpub, true);

        const txFee = await this.estimateSysTransactionFee({
          outputs,
          changeAddress: `${changeAddress}`,
          feeRateBN: feeRate,
          xpub,
          explorerUrl: main.blockbookURL,
        });

        if (value.add(txFee).gte(syscoin)) {
          outputs = [
            {
              address: receivingAddress,
              value: value,
            },
          ];
        }

        const psbt = await this.getTransactionPSBT({
          outputs,
          changeAddress: `${changeAddress}`,
          feeRateBN: feeRate,
          xpub,
          explorerUrl: main.blockbookURL,
        });

        const trezorTx = this.trezor.convertToTrezorFormat({
          psbt,
          coin: `${coin ? coin : 'sys'}`,
        });
        const signedPsbt = await this.trezor.signUtxoTransaction(
          trezorTx,
          psbt
        );

        try {
          // syscoinjs.send() now returns a PSBT after broadcasting
          const resultPsbt = await main.send(signedPsbt);

          // Extract the transaction from the PSBT to get the txid
          const tx = resultPsbt.extractTransaction();
          return { txid: tx.getId() };
        } catch (error) {
          // If send fails, throw the error
          throw new Error(`Failed to broadcast transaction. Error: ${error}`);
        }
      } catch (error) {
        throw new Error(
          `Bad Request: Could not create transaction. Error: ${error}`
        );
      }
    }

    const feeRate = new syscoinjs.utils.BN(fee * 1e8);

    const backendAccount = await syscoinjs.utils.fetchBackendAccount(
      main.blockbookURL,
      xpub,
      {},
      true,
      undefined
    );

    const value = new syscoinjs.utils.BN(amount * 1e8);

    let outputs = [
      {
        address: receivingAddress,
        value,
      },
    ] as any;

    const changeAddress = await this.getAddress(xpub, true);

    const txOptions = { rbf: true };

    try {
      const txFee = await this.estimateSysTransactionFee({
        outputs,
        changeAddress,
        feeRateBN: feeRate,
        xpub,
        explorerUrl: main.blockbookURL,
      });

      if (value.add(txFee).gte(backendAccount.balance)) {
        outputs = [
          {
            address: receivingAddress,
            value: value,
          },
        ];
      }

      // createTransaction now returns a PSBT since it calls signAndSend internally
      const pendingTransaction = await main.createTransaction(
        txOptions,
        changeAddress,
        outputs,
        feeRate
      );

      // Extract the transaction from the PSBT to get the txid
      const txid = pendingTransaction.extractTransaction().getId();

      return { txid };
    } catch (error) {
      throw new Error(
        `Bad Request: Could not create transaction. Error: ${error}`
      );
    }
  };

  public sendTransaction = async (
    temporaryTransaction: ITokenSend,
    isTrezor: boolean,
    isLedger: boolean
  ): Promise<ITxid> => {
    const { isToken, token } = temporaryTransaction;
    const { accounts, activeAccountId, activeAccountType } = this.getState();
    const activeAccount = accounts[activeAccountType][activeAccountId];

    if (isLedger) {
      return await this.ledger.utxo.sendTransaction({
        accountIndex: activeAccount.id,
        amount: temporaryTransaction.amount,
        receivingAddress: temporaryTransaction.receivingAddress,
      });
    }

    if (isToken && token) {
      return await this.confirmCustomTokenSend(temporaryTransaction);
    }

    return await this.confirmNativeTokenSend(temporaryTransaction, isTrezor);
  };
}

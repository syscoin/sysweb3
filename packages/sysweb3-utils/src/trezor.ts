import { fromZpub } from 'bip84';

export const getTrezorAccountAddressAndSplitTokensPath = ({
  xpub,
  signer,
  backendAccount,
}: {
  backendAccount: any;
  signer: any;
  xpub: string;
}) => {
  const account: any = new fromZpub(
    xpub,
    signer.Signer.Signer.pubtypes,
    signer.Signer.Signer.networks
  );
  let receivingIndex = -1;

  if (backendAccount.tokens) {
    backendAccount.tokens.forEach((token: any) => {
      if (token.path) {
        const splitPath = token.path.split('/');

        if (splitPath.length >= 6) {
          const change = parseInt(splitPath[4], 10);
          const index = parseInt(splitPath[5], 10);

          if (change === 1) {
            return;
          }

          if (index > receivingIndex) {
            receivingIndex = index;
          }
        }
      }
    });
  }
  const address = account.getAddress(receivingIndex + 1);

  return address;
};

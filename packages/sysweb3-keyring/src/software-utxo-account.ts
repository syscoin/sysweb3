import { Bip84PublicAccount, Bip84PublicAddress } from './public-bip84';
import {
  Bip84NetworkBinding,
  record,
  index,
  snapshotBip84Network,
} from './transactions/bip84-native-plan';

export type Bip84HdPublicRequest = Readonly<{
  network: Bip84NetworkBinding;
  accountIndex: number;
}>;
export type Bip84HdPublicResult = Readonly<{
  type: 'HDAccount';
  accountIndex: number;
  account: Bip84PublicAccount;
  receive: Bip84PublicAddress;
}>;
export function snapshotBip84HdPublicRequest(
  value: unknown
): Bip84HdPublicRequest {
  const r = record(value, ['network', 'accountIndex']);
  return Object.freeze({
    network: snapshotBip84Network(r.network),
    accountIndex: index(r.accountIndex),
  });
}

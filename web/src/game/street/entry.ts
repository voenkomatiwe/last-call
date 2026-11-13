// The way into the bar (LC-024): one step at a time, chosen from the chain state only. Pure: the
// street gate and the tests import it.

import type { AccountSnapshot, GameSnapshot } from "../actions";
import { hasBacklog } from "../actions";

export type EntryStep =
  /** No wallet: connect one. */
  | { readonly kind: "connect" }
  /** No token account: `storage_deposit` (registration only). */
  | { readonly kind: "register"; readonly deposit: bigint }
  /** Not enough LAST for the stake, and the contract has a faucet with tokens left. */
  | { readonly kind: "faucet"; readonly amount: bigint; readonly stake: bigint; readonly balance: bigint }
  /** Not enough LAST and no faucet: the visitor needs a transfer from a holder. */
  | { readonly kind: "no-funds"; readonly stake: bigint; readonly balance: bigint }
  /** Finished days wait beyond the auto-settle cap: `join` would fail with `ERR_BACKLOG`. */
  | { readonly kind: "settle"; readonly days: number }
  /** Everything is in place: `join` with the stake. */
  | { readonly kind: "join"; readonly stake: bigint; readonly deposit: bigint; readonly balance: bigint }
  /** Already a member: the bar. */
  | { readonly kind: "member" };

export function entryStep(game: GameSnapshot, account: AccountSnapshot | null): EntryStep {
  if (!account) return { kind: "connect" };
  if (account.member) return { kind: "member" };
  const { config, state, bounds } = game;
  if (account.storage === null) return { kind: "register", deposit: bounds.min };
  if (account.balance < config.joinStake) {
    const faucetOpen = config.faucetAmount > 0n && state.faucetLeft >= config.faucetAmount;
    return faucetOpen
      ? { kind: "faucet", amount: config.faucetAmount, stake: config.joinStake, balance: account.balance }
      : { kind: "no-funds", stake: config.joinStake, balance: account.balance };
  }
  if (hasBacklog(game)) return { kind: "settle", days: state.pendingDays };
  return { kind: "join", stake: config.joinStake, deposit: config.memberStorageDeposit, balance: account.balance };
}

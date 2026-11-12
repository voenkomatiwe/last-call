import {
  type ContractCall,
  checkInCall,
  claimCall,
  faucetCall,
  joinCall,
  leaveCall,
  settleCall,
  storageDepositCall,
} from "../contract/calls";
import type { ConfigView, MemberView, StateView, StorageBalance, StorageBalanceBounds } from "../contract/views";
import { formatLast } from "./format";

// Which actions the page offers to the connected account, and why one is unavailable. The rules
// follow `contract/API.md` ("Flows"); the contract stays the authority and may still refuse.

export type ActionId = "register" | "faucet" | "join" | "checkIn" | "claim" | "leave" | "settle";

export interface ActionState {
  readonly id: ActionId;
  readonly label: string;
  /** The call to send when enabled. */
  readonly call: ContractCall | undefined;
  /** Why the action is unavailable, or a warning to show next to an enabled one. */
  readonly note: string | undefined;
}

export interface AccountSnapshot {
  readonly accountId: string;
  /** `null`: no token account. */
  readonly storage: StorageBalance | null;
  readonly balance: bigint;
  readonly member: MemberView | null;
}

export interface GameSnapshot {
  readonly config: ConfigView;
  readonly state: StateView;
  readonly bounds: StorageBalanceBounds;
}

function enabled(id: ActionId, label: string, call: ContractCall, note?: string): ActionState {
  return { id, label, call, note };
}

function disabled(id: ActionId, label: string, note: string): ActionState {
  return { id, label, call: undefined, note };
}

/** True when game calls would fail with `ERR_BACKLOG` until someone settles. */
export function hasBacklog(game: GameSnapshot): boolean {
  return game.state.pendingDays > game.config.autoSettleCap;
}

/** The exit fee `leave` would burn now (API.md: `slash_bps` of the stake unless checked in today or in warm-up). */
export function exitFee(config: ConfigView, member: MemberView): bigint {
  if (!member.isActive || member.checkedInToday) return 0n;
  return (member.effectiveStake * BigInt(config.slashBps)) / 10_000n;
}

/** Actions for an account; settle is offered to anyone when finished days wait. */
export function accountActions(game: GameSnapshot, account: AccountSnapshot | null): ActionState[] {
  const { config, state, bounds } = game;
  const actions: ActionState[] = [];
  const backlog = hasBacklog(game);

  if (state.pendingDays > 0) {
    const label = `Settle ${state.pendingDays} finished day${state.pendingDays === 1 ? "" : "s"}`;
    const required = backlog ? "Required: game calls are refused until these days are settled." : undefined;
    // Anyone may settle, but a transaction needs a signer.
    actions.push(
      account
        ? enabled("settle", label, settleCall(), required)
        : disabled(
            "settle",
            label,
            required ? `${required} Connect a wallet to settle.` : "Connect a wallet to settle."
          )
    );
  }
  if (!account) return actions;

  if (account.storage === null) {
    actions.push(enabled("register", "Register for $LAST", storageDepositCall(bounds.min)));
    return actions;
  }

  const member = account.member;
  if (!member) {
    if (config.faucetAmount > 0n) {
      actions.push(enabled("faucet", `Faucet: get ${formatLast(config.faucetAmount)}`, faucetCall()));
    }
    actions.push(
      account.balance >= config.joinStake
        ? enabled("join", `Join (stake ${formatLast(config.joinStake)})`, joinCall(config.memberStorageDeposit))
        : disabled("join", `Join (stake ${formatLast(config.joinStake)})`, `You have ${formatLast(account.balance)}.`)
    );
    return actions;
  }

  const blockedByBacklog = backlog ? "Settle the finished days first." : undefined;
  if (member.checkedInToday) {
    actions.push(disabled("checkIn", "Check in", "Already checked in today."));
  } else if (!member.isActive) {
    actions.push(disabled("checkIn", "Check in", `Warm-up: check-ins open on day ${member.activationDay}.`));
  } else if (blockedByBacklog) {
    actions.push(disabled("checkIn", "Check in", blockedByBacklog));
  } else {
    actions.push(enabled("checkIn", "Check in", checkInCall()));
  }

  const claimable = member.pendingClaimable;
  if (claimable > 0n && !blockedByBacklog) {
    actions.push(enabled("claim", `Claim ${formatLast(claimable)}`, claimCall()));
  } else {
    actions.push(disabled("claim", "Claim", blockedByBacklog ?? "Nothing to claim yet."));
  }

  if (blockedByBacklog) {
    actions.push(disabled("leave", "Leave", blockedByBacklog));
  } else {
    const fee = exitFee(config, member);
    actions.push(
      enabled(
        "leave",
        "Leave",
        leaveCall(),
        fee > 0n
          ? `Exit fee ${formatLast(fee)} (burnt). Checking in today first waives it.`
          : "No exit fee now. Your stake, rewards, and storage deposit are returned."
      )
    );
  }
  return actions;
}

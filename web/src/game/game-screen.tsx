"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { type QuickCheckIn, useCheckinKey } from "../checkin/use-checkin-key";
import { kickCall, retryPickHeroCall } from "../contract/calls";
import { describeContractError } from "../contract/errors";
import { parseCheckInResult } from "../contract/views";
import { type AccessKeySummary, accessKeySummary } from "../near/access-keys";
import type { NearNetwork } from "../near/near-config";
import { createViewProvider } from "../near/view";
import { useWallet } from "../wallet/use-wallet";
import { type ActionState, accountActions } from "./actions";
import { formatBps, formatCountdown, formatLast, formatNear } from "./format";
import { createGameQueryClient, type GameData, useGame } from "./use-game";

// Neutral, functional game screen (plan section 6.2). The visual design and the check-in gesture
// are open decisions: plain controls until they are made.

interface Props {
  readonly network: NearNetwork;
  readonly contractId: string;
  readonly rpcUrl: string;
}

const EXPLORER: Record<NearNetwork, string> = {
  testnet: "https://testnet.nearblocks.io/address/",
  mainnet: "https://nearblocks.io/address/",
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function GameScreen(props: Props) {
  const [queryClient] = useState(createGameQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <Game {...props} />
    </QueryClientProvider>
  );
}

function Game({ network, contractId, rpcUrl }: Props) {
  const wallet = useWallet(network);
  const accountId = wallet.state.status === "connected" ? wallet.state.accountId : null;
  const { data, kickable, error, refresh } = useGame(rpcUrl, contractId, accountId);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const quick = useCheckinKey({ rpcUrl, contractId, accountId, sendActions: wallet.sendActions });

  async function execute(label: string, task: () => Promise<unknown>, describe?: (result: unknown) => string) {
    setBusy(label);
    setMessage(undefined);
    try {
      const result = await task();
      setMessage(describe ? describe(result) : `${label}: done.`);
    } catch (cause) {
      setMessage(`${label} failed: ${describeContractError(cause)}`);
    } finally {
      setBusy(undefined);
      refresh();
    }
  }

  function send(label: string, call: ActionState["call"], describe?: (result: unknown) => string) {
    if (!call) return;
    void execute(label, () => wallet.callContract(contractId, call), describe);
  }

  return (
    <>
      <WalletBar
        state={wallet.state}
        onConnect={() => wallet.connect().catch((cause) => setMessage(describeContractError(cause)))}
        onDisconnect={() => wallet.disconnect()}
      />
      {error && <p role="alert">Could not read the contract: {error}</p>}
      {!data ? (
        <p>Loading the game from {contractId}…</p>
      ) : (
        <>
          <DaySection data={data} />
          <AccountSection
            data={data}
            busy={busy}
            message={message}
            onAction={send}
            quick={quick}
            onQuick={(label, task, describe) => void execute(label, task, describe)}
          />
          <HeroSection data={data} canSend={accountId !== null} busy={busy} onAction={send} />
          <KickSection kickable={kickable} accountId={accountId} busy={busy} onAction={send} />
          <PotSection data={data} />
          <HistorySection data={data} />
          <NoAdminKey network={network} contractId={contractId} rpcUrl={rpcUrl} />
        </>
      )}
    </>
  );
}

function WalletBar({
  state,
  onConnect,
  onDisconnect,
}: {
  readonly state: ReturnType<typeof useWallet>["state"];
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
}) {
  if (state.status === "loading") return <p>Loading wallets…</p>;
  if (state.status === "disconnected") {
    return (
      <p>
        <button type="button" onClick={onConnect}>
          Connect wallet
        </button>{" "}
        to play. Everything below is readable without one.
      </p>
    );
  }
  return (
    <p>
      Connected as <strong>{state.accountId}</strong> ({state.walletName}){" "}
      <button type="button" onClick={onDisconnect}>
        Disconnect
      </button>
    </p>
  );
}

function DaySection({ data }: { readonly data: GameData }) {
  const now = useNow(1_000);
  const { state, config } = data.game;
  const day = data.openDay;
  const left = state.msToDayEnd - (now - data.readAt);
  const ticketsLeft = Math.max(0, day.goal - day.count);

  return (
    <section aria-labelledby="day-heading">
      <h2 id="day-heading">Day {state.today}</h2>
      <p>
        Community streak: <strong>{state.streak}</strong> (record {state.longestStreak})
      </p>
      <p>Day ends in {formatCountdown(left)}</p>
      {day.stale && (
        <p>
          Day {day.day} has ended and waits to be settled; the first call of the new day settles it. The figures below
          describe day {day.day}.
        </p>
      )}
      {day.isIdle ? (
        <p>
          Idle day: {day.active} active member{day.active === 1 ? "" : "s"}, fewer than {config.minGoal}. Check-ins are
          recorded but do not decide anything.
        </p>
      ) : (
        <>
          <p>
            Checked in <strong>{day.count}</strong> of <strong>{day.goal}</strong> needed ({day.active} active members).
            {ticketsLeft > 0 ? ` ${ticketsLeft} more to reach the goal.` : " Goal reached."}
          </p>
          <progress max={day.goal} value={Math.min(day.count, day.goal)} />
        </>
      )}
      <p>
        Hero candidates (the last {config.closersK} check-ins before the goal, one per block):{" "}
        {day.closers.length === 0 ? "none yet" : day.closers.join(", ")}
      </p>
    </section>
  );
}

const ONE_TAP = "Check in (one tap)";

function AccountSection({
  data,
  busy,
  message,
  onAction,
  quick,
  onQuick,
}: {
  readonly data: GameData;
  readonly busy: string | undefined;
  readonly message: string | undefined;
  readonly onAction: (label: string, call: ActionState["call"], describe?: (result: unknown) => string) => void;
  readonly quick: QuickCheckIn;
  readonly onQuick: (label: string, task: () => Promise<unknown>, describe?: (result: unknown) => string) => void;
}) {
  const account = data.account;
  const actions = accountActions(data.game, account);
  const member = account?.member;
  const { config, state } = data.game;

  const describeCheckIn = (result: unknown) => {
    const r = parseCheckInResult(result);
    return `Checked in for day ${r.day}: number ${r.n} of ${r.goal}. ${
      r.inClosers ? "You are a hero candidate for now." : "Not a hero candidate."
    }`;
  };

  return (
    <section aria-labelledby="account-heading">
      <h2 id="account-heading">You</h2>
      {!account ? (
        <p>Connect a wallet to join and check in.</p>
      ) : (
        <>
          <p>
            Balance: {formatLast(account.balance)}
            {account.storage === null && " — not registered for the token yet"}
          </p>
          {member ? (
            <ul>
              <li>
                Stake: {formatLast(member.effectiveStake)}
                {state.pendingDays > 0 && " (finished days not settled yet)"}
              </li>
              <li>Rewards to claim: {formatLast(member.pendingClaimable)}</li>
              <li>
                {member.isActive ? "Active" : `Warm-up until day ${member.activationDay}`} · check-ins {member.checkins}{" "}
                · your streak {member.currentPersonalStreak} (best {member.bestPersonalStreak}) · hero{" "}
                {member.heroCount}×
              </li>
              {member.kickableFromDay !== null && !member.checkedInToday && (
                <li>
                  Check in to stay: anyone may kick you from day {member.kickableFromDay} (after {config.inactiveDays}{" "}
                  days without a check-in).
                </li>
              )}
            </ul>
          ) : (
            account.storage !== null && (
              <p>
                Not a member. Joining locks {formatLast(config.joinStake)} and {formatNear(config.memberStorageDeposit)}{" "}
                for storage, both returned when you leave (minus the exit fee of {formatBps(config.slashBps)} if you
                leave on a day you have not checked in).
              </p>
            )
          )}
        </>
      )}
      {actions.length > 0 && (
        <ul>
          {actions.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                disabled={!action.call || busy !== undefined}
                onClick={() =>
                  onAction(action.label, action.call, action.id === "checkIn" ? describeCheckIn : undefined)
                }
              >
                {busy === action.label ? `${action.label}…` : action.label}
              </button>
              {action.note && ` ${action.note}`}
              {/* One tap next to the wallet check-in, never instead of it: if it fails the wallet still works. */}
              {action.id === "checkIn" && action.call !== undefined && quick.status === "ready" && (
                <>
                  {" "}
                  <button
                    type="button"
                    disabled={busy !== undefined}
                    onClick={() => onQuick(ONE_TAP, quick.checkIn, describeCheckIn)}
                  >
                    {busy === ONE_TAP ? `${ONE_TAP}…` : ONE_TAP}
                  </button>{" "}
                  No wallet popup; your account pays the small gas.
                </>
              )}
            </li>
          ))}
          {member && quick.status === "off" && (
            <li>
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={() => onQuick("Enable one-tap check-in", quick.enable)}
              >
                {busy === "Enable one-tap check-in" ? "Enable one-tap check-in…" : "Enable one-tap check-in"}
              </button>{" "}
              One wallet confirmation adds a key to your account that can only call check_in on this contract. After
              that you check in without a wallet popup; your account pays the small gas. You can always check in through
              the wallet instead.
            </li>
          )}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function HeroSection({
  data,
  canSend,
  busy,
  onAction,
}: {
  readonly data: GameData;
  readonly canSend: boolean;
  readonly busy: string | undefined;
  readonly onAction: (label: string, call: ActionState["call"]) => void;
}) {
  const pending = data.game.state.pendingHeroDays;
  if (pending.length === 0) return null;
  return (
    <section aria-labelledby="hero-heading">
      <h2 id="hero-heading">Hero draws in progress</h2>
      <p>
        The hero of a successful day is drawn a block or two after the day is settled. Jackpots waiting:{" "}
        {formatLast(data.game.state.jackpotPending)}.
      </p>
      <ul>
        {pending.map((day) => (
          <li key={day}>
            Day {day}{" "}
            {canSend && (
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={() => onAction(`Retry the draw of day ${day}`, retryPickHeroCall(day))}
              >
                Retry the draw
              </button>
            )}{" "}
            (only if it stays pending: the draw ran out of gas)
          </li>
        ))}
      </ul>
    </section>
  );
}

function KickSection({
  kickable,
  accountId,
  busy,
  onAction,
}: {
  readonly kickable: readonly string[];
  readonly accountId: string | null;
  readonly busy: string | undefined;
  readonly onAction: (label: string, call: ActionState["call"]) => void;
}) {
  if (kickable.length === 0) return null;
  return (
    <section aria-labelledby="kick-heading">
      <h2 id="kick-heading">Abandoned seats</h2>
      <p>These members stopped checking in. Anyone may kick them and receive part of their exit fee.</p>
      <ul>
        {kickable.map((target) => (
          <li key={target}>
            {target}{" "}
            {accountId && (
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={() => onAction(`Kick ${target}`, kickCall(target))}
              >
                Kick
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PotSection({ data }: { readonly data: GameData }) {
  const { state, config } = data.game;
  return (
    <section aria-labelledby="pot-heading">
      <h2 id="pot-heading">Pot and supply</h2>
      <ul>
        <li>Pot: {formatLast(state.pot)}</li>
        <li>
          Members: {state.activeCount} active, {state.membersTotal} in total
        </li>
        <li>Total supply: {formatLast(state.totalSupply)}</li>
        <li>Burnt so far: {formatLast(state.totalBurned)}</li>
        <li>
          Paid as rewards: {formatLast(state.totalRewarded)}; as jackpots: {formatLast(state.totalJackpots)}
        </li>
        <li>
          A successful day pays out {formatBps(config.emitBps)} of the pot (more with the streak); a failed day burns{" "}
          {formatBps(config.burnBps)} of it and {formatBps(config.slashBps)} of each absent member's stake.
        </li>
      </ul>
    </section>
  );
}

function HistorySection({ data }: { readonly data: GameData }) {
  if (data.history.length === 0) {
    return (
      <section aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        <p>No settled days yet.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading">History</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Outcome</th>
            <th scope="col">Check-ins</th>
            <th scope="col">Reward each</th>
            <th scope="col">Hero / jackpot</th>
            <th scope="col">Burnt</th>
          </tr>
        </thead>
        <tbody>
          {data.history.map((day) => (
            <tr key={day.day}>
              <td>{day.day}</td>
              <td>{day.outcome}</td>
              <td>
                {day.count} / {day.goal}
              </td>
              <td>{day.outcome === "Success" ? formatLast(day.perShare) : "—"}</td>
              <td>{day.jackpot > 0n ? `${day.hero ?? "drawing…"} · ${formatLast(day.jackpot)}` : "—"}</td>
              <td>{day.potBurned + day.stakeSlashed > 0n ? formatLast(day.potBurned + day.stakeSlashed) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function NoAdminKey({ network, contractId, rpcUrl }: Props) {
  const provider = useMemo(() => createViewProvider(rpcUrl), [rpcUrl]);
  const [keys, setKeys] = useState<AccessKeySummary | string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    accessKeySummary(provider, contractId).then(
      (summary) => active && setKeys(summary),
      (cause) => active && setKeys(cause instanceof Error ? cause.message : String(cause))
    );
    return () => {
      active = false;
    };
  }, [provider, contractId]);

  return (
    <section aria-labelledby="keys-heading">
      <h2 id="keys-heading">Admin keys</h2>
      {keys === undefined ? (
        <p>Checking the contract's access keys…</p>
      ) : typeof keys === "string" ? (
        <p>Could not read the access keys: {keys}</p>
      ) : keys.total === 0 ? (
        <p>
          <strong>No admin key.</strong> {contractId} has no access keys: nobody can upgrade it, change its parameters,
          or move its tokens.
        </p>
      ) : (
        <p>
          {contractId} still has {keys.total} access key{keys.total === 1 ? "" : "s"} ({keys.fullAccess} full access):
          it is not locked yet.
        </p>
      )}
      <p>
        <a href={`${EXPLORER[network]}${contractId}`} target="_blank" rel="noreferrer">
          See it on the explorer
        </a>
      </p>
    </section>
  );
}

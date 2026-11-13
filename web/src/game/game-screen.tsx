"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCheckinKey } from "../checkin/use-checkin-key";
import { checkInCall, faucetCall, joinCall, settleCall, storageDepositCall } from "../contract/calls";
import { describeContractError } from "../contract/errors";
import { parseCheckInResult } from "../contract/views";
import type { NearNetwork } from "../near/near-config";
import { useWallet } from "../wallet/use-wallet";
import { type ActionState, hasBacklog } from "./actions";
import { BarHall, type HallMessage, hallPrimary, shortLast } from "./bar/bar-hall";
import { BarLoading } from "./bar/bar-loading";
import { BarScene, claimInBar } from "./bar/bar-scene";
import { type BarSettings, useBarSettings } from "./bar/bar-settings";
import { barDay, barMode, initialPot, jarLevel } from "./bar/events";
import { claimError, claimedAmount, claimedLine, MOMENT_LINES } from "./bar/lines";
import { type EntryStep, entryStep } from "./street/entry";
import { Gate } from "./street/gate";
import { createGameQueryClient, type GameData, useGame } from "./use-game";

// The game screen (plan section 6.2, decisions of 13 Nov). Everyone sees the pub: a visitor who has
// not joined stands on the street (LC-024) and is led to the door one contract step at a time; a
// member plays the night inside the bar (LC-021). The neutral fallback screen is gone (user, 13 Nov).

interface Props {
  readonly network: NearNetwork;
  readonly contractId: string;
  readonly rpcUrl: string;
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
  const { data: fresh, kickable, error, refresh } = useGame(rpcUrl, contractId, accountId);
  // While a newly connected account loads, keep showing the last state instead of the loading screen.
  const last = useRef<GameData | undefined>(undefined);
  if (fresh) last.current = fresh;
  const data = fresh ?? last.current;
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<HallMessage | undefined>(undefined);

  const quick = useCheckinKey({ rpcUrl, contractId, accountId, sendActions: wallet.sendActions });

  // The street → bar choreography (LC-024): a visitor who joins keeps the street layout through the
  // entry walk; on desktops the full-window scene then closes in to the column before the side blocks
  // arrive. A member who opens the page goes straight to the bar.
  const member = data?.account?.member ?? null;
  const sawStreet = useRef(false);
  if (data && !member) sawStreet.current = true;
  const [entered, setEntered] = useState(false);
  const [narrowing, setNarrowing] = useState(false);
  useEffect(() => {
    if (!member && entered) setEntered(false);
  }, [member, entered]);
  const onEntered = useCallback(() => {
    const wide = window.matchMedia("(min-width: 1100px) and (prefers-reduced-motion: no-preference)").matches;
    if (!wide) {
      setEntered(true);
      return;
    }
    setNarrowing(true);
    setTimeout(() => {
      setNarrowing(false);
      setEntered(true);
    }, 950);
  }, []);
  const streetLayout = !member || (sawStreet.current && !entered);
  const settings = useBarSettings();

  // Messages fade after a while; a new one restarts the timer.
  useEffect(() => {
    if (!message) return;
    // Errors stay longer: they explain what to do next.
    const timer = setTimeout(() => setMessage(undefined), message.tone === "error" ? 10_000 : 6_000);
    return () => clearTimeout(timer);
  }, [message]);

  // The bar's check-in goes through the one-tap key when it is ready, otherwise the wallet. Either
  // way the page re-reads the contract afterwards.
  const { callContract } = wallet;
  const { status: quickStatus, checkIn: quickCheckIn } = quick;
  const checkInFromBar = useCallback(async () => {
    try {
      const result = quickStatus === "ready" ? await quickCheckIn() : await callContract(contractId, checkInCall());
      return parseCheckInResult(result);
    } finally {
      refresh();
    }
  }, [quickStatus, quickCheckIn, callContract, contractId, refresh]);

  async function execute(label: string, task: () => Promise<unknown>, describe?: (result: unknown) => string) {
    setBusy(label);
    setMessage(undefined);
    try {
      const result = await task();
      setMessage({ text: describe ? describe(result) : `${label}: done.`, tone: "info" });
    } catch (cause) {
      setMessage({ text: `${label} failed: ${describeContractError(cause)}`, tone: "error" });
    } finally {
      setBusy(undefined);
      refresh();
    }
  }

  /** Claim from the tab plays in the bar: the bartender opens the till, then hands over the coins or explains. */
  function claim(call: NonNullable<ActionState["call"]>) {
    const expected = data?.account?.member?.pendingClaimable ?? 0n;
    const pick = (lines: readonly string[]) => lines[(Math.random() * lines.length) | 0] ?? "";
    setBusy("Claim");
    setMessage(undefined);
    claimInBar({ state: "pending", line: pick(MOMENT_LINES.claiming) });
    wallet
      .callContract(contractId, call)
      .then(
        (result) => {
          const amount = shortLast(claimedAmount(result, expected));
          claimInBar({ state: "paid", line: claimedLine(amount, pick) });
          setMessage({ text: `Claimed ${amount} LAST.`, tone: "info" });
        },
        (cause) => {
          claimInBar({ state: "failed", line: claimError(cause) });
          setMessage({ text: `Claim failed: ${describeContractError(cause)}`, tone: "error" });
        }
      )
      .finally(() => {
        setBusy(undefined);
        refresh();
      });
  }

  function send(label: string, call: ActionState["call"], describe?: (result: unknown) => string) {
    if (!call) return;
    void execute(label, () => wallet.callContract(contractId, call), describe);
  }

  /** One gate step: the matching wallet or contract call. */
  function takeStep(step: EntryStep) {
    switch (step.kind) {
      case "connect":
        setBusy("Connect");
        wallet
          .connect()
          .catch((cause) => setMessage({ text: `Wallet: ${describeContractError(cause)}`, tone: "error" }))
          .finally(() => setBusy(undefined));
        return;
      case "register":
        send("Open a $LAST account", storageDepositCall(step.deposit), () => "Account opened. Now the stake.");
        return;
      case "faucet":
        send("Faucet", faucetCall(), () => "The tap poured. Now the door.");
        return;
      case "settle":
        send("Settle", settleCall(), () => "Old nights settled.");
        return;
      case "join":
        send("Join", joinCall(step.deposit), () => "Welcome in.");
        return;
      default:
        return;
    }
  }

  if (wallet.state.status === "loading" || !data) return <BarLoading error={error} />;

  const step = entryStep(data.game, data.account);
  const gateBusy = busy === "Connect" || (busy !== undefined && !member);

  return (
    <>
      {error && (
        <p className="lc-hall-alert" role="alert">
          Could not read the contract: {error}
        </p>
      )}
      <BarHall
        data={data}
        kickable={kickable}
        accountId={accountId}
        busy={busy}
        message={message}
        quick={quick}
        stage={
          <Bar data={data} accountId={accountId} settings={settings} onCheckIn={checkInFromBar} onEntered={onEntered} />
        }
        settings={settings}
        onSend={(label, call) => (call?.methodName === "claim" ? claim(call) : send(label, call))}
        onEnableQuick={() => void execute("Enable one-tap check-in", quick.enable)}
        onDisconnect={() => wallet.disconnect()}
        street={streetLayout}
        narrowing={narrowing}
        gate={
          member ? undefined : (
            <Gate
              step={step}
              accountId={accountId}
              slashPct={data.game.config.slashBps / 100}
              busy={gateBusy}
              onStep={takeStep}
            />
          )
        }
      />
    </>
  );
}

const NO_CHECK_IN = async () => {
  throw new Error("Not a member yet");
};

/** The scene for everyone: the street for visitors, the bar for members. */
function Bar({
  data,
  accountId,
  settings,
  onCheckIn,
  onEntered,
}: {
  readonly data: GameData;
  readonly accountId: string | null;
  readonly settings: BarSettings;
  readonly onCheckIn: () => Promise<ReturnType<typeof parseCheckInResult>>;
  readonly onEntered: () => void;
}) {
  const member = data.account?.member ?? null;
  const { config, state } = data.game;
  const day = useMemo(() => barDay(state, data.openDay), [state, data.openDay]);
  const facts = useMemo(
    () => ({ closersK: config.closersK, slashPct: config.slashBps / 100 }),
    [config.closersK, config.slashBps]
  );
  const goal = data.openDay.stale || data.openDay.isIdle ? "-" : String(data.openDay.goal);
  const stake = shortLast(config.joinStake);
  const board = useMemo(() => ({ goal, stake: `${stake} LAST` }), [goal, stake]);
  const jar = jarLevel(state.pot, initialPot(config.initialSupply, config.potBps));
  return (
    <BarScene
      day={day}
      mode={member ? barMode(member, hasBacklog(data.game)) : "warmup"}
      checkedInToday={member?.checkedInToday ?? false}
      accountId={accountId ?? "guest"}
      streak={member?.currentPersonalStreak ?? 0}
      facts={facts}
      onCheckIn={member ? onCheckIn : NO_CHECK_IN}
      sound={settings.sound}
      bodySounds={settings.bodySounds}
      nightEndsAt={data.readAt + state.msToDayEnd}
      nightLengthMs={config.dayLengthS * 1000}
      primary={member ? hallPrimary(data) : "none"}
      place={member ? "bar" : "street"}
      board={board}
      onEntered={onEntered}
      history={data.history}
      jar={jar}
    />
  );
}

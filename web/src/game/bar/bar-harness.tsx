"use client";

import { useEffect, useMemo, useState } from "react";
import type { QuickCheckIn } from "../../checkin/use-checkin-key";
import type { CheckInResult, DaySummary } from "../../contract/views";
import { BarHall } from "./bar-hall";
import { BarScene, claimInBar } from "./bar-scene";
import { useBarSettings } from "./bar-settings";
import type { BarDay, BarMode } from "./events";
import { harnessData } from "./harness-data";
import { claimError, claimedLine, MOMENT_LINES } from "./lines";

// `/dev/bar`: the bar against a simulated chain, to check the scene, the gesture, and every
// outcome without a wallet. The real page wires the same component to the contract.
// `/dev/bar?hall` shows the whole hall (chalkboard, scene, tab) on synthetic contract views.

const QUICK_OFF: QuickCheckIn = { status: "off", enable: async () => {}, checkIn: async () => undefined };

type Next = "ok" | "rejected" | "already" | "backlog";

const MODES: readonly BarMode[] = ["ready", "warmup", "done-today", "backlog"];

export function BarHarness() {
  const [day, setDay] = useState<BarDay>({
    day: 12,
    count: 3,
    goal: 6,
    isIdle: false,
    closers: ["bot-1.test", "bot-2.test"],
  });
  const [mode, setMode] = useState<BarMode>("ready");
  const [checkedIn, setCheckedIn] = useState(false);
  const [streak, setStreak] = useState(5);
  const [leftPct, setLeftPct] = useState(60);
  const [nightEndsAt, setNightEndsAt] = useState(() => Date.now() + 360_000);
  const NIGHT_MS = 600_000;
  const [place, setPlace] = useState<"street" | "bar">("bar");
  // Same choreography as the game screen: street layout until the walk ends, then the desktop close-in.
  const [hallStreet, setHallStreet] = useState(false);
  const [narrowing, setNarrowing] = useState(false);
  const onEntered = () => {
    if (!window.matchMedia("(min-width: 1100px) and (prefers-reduced-motion: no-preference)").matches) {
      setHallStreet(false);
      return;
    }
    setNarrowing(true);
    setTimeout(() => {
      setNarrowing(false);
      setHallStreet(false);
    }, 950);
  };
  const board = useMemo(() => ({ goal: String(day.goal ?? "-"), stake: "100K LAST" }), [day.goal]);
  const [next, setNext] = useState<Next>("ok");
  const [log, setLog] = useState<string[]>([]);
  const facts = useMemo(() => ({ closersK: 3, slashPct: 10 }), []);
  const note = (line: string) =>
    setLog((lines) => [`${new Date().toLocaleTimeString()} ${line}`, ...lines].slice(0, 8));

  const onCheckIn = async (): Promise<CheckInResult> => {
    note(`check-in sent (${next})`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (next === "rejected") throw new Error("User rejected");
    if (next === "already") throw new Error("Smart contract panicked: ERR_ALREADY_CHECKED_IN");
    if (next === "backlog") throw new Error("Smart contract panicked: ERR_BACKLOG");
    const n = day.count + 1;
    const goal = day.goal ?? n;
    setDay((d) => ({ ...d, count: n, closers: [...d.closers, "you.test"].slice(-3) }));
    setCheckedIn(true);
    setMode("done-today");
    note(`check-in landed: #${n}`);
    return { day: day.day, n, goal, inClosers: n <= goal && n > goal - 3 };
  };

  const other = (k: number) => {
    setDay((d) => {
      const names = Array.from({ length: k }, (_, i) => `bot-${d.count + i + 1}.test`);
      return { ...d, count: d.count + k, closers: [...d.closers, ...names].slice(-3) };
    });
    note(`${k} other check-in(s)`);
  };

  // LC-025: settled days, hero draws, the pot, the claim
  const [history, setHistory] = useState<DaySummary[]>(() => harnessData(day, false, 5, 0).history.slice());
  const [potPct, setPotPct] = useState(96);
  const [settledClosers, setSettledClosers] = useState<Record<number, readonly string[]>>({});
  const settle = (outcome: "Success" | "Fail") => {
    const d = day;
    const goal = d.goal ?? 6;
    setHistory((h) => [
      {
        day: d.day,
        outcome,
        goal,
        count: outcome === "Success" ? Math.max(d.count, goal) : Math.min(d.count, goal - 1),
        streakAfter: 0,
        perShare: outcome === "Success" ? 2_380n * 10n ** 18n : 0n,
        jackpot: outcome === "Success" ? 23_810n * 10n ** 18n : 0n,
        hero: null,
        potBurned: outcome === "Fail" ? 24_100_000n * 10n ** 18n : 0n,
        stakeSlashed: 0n,
        potAfter: 0n,
      },
      ...h,
    ]);
    setSettledClosers((c) => ({ ...c, [d.day]: d.closers }));
    if (outcome === "Fail") setPotPct((p) => Math.max(0, p - 5));
    setDay((x) => ({ ...x, day: x.day + 1, count: 0, closers: [] }));
    setCheckedIn(false);
    setMode((m) => (m === "done-today" ? "ready" : m));
    note(`night ${d.day} settled: ${outcome}`);
  };
  const drawHero = (self: boolean) => {
    const target = history.find((h) => h.outcome === "Success" && h.hero === null);
    if (!target) {
      note("no hero draw pending (settle a successful night first)");
      return;
    }
    const pool = settledClosers[target.day] ?? [];
    const hero = self ? "you.test" : (pool.filter((c) => c !== "you.test")[0] ?? "bot-9.test");
    setHistory((h) => h.map((x) => (x.day === target.day ? { ...x, hero } : x)));
    note(`hero of night ${target.day}: ${hero}`);
  };
  const claimDemo = (ok: boolean) => {
    claimInBar({ state: "pending", line: MOMENT_LINES.claiming[0] });
    note(`claim sent (${ok ? "ok" : "rejected"})`);
    setTimeout(() => {
      if (ok) claimInBar({ state: "paid", line: claimedLine("7.1K", (l) => l[0] ?? "") });
      else claimInBar({ state: "failed", line: claimError(new Error("User rejected the request")) });
    }, 1200);
  };

  const settings = useBarSettings();
  const [hall, setHall] = useState(false);
  const [readAt] = useState(() => Date.now());
  useEffect(() => {
    setHall(new URLSearchParams(window.location.search).has("hall"));
  }, []);

  const scene = (
    <BarScene
      day={day}
      mode={mode}
      checkedInToday={checkedIn}
      accountId="you.test"
      streak={streak}
      facts={facts}
      onCheckIn={onCheckIn}
      sound={settings.sound}
      bodySounds={settings.bodySounds}
      nightEndsAt={nightEndsAt}
      nightLengthMs={NIGHT_MS}
      primary={mode === "backlog" ? "settle" : mode === "ready" ? "drink" : "claim"}
      place={place}
      board={board}
      onEntered={() => {
        note("entered");
        onEntered();
      }}
      history={history}
      jar={potPct / 100}
    />
  );

  const controls = (
    <fieldset>
      <legend>Simulated chain</legend>
      <p>
        <button type="button" onClick={() => other(1)}>
          Another account checks in
        </button>{" "}
        <button type="button" onClick={() => other(5)}>
          Five check in
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            setDay((d) => ({ ...d, day: d.day + 1, count: 0, closers: [] }));
            setCheckedIn(false);
            setMode((m) => (m === "done-today" ? "ready" : m));
            note("new day");
          }}
        >
          New day
        </button>
      </p>
      <p>
        <button type="button" onClick={() => settle("Success")}>
          Settle: goal hit
        </button>{" "}
        <button type="button" onClick={() => settle("Fail")}>
          Settle: failed
        </button>{" "}
        <button type="button" onClick={() => drawHero(false)}>
          Draw hero
        </button>{" "}
        <button type="button" onClick={() => drawHero(true)}>
          Draw hero: me
        </button>
      </p>
      <p>
        <button type="button" onClick={() => claimDemo(true)}>
          Claim: paid
        </button>{" "}
        <button type="button" onClick={() => claimDemo(false)}>
          Claim: rejected
        </button>{" "}
        <label>
          Pot {potPct}%{" "}
          <input type="range" min={0} max={100} value={potPct} onChange={(e) => setPotPct(Number(e.target.value))} />
        </label>
      </p>
      <p>
        Place:{" "}
        <button
          type="button"
          onClick={() => {
            setPlace("street");
            setHallStreet(true);
          }}
        >
          Street
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            setMode("warmup");
            setPlace("bar");
            note("joined: entering");
          }}
        >
          Join (walk in)
        </button>
      </p>
      <p>
        Mode:{" "}
        {MODES.map((m) => (
          <label key={m} style={{ marginRight: 8 }}>
            <input
              type="radio"
              name="mode"
              checked={mode === m}
              onChange={() => {
                setMode(m);
                setCheckedIn(m === "done-today");
              }}
            />{" "}
            {m}
          </label>
        ))}
      </p>
      <p>
        Next check-in:{" "}
        {(["ok", "rejected", "already", "backlog"] as const).map((n) => (
          <label key={n} style={{ marginRight: 8 }}>
            <input type="radio" name="next" checked={next === n} onChange={() => setNext(n)} /> {n}
          </label>
        ))}
      </p>
      <p>
        <label>
          Streak {streak}{" "}
          <input type="range" min={0} max={35} value={streak} onChange={(e) => setStreak(Number(e.target.value))} />
        </label>{" "}
        <button type="button" onClick={() => setStreak(0)}>
          Lose streak
        </button>
      </p>
      <p>
        <label>
          Night left {leftPct}%{" "}
          <input
            type="range"
            min={1}
            max={100}
            value={leftPct}
            onChange={(e) => {
              const pct = Number(e.target.value);
              setLeftPct(pct);
              setNightEndsAt(Date.now() + (NIGHT_MS * pct) / 100);
            }}
          />
        </label>
      </p>
      <ol reversed aria-label="Log">
        {log.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </fieldset>
  );

  if (hall) {
    return (
      <main>
        <BarHall
          data={{ ...harnessData(day, checkedIn, streak, readAt, nightEndsAt - readAt, mode), history }}
          kickable={["sleepy.test"]}
          accountId="you.test"
          busy={undefined}
          message={undefined}
          quick={QUICK_OFF}
          stage={scene}
          keys={<p>No admin key (simulated)</p>}
          settings={settings}
          onSend={(label, call) => (call?.methodName === "claim" ? claimDemo(true) : note(`send: ${label}`))}
          onEnableQuick={() => note("enable one-tap")}
          onDisconnect={() => note("disconnect")}
          street={hallStreet}
          narrowing={narrowing}
        />
        <details
          style={{
            position: "fixed",
            left: 8,
            bottom: 8,
            zIndex: 10,
            maxWidth: 420,
            maxHeight: "80vh",
            overflow: "auto",
            padding: 8,
            borderRadius: 8,
            background: "#fff",
            color: "#000",
          }}
        >
          <summary>Simulated chain</summary>
          {controls}
        </details>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 460, margin: "0 auto", padding: "16px" }}>
      {scene}
      {controls}
    </main>
  );
}

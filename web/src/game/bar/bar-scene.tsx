"use client";

import "./bar.css";

import { useEffect, useRef, useState } from "react";

import type { CheckInResult, DaySummary } from "../../contract/views";
import { shortLast } from "../format";
import type { BoardText } from "../street/street-art";
import {
  type BarDay,
  type BarMode,
  type BarSnapshot,
  deadLetters,
  failedDays,
  historyEvents,
  SIGN,
  sceneEvents,
  seatClosers,
} from "./events";
import { type BarFacts, bartenderError, chatLines, heroLine, hintLines, ownCheckInLine, settledLine } from "./lines";
import { createBarScene, type BarScene as Engine, type FocusTarget, type Place } from "./scene";
import { type PrimaryAction, streakTier } from "./streak-tier";

/** HUD numbers ask the scene to ring their object with this window event (LC-028). */
export const FOCUS_EVENT = "lc-bar-focus";
export function focusInBar(target: FocusTarget): void {
  window.dispatchEvent(new CustomEvent<FocusTarget>(FOCUS_EVENT, { detail: target }));
}

/** The claim from the tab plays in the bar: the bartender opens the till and hands the coins over (LC-025). */
export const CLAIM_EVENT = "lc-bar-claim";
export interface ClaimMoment {
  readonly state: "pending" | "paid" | "failed";
  readonly line: string;
}
export function claimInBar(moment: ClaimMoment): void {
  window.dispatchEvent(new CustomEvent<ClaimMoment>(CLAIM_EVENT, { detail: moment }));
}

const pickLine = (lines: readonly string[]) => lines[(Math.random() * lines.length) | 0] ?? "";

// The joined player's bar (LC-021). The chain decides; this component only shows it: the mode comes
// from `get_member`, the crowd from the polled day, and a full "bottoms up" calls `onCheckIn`, which
// sends the check-in through the page's existing path.

export interface BarSceneProps {
  readonly day: BarDay;
  readonly mode: BarMode;
  readonly checkedInToday: boolean;
  readonly accountId: string;
  readonly streak: number;
  readonly facts: BarFacts;
  /** Sends `check_in` and resolves with its result; rejects with the wallet's or the contract's error. */
  readonly onCheckIn: () => Promise<CheckInResult>;
  /** Sound settings live next to the wallet (`useBarSettings`); the scene only follows them. */
  readonly sound: boolean;
  readonly bodySounds: boolean;
  /** When tonight ends, on this page clock (epoch ms), and the night length; drive the clock and the at-risk state. */
  readonly nightEndsAt: number;
  readonly nightLengthMs: number;
  /** The one thing the screen asks for now; only "drink" makes the glass glow. */
  readonly primary: PrimaryAction;
  /** Street (not joined yet) or bar; street → bar plays the entry walk. */
  readonly place: Place;
  /** The chalk board on the street. */
  readonly board: BoardText;
  /** The entry walk finished and the camera settled at the bar. */
  readonly onEntered?: () => void;
  /** Settled days (`get_history`): new ones and hero draws become moments; failures kill sign letters. */
  readonly history: readonly DaySummary[];
  /** How full the pot jar is, 0..1 (`jarLevel`). */
  readonly jar: number;
}

export function BarScene({
  day,
  mode,
  checkedInToday,
  accountId,
  streak,
  facts,
  onCheckIn,
  sound,
  bodySounds,
  nightEndsAt,
  nightLengthMs,
  primary,
  place,
  board,
  onEntered,
  history,
  jar,
}: BarSceneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sayRef = useRef<HTMLDivElement>(null);
  const bangRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const signRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const checkInRef = useRef(onCheckIn);
  checkInRef.current = onCheckIn;
  const enteredRef = useRef(onEntered);
  enteredRef.current = onEntered;
  /** The player's own confirmed check-in, shown before the next poll catches up. */
  const [own, setOwn] = useState<{ day: number; n: number } | null>(null);

  // The engine lives as long as the component; it is told about changes below.
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const say = sayRef.current;
    const bang = bangRef.current;
    const tip = tipRef.current;
    const bell = bellRef.current;
    const sign = signRef.current;
    const ghost = ghostRef.current;
    if (!root || !canvas || !say || !bang || !tip || !bell || !sign || !ghost) return;
    const scene = createBarScene({
      elements: { root, canvas, say, bang, tip, bell, sign, ghost },
      assetBase: "/bar",
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onEntered: () => enteredRef.current?.(),
      onFullDrink: () => {
        checkInRef.current().then(
          (result) => {
            setOwn({ day: result.day, n: result.n });
            scene.checkInSucceeded(result, ownCheckInLine(result, pickLine));
          },
          (error: unknown) => scene.checkInFailed(bartenderError(error))
        );
      },
    });
    engine.current = scene;
    return () => {
      engine.current = null;
      scene.destroy();
    };
  }, []);

  useEffect(() => {
    engine.current?.setMode(mode);
  }, [mode]);

  // Place first: the greeting below depends on it.
  useEffect(() => {
    engine.current?.setPlace(place);
  }, [place]);

  useEffect(() => {
    engine.current?.setBoard(board);
  }, [board]);

  // Streak tier: greet on the first value, celebrate a new tier, crack the glass when the streak is lost.
  const lastStreak = useRef<number | null>(null);
  useEffect(() => {
    const scene = engine.current;
    if (!scene) return;
    const before = lastStreak.current;
    lastStreak.current = streak;
    if (before !== null && before > 0 && streak === 0) scene.streakLost(before);
    scene.setStreak(streak, accountId);
  }, [streak, accountId]);

  useEffect(() => {
    engine.current?.setNight(nightEndsAt, nightLengthMs);
  }, [nightEndsAt, nightLengthMs]);

  useEffect(() => {
    engine.current?.setPrimary(primary === "drink");
  }, [primary]);

  useEffect(() => {
    const onFocus = (event: Event) => {
      const target = (event as CustomEvent<FocusTarget>).detail;
      engine.current?.focus(target);
    };
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EVENT, onFocus);
  }, []);

  useEffect(() => {
    engine.current?.setSound(sound);
  }, [sound]);

  useEffect(() => {
    engine.current?.setBodySounds(bodySounds);
  }, [bodySounds]);

  useEffect(() => {
    engine.current?.setLines({ hints: hintLines(day.goal, facts), chat: chatLines(facts) });
  }, [day.goal, facts]);

  // Live crowd: compare each poll with the previous one.
  const previous = useRef<BarSnapshot | null>(null);
  useEffect(() => {
    const next: BarSnapshot = { day, checkedInToday, accountId };
    const events = sceneEvents(previous.current, next);
    previous.current = next;
    const scene = engine.current;
    if (!scene) return;
    for (const event of events) {
      if (event.kind === "new-day") scene.newDay();
      else if (event.kind === "others-checked-in") scene.othersCheckedIn(event.count, event.names);
      else scene.goalReached();
    }
  }, [day, checkedInToday, accountId]);

  // LC-025: closers on the patrons' glasses, the jar, settled days and hero draws, the claim.
  useEffect(() => {
    const seats = seatClosers(day.closers, accountId);
    engine.current?.setClosers(seats.others, seats.self);
  }, [day.closers, accountId]);

  useEffect(() => {
    engine.current?.setJar(jar);
  }, [jar]);

  /** Each open day's closers as last seen, so a later hero draw spins over the right names. */
  const closersByDay = useRef(new Map<number, readonly string[]>());
  if (day.closers.length) {
    closersByDay.current.set(day.day, day.closers);
    for (const d of closersByDay.current.keys()) if (d < day.day - 8) closersByDay.current.delete(d);
  }
  const previousHistory = useRef<readonly DaySummary[] | null>(null);
  useEffect(() => {
    const events = historyEvents(previousHistory.current, history);
    previousHistory.current = history;
    const scene = engine.current;
    if (!scene) return;
    for (const event of events) {
      if (event.kind === "day-settled") {
        const { day: d, outcome } = event.summary;
        if (outcome !== "Idle") scene.daySettled(outcome, settledLine(d, outcome, pickLine));
      } else {
        const self = event.hero === accountId;
        const candidates = closersByDay.current.get(event.day) ?? [event.hero];
        scene.heroPicked(
          candidates,
          event.hero,
          accountId,
          heroLine(event.day, event.hero, self, shortLast(event.jackpot), pickLine)
        );
      }
    }
  }, [history, accountId]);

  useEffect(() => {
    const onClaim = (event: Event) => {
      const { state, line } = (event as CustomEvent<ClaimMoment>).detail;
      engine.current?.claim(state, line);
    };
    window.addEventListener(CLAIM_EVENT, onClaim);
    return () => window.removeEventListener(CLAIM_EVENT, onClaim);
  }, []);

  // Failed days kill the sign's letters for good; letters that die while the page is open flicker out.
  const dead = deadLetters(failedDays(history));
  const deadAtStart = useRef<ReadonlySet<number> | null>(null);
  if (deadAtStart.current === null) deadAtStart.current = dead;

  const count = own && own.day === day.day ? Math.max(day.count, own.n) : day.count;

  useEffect(() => {
    engine.current?.setGoal(count, day.isIdle ? null : day.goal);
  }, [count, day.goal, day.isIdle]);

  // The drunk sway lives in the canvas only (LC-028): numbers and buttons stay sharp.
  return (
    <section className="lc-bar" data-tier={streakTier(streak).id} aria-label="The bar">
      <div
        ref={rootRef}
        className="lc-bar-scene"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scene is the check-in control (hold Space).
        tabIndex={0}
        role="application"
        aria-label="First-person bar. Drag the pint to your mouth and hold until it is empty: that is your check-in. Keyboard: hold Space."
      >
        <canvas ref={canvasRef} />
        <div ref={signRef} className="lc-bar-sign" aria-hidden="true">
          {[...SIGN].map((letter, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: the sign's letters are fixed; the index is the letter.
              key={i}
              className={dead.has(i) ? (deadAtStart.current?.has(i) ? "is-dead" : "is-dying") : undefined}
            >
              {letter}
            </span>
          ))}
        </div>
        <button ref={bellRef} type="button" className="lc-bar-bell" aria-label="Bell">
          <svg viewBox="0 0 34 40" aria-hidden="true">
            <path d="M17 2v4" stroke="#c9a14a" strokeWidth="2" />
            <path d="M6 30c2-4 2-10 3-14 1-5 4-8 8-8s7 3 8 8c1 4 1 10 3 14z" fill="#d9a441" stroke="#8a6420" />
            <rect x="3" y="29" width="28" height="3" rx="1.5" fill="#b8862c" />
            <circle cx="17" cy="35" r="3" fill="#8a6420" />
          </svg>
        </button>
        <div className="lc-bar-hud" aria-live="polite">
          <span className="lc-bar-chip">
            on board <b>{count}</b>
            {day.goal !== null && ` / ${day.goal}`}
          </span>
          <span className="lc-bar-chip">
            {day.isIdle
              ? "quiet night: too few members"
              : day.goal === null
                ? "day not open yet"
                : count < day.goal
                  ? `${day.goal - count} to the bell`
                  : "goal hit!"}
          </span>
          <span className="lc-bar-chip">
            streak <b>{streak}</b>
          </span>
        </div>
        <div ref={ghostRef} className="lc-bar-ghost" aria-hidden="true">
          <span className="lc-bar-ghost-dot" />
        </div>
        <div ref={sayRef} className="lc-bar-say" role="status" aria-live="polite" />
        <div ref={bangRef} className="lc-bar-bang" aria-hidden="true">
          BANG!
        </div>
        <div ref={tipRef} className="lc-bar-tip" />
      </div>
    </section>
  );
}

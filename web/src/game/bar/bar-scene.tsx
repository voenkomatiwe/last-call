"use client";

import "./bar.css";

import { type CSSProperties, useEffect, useRef, useState } from "react";

import type { CheckInResult } from "../../contract/views";
import { type BarDay, type BarMode, type BarSnapshot, drunkLevel, sceneEvents } from "./events";
import { type BarFacts, bartenderError, chatLines, hintLines, ownCheckInLine } from "./lines";
import { createBarScene, type BarScene as Engine } from "./scene";

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
}: BarSceneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sayRef = useRef<HTMLDivElement>(null);
  const bangRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const signRef = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const checkInRef = useRef(onCheckIn);
  checkInRef.current = onCheckIn;
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
    if (!root || !canvas || !say || !bang || !tip || !bell || !sign) return;
    const scene = createBarScene({
      elements: { root, canvas, say, bang, tip, bell, sign },
      assetBase: "/bar",
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onFullDrink: () => {
        checkInRef.current().then(
          (result) => {
            setOwn({ day: result.day, n: result.n });
            scene.checkInSucceeded(
              result,
              ownCheckInLine(result, (lines) => lines[(Math.random() * lines.length) | 0] ?? "")
            );
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

  const count = own && own.day === day.day ? Math.max(day.count, own.n) : day.count;
  const drunk = drunkLevel(streak);
  const style = { "--d": drunk.toFixed(3) } as CSSProperties;
  const wob = (i: number): CSSProperties => ({
    animationDelay: `${(-i * 0.37).toFixed(2)}s`,
    animationDuration: `${(1.6 + (i % 3) * 0.45).toFixed(2)}s`,
  });

  return (
    <section className={`lc-bar${drunk > 0 ? " lc-bar-drunk" : ""}`} style={style} aria-label="The bar">
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
          LAST CALL
        </div>
        <button ref={bellRef} type="button" className="lc-bar-bell" aria-label="Bell">
          <svg viewBox="0 0 34 40" aria-hidden="true" className="lc-bar-wob" style={wob(0)}>
            <path d="M17 2v4" stroke="#c9a14a" strokeWidth="2" />
            <path d="M6 30c2-4 2-10 3-14 1-5 4-8 8-8s7 3 8 8c1 4 1 10 3 14z" fill="#d9a441" stroke="#8a6420" />
            <rect x="3" y="29" width="28" height="3" rx="1.5" fill="#b8862c" />
            <circle cx="17" cy="35" r="3" fill="#8a6420" />
          </svg>
        </button>
        <div className="lc-bar-hud" aria-live="polite">
          <span className="lc-bar-chip lc-bar-wob" style={wob(1)}>
            on board <b>{count}</b>
            {day.goal !== null && ` / ${day.goal}`}
          </span>
          <span className="lc-bar-chip lc-bar-wob" style={wob(2)}>
            {day.isIdle
              ? "quiet night: too few members"
              : day.goal === null
                ? "day not open yet"
                : count < day.goal
                  ? `${day.goal - count} to the bell`
                  : "goal hit!"}
          </span>
          <span className="lc-bar-chip lc-bar-wob" style={wob(3)}>
            streak <b>{streak}</b>
          </span>
        </div>
        <div ref={sayRef} className="lc-bar-say" role="status" aria-live="polite" />
        <div ref={bangRef} className="lc-bar-bang" aria-hidden="true">
          BANG!
        </div>
        <div ref={tipRef} className="lc-bar-tip lc-bar-wob" style={wob(4)} />
      </div>
    </section>
  );
}

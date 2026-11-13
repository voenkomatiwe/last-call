// The last-orders bar: canvas 2D scene engine ported from `docs/prototypes/last-orders-bar.html`
// (LC-021). It draws the room, four Open Peeps patrons (CC0), the player's nonic pint, the screen beer
// flood, and runs the "bottoms up" gesture. It knows nothing about the chain: the host tells it the bar
// mode and what happened, and is told when a full drink should become a check-in.
//
// Browser-only: import it from a client component, inside an effect.

import { gsap } from "gsap";
import { type BoardText, createStreetArt, doorRect, STREET_PUSH, type StreetState } from "../street/street-art";
import { type BarMode, drunkLevel } from "./events";
import { cheerFor, LINES } from "./lines";
import {
  burstConfetti,
  type Confetto,
  drawClock,
  drawCracks,
  drawCrown,
  drawFocus,
  drawGlassBadge,
  drawGoalRail,
  drawHalo,
  drawJar,
  drawPlaque,
  drawRimGlow,
  drawTierWash,
  goalRailBox,
  gradeFilter,
  stepConfetti,
} from "./scene-extras";
import { streakTier } from "./streak-tier";

/** Where the camera is: in front of the pub (not joined yet) or inside at the bar. */
export type Place = "street" | "bar";

/** How a line reads: plain, good news, a nudge, or something that went wrong. */
export type SayTone = "info" | "good" | "warn" | "error";

/** What a HUD number points at in the scene. */
export type FocusTarget = "glass" | "streak" | "goal" | "pot" | "clock";
const FOCUS_LABEL: Record<FocusTarget, string> = {
  glass: "your pint",
  streak: "your streak",
  goal: "goal",
  pot: "pot",
  clock: "time left",
};
const DRANK_KEY = "lc-bar-drank";

export interface SceneElements {
  /** The scene box: pointer and keyboard input, size. */
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** Bartender's line, big text in the middle. */
  readonly say: HTMLElement;
  /** "BANG!" when the glass lands. */
  readonly bang: HTMLElement;
  /** Small hint at the bottom. */
  readonly tip: HTMLElement;
  readonly bell: HTMLElement;
  readonly sign: HTMLElement;
  /** Ghost hand that shows the gesture (LC-028); optional. */
  readonly ghost?: HTMLElement;
}

export interface SceneOptions {
  readonly elements: SceneElements;
  /** Where `peeps/` and `sfx/` live under `public/`. */
  readonly assetBase: string;
  readonly reducedMotion: boolean;
  /** The player drank to the bottom in `ready` mode: send the check-in, then call `checkInSucceeded` or `checkInFailed`. */
  readonly onFullDrink: () => void;
  /** The street entry finished: the camera has settled at the bar (LC-024). */
  readonly onEntered?: () => void;
}

export interface CheckInOutcome {
  readonly n: number;
  readonly goal: number;
  readonly inClosers: boolean;
}

export interface BarScene {
  setMode(mode: BarMode): void;
  setLines(lines: { readonly hints: readonly string[]; readonly chat: readonly string[] }): void;
  setSound(on: boolean): void;
  setBodySounds(on: boolean): void;
  othersCheckedIn(count: number, names: readonly string[]): void;
  goalReached(): void;
  newDay(): void;
  checkInSucceeded(outcome: CheckInOutcome, line: string): void;
  checkInFailed(line: string): void;
  say(text: string, who?: string, tone?: SayTone): void;
  /** Personal streak and the player name (plaque, glass initial): sets the tier, greets or celebrates. */
  setStreak(streak: number, name: string): void;
  /** When tonight ends (epoch ms, this page clock) and how long a night is. */
  setNight(endsAt: number, lengthMs: number): void;
  setGoal(count: number, goal: number | null): void;
  /** The personal streak dropped to zero between polls. */
  streakLost(previous: number): void;
  /** Ring the object a HUD number stands for. */
  focus(target: FocusTarget): void;
  /** Whether the glass is the one thing to touch now (else it does not glow). */
  setPrimary(glass: boolean): void;
  /**
   * Street or bar. The first call places the camera; street → bar afterwards plays the entry: the door
   * opens, the camera walks in, the crowd greets the new member.
   */
  setPlace(place: Place): void;
  /** Tonight's goal and the stake for the chalk board on the street. */
  setBoard(board: BoardText): void;
  destroy(): void;
}

type Ctx = CanvasRenderingContext2D;
type Pt = { x: number; y: number };
type Ellipse = { cx: number; cy: number; rx: number; ry: number };
type GlassMode = "idle" | "hold" | "drink" | "drain" | "wait" | "lower";

const at = <T>(list: readonly T[], i: number): T => list[((i % list.length) + list.length) % list.length] as T;
const pick = <T>(list: readonly T[]): T => at(list, (Math.random() * list.length) | 0);
const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function norm(x: number, y: number): Pt {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

// Tuning approved in the prototype (its "parameters for LC-021" panel).
const GULP_S = 1.4;
const LIFT_TRAVEL = 0.36;
const SCREEN_FLOOD = 1;
const DRAIN_S = 1.2;

const BAR = 0.7;
const INK = "#140812";
const FACES = ["idle", "closed", "lol", "big", "shout", "worried"] as const;
type Face = (typeof FACES)[number];
const SFX_COUNT = { burp: 6, fart: 7 } as const;
type SfxKind = keyof typeof SFX_COUNT;

interface Patron {
  readonly id: string;
  readonly x: number;
  readonly flip: number;
  readonly sleeve: string;
  /** Arm lift, chug, celebrate: 0..1 tweened by GSAP. */
  a: number;
  d: number;
  c: number;
  vol: number;
  busy: boolean;
  face: Face | null;
  faceUntil: number;
  blinkAt: number;
  bubble: { text: string; until: number; born: number } | null;
  bodyC: HTMLCanvasElement | null;
  armC: HTMLCanvasElement | null;
  faceC: Partial<Record<Face, HTMLCanvasElement>>;
  headScreen: Pt | null;
}

interface PatronImages {
  body: HTMLImageElement | null;
  faces: Partial<Record<Face, HTMLImageElement | null>>;
}

export function createBarScene(options: SceneOptions): BarScene {
  const { root, canvas: cv, say: sayEl, bang: bangEl, tip: tipEl, bell: bellEl, sign: signEl } = options.elements;
  const reduced = options.reducedMotion;
  const base = options.assetBase;
  const maybeCtx = cv.getContext("2d");
  if (!maybeCtx) throw new Error("Canvas 2D is not available");
  let ctx: Ctx = maybeCtx;

  const fontVar = (name: string, fallback: string) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  const F_BODY = fontVar("--f-body", "system-ui, sans-serif");
  const F_MONO = fontVar("--f-mono", "ui-monospace, monospace");

  let destroyed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function later(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, ms);
    timers.add(id);
  }

  // The scene is laid out in a portrait column `cw` × `ch`. On a wider screen the canvas spans the
  // full width `fw`, the column sits in the middle at `ox`, and the room and the counter repeat as
  // bays of a long back bar on both sides (desktop fills the screen; phones are unchanged).
  let cw = 0;
  let ch = 0;
  let fw = 0;
  let ox = 0;
  // Same portrait ratio as the hall column (bar.css), so the full-width bar and the column agree.
  const PORTRAIT = 0.62;
  let dpr = 1;
  let sound = true;
  let bodyOn = true;
  let bodyN = 0;
  let audio: AudioContext | null = null;

  // ---------- state ----------
  let barMode: BarMode = "ready";
  /** The player's check-in landed this day (before the poll says so). */
  let ownDone = false;
  let mode: GlassMode = "idle";
  let held = false;
  let lift = 0;
  let liftTarget = 0;
  let hx = 0.5;
  let hxTarget = 0.5;
  let vol = 1;
  let flood = 0;
  let drainY = -1;
  let extraDrinks = 0;
  let startY = 0;
  let bellPokes = 0;
  let bellRungToday = false;
  let lastHint = 0;
  const shake = { x: 0, y: 0 };
  let wobble = 0;
  let slosh = 0;
  let sloshV = 0;
  let lastLift = 0;
  let gulpT = 0;
  let nextChat = 0;
  let nextPatron = 0;
  let hints: readonly string[] = [];
  let chat: readonly string[] = [];
  const queue: string[] = [];
  const bubbles: { t: number; x: number; v: number; r: number }[] = [];
  const drops: { x: number; y: number; y0: number; vy: number; r: number; a: number }[] = [];
  const bokeh: { x: number; y: number; r: number; c: string; ph: number }[] = [];
  const labels: { text: string; x: number; y: number; a: number }[] = [];
  // LC-028: streak tier, night clock, goal rail, focus ring, ghost hand, confetti
  let tier = -1;
  let drunk = 0;
  let playerName = "";
  let nightEnd = 0;
  let nightLen = 0;
  let riskK = 0;
  let riskOn = false;
  let goalCount = 0;
  let goalN: number | null = null;
  let cracked = 0;
  let primaryGlass = true;
  let focusOn: { target: FocusTarget; until: number } | null = null;
  let idleSince = performance.now();
  let ghostShown = false;
  let lastFilter = "";
  let drankBefore = false;
  try {
    drankBefore = localStorage.getItem(DRANK_KEY) === "1";
  } catch {}
  const confetti: Confetto[] = [];
  // LC-024: the street in front of the pub, the entry walk, and the camera settling in the bar
  let place: Place | null = null;
  const street: StreetState = { door: 0, zoom: 0, reveal: 0 };
  /** The street frame, for splitting it in two as the doorway opens up. */
  let streetFrameC: HTMLCanvasElement | null = null;
  /** The player's glass slides up onto the counter after the walk in (px below its place). */
  let glassIn = 0;
  let camZ = 0;
  let vgA = 1;
  let portalC: HTMLCanvasElement | null = null;
  const streetArt = createStreetArt({
    body: F_BODY,
    neon: fontVar("--f-neon", "sans-serif"),
    chalk: fontVar("--f-chalk", "cursive"),
  });

  // ---------- patrons ----------
  const patrons: Patron[] = [
    { id: "kai", x: 0.16, flip: 1, sleeve: "#5B3FA0" },
    { id: "mira", x: 0.39, flip: 1, sleeve: "#D9533C" },
    { id: "bob", x: 0.61, flip: -1, sleeve: "#2E8C84" },
    { id: "olga", x: 0.84, flip: -1, sleeve: "#F2C14E" },
  ].map((p) => ({
    ...p,
    a: 0,
    d: 0,
    c: 0,
    vol: 1,
    busy: false,
    face: null,
    faceUntil: 0,
    blinkAt: 2000 + Math.random() * 3000,
    bubble: null,
    bodyC: null,
    armC: null,
    faceC: {},
    headScreen: null,
  }));
  const imgs: Record<string, PatronImages> = {};
  let myHand: HTMLImageElement | null = null;
  function loadImg(src: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
  const ready = (async () => {
    await Promise.all(
      patrons.map(async (p) => {
        const dir = `${base}/peeps/${p.id}`;
        const [body, ...faces] = await Promise.all([
          loadImg(`${dir}/body.svg`),
          ...FACES.map((f) => loadImg(`${dir}/face-${f}.svg`)),
        ]);
        imgs[p.id] = { body: body ?? null, faces: Object.fromEntries(FACES.map((f, i) => [f, faces[i] ?? null])) };
      })
    );
    myHand = await loadImg(`${base}/peeps/_me/hand.svg`);
  })();

  const PAD = 60;
  let K = 0;
  function rasterCanvas(): [HTMLCanvasElement, Ctx] {
    const c = document.createElement("canvas");
    c.width = Math.ceil((940 + PAD * 2) * K * dpr);
    c.height = Math.ceil((1130 + PAD * 2) * K * dpr);
    const x = c.getContext("2d") as Ctx;
    x.setTransform(K * dpr, 0, 0, K * dpr, 0, 0);
    x.translate(-184 + PAD, -210 + PAD);
    return [c, x];
  }
  function raster(img: HTMLImageElement | null | undefined): HTMLCanvasElement | null {
    if (!img) return null;
    const [c, x] = rasterCanvas();
    x.shadowColor = "#ff4fb8";
    x.shadowBlur = 9 * dpr;
    x.drawImage(img, 184, 210, 940, 1130);
    x.shadowBlur = 0;
    // no neon glow inside the see-through cup, so the beer behind it keeps its colour
    x.globalCompositeOperation = "destination-out";
    x.fillRect(608, 934, 229, 282);
    x.globalCompositeOperation = "source-over";
    x.drawImage(img, 184, 210, 940, 1130);
    return c;
  }
  // Cut-out rig of the artist's "Coffee" pose (Coffee units, offset (147,639) into effigy units).
  // FORE: forearm band + fist, swung from the elbow hidden below the bar. MUGCOVER: the old mug, painted over.
  const CO = { x: 147, y: 639 };
  const FORE: readonly (readonly [number, number])[] = [
    [40, 716],
    [108, 512],
    [326, 424],
    [392, 362],
    [478, 310],
    [552, 326],
    [560, 404],
    [552, 470],
    [516, 500],
    [478, 522],
    [404, 560],
    [372, 590],
    [44, 722],
  ];
  const MUGCOVER: readonly (readonly [number, number])[] = [
    [548, 318],
    [700, 318],
    [700, 545],
    [492, 545],
    [520, 512],
    [546, 486],
    [554, 440],
    [560, 400],
    [556, 350],
  ];
  const ELBOW = { x: 60, y: 690 };
  const GLASSC = { x: 600, y: 420 };
  function polyPath(x: Ctx, pts: readonly (readonly [number, number])[]) {
    x.beginPath();
    pts.forEach(([a, b], i) => {
      if (i) x.lineTo(a + CO.x, b + CO.y);
      else x.moveTo(a + CO.x, b + CO.y);
    });
    x.closePath();
  }
  function rasterRig(
    img: HTMLImageElement | null,
    shirt: string
  ): { torso: HTMLCanvasElement; arm: HTMLCanvasElement } | null {
    if (!img) return null;
    const [tc, tx] = rasterCanvas();
    tx.shadowColor = "#ff4fb8";
    tx.shadowBlur = 9 * dpr;
    tx.drawImage(img, 184, 210, 940, 1130);
    tx.shadowBlur = 0;
    tx.drawImage(img, 184, 210, 940, 1130);
    tx.fillStyle = shirt;
    polyPath(tx, FORE);
    tx.fill();
    polyPath(tx, MUGCOVER);
    tx.fill();
    // fill the see-through hole the mug left in the shirt
    tx.globalCompositeOperation = "destination-over";
    tx.fillRect(461 + CO.x, 295 + CO.y, 229, 282);
    tx.globalCompositeOperation = "source-over";
    const [ac, ax] = rasterCanvas();
    polyPath(ax, FORE);
    ax.clip();
    ax.drawImage(img, 184, 210, 940, 1130);
    ax.globalCompositeOperation = "destination-out";
    polyPath(ax, MUGCOVER);
    ax.fill();
    ax.globalCompositeOperation = "source-over";
    return { torso: tc, arm: ac };
  }
  function rasterAll() {
    if (destroyed || cw === 0) return;
    K = (cw * 0.36) / 940;
    for (const p of patrons) {
      const im = imgs[p.id];
      if (!im) continue;
      const rig = rasterRig(im.body, p.sleeve);
      p.bodyC = rig?.torso ?? null;
      p.armC = rig?.arm ?? null;
      p.faceC = {};
      for (const f of FACES) {
        const c = raster(im.faces[f]);
        if (c) p.faceC[f] = c;
      }
    }
  }

  function resize() {
    const r = root.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    fw = r.width;
    ch = r.height;
    cw = Math.min(fw, ch * PORTRAIT);
    ox = (fw - cw) / 2;
    cv.width = Math.round(fw * dpr);
    cv.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!bokeh.length)
      for (let i = 0; i < 18; i++)
        bokeh.push({
          x: 0.05 + Math.random() * 0.9,
          y: 0.21 + Math.random() * 0.22,
          r: 6 + Math.random() * 20,
          c: at(["#ff4fb8", "#ffb84a", "#7d6bff", "#ffd27a"], i),
          ph: Math.random() * 6,
        });
    roomC = null;
    barC = null;
    streetArt.reset();
    void ready.then(rasterAll);
  }

  // ---------- room ----------
  // The static room is painted once per resize into offscreen canvases; lamps and glints animate on top.
  let roomC: HTMLCanvasElement | null = null;
  let barC: HTMLCanvasElement | null = null;
  let coasterX = -1;
  const MIR0 = 0.195;
  const MIR1 = 0.53;
  const SHELVES = [0.292, 0.398];
  const LAMPS = [0.2, 0.76];
  const LAMPY = 0.192;
  /** Bay offsets (in column widths) that cover the full canvas: 0 is the middle column. */
  function bays(): number[] {
    const n = cw > 0 ? Math.ceil(ox / cw) : 0;
    return Array.from({ length: n * 2 + 1 }, (_, i) => i - n);
  }
  /** Lamp positions (in column widths) over every bay. */
  function lampsAcross(): number[] {
    return bays().flatMap((k) => LAMPS.map((lx) => lx + k));
  }
  function offscreen(): [HTMLCanvasElement, Ctx] {
    const c = document.createElement("canvas");
    c.width = Math.ceil(cw * dpr);
    c.height = Math.ceil(ch * dpr);
    const x = c.getContext("2d") as Ctx;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [c, x];
  }
  function shade(hex: string, k: number) {
    const n = Number.parseInt(hex.slice(1), 16);
    const f = (v: number) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k);
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  function line(x0: number, y0: number, x1: number, y1: number) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  // bottle shapes as fractions of height: body half-width, body height, shoulder height, neck half-width
  const BT = {
    wine: [0.15, 0.58, 0.12, 0.05],
    whisky: [0.23, 0.64, 0.07, 0.07],
    gin: [0.18, 0.7, 0.06, 0.06],
    round: [0.25, 0.46, 0.12, 0.05],
    beer: [0.12, 0.5, 0.17, 0.045],
    tall: [0.13, 0.66, 0.1, 0.045],
  } as const;
  type Bottle = keyof typeof BT;
  const BTYPES: readonly Bottle[] = [
    "wine",
    "whisky",
    "gin",
    "round",
    "beer",
    "tall",
    "whisky",
    "wine",
    "gin",
    "beer",
    "round",
    "tall",
    "whisky",
  ];
  const LIQ = [
    "#7a1f2b",
    "#c9781e",
    "#cfe3da",
    "#2f6b3a",
    "#5a2e0e",
    "#e2b04a",
    "#b5651d",
    "#3b1020",
    "#9fd3c7",
    "#4a2a0c",
    "#8a2340",
    "#f0c060",
    "#a8541a",
  ];
  const LAB: readonly (string | null)[] = [
    "#f3e3c3",
    "#1d1d2b",
    "#ffffff",
    "#e9c46a",
    "#c0392b",
    "#f6e8dc",
    "#264653",
    "#f4a261",
    null,
  ];
  function bottle(x: number, y: number, h: number, type: Bottle, liq: string, lab: string | null, lw: number) {
    const [bw, bh, sh, nw] = BT[type].map((v) => v * h) as [number, number, number, number];
    const r = Math.min(bw * 0.35, h * 0.05);
    const round = type === "round";
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(x - bw + r, y);
      ctx.lineTo(x + bw - r, y);
      ctx.quadraticCurveTo(x + bw, y, x + bw, y - r);
      if (round) {
        ctx.lineTo(x + bw, y - bh * 0.55);
        ctx.quadraticCurveTo(x + bw, y - bh - sh * 0.4, x + nw, y - bh - sh);
      } else {
        ctx.lineTo(x + bw, y - bh);
        ctx.quadraticCurveTo(x + bw, y - bh - sh, x + nw, y - bh - sh);
      }
      ctx.lineTo(x + nw, y - h);
      ctx.lineTo(x - nw, y - h);
      ctx.lineTo(x - nw, y - bh - sh);
      if (round) ctx.quadraticCurveTo(x - bw, y - bh - sh * 0.4, x - bw, y - bh * 0.55);
      else ctx.quadraticCurveTo(x - bw, y - bh - sh, x - bw, y - bh);
      ctx.lineTo(x - bw, y - r);
      ctx.quadraticCurveTo(x - bw, y, x - bw + r, y);
      ctx.closePath();
    };
    path();
    const g = ctx.createLinearGradient(x - bw, 0, x + bw, 0);
    g.addColorStop(0, shade(liq, -0.45));
    g.addColorStop(0.42, shade(liq, 0.3));
    g.addColorStop(1, shade(liq, -0.55));
    ctx.fillStyle = g;
    ctx.fill();
    if (lab) {
      const ly = y - bh * (round ? 0.5 : 0.66);
      const lh = bh * (round ? 0.3 : 0.36);
      ctx.fillStyle = lab;
      ctx.fillRect(x - bw * 0.86, ly, bw * 1.72, lh);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fillRect(x - bw * 0.5, ly + lh * 0.28, bw, lh * 0.15);
      ctx.fillRect(x - bw * 0.34, ly + lh * 0.6, bw * 0.68, lh * 0.1);
    }
    ctx.fillStyle = type === "wine" ? "#5c1520" : type === "beer" ? "#c9a14a" : type === "gin" ? "#9aa3ad" : "#1f1a1d";
    ctx.fillRect(x - nw * 1.2, y - h, nw * 2.4, h * 0.08);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.lineJoin = "round";
    path();
    ctx.stroke();
    ctx.strokeRect(x - nw * 1.2, y - h, nw * 2.4, h * 0.08);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = lw * 0.9;
    ctx.lineCap = "round";
    line(x - bw * 0.55, y - bh * 0.92, x - bw * 0.55, y - bh * 0.18);
  }
  function plank(x0: number, x1: number, y: number, th: number, lw: number) {
    const g = ctx.createLinearGradient(0, y, 0, y + th);
    g.addColorStop(0, "#9a5a2c");
    g.addColorStop(0.3, "#6e3a18");
    g.addColorStop(1, "#3d1d0b");
    ctx.fillStyle = g;
    ctx.fillRect(x0, y, x1 - x0, th);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.strokeRect(x0, y, x1 - x0, th);
    ctx.strokeStyle = "rgba(255,214,160,0.35)";
    ctx.lineWidth = 1;
    line(x0 + lw, y + lw * 0.9, x1 - lw, y + lw * 0.9);
  }
  function paintRoom(): HTMLCanvasElement {
    const [c, x] = offscreen();
    const main = ctx;
    ctx = x;
    const lw = Math.max(1.3, cw / 250);
    // brick wall
    ctx.fillStyle = "#1a0a0b";
    ctx.fillRect(0, 0, cw, ch);
    const bh = ch * 0.024;
    const bw = cw * 0.115;
    for (let r = 0; r * bh < ch * MIR0 + bh; r++) {
      const off = ((r % 2) * bw) / 2;
      for (let i = -1; i * bw < cw + bw; i++) {
        const k = ((r * 7 + i * 13) % 5) / 5;
        ctx.fillStyle = `rgb(${(66 + k * 22) | 0},${(28 + k * 10) | 0},${(24 + k * 8) | 0})`;
        ctx.beginPath();
        ctx.roundRect(i * bw - off + 1.4, r * bh + 1.4, bw - 2.8, bh - 2.8, 2.5);
        ctx.fill();
      }
    }
    const wv = ctx.createLinearGradient(0, 0, 0, ch * MIR0);
    wv.addColorStop(0, "rgba(12,4,8,0.15)");
    wv.addColorStop(1, "rgba(12,4,8,0.6)");
    ctx.fillStyle = wv;
    ctx.fillRect(0, 0, cw, ch * MIR0);
    // back bar: wooden frame, a dark mirror, two shelves of backlit bottles
    const fx0 = cw * 0.02;
    const fx1 = cw * 0.98;
    const y0 = ch * MIR0;
    const y1 = ch * MIR1;
    const fw = cw * 0.022;
    ctx.fillStyle = "#3a1c0c";
    ctx.fillRect(fx0, y0, fx1 - fx0, y1 - y0);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.strokeRect(fx0, y0, fx1 - fx0, y1 - y0);
    ctx.fillStyle = "#5a2e14";
    ctx.fillRect(fx0 - cw * 0.01, y0 - ch * 0.012, fx1 - fx0 + cw * 0.02, ch * 0.014);
    ctx.strokeRect(fx0 - cw * 0.01, y0 - ch * 0.012, fx1 - fx0 + cw * 0.02, ch * 0.014);
    const mg = ctx.createLinearGradient(0, y0, 0, y1);
    mg.addColorStop(0, "#241a2a");
    mg.addColorStop(1, "#140d16");
    ctx.fillStyle = mg;
    ctx.fillRect(fx0 + fw, y0 + fw, fx1 - fx0 - fw * 2, y1 - y0 - fw);
    ctx.strokeRect(fx0 + fw, y0 + fw, fx1 - fx0 - fw * 2, y1 - y0 - fw);
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx0 + fw, y0 + fw, fx1 - fx0 - fw * 2, y1 - y0 - fw);
    ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,0.045)";
    for (const [a, w] of [
      [0.12, 0.07],
      [0.3, 0.03],
      [0.55, 0.09],
      [0.8, 0.04],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(cw * a, y0);
      ctx.lineTo(cw * (a + w), y0);
      ctx.lineTo(cw * (a + w - 0.12), y1);
      ctx.lineTo(cw * (a - 0.12), y1);
      ctx.fill();
    }
    SHELVES.forEach((sf, si) => {
      const sy = ch * sf;
      const bh2 = ch * (si ? 0.082 : 0.074);
      const glow = ctx.createLinearGradient(0, sy - bh2 * 1.2, 0, sy);
      glow.addColorStop(0, "rgba(255,170,80,0)");
      glow.addColorStop(1, "rgba(255,170,80,0.32)");
      ctx.fillStyle = glow;
      ctx.fillRect(fx0, sy - bh2 * 1.2, fx1 - fx0, bh2 * 1.2);
      let x = fx0 + fw + cw * 0.035;
      let n = si * 5;
      while (x < fx1 - fw - cw * 0.03) {
        const ty = at(BTYPES, n);
        const h = bh2 * (0.78 + ((n * 37) % 10) / 45);
        const half = BT[ty][0] * h;
        x += half;
        if (x + half > fx1 - fw - cw * 0.01) break;
        bottle(x, sy, h, ty, at(LIQ, n * 5), at(LAB, n * 3), lw * 0.85);
        x += half + cw * (0.008 + ((n * 7) % 4) * 0.004);
        n++;
      }
      plank(fx0 + fw * 0.5, fx1 - fw * 0.5, sy, ch * 0.012, lw);
      const led = ctx.createLinearGradient(0, sy + ch * 0.012, 0, sy + ch * 0.05);
      led.addColorStop(0, "rgba(255,190,110,0.28)");
      led.addColorStop(1, "rgba(255,190,110,0)");
      ctx.fillStyle = led;
      ctx.fillRect(fx0, sy + ch * 0.012, fx1 - fx0, ch * 0.04);
    });
    ctx.restore();
    // lamps hang from the ceiling over the bar
    LAMPS.forEach((lx) => {
      const X = lx * cw;
      const Y = ch * LAMPY;
      const w = cw * 0.13;
      ctx.strokeStyle = INK;
      ctx.lineWidth = lw;
      line(X, 0, X, Y - w * 0.32);
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(X - w * 0.06, Y - w * 0.36, w * 0.12, w * 0.08);
      ctx.strokeRect(X - w * 0.06, Y - w * 0.36, w * 0.12, w * 0.08);
      ctx.beginPath();
      ctx.moveTo(X - w * 0.1, Y - w * 0.28);
      ctx.lineTo(X + w * 0.1, Y - w * 0.28);
      ctx.quadraticCurveTo(X + w * 0.2, Y - w * 0.08, X + w * 0.5, Y);
      ctx.ellipse(X, Y, w * 0.5, w * 0.08, 0, 0, Math.PI);
      ctx.quadraticCurveTo(X - w * 0.2, Y - w * 0.08, X - w * 0.1, Y - w * 0.28);
      ctx.closePath();
      const sg = ctx.createLinearGradient(X - w * 0.5, 0, X + w * 0.5, 0);
      sg.addColorStop(0, "#173a30");
      sg.addColorStop(0.4, "#3f7a64");
      sg.addColorStop(1, "#122a23");
      ctx.fillStyle = sg;
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = lw * 0.8;
      line(X - w * 0.08, Y - w * 0.22, X - w * 0.3, Y - w * 0.04);
    });
    ctx = main;
    return c;
  }
  // beer taps on the far edge of the counter: chrome T-bar, three spouts, tall handles
  function taps(x: number, y0: number, h: number, lw: number) {
    const W = cw * 0.062;
    const colW = cw * 0.018;
    const barY = y0 - h * 0.5;
    const bh = h * 0.11;
    const chrome = (x0: number, x1: number) => {
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, "#55555f");
      g.addColorStop(0.35, "#eeeef4");
      g.addColorStop(0.6, "#a0a0ae");
      g.addColorStop(1, "#44444e");
      return g;
    };
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.fillStyle = "#2a2a30";
    ctx.beginPath();
    ctx.roundRect(x - W * 0.95, y0 - h * 0.05, W * 1.9, h * 0.08, 3);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 9; i++)
      line(x - W * 0.9 + i * W * 0.2, y0 - h * 0.04, x - W * 0.9 + i * W * 0.2, y0 + h * 0.02);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.fillStyle = chrome(x - colW, x + colW);
    ctx.fillRect(x - colW, barY, colW * 2, y0 - h * 0.05 - barY);
    ctx.strokeRect(x - colW, barY, colW * 2, y0 - h * 0.05 - barY);
    ctx.fillStyle = chrome(x - W, x + W);
    ctx.beginPath();
    ctx.roundRect(x - W, barY - bh, W * 2, bh, bh / 2);
    ctx.fill();
    ctx.stroke();
    ["#ff4fb8", "#ffb84a", "#2E8C84"].forEach((col, k) => {
      const tx = x + (k - 1) * W * 0.66;
      ctx.fillStyle = chrome(tx - 4, tx + 4);
      ctx.beginPath();
      ctx.moveTo(tx - 3.5, barY);
      ctx.lineTo(tx + 3.5, barY);
      ctx.lineTo(tx + 3.5, barY + h * 0.13);
      ctx.lineTo(tx + 1.5, barY + h * 0.17);
      ctx.lineTo(tx - 1.5, barY + h * 0.17);
      ctx.lineTo(tx - 3.5, barY + h * 0.13);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const ht = h * 0.42;
      const t0 = barY - bh;
      ctx.beginPath();
      ctx.moveTo(tx - cw * 0.008, t0);
      ctx.lineTo(tx + cw * 0.008, t0);
      ctx.lineTo(tx + cw * 0.014, t0 - ht);
      ctx.quadraticCurveTo(tx, t0 - ht - cw * 0.012, tx - cw * 0.014, t0 - ht);
      ctx.closePath();
      const hg = ctx.createLinearGradient(tx - cw * 0.014, 0, tx + cw * 0.014, 0);
      hg.addColorStop(0, shade(col, -0.4));
      hg.addColorStop(0.4, shade(col, 0.25));
      hg.addColorStop(1, shade(col, -0.5));
      ctx.fillStyle = hg;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff3d6";
      ctx.beginPath();
      ctx.arc(tx, t0 - ht * 0.62, cw * 0.007, 0, 7);
      ctx.fill();
      ctx.stroke();
    });
  }
  function paintBar(): HTMLCanvasElement {
    const [c, x] = offscreen();
    const main = ctx;
    ctx = x;
    const top = ch * BAR;
    const lw = Math.max(1.3, cw / 250);
    const D = ch - top;
    // counter top in perspective: far edge at the bar line, near edge at the bottom of the screen
    const g = ctx.createLinearGradient(0, top, 0, ch);
    g.addColorStop(0, "#4a230e");
    g.addColorStop(0.3, "#7a3f1b");
    g.addColorStop(1, "#3a1a09");
    ctx.fillStyle = g;
    ctx.fillRect(0, top, cw, D);
    for (let i = 0; i < 46; i++) {
      const f = ((i * 0.618) % 1) ** 1.5;
      const yy = top + D * f;
      const x0 = ((i * 0.37) % 1) * cw * 0.9 - cw * 0.15;
      const len = cw * (0.35 + ((i * 0.29) % 1) * 0.6);
      const amp = 1 + f * 3;
      ctx.strokeStyle = i % 3 ? "rgba(35,12,4,0.28)" : "rgba(255,190,120,0.09)";
      ctx.lineWidth = 0.6 + f * 1.2;
      ctx.beginPath();
      for (let k = 0; k <= 24; k++) {
        const xx = x0 + (len * k) / 24;
        if (k) ctx.lineTo(xx, yy + Math.sin(k * 0.6 + i) * amp);
        else ctx.moveTo(xx, yy);
      }
      ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      const yy = top + D * (i / 8) ** 1.7;
      ctx.strokeStyle = "rgba(20,8,18,0.6)";
      ctx.lineWidth = 0.8 + i * 0.25;
      line(0, yy, cw, yy);
      ctx.strokeStyle = "rgba(255,205,150,0.1)";
      ctx.lineWidth = 1;
      line(0, yy + 1.5 + i * 0.3, cw, yy + 1.5 + i * 0.3);
    }
    const sh = ctx.createLinearGradient(0, top, 0, ch);
    sh.addColorStop(0, "rgba(255,230,200,0)");
    sh.addColorStop(0.2, "rgba(255,230,200,0.08)");
    sh.addColorStop(0.32, "rgba(255,230,200,0)");
    ctx.fillStyle = sh;
    ctx.fillRect(0, top, cw, D);
    const rg = ctx.createRadialGradient(cw / 2, top, 4, cw / 2, top, cw * 0.7);
    rg.addColorStop(0, "#ff4fb830");
    rg.addColorStop(1, "#ff4fb800");
    ctx.fillStyle = rg;
    ctx.fillRect(0, top, cw, D * 0.5);
    const nv = ctx.createLinearGradient(0, top, 0, ch);
    nv.addColorStop(0.55, "rgba(10,3,2,0)");
    nv.addColorStop(1, "rgba(10,3,2,0.5)");
    ctx.fillStyle = nv;
    ctx.fillRect(0, top, cw, D);
    ctx.fillStyle = INK;
    ctx.fillRect(0, top - 1.5, cw, 3);
    ctx.fillStyle = "rgba(255,214,160,0.3)";
    ctx.fillRect(0, top + 1.5, cw, 1.5);
    taps(cw * 0.29, top + ch * 0.012, ch * 0.1, lw);
    ctx = main;
    return c;
  }
  function drawRoom(t: number) {
    if (!roomC) roomC = paintRoom();
    for (const k of bays()) ctx.drawImage(roomC, k * cw, 0, cw, ch);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cw * 0.04, ch * MIR0, cw * 0.92, ch * (MIR1 - MIR0));
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    bokeh.forEach((b) => {
      const rg = ctx.createRadialGradient(b.x * cw, b.y * ch, 0, b.x * cw, b.y * ch, b.r);
      rg.addColorStop(0, `${b.c}aa`);
      rg.addColorStop(1, `${b.c}00`);
      ctx.globalAlpha = 0.12 + 0.08 * Math.sin(t / 900 + b.ph);
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(b.x * cw, b.y * ch, b.r, 0, 7);
      ctx.fill();
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  function drawBarTop(t: number) {
    if (!barC) barC = paintBar();
    for (const k of bays()) ctx.drawImage(barC, k * cw, 0, cw, ch);
    // warm light from the lamps: glow round the bulb, a faint cone, a pool on the counter
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    lampsAcross().forEach((lx, i) => {
      const X = lx * cw;
      const Y = ch * LAMPY;
      const w = cw * 0.13;
      const f = 0.92 + 0.06 * Math.sin(t / 1700 + i * 2.3) + 0.02 * Math.sin(t / 97 + i);
      let g = ctx.createLinearGradient(0, Y, 0, ch * (BAR + 0.05));
      g.addColorStop(0, `rgba(255,205,130,${0.13 * f})`);
      g.addColorStop(1, "rgba(255,205,130,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(X - w * 0.45, Y);
      ctx.lineTo(X + w * 0.45, Y);
      ctx.lineTo(X + w * 1.7, ch * (BAR + 0.05));
      ctx.lineTo(X - w * 1.7, ch * (BAR + 0.05));
      ctx.fill();
      const py = ch * (BAR + 0.025);
      const rg = ctx.createRadialGradient(X, py, 0, X, py, w * 1.5);
      rg.addColorStop(0, `rgba(255,190,110,${0.22 * f})`);
      rg.addColorStop(1, "rgba(255,190,110,0)");
      ctx.fillStyle = rg;
      ctx.save();
      ctx.translate(X, py);
      ctx.scale(1, 0.22);
      ctx.translate(-X, -py);
      ctx.beginPath();
      ctx.arc(X, py, w * 1.5, 0, 7);
      ctx.fill();
      ctx.restore();
      g = ctx.createRadialGradient(X, Y + w * 0.02, 0, X, Y + w * 0.02, w * 0.75);
      g.addColorStop(0, `rgba(255,240,200,${0.85 * f})`);
      g.addColorStop(0.15, `rgba(255,214,140,${0.4 * f})`);
      g.addColorStop(1, "rgba(255,200,120,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(X, Y + w * 0.02, w * 0.75, 0, 7);
      ctx.fill();
    });
    ctx.restore();
  }

  /** The bar on the current canvas; as a street portal it has no camera, no glass in hand and no bubbles. */
  function drawBarWorld(t: number, portal = false) {
    ctx.save();
    if (!portal) {
      const sway = Math.max(wobble, drunk * 2);
      const wob = sway > 0 && !reduced ? Math.sin(t / 420) * sway * 0.03 : 0;
      ctx.translate(cw / 2 + shake.x, ch / 2 + shake.y);
      ctx.rotate(wob);
      const camS = 1 + camZ;
      ctx.scale(camS, camS);
      ctx.translate(-cw / 2, -ch / 2);
    }
    drawRoom(t);
    drawWall(t);
    for (const p of patrons) drawPatron(p, t);
    drawBarTop(t);
    drawCounterProps(t);
    if (portal) {
      ctx.restore();
      return;
    }
    drawBubbles(t);
    if (primaryGlass && barMode === "ready" && !ownDone && mode === "idle") {
      const r = restGlass();
      drawHalo(ctx, r.x, r.y, r.h * 1.1, t);
    }
    if (glassIn > 0.5) {
      ctx.save();
      ctx.translate(0, glassIn);
      rimNow = drawMine(t);
      ctx.restore();
    } else rimNow = drawMine(t);
    if (tier >= 5 && lift < 0.2) {
      const r = restGlass();
      drawCrown(ctx, r.x, r.y - r.h * 0.95, r.h * 0.22, t);
    }
    drawFocusRing(t);
    ctx.restore();
    const vg = ctx.createRadialGradient(
      cw / 2,
      ch * 0.55,
      Math.min(cw, ch) * 0.35,
      cw / 2,
      ch * 0.55,
      Math.hypot(Math.max(cw, fw * 0.7), ch) * 0.62
    );
    vg.addColorStop(0, "rgba(8,2,6,0)");
    vg.addColorStop(1, `rgba(8,2,6,${(0.55 * vgA).toFixed(3)})`);
    ctx.fillStyle = vg;
    ctx.fillRect(-ox, 0, fw, ch);
    drawTierWash(ctx, Math.max(0, tier), -ox, fw, ch, vgA);
  }

  // ---------- LC-024: the street ----------
  /** The live bar at the full view size (the long bar fills wide screens), for windows and the door. */
  function renderPortal(t: number) {
    const w = Math.ceil(fw * dpr);
    const h = Math.ceil(ch * dpr);
    if (!portalC || portalC.width !== w || portalC.height !== h) {
      portalC = document.createElement("canvas");
      portalC.width = w;
      portalC.height = h;
    }
    const main = ctx;
    ctx = portalC.getContext("2d") as Ctx;
    ctx.setTransform(dpr, 0, 0, dpr, dpr * ox, 0);
    drawBarWorld(t, true);
    ctx = main;
  }
  /**
   * The street; while entering, the doorway opens up to the whole view. The street falls back into the
   * dark, and the bar seen through the door grows from its doorway size to its own size: the street
   * itself barely zooms (user, 13 Nov).
   */
  function drawStreetFrame(t: number) {
    renderPortal(t);
    const portal = portalC as HTMLCanvasElement;
    ctx.fillStyle = "#07060d";
    ctx.fillRect(-ox, 0, fw, ch);
    const e = street.reveal;
    if (e <= 0) {
      streetArt.draw(ctx, t, cw, ch, dpr, portal, street, ox);
      return;
    }
    const w = Math.ceil(fw * dpr);
    const h = Math.ceil(ch * dpr);
    if (!streetFrameC || streetFrameC.width !== w || streetFrameC.height !== h) {
      streetFrameC = document.createElement("canvas");
      streetFrameC.width = w;
      streetFrameC.height = h;
    }
    const sx = streetFrameC.getContext("2d") as Ctx;
    sx.setTransform(dpr, 0, 0, dpr, dpr * ox, 0);
    sx.fillStyle = "#07060d";
    sx.fillRect(-ox, 0, fw, ch);
    streetArt.draw(sx, t, cw, ch, dpr, portal, street, ox);
    const D = doorRect(cw, ch, fw);
    const z = 1 + STREET_PUSH * street.zoom;
    const A = { x: D.x + D.w / 2, y: D.y + D.h / 2 };
    // the street falls back a touch into the dark around the opening
    const back = 1 + 0.06 * e;
    ctx.save();
    ctx.translate(A.x, A.y);
    ctx.scale(back, back);
    ctx.translate(-A.x, -A.y);
    ctx.drawImage(streetFrameC, -ox, 0, fw, ch);
    ctx.restore();
    ctx.fillStyle = `rgba(4,3,8,${(0.75 * e).toFixed(3)})`;
    ctx.fillRect(-ox, 0, fw, ch);
    // the doorway, pushed with the camera, grows to the whole view
    const door = { x: A.x - (D.w * z) / 2, y: A.y - (D.h * z) / 2, w: D.w * z, h: D.h * z };
    const m = {
      x: lerp(door.x, -ox, e),
      y: lerp(door.y, 0, e),
      w: lerp(door.w, fw, e),
      h: lerp(door.h, ch, e),
    };
    const radius = lerp(D.w * z * 0.05, 0, e);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(m.x, m.y, m.w, m.h, radius);
    ctx.clip();
    const k = lerp(D.cover * z, 1, e);
    ctx.translate(lerp(A.x, cw / 2, e), lerp(A.y, ch / 2, e));
    ctx.scale(k, k);
    ctx.translate(-cw / 2, -ch / 2);
    ctx.drawImage(portal, -ox, 0, fw, ch);
    ctx.restore();
    // warm light round the opening, fading as it reaches the edges
    if (e < 0.98) {
      ctx.save();
      ctx.strokeStyle = `rgba(255,214,150,${(0.85 * (1 - e)).toFixed(3)})`;
      ctx.shadowColor = "#ffb84a";
      ctx.shadowBlur = 36;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(m.x, m.y, m.w, m.h, radius);
      ctx.stroke();
      ctx.restore();
    }
  }
  function doorBell() {
    if (!audio || !sound) return;
    const t0 = audio.currentTime;
    [0, 0.17].forEach((d, j) => {
      [1, 2.4, 3.9].forEach((m, i) => {
        if (!audio) return;
        const o = audio.createOscillator();
        o.frequency.value = 1650 * m * (1 + j * 0.03);
        const g = audio.createGain();
        adsr(g.gain, t0 + d, 0.09 / (i + 1), 0.004, 0.01, 0.7 - i * 0.15);
        o.connect(g).connect(out(0));
        o.start(t0 + d);
        o.stop(t0 + d + 0.9);
      });
    });
  }
  function crowdSwell() {
    if (!audio || !sound) return;
    const t0 = audio.currentTime;
    const n = noiseSrc();
    const f = audio.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 650;
    f.Q.value = 0.8;
    const am = audio.createGain();
    am.gain.value = 0.6;
    lfo(5.3, 0.3, am.gain, t0, t0 + 3.3);
    lfo(2.2, 0.2, am.gain, t0, t0 + 3.3);
    const g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.2);
    n.connect(f).connect(am).connect(g).connect(out(0));
    n.start(t0, Math.random());
    n.stop(t0 + 3.3);
  }
  function placeClass() {
    root.classList.toggle("is-street", place === "street");
  }
  /** The door opens, the camera walks into the doorway, then settles at the bar: no cut. */
  function enterBar() {
    root.classList.add("is-entering");
    ensureAudio();
    doorBell();
    later(crowdSwell, 250);
    const arrive = () => {
      place = "bar";
      root.classList.remove("is-entering");
      placeClass();
      street.door = 0;
      street.zoom = 0;
      mode = "idle";
      tipText(idleTip());
      const hi = ["New face!", "Come in!", "Sit with us", "First time here?"];
      patrons.forEach((p, i) => {
        later(
          () => {
            p.face = "big";
            p.faceUntil = performance.now() + 1400;
            talk(p, at(hi, i), 1900);
          },
          600 + i * 260
        );
      });
      later(() => say("Welcome. Warm-up first: your pint is poured soon", "bartender"), 2000);
    };
    if (reduced) {
      arrive();
      options.onEntered?.();
      return;
    }
    gsap
      .timeline()
      .to(street, { door: 1, duration: 0.85, ease: "power2.out" })
      .to(street, { zoom: 1, duration: 1.7, ease: "sine.inOut" }, 0)
      .to(street, { reveal: 1, duration: 1.15, ease: "power3.inOut" }, 0.6)
      .call(() => {
        camZ = 0;
        vgA = 0;
        glassIn = ch * 0.35;
        arrive();
        street.reveal = 0;
        // the bar settles into its own light; the bartender slides the glass onto the counter
        const o = { v: 0 };
        gsap.to(o, {
          v: 1,
          duration: 0.8,
          ease: "sine.out",
          onUpdate: () => {
            vgA = o.v;
          },
        });
        const g = { y: glassIn };
        gsap.to(g, {
          y: 0,
          duration: 0.7,
          delay: 0.25,
          ease: "back.out(1.6)",
          onUpdate: () => {
            glassIn = g.y;
          },
          onComplete: () => thud(0.35, 0),
        });
        later(() => options.onEntered?.(), 1000);
      });
  }

  // ---------- LC-028: tier props, clock, goal rail, focus ----------
  /** The player glass at rest: centre and height, for the halo, the ghost hand and the focus ring. */
  function restGlass() {
    const h = 138 * (cw / 360);
    const by = ch * 0.93;
    return { x: coasterX >= 0 ? coasterX : hx * cw, y: by - h * 0.5, h };
  }
  const CLOCK = { x: 0.13, y: 0.145 };
  const JAR = { x: 0.12, h: 0.085 };
  function clockLeft(): number {
    if (!nightLen || !nightEnd) return 1;
    return Math.max(0, Math.min(1, (nightEnd - Date.now()) / nightLen));
  }
  function drawWall(t: number) {
    drawClock(ctx, cw * CLOCK.x, ch * CLOCK.y, Math.max(14, cw * 0.045), clockLeft(), riskK > 0.5, t);
    drawPlaque(ctx, cw * 0.84, ch * 0.15, cw * 0.24, playerName, tier, F_BODY);
  }
  function drawCounterProps(t: number) {
    drawJar(ctx, cw * JAR.x, ch * (BAR + 0.03), ch * JAR.h, F_BODY);
    drawGoalRail(ctx, goalRailBox(cw, ch, BAR), goalCount, goalN, t);
  }
  function drawFocusRing(t: number) {
    if (!focusOn) return;
    const k = (focusOn.until - t) / 2200;
    if (k <= 0) {
      focusOn = null;
      return;
    }
    const target = focusOn.target;
    const label = FOCUS_LABEL[target];
    if (target === "glass" || target === "streak") {
      const r = restGlass();
      drawFocus(ctx, r.x, r.y, r.h * 0.55, r.h * 0.7, label, k, t, F_BODY);
    } else if (target === "goal") {
      const b = goalRailBox(cw, ch, BAR);
      drawFocus(ctx, (b.x0 + b.x1) / 2, b.base - b.h / 2, (b.x1 - b.x0) * 0.56, b.h * 0.95, label, k, t, F_BODY);
    } else if (target === "pot") {
      const h = ch * JAR.h;
      drawFocus(ctx, cw * JAR.x, ch * (BAR + 0.03) - h / 2, h * 0.6, h * 0.75, label, k, t, F_BODY);
    } else {
      const r = Math.max(14, cw * 0.045);
      drawFocus(ctx, cw * CLOCK.x, ch * CLOCK.y, r * 1.5, r * 1.5, label, k, t, F_BODY);
    }
  }
  function updateGhost() {
    const ghost = options.elements.ghost;
    if (!ghost) return;
    const now = performance.now();
    const show =
      place === "bar" &&
      primaryGlass &&
      barMode === "ready" &&
      !ownDone &&
      mode === "idle" &&
      !held &&
      cw > 0 &&
      (!drankBefore || now - idleSince > 6000);
    if (show) {
      const r = restGlass();
      ghost.style.left = `${(ox + r.x).toFixed(1)}px`;
      ghost.style.top = `${(r.y + r.h * 0.15).toFixed(1)}px`;
      ghost.style.setProperty("--lift", `${(-ch * LIFT_TRAVEL).toFixed(1)}px`);
    }
    if (show !== ghostShown) {
      ghostShown = show;
      ghost.classList.toggle("is-on", show);
    }
  }

  // ---------- patrons drawing (effigy units: viewBox 184..1124 x 210..1340) ----------
  const NECK = { x: 660, y: 700 };
  const BARU = 1240;
  function faceKey(p: Patron, t: number): Face {
    if (p.d > 0.08) return "closed";
    if (p.face && t < p.faceUntil) return p.face;
    if (p.bubble && t < p.bubble.until) return Math.floor(t / 150) % 2 ? "shout" : "idle";
    if (t > p.blinkAt) {
      if (t > p.blinkAt + 130) p.blinkAt = t + 2500 + Math.random() * 3500;
      return "closed";
    }
    return "idle";
  }
  // ---------- fist + sleeve for the player's hand ----------
  // The fist is cut from the Open Peeps "Coffee" body (CC0); drawn mirrored, glass on the left, wrist on the right.
  const HVB = { x: 300, y: 300, w: 250, h: 280 };
  const GRIP = { x: 560, y: 445 };
  const CUFF = { x: 200, y: 32 };
  const CUFF_DIR = 0.44;
  const CUFF_W = 118;
  function drawFist(img: HTMLImageElement | null) {
    if (!img) return;
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(img, HVB.x - GRIP.x, HVB.y - GRIP.y, HVB.w, HVB.h);
    ctx.restore();
  }
  // a baggy sleeve from the cuff out of the screen; open at the far end so it merges into the shirt
  function sleeve(A: Pt, B: Pt, w0: number, w1: number, fill: string, lw: number) {
    const N = 24;
    const P: Pt[] = [];
    for (let i = 0; i <= N; i++) P.push({ x: lerp(A.x, B.x, i / N), y: lerp(A.y, B.y, i / N) });
    const n = norm(B.x - A.x, B.y - A.y);
    const L: Pt[] = [];
    const R: Pt[] = [];
    P.forEach((q, i) => {
      const k = i / N;
      const w = (lerp(w0, w1, k) / 2) * (1 + 0.06 * Math.sin(k * Math.PI));
      L.push({ x: q.x - n.y * w, y: q.y + n.x * w });
      R.push({ x: q.x + n.y * w, y: q.y - n.x * w });
    });
    ctx.beginPath();
    L.forEach((q, i) => {
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    });
    for (let i = R.length - 1; i >= 0; i--) ctx.lineTo((R[i] as Pt).x, (R[i] as Pt).y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const stop = Math.floor(P.length * 0.82);
    for (const side of [L, R]) {
      ctx.beginPath();
      for (let i = 0; i < stop; i++) {
        const q = side[i] as Pt;
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();
    }
    const l0 = L[0] as Pt;
    const r0 = R[0] as Pt;
    const p0 = P[0] as Pt;
    const p1 = P[1] as Pt;
    ctx.beginPath();
    ctx.moveTo(l0.x, l0.y);
    ctx.quadraticCurveTo(p0.x - (p1.x - p0.x) * 0.6, p0.y - (p1.y - p0.y) * 0.6, r0.x, r0.y);
    ctx.stroke();
    const l3 = L[3] as Pt;
    const r3 = R[3] as Pt;
    ctx.lineWidth = lw * 0.6;
    ctx.beginPath();
    ctx.moveTo(lerp(l3.x, r3.x, 0.12), lerp(l3.y, r3.y, 0.12));
    ctx.lineTo(lerp(l3.x, r3.x, 0.7), lerp(l3.y, r3.y, 0.7));
    ctx.stroke();
  }
  // A nonic pint in Open Peeps ink centred at (cx,cy): bulge under the rim, thick base, amber beer, a creamy head.
  const PH = 300;
  const PTOP = -PH / 2;
  const PBOT = PH / 2;
  const PBASE = 26;
  const PFOAM = 42;
  const FOAM = "#FFF4DC";
  function pintPath() {
    ctx.beginPath();
    ctx.moveTo(-92, PTOP);
    ctx.lineTo(92, PTOP);
    ctx.quadraticCurveTo(101, PTOP + 18, 101, PTOP + 46);
    ctx.quadraticCurveTo(101, PTOP + 68, 92, PTOP + 86);
    ctx.lineTo(74, PBOT - 16);
    ctx.quadraticCurveTo(74, PBOT, 58, PBOT);
    ctx.lineTo(-58, PBOT);
    ctx.quadraticCurveTo(-74, PBOT, -74, PBOT - 16);
    ctx.lineTo(-92, PTOP + 86);
    ctx.quadraticCurveTo(-101, PTOP + 68, -101, PTOP + 46);
    ctx.quadraticCurveTo(-101, PTOP + 18, -92, PTOP);
    ctx.closePath();
  }
  // foam puffs outlined in ink: all inks first, then all fills, so only the outer edge keeps a line
  function puffs(list: readonly (readonly [number, number, number])[], lw: number, fill: string) {
    ctx.fillStyle = INK;
    list.forEach(([x, y, r]) => {
      ctx.beginPath();
      ctx.arc(x, y, r + lw, 0, 7);
      ctx.fill();
    });
    ctx.fillStyle = fill;
    list.forEach(([x, y, r]) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 7);
      ctx.fill();
    });
  }
  function pint(cx: number, cy: number, v: number, worldTilt: number, t: number) {
    ctx.save();
    ctx.translate(cx, cy);
    pintPath();
    ctx.fillStyle = "rgba(255,244,228,0.5)";
    ctx.fill();
    ctx.save();
    pintPath();
    ctx.clip();
    ctx.fillStyle = "rgba(255,252,244,0.8)";
    ctx.fillRect(-120, PBOT - PBASE, 240, PBASE);
    ctx.rotate(-worldTilt);
    if (v > 0.01) {
      const lvl = PBOT - PBASE - v * (PH - PBASE - PFOAM + 4);
      const fh = PFOAM * (0.35 + 0.65 * v);
      const bg = ctx.createLinearGradient(0, lvl, 0, PBOT);
      bg.addColorStop(0, "#FFC85A");
      bg.addColorStop(0.45, "#F2A33A");
      bg.addColorStop(1, "#B9600F");
      ctx.fillStyle = bg;
      ctx.fillRect(-PH * 2, lvl, PH * 4, PH * 4);
      ctx.fillStyle = "rgba(140,62,6,0.28)";
      ctx.fillRect(50, lvl, PH * 4, PH * 4);
      ctx.fillStyle = "rgba(255,246,214,0.85)";
      const depth = Math.max(1, PBOT - PBASE - lvl);
      for (let i = 0; i < 11; i++) {
        const x = -62 + ((i * 47) % 124);
        const sp = 50 + ((i * 17) % 40);
        const y = PBOT - PBASE - (((t / 1000) * sp + i * 61) % depth);
        ctx.beginPath();
        ctx.arc(x + Math.sin(t / 260 + i) * 3, y, 2.5 + (i % 3) * 1.5, 0, 7);
        ctx.fill();
      }
      ctx.fillStyle = FOAM;
      ctx.beginPath();
      ctx.moveTo(-PH * 2, lvl - fh);
      ctx.lineTo(PH * 2, lvl - fh);
      ctx.lineTo(PH * 2, lvl);
      for (let x = PH; x >= -PH; x -= 12) ctx.lineTo(x, lvl + 3 + Math.sin(x * 0.11 + t / 400) * 4);
      ctx.lineTo(-PH * 2, lvl);
      ctx.fill();
      ctx.fillStyle = "rgba(214,180,128,0.55)";
      for (let i = 0; i < 12; i++) {
        ctx.beginPath();
        ctx.arc(-80 + i * 15, lvl - fh * (0.25 + ((i * 7) % 5) * 0.12), 2 + (i % 3), 0, 7);
        ctx.fill();
      }
    }
    ctx.restore();
    pintPath();
    ctx.lineWidth = 16;
    ctx.strokeStyle = INK;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(-66, PBOT - PBASE);
    ctx.quadraticCurveTo(0, PBOT - PBASE + 8, 66, PBOT - PBASE);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-80, PTOP + 30);
    ctx.quadraticCurveTo(-88, PTOP + 50, -78, PTOP + 86);
    ctx.lineTo(-62, PBOT - 40);
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(70, PTOP + 110);
    ctx.lineTo(60, PTOP + 170);
    ctx.stroke();
    // a full pint wears its head over the rim, with one blob running down the outside
    const k = clamp((v - 0.9) / 0.1, 0, 1);
    if (k > 0) {
      const P: [number, number, number][] = [];
      for (let i = 0; i <= 6; i++) {
        const u = i / 3 - 1;
        P.push([u * 84, PTOP - 4 - k * 24 * (1 - u * u), (17 + 9 * (1 - Math.abs(u))) * (0.6 + 0.4 * k)]);
      }
      P.push([96, PTOP + 12, 13 * k], [99, PTOP + 34, 10 * k], [98, PTOP + 52, 8 * k]);
      puffs(P, 8, FOAM);
      ctx.fillStyle = FOAM;
      ctx.fillRect(-84, PTOP - 6, 168, 26);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.ellipse(-30, PTOP - 14 - k * 14, 16, 7, -0.2, 0, 7);
      ctx.fill();
    }
    ctx.restore();
  }
  function drawPatron(p: Patron, t: number) {
    if (!p.bodyC) return;
    const px = p.x * cw;
    const by = ch * BAR;
    const breathe = reduced ? 0 : Math.sin(t / 800 + p.x * 9) * 5;
    ctx.save();
    ctx.translate(px, by);
    ctx.scale(p.flip * K, K);
    ctx.translate(-660, -BARU);
    // the bar hides everything below it
    ctx.beginPath();
    ctx.rect(0, 0, 2000, BARU + 12);
    ctx.clip();
    const hop = reduced ? 0 : -Math.abs(Math.sin(t / 140)) * 28 * p.c;
    ctx.translate(0, hop);
    ctx.drawImage(p.bodyC, 184 - PAD, 210 - PAD + breathe, 940 + PAD * 2, 1130 + PAD * 2);
    // head: tips back while chugging
    const a = ease(p.a);
    const c = ease(p.c);
    const d = p.d;
    const sway = reduced ? 0 : 0.06 * Math.sin(t / 300) * c + Math.sin(t / 1300 + p.x * 5) * 0.025;
    const tilt = -0.1 * a - 0.3 * d + sway;
    const fc = p.faceC[faceKey(p, t)] ?? p.faceC.idle;
    ctx.save();
    ctx.translate(NECK.x, NECK.y + breathe);
    ctx.rotate(tilt);
    ctx.translate(-NECK.x, -NECK.y - breathe);
    if (fc) ctx.drawImage(fc, 184 - PAD, 210 - PAD + breathe, 940 + PAD * 2, 1130 + PAD * 2);
    ctx.restore();
    // forearm + fist (the artist's own drawing) swung from the elbow under the bar; the pint sits in the fist
    if (p.armC) {
      const E0 = { x: ELBOW.x + CO.x, y: ELBOW.y + CO.y + breathe };
      let E = { x: lerp(E0.x, 300 + CO.x, a), y: lerp(E0.y, 662 + CO.y, a) };
      let th = lerp(0, -0.62, a) - 0.3 * d;
      E = { x: lerp(E.x, 170 + CO.x, c), y: lerp(E.y, 640 + CO.y, c) };
      th = lerp(th, -0.3, c);
      ctx.save();
      ctx.translate(E.x, E.y);
      ctx.rotate(th);
      ctx.translate(-E0.x, -E0.y);
      pint(GLASSC.x + CO.x, GLASSC.y + CO.y + breathe, p.vol, th, t);
      ctx.drawImage(p.armC, 184 - PAD, 210 - PAD + breathe, 940 + PAD * 2, 1130 + PAD * 2);
      ctx.restore();
    }
    ctx.restore();
    p.headScreen = { x: px, y: by + K * (260 - BARU) };
  }

  // ---------- my glass and hand ----------
  function glassPose() {
    const p = lift;
    const s = cw / 360;
    const tilt = ease((p - 0.3) / 0.7) * 1.05 + (mode === "drink" ? 0.35 * (1 - vol) : 0) + slosh * 0.04;
    const scale = (1 + 1.45 * p ** 1.4) * s;
    return { cx: lerp(hx * cw, cw / 2, ease(p)), by: ch * (0.93 - 0.3 * p), r: 40 * scale, h: 138 * scale, tilt };
  }
  type Pose = ReturnType<typeof glassPose>;
  function geom(g: Pose): { bot: Ellipse; rim: Ellipse } {
    const beta = 0.42;
    const ph = g.tilt;
    const near = 1 + 0.55 * Math.sin(Math.min(ph, 1.57));
    const bot = { cx: g.cx, cy: g.by, rx: g.r * 0.8, ry: g.r * 0.8 * Math.min(1, Math.sin(beta + ph * 0.6)) };
    const rr = g.r * near;
    return {
      bot,
      rim: {
        cx: g.cx,
        cy: g.by - g.h * Math.cos(ph) * 0.95 - g.h * 0.05,
        rx: rr,
        ry: rr * Math.min(1, Math.sin(beta + ph)),
      },
    };
  }
  function lerpE(a: Ellipse, b: Ellipse, t: number): Ellipse {
    return { cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t), rx: lerp(a.rx, b.rx, t), ry: lerp(a.ry, b.ry, t) };
  }
  // nonic profile: the ring at height s (0 = bottom, 1 = rim) swells a little just under the rim
  const bulge = (s: number) => 1 + 0.085 * Math.exp(-(((s - 0.82) / 0.075) ** 2));
  function ringAt(bot: Ellipse, rim: Ellipse, s: number): Ellipse {
    const e = lerpE(bot, rim, s);
    const k = bulge(s);
    e.rx *= k;
    e.ry *= k;
    return e;
  }
  function bodyPath(bot: Ellipse, rim: Ellipse, s0: number, s1: number) {
    const N = 24;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const e = ringAt(bot, rim, lerp(s1, s0, i / N));
      if (i) ctx.lineTo(e.cx - e.rx, e.cy);
      else ctx.moveTo(e.cx - e.rx, e.cy);
    }
    const a = ringAt(bot, rim, s0);
    ctx.ellipse(a.cx, a.cy, a.rx, a.ry, 0, Math.PI, 0, true);
    for (let i = 0; i <= N; i++) {
      const e = ringAt(bot, rim, lerp(s0, s1, i / N));
      ctx.lineTo(e.cx + e.rx, e.cy);
    }
    const b = ringAt(bot, rim, s1);
    ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI, true);
    ctx.closePath();
  }
  const DEW = Array.from({ length: 26 }, (_, i) => ({
    s: 0.12 + ((i * 0.618) % 1) * 0.78,
    u: ((i * 0.382 * 7) % 2) - 1,
    r: 0.8 + (i % 4) * 0.6,
  }));
  function fillLevel(g: Pose) {
    const c = Math.cos(Math.min(g.tilt, 1.5));
    return vol / Math.max(0.12, c * 0.85 + 0.15);
  }

  const SLEEVE = "#34406B";
  function drawMine(t: number): Ellipse {
    const g = glassPose();
    const { bot, rim } = geom(g);
    if (lift < 0.02 || coasterX < 0) coasterX = g.cx;
    {
      const cr = (cw / 360) * 40;
      const cy = ch * 0.935;
      ctx.save();
      ctx.lineWidth = Math.max(1.5, cr * 0.05);
      ctx.strokeStyle = INK;
      ctx.fillStyle = "#efe2c6";
      ctx.beginPath();
      ctx.ellipse(coasterX, cy, cr * 1.45, cr * 0.42, 0, 0, 7);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "#ff4fb8";
      ctx.lineWidth = Math.max(1.5, cr * 0.06);
      ctx.beginPath();
      ctx.ellipse(coasterX, cy, cr * 1.18, cr * 0.32, 0, 0, 7);
      ctx.stroke();
      ctx.fillStyle = "#c0392b";
      ctx.font = `900 ${Math.round(cr * 0.22)}px ${F_BODY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("LAST CALL", coasterX, cy + cr * 0.2);
      ctx.restore();
    }
    if (lift < 0.3) {
      ctx.fillStyle = `rgba(0,0,0,${0.4 * (1 - lift / 0.3)})`;
      ctx.beginPath();
      ctx.ellipse(g.cx + g.r * 0.2, ch * 0.93 + g.r * 0.25, g.r * 1.1, g.r * 0.3, 0, 0, 7);
      ctx.fill();
    }
    const mid = lerpE(bot, rim, 0.42);
    const u = mid.rx;
    // hand behind the glass: Open Peeps fist gripping the far side, sleeve out to the bottom-right corner
    {
      const hs = u / 80;
      const ox = mid.cx + u * 0.55;
      const oy = mid.cy;
      const cuffP = { x: ox + CUFF.x * hs, y: oy + CUFF.y * hs };
      const dir = CUFF_DIR + 0.5;
      sleeve(
        cuffP,
        { x: cuffP.x + Math.cos(dir) * u * 9, y: cuffP.y + Math.sin(dir) * u * 9 },
        CUFF_W * hs,
        CUFF_W * hs * 1.5,
        SLEEVE,
        12 * hs
      );
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(hs, hs);
      drawFist(myHand);
      ctx.restore();
    }
    const lw = Math.max(2, g.r * 0.05);
    const BASE = 0.075;
    const HEAD = 0.15;
    bodyPath(bot, rim, 0, 1);
    ctx.fillStyle = "rgba(255,240,220,0.14)";
    ctx.fill();
    const f = Math.min(1, fillLevel(g));
    let sTop = BASE;
    ctx.save();
    bodyPath(bot, rim, 0, 1);
    ctx.clip();
    bodyPath(bot, rim, 0, BASE);
    ctx.fillStyle = "rgba(255,250,240,0.4)";
    ctx.fill();
    if (vol > 0.005) {
      const sb = BASE + (1 - BASE - HEAD * 0.9) * f;
      const fh = HEAD * (0.3 + 0.7 * vol);
      sTop = Math.min(1, sb + fh);
      const lg = ctx.createLinearGradient(g.cx - g.r, 0, g.cx + g.r, 0);
      lg.addColorStop(0, "rgba(150,72,8,.94)");
      lg.addColorStop(0.3, "rgba(236,150,36,.92)");
      lg.addColorStop(0.58, "rgba(255,204,96,.92)");
      lg.addColorStop(1, "rgba(140,66,8,.94)");
      bodyPath(bot, rim, BASE, sb);
      ctx.fillStyle = lg;
      ctx.fill();
      ctx.fillStyle = "rgba(255,246,206,0.8)";
      bubbles.forEach((b) => {
        const e = ringAt(bot, rim, lerp(BASE, sb, b.t));
        ctx.beginPath();
        ctx.arc(e.cx + b.x * e.rx * 0.75, e.cy + e.ry * 0.5 * Math.sqrt(1 - b.x * b.x), (b.r * g.r) / 40, 0, 7);
        ctx.fill();
      });
      const fg = ctx.createLinearGradient(g.cx - g.r, 0, g.cx + g.r, 0);
      fg.addColorStop(0, "#e6cfa2");
      fg.addColorStop(0.45, "#fff8ea");
      fg.addColorStop(1, "#dcc294");
      bodyPath(bot, rim, sb, sTop);
      ctx.fillStyle = fg;
      ctx.fill();
      ctx.fillStyle = "rgba(205,170,115,0.5)";
      for (let i = 0; i < 18; i++) {
        const e = ringAt(bot, rim, lerp(sb, sTop, 0.15 + ((i * 37) % 10) / 12));
        const uu = ((i * 53) % 19) / 9.5 - 1;
        ctx.beginPath();
        ctx.arc(e.cx + uu * e.rx * 0.85, e.cy + e.ry * 0.7 * Math.sqrt(1 - uu * uu), g.r * 0.022 * (1 + (i % 3)), 0, 7);
        ctx.fill();
      }
      const top = ringAt(bot, rim, sTop);
      const wob = 1 + Math.sin(t / 120) * slosh * 0.04;
      ctx.fillStyle = "#fffaf0";
      ctx.beginPath();
      ctx.ellipse(top.cx, top.cy, top.rx, top.ry * wob, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = "rgba(232,212,170,0.7)";
      for (let i = 0; i < 7; i++) {
        const an = i * 0.9 + 1;
        const q = 0.25 + (i % 3) * 0.2;
        ctx.beginPath();
        ctx.arc(top.cx + Math.cos(an) * top.rx * q, top.cy + Math.sin(an) * top.ry * q * wob, g.r * 0.035, 0, 7);
        ctx.fill();
      }
    }
    // lacing: foam rings left on the glass where the beer used to be
    if (vol < 0.97 && barMode !== "warmup") {
      ctx.strokeStyle = "rgba(255,248,232,0.5)";
      ctx.lineWidth = Math.max(1.5, g.r * 0.035);
      ctx.lineCap = "round";
      [0.92, 0.8, 0.68, 0.56, 0.44, 0.32].forEach((s, j) => {
        if (s < sTop + 0.03) return;
        const e = ringAt(bot, rim, s);
        ctx.beginPath();
        for (let i = 0; i <= 20; i++) {
          const an = 0.15 + (i / 20) * (Math.PI - 0.3);
          const x = e.cx + Math.cos(an) * e.rx;
          const y = e.cy + Math.sin(an) * e.ry + Math.sin(an * 9 + j * 2) * g.r * 0.03;
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.stroke();
      });
    }
    // condensation on the cold part
    DEW.forEach((d) => {
      if (d.s > Math.max(sTop, BASE + 0.1)) return;
      const e = ringAt(bot, rim, d.s);
      const x = e.cx + d.u * e.rx * 0.95;
      const y = e.cy + e.ry * Math.sqrt(1 - d.u * d.u) * 0.95;
      const r = (d.r * g.r) / 40;
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 1.25, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.arc(x - r * 0.35, y - r * 0.4, r * 0.35, 0, 7);
      ctx.fill();
    });
    ctx.restore();
    // glass outline in ink: silhouette, front lip, base line, a faint inner rim
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK;
    ctx.lineJoin = "round";
    bodyPath(bot, rim, 0, 1);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(rim.cx, rim.cy, rim.rx, rim.ry, 0, 0, Math.PI);
    ctx.stroke();
    const bl = ringAt(bot, rim, BASE);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = lw * 0.7;
    ctx.beginPath();
    ctx.ellipse(bl.cx, bl.cy, bl.rx, bl.ry, 0, 0.2, Math.PI - 0.2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = lw * 0.6;
    ctx.beginPath();
    ctx.ellipse(rim.cx, rim.cy + rim.ry * 0.04, rim.rx * 0.93, rim.ry * 0.9, 0, 0, 7);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = Math.max(2, g.r * 0.06);
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const e = ringAt(bot, rim, lerp(0.94, 0.14, i / 16));
      const uu = -0.66;
      const x = e.cx + uu * e.rx;
      const y = e.cy + e.ry * Math.sqrt(1 - uu * uu);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = Math.max(1.5, g.r * 0.035);
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const e = ringAt(bot, rim, lerp(0.62, 0.3, i / 8));
      const uu = 0.72;
      const x = e.cx + uu * e.rx;
      const y = e.cy + e.ry * Math.sqrt(1 - uu * uu);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
    drawRimGlow(ctx, tier, rim, lw);
    drawGlassBadge(ctx, tier, ringAt(bot, rim, 0.42), g.r * 0.4, (playerName[0] ?? "?").toUpperCase(), F_BODY);
    drawCracks(ctx, bot, rim, cracked);
    // a full glass at rest wears its head over the rim, with a blob running down the front
    const k = clamp((vol - 0.9) / 0.1, 0, 1) * (1 - ease(g.tilt / 0.7));
    if (k > 0.01 && sTop >= 0.999) {
      const dh = g.r * 0.42 * k;
      const pr = rim.rx * 0.2;
      const P: [number, number, number][] = [];
      for (let i = 0; i < 12; i++) {
        const an = (i / 12) * Math.PI * 2;
        P.push([
          rim.cx + Math.cos(an) * rim.rx * 0.86,
          rim.cy + Math.sin(an) * rim.ry * 0.86 - dh * 0.35,
          pr * (0.85 + (0.3 * ((i * 5) % 3)) / 2),
        ]);
      }
      P.push(
        [rim.cx, rim.cy - dh * 0.7, rim.rx * 0.55],
        [rim.cx - rim.rx * 0.3, rim.cy - dh * 0.55, rim.rx * 0.38],
        [rim.cx + rim.rx * 0.32, rim.cy - dh * 0.5, rim.rx * 0.36]
      );
      const uu = -0.4;
      const sq = Math.sqrt(1 - uu * uu);
      for (const [s, r] of [
        [0.99, 0.8],
        [0.955, 0.68],
        [0.92, 0.58],
        [0.885, 0.5],
        [0.86, 0.46],
      ] as const) {
        const e = ringAt(bot, rim, s);
        P.push([e.cx + uu * e.rx, e.cy + e.ry * sq, pr * r * k]);
      }
      ctx.save();
      puffs(P, lw, "#fff6e6");
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.ellipse(rim.cx - rim.rx * 0.25, rim.cy - dh * 0.85, rim.rx * 0.22, rim.rx * 0.09, -0.2, 0, 7);
      ctx.fill();
      ctx.fillStyle = "rgba(214,184,132,0.45)";
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(
          rim.cx + (i - 2.5) * rim.rx * 0.28,
          rim.cy + rim.ry * 0.55 - dh * 0.2 + (i % 2) * pr * 0.3,
          pr * 0.18,
          0,
          7
        );
        ctx.fill();
      }
      ctx.restore();
    }
    return rim;
  }

  // ---------- screen beer ----------
  function drawFlood(t: number, rim: Ellipse | null) {
    if (flood <= 0.001 && drainY < 0) return;
    ctx.save();
    if (reduced) {
      // reduced motion: an amber veil that fades in and out instead of a spreading, draining flood
      ctx.fillStyle = `rgba(232,150,34,${0.55 * Math.min(1, flood)})`;
      ctx.fillRect(-ox, 0, fw, ch);
      ctx.restore();
      return;
    }
    if (drainY < 0 && rim) {
      const R = flood * Math.hypot(Math.max(cw, fw), ch) * 0.9 * SCREEN_FLOOD;
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const an = (i / 64) * Math.PI * 2;
        const n = 1 + 0.09 * Math.sin(an * 5 + t / 140) + 0.05 * Math.sin(an * 11 - t / 90);
        const x = rim.cx + Math.cos(an) * R * n;
        const y = rim.cy + Math.sin(an) * R * n * 1.05;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      const rg = ctx.createRadialGradient(rim.cx, rim.cy, 0, rim.cx, rim.cy, Math.max(1, R));
      rg.addColorStop(0, "rgba(255,214,120,0.92)");
      rg.addColorStop(0.7, "rgba(232,150,34,0.86)");
      rg.addColorStop(1, "rgba(150,80,10,0.9)");
      ctx.fillStyle = rg;
      ctx.fill();
      ctx.lineWidth = Math.max(6, R * 0.06);
      ctx.strokeStyle = "rgba(255,248,232,0.9)";
      ctx.stroke();
    } else if (drainY >= 0) {
      ctx.beginPath();
      ctx.moveTo(-ox, ch);
      for (let i = 0; i <= 40; i++) {
        const x = -ox + (i / 40) * fw;
        ctx.lineTo(x, drainY + Math.sin(i * 0.7 + t / 110) * 10 + Math.sin(i * 1.9 - t / 70) * 5);
      }
      ctx.lineTo(fw - ox, ch);
      ctx.closePath();
      const lg = ctx.createLinearGradient(0, drainY, 0, ch);
      lg.addColorStop(0, "rgba(255,214,120,0.9)");
      lg.addColorStop(1, "rgba(150,80,10,0.92)");
      ctx.fillStyle = lg;
      ctx.fill();
      ctx.lineWidth = 8;
      ctx.strokeStyle = "rgba(255,248,232,0.85)";
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,250,225,0.55)";
    for (let i = 0; i < 40; i++) {
      const x = -ox + ((i * 97.3) % 1) * fw;
      const y = ch - ((t / 12 + i * 53) % ch);
      if (drainY >= 0 && y < drainY) continue;
      ctx.beginPath();
      ctx.arc(x + Math.sin(t / 300 + i) * 4, y, 1.5 + (i % 4), 0, 7);
      ctx.fill();
    }
    ctx.restore();
  }
  function drawDrops() {
    drops.forEach((d) => {
      ctx.strokeStyle = `rgba(255,210,130,${0.25 * d.a})`;
      ctx.lineWidth = d.r * 0.9;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(d.x, d.y0);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
      const rg = ctx.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, 0, d.x, d.y, d.r * 1.2);
      rg.addColorStop(0, `rgba(255,255,255,${0.9 * d.a})`);
      rg.addColorStop(0.35, `rgba(255,205,110,${0.55 * d.a})`);
      rg.addColorStop(1, `rgba(160,90,20,${0.25 * d.a})`);
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.r, d.r * 1.25, 0, 0, 7);
      ctx.fill();
    });
  }

  // ---------- speech bubbles and labels ----------
  function talk(p: Patron, text: string, ms = 2600) {
    const now = performance.now();
    p.bubble = { text, until: now + ms, born: now };
  }
  function drawBubbles(t: number) {
    ctx.font = `700 12px ${F_BODY}`;
    ctx.textBaseline = "middle";
    const order = patrons.filter((p) => p.bubble && t < p.bubble.until && p.headScreen);
    order.forEach((p, i) => {
      const bubble = p.bubble as NonNullable<Patron["bubble"]>;
      const head = p.headScreen as Pt;
      const words = bubble.text.split(" ");
      const maxW = cw * 0.34;
      const lines = [""];
      for (const w of words) {
        const last = lines[lines.length - 1] as string;
        const tr = `${last} ${w}`.trim();
        if (ctx.measureText(tr).width > maxW && last) lines.push(w);
        else lines[lines.length - 1] = tr;
      }
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18;
      const h = lines.length * 15 + 12;
      const bx = head.x;
      const hy = head.y - (i % 2) * 6;
      const x = clamp(bx - w / 2, 6, cw - w - 6);
      const y = hy - h - 14;
      const pop = reduced ? 1 : Math.min(1, (t - bubble.born) / 120);
      ctx.save();
      ctx.globalAlpha = Math.min(1, (bubble.until - t) / 250);
      ctx.translate(bx, y + h);
      ctx.scale(0.8 + 0.2 * Math.max(0, pop), 0.8 + 0.2 * Math.max(0, pop));
      ctx.translate(-bx, -(y + h));
      ctx.fillStyle = "#fff8ee";
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 10);
      ctx.moveTo(bx - 6, y + h);
      ctx.lineTo(bx, y + h + 9);
      ctx.lineTo(bx + 6, y + h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff8ee";
      ctx.fillRect(bx - 5, y + h - 2, 10, 3);
      ctx.fillStyle = INK;
      ctx.textAlign = "center";
      lines.forEach((l, j) => {
        ctx.fillText(l, x + w / 2, y + 12 + j * 15);
      });
      ctx.restore();
    });
    labels.forEach((l) => {
      ctx.globalAlpha = l.a;
      ctx.fillStyle = "#ffe0f2";
      ctx.font = `700 12px ${F_MONO}`;
      ctx.textAlign = "center";
      ctx.shadowColor = "#ff4fb8";
      ctx.shadowBlur = 8;
      ctx.fillText(l.text, l.x, l.y);
      ctx.shadowBlur = 0;
    });
    ctx.globalAlpha = 1;
  }

  // ---------- loop ----------
  let last = performance.now();
  let rimNow: Ellipse | null = null;
  let raf = 0;
  function frame(t: number) {
    if (destroyed) return;
    const dt = Math.min(0.033, (t - last) / 1000);
    last = t;
    lift += (liftTarget - lift) * Math.min(1, dt * 14);
    hx += (hxTarget - hx) * Math.min(1, dt * 12);
    const lv = (lift - lastLift) / Math.max(dt, 0.001);
    lastLift = lift;
    if (!reduced) {
      sloshV += (-slosh * 60 - sloshV * 6 + lv * 4) * dt;
      slosh += sloshV * dt;
    }
    if (mode === "hold" && held && lift > 0.96) {
      mode = "drink";
      gulpT = 0;
      tipText("hold… hold…");
      crowdCheer();
    }
    if (mode === "drink") {
      vol = Math.max(0, vol - dt / GULP_S);
      flood = Math.min(1, flood + (dt / GULP_S) * 1.25);
      gulpT -= dt;
      if (gulpT <= 0) {
        gulp(0.35, 0);
        gulpT = 0.32;
        buzz(15);
      }
      if (vol <= 0) finishDrink();
    }
    if (mode === "hold" && !held && lift < 0.02 && flood <= 0.001) mode = "idle";
    // queued check-ins of other accounts: one patron at a time, a beat apart
    if (queue.length && mode !== "drink" && mode !== "drain" && t > nextPatron) {
      const free = patrons.filter((p) => !p.busy);
      if (free.length) {
        otherDrinks(pick(free), queue.shift() as string);
        nextPatron = t + 450;
      }
    }
    if (t > nextChat && mode === "idle" && chat.length) {
      nextChat = t + 3500 + Math.random() * 3500;
      const free = patrons.filter((p) => !p.busy && !(p.bubble && t < p.bubble.until));
      if (free.length) talk(pick(free), pick(chat));
    }
    if (mode === "idle" && t - lastHint > 22000 && hints.length) {
      lastHint = t;
      say(pick(hints), "bartender");
    }
    bubbles.forEach((b) => {
      b.t += dt * b.v;
      if (b.t > 0.95) {
        b.t = 0.02;
        b.x = Math.random() * 2 - 1;
      }
    });
    drops.forEach((d) => {
      d.y += d.vy * dt;
      d.vy = Math.max(4, d.vy * 0.96 + (Math.random() < 0.02 ? 40 : 0));
      if (d.y - d.y0 > ch * 0.35) d.y0 += d.vy * dt;
      d.a -= dt * 0.12;
    });
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i] as (typeof drops)[number];
      if (d.a <= 0 || d.y > ch + 20) drops.splice(i, 1);
    }
    if (cw > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, dpr * ox, 0);
      if (place === "street") {
        drawStreetFrame(t);
        if (lastFilter !== "") {
          lastFilter = "";
          cv.style.filter = "";
        }
        raf = requestAnimationFrame(frame);
        return;
      }
      drawBarWorld(t);
      drawFlood(t, rimNow);
      drawDrops();
      if (confetti.length) stepConfetti(ctx, confetti, ch, dt, Math.max(6, cw / 45));
      const risk = tier > 0 && !ownDone && barMode === "ready" && nightLen > 0 && clockLeft() < 0.15 && clockLeft() > 0;
      riskK += ((risk ? 1 : 0) - riskK) * Math.min(1, dt * 3);
      if (risk !== riskOn) {
        riskOn = risk;
        if (mode === "idle") tipText(idleTip());
      }
      const filter = gradeFilter(
        Math.max(0, tier),
        reduced ? 0 : riskK,
        wobble > 0 && !reduced ? wobble * 0.4 : 0,
        t,
        vgA
      );
      if (filter !== lastFilter) {
        lastFilter = filter;
        cv.style.filter = filter;
      }
      updateGhost();
    }
    raf = requestAnimationFrame(frame);
  }

  // ---------- crowd ----------
  function crowdCheer() {
    patrons.forEach((p, i) => {
      if (p.busy) return;
      later(() => {
        if (mode === "drink") talk(p, pick(LINES.cheer), 1400);
      }, i * 220);
      later(
        () => {
          if (mode === "drink") talk(p, pick(LINES.cheer), 1200);
        },
        900 + i * 200
      );
    });
  }
  function freePatron(): Patron | undefined {
    const free = patrons.filter((q) => !q.busy);
    return free.length ? pick(free) : undefined;
  }
  function crowdPraise() {
    const p = freePatron();
    if (!p) return;
    talk(p, pick(LINES.praise), 2200);
    p.face = "lol";
    p.faceUntil = performance.now() + 1500;
  }
  function crowdGroan() {
    patrons.forEach((p) => {
      if (!p.busy) {
        p.face = "worried";
        p.faceUntil = performance.now() + 1400;
      }
    });
    talk(pick(patrons), pick(LINES.groan), 1600);
  }

  /** The crowd answers the player own check-in louder as the tier grows (LC-028). */
  function raiseGlasses(lines: readonly string[]) {
    patrons.forEach((p, i) => {
      later(
        () => {
          if (p.busy) return;
          p.busy = true;
          p.face = "big";
          p.faceUntil = performance.now() + 1400;
          talk(p, at(lines, i), 1500);
          if (reduced) {
            later(() => {
              p.busy = false;
            }, 900);
            return;
          }
          gsap
            .timeline()
            .to(p, { c: 1, duration: 0.3, ease: "back.out(2)" })
            .call(() => clink(0.4, pan(p)))
            .to(p, {
              c: 0,
              duration: 0.35,
              delay: 0.5,
              onComplete: () => {
                p.busy = false;
              },
            });
        },
        250 + i * 120
      );
    });
  }
  function tierCheer() {
    if (tier >= 3) raiseGlasses(LINES.chorus);
    else if (tier >= 2) raiseGlasses(LINES.toasts);
    if (tier >= 4 && !reduced) burstConfetti(confetti, cw, ch, 70);
  }

  // ---------- my drink ----------
  function finishDrink() {
    mode = "drain";
    if (reduced) {
      const o = { f: flood };
      gsap.to(o, {
        f: 0,
        duration: 0.3,
        onUpdate: () => {
          flood = o.f;
        },
        onComplete: afterDrain,
      });
      return;
    }
    for (let i = 0; i < 18; i++) {
      const y = Math.random() * ch * 0.5;
      drops.push({ x: Math.random() * cw, y, y0: y, vy: 10 + Math.random() * 30, r: 3 + Math.random() * 7, a: 1 });
    }
    const st = { y: -20 };
    drainY = 0;
    gsap.to(st, {
      y: ch + 30,
      duration: DRAIN_S,
      ease: "power2.in",
      onUpdate: () => {
        drainY = st.y;
        if (Math.random() < 0.25)
          drops.push({
            x: Math.random() * cw,
            y: st.y,
            y0: st.y,
            vy: 8 + Math.random() * 20,
            r: 2 + Math.random() * 6,
            a: 1,
          });
      },
      onComplete: () => {
        drainY = -1;
        flood = 0;
        afterDrain();
      },
    });
  }
  /** The glass is empty. In `ready` mode it waits for the chain before it lands. */
  function afterDrain() {
    if (barMode === "ready" && !ownDone) {
      mode = "wait";
      held = false;
      liftTarget = 0.3;
      tipText("bartender is writing it down…");
      say("Writing it down…", "bartender");
      options.onFullDrink();
      return;
    }
    if (barMode === "done-today" || ownDone) {
      slam(null, null);
      return;
    }
    // the mode changed mid-drink (warm-up, backlog): nothing is sent, nothing counted
    mode = "wait";
    api.checkInFailed(refuseLine() ?? "Not counted");
  }
  /** The glass lands with a bang: after a confirmed check-in (`outcome`) or an extra one on the house. */
  function slam(outcome: CheckInOutcome | null, lineText: string | null) {
    mode = "lower";
    held = false;
    const s = { l: lift };
    gsap.to(s, {
      l: 0,
      duration: reduced ? 0.15 : 0.28,
      ease: "power3.in",
      onUpdate: () => {
        lift = liftTarget = s.l;
      },
      onComplete: () => {
        thud(0.6, 0);
        buzz(40);
        if (!reduced) {
          gsap.fromTo(
            shake,
            { x: 0, y: 0 },
            {
              keyframes: [
                { x: -7, y: 5, duration: 0.05 },
                { x: 6, y: -4, duration: 0.05 },
                { x: -3, y: 2, duration: 0.05 },
                { x: 0, y: 0, duration: 0.08 },
              ],
            }
          );
        }
        gsap.fromTo(
          bangEl,
          { opacity: 0, scale: reduced ? 1 : 0.6 },
          {
            opacity: 1,
            scale: 1,
            duration: 0.18,
            ease: "back.out(3)",
            onComplete: () => {
              gsap.to(bangEl, { opacity: 0, duration: 0.4, delay: 0.35 });
            },
          }
        );
        if (outcome) {
          ownDone = true;
          bodyAfterMine();
          say(lineText ?? "Bottoms up! Counted", undefined, "good");
          if (outcome.n === outcome.goal) goalReached();
          crowdPraise();
          cracked = 0;
          drankBefore = true;
          try {
            localStorage.setItem(DRANK_KEY, "1");
          } catch {}
          tierCheer();
        } else {
          extraDrinks++;
          if (Math.random() < 0.5) bodyAfterMine();
          if (!reduced) wobble = Math.min(6, wobble + 1.5);
          say(at(LINES.extra, Math.min(LINES.extra.length - 1, extraDrinks - 1)), "bartender");
          talk(pick(patrons), pick(LINES.enough), 2000);
        }
        later(() => {
          vol = 1;
          mode = "idle";
          tipText(idleTip());
          pour(0);
        }, 900);
      },
    });
  }

  // ---------- patrons drinking ----------
  function pan(p: Patron) {
    return (p.x - 0.5) * 1.6;
  }
  function otherDrinks(p: Patron, label: string) {
    p.busy = true;
    p.bubble = null;
    const done = () => {
      thud(0.25, pan(p));
      if (bodyOn && Math.random() < 0.5) later(() => burp(0.1, pan(p)), 450);
      p.face = "lol";
      p.faceUntil = performance.now() + 1300;
      const l = { text: label, x: clamp(p.x * cw, 80, cw - 80), y: ch * BAR - ch * 0.29, a: 1 };
      labels.push(l);
      gsap.to(l, {
        y: l.y - (reduced ? 0 : 26),
        a: 0,
        duration: 2.2,
        delay: 0.4,
        onComplete: () => {
          labels.splice(labels.indexOf(l), 1);
        },
      });
      later(() => talk(p, pick(LINES.after), 2000), 500);
      later(() => {
        p.vol = 1;
        p.busy = false;
        pour(pan(p));
      }, 2500);
    };
    const neighbours = patrons.filter((q) => q !== p && !q.busy);
    if (neighbours.length) talk(pick(neighbours), pick(cheerFor(label.replace(/^\+\d+\s*/, "") || "fren")), 1400);
    if (reduced) {
      // a short fade of the patron's beer instead of the lift-and-chug timeline
      gsap.to(p, { vol: 0, duration: 0.4, onComplete: done });
      return;
    }
    gsap
      .timeline()
      .to(p, { a: 1, duration: 0.55, ease: "power2.out" })
      .to(p, {
        d: 1,
        vol: 0,
        duration: 1.1,
        ease: "sine.inOut",
        onStart: () => {
          for (let i = 0; i < 3; i++) later(() => gulp(0.12, pan(p)), i * 330);
        },
      })
      .to(p, { a: 0, d: 0, duration: 0.25, ease: "power3.in", onComplete: done });
  }
  function goalReached() {
    if (bellRungToday) return;
    bellRungToday = true;
    later(() => bellRing(1), 200);
    if (!reduced) {
      gsap.fromTo(
        bellEl,
        { rotate: 0 },
        {
          keyframes: [
            { rotate: 28, duration: 0.15 },
            { rotate: -24, duration: 0.2 },
            { rotate: 16, duration: 0.2 },
            { rotate: -10, duration: 0.2 },
            { rotate: 0, duration: 0.3 },
          ],
          delay: 0.2,
        }
      );
      gsap.fromTo(
        signEl,
        { filter: "brightness(1)" },
        { filter: "brightness(1.8)", yoyo: true, repeat: 5, duration: 0.12, delay: 0.2 }
      );
    }
    later(() => say(pick(LINES.goal), undefined, "good"), 300);
    patrons.forEach((p, i) => {
      later(
        () => {
          if (p.busy) return;
          p.busy = true;
          p.face = "big";
          p.faceUntil = performance.now() + 1600;
          talk(p, at(LINES.toasts, i), 1800);
          if (reduced) {
            clink(0.6, pan(p));
            later(() => {
              p.busy = false;
            }, 1100);
            return;
          }
          gsap
            .timeline()
            .to(p, { c: 1, duration: 0.35, ease: "back.out(2)" })
            .call(() => clink(0.6, pan(p)))
            .to(p, {
              c: 0,
              duration: 0.4,
              delay: 0.7,
              onComplete: () => {
                p.busy = false;
              },
            });
        },
        350 + i * 140
      );
    });
  }

  // ---------- input ----------
  function refuseLine(): string | null {
    if (barMode === "warmup") return "Warm-up: your pint gets poured on your activation day";
    if (barMode === "backlog") return "Settle the old days first, then I pour";
    return null;
  }
  function local(e: PointerEvent): Pt {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left - ox, y: e.clientY - r.top };
  }
  function onPointerDown(e: PointerEvent) {
    ensureAudio();
    idleSince = performance.now();
    if (place !== "bar" || mode !== "idle") return;
    const refuse = refuseLine();
    if (refuse) {
      say(refuse, "bartender", "warn");
      return;
    }
    const p = local(e);
    if (p.y < ch * 0.45) return;
    root.setPointerCapture(e.pointerId);
    startY = p.y;
    held = true;
    mode = "hold";
    hxTarget = clamp(p.x / cw, 0.3, 0.7);
  }
  function onPointerMove(e: PointerEvent) {
    if (!held) return;
    const p = local(e);
    hxTarget = clamp(p.x / cw, 0.3, 0.7);
    if (mode === "hold") liftTarget = clamp((startY - p.y) / (ch * LIFT_TRAVEL), 0, 1);
  }
  function letGo() {
    if (!held) return;
    held = false;
    if (mode === "hold") {
      liftTarget = 0;
      if (lift > 0.5) {
        say(pick(LINES.notMouth), undefined, "warn");
        crowdGroan();
      }
    } else if (mode === "drink") {
      mode = "hold";
      liftTarget = 0;
      say(pick(LINES.notFinished), undefined, "warn");
      crowdGroan();
      const o = { f: flood };
      gsap.to(o, {
        f: 0,
        duration: reduced ? 0.25 : 0.6,
        onUpdate: () => {
          flood = o.f;
        },
      });
      later(() => {
        vol = 1;
        pour(0);
        tipText("refilled. try bottoms up");
      }, 700);
    }
  }
  let kRaf = 0;
  function onKeyDown(e: KeyboardEvent) {
    if (e.target !== root || e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    ensureAudio();
    idleSince = performance.now();
    if (place !== "bar" || mode !== "idle") return;
    const refuse = refuseLine();
    if (refuse) {
      say(refuse, "bartender", "warn");
      return;
    }
    mode = "hold";
    held = true;
    const step = () => {
      if (!held || destroyed) return;
      if (mode === "hold") liftTarget = Math.min(1, liftTarget + 0.03);
      kRaf = requestAnimationFrame(step);
    };
    step();
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.target !== root || e.key !== " ") return;
    cancelAnimationFrame(kRaf);
    letGo();
  }
  const stop = (e: Event) => e.stopPropagation();
  function onBell() {
    ensureAudio();
    bellRing(0.5);
    bellPokes++;
    if (!reduced)
      gsap.fromTo(
        bellEl,
        { rotate: 0 },
        {
          keyframes: [
            { rotate: 18, duration: 0.12 },
            { rotate: -12, duration: 0.15 },
            { rotate: 0, duration: 0.2 },
          ],
        }
      );
    say(at(LINES.bell, Math.min(LINES.bell.length - 1, bellPokes - 1)), "bartender");
    patrons.forEach((p) => {
      p.face = "shout";
      p.faceUntil = performance.now() + 500;
    });
  }

  // ---------- sound ----------
  function ensureAudio() {
    if (!sound || audio) return;
    try {
      audio = new AudioContext();
    } catch {
      audio = null;
    }
    if (audio) loadSfx();
  }
  function out(v: number): AudioNode {
    const a = audio as AudioContext;
    const p = a.createStereoPanner();
    p.pan.value = clamp(v, -1, 1);
    p.connect(a.destination);
    return p;
  }
  function env(node: AudioScheduledSourceNode, gain: number, dur: number, pv: number) {
    const a = audio as AudioContext;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(gain, a.currentTime + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    node.connect(g).connect(out(pv));
  }
  // real recordings from Wikimedia Commons (CC BY-SA, credited in the README), trimmed and peak-normalised
  const SFXBUF: Record<SfxKind, AudioBuffer[]> = { burp: [], fart: [] };
  const lastPick: Partial<Record<SfxKind, number>> = {};
  let sfxLoading = false;
  function loadSfx() {
    if (sfxLoading || !audio) return;
    sfxLoading = true;
    const a = audio;
    for (const kind of Object.keys(SFX_COUNT) as SfxKind[]) {
      for (let i = 0; i < SFX_COUNT[kind]; i++) {
        fetch(`${base}/sfx/${kind}-${i}.mp3`)
          .then((r) => r.arrayBuffer())
          .then((b) => a.decodeAudioData(b))
          .then((buf) => {
            SFXBUF[kind].push(buf);
          })
          .catch(() => {});
      }
    }
  }
  function playSfx(kind: SfxKind, v: number, pv: number): boolean {
    const a = audio as AudioContext;
    const list = SFXBUF[kind];
    if (!list.length) return false;
    let i: number;
    do i = (Math.random() * list.length) | 0;
    while (list.length > 1 && i === lastPick[kind]);
    lastPick[kind] = i;
    const s = a.createBufferSource();
    s.buffer = list[i] ?? null;
    s.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = a.createGain();
    g.gain.value = v;
    s.connect(g).connect(out(pv));
    s.start();
    return true;
  }
  function burp(v: number, pv: number) {
    if (!audio || !sound) return;
    if (!playSfx("burp", v * 3.2, pv)) burpSynth(v, pv);
  }
  function fart(v: number, pv: number) {
    if (!audio || !sound) return;
    if (!playSfx("fart", v * 2.6, pv)) fartSynth(v, pv);
  }
  let NB: AudioBuffer | null = null;
  function noiseSrc(): AudioBufferSourceNode {
    const a = audio as AudioContext;
    if (!NB) {
      NB = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
      const d = NB.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const n = a.createBufferSource();
    n.buffer = NB;
    n.loop = true;
    return n;
  }
  function adsr(param: AudioParam, t: number, peak: number, a: number, hold: number, rel: number) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + a);
    param.setValueAtTime(peak, t + a + hold);
    param.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  }
  function lfo(freq: number, depth: number, target: AudioParam, t: number, end: number, type: OscillatorType = "sine") {
    const a = audio as AudioContext;
    const o = a.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = a.createGain();
    g.gain.value = depth;
    o.connect(g).connect(target);
    o.start(t);
    o.stop(end);
    return o;
  }
  // cartoon swallow "glk": a wet click, the throat blob jumps up in pitch and drops, then a low thump
  function gulp(v: number, pv: number) {
    if (!audio || !sound) return;
    const a = audio;
    const t = a.currentTime;
    const k = 0.85 + Math.random() * 0.3;
    const o = out(pv);
    const s = a.createOscillator();
    s.frequency.setValueAtTime(160 * k, t);
    s.frequency.exponentialRampToValueAtTime(560 * k, t + 0.06);
    s.frequency.exponentialRampToValueAtTime(140 * k, t + 0.17);
    const g = a.createGain();
    adsr(g.gain, t, v, 0.012, 0.05, 0.12);
    s.connect(g).connect(o);
    s.start(t);
    s.stop(t + 0.22);
    const n = noiseSrc();
    const f = a.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(900 * k, t);
    f.frequency.exponentialRampToValueAtTime(2600 * k, t + 0.04);
    f.Q.value = 8;
    const gn = a.createGain();
    adsr(gn.gain, t, v * 1.2, 0.004, 0.01, 0.05);
    n.connect(f).connect(gn).connect(o);
    n.start(t, Math.random());
    n.stop(t + 0.08);
    const d = a.createOscillator();
    d.frequency.setValueAtTime(110, t + 0.08);
    d.frequency.exponentialRampToValueAtTime(55, t + 0.2);
    const gd = a.createGain();
    gd.gain.setValueAtTime(0.0001, t);
    adsr(gd.gain, t + 0.08, v * 0.8, 0.01, 0.02, 0.12);
    d.connect(gd).connect(o);
    d.start(t);
    d.stop(t + 0.26);
  }
  // fallback when the recordings did not load: a rattly voiced buzz through "oa" mouth formants
  function burpSynth(v: number, pv: number) {
    const a = audio as AudioContext;
    const t = a.currentTime;
    const k = 0.85 + Math.random() * 0.3;
    const dur = 0.32 + Math.random() * 0.2;
    const end = t + dur + 0.1;
    const o = out(pv);
    const src = a.createOscillator();
    src.type = "sawtooth";
    src.frequency.setValueAtTime(70 * k, t);
    src.frequency.linearRampToValueAtTime(105 * k, t + 0.05);
    src.frequency.linearRampToValueAtTime(88 * k, t + dur * 0.7);
    src.frequency.exponentialRampToValueAtTime(55 * k, t + dur);
    lfo(31 + Math.random() * 8, 16 * k, src.frequency, t, end, "square");
    const rough = a.createGain();
    rough.gain.value = 0.7;
    lfo(23, 0.3, rough.gain, t, end);
    const amp = a.createGain();
    adsr(amp.gain, t, v, 0.03, dur * 0.55, dur * 0.45);
    for (const [gn, fq, q] of [
      [1, 520, 6],
      [0.6, 1050, 8],
      [0.25, 2400, 10],
    ] as const) {
      const b = a.createBiquadFilter();
      b.type = "bandpass";
      b.frequency.setValueAtTime(fq * 0.7 * k, t);
      b.frequency.linearRampToValueAtTime(fq * k, t + 0.08);
      b.frequency.linearRampToValueAtTime(fq * 0.8 * k, t + dur);
      b.Q.value = q;
      const g = a.createGain();
      g.gain.value = gn * 3;
      rough.connect(b).connect(g).connect(amp);
    }
    src.connect(rough);
    amp.connect(o);
    src.start(t);
    src.stop(end);
  }
  // fallback "prrt": a low buzz flapping on and off, muffled, with a squeaky rising tail
  function fartSynth(v: number, pv: number) {
    const a = audio as AudioContext;
    const t = a.currentTime;
    const dur = 0.55 + Math.random() * 0.35;
    const end = t + dur + 0.1;
    const o = out(pv);
    const b0 = 62 + Math.random() * 30;
    const src = a.createOscillator();
    src.type = "sawtooth";
    src.frequency.setValueAtTime(b0 * 1.3, t);
    src.frequency.linearRampToValueAtTime(b0, t + 0.08);
    src.frequency.linearRampToValueAtTime(b0 * 0.85, t + dur * 0.7);
    src.frequency.exponentialRampToValueAtTime(b0 * 1.9, t + dur);
    lfo(5 + Math.random() * 4, b0 * 0.18, src.frequency, t, end);
    lfo(13, b0 * 0.08, src.frequency, t, end, "triangle");
    const flap = a.createGain();
    flap.gain.value = 0.55;
    const fl = lfo(24 + Math.random() * 10, 0.45, flap.gain, t, end, "square");
    fl.frequency.linearRampToValueAtTime(42, t + dur);
    const lp = a.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.linearRampToValueAtTime(760, t + dur);
    lp.Q.value = 4;
    const amp = a.createGain();
    adsr(amp.gain, t, v, 0.02, dur * 0.6, dur * 0.4);
    src.connect(flap).connect(lp).connect(amp).connect(o);
    src.start(t);
    src.stop(end);
    const n = noiseSrc();
    const nf = a.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = 300;
    const ng = a.createGain();
    adsr(ng.gain, t, v * 0.5, 0.02, dur * 0.5, dur * 0.4);
    n.connect(nf).connect(ng).connect(o);
    n.start(t, Math.random());
    n.stop(end);
  }
  // after the player's own drink: a light burp every time, a fart every second time
  function bodyAfterMine() {
    if (!bodyOn) return;
    bodyN++;
    later(() => {
      burp(0.24, 0);
      if (Math.random() < 0.4) {
        const p = freePatron();
        if (p) talk(p, pick(LINES.bless), 1600);
      }
    }, 450);
    if (bodyN % 2 === 0)
      later(() => {
        fart(0.34, 0);
        buzz(120);
        patrons.forEach((p) => {
          if (!p.busy) {
            p.face = "worried";
            p.faceUntil = performance.now() + 1800;
          }
        });
        const p = freePatron();
        if (p) talk(p, pick(LINES.fart), 2200);
      }, 1300);
  }
  function thud(v: number, pv: number) {
    if (!audio || !sound) return;
    const a = audio;
    const o = a.createOscillator();
    o.frequency.setValueAtTime(120, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(45, a.currentTime + 0.2);
    env(o, v, 0.3, pv);
    o.start();
    o.stop(a.currentTime + 0.32);
    const o2 = a.createOscillator();
    o2.frequency.value = 2900;
    env(o2, v * 0.1, 0.25, pv);
    o2.start();
    o2.stop(a.currentTime + 0.26);
  }
  function clink(k: number, pv: number) {
    if (!audio || !sound) return;
    const a = audio;
    const f = 2400 + Math.random() * 500;
    [1, 1.51].forEach((m, i) => {
      const o = a.createOscillator();
      o.frequency.value = f * m;
      env(o, (0.08 + k * 0.1) / (i + 1), 0.4, pv);
      o.start();
      o.stop(a.currentTime + 0.42);
    });
  }
  function pour(pv: number) {
    if (!audio || !sound) return;
    const a = audio;
    const n = a.createBufferSource();
    const b = a.createBuffer(1, a.sampleRate * 0.9, a.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / d.length);
    n.buffer = b;
    const f = a.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1400;
    f.Q.value = 0.8;
    const g = a.createGain();
    g.gain.value = 0.05;
    n.connect(f).connect(g).connect(out(pv));
    n.start();
  }
  function bellRing(k: number) {
    if (!audio || !sound) return;
    const a = audio;
    [1, 2.76, 5.4, 8.93].forEach((m, i) => {
      const o = a.createOscillator();
      o.frequency.value = 520 * m;
      env(o, (0.16 * k) / (i + 1), 2.4 - i * 0.45, 0.6);
      o.start();
      o.stop(a.currentTime + 2.5);
    });
  }
  function buzz(ms: number) {
    try {
      navigator.vibrate?.(ms | 0);
    } catch {
      // vibration is optional
    }
  }

  // ---------- text ----------
  let sayTimer: ReturnType<typeof setTimeout> | undefined;
  function say(text: string, who?: string, tone: SayTone = "info") {
    sayEl.dataset.tone = tone;
    sayEl.setAttribute("role", tone === "error" ? "alert" : "status");
    sayEl.replaceChildren();
    if (who) {
      const s = document.createElement("small");
      s.className = "lc-bar-say-who";
      s.textContent = who;
      sayEl.appendChild(s);
    }
    sayEl.appendChild(document.createTextNode(text));
    gsap.killTweensOf(sayEl);
    gsap.fromTo(
      sayEl,
      { opacity: 0, y: reduced ? 0 : 8, scale: reduced ? 1 : 0.95 },
      { opacity: 1, y: 0, scale: 1, duration: 0.25, ease: "back.out(2)" }
    );
    if (tone === "error" && !reduced) {
      gsap.fromTo(
        sayEl,
        { x: 0 },
        {
          keyframes: [
            { x: -8, duration: 0.06 },
            { x: 7, duration: 0.06 },
            { x: -5, duration: 0.06 },
            { x: 3, duration: 0.06 },
            { x: 0, duration: 0.08 },
          ],
          delay: 0.2,
        }
      );
    }
    if (sayTimer) clearTimeout(sayTimer);
    sayTimer = setTimeout(
      () => {
        if (!destroyed) gsap.to(sayEl, { opacity: 0, duration: 0.4 });
      },
      tone === "error" ? 5500 : 3400
    );
    lastHint = performance.now();
  }
  function tipText(text: string) {
    tipEl.textContent = text;
  }
  function idleTip(): string {
    if (barMode === "warmup") return "warm-up: pint pours on your activation day";
    if (barMode === "backlog") return "settle first, then we pour";
    if (barMode === "done-today" || ownDone) return "checked in today. another one? on the house";
    if (riskOn) return "last call! drink or lose your streak";
    return "drag the pint to your mouth and hold · or hold space";
  }

  // ---------- wiring ----------
  for (let i = 0; i < 14; i++)
    bubbles.push({
      t: Math.random(),
      x: Math.random() * 2 - 1,
      v: 0.15 + Math.random() * 0.25,
      r: 1 + Math.random() * 1.6,
    });
  resize();
  // Fade the canvas in once the art is ready (LC-024); repaint the chalk board when its font arrives.
  void ready.then(() => {
    if (!destroyed) root.classList.add("is-ready");
  });
  void document.fonts?.ready.then(() => {
    if (!destroyed) streetArt.reset();
  });
  const observer = new ResizeObserver(resize);
  observer.observe(root);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", letGo);
  root.addEventListener("pointercancel", letGo);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("keyup", onKeyUp);
  bellEl.addEventListener("pointerdown", stop);
  bellEl.addEventListener("click", onBell);
  nextChat = performance.now() + 1200;
  lastHint = performance.now();
  tipText(idleTip());
  raf = requestAnimationFrame(frame);

  const api: BarScene = {
    setMode(next) {
      if (next === barMode) return;
      const wasWarmup = barMode === "warmup";
      barMode = next;
      if (next === "warmup" && mode === "idle") vol = 0;
      if (wasWarmup && next !== "warmup" && mode === "idle") {
        vol = 1;
        pour(0);
      }
      if (mode === "idle") tipText(idleTip());
    },
    setLines(next) {
      hints = next.hints;
      chat = next.chat;
    },
    setSound(on) {
      sound = on;
      if (on) ensureAudio();
      else if (audio) {
        void audio.close().catch(() => {});
        audio = null;
        sfxLoading = false;
        SFXBUF.burp = [];
        SFXBUF.fart = [];
        NB = null;
      }
    },
    setBodySounds(on) {
      bodyOn = on;
    },
    othersCheckedIn(count, names) {
      const shown = Math.min(count, patrons.length);
      for (let i = 0; i < shown; i++) {
        const name = names[i];
        const rest = count - shown;
        const last = i === shown - 1 && rest > 0;
        queue.push(`+${last ? rest + 1 : 1}${name ? ` ${name}` : ""}`);
      }
    },
    goalReached,
    newDay() {
      ownDone = false;
      bellRungToday = false;
      extraDrinks = 0;
      wobble = 0;
      bellPokes = 0;
      queue.length = 0;
      if (mode === "idle") {
        vol = barMode === "warmup" ? 0 : 1;
        tipText(idleTip());
      }
      say("gm. New day, bar is open", "bartender");
    },
    checkInSucceeded(outcome, lineText) {
      if (mode !== "wait") {
        ownDone = true;
        say(lineText, undefined, "good");
        return;
      }
      slam(outcome, lineText);
    },
    checkInFailed(lineText) {
      if (mode !== "wait") {
        say(lineText, "bartender", "error");
        return;
      }
      mode = "lower";
      const s = { l: lift };
      gsap.to(s, {
        l: 0,
        duration: 0.5,
        ease: "power2.out",
        onUpdate: () => {
          lift = liftTarget = s.l;
        },
        onComplete: () => {
          say(lineText, "bartender", "error");
          crowdGroan();
          later(() => {
            vol = barMode === "warmup" ? 0 : 1;
            pour(0);
            mode = "idle";
            tipText(idleTip());
          }, 700);
        },
      });
    },
    say,
    setStreak(streak, name) {
      playerName = name;
      drunk = reduced ? 0 : drunkLevel(streak);
      const next = streakTier(streak).index;
      const first = tier < 0;
      const rose = !first && next > tier;
      tier = next;
      if (first) {
        if (place !== "street") later(() => say(at(LINES.tierGreet, next), "bartender"), 900);
      } else if (rose) {
        later(() => {
          say(at(LINES.tierUp, next), "bartender");
          if (next >= 2) raiseGlasses(LINES.chorus);
          if (next >= 3 && !reduced) burstConfetti(confetti, cw, ch, 90);
        }, 1600);
      }
      if (mode === "idle") tipText(idleTip());
    },
    setNight(endsAt, lengthMs) {
      nightEnd = endsAt;
      nightLen = lengthMs;
    },
    setGoal(count, goal) {
      goalCount = count;
      goalN = goal;
    },
    streakLost(previous) {
      cracked = 1;
      thud(0.4, 0);
      crowdGroan();
      later(() => say(`Streak ${previous} is gone. Start a new one tonight`, "bartender", "error"), 400);
    },
    focus(target) {
      focusOn = { target, until: performance.now() + 2200 };
    },
    setPrimary(glass) {
      primaryGlass = glass;
    },
    setPlace(next) {
      if (next === place) return;
      const first = place === null;
      if (first || next === "street") {
        gsap.killTweensOf(street);
        place = next;
        street.door = 0;
        street.zoom = 0;
        street.reveal = 0;
        camZ = 0;
        vgA = 1;
        placeClass();
        return;
      }
      enterBar();
    },
    setBoard(board) {
      streetArt.setBoard(board);
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(kRaf);
      observer.disconnect();
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (sayTimer) clearTimeout(sayTimer);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", letGo);
      root.removeEventListener("pointercancel", letGo);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("keyup", onKeyUp);
      bellEl.removeEventListener("pointerdown", stop);
      bellEl.removeEventListener("click", onBell);
      gsap.killTweensOf([shake, sayEl, bangEl, bellEl, signEl, street, ...patrons, ...labels]);
      if (audio) void audio.close().catch(() => {});
      audio = null;
    },
  };
  return api;
}

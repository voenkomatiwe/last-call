// The street in front of the bar (LC-024), ported from `docs/prototypes/last-orders-bar.html`: a
// Victorian pub front at night. The windows and the door are portals: the scene engine renders the
// live bar offscreen every frame and hands it in, so passers-by see the real crowd. Entering opens
// the door and walks the camera into the doorway until the door fills the screen; that frame equals
// the bar scene, so the engine switches to the bar without a cut.
//
// Browser-only canvas drawing; `scene.ts` owns the state (door, zoom) and calls `drawStreet`.

type Ctx = CanvasRenderingContext2D;

const INK = "#140812";
const GREEN = "#173b30";
const GREEN2 = "#24574a";
const GOLD = "#d9a441";

const WIN: readonly (readonly [number, number])[] = [
  [0.055, 0.285],
  [0.715, 0.945],
];
const WY = [0.29, 0.625] as const;
const VO = { x0: 0.312, x1: 0.688, y0: 0.262, y1: 0.8 };
/** The door, as fractions of the column. */
export const DOOR = { x0: 0.362, x1: 0.638, y0: 0.338, y1: 0.775 };
const AB = { x0: 0.645, x1: 0.962, y0: 0.6, y1: 0.79, foot: 0.816 };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + (k < 0 ? c * k : (255 - c) * k))));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export interface StreetFonts {
  readonly body: string;
  readonly neon: string;
  readonly chalk: string;
}

/** What the chalk board says: tonight's goal and the stake, from the contract. */
export interface BoardText {
  readonly goal: string;
  readonly stake: string;
}

export interface StreetState {
  /** 0 closed … 1 open. */
  door: number;
  /** A gentle push towards the door: 0 … 1 is a camera zoom of 1 … 1 + STREET_PUSH, about the door. */
  zoom: number;
  /** The doorway opening up to the whole view (drawn by the scene): 0 … 1. */
  reveal: number;
}

/** How far the camera leans in towards the door while it opens (user, 13 Nov: no big zoom). */
export const STREET_PUSH = 0.08;

/** Door rectangle in pixels and the scale at which it fills the column. */
export function doorRect(cw: number, ch: number, fw = cw) {
  const r = { x: DOOR.x0 * cw, y: DOOR.y0 * ch, w: (DOOR.x1 - DOOR.x0) * cw, h: (DOOR.y1 - DOOR.y0) * ch };
  // `fill`: zoom at which the door covers the whole view (fw wide); `cover`: how the view-sized portal
  // is scaled to cover the door. Their product is the bar's camera zoom at the end of the walk.
  return { ...r, fill: Math.max(fw / r.w, ch / r.h), cover: Math.max(r.w / fw, r.h / ch) };
}

/** Lamp posts of the wide street, as column fractions (outside 0 … 1 only). */
function lampsAt(ox: number, cw: number): number[] {
  const out: number[] = [];
  const step = 0.85;
  for (let k = 1; (k - 0.5) * step * cw < ox + cw; k++) {
    out.push(-0.32 - (k - 1) * step, 1.32 + (k - 1) * step);
  }
  return out.filter((x) => x * cw > -ox - cw * 0.1 && x * cw < cw + ox + cw * 0.1);
}

export function createStreetArt(fonts: StreetFonts) {
  let streetC: HTMLCanvasElement | null = null;
  let streetKey = "";
  let blurC: HTMLCanvasElement | null = null;
  let boardC: { c: HTMLCanvasElement; key: string } | null = null;
  let board: BoardText = { goal: "?", stake: "?" };

  function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  function goldText(ctx: Ctx, tx: string, x: number, y: number, size: number, arc = 0) {
    ctx.save();
    ctx.font = `900 ${size}px ${fonts.body}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const g = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2);
    g.addColorStop(0, "#fff0b8");
    g.addColorStop(0.5, "#e2b04a");
    g.addColorStop(1, "#9a6a1c");
    ctx.fillStyle = g;
    ctx.strokeStyle = "#2a1406";
    ctx.lineWidth = Math.max(1.5, size * 0.12);
    ctx.lineJoin = "round";
    if (!arc) {
      ctx.strokeText(tx, x, y);
      ctx.fillText(tx, x, y);
      ctx.restore();
      return;
    }
    const chars = [...tx];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let ang = -total / arc / 2;
    chars.forEach((c, i) => {
      const w = widths[i] as number;
      const a = ang + w / arc / 2;
      ctx.save();
      ctx.translate(x + Math.sin(a) * arc, y + arc - Math.cos(a) * arc);
      ctx.rotate(a);
      ctx.strokeText(c, 0, 0);
      ctx.fillText(c, 0, 0);
      ctx.restore();
      ang += w / arc;
    });
    ctx.restore();
  }

  function woodPanel(ctx: Ctx, x: number, y: number, w: number, h: number, lw: number) {
    ctx.fillStyle = GREEN;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.strokeRect(x, y, w, h);
    const i = Math.min(w, h) * 0.14;
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(x + i, y + i, w - i * 2, h - i * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = lw * 0.6;
    ctx.strokeRect(x + i, y + i, w - i * 2, h - i * 2);
  }

  /**
   * The street either side of the pub on wide screens: dark neighbours with a few lit windows, shut
   * doors, lamp posts, and the same wet pavement. Column coordinates, from -ox to cw + ox.
   */
  function streetSides(ctx: Ctx, cw: number, ch: number, ox: number) {
    if (ox < 1) return;
    const lw = Math.max(1.4, cw / 230);
    const x0 = -ox - 2;
    const x1 = cw + ox + 2;
    ctx.fillStyle = "#0a0914";
    ctx.fillRect(x0, 0, x1 - x0, ch);
    const bh = ch * 0.022;
    const bw = cw * 0.1;
    for (let r = 0; r * bh < ch * 0.8; r++) {
      const off = ((r % 2) * bw) / 2;
      for (let i = Math.floor(x0 / bw) - 1; i * bw < x1 + bw; i++) {
        if (i * bw - off > -bw && i * bw - off < cw) continue;
        const k = ((((r * 7 + i * 13) % 5) + 5) % 5) / 5;
        ctx.fillStyle = `rgb(${(34 + k * 12) | 0},${(22 + k * 6) | 0},${(32 + k * 8) | 0})`;
        ctx.beginPath();
        ctx.roundRect(i * bw - off + 1.3, r * bh + 1.3, bw - 2.6, bh - 2.6, 2);
        ctx.fill();
      }
    }
    // neighbours: a band of storefronts with windows, some lit, some shuttered
    const unit = cw * 0.42;
    for (const side of [-1, 1] as const) {
      for (let n = 0; n * unit < ox + unit; n++) {
        const bx = side < 0 ? -(n + 1) * unit : cw + n * unit;
        const seed = (n * 7 + (side < 0 ? 3 : 11)) % 5;
        ctx.fillStyle = seed % 2 ? "#141b26" : "#1b1420";
        ctx.fillRect(bx + unit * 0.04, ch * 0.24, unit * 0.92, ch * 0.56);
        ctx.strokeStyle = INK;
        ctx.lineWidth = lw;
        ctx.strokeRect(bx + unit * 0.04, ch * 0.24, unit * 0.92, ch * 0.56);
        // upstairs windows
        for (const wx of [0.18, 0.58]) {
          const lit = (seed + (wx > 0.5 ? 1 : 0)) % 3 === 0;
          ctx.fillStyle = lit ? "#5a4020" : "#0d0c16";
          ctx.fillRect(bx + unit * wx, ch * 0.06, unit * 0.24, ch * 0.1);
          ctx.strokeRect(bx + unit * wx, ch * 0.06, unit * 0.24, ch * 0.1);
          if (lit) {
            ctx.fillStyle = "rgba(255,200,120,0.25)";
            ctx.fillRect(bx + unit * wx, ch * 0.06, unit * 0.24, ch * 0.1);
          }
        }
        // shop window or shutter
        if (seed === 1 || seed === 3) {
          ctx.fillStyle = "#26222c";
          ctx.fillRect(bx + unit * 0.12, ch * 0.34, unit * 0.76, ch * 0.32);
          ctx.strokeStyle = "rgba(0,0,0,0.5)";
          ctx.lineWidth = 1;
          for (let k = 1; k < 14; k++)
            line(ctx, bx + unit * 0.12, ch * (0.34 + k * 0.0228), bx + unit * 0.88, ch * (0.34 + k * 0.0228));
          ctx.strokeStyle = INK;
          ctx.lineWidth = lw;
          ctx.strokeRect(bx + unit * 0.12, ch * 0.34, unit * 0.76, ch * 0.32);
        } else {
          ctx.fillStyle = seed === 0 ? "#3a2a18" : "#10121c";
          ctx.fillRect(bx + unit * 0.12, ch * 0.34, unit * 0.76, ch * 0.32);
          ctx.strokeRect(bx + unit * 0.12, ch * 0.34, unit * 0.76, ch * 0.32);
          ctx.strokeStyle = "#0f2a22";
          ctx.lineWidth = cw * 0.008;
          line(ctx, bx + unit * 0.5, ch * 0.34, bx + unit * 0.5, ch * 0.66);
          ctx.strokeStyle = INK;
          ctx.lineWidth = lw;
        }
        ctx.fillStyle = "#0c0a10";
        ctx.fillRect(bx + unit * 0.12, ch * 0.68, unit * 0.76, ch * 0.12);
        ctx.strokeRect(bx + unit * 0.12, ch * 0.68, unit * 0.76, ch * 0.12);
      }
    }
    // pavement and kerb across the whole width
    const py = 0.8 * ch;
    const g = ctx.createLinearGradient(0, py, 0, ch);
    g.addColorStop(0, "#2a2c3c");
    g.addColorStop(1, "#12131c");
    ctx.fillStyle = g;
    ctx.fillRect(x0, py, x1 - x0, ch - py);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1.2;
    for (let i = 1; i < 6; i++) {
      const y = py + (ch - py) * (i / 6) ** 1.45;
      line(ctx, x0, y, x1, y);
    }
    for (let i = -40; i <= 40; i++) {
      const xa = cw / 2 + i * cw * 0.075;
      const xb = cw / 2 + i * cw * 0.22;
      if (xa < 0 || xa > cw) line(ctx, xa, py, xb, ch);
    }
    ctx.fillStyle = "#3a3c4c";
    ctx.fillRect(x0, py, x1 - x0, ch * 0.008);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    line(ctx, x0, py, x1, py);
    // lamp posts
    for (const lx of lampsAt(ox, cw)) {
      const X = lx * cw;
      const w = cw * 0.016;
      ctx.fillStyle = "#14161c";
      ctx.fillRect(X - w / 2, ch * 0.4, w, py - ch * 0.4 + ch * 0.02);
      ctx.strokeRect(X - w / 2, ch * 0.4, w, py - ch * 0.4 + ch * 0.02);
      ctx.fillRect(X - w * 1.6, ch * 0.34, w * 3.2, ch * 0.012);
      ctx.fillStyle = "#ffe2a0";
      ctx.beginPath();
      ctx.moveTo(X - w * 1.3, ch * 0.352);
      ctx.lineTo(X + w * 1.3, ch * 0.352);
      ctx.lineTo(X + w * 0.9, ch * 0.405);
      ctx.lineTo(X - w * 0.9, ch * 0.405);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  /** Everything that does not move: cached, or drawn live under the camera so it stays sharp. */
  function streetArt(ctx: Ctx, cw: number, ch: number) {
    const lw = Math.max(1.4, cw / 230);
    ctx.fillStyle = "#0b0a16";
    ctx.fillRect(0, 0, cw, ch);
    const bh = ch * 0.022;
    const bw = cw * 0.1;
    for (let r = 0; r * bh < ch * 0.21; r++) {
      const off = ((r % 2) * bw) / 2;
      for (let i = -1; i * bw < cw + bw; i++) {
        const k = ((r * 7 + i * 13) % 5) / 5;
        ctx.fillStyle = `rgb(${(52 + k * 16) | 0},${(28 + k * 8) | 0},${(36 + k * 8) | 0})`;
        ctx.beginPath();
        ctx.roundRect(i * bw - off + 1.3, r * bh + 1.3, bw - 2.6, bh - 2.6, 2);
        ctx.fill();
      }
    }
    let g = ctx.createLinearGradient(0, 0, 0, ch * 0.21);
    g.addColorStop(0, "rgba(8,8,24,0.55)");
    g.addColorStop(1, "rgba(8,8,24,0.2)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch * 0.21);
    // shopfront: cornice, fascia, pilasters, stallrisers
    ctx.fillStyle = "#0f2a22";
    ctx.fillRect(0, ch * 0.198, cw, ch * 0.016);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.strokeRect(-2, ch * 0.198, cw + 4, ch * 0.016);
    ctx.fillStyle = GREEN;
    ctx.fillRect(0, ch * 0.214, cw, ch * 0.046);
    ctx.strokeRect(-2, ch * 0.214, cw + 4, ch * 0.046);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(cw * 0.03, ch * 0.221, cw * 0.94, ch * 0.032);
    goldText(ctx, "PUB · CHECK IN BOTTOMS UP · EST. 2026", cw / 2, ch * 0.2375, Math.round(cw * 0.03));
    ctx.fillStyle = GREEN2;
    ctx.fillRect(0, ch * 0.26, cw, ch * 0.54);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.strokeRect(-2, ch * 0.26, cw + 4, ch * 0.54);
    for (const [a, b] of WIN) {
      woodPanel(ctx, a * cw - cw * 0.012, ch * 0.645, (b - a) * cw + cw * 0.024, ch * 0.15, lw);
      ctx.fillStyle = GREEN;
      ctx.fillRect(a * cw - cw * 0.02, ch * 0.632, (b - a) * cw + cw * 0.04, ch * 0.014);
      ctx.strokeRect(a * cw - cw * 0.02, ch * 0.632, (b - a) * cw + cw * 0.04, ch * 0.014);
      ctx.fillStyle = "#1d1416";
      ctx.fillRect(
        a * cw - cw * 0.008,
        WY[0] * ch - cw * 0.008,
        (b - a) * cw + cw * 0.016,
        (WY[1] - WY[0]) * ch + cw * 0.016
      );
    }
    for (const px of [0.0, 0.29, 0.69, 0.98]) {
      const x = px * cw;
      const w = cw * 0.03;
      ctx.fillStyle = GREEN;
      ctx.fillRect(x - w * 0.1, ch * 0.26, w, ch * 0.54);
      ctx.strokeStyle = INK;
      ctx.lineWidth = lw;
      ctx.strokeRect(x - w * 0.1, ch * 0.26, w, ch * 0.54);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(x + w * 0.05, ch * 0.27, w * 0.18, ch * 0.52);
      ctx.fillStyle = GREEN2;
      ctx.fillRect(x - w * 0.3, ch * 0.26, w * 1.4, ch * 0.016);
      ctx.strokeRect(x - w * 0.3, ch * 0.26, w * 1.4, ch * 0.016);
      ctx.fillRect(x - w * 0.3, ch * 0.784, w * 1.4, ch * 0.016);
      ctx.strokeRect(x - w * 0.3, ch * 0.784, w * 1.4, ch * 0.016);
    }
    // vestibule: tiled side walls in perspective, a mosaic floor, the door frame and a glowing transom
    const o = VO;
    const d = DOOR;
    const P = (x: number, y: number): [number, number] => [x * cw, y * ch];
    const poly = (pts: [number, number][], fill?: string) => {
      ctx.beginPath();
      for (const [i, [x, y]] of pts.entries()) {
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.strokeStyle = INK;
      ctx.lineWidth = lw;
      ctx.stroke();
    };
    poly([P(o.x0, o.y0), P(o.x1, o.y0), P(d.x1, 0.285), P(d.x0, 0.285)], "#0d1f19");
    for (const [ox, dx] of [
      [o.x0, d.x0],
      [o.x1, d.x1],
    ] as const) {
      poly([P(ox, o.y0), P(dx, 0.285), P(dx, d.y1), P(ox, o.y1)], "#1e4a3e");
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.lineWidth = 1;
      for (let k = 1; k < 8; k++) {
        line(ctx, ox * cw, lerp(o.y0, o.y1, k / 8) * ch, dx * cw, lerp(0.285, d.y1, k / 8) * ch);
      }
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
    }
    poly([P(d.x0, d.y1), P(d.x1, d.y1), P(o.x1, o.y1), P(o.x0, o.y1)], "#ddd6c8");
    ctx.save();
    ctx.clip();
    for (let r = 0; r < 4; r++) {
      const v0 = r / 4;
      const v1 = (r + 1) / 4;
      const ya = lerp(d.y1, o.y1, v0) * ch;
      const yb = lerp(d.y1, o.y1, v1) * ch;
      const xa0 = lerp(d.x0, o.x0, v0) * cw;
      const xa1 = lerp(d.x1, o.x1, v0) * cw;
      const xb0 = lerp(d.x0, o.x0, v1) * cw;
      const xb1 = lerp(d.x1, o.x1, v1) * cw;
      for (let c = 0; c < 14; c++) {
        if ((r + c) % 2) continue;
        const u0 = c / 14;
        const u1 = (c + 1) / 14;
        ctx.beginPath();
        ctx.moveTo(lerp(xa0, xa1, u0), ya);
        ctx.lineTo(lerp(xa0, xa1, u1), ya);
        ctx.lineTo(lerp(xb0, xb1, u1), yb);
        ctx.lineTo(lerp(xb0, xb1, u0), yb);
        ctx.fillStyle = "#1d1a1c";
        ctx.fill();
      }
    }
    ctx.restore();
    const R = doorRect(cw, ch);
    ctx.fillStyle = "#2a1206";
    ctx.fillRect(R.x - cw * 0.012, 0.285 * ch, R.w + cw * 0.024, R.y + R.h - 0.285 * ch);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.strokeRect(R.x - cw * 0.012, 0.285 * ch, R.w + cw * 0.024, R.y + R.h - 0.285 * ch);
    g = ctx.createLinearGradient(0, 0.29 * ch, 0, 0.33 * ch);
    g.addColorStop(0, "#ffe2a6");
    g.addColorStop(1, "#e8963f");
    ctx.fillStyle = g;
    ctx.fillRect(R.x, 0.292 * ch, R.w, 0.04 * ch);
    ctx.strokeRect(R.x, 0.292 * ch, R.w, 0.04 * ch);
    ctx.strokeStyle = "#2a1206";
    ctx.lineWidth = lw * 1.2;
    for (let k = 1; k < 4; k++) line(ctx, R.x + (R.w * k) / 4, 0.292 * ch, R.x + (R.w * k) / 4, 0.332 * ch);
    goldText(ctx, "No. 60", R.x + R.w / 2, 0.312 * ch, Math.round(ch * 0.02));
    // pavement: wet slate flags in perspective, a kerb
    const py = 0.8 * ch;
    g = ctx.createLinearGradient(0, py, 0, ch);
    g.addColorStop(0, "#2a2c3c");
    g.addColorStop(1, "#12131c");
    ctx.fillStyle = g;
    ctx.fillRect(0, py, cw, ch - py);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1.2;
    for (let i = 1; i < 6; i++) {
      const y = py + (ch - py) * (i / 6) ** 1.45;
      line(ctx, 0, y, cw, y);
    }
    for (let i = -7; i <= 7; i++) line(ctx, cw / 2 + i * cw * 0.075, py, cw / 2 + i * cw * 0.22, ch);
    ctx.fillStyle = "#3a3c4c";
    ctx.fillRect(0, py, cw, ch * 0.008);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    line(ctx, 0, py, cw, py);
  }

  /** The door leaf, hinged on the left, swinging inwards (`k` 0 … 1). */
  function drawDoor(ctx: Ctx, cw: number, ch: number, k: number, lw: number) {
    const R = doorRect(cw, ch);
    const a = k * 1.42;
    const xf = R.x + R.w * Math.cos(a);
    const dt = R.h * 0.06 * Math.sin(a);
    const db = R.h * 0.03 * Math.sin(a);
    const q = (u: number, v: number) => ({
      x: lerp(R.x, xf, u),
      y: lerp(lerp(R.y, R.y + dt, u), lerp(R.y + R.h, R.y + R.h - db, u), v),
    });
    const quad = (u0: number, v0: number, u1: number, v1: number) => {
      const A = q(u0, v0);
      const B = q(u1, v0);
      const C = q(u1, v1);
      const D = q(u0, v1);
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.lineTo(C.x, C.y);
      ctx.lineTo(D.x, D.y);
      ctx.closePath();
    };
    const dark = -0.45 * k;
    quad(0, 0, 1, 1);
    ctx.fillStyle = shade("#1f5040", dark);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw * 1.2;
    ctx.stroke();
    quad(0.14, 0.07, 0.86, 0.5);
    const fg = ctx.createLinearGradient(0, R.y, 0, R.y + R.h * 0.5);
    fg.addColorStop(0, shade("#ffe6b0", dark));
    fg.addColorStop(1, shade("#e0903c", dark));
    ctx.fillStyle = fg;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.stroke();
    quad(0.2, 0.11, 0.8, 0.46);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (Math.cos(a) > 0.55) {
      const c = q(0.5, 0.29);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(Math.cos(a), 1);
      goldText(ctx, "LAST", 0, -R.h * 0.035, Math.round(R.w * 0.17));
      goldText(ctx, "CALL", 0, R.h * 0.035, Math.round(R.w * 0.17));
      ctx.restore();
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    for (const [u0, v0, u1, v1] of [
      [0.14, 0.56, 0.86, 0.72],
      [0.14, 0.76, 0.86, 0.88],
    ] as const) {
      quad(u0, v0, u1, v1);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fill();
      ctx.stroke();
      quad(u0 + 0.06, v0 + 0.025, u1 - 0.06, v1 - 0.025);
      ctx.fillStyle = shade("#2a6a55", dark);
      ctx.fill();
      ctx.stroke();
    }
    quad(0.04, 0.91, 0.96, 0.975);
    ctx.fillStyle = shade(GOLD, dark);
    ctx.fill();
    ctx.stroke();
    quad(0.84, 0.42, 0.9, 0.6);
    ctx.fill();
    ctx.stroke();
    quad(0.35, 0.525, 0.65, 0.545);
    ctx.fill();
    ctx.stroke();
  }

  /** The chalk A-frame face: slate with smudges, chalk lines that shrink to fit, chalk grain. */
  function paintBoardFace(w: number, h: number, dpr: number): HTMLCanvasElement {
    const mk = (): [HTMLCanvasElement, Ctx] => {
      const c = document.createElement("canvas");
      c.width = Math.ceil(w * dpr);
      c.height = Math.ceil(h * dpr);
      const x = c.getContext("2d") as Ctx;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [c, x];
    };
    const [face, fx] = mk();
    const [chalkC, cx] = mk();
    const g = fx.createRadialGradient(w * 0.45, h * 0.4, 0, w * 0.5, h * 0.5, w * 0.75);
    g.addColorStop(0, "#2e3d36");
    g.addColorStop(1, "#18211d");
    fx.fillStyle = g;
    fx.fillRect(0, 0, w, h);
    fx.strokeStyle = "rgba(255,255,255,0.045)";
    fx.lineCap = "round";
    for (let i = 0; i < 16; i++) {
      fx.lineWidth = h * (0.05 + (i % 4) * 0.03);
      fx.beginPath();
      fx.arc(((i * 0.618) % 1) * w, ((i * 0.382) % 1) * h, w * (0.08 + (i % 3) * 0.06), i, i + 2.4);
      fx.stroke();
    }
    const pad = w * 0.09;
    const maxW = w - pad * 2;
    const font = fonts.chalk;
    const chalk = (tx: string, y: number, size: number, col: string) => {
      let sz = size;
      cx.font = `700 ${sz}px ${font}`;
      while (cx.measureText(tx).width > maxW && sz > 8) {
        sz -= 0.5;
        cx.font = `700 ${sz}px ${font}`;
      }
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillStyle = col;
      cx.fillText(tx, w / 2, y);
      cx.globalAlpha = 0.35;
      cx.fillText(tx, w / 2 + 0.7, y + 0.6);
      cx.globalAlpha = 1;
      return sz;
    };
    const hs = chalk("Tonight", h * 0.15, h * 0.25, "#ffc65c");
    cx.strokeStyle = "#ffc65c";
    cx.lineWidth = Math.max(1.2, h * 0.016);
    cx.lineCap = "round";
    cx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const xx = w * 0.27 + (i / 24) * w * 0.46;
      const yy = h * 0.15 + hs * 0.52 + Math.sin(i * 1.1) * h * 0.008;
      if (i) cx.lineTo(xx, yy);
      else cx.moveTo(xx, yy);
    }
    cx.stroke();
    chalk(`goal: ${board.goal}`, h * 0.42, h * 0.21, "#f3efe2");
    chalk(`stake: ${board.stake}`, h * 0.62, h * 0.21, "#f3efe2");
    {
      const my = h * 0.84;
      const mw = h * 0.11;
      const mh = h * 0.14;
      const gap = mw * 0.75;
      const word = "bottoms up!";
      let fs = h * 0.19;
      cx.font = `700 ${fs}px ${font}`;
      while (mw + gap + cx.measureText(word).width > maxW && fs > 8) {
        fs -= 0.5;
        cx.font = `700 ${fs}px ${font}`;
      }
      const gw = mw + gap + cx.measureText(word).width;
      const mx = (w - gw) / 2 + mw / 2;
      cx.strokeStyle = "#f3efe2";
      cx.lineWidth = Math.max(1.2, h * 0.014);
      cx.lineJoin = "round";
      cx.strokeRect(mx - mw / 2, my - mh / 2, mw, mh);
      cx.beginPath();
      cx.arc(mx + mw / 2, my, mh * 0.28, -1.3, 1.3);
      cx.stroke();
      cx.fillStyle = "#f3efe2";
      for (const k of [-0.35, 0, 0.35]) {
        cx.beginPath();
        cx.arc(mx + k * mw, my - mh / 2, mw * 0.24, 0, 7);
        cx.fill();
      }
      cx.textAlign = "left";
      cx.fillStyle = "#ffc65c";
      cx.fillText(word, mx + mw / 2 + gap, my + h * 0.01);
    }
    cx.globalCompositeOperation = "destination-out";
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0, n = w * h * 0.12; i < n; i++) {
      cx.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.35})`;
      cx.fillRect(rnd() * w, rnd() * h, 0.8, 0.8);
    }
    cx.globalCompositeOperation = "source-over";
    fx.drawImage(chalkC, 0, 0, w, h);
    return face;
  }

  function drawABoard(ctx: Ctx, cw: number, ch: number, dpr: number, lw: number) {
    const x0 = AB.x0 * cw;
    const x1 = AB.x1 * cw;
    const y0 = AB.y0 * ch;
    const y1 = AB.y1 * ch;
    const fy = AB.foot * ch;
    const fr = cw * 0.014;
    const lean = cw * 0.01;
    const top = fr * 1.9;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.ellipse((x0 + x1) / 2 + cw * 0.012, fy + ch * 0.003, (x1 - x0) * 0.6, ch * 0.009, 0, 0, 7);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.fillStyle = "#2a1408";
    for (const lx of [x0 + fr * 1.6, x1 - fr * 2.6]) {
      ctx.fillRect(lx, y1 - ch * 0.02, fr, fy - y1 + ch * 0.02 - ch * 0.004);
      ctx.strokeRect(lx, y1 - ch * 0.02, fr, fy - y1 + ch * 0.02 - ch * 0.004);
    }
    const wood = ctx.createLinearGradient(x0, 0, x1, 0);
    wood.addColorStop(0, "#5a2e14");
    wood.addColorStop(0.5, "#8a4a22");
    wood.addColorStop(1, "#4a240f");
    ctx.fillStyle = wood;
    ctx.beginPath();
    ctx.moveTo(x0 + lean, y0);
    ctx.lineTo(x1 - lean, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1, fy);
    ctx.lineTo(x1 - fr, fy);
    ctx.lineTo(x1 - fr, y1 + fr * 0.4);
    ctx.lineTo(x0 + fr, y1 + fr * 0.4);
    ctx.lineTo(x0 + fr, fy);
    ctx.lineTo(x0, fy);
    ctx.lineTo(x0, y1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1a0c05";
    ctx.beginPath();
    ctx.roundRect((x0 + x1) / 2 - cw * 0.03, y0 + top * 0.28, cw * 0.06, top * 0.42, top * 0.21);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw * 0.8;
    ctx.stroke();
    const ix0 = x0 + fr + lean * 0.7;
    const ix1 = x1 - fr - lean * 0.7;
    const iy0 = y0 + top;
    const iy1 = y1 - fr * 0.15;
    const iw = ix1 - ix0;
    const ih = iy1 - iy0;
    const key = `${Math.round(iw)}x${Math.round(ih)}:${dpr}:${board.goal}:${board.stake}`;
    if (!boardC || boardC.key !== key) boardC = { c: paintBoardFace(iw, ih, dpr), key };
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ix0 + lean * 0.3, iy0);
    ctx.lineTo(ix1 - lean * 0.3, iy0);
    ctx.lineTo(ix1, iy1);
    ctx.lineTo(ix0, iy1);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(boardC.c, ix0, iy0, iw, ih);
    const sh = ctx.createLinearGradient(0, iy0, 0, iy0 + ih * 0.12);
    sh.addColorStop(0, "rgba(0,0,0,0.45)");
    sh.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sh;
    ctx.fillRect(ix0, iy0, iw, ih * 0.12);
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(ix0 + lean * 0.3, iy0);
    ctx.lineTo(ix1 - lean * 0.3, iy0);
    ctx.lineTo(ix1, iy1);
    ctx.lineTo(ix0, iy1);
    ctx.closePath();
    ctx.stroke();
  }

  /** A small pint for the hanging blade sign. */
  function signPint(ctx: Ctx, x: number, y: number, h: number) {
    const w = h * 0.55;
    ctx.save();
    ctx.lineWidth = Math.max(1, h * 0.06);
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y - h / 2);
    ctx.lineTo(x + w / 2, y - h / 2);
    ctx.lineTo(x + w * 0.4, y + h / 2);
    ctx.lineTo(x - w * 0.4, y + h / 2);
    ctx.closePath();
    ctx.fillStyle = "#f0a030";
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff6e6";
    ctx.beginPath();
    ctx.ellipse(x, y - h / 2, w * 0.58, h * 0.14, 0, 0, 7);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  return {
    setBoard(next: BoardText) {
      board = next;
    },
    /** Forget cached art (after a resize). */
    reset() {
      streetC = null;
      boardC = null;
    },
    /**
     * Draws the street into `ctx` (column coordinates). `portal` holds the live bar at the column size,
     * at `dpr`. `state` is the door and the camera walk.
     */
    draw(
      ctx: Ctx,
      t: number,
      cw: number,
      ch: number,
      dpr: number,
      portal: HTMLCanvasElement,
      state: StreetState,
      ox = 0
    ) {
      const lw = Math.max(1.4, cw / 230);
      const fw = cw + ox * 2;
      const D = doorRect(cw, ch, fw);
      const u = state.zoom;
      const z = 1 + STREET_PUSH * u;
      const A = { x: D.x + D.w / 2, y: D.y + D.h / 2 };
      ctx.save();
      ctx.translate(A.x, A.y);
      ctx.scale(z, z);
      ctx.translate(-A.x, -A.y);
      if (u > 0.001) {
        streetSides(ctx, cw, ch, ox);
        streetArt(ctx, cw, ch);
      } else {
        const key = `${cw}x${ch}:${dpr}:${ox}`;
        if (!streetC || streetKey !== key) {
          streetC = document.createElement("canvas");
          streetC.width = Math.ceil(fw * dpr);
          streetC.height = Math.ceil(ch * dpr);
          const x = streetC.getContext("2d") as Ctx;
          x.setTransform(dpr, 0, 0, dpr, dpr * ox, 0);
          streetSides(x, cw, ch, ox);
          streetArt(x, cw, ch);
          streetKey = key;
        }
        ctx.drawImage(streetC, -ox, 0, fw, ch);
      }
      // windows: the live bar through frosted glass, mullions, gold lettering, an OPEN neon
      WIN.forEach(([a, b], i) => {
        const wx = a * cw;
        const wy = WY[0] * ch;
        const ww = (b - a) * cw;
        const wh = (WY[1] - WY[0]) * ch;
        const sw = cw * 0.4;
        const sh = (sw * wh) / ww;
        const sx = i ? cw * 0.53 : cw * 0.07;
        const sy = ch * 0.33;
        if (!blurC) blurC = document.createElement("canvas");
        const bw = Math.max(4, Math.round(ww / 9));
        const bh = Math.max(4, Math.round(wh / 9));
        if (blurC.width !== bw || blurC.height !== bh) {
          blurC.width = bw;
          blurC.height = bh;
        }
        const bx = blurC.getContext("2d") as Ctx;
        bx.imageSmoothingQuality = "high";
        bx.drawImage(portal, (sx + ox) * dpr, sy * dpr, sw * dpr, sh * dpr, 0, 0, bw, bh);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(blurC, 0, 0, bw, bh, wx, wy, ww, wh);
        ctx.restore();
        ctx.fillStyle = "rgba(255,236,210,0.12)";
        ctx.fillRect(wx, wy, ww, wh);
        const g = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
        g.addColorStop(0, "rgba(140,170,255,0.18)");
        g.addColorStop(0.35, "rgba(140,170,255,0.02)");
        g.addColorStop(0.36, "rgba(255,255,255,0.1)");
        g.addColorStop(0.42, "rgba(255,255,255,0.02)");
        g.addColorStop(1, "rgba(10,10,30,0.25)");
        ctx.fillStyle = g;
        ctx.fillRect(wx, wy, ww, wh);
        ctx.strokeStyle = GREEN;
        ctx.lineWidth = cw * 0.012;
        line(ctx, wx, wy + wh * 0.3, wx + ww, wy + wh * 0.3);
        line(ctx, wx + ww / 2, wy + wh * 0.3, wx + ww / 2, wy + wh);
        ctx.strokeStyle = INK;
        ctx.lineWidth = lw;
        ctx.strokeRect(wx, wy, ww, wh);
        ctx.strokeRect(wx, wy + wh * 0.3 - cw * 0.006, ww, cw * 0.012);
        goldText(
          ctx,
          i ? "BOTTOMS UP" : "ALE",
          wx + ww / 2,
          wy + wh * 0.15,
          Math.round(cw * (i ? 0.036 : 0.05)),
          ww * 1.1
        );
        if (i) {
          const on = Math.sin(t / 1100) > -0.92;
          const nx = wx + ww / 2;
          const ny = wy + wh * 0.47;
          ctx.save();
          ctx.globalAlpha = on ? 1 : 0.3;
          ctx.shadowColor = "#ff4fb8";
          ctx.shadowBlur = 10;
          ctx.strokeStyle = "#ff9ad5";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(nx - ww * 0.36, ny - wh * 0.06, ww * 0.72, wh * 0.12, 6);
          ctx.stroke();
          ctx.fillStyle = "#fff0f8";
          ctx.font = `400 ${Math.round(cw * 0.04)}px ${fonts.neon}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("OPEN", nx, ny + 1);
          ctx.restore();
        }
      });
      // the doorway shows the bar too, scaled to cover the door; the leaf swings in front of it
      ctx.save();
      ctx.beginPath();
      ctx.rect(D.x, D.y, D.w, D.h);
      ctx.clip();
      ctx.drawImage(portal, A.x - (fw * D.cover) / 2, A.y - (ch * D.cover) / 2, fw * D.cover, ch * D.cover);
      ctx.restore();
      drawDoor(ctx, cw, ch, state.door, lw);
      // coach lanterns and a hanging blade sign that sways a little
      for (const xx of [VO.x0 - 0.012, VO.x1 + 0.012]) {
        const X = xx * cw;
        const Y = 0.335 * ch;
        const w = cw * 0.032;
        ctx.strokeStyle = INK;
        ctx.lineWidth = lw;
        ctx.fillStyle = "#14110f";
        ctx.fillRect(X - w * 0.6, Y - w * 1.5, w * 1.2, w * 0.3);
        ctx.strokeRect(X - w * 0.6, Y - w * 1.5, w * 1.2, w * 0.3);
        ctx.fillStyle = "#ffe2a0";
        ctx.fillRect(X - w * 0.45, Y - w * 1.2, w * 0.9, w * 1.3);
        ctx.strokeRect(X - w * 0.45, Y - w * 1.2, w * 0.9, w * 1.3);
        ctx.fillStyle = "#14110f";
        ctx.fillRect(X - w * 0.55, Y + w * 0.1, w * 1.1, w * 0.25);
        ctx.strokeRect(X - w * 0.55, Y + w * 0.1, w * 1.1, w * 0.25);
      }
      {
        const bx = cw * 0.985;
        const by = ch * 0.105;
        const sw = Math.sin(t / 900) * 0.05;
        ctx.strokeStyle = INK;
        ctx.lineWidth = lw * 1.3;
        line(ctx, bx, by, cw * 0.8, by);
        line(ctx, bx, by + ch * 0.03, cw * 0.86, by);
        ctx.save();
        ctx.translate(cw * 0.865, by);
        ctx.rotate(sw);
        ctx.lineWidth = lw;
        line(ctx, -cw * 0.03, 0, -cw * 0.03, ch * 0.012);
        line(ctx, cw * 0.03, 0, cw * 0.03, ch * 0.012);
        ctx.beginPath();
        ctx.ellipse(0, ch * 0.05, cw * 0.07, ch * 0.04, 0, 0, 7);
        ctx.fillStyle = GREEN;
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(0, ch * 0.05, cw * 0.06, ch * 0.033, 0, 0, 7);
        ctx.stroke();
        signPint(ctx, 0, ch * 0.052, ch * 0.045);
        ctx.restore();
      }
      drawABoard(ctx, cw, ch, dpr, lw);
      // light: lantern glows, warm window spill on the wet pavement, the open door's beam
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const xx of [VO.x0 - 0.012, VO.x1 + 0.012]) {
        const X = xx * cw;
        const Y = 0.33 * ch;
        const r = cw * 0.13;
        const f = 0.9 + 0.1 * Math.sin(t / 230 + xx * 9);
        const g = ctx.createRadialGradient(X, Y, 0, X, Y, r);
        g.addColorStop(0, `rgba(255,214,140,${0.5 * f})`);
        g.addColorStop(1, "rgba(255,214,140,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(X, Y, r, 0, 7);
        ctx.fill();
      }
      for (const lx of ox > 0 ? lampsAt(ox, cw) : []) {
        const X = lx * cw;
        const Y = 0.38 * ch;
        const r = cw * 0.3;
        const g = ctx.createRadialGradient(X, Y, 0, X, Y, r);
        g.addColorStop(0, "rgba(255,214,140,0.32)");
        g.addColorStop(1, "rgba(255,214,140,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(X, Y, r, 0, 7);
        ctx.fill();
        const p = ctx.createRadialGradient(X, 0.84 * ch, 0, X, 0.84 * ch, r * 0.8);
        p.addColorStop(0, "rgba(255,200,120,0.16)");
        p.addColorStop(1, "rgba(255,200,120,0)");
        ctx.fillStyle = p;
        ctx.fillRect(X - r, 0.8 * ch, r * 2, 0.2 * ch);
      }
      for (const [a, b] of WIN) {
        const g = ctx.createLinearGradient(0, 0.8 * ch, 0, ch);
        g.addColorStop(0, "rgba(255,170,80,0.22)");
        g.addColorStop(1, "rgba(255,170,80,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(a * cw, 0.8 * ch);
        ctx.lineTo(b * cw, 0.8 * ch);
        ctx.lineTo(b * cw + cw * 0.08, ch);
        ctx.lineTo(a * cw - cw * 0.08, ch);
        ctx.fill();
      }
      {
        const g = ctx.createLinearGradient(0, 0.8 * ch, 0, ch);
        g.addColorStop(0, "rgba(255,79,184,0.16)");
        g.addColorStop(1, "rgba(255,79,184,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cw * 0.3, 0.8 * ch, cw * 0.4, ch * 0.2);
      }
      if (state.door > 0) {
        const g = ctx.createLinearGradient(0, D.y + D.h, 0, ch);
        g.addColorStop(0, `rgba(255,200,120,${0.5 * state.door})`);
        g.addColorStop(1, "rgba(255,200,120,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(D.x, D.y + D.h);
        ctx.lineTo(D.x + D.w, D.y + D.h);
        ctx.lineTo(D.x + D.w + cw * 0.22, ch);
        ctx.lineTo(D.x - cw * 0.22, ch);
        ctx.fill();
      }
      ctx.restore();
      // cold fog and drizzle with ripples
      const fog = ctx.createLinearGradient(0, 0.7 * ch, 0, ch);
      fog.addColorStop(0, "rgba(120,140,200,0)");
      fog.addColorStop(0.5, "rgba(120,140,200,0.07)");
      fog.addColorStop(1, "rgba(120,140,200,0.03)");
      ctx.fillStyle = fog;
      ctx.fillRect(-ox, 0.7 * ch, fw, 0.3 * ch);
      ctx.strokeStyle = "rgba(190,205,255,0.22)";
      ctx.lineWidth = 1;
      const drops = Math.round(44 * (fw / cw));
      for (let i = 0; i < drops; i++) {
        const x = ((i * 0.6180339) % 1) * fw * 1.1 - fw * 0.05 - ox;
        const y = ((t * 0.6 + i * 137) % (ch * 1.1)) - ch * 0.05;
        line(ctx, x, y, x - 2, y + 10);
      }
      for (let i = 0; i < 5; i++) {
        const ph = (t / 900 + i * 0.37) % 1;
        const x = cw * (0.12 + ((i * 0.29) % 1) * 0.76);
        const y = ch * (0.85 + ((i * 0.43) % 1) * 0.12);
        ctx.strokeStyle = `rgba(200,215,255,${0.35 * (1 - ph)})`;
        ctx.beginPath();
        ctx.ellipse(x, y, 2 + ph * 16, (2 + ph * 16) * 0.3, 0, 0, 7);
        ctx.stroke();
      }
      ctx.restore();
      const vg = ctx.createRadialGradient(
        cw / 2,
        ch * 0.5,
        Math.min(fw, ch) * 0.4,
        cw / 2,
        ch * 0.5,
        Math.hypot(fw, ch) * 0.62
      );
      vg.addColorStop(0, "rgba(4,4,12,0)");
      vg.addColorStop(1, "rgba(4,4,12,0.6)");
      ctx.fillStyle = vg;
      ctx.fillRect(-ox, 0, fw, ch);
    },
  };
}

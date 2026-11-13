// Canvas pieces for the day's moments (LC-025): the closers' neon rims and name tags, the hero
// spotlight, coins and smoke from the pot jar. Stateless drawing and particle helpers; `scene.ts`
// owns the state and calls them inside its frame, in column coordinates (`cw` × `ch`).

type Ctx = CanvasRenderingContext2D;

const INK = "#140812";
const GOLD = "#ffd36b";
const NEON = "#ff4fb8";

/** `kai.testnet` → `kai.testnet`; long names keep the start and the end. */
export function shortName(name: string, max = 14): string {
  return name.length <= max ? name : `${name.slice(0, max - 5)}…${name.slice(-4)}`;
}

/** Neon outline over a glass path already set on `ctx`. */
export function strokeNeon(ctx: Ctx, lw: number, t: number, colour = NEON) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.shadowColor = colour;
  ctx.shadowBlur = lw * (3 + Math.sin(t / 260));
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.restore();
}

/** A small neon name tag on the counter: "closer" in front of a patron, or "HERO". */
export function drawTag(ctx: Ctx, x: number, y: number, text: string, size: number, font: string, colour = NEON) {
  ctx.save();
  ctx.font = `800 ${Math.round(size)}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + size * 1.1;
  const h = size * 1.6;
  ctx.fillStyle = "rgba(20,8,18,0.82)";
  ctx.strokeStyle = colour;
  ctx.shadowColor = colour;
  ctx.shadowBlur = size * 0.8;
  ctx.lineWidth = Math.max(1, size * 0.12);
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = size * 0.5;
  ctx.fillStyle = "#ffe0f2";
  ctx.fillText(text, x, y + size * 0.04);
  ctx.restore();
}

/** A cone of warm light from the ceiling onto `x`, with a pool on the counter. `k` is its strength. */
export function drawSpotlight(ctx: Ctx, x: number, floorY: number, spread: number, ch: number, k: number) {
  if (k <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const top = -ch * 0.05;
  const g = ctx.createLinearGradient(0, top, 0, floorY);
  g.addColorStop(0, `rgba(255,236,190,${(0.05 * k).toFixed(3)})`);
  g.addColorStop(1, `rgba(255,236,190,${(0.3 * k).toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x - spread * 0.12, top);
  ctx.lineTo(x + spread * 0.12, top);
  ctx.lineTo(x + spread, floorY);
  ctx.lineTo(x - spread, floorY);
  ctx.closePath();
  ctx.fill();
  const pool = ctx.createRadialGradient(x, floorY, 0, x, floorY, spread * 1.2);
  pool.addColorStop(0, `rgba(255,236,190,${(0.35 * k).toFixed(3)})`);
  pool.addColorStop(1, "rgba(255,236,190,0)");
  ctx.fillStyle = pool;
  ctx.beginPath();
  ctx.ellipse(x, floorY, spread * 1.2, spread * 0.35, 0, 0, 7);
  ctx.fill();
  ctx.restore();
}

export interface Coin {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  life: number;
  /** Lands here (claim) instead of falling off-screen. */
  floor: number;
}

/** Coins popping out of the jar; with a target they arc to it (the bartender hands them over). */
export function burstCoins(
  list: Coin[],
  from: { x: number; y: number },
  n: number,
  scale: number,
  to?: { x: number; y: number }
) {
  for (let i = 0; i < n; i++) {
    const flight = 0.7 + Math.random() * 0.25;
    const vy = to ? (to.y - from.y) / flight - 0.5 * scale * 4 * flight : -scale * (1.6 + Math.random() * 1.2);
    list.push({
      x: from.x + (Math.random() - 0.5) * scale * 0.2,
      y: from.y,
      vx: to ? (to.x - from.x) / flight + (Math.random() - 0.5) * scale * 0.3 : (Math.random() - 0.5) * scale * 1.6,
      vy,
      spin: Math.random() * 6,
      life: 1 + i * 0.02,
      floor: to ? to.y : Number.POSITIVE_INFINITY,
    });
  }
}

export function stepCoins(ctx: Ctx, list: Coin[], scale: number, dt: number, size: number) {
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i] as Coin;
    c.vy += scale * 4 * dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    if (c.y >= c.floor) {
      c.y = c.floor;
      c.vx = 0;
      c.vy = 0;
    }
    c.spin += dt * 9;
    c.life -= dt * 0.55;
    if (c.life <= 0) {
      list.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, c.life * 2);
    ctx.translate(c.x, c.y);
    ctx.fillStyle = GOLD;
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, size * 0.14);
    ctx.beginPath();
    ctx.ellipse(0, 0, size * Math.max(0.15, Math.abs(Math.cos(c.spin))), size, 0, 0, 7);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export interface Puff {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  life: number;
}

/** Smoke rising from the jar: the pot burns on a failed day. */
export function burstSmoke(list: Puff[], from: { x: number; y: number }, n: number, scale: number) {
  for (let i = 0; i < n; i++)
    list.push({
      x: from.x + (Math.random() - 0.5) * scale * 0.2,
      y: from.y - i * scale * 0.02,
      r: scale * (0.06 + Math.random() * 0.05),
      vx: (Math.random() - 0.5) * scale * 0.15,
      vy: -scale * (0.25 + Math.random() * 0.2),
      life: 1 + i * 0.04,
    });
}

export function stepSmoke(ctx: Ctx, list: Puff[], scale: number, dt: number) {
  ctx.save();
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i] as Puff;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.r += scale * 0.08 * dt;
    p.life -= dt * 0.4;
    if (p.life <= 0) {
      list.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = Math.min(0.55, p.life * 0.55);
    ctx.fillStyle = "#6d6470";
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, 7);
    ctx.fill();
  }
  ctx.restore();
}

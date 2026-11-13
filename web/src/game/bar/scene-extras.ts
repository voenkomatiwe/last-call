// Canvas pieces the streak tiers and the "obvious controls" add to the bar (LC-028): tier light grade,
// the player's glass badge and cracks, the wall clock, the name plaque, the pot jar, the goal rail of
// small glasses, the focus ring for HUD taps, and confetti. Stateless drawing helpers: `scene.ts`
// owns the state and calls them inside its frame, in column coordinates (`cw` × `ch`).

type Ctx = CanvasRenderingContext2D;
export type Ellipse = { cx: number; cy: number; rx: number; ry: number };

const INK = "#140812";
const GOLD = "#ffd36b";
const NEON = "#ff4fb8";

/** Brightness and saturation per tier (novice … owner): the bar lights up as the streak grows. */
const GRADE: readonly (readonly [number, number])[] = [
  [0.68, 0.5],
  [0.84, 0.78],
  [1, 1],
  [1.04, 1.15],
  [1.06, 1.12],
  [1.08, 1.22],
];

/**
 * CSS filter for the canvas: tier grade, the at-risk dimming, and the extra-drinks blur. `strength`
 * (0 … 1) fades the grade in, so the bar warms or cools gently after the walk in from the street.
 */
export function gradeFilter(tier: number, risk: number, blurPx: number, t: number, strength = 1): string {
  const [g0, g1] = GRADE[Math.max(0, Math.min(GRADE.length - 1, tier))] as readonly [number, number];
  const b0 = 1 + (g0 - 1) * strength;
  const s0 = 1 + (g1 - 1) * strength;
  const pulse = risk > 0 ? 1 - risk * (0.26 + 0.08 * Math.sin(t / 260)) : 1;
  const b = (b0 * pulse).toFixed(3);
  const s = (s0 * (risk > 0 ? 1 - risk * 0.35 : 1)).toFixed(3);
  return `brightness(${b}) saturate(${s})${blurPx > 0.05 ? ` blur(${blurPx.toFixed(2)}px)` : ""}`;
}

/** A colour wash over the whole room: cold for a new face, amber, neon, then gold. */
export function drawTierWash(ctx: Ctx, tier: number, x: number, w: number, h: number, strength = 1) {
  const wash: readonly (readonly [string, number, GlobalCompositeOperation] | null)[] = [
    ["#20304a", 0.3, "multiply"],
    null,
    ["#ffb84a", 0.07, "soft-light"],
    [NEON, 0.1, "soft-light"],
    [GOLD, 0.12, "soft-light"],
    [GOLD, 0.16, "soft-light"],
  ];
  const k = wash[tier];
  if (!k) return;
  ctx.save();
  ctx.globalCompositeOperation = k[2];
  ctx.globalAlpha = k[1] * strength;
  ctx.fillStyle = k[0];
  ctx.fillRect(x, 0, w, h);
  ctx.restore();
}

/** Round enamel badge on the front of the player's glass: initial from regular, neon at local, gold from legend. */
export function drawGlassBadge(ctx: Ctx, tier: number, front: Ellipse, r: number, initial: string, font: string) {
  if (tier < 2) return;
  const x = front.cx;
  const y = front.cy + front.ry * 0.9;
  const gold = tier >= 4;
  ctx.save();
  if (tier >= 3) {
    ctx.shadowColor = gold ? GOLD : NEON;
    ctx.shadowBlur = r * 0.9;
  }
  // Dark enamel with a gold letter from legend: a gold badge would vanish against the beer.
  ctx.fillStyle = gold ? "#2a1608" : "#fff4e4";
  ctx.strokeStyle = gold ? GOLD : tier >= 3 ? NEON : INK;
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.92, 0, 0, 7);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = gold ? GOLD : "#c0392b";
  ctx.font = `900 ${Math.round(r * 1.2)}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initial, x, y + r * 0.08);
  ctx.restore();
}

/** Neon (local) or gold (legend, owner) lip on the glass rim. */
export function drawRimGlow(ctx: Ctx, tier: number, rim: Ellipse, lw: number) {
  if (tier < 3) return;
  ctx.save();
  const c = tier >= 4 ? GOLD : NEON;
  ctx.strokeStyle = c;
  ctx.shadowColor = c;
  ctx.shadowBlur = lw * 4;
  ctx.lineWidth = lw * 1.1;
  ctx.beginPath();
  ctx.ellipse(rim.cx, rim.cy, rim.rx, rim.ry, 0, 0, 7);
  ctx.stroke();
  ctx.restore();
}

/** A crown floating over the owner's glass at rest. */
export function drawCrown(ctx: Ctx, x: number, y: number, s: number, t: number) {
  const bob = Math.sin(t / 500) * s * 0.08;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.fillStyle = GOLD;
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.5, s * 0.07);
  ctx.shadowColor = GOLD;
  ctx.shadowBlur = s * 0.6;
  ctx.beginPath();
  ctx.moveTo(-s, s * 0.4);
  ctx.lineTo(-s, -s * 0.35);
  ctx.lineTo(-s * 0.5, s * 0.05);
  ctx.lineTo(0, -s * 0.6);
  ctx.lineTo(s * 0.5, s * 0.05);
  ctx.lineTo(s, -s * 0.35);
  ctx.lineTo(s, s * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.restore();
}

/** Cracks across the glass after a lost streak; `k` fades them (0 … 1). */
export function drawCracks(ctx: Ctx, bot: Ellipse, rim: Ellipse, k: number) {
  if (k <= 0.01) return;
  const lines: readonly (readonly [number, number])[][] = [
    [
      [-0.3, 0.92],
      [-0.1, 0.72],
      [-0.25, 0.55],
      [0.05, 0.38],
    ],
    [
      [-0.1, 0.72],
      [0.25, 0.66],
      [0.4, 0.5],
    ],
    [
      [0.05, 0.38],
      [0.3, 0.3],
    ],
  ];
  ctx.save();
  ctx.globalAlpha = k;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [w, c] of [
    [4, "rgba(20,8,18,0.7)"],
    [1.5, "rgba(255,255,255,0.9)"],
  ] as const) {
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    for (const path of lines) {
      ctx.beginPath();
      path.forEach(([u, s], i) => {
        const cy = bot.cy + (rim.cy - bot.cy) * s;
        const rx = bot.rx + (rim.rx - bot.rx) * s;
        const x = bot.cx + u * rx;
        const y = cy + (bot.ry + (rim.ry - bot.ry) * s) * 0.9;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Wall clock: the coloured slice is what is left of the night; red in the last 15%. */
export function drawClock(ctx: Ctx, x: number, y: number, r: number, left: number, risk: boolean, t: number) {
  ctx.save();
  ctx.fillStyle = "#f4e6c8";
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.5, r * 0.12);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  ctx.fill();
  const f = Math.max(0, Math.min(1, left));
  if (f > 0) {
    ctx.fillStyle = f < 0.15 ? (Math.sin(t / 180) > 0 ? "#ff4d3d" : "#c0392b") : "#ffb84a";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r * 0.86, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, r * 0.1);
  const a = -Math.PI / 2 + f * Math.PI * 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8);
  ctx.stroke();
  if (risk) {
    ctx.strokeStyle = `rgba(255,77,61,${0.5 + 0.5 * Math.sin(t / 180)})`;
    ctx.lineWidth = r * 0.18;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.25, 0, 7);
    ctx.stroke();
  }
  ctx.restore();
}

/** Brass plaque with the player's name, from legend. */
export function drawPlaque(ctx: Ctx, x: number, y: number, w: number, name: string, tier: number, font: string) {
  if (tier < 4) return;
  const h = w * 0.34;
  ctx.save();
  ctx.fillStyle = GOLD;
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.3, w * 0.025);
  ctx.shadowColor = GOLD;
  ctx.shadowBlur = w * 0.15;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h * 0.2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.fillStyle = "#4a2a00";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${Math.round(h * 0.34)}px ${font}`;
  ctx.fillText(tier >= 5 ? "OWNER" : "LEGEND", x, y - h * 0.18);
  ctx.font = `700 ${Math.round(h * 0.3)}px ${font}`;
  const short = name.length > 14 ? `${name.slice(0, 13)}…` : name;
  ctx.fillText(short, x, y + h * 0.2);
  ctx.restore();
}

/** Stable pseudo-random 0..1 per index, so the coin pile does not reshuffle every frame. */
const jitter = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const COIN_TONES = ["#e8b23a", "#f4c95a", "#d39a24", "#c78a1c", "#f0bf48"] as const;

/**
 * The pot as a glass jar of coins on the counter (LC-025): a mason jar with a screw lid, coins piled
 * loosely in a mound up to `level` (0..1), glass glare over them, and a hand-written paper label.
 * `base` is the counter line, `h` the full height including the lid.
 */
export function drawJar(ctx: Ctx, x: number, base: number, h: number, font: string, level = 1) {
  const w = h * 0.78;
  const lw = Math.max(1.2, h * 0.028);
  const top = base - h;
  const lidH = h * 0.11;
  const neckY = top + lidH;
  const shoulderY = top + h * 0.3;
  const neckW = w * 0.62;
  const r = w * 0.16;
  const body = () => {
    ctx.beginPath();
    ctx.moveTo(x - neckW / 2, neckY);
    ctx.lineTo(x - neckW / 2, neckY + h * 0.04);
    ctx.bezierCurveTo(x - w / 2, neckY + h * 0.07, x - w / 2, shoulderY - h * 0.06, x - w / 2, shoulderY);
    ctx.lineTo(x - w / 2, base - r);
    ctx.quadraticCurveTo(x - w / 2, base, x - w / 2 + r, base);
    ctx.lineTo(x + w / 2 - r, base);
    ctx.quadraticCurveTo(x + w / 2, base, x + w / 2, base - r);
    ctx.lineTo(x + w / 2, shoulderY);
    ctx.bezierCurveTo(x + w / 2, shoulderY - h * 0.06, x + w / 2, neckY + h * 0.07, x + neckW / 2, neckY + h * 0.04);
    ctx.lineTo(x + neckW / 2, neckY);
    ctx.closePath();
  };
  ctx.save();
  // soft shadow on the counter
  ctx.fillStyle = "rgba(10,3,6,0.35)";
  ctx.beginPath();
  ctx.ellipse(x + w * 0.06, base + h * 0.015, w * 0.58, h * 0.035, 0, 0, 7);
  ctx.fill();
  // the glass, tinted by the bar behind it
  body();
  const glass = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  glass.addColorStop(0, "rgba(255,236,210,0.22)");
  glass.addColorStop(0.5, "rgba(255,236,210,0.08)");
  glass.addColorStop(1, "rgba(255,236,210,0.18)");
  ctx.fillStyle = glass;
  ctx.fill();

  // coins: a loose pile filling from the bottom, the top heaped in the middle
  if (level > 0) {
    ctx.save();
    body();
    ctx.clip();
    const floor = base - h * 0.035;
    const room = floor - (neckY + h * 0.06);
    const fill = floor - room * Math.min(1, level);
    const mound = h * 0.05 * Math.min(1, level * 3);
    const surface = (px: number) => fill - mound * (1 - ((px - x) / (w / 2)) ** 2);
    // dark gold mass under the visible coins, so gaps read as more coins deeper in
    ctx.beginPath();
    ctx.moveTo(x - w / 2, floor + h);
    for (let i = 0; i <= 12; i++) {
      const px = x - w / 2 + (w * i) / 12;
      ctx.lineTo(px, surface(px) + h * 0.03);
    }
    ctx.lineTo(x + w / 2, floor + h);
    ctx.closePath();
    ctx.fillStyle = "#8a5a12";
    ctx.fill();
    // a couple of folded bills poking out of the pile, as in any real tip jar
    if (level > 0.15) {
      const bills: readonly (readonly [number, number])[] = [
        [-0.18, -0.35],
        [0.2, 0.42],
      ];
      for (const [dx, rot] of bills) {
        const bx = x + dx * w;
        ctx.save();
        ctx.translate(bx, surface(bx) + h * 0.015);
        ctx.rotate(rot);
        ctx.fillStyle = "#7fb26a";
        ctx.strokeStyle = "#2f5a26";
        ctx.lineWidth = lw * 0.5;
        ctx.beginPath();
        ctx.rect(-w * 0.09, -h * 0.13, w * 0.18, h * 0.16);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = "rgba(47,90,38,0.6)";
        ctx.beginPath();
        ctx.ellipse(0, -h * 0.05, w * 0.04, h * 0.035, 0, 0, 7);
        ctx.stroke();
        ctx.restore();
      }
    }
    const rx = w * 0.12;
    const rowH = h * 0.042;
    const rows = Math.ceil((floor - fill + mound) / rowH) + 1;
    let n = 0;
    for (let row = 0; row < rows; row++) {
      const per = 5 + (row % 2);
      for (let k = 0; k < per; k++) {
        n++;
        const cx = x - w / 2 + ((k + 0.5 + (row % 2 ? -0.25 : 0.1)) / per) * w + (jitter(n, 1) - 0.5) * rx * 0.8;
        const cy = floor - row * rowH - (jitter(n, 2) - 0.5) * rowH * 0.6;
        if (cy < surface(cx)) continue;
        const ry = rx * (0.28 + jitter(n, 3) * 0.32);
        const rot = (jitter(n, 4) - 0.5) * 0.9;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        // the coin's edge, then its face
        ctx.fillStyle = "#7a4a0c";
        ctx.beginPath();
        ctx.ellipse(0, ry * 0.35, rx, ry, 0, 0, 7);
        ctx.fill();
        ctx.fillStyle = COIN_TONES[n % COIN_TONES.length] as string;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, 7);
        ctx.fill();
        ctx.strokeStyle = "rgba(90,50,8,0.75)";
        ctx.lineWidth = lw * 0.45;
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,246,200,0.7)";
        ctx.beginPath();
        ctx.ellipse(0, 0, rx * 0.62, ry * 0.62, 0, Math.PI * 1.1, Math.PI * 1.7);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // glare: a tall streak on the left, a thin one on the right, a sheen on the shoulder
  ctx.save();
  body();
  ctx.clip();
  // glass thickness: lit on the left, in shade on the right; contents soften towards both edges
  const edge = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  edge.addColorStop(0, "rgba(255,236,210,0.38)");
  edge.addColorStop(0.12, "rgba(255,236,210,0.06)");
  edge.addColorStop(0.8, "rgba(20,8,18,0)");
  edge.addColorStop(1, "rgba(20,8,18,0.42)");
  ctx.fillStyle = edge;
  ctx.fillRect(x - w / 2, top, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.32)";
  ctx.beginPath();
  ctx.roundRect(x - w * 0.36, shoulderY - h * 0.02, w * 0.09, base - shoulderY - h * 0.1, w * 0.05);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  ctx.roundRect(x + w * 0.3, shoulderY + h * 0.06, w * 0.04, (base - shoulderY) * 0.5, w * 0.02);
  ctx.fill();
  ctx.restore();
  // glints where the glass is thick: the shoulder and the heavy bottom
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = lw * 0.8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(x - w * 0.18, shoulderY + h * 0.02, w * 0.2, Math.PI * 1.15, Math.PI * 1.4);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - w * 0.3, base - h * 0.03);
  ctx.lineTo(x - w * 0.05, base - h * 0.03);
  ctx.stroke();
  // outline: thinner than the patrons' ink, glass reads lighter
  body();
  ctx.strokeStyle = INK;
  ctx.lineWidth = lw * 0.8;
  ctx.lineJoin = "round";
  ctx.stroke();
  // paper label, slightly crooked, hand-written
  ctx.save();
  ctx.translate(x, base - h * 0.4);
  ctx.rotate(-0.07);
  const labW = w * 0.7;
  const labH = h * 0.2;
  ctx.fillStyle = "#ead6a8";
  ctx.strokeStyle = "rgba(90,50,8,0.6)";
  ctx.lineWidth = lw * 0.5;
  ctx.beginPath();
  ctx.moveTo(-labW / 2, -labH / 2);
  ctx.lineTo(labW / 2, -labH / 2 + labH * 0.06);
  ctx.lineTo(labW / 2 - labW * 0.02, labH / 2);
  ctx.lineTo(-labW / 2 + labW * 0.03, labH / 2 - labH * 0.04);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#5a2a0e";
  ctx.font = `italic 900 ${Math.round(labH * 0.72)}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("POT", 0, labH * 0.04);
  ctx.restore();
  // screw lid: brass with ridges
  const lidW = neckW * 1.08;
  const brass = ctx.createLinearGradient(x - lidW / 2, 0, x + lidW / 2, 0);
  brass.addColorStop(0, "#7d5a1c");
  brass.addColorStop(0.35, "#e2b75a");
  brass.addColorStop(0.6, "#b88a33");
  brass.addColorStop(1, "#6b4a14");
  ctx.fillStyle = brass;
  ctx.beginPath();
  ctx.roundRect(x - lidW / 2, top, lidW, lidH, lidH * 0.25);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.strokeStyle = "rgba(40,20,4,0.55)";
  ctx.lineWidth = lw * 0.5;
  for (let i = 1; i < 6; i++) {
    const lx = x - lidW / 2 + (lidW * i) / 6;
    ctx.beginPath();
    ctx.moveTo(lx, top + lidH * 0.2);
    ctx.lineTo(lx, top + lidH * 0.8);
    ctx.stroke();
  }
  ctx.restore();
}

/** Where the goal rail stands, for the focus ring. */
export function goalRailBox(cw: number, ch: number, bar: number) {
  return { x0: cw * 0.44, x1: cw * 0.95, base: ch * bar + ch * 0.012, h: ch * 0.05 };
}

/**
 * The goal as a row of small glasses on the far edge of the counter. Up to ten glasses; with a bigger
 * goal each glass stands for several check-ins and fills in steps. All of them glow once the goal is hit.
 */
export function drawGoalRail(
  ctx: Ctx,
  box: ReturnType<typeof goalRailBox>,
  count: number,
  goal: number | null,
  t: number
) {
  if (goal === null || goal <= 0) return;
  const slots = Math.min(goal, 10);
  const filled = (Math.min(count, goal) / goal) * slots;
  const done = count >= goal;
  const step = (box.x1 - box.x0) / slots;
  const w = Math.min(step * 0.62, box.h * 0.62);
  ctx.save();
  ctx.lineWidth = Math.max(1, w * 0.08);
  for (let i = 0; i < slots; i++) {
    const cx = box.x0 + step * (i + 0.5);
    const top = box.base - box.h;
    const f = Math.max(0, Math.min(1, filled - i));
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, top);
      ctx.lineTo(cx + w / 2, top);
      ctx.lineTo(cx + w * 0.38, box.base);
      ctx.lineTo(cx - w * 0.38, box.base);
      ctx.closePath();
    };
    path();
    ctx.fillStyle = "rgba(255,240,220,0.12)";
    ctx.fill();
    if (f > 0) {
      ctx.save();
      path();
      ctx.clip();
      const y = box.base - box.h * f;
      ctx.fillStyle = "#f0a030";
      ctx.fillRect(cx - w, y, w * 2, box.base - y);
      if (f >= 1) {
        ctx.fillStyle = "#fff6e6";
        ctx.fillRect(cx - w, top, w * 2, box.h * 0.18);
      }
      ctx.restore();
    }
    path();
    ctx.strokeStyle = done ? GOLD : INK;
    if (done) {
      ctx.shadowColor = GOLD;
      ctx.shadowBlur = w * (0.8 + 0.4 * Math.sin(t / 300 + i));
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

/** Soft pulsing glow behind the one thing to touch. */
export function drawHalo(ctx: Ctx, x: number, y: number, r: number, t: number) {
  const a = 0.22 + 0.14 * Math.sin(t / 380);
  const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
  g.addColorStop(0, `rgba(255,184,74,${a})`);
  g.addColorStop(1, "rgba(255,184,74,0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  ctx.fill();
  ctx.restore();
}

/** Ring and a one-word label round an object the player asked about (HUD tap). `k` fades it out. */
export function drawFocus(
  ctx: Ctx,
  x: number,
  y: number,
  rx: number,
  ry: number,
  label: string,
  k: number,
  t: number,
  font: string
) {
  if (k <= 0) return;
  const pulse = 1 + 0.08 * Math.sin(t / 140);
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 2);
  ctx.strokeStyle = "#ffb84a";
  ctx.shadowColor = "#ffb84a";
  ctx.shadowBlur = 12;
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.lineDashOffset = -t / 30;
  ctx.beginPath();
  ctx.ellipse(x, y, rx * pulse, ry * pulse, 0, 0, 7);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  ctx.font = `900 14px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const ty = y - ry * pulse - 6;
  const tw = ctx.measureText(label).width + 14;
  ctx.fillStyle = "#1a0d16ee";
  ctx.beginPath();
  ctx.roundRect(x - tw / 2, ty - 22, tw, 22, 11);
  ctx.fill();
  ctx.fillStyle = "#ffb84a";
  ctx.fillText(label, x, ty - 4);
  ctx.restore();
}

export interface Confetto {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  c: string;
  life: number;
}

const CONFETTI_COLOURS = [NEON, GOLD, "#7d6bff", "#8fe3a8", "#ffb84a"];

export function burstConfetti(list: Confetto[], cw: number, ch: number, n: number) {
  for (let i = 0; i < n; i++)
    list.push({
      x: cw * (0.2 + Math.random() * 0.6),
      y: ch * 0.35,
      vx: (Math.random() - 0.5) * cw * 1.2,
      vy: -ch * (0.4 + Math.random() * 0.5),
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 12,
      c: CONFETTI_COLOURS[i % CONFETTI_COLOURS.length] as string,
      life: 1,
    });
}

export function stepConfetti(ctx: Ctx, list: Confetto[], ch: number, dt: number, size: number) {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i] as Confetto;
    p.vy += ch * 1.4 * dt;
    p.vx *= 0.985;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.life -= dt * 0.45;
    if (p.life <= 0 || p.y > ch + 20) {
      list.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life * 2);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.c;
    ctx.fillRect(-size / 2, -size / 4, size, size / 2);
    ctx.restore();
  }
}

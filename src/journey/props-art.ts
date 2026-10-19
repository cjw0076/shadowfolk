/**
 * Sumi-ink-on-washi stage prop painters for the Night Journey (Shadowfolk v2).
 *
 * Every painter is pure, deterministic, has no timers or DOM attachment, and
 * returns a CPU-backed HTMLCanvasElement (`willReadFrequently: true`) so its
 * WebGL upload comes from plain memory without GPU-canvas-copy stalls.
 */
import { PIXELS_PER_METRE } from '../theater/stencil-raster.js';

/** Paper pixels per screen metre (matches `painter.ts`). */
export const PX = PIXELS_PER_METRE;
export const SUMI_INK = '#23160f';
export const SUMI_DEEP = '#160d09';
export const SUMI_WASH = 'rgba(42, 38, 44, 0.82)';

/**
 * Create a CPU-backed canvas (`willReadFrequently: true`) matching `painter.ts`.
 */
function cpuCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/** Convert a size argument that may be in paper pixels (> 4) or screen metres (<= 4) to pixels. */
function toPx(value: number, fallbackPx: number, minPx = 32): number {
  if (!Number.isFinite(value) || value <= 0) return fallbackPx;
  const px = value <= 4 ? Math.round(value * PX) : Math.round(value);
  return Math.max(minPx, px);
}

/** Deterministic LCG PRNG for repeatable sumi grain and brush wisps. */
function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Apply the painter's signature sumi-ink finish:
 * 1) soft penumbra under-blur (`rgba(42,47,58,0.85)`)
 * 2) crisp sumi core (`#23160f`)
 * 3) `source-atop` washi fibre grain speckles
 * 4) organic ink-bleed edge wisps
 */
function finishSumiInk(
  width: number,
  height: number,
  seed: number,
  drawShape: (ctx: CanvasRenderingContext2D) => void,
  blurPx = 3,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const [c, ctx] = cpuCanvas(width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 1. Soft penumbra bleed
  ctx.save();
  ctx.filter = `blur(${blurPx}px)`;
  ctx.fillStyle = SUMI_WASH;
  ctx.strokeStyle = SUMI_WASH;
  drawShape(ctx);
  ctx.restore();

  // 2. Dense sumi ink core
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = SUMI_INK;
  ctx.strokeStyle = SUMI_INK;
  drawShape(ctx);
  ctx.restore();

  // 3. Washi paper grain inside the ink (`source-atop`)
  const rng = makeRng(seed);
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  const specks = Math.round((width * height) / 85);
  for (let i = 0; i < specks; i++) {
    const x = rng() * width;
    const y = rng() * height;
    ctx.fillStyle = i % 3 === 0 ? 'rgba(8, 6, 8, 0.12)' : 'rgba(242, 228, 202, 0.065)';
    ctx.fillRect(x, y, i % 5 === 0 ? 2 : 1, 1);
  }
  ctx.restore();

  // 4. Sumi edge wisps along alpha contour
  const img = ctx.getImageData(0, 0, width, height).data;
  ctx.save();
  for (let row = 10; row < height - 10; row += 4) {
    for (let col = 10; col < width - 10; col += 4) {
      const idx = (row * width + col) * 4;
      const a = img[idx + 3];
      if (a < 45 || a > 205) continue;
      const flow = Math.sin(col * 0.29 + row * 0.19 + seed * 0.01) * Math.cos(col * 0.08 - row * 0.23);
      if (flow < 0.34) continue;
      const gx = img[idx + 7] - img[idx - 1];
      const gy = img[idx + width * 4 + 3] - img[idx - width * 4 + 3];
      const len = Math.hypot(gx, gy);
      if (len < 16) continue;
      const reach = 6 + 7 * flow;
      const drift = 4 * Math.sin(col * 0.11 - row * 0.13);
      const ex = col - (gx / len) * reach - (gy / len) * drift;
      const ey = row - (gy / len) * reach + (gx / len) * drift;
      const grad = ctx.createLinearGradient(col, row, ex, ey);
      grad.addColorStop(0, 'rgba(35, 22, 15, 0.35)');
      grad.addColorStop(1, 'rgba(35, 22, 15, 0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 0.7 + flow * 0.7;
      ctx.beginPath();
      ctx.moveTo(col, row);
      ctx.quadraticCurveTo((col + ex) * 0.5 + drift * 0.35, (row + ey) * 0.5, ex, ey);
      ctx.stroke();
    }
  }
  ctx.restore();

  return [c, ctx];
}

/** Paint a tiny warm amber eye glint matching woken shadow creatures. */
function paintAmberEye(ctx: CanvasRenderingContext2D, x: number, y: number, radius = 3.6): void {
  ctx.save();
  const halo = ctx.createRadialGradient(x, y, 0.5, x, y, radius * 2.8);
  halo.addColorStop(0, 'rgba(255, 229, 156, 0.98)');
  halo.addColorStop(0.45, 'rgba(217, 143, 63, 0.78)');
  halo.addColorStop(1, 'rgba(217, 143, 63, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, radius * 2.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffd985';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x - radius * 0.28, y - radius * 0.28, Math.max(1, radius * 0.26), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Crow obstacle (`136 × 128` px).
 * - `perched = true`: hunched sentinel crow facing left on a low twig/stone.
 * - `perched = false`: startled crow rearing back, beak open, wings flaring up.
 */
export function crow(perched = true): HTMLCanvasElement {
  const W = 136, H = 128;
  const [c, ctx] = finishSumiInk(W, H, perched ? 0x101c01 : 0x101c02, (g) => {
    if (perched) {
      // Perch rock/branch base
      g.beginPath();
      g.ellipse(68, 108, 22, 6, -0.08, 0, Math.PI * 2);
      g.fill();

      // Legs & talons
      g.lineWidth = 3.2;
      g.beginPath();
      g.moveTo(62, 86); g.lineTo(59, 104);
      g.moveTo(71, 86); g.lineTo(69, 104);
      g.stroke();

      // Body (hunched oval tilted forward-left)
      g.beginPath();
      g.ellipse(68, 68, 25, 19, -0.42, 0, Math.PI * 2);
      g.fill();

      // Folded wing tips & primary feathers
      g.beginPath();
      g.moveTo(56, 54);
      g.quadraticCurveTo(88, 56, 102, 82);
      g.quadraticCurveTo(78, 80, 56, 70);
      g.closePath();
      g.fill();

      // Tail feathers angled down-right
      for (let i = 0; i < 3; i++) {
        g.lineWidth = 5 - i * 0.8;
        g.beginPath();
        g.moveTo(86, 76 + i * 2);
        g.quadraticCurveTo(104, 86 + i * 4, 118 - i * 3, 96 + i * 5);
        g.stroke();
      }

      // Head & neck ruffle
      g.beginPath();
      g.arc(46, 48, 13.5, 0, Math.PI * 2);
      g.fill();

      // Heavy curved crow beak (closed, pointing left)
      g.beginPath();
      g.moveTo(36, 42);
      g.quadraticCurveTo(21, 44, 16, 50);
      g.quadraticCurveTo(25, 53, 38, 52);
      g.closePath();
      g.fill();
    } else {
      // Startled crow: lifting off, beak wide open, wings thrown high
      g.lineWidth = 2.8;
      g.beginPath();
      g.moveTo(64, 88); g.lineTo(58, 102);
      g.moveTo(73, 88); g.lineTo(70, 101);
      g.stroke();

      // Body rearing back
      g.beginPath();
      g.ellipse(68, 66, 23, 17, -0.75, 0, Math.PI * 2);
      g.fill();

      // Flared upper wing
      g.beginPath();
      g.moveTo(62, 56);
      g.quadraticCurveTo(66, 22, 104, 14);
      g.quadraticCurveTo(96, 44, 76, 62);
      g.closePath();
      g.fill();

      // Feather fingers on raised wing
      for (let f = 0; f < 4; f++) {
        g.lineWidth = 3.8 - f * 0.5;
        g.beginPath();
        g.moveTo(82 + f * 4, 34 + f * 5);
        g.lineTo(106 + f * 3, 18 + f * 8);
        g.stroke();
      }

      // Fanned tail
      for (let i = -1; i <= 1; i++) {
        g.lineWidth = 4.5;
        g.beginPath();
        g.moveTo(82, 76);
        g.lineTo(112, 88 + i * 8);
        g.stroke();
      }

      // Head & open cawing beak
      g.beginPath();
      g.arc(48, 44, 13, 0, Math.PI * 2);
      g.fill();

      g.lineWidth = 4.2;
      g.beginPath();
      g.moveTo(38, 40); g.lineTo(18, 35);
      g.moveTo(38, 46); g.lineTo(20, 51);
      g.stroke();
    }
  });

  paintAmberEye(ctx, perched ? 42 : 44, perched ? 46 : 42, 3.2);
  return c;
}

/**
 * Flying crow animation frame (`frame` 0..3, `148 × 128` px).
 * - `0`: high upstroke
 * - `1`: forward glide / mid-downstroke
 * - `2`: deep downstroke
 * - `3`: recovery upstroke
 */
export function crowFlying(frame: number): HTMLCanvasElement {
  const f = ((Math.round(frame) % 4) + 4) % 4;
  const W = 148, H = 128;
  const [c, ctx] = finishSumiInk(W, H, 0x202c00 + f, (g) => {
    const bodyY = [66, 62, 54, 60][f];
    const tilt = [-0.22, -0.14, -0.28, -0.18][f];

    // Streamlined body flying right-upward
    g.beginPath();
    g.ellipse(72, bodyY, 24, 12.5, tilt, 0, Math.PI * 2);
    g.fill();

    // Head & forward-pointing beak (facing right as it flees)
    const hx = 96, hy = bodyY - 8;
    g.beginPath();
    g.arc(hx, hy, 10.5, 0, Math.PI * 2);
    g.fill();

    g.beginPath();
    g.moveTo(hx + 8, hy - 4);
    g.lineTo(hx + 25, hy - 1);
    g.lineTo(hx + 8, hy + 5);
    g.closePath();
    g.fill();

    // Fanned tail trailing left
    for (let t = -1; t <= 1; t++) {
      g.lineWidth = 4.5;
      g.beginPath();
      g.moveTo(50, bodyY + 4);
      g.quadraticCurveTo(32, bodyY + 10 + t * 5, 18, bodyY + 14 + t * 9);
      g.stroke();
    }

    // Wingbeat geometry per frame
    const wingTipX = [56, 76, 68, 48][f];
    const wingTipY = [14, 34, 106, 26][f];
    const wingMidX = [64, 84, 82, 58][f];
    const wingMidY = [34, 46, 84, 42][f];

    g.beginPath();
    g.moveTo(64, bodyY - 2);
    g.quadraticCurveTo(wingMidX - 12, wingMidY, wingTipX, wingTipY);
    g.quadraticCurveTo(wingMidX + 16, wingMidY + 4, 84, bodyY + 2);
    g.closePath();
    g.fill();

    // Primary wing-tip feathers
    for (let k = 0; k < 4; k++) {
      const spreadX = wingTipX - 10 + k * 7;
      const spreadY = wingTipY + (f === 2 ? -k * 4 : k * 5);
      g.lineWidth = 3.6 - k * 0.4;
      g.beginPath();
      g.moveTo(wingMidX, wingMidY);
      g.lineTo(spreadX, spreadY);
      g.stroke();
    }
  });

  const bodyY = [66, 62, 54, 60][f];
  paintAmberEye(ctx, 99, bodyY - 9, 2.7);
  return c;
}

/**
 * Hanging vine/thread curtain (`144 × 280` px).
 * - `cutAt = null`: intact braided sumi vines from top to bottom with thorny leaves.
 * - `cutAt = number`: severed at `cutAt` (`0..1` normalized Y or pixel Y), parting with recoiling ends.
 */
export function vineCurtain(cutAt: number | null = null): HTMLCanvasElement {
  const W = 144, H = 280;
  const isCut = cutAt !== null && cutAt !== undefined && Number.isFinite(cutAt);
  const cutY = isCut
    ? (cutAt! <= 1 ? clamp01(cutAt!) * (H - 80) + 40 : Math.max(40, Math.min(H - 40, cutAt!)))
    : -1;

  const [c, ctx] = finishSumiInk(W, H, isCut ? 0x303002 : 0x303001, (g) => {
    const strands = [38, 62, 84, 106];
    const gapHalf = 34;

    for (let s = 0; s < strands.length; s++) {
      const baseX = strands[s];
      const mainStrand = s === 1 || s === 2;
      g.lineWidth = mainStrand ? 5.2 : 3.4;

      if (!isCut) {
        g.beginPath();
        g.moveTo(baseX, 4);
        for (let y = 16; y <= H - 6; y += 16) {
          const wave = Math.sin(y * 0.045 + s * 1.4) * (mainStrand ? 7 : 5);
          g.lineTo(baseX + wave, y);
        }
        g.stroke();
      } else {
        // Upper severed half (recoils & curls outward)
        const upperEnd = Math.max(20, cutY - gapHalf + (s % 2 === 0 ? -6 : 4));
        g.beginPath();
        g.moveTo(baseX, 4);
        for (let y = 16; y <= upperEnd; y += 14) {
          const recoil = y > upperEnd - 28 ? (s < 2 ? -12 : 12) * ((y - (upperEnd - 28)) / 28) : 0;
          const wave = Math.sin(y * 0.05 + s * 1.4) * 6 + recoil;
          g.lineTo(baseX + wave, y);
        }
        g.stroke();

        // Lower severed half (drops & frays)
        const lowerStart = Math.min(H - 20, cutY + gapHalf + (s % 2 === 0 ? 5 : -4));
        g.beginPath();
        g.moveTo(baseX + (s < 2 ? -10 : 10), lowerStart);
        for (let y = lowerStart + 14; y <= H - 6; y += 14) {
          const wave = Math.sin(y * 0.05 + s * 1.4) * 6;
          g.lineTo(baseX + wave, y);
        }
        g.stroke();
      }

      // Pointed sumi leaves along the vine
      for (let y = 28; y < H - 24; y += 32) {
        if (isCut && Math.abs(y - cutY) < gapHalf + 8) continue;
        const wx = baseX + Math.sin(y * 0.045 + s * 1.4) * 6;
        const dir = (y + s * 17) % 2 === 0 ? 1 : -1;
        g.beginPath();
        g.ellipse(wx + dir * 9, y, 8, 3.3, dir * 0.45, 0, Math.PI * 2);
        g.fill();
      }
    }
  });

  // Subtle amber node where the beak/claws snip, or scattered amber sparks when cut
  if (!isCut) {
    paintAmberEye(ctx, 73, H * 0.5, 2.8);
  } else {
    paintAmberEye(ctx, 56, cutY - 12, 2.2);
    paintAmberEye(ctx, 88, cutY + 10, 2.2);
  }
  return c;
}

/**
 * Painted sumi-ink ground path (`width × 96` px) with optional chasm `gaps`.
 * Each `[x0, x1]` in `gaps` may be in paper pixels or normalized `0..1` of `width`.
 */
export function groundLine(
  width: number,
  gaps: ReadonlyArray<readonly [number, number]> = [],
): HTMLCanvasElement {
  const W = toPx(width, PX, 128);
  const H = 96;
  const normGaps = gaps.map(([a, b]) => {
    const scale = Math.abs(a) <= 1 && Math.abs(b) <= 1 && W > 10 ? W : 1;
    const x0 = Math.max(0, Math.min(W, Math.min(a, b) * scale));
    const x1 = Math.max(0, Math.min(W, Math.max(a, b) * scale));
    return [x0, x1] as const;
  }).filter(([x0, x1]) => x1 - x0 >= 4).sort((u, v) => u[0] - v[0]);

  // Build solid segments between gaps
  const segments: [number, number][] = [];
  let cursor = 8;
  for (const [gx0, gx1] of normGaps) {
    if (gx0 > cursor + 6) segments.push([cursor, gx0]);
    cursor = Math.max(cursor, gx1);
  }
  if (cursor < W - 8) segments.push([cursor, W - 8]);

  const [c] = finishSumiInk(W, H, 0x404001 + normGaps.length, (g) => {
    const baseY = 38;
    for (const [sx0, sx1] of segments) {
      // Main calligrapher's brush stroke
      g.beginPath();
      g.moveTo(sx0, baseY + 6);
      for (let x = sx0; x <= sx1; x += 12) {
        const undulate = Math.sin(x * 0.025) * 3.5 + Math.cos(x * 0.07) * 1.5;
        g.lineTo(x, baseY + undulate);
      }
      for (let x = sx1; x >= sx0; x -= 12) {
        const thickness = 23 + Math.sin(x * 0.031 + 1.2) * 5;
        const undulate = Math.sin(x * 0.025) * 3.5;
        g.lineTo(x, baseY + undulate + thickness);
      }
      g.closePath();
      g.fill();

      // Steep cliff drop-offs at gap edges
      if (sx0 > 12) {
        g.beginPath();
        g.moveTo(sx0, baseY);
        g.quadraticCurveTo(sx0 + 6, baseY + 26, sx0 + 14, H - 6);
        g.lineTo(sx0 + 24, baseY + 14);
        g.closePath();
        g.fill();
      }
      if (sx1 < W - 12) {
        g.beginPath();
        g.moveTo(sx1, baseY);
        g.quadraticCurveTo(sx1 - 6, baseY + 26, sx1 - 14, H - 6);
        g.lineTo(sx1 - 24, baseY + 14);
        g.closePath();
        g.fill();
      }

      // Organic grass tufts and ink pebbles along the segment
      const segRng = makeRng(0x404999 + Math.round(sx0));
      let gx = sx0 + 14 + segRng() * 14;
      while (gx < sx1 - 14) {
        const y = baseY + Math.sin(gx * 0.025) * 3.5;
        if (segRng() < 0.68) {
          const blades = 1 + Math.floor(segRng() * 3);
          for (let b = 0; b < blades; b++) {
            const bx = gx + (b - 1) * 3.5;
            const lean = (segRng() - 0.45) * 9;
            const bh = 6 + segRng() * 8;
            g.lineWidth = 1.6 + segRng() * 1.1;
            g.beginPath();
            g.moveTo(bx, y + 2);
            g.quadraticCurveTo(bx + lean * 0.4, y - bh * 0.55, bx + lean, y - bh);
            g.stroke();
          }
        } else {
          // Small sumi pebble resting on the path
          g.beginPath();
          g.ellipse(gx, y + 0.5, 3.2 + segRng() * 2.5, 1.8 + segRng() * 1.2, (segRng() - 0.5) * 0.4, 0, Math.PI * 2);
          g.fill();
        }
        gx += 22 + segRng() * 32;
      }
    }
  });

  return c;
}

/**
 * Swirling sumi-wash fog bank (`280 × 176` px).
 * `clear01` (`0..1`) parts the mist from dense bank (`0`) to dispersed wisps (`1`).
 */
export function fogBank(clear01: number): HTMLCanvasElement {
  const k = clamp01(clear01);
  const W = 280, H = 176;
  const [c, ctx] = cpuCanvas(W, H);
  const rng = makeRng(0x505001);

  const puffs = [
    { x: 96, y: 88, rx: 68, ry: 34, dir: -1 },
    { x: 184, y: 86, rx: 72, ry: 36, dir: 1 },
    { x: 138, y: 62, rx: 62, ry: 28, dir: -1 },
    { x: 144, y: 114, rx: 76, ry: 30, dir: 1 },
    { x: 74, y: 116, rx: 52, ry: 24, dir: -1 },
    { x: 206, y: 64, rx: 54, ry: 25, dir: 1 },
  ];

  const alphaScale = (1 - k * 0.86);
  ctx.save();
  ctx.filter = `blur(${Math.round(8 + k * 6)}px)`;
  for (let i = 0; i < puffs.length; i++) {
    const p = puffs[i];
    const shiftX = p.dir * k * (52 + i * 8);
    const shiftY = (i % 2 === 0 ? -1 : 1) * k * 14;
    const cx = p.x + shiftX;
    const cy = p.y + shiftY;
    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, p.rx);
    grad.addColorStop(0, `rgba(35, 22, 15, ${(0.76 * alphaScale).toFixed(3)})`);
    grad.addColorStop(0.55, `rgba(48, 38, 42, ${(0.48 * alphaScale).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(48, 38, 42, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, p.rx * (1 + k * 0.15), p.ry * (1 - k * 0.25), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Calligraphic wind-curl ribbons inside the fog
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(28, 18, 14, ${(0.52 * alphaScale).toFixed(3)})`;
  ctx.lineWidth = 3.2;
  for (let i = 0; i < 4; i++) {
    const dir = i % 2 === 0 ? -1 : 1;
    const bx = 140 + dir * (24 + k * 58);
    const by = 48 + i * 26;
    ctx.beginPath();
    ctx.moveTo(bx - dir * 38, by);
    ctx.bezierCurveTo(bx, by - 14, bx + dir * 28, by + 14, bx + dir * 48, by - 4);
    ctx.stroke();
  }

  // Washi grain
  ctx.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 420; i++) {
    const x = rng() * W;
    const y = rng() * H;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(244, 231, 208, 0.08)' : 'rgba(18, 12, 10, 0.09)';
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  ctx.restore();

  return c;
}

/**
 * Heavy craggy sumi-ink boulder (`180 × 164` px).
 * `rolled01` (`0..1`) rotates the boulder's facets and carved spiral seal.
 */
export function boulder(rolled01: number): HTMLCanvasElement {
  const k = clamp01(rolled01);
  const angle = k * Math.PI * 1.35;
  const W = 180, H = 164;
  const cx = 90, cy = 84, radius = 56;

  const [c, ctx] = finishSumiInk(W, H, 0x606001 + Math.round(k * 100), (g) => {
    // Faceted rock polygon rotated by `angle`
    const lobes = 11;
    g.beginPath();
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2 + angle;
      const rVar = radius * (0.88 + 0.12 * Math.sin(i * 2.7 + 0.5) + 0.06 * Math.cos(i * 4.1));
      const px = cx + Math.cos(a) * rVar;
      const py = cy + Math.sin(a) * rVar * 0.94;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();

    // Ground contact shadow & rolling dust puffs when rolled01 > 0
    g.beginPath();
    g.ellipse(cx, 142, 46, 7, 0, 0, Math.PI * 2);
    g.fill();

    if (k > 0.02) {
      for (let d = 0; d < 3; d++) {
        const dx = cx - 42 - d * 14 * k;
        const dy = 136 - d * 6;
        g.beginPath();
        g.arc(dx, dy, 7 + d * 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  });

  // Inner rock fracture lines & faint amber spiral rune rotating with the boulder
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = 'rgba(244, 224, 186, 0.22)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  for (let t = 0; t < 28; t++) {
    const a = t * 0.38;
    const r = 3 + t * 1.15;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (t === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  return c;
}

/**
 * Narrow rock crevice obstacle (`width × 260` px) that only a Tiny shadow can thread.
 */
export function crack(width: number): HTMLCanvasElement {
  const W = Math.max(96, Math.min(240, toPx(width, 136, 96)));
  const H = 260;
  const midX = W * 0.5;

  const [c, ctx] = finishSumiInk(W, H, 0x707001 + W, (g) => {
    // Upper massive rock pillar hanging down, leaving a narrow jagged slot near y = 148..198
    g.beginPath();
    g.moveTo(14, 6);
    g.lineTo(W - 14, 6);
    g.lineTo(W - 18, 134);
    g.lineTo(midX + 18, 152);
    g.lineTo(midX - 6, 138);
    g.lineTo(18, 146);
    g.closePath();
    g.fill();

    // Lower rock base rising up beneath the narrow crevice
    g.beginPath();
    g.moveTo(16, 198);
    g.lineTo(midX - 10, 184);
    g.lineTo(midX + 16, 196);
    g.lineTo(W - 16, 186);
    g.lineTo(W - 12, H - 6);
    g.lineTo(12, H - 6);
    g.closePath();
    g.fill();
  });

  // Warm amber rim light inside the narrow crevice passage
  ctx.save();
  const glow = ctx.createRadialGradient(midX, 168, 2, midX, 168, 34);
  glow.addColorStop(0, 'rgba(255, 224, 146, 0.55)');
  glow.addColorStop(1, 'rgba(255, 224, 146, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(midX, 168, 34, 18, -0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  return c;
}

/**
 * High cliff ledge (`200 × height` px) that requires Fly (or ramp Hop) to ascend.
 */
export function ledge(height: number): HTMLCanvasElement {
  const H = Math.max(120, Math.min(340, toPx(height, 220, 120)));
  const W = 200;

  const [c, ctx] = finishSumiInk(W, H, 0x808001 + H, (g) => {
    // Overhanging upper platform & vertical cliff face on the right
    g.beginPath();
    g.moveTo(24, 28);
    g.lineTo(W - 12, 24);
    g.lineTo(W - 10, H - 8);
    g.lineTo(92, H - 8);
    g.lineTo(86, 84);
    g.quadraticCurveTo(56, 68, 20, 44);
    g.closePath();
    g.fill();

    // Hanging root tendrils under the overhang
    g.lineWidth = 2.6;
    for (let i = 0; i < 3; i++) {
      const rx = 42 + i * 16;
      const ry = 52 + i * 8;
      g.beginPath();
      g.moveTo(rx, ry);
      g.quadraticCurveTo(rx - 4, ry + 18, rx + 3, ry + 34 + i * 6);
      g.stroke();
    }
  });

  // Dry-brush vertical cliff striations
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.strokeStyle = 'rgba(242, 226, 198, 0.11)';
  ctx.lineWidth = 2;
  for (let x = 104; x < W - 18; x += 14) {
    ctx.beginPath();
    ctx.moveTo(x, 36);
    ctx.lineTo(x - 4, H - 16);
    ctx.stroke();
  }
  ctx.restore();

  return c;
}

/**
 * The lantern's living spark (`96 × 96` px) carried by the player's shadow creature.
 * `glow01` (`0..1`) controls the halo bloom and ember mote intensity.
 */
export function spark(glow01: number): HTMLCanvasElement {
  const k = clamp01(glow01);
  const W = 96, H = 96;
  const cx = 48, cy = 48;
  const [c, ctx] = cpuCanvas(W, H);

  // Outer warm lantern bloom
  const outerR = 26 + k * 18;
  const halo = ctx.createRadialGradient(cx, cy, 2, cx, cy, outerR);
  halo.addColorStop(0, `rgba(255, 248, 220, ${(0.95 + 0.05 * k).toFixed(3)})`);
  halo.addColorStop(0.28, `rgba(255, 214, 118, ${(0.82 + 0.14 * k).toFixed(3)})`);
  halo.addColorStop(0.62, `rgba(232, 132, 42, ${(0.38 + 0.25 * k).toFixed(3)})`);
  halo.addColorStop(1, 'rgba(232, 132, 42, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.fill();

  // Delicate ink ring framing the ember so it reads on bright washi paper too
  ctx.strokeStyle = 'rgba(58, 32, 16, 0.38)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(cx, cy, 10.5 + k * 2.5, 0, Math.PI * 2);
  ctx.stroke();

  // Four-pointed warm starlight rays
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = `rgba(255, 244, 204, ${(0.65 + 0.3 * k).toFixed(3)})`;
  const rayLen = 14 + k * 10;
  ctx.beginPath();
  ctx.ellipse(0, 0, rayLen, 2.4, 0, 0, Math.PI * 2);
  ctx.ellipse(0, 0, 2.4, rayLen, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Bright tear-shaped flame core
  ctx.fillStyle = '#fffdf4';
  ctx.beginPath();
  ctx.arc(cx, cy, 5.5 + k * 1.8, 0, Math.PI * 2);
  ctx.fill();

  // Orbiting ember motes
  for (let i = 0; i < 6; i++) {
    const a = i * 1.047 + k * 0.8;
    const r = 13 + (i % 2) * 6 + k * 6;
    const mx = cx + Math.cos(a) * r;
    const my = cy + Math.sin(a) * r;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255, 230, 150, 0.85)' : 'rgba(240, 155, 65, 0.7)';
    ctx.beginPath();
    ctx.arc(mx, my, 1.5 + (i % 2) * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  return c;
}

/**
 * The Moon Hole goal (`144 × 144` px) on the far side of the paper:
 * a charred deckle-edge cut-out in the washi screen revealing warm moonlight and a crescent cradle.
 */
export function moonHole(): HTMLCanvasElement {
  const W = 144, H = 144;
  const cx = 72, cy = 72, R = 44;
  const [c, ctx] = cpuCanvas(W, H);

  // Soft outer moonlight spill onto surrounding paper
  const spill = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.55);
  spill.addColorStop(0, 'rgba(255, 232, 175, 0.85)');
  spill.addColorStop(0.55, 'rgba(235, 165, 78, 0.38)');
  spill.addColorStop(1, 'rgba(235, 165, 78, 0)');
  ctx.fillStyle = spill;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.55, 0, Math.PI * 2);
  ctx.fill();

  // Deckle-edged charred paper rim (matches `cut` layer in `stencil-raster.ts`)
  const rimRings: { r: number; color: string }[] = [
    { r: R + 7, color: '#2e1408' },
    { r: R + 4.5, color: '#42220f' },
    { r: R + 2, color: '#b2682a' },
    { r: R, color: '#fff2d1' },
  ];

  for (const ring of rimRings) {
    ctx.fillStyle = ring.color;
    ctx.beginPath();
    const steps = 48;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const wobble = 1.6 * Math.sin(a * 7 + 0.4) + 1.1 * Math.cos(a * 11 - 0.8);
      const rad = ring.r + wobble;
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Subtle sumi crescent shadow cradling the inner left rim of the moon hole
  ctx.save();
  ctx.fillStyle = 'rgba(46, 20, 8, 0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, R - 3, 0, Math.PI * 2);
  ctx.arc(cx + 10, cy - 4, R - 6, 0, Math.PI * 2, true);
  ctx.fill();
  ctx.restore();

  return c;
}

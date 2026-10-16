/**
 * Shadow silhouettes as binary masks: projection of hand joints onto a plane,
 * capsule/polygon rasterisation, and a translation/scale/rotation tolerant
 * shape comparison (IoU) used to decide whether a hand shadow fits a target.
 * Pure math, no DOM — shared by the runtime, target baking and node tests.
 */
import { BONES, HandPose, JOINT_COUNT, PALM } from './hand-model.js';

/**
 * Stage geometry every template is baked for: distance from the lantern to
 * the paper, from the lantern to where a hand naturally hovers, and how far
 * the cut-out centre sits above the lantern (the light is cast upward).
 */
export const STAGE = { lightToScreen: 0.75, lightToHand: 0.3, lightDrop: 0.26 };

/** A hand flattened onto the screen plane: 2D joint centres and radii (metres). */
export class FlatHand {
  readonly x = new Float32Array(JOINT_COUNT);
  readonly y = new Float32Array(JOINT_COUNT);
  readonly r = new Float32Array(JOINT_COUNT);
  valid = false;
}

/** Orthographic flattening (targets): drop hand-space Z. */
export function flattenOrtho(p: HandPose, out: FlatHand): FlatHand {
  for (let j = 0; j < JOINT_COUNT; j++) {
    out.x[j] = p.mats[j * 16 + 12];
    out.y[j] = p.mats[j * 16 + 13];
    out.r[j] = p.radii[j];
  }
  out.valid = true;
  return out;
}

/**
 * Point-light projection onto the screen. Joint positions are world-space
 * xyz triples; the screen is origin + basis (right, up) with normal facing
 * the light. Radii grow with the magnification of the shadow.
 */
export interface ScreenFrame {
  ox: number; oy: number; oz: number; // screen centre
  rx: number; ry: number; rz: number; // unit right
  ux: number; uy: number; uz: number; // unit up
  nx: number; ny: number; nz: number; // unit normal, pointing toward the light
}

export function projectFromLight(
  joints: Float32Array, // JOINT_COUNT * 3 world positions
  radii: Float32Array,
  lx: number, ly: number, lz: number,
  s: ScreenFrame,
  out: FlatHand,
): FlatHand {
  // Distance from light to screen plane along the normal.
  const hLight = (lx - s.ox) * s.nx + (ly - s.oy) * s.ny + (lz - s.oz) * s.nz;
  out.valid = hLight > 0.01;
  if (!out.valid) return out;
  for (let j = 0; j < JOINT_COUNT; j++) {
    const px = joints[j * 3], py = joints[j * 3 + 1], pz = joints[j * 3 + 2];
    const hP = (px - s.ox) * s.nx + (py - s.oy) * s.ny + (pz - s.oz) * s.nz;
    // Clamp joints that stray behind the screen or past the light so a hand
    // brushing the lantern still casts a (huge) shadow instead of vanishing.
    const h = hP < 0.002 ? 0.002 : hP > hLight - 0.03 ? hLight - 0.03 : hP;
    const t = hLight / (hLight - h); // magnification
    const dx = px - lx, dy = py - ly, dz = pz - lz;
    const qx = lx + dx * t - s.ox, qy = ly + dy * t - s.oy, qz = lz + dz * t - s.oz;
    out.x[j] = qx * s.rx + qy * s.ry + qz * s.rz;
    out.y[j] = qx * s.ux + qy * s.uy + qz * s.uz;
    out.r[j] = radii[j] * t;
  }
  return out;
}

/** Binary raster over a rectangle of the plane. */
export class Mask {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    public x0: number, // plane coordinate of the left edge
    public y0: number, // plane coordinate of the bottom edge
    public cell: number, // metres per cell
  ) {
    this.data = new Uint8Array(w * h);
  }
  clear(): void { this.data.fill(0); }

  capsule(ax: number, ay: number, bx: number, by: number, ra: number, rb: number): void {
    const { w, h, x0, y0, cell, data } = this;
    const rmax = Math.max(ra, rb);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - rmax - x0) / cell));
    const i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + rmax - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - rmax - y0) / cell));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(ay, by) + rmax - y0) / cell));
    const ex = bx - ax, ey = by - ay;
    const len2 = ex * ex + ey * ey || 1e-12;
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const index = j * w + i;
        // Capsules only add ink. Overlapping palms/fingers cannot change ink
        // already in the union, especially when magnified near the lantern.
        if (data[index] === 1) continue;
        const px = x0 + (i + 0.5) * cell;
        let t = ((px - ax) * ex + (py - ay) * ey) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (ax + ex * t), dy = py - (ay + ey * t);
        const r = ra + (rb - ra) * t;
        if (dx * dx + dy * dy <= r * r) data[index] = 1;
      }
    }
  }

  /** Even-odd scanline fill of a polygon given as parallel coordinate arrays. */
  polygon(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): void {
    const { w, h, x0, y0, cell, data } = this;
    let minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < n; k++) { minY = Math.min(minY, ys[k]); maxY = Math.max(maxY, ys[k]); }
    const j0 = Math.max(0, Math.floor((minY - y0) / cell));
    const j1 = Math.min(h - 1, Math.ceil((maxY - y0) / cell));
    const xsHit = this.scratch;
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * cell;
      let c = 0;
      for (let k = 0, l = n - 1; k < n; l = k++) {
        const ya = ys[k], yb = ys[l];
        if ((ya > py) !== (yb > py)) {
          xsHit[c++] = xs[k] + ((py - ya) / (yb - ya)) * (xs[l] - xs[k]);
        }
      }
      // Insertion sort of the few crossings.
      for (let a = 1; a < c; a++) {
        const v = xsHit[a]; let b = a - 1;
        while (b >= 0 && xsHit[b] > v) { xsHit[b + 1] = xsHit[b]; b--; }
        xsHit[b + 1] = v;
      }
      for (let a = 0; a + 1 < c; a += 2) {
        const ia = Math.max(0, Math.ceil((xsHit[a] - x0) / cell - 0.5));
        const ib = Math.min(w - 1, Math.floor((xsHit[a + 1] - x0) / cell - 0.5));
        for (let i = ia; i <= ib; i++) data[j * w + i] = 1;
      }
    }
  }
  private scratch = new Float32Array(32);
}

const palmX = new Float32Array(PALM.length);
const palmY = new Float32Array(PALM.length);

/** Rasterise a flattened hand (palm polygon + finger capsules). */
export function drawHand(m: Mask, f: FlatHand): void {
  if (!f.valid) return;
  for (let k = 0; k < PALM.length; k++) { palmX[k] = f.x[PALM[k]]; palmY[k] = f.y[PALM[k]]; }
  m.polygon(palmX, palmY, PALM.length);
  for (const [a, b] of BONES) m.capsule(f.x[a], f.y[a], f.x[b], f.y[b], f.r[a], f.r[b]);
}

export interface Moments { area: number; cx: number; cy: number }

/** Area (cells) and centroid (plane coordinates) of a mask. */
export function moments(m: Mask, out: Moments): Moments {
  let n = 0, sx = 0, sy = 0;
  const { w, h, data } = m;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (data[j * w + i]) { n++; sx += i; sy += j; }
    }
  }
  out.area = n;
  out.cx = n ? m.x0 + (sx / n + 0.5) * m.cell : 0;
  out.cy = n ? m.y0 + (sy / n + 0.5) * m.cell : 0;
  return out;
}

/** Normalised template grid size and how many cells sqrt(area) spans. */
export const NORM = 40;
export const NORM_SPAN = 12;

/**
 * Resample a mask into a NORM x NORM grid centred on its centroid and scaled
 * so that sqrt(area) spans NORM_SPAN cells, optionally rotated and mirrored.
 */
export function normalise(
  m: Mask, mo: Moments, out: Uint8Array, rotRad = 0, mirrorX = false,
): number {
  const areaM2 = mo.area * m.cell * m.cell;
  if (mo.area < 4) { out.fill(0); return 0; }
  const step = Math.sqrt(areaM2) / NORM_SPAN; // metres per normalised cell
  const c = Math.cos(rotRad), s = Math.sin(rotRad);
  let filled = 0;
  for (let j = 0; j < NORM; j++) {
    const v = (j - NORM / 2 + 0.5) * step;
    for (let i = 0; i < NORM; i++) {
      let u = (i - NORM / 2 + 0.5) * step;
      if (mirrorX) u = -u;
      const px = mo.cx + c * u - s * v;
      const py = mo.cy + s * u + c * v;
      const ii = Math.floor((px - m.x0) / m.cell);
      const jj = Math.floor((py - m.y0) / m.cell);
      const on = ii >= 0 && jj >= 0 && ii < m.w && jj < m.h && m.data[jj * m.w + ii] === 1;
      out[j * NORM + i] = on ? 1 : 0;
      if (on) filled++;
    }
  }
  return filled;
}

/**
 * Radial weights for the normalised grid: cells far from the centroid (the
 * fingers that make a silhouette recognisable) count more than the palm core.
 */
export const RADIAL_GAIN = { value: 1.0 };
export const WEIGHTS = new Float32Array(NORM * NORM);
export function setRadialGain(g: number): void {
  RADIAL_GAIN.value = g;
  for (let j = 0; j < NORM; j++) {
    for (let i = 0; i < NORM; i++) {
      const u = (i - NORM / 2 + 0.5) / NORM_SPAN, v = (j - NORM / 2 + 0.5) / NORM_SPAN;
      WEIGHTS[j * NORM + i] = 1 + g * (u * u + v * v);
    }
  }
}
setRadialGain(3.0);

/** Radially weighted intersection-over-union of two normalised masks. */
export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) {
    const x = a[k], y = b[k], w = WEIGHTS[k];
    if (x & y) inter += w;
    if (x | y) uni += w;
  }
  return uni ? inter / uni : 0;
}

/** Same weighted accumulation order as iou, reading a horizontally mirrored. */
function mirroredIou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let j = 0; j < NORM; j++) {
    const row = j * NORM;
    for (let i = 0; i < NORM; i++) {
      const k = row + i;
      const x = a[row + NORM - 1 - i], y = b[k], w = WEIGHTS[k];
      if (x & y) inter += w;
      if (x | y) uni += w;
    }
  }
  return uni ? inter / uni : 0;
}

/** Rotations tried when matching (radians): ±30° in 10° steps. */
export const MATCH_ROTATIONS = [-30, -20, -10, 0, 10, 20, 30].map((d) => (d * Math.PI) / 180);

/**
 * Best IoU of a live mask against a normalised template over the allowed
 * rotations and mirror (either hand may make any shape).
 */
export class Matcher {
  private rotated = MATCH_ROTATIONS.map(() => new Uint8Array(NORM * NORM));
  private mo: Moments = { area: 0, cx: 0, cy: 0 };
  bestRot = 0;
  bestMirror = false;

  score(live: Mask, template: Uint8Array): number {
    moments(live, this.mo);
    if (this.mo.area < 4) return 0;
    let best = 0;
    for (let mirror = 0; mirror < 2; mirror++) {
      const mirrorX = mirror === 1;
      for (let r = 0; r < MATCH_ROTATIONS.length; r++) {
        const rot = MATCH_ROTATIONS[r], buf = this.rotated[r];
        // Mirroring normalise's u coordinate is exactly a row reversal. Keep
        // rotation/mirror and IoU accumulation order so ties remain identical.
        if (!mirrorX) normalise(live, this.mo, buf, rot, false);
        const v = mirrorX ? mirroredIou(buf, template) : iou(buf, template);
        if (v > best) { best = v; this.bestRot = rot; this.bestMirror = mirrorX; }
      }
    }
    return best;
  }

  get centroid(): Readonly<Moments> { return this.mo; }
}

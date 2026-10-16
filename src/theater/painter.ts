/**
 * Paints the paper screen: washi paper lit by the lantern, the live hand
 * shadows (soft penumbra), the glowing cut-out of the creature to match, and
 * the woken creature's shadow animation. Everything is a 2D canvas uploaded
 * as one texture per frame.
 */
import { CanvasTexture, SRGBColorSpace } from '@iwsdk/core';
import { BONES, PALM } from '../shadow/hand-model.js';
import { FlatHand } from '../shadow/silhouette.js';

export const SCREEN_W = 1.0; // metres
export const SCREEN_H = 0.66;
const CW = 1024;
const CH = Math.round((CW * SCREEN_H) / SCREEN_W);
const PX = CW / SCREEN_W; // canvas px per screen metre
const SOFT = 4; // shadow layer downscale (penumbra softness)

const INK = '#1c1316';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Trace palm polygon + finger capsules of a flat hand into the current path. */
function handPath(ctx: CanvasRenderingContext2D, f: FlatHand): void {
  ctx.beginPath();
  ctx.moveTo(f.x[PALM[0]], f.y[PALM[0]]);
  for (let k = 1; k < PALM.length; k++) ctx.lineTo(f.x[PALM[k]], f.y[PALM[k]]);
  ctx.closePath();
  ctx.fill();
  for (const [a, b] of BONES) {
    ctx.lineWidth = f.r[a] + f.r[b];
    ctx.beginPath();
    ctx.moveTo(f.x[a], f.y[a]);
    ctx.lineTo(f.x[b], f.y[b]);
    ctx.stroke();
  }
}

/** A creature silhouette pre-rendered as sprites (ink, cut-out, glow). */
export interface Stencil {
  ink: HTMLCanvasElement;
  cut: HTMLCanvasElement;
  glow: HTMLCanvasElement;
  /** Sprite size in screen metres; sprite centre in screen metres. */
  w: number;
  h: number;
  cx: number;
  cy: number;
  eyes: [number, number][]; // 0..1 inside the sprite, y down
}

/** Same path as handPath but every stroke widened by `grow` metres. */
function handPathGrown(ctx: CanvasRenderingContext2D, f: FlatHand, grow: number): void {
  ctx.lineWidth = grow * 2;
  ctx.beginPath();
  ctx.moveTo(f.x[PALM[0]], f.y[PALM[0]]);
  for (let k = 1; k < PALM.length; k++) ctx.lineTo(f.x[PALM[k]], f.y[PALM[k]]);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  for (const [a, b] of BONES) {
    ctx.lineWidth = f.r[a] + f.r[b] + grow * 2;
    ctx.beginPath();
    ctx.moveTo(f.x[a], f.y[a]);
    ctx.lineTo(f.x[b], f.y[b]);
    ctx.stroke();
  }
}

export function makeStencil(hands: FlatHand | FlatHand[], scale: number, eyes: readonly (readonly number[])[]): Stencil {
  const fs = Array.isArray(hands) ? hands : [hands];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of fs) {
    for (let j = 0; j < f.x.length; j++) {
      minX = Math.min(minX, f.x[j] - f.r[j]); maxX = Math.max(maxX, f.x[j] + f.r[j]);
      minY = Math.min(minY, f.y[j] - f.r[j]); maxY = Math.max(maxY, f.y[j] + f.r[j]);
    }
  }
  const pad = 0.03; // metres of room for the glow
  const wM = (maxX - minX) * scale + 2 * pad, hM = (maxY - minY) * scale + 2 * pad;
  const w = Math.ceil(wM * PX), h = Math.ceil(hM * PX);
  const [ink, ictx] = canvas(w, h);
  ictx.setTransform(PX * scale, 0, 0, -PX * scale, pad * PX - minX * PX * scale, h - pad * PX + minY * PX * scale);
  ictx.fillStyle = ictx.strokeStyle = INK;
  ictx.lineCap = 'round';
  ictx.lineJoin = 'round';
  for (const f of fs) handPath(ictx, f);
  // Cut-out: a hole in the paper with a thin scorched edge, lit from behind.
  const [cut, cctx] = canvas(w, h);
  cctx.setTransform(ictx.getTransform());
  cctx.lineCap = 'round';
  cctx.lineJoin = 'round';
  cctx.fillStyle = cctx.strokeStyle = 'rgba(92,58,34,0.85)';
  for (const f of fs) handPathGrown(cctx, f, 0.0045 / scale);
  cctx.fillStyle = cctx.strokeStyle = '#fff4dc';
  for (const f of fs) handPath(cctx, f);
  const [glow, gctx] = canvas(w, h);
  gctx.filter = 'blur(9px)';
  gctx.drawImage(ink, 0, 0);
  gctx.filter = 'none';
  gctx.globalCompositeOperation = 'source-in';
  gctx.fillStyle = '#ffc25e';
  gctx.fillRect(0, 0, w, h);
  const toSprite = (x: number, y: number): [number, number] => [
    (pad + (x - minX) * scale) / wM,
    1 - (pad + (y - minY) * scale) / hM,
  ];
  const eyePts = eyes.map(([a, b, t, hand = 0]) => {
    const f = fs[Math.min(hand, fs.length - 1)];
    return toSprite(f.x[a] + (f.x[b] - f.x[a]) * t, f.y[a] + (f.y[b] - f.y[a]) * t);
  });
  return {
    ink, cut, glow, w: wM, h: hM,
    cx: ((minX + maxX) / 2) * scale, cy: ((minY + maxY) / 2) * scale,
    eyes: eyePts,
  };
}

export class ScreenPainter {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private paper: HTMLCanvasElement;
  private soft: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;

  constructor() {
    [this.canvas, this.ctx] = canvas(CW, CH);
    [this.soft, this.sctx] = canvas(CW / SOFT, Math.round(CH / SOFT));
    this.paper = this.paintPaper(0, -0.2);
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
  }

  /** Washi paper with fibres, warmly lit around the lantern's footprint. */
  paintPaper(lightX: number, lightY: number): HTMLCanvasElement {
    const [c, g] = canvas(CW, CH);
    g.fillStyle = '#eadbc0';
    g.fillRect(0, 0, CW, CH);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 900; k++) {
      const x = rnd() * CW, y = rnd() * CH, len = 6 + rnd() * 40, a = rnd() * Math.PI;
      g.strokeStyle = rnd() < 0.5 ? 'rgba(255,250,235,0.35)' : 'rgba(150,120,85,0.12)';
      g.lineWidth = 0.6 + rnd() * 1.2;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 8, y + Math.sin(a) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
    const cx = CW / 2 + lightX * PX, cy = CH / 2 - lightY * PX;
    const glow = g.createRadialGradient(cx, cy, 20, cx, cy, CW * 0.75);
    glow.addColorStop(0, 'rgba(255,214,140,0.55)');
    glow.addColorStop(0.45, 'rgba(255,190,110,0.18)');
    glow.addColorStop(1, 'rgba(70,40,25,0.55)');
    g.fillStyle = glow;
    g.fillRect(0, 0, CW, CH);
    this.paper = c;
    return c;
  }

  begin(): void {
    this.ctx.globalAlpha = 1;
    this.ctx.drawImage(this.paper, 0, 0);
    const s = this.sctx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, this.soft.width, this.soft.height);
  }

  /** Cut-out of the creature to match, glowing with closeness. */
  target(st: Stencil, cx: number, cy: number, glow: number, time: number): void {
    const g = this.ctx;
    const w = st.w * PX, h = st.h * PX;
    const x = CW / 2 + (cx + st.cx) * PX - w / 2, y = CH / 2 - (cy + st.cy) * PX - h / 2;
    g.globalAlpha = 0.8 + 0.12 * Math.sin(time * 1.7);
    g.drawImage(st.cut, x, y, w, h);
    g.globalAlpha = Math.min(1, 0.25 + glow * 0.9);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(st.glow, x, y, w, h);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }

  /** Accumulate a live hand shadow (screen-metre coordinates). */
  shadow(f: FlatHand): void {
    if (!f.valid) return;
    const s = this.sctx, k = PX / SOFT;
    s.setTransform(k, 0, 0, -k, this.soft.width / 2, this.soft.height / 2);
    s.fillStyle = s.strokeStyle = INK;
    s.lineCap = 'round';
    s.lineJoin = 'round';
    handPath(s, f);
  }

  /** Composite the soft shadow layer onto the paper. */
  flushShadows(alpha: number): void {
    const g = this.ctx;
    g.globalAlpha = alpha;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    // Upscaling the quarter-res layer gives the penumbra; no per-frame filter.
    g.drawImage(this.soft, 0, 0, CW, CH);
    g.globalAlpha = 1;
  }

  /** A woken creature: ink silhouette with a blinking eye. */
  creature(st: Stencil, cx: number, cy: number, scale: number, rot: number, flipX: boolean, blink: boolean, alpha: number): void {
    const g = this.ctx;
    const w = st.w * PX * scale, h = st.h * PX * scale;
    g.save();
    g.globalAlpha = alpha;
    g.translate(CW / 2 + (cx + st.cx * scale) * PX, CH / 2 - (cy + st.cy * scale) * PX);
    g.rotate(rot);
    if (flipX) g.scale(-1, 1);
    g.drawImage(st.ink, -w / 2, -h / 2, w, h);
    g.fillStyle = '#fff6e0';
    for (const [u, v] of st.eyes) {
      const ex = -w / 2 + u * w, ey = -h / 2 + v * h;
      g.beginPath();
      if (blink) g.ellipse(ex, ey, 8 * scale, 1.6 * scale, 0, 0, Math.PI * 2);
      else g.arc(ex, ey, 7.5 * scale, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  /** Little sparks of lantern light (wake moment). */
  sparks(cx: number, cy: number, t: number, alpha: number): void {
    const g = this.ctx;
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 18; k++) {
      const a = k * 2.399 + t * 0.6, r = (40 + 260 * t) * (0.5 + ((k * 37) % 10) / 20);
      g.fillStyle = `rgba(255,${180 + ((k * 13) % 60)},90,${alpha * (1 - t)})`;
      g.beginPath();
      g.arc(CW / 2 + cx * PX + Math.cos(a) * r, CH / 2 - cy * PX + Math.sin(a) * r, 3 + (k % 3), 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  caption(text: string, alpha: number, y = -0.27): void {
    if (alpha <= 0 || !text) return;
    const g = this.ctx;
    g.globalAlpha = alpha;
    g.fillStyle = '#4a3626';
    g.font = 'italic 34px Georgia, "Times New Roman", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, CW / 2, CH / 2 - y * PX);
    g.globalAlpha = 1;
  }

  /** Small counter of woken creatures (top-right), drawn as dots. */
  progress(done: number, total: number): void {
    const g = this.ctx;
    for (let k = 0; k < total; k++) {
      g.fillStyle = k < done ? 'rgba(60,40,30,0.85)' : 'rgba(60,40,30,0.18)';
      g.beginPath();
      g.arc(CW - 40 - (total - 1 - k) * 26, 36, 8, 0, Math.PI * 2);
      g.fill();
    }
  }

  end(): void {
    this.texture.needsUpdate = true;
  }
}

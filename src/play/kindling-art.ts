/**
 * Kindling art, baked once: a strip of small flame people (walk cycle, wave,
 * fall, cheer, idle) plus the warm halo each one throws on the paper. Bright
 * cores read on your dark shadow; a thin scorched outline keeps them legible
 * on the pale paper. CPU-backed canvases, uploaded once.
 */
import { CanvasTexture, LinearFilter, SRGBColorSpace } from '@iwsdk/core';

export const KINDLING_CELL = 128;
export const KINDLING_CELLS = 8;
export const KINDLING_FRAMES = { walk: [0, 1, 2, 3], wave: 4, fall: 5, cheer: 6, idle: 7 } as const;
/** Feet line, as a fraction of the cell height from its bottom edge. */
export const KINDLING_FOOT = 10 / 128;
/** Body height (tip to feet) as a fraction of the cell height. */
export const KINDLING_BODY = 96 / 128;

type Pose = {
  tip: number; bob: number; legs: [number, number];
  arms: [[number, number], [number, number]]; eyes: 'open' | 'wide' | 'happy'; spark: boolean;
};

const POSES: Pose[] = [
  { tip: -3, bob: 0, legs: [-7, 7], arms: [[36, 94], [92, 86]], eyes: 'open', spark: false },
  { tip: 0, bob: -2, legs: [-2, 2], arms: [[37, 90], [91, 90]], eyes: 'open', spark: false },
  { tip: 3, bob: 0, legs: [7, -7], arms: [[36, 86], [92, 94]], eyes: 'open', spark: false },
  { tip: 0, bob: -2, legs: [2, -2], arms: [[37, 90], [91, 90]], eyes: 'open', spark: false },
  { tip: 2, bob: 0, legs: [-3, 3], arms: [[36, 92], [98, 46]], eyes: 'happy', spark: false },
  { tip: -7, bob: 0, legs: [-4, 4], arms: [[26, 56], [102, 56]], eyes: 'wide', spark: false },
  { tip: 0, bob: -6, legs: [-5, 5], arms: [[38, 38], [90, 38]], eyes: 'happy', spark: true },
  { tip: 0, bob: 0, legs: [-3, 3], arms: [[39, 96], [89, 96]], eyes: 'open', spark: false },
];

function bake(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return [canvas, canvas.getContext('2d', { willReadFrequently: true })!];
}

function texture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  map.generateMipmaps = false;
  map.minFilter = LinearFilter;
  map.magFilter = LinearFilter;
  return map;
}

function limb(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, width: number): void {
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(84,34,12,0.75)'; g.lineWidth = width + 3;
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  g.strokeStyle = '#ffab45'; g.lineWidth = width;
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
}

/** One Kindling facing right, feet on y = 118 of a 128 px cell starting at `ox`. */
function drawKindling(g: CanvasRenderingContext2D, ox: number, pose: Pose): void {
  g.save();
  g.translate(ox, pose.bob);
  const tip = 64 + pose.tip;
  // Legs and arms sit behind the body.
  limb(g, 58, 98, 58 + pose.legs[0], 116 - pose.bob, 5);
  limb(g, 70, 98, 70 + pose.legs[1], 116 - pose.bob, 5);
  limb(g, 45, 76, pose.arms[0][0], pose.arms[0][1], 4.5);
  limb(g, 83, 76, pose.arms[1][0], pose.arms[1][1], 4.5);
  for (const [x, y] of pose.arms) {
    g.fillStyle = '#ffd27a'; g.beginPath(); g.arc(x, y, 3.6, 0, Math.PI * 2); g.fill();
  }
  // Flame body: a teardrop whose tip sways frame to frame.
  const body = new Path2D();
  body.moveTo(tip, 20);
  body.bezierCurveTo(tip + 9, 36, 88, 50, 88, 74);
  body.bezierCurveTo(88, 92, 77, 102, 64, 102);
  body.bezierCurveTo(51, 102, 40, 92, 40, 74);
  body.bezierCurveTo(40, 54, 55, 42, tip, 20);
  const fill = g.createRadialGradient(64, 80, 4, 64, 76, 44);
  fill.addColorStop(0, '#fffef6');
  fill.addColorStop(0.32, '#fff0b8');
  fill.addColorStop(0.66, '#ffc25a');
  fill.addColorStop(1, '#ff7c22');
  g.fillStyle = fill; g.fill(body);
  g.strokeStyle = 'rgba(96,38,12,0.6)'; g.lineWidth = 3; g.stroke(body);
  // A second, smaller tongue of flame for flicker.
  g.fillStyle = 'rgba(255,214,120,0.85)';
  g.beginPath(); g.moveTo(tip - 10, 44); g.quadraticCurveTo(tip - 16, 34, tip - 12 - pose.tip, 28);
  g.quadraticCurveTo(tip - 4, 38, tip - 4, 48); g.closePath(); g.fill();
  // Hot core.
  g.fillStyle = 'rgba(255,255,250,0.7)';
  g.beginPath(); g.ellipse(64, 84, 12, 13, 0, 0, Math.PI * 2); g.fill();
  // Face, looking ahead.
  g.fillStyle = '#2b1309'; g.strokeStyle = '#2b1309'; g.lineWidth = 2.6; g.lineCap = 'round';
  for (const ex of [60, 74]) {
    if (pose.eyes === 'happy') {
      g.beginPath(); g.arc(ex, 74, 3.6, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
    } else {
      const r = pose.eyes === 'wide' ? 4.4 : 3.3;
      g.beginPath(); g.ellipse(ex, 72, r, pose.eyes === 'wide' ? 4.6 : 4.4, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff6dc'; g.beginPath(); g.arc(ex + 1.2, 70.6, 1.2, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#2b1309';
    }
  }
  if (pose.eyes === 'happy') {
    g.beginPath(); g.arc(67, 82, 3.4, Math.PI * 0.15, Math.PI * 0.85); g.stroke();
  }
  if (pose.spark) {
    g.fillStyle = '#fff3c4';
    for (const [x, y, r] of [[tip, 10, 3], [tip + 12, 16, 2], [tip - 13, 14, 2]] as const) {
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
}

/** Eight 128 px cells in one row: walk ×4, wave, fall, cheer, idle. */
export function kindlingAtlas(): CanvasTexture {
  const [canvas, g] = bake(KINDLING_CELL * KINDLING_CELLS, KINDLING_CELL);
  POSES.forEach((pose, index) => drawKindling(g, index * KINDLING_CELL, pose));
  return texture(canvas);
}

/** Warm light a Kindling throws on the paper; meant for additive blending. */
export function kindlingHalo(): CanvasTexture {
  const [canvas, g] = bake(128, 128);
  const glow = g.createRadialGradient(64, 64, 2, 64, 64, 63);
  glow.addColorStop(0, 'rgba(255,226,160,0.95)');
  glow.addColorStop(0.22, 'rgba(255,180,90,0.5)');
  glow.addColorStop(0.55, 'rgba(255,128,40,0.14)');
  glow.addColorStop(1, 'rgba(255,110,30,0)');
  g.fillStyle = glow; g.fillRect(0, 0, 128, 128);
  return texture(canvas);
}

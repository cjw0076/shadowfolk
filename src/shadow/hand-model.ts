/**
 * Hand pose model shared by targets, the ghost guide and the emulator test
 * harness. A pose is 25 column-major 4x4 joint matrices in WebXR joint order,
 * expressed in a left-hand space; right hands are produced by mirroring.
 */
import {
  JOINT_NAMES,
  PINCH_MATS,
  POINT_MATS,
  RELAXED_MATS,
  RELAXED_RADII,
} from './base-poses.js';

export const JOINT_COUNT = 25;
export type JointName = (typeof JOINT_NAMES)[number];
export { JOINT_NAMES };

export interface HandPose {
  mats: Float32Array; // JOINT_COUNT * 16
  radii: Float32Array; // JOINT_COUNT
}

export type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

/** First joint of each finger chain; chains run to the tip. */
const CHAIN: Record<Finger, readonly number[]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8, 9],
  middle: [10, 11, 12, 13, 14],
  ring: [15, 16, 17, 18, 19],
  pinky: [20, 21, 22, 23, 24],
};

/** Flexion joints per finger, ordered knuckle → fingertip. */
const FLEX: Record<Finger, readonly number[]> = {
  thumb: [1, 2, 3],
  index: [6, 7, 8],
  middle: [11, 12, 13],
  ring: [16, 17, 18],
  pinky: [21, 22, 23],
};

/** Max flexion (degrees) per flex joint at curl = 1. */
const FLEX_DEG: Record<Finger, readonly number[]> = {
  thumb: [25, 45, 60],
  index: [85, 100, 65],
  middle: [85, 100, 65],
  ring: [85, 100, 65],
  pinky: [85, 100, 65],
};

/** Capsule bones drawn for a hand, as joint index pairs. */
export const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8], [8, 9],
  [10, 11], [11, 12], [12, 13], [13, 14],
  [15, 16], [16, 17], [17, 18], [18, 19],
  [20, 21], [21, 22], [22, 23], [23, 24],
];

/** Palm outline polygon (joint indices), filled solid. */
export const PALM: readonly number[] = [0, 1, 2, 6, 11, 16, 21, 20];

export function makePose(mats: readonly number[], radii: readonly number[] = RELAXED_RADII): HandPose {
  return { mats: Float32Array.from(mats), radii: Float32Array.from(radii) };
}

export const basePoses = {
  relaxed: () => makePose(RELAXED_MATS),
  point: () => makePose(POINT_MATS),
  pinch: () => makePose(PINCH_MATS),
};

export function clonePose(p: HandPose): HandPose {
  return { mats: p.mats.slice(), radii: p.radii.slice() };
}

export function jointPosition(p: HandPose, j: number, out: number[] = [0, 0, 0]): number[] {
  const o = j * 16;
  out[0] = p.mats[o + 12];
  out[1] = p.mats[o + 13];
  out[2] = p.mats[o + 14];
  return out;
}

/** Rotation matrix (3x3, row-major) about a unit axis. */
function axisAngle(ax: number, ay: number, az: number, a: number): number[] {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay,
    t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax,
    t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c,
  ];
}

/** Rotate joints [from..to] (inclusive) about an axis through pivot. */
function rotateJoints(p: HandPose, joints: readonly number[], pivot: number[], r: number[]): void {
  const m = p.mats;
  for (const j of joints) {
    const o = j * 16;
    for (let col = 0; col < 3; col++) {
      const c = o + col * 4;
      const x = m[c], y = m[c + 1], z = m[c + 2];
      m[c] = r[0] * x + r[1] * y + r[2] * z;
      m[c + 1] = r[3] * x + r[4] * y + r[5] * z;
      m[c + 2] = r[6] * x + r[7] * y + r[8] * z;
    }
    const x = m[o + 12] - pivot[0], y = m[o + 13] - pivot[1], z = m[o + 14] - pivot[2];
    m[o + 12] = pivot[0] + r[0] * x + r[1] * y + r[2] * z;
    m[o + 13] = pivot[1] + r[3] * x + r[4] * y + r[5] * z;
    m[o + 14] = pivot[2] + r[6] * x + r[7] * y + r[8] * z;
  }
}

/** Unit local axis (0 = X, 1 = Y, 2 = Z) of joint j in hand space. */
function jointAxis(p: HandPose, j: number, axis: 0 | 1 | 2): number[] {
  const o = j * 16 + axis * 4;
  const x = p.mats[o], y = p.mats[o + 1], z = p.mats[o + 2];
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * Bend one finger. curl = 0 keeps the captured pose, positive curls toward
 * the palm, negative straightens (about -0.3 is a fully extended finger).
 */
export function curl(p: HandPose, finger: Finger, amount: number): HandPose {
  const flex = FLEX[finger];
  const chain = CHAIN[finger];
  for (let k = 0; k < flex.length; k++) {
    const j = flex[k];
    const angle = (amount * FLEX_DEG[finger][k] * Math.PI) / 180;
    const ax = jointAxis(p, j, 0);
    // Flexion about local X moves the fingertip toward the palm (-Y side).
    const r = axisAngle(ax[0], ax[1], ax[2], -angle);
    const tail = chain.slice(chain.indexOf(j));
    rotateJoints(p, tail, jointPosition(p, j), r);
  }
  return p;
}

/** Spread a finger sideways at its knuckle (degrees, + toward the thumb side). */
export function spread(p: HandPose, finger: Finger, deg: number): HandPose {
  const knuckle = FLEX[finger][0];
  const ax = jointAxis(p, knuckle, 1);
  const r = axisAngle(ax[0], ax[1], ax[2], (deg * Math.PI) / 180);
  const chain = CHAIN[finger];
  rotateJoints(p, chain.slice(chain.indexOf(knuckle)), jointPosition(p, knuckle), r);
  return p;
}

/** Curl several fingers at once: { index: -0.3, middle: 1, ... }. */
export function shape(p: HandPose, curls: Partial<Record<Finger, number>>): HandPose {
  for (const f of Object.keys(curls) as Finger[]) curl(p, f, curls[f]!);
  return p;
}

/**
 * Apply a rigid transform (row-major 3x3 rotation + translation) about the
 * wrist to the whole hand, e.g. to present a target pose side-on.
 */
export function orient(p: HandPose, eulerDeg: [number, number, number]): HandPose {
  const [rx, ry, rz] = eulerDeg.map((d) => (d * Math.PI) / 180);
  const wrist = jointPosition(p, 0);
  const all = Array.from({ length: JOINT_COUNT }, (_, i) => i);
  // Z * Y * X order, applied as successive world-axis rotations.
  if (rx) rotateJoints(p, all, wrist, axisAngle(1, 0, 0, rx));
  if (ry) rotateJoints(p, all, wrist, axisAngle(0, 1, 0, ry));
  if (rz) rotateJoints(p, all, wrist, axisAngle(0, 0, 1, rz));
  return p;
}

/** Mirror a left-hand pose into a right-hand pose (flip hand-space X). */
export function mirror(p: HandPose): HandPose {
  const q = clonePose(p);
  const m = q.mats;
  for (let j = 0; j < JOINT_COUNT; j++) {
    const o = j * 16;
    // M' = S M S with S = diag(-1, 1, 1, 1).
    m[o + 1] = -m[o + 1]; m[o + 2] = -m[o + 2];
    m[o + 4] = -m[o + 4]; m[o + 8] = -m[o + 8];
    m[o + 12] = -m[o + 12];
  }
  return q;
}

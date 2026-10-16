/**
 * The shadow creatures. Each target is a real, reachable hand pose (captured
 * Quest hand data bent with forward kinematics) presented at a fixed angle to
 * the screen. Its orthographic shadow becomes the template the player's live
 * shadow must fit; the same pose drives the ghost-hand hint.
 */
import { HandPose, basePoses, clonePose, mirror, orient, shape, spread } from './hand-model.js';
import { PASS } from './thresholds.js';
import { HandPose as Pose, JOINT_COUNT } from './hand-model.js';
import {
  FlatHand, Mask, NORM, STAGE, ScreenFrame, drawHand, moments, normalise, projectFromLight,
} from './silhouette.js';

export type Motion = 'swim' | 'hop' | 'crawl' | 'bob' | 'fan' | 'flap' | 'stalk' | 'scuttle';

export interface TargetDef {
  id: string;
  creature: string;
  /** One line of the night's story, told when the creature wakes. */
  line: string;
  motion: Motion;
  /** Eyes, each placed between two joints: [jointA, jointB, t, hand?] (hand 1 = partner). */
  eyes: Eye[];
  /** The left hand's pose, in hand space (the matcher also accepts it mirrored). */
  build: () => HandPose;
  /**
   * Two-hand creatures: the second hand, built as a left-hand pose and
   * mirrored into the right hand, with its centroid this far from the first
   * hand's centroid (metres: +x right, +y up, +z toward the lantern).
   */
  partner?: { build: () => HandPose; offset: [number, number, number] };
}

export type Eye = [number, number, number] | [number, number, number, number];

const straight = -0.32;

// Two-hand creature halves (each built as a left hand; the partner is mirrored).
function butterflyWing(): HandPose {
  const p = shape(basePoses.relaxed(), { thumb: straight, index: straight, middle: straight, ring: -0.1, pinky: 0.05 });
  spread(p, 'thumb', 16); spread(p, 'index', 6); spread(p, 'middle', -4); spread(p, 'ring', -14); spread(p, 'pinky', -24);
  return orient(p, [0, 18, 48]);
}
function crabHalf(): HandPose {
  const p = shape(basePoses.relaxed(), { thumb: 0.1, index: straight, middle: straight, ring: straight, pinky: straight });
  spread(p, 'thumb', 32); spread(p, 'index', 18); spread(p, 'middle', 4); spread(p, 'ring', -10); spread(p, 'pinky', -24);
  return orient(p, [0, 10, 92]);
}
// Stag v2 (agy-05): head side-on pointing left, antler hand behind it, fingers up.
function stagHead(): HandPose {
  const p = shape(basePoses.relaxed(), { thumb: straight, index: straight, middle: straight, ring: 1, pinky: 1 });
  spread(p, 'index', 15); spread(p, 'middle', -15); spread(p, 'thumb', 10);
  return orient(p, [0, 0, 80]);
}
function stagAntlers(): HandPose {
  const p = shape(basePoses.relaxed(), { thumb: -0.1, index: straight, middle: straight, ring: straight, pinky: straight });
  spread(p, 'thumb', -10); spread(p, 'index', 18); spread(p, 'middle', 4); spread(p, 'ring', -12); spread(p, 'pinky', -26);
  return orient(p, [0, 0, 10]);
}

export const TARGETS: readonly TargetDef[] = [
  {
    id: 'peacock',
    creature: 'Peacock',
    line: 'A peacock opens its tail to greet the lantern.',
    motion: 'fan',
    eyes: [[3, 4, 0.55]],
    build: () => {
      const p = shape(basePoses.relaxed(), {
        thumb: straight, index: straight, middle: straight, ring: straight, pinky: straight,
      });
      spread(p, 'index', 8); spread(p, 'pinky', -14); spread(p, 'ring', -6);
      return orient(p, [0, 0, 0]);
    },
  },
  {
    id: 'rabbit',
    creature: 'Rabbit',
    line: 'The rabbit pricks its ears. Something is coming.',
    motion: 'hop',
    eyes: [[11, 16, 0.35]],
    build: () => {
      const p = shape(basePoses.relaxed(), {
        thumb: 0.9, index: straight, middle: straight, ring: 1, pinky: 1,
      });
      spread(p, 'index', 10); spread(p, 'middle', -8);
      return orient(p, [0, 0, 0]);
    },
  },
  {
    id: 'snail',
    creature: 'Snail',
    line: 'A snail lifts two curious horns and starts the long way home.',
    motion: 'crawl',
    eyes: [[9, 9, 0], [24, 24, 0]],
    build: () => {
      const p = shape(basePoses.relaxed(), {
        thumb: 0.9, index: straight, middle: 1, ring: 1, pinky: straight,
      });
      spread(p, 'index', 6); spread(p, 'pinky', -10);
      return orient(p, [0, 0, 0]);
    },
  },
  {
    id: 'fish',
    creature: 'Fish',
    line: 'A fish slips out of the dark water of the wall.',
    motion: 'swim',
    eyes: [[8, 13, 0.5]],
    build: () => {
      const p = shape(basePoses.relaxed(), {
        thumb: -0.1, index: straight, middle: straight, ring: straight, pinky: straight,
      });
      spread(p, 'index', -6); spread(p, 'ring', 5); spread(p, 'pinky', 9);
      return orient(p, [0, 90, -70]);
    },
  },
  {
    id: 'duck',
    creature: 'Duck',
    line: 'The duck clacks its beak: the night is not over yet.',
    motion: 'bob',
    eyes: [[7, 11, 0.6]],
    build: () => orient(clonePose(basePoses.pinch()), [0, 90, -20]),
  },
  {
    id: 'butterfly',
    creature: 'Butterfly',
    line: 'A butterfly hooks its wings together and drifts toward the warm paper.',
    motion: 'flap',
    eyes: [[3, 4, 0.7, 0], [3, 4, 0.7, 1]],
    // Two hands, thumbs hooked, fingers fanned as wings (design: agy-02).
    build: butterflyWing,
    partner: { build: butterflyWing, offset: [0.085, 0.0, 0.025] },
  },
  {
    id: 'heron',
    creature: 'Heron',
    line: 'A heron stands on one leg and points its beak toward morning.',
    motion: 'bob',
    eyes: [[6, 11, 0.4]],
    build: () => orient(basePoses.point(), [0, 90, -55]),
  },
  {
    id: 'stag',
    creature: 'Stag',
    line: 'A great stag lifts branched antlers above the quiet ridge.',
    motion: 'stalk',
    eyes: [[5, 10, 0.45, 0]],
    build: stagHead,
    partner: { build: stagAntlers, offset: [0.015, 0.065, 0.025] },
  },
  {
    id: 'crab',
    creature: 'Crab',
    line: 'A tide-pool crab clicks its claws and sidesteps across the lantern glow.',
    motion: 'scuttle',
    eyes: [[3, 4, 0.85, 0], [3, 4, 0.85, 1]],
    build: crabHalf,
    partner: { build: crabHalf, offset: [0.065, 0.0, 0.025] },
  },
  {
    id: 'dog',
    creature: 'Dog',
    line: 'A small dog barks once at the moon, then trots home.',
    motion: 'hop',
    eyes: [[6, 7, 0.5]],
    // Side-on hand: fingers as the head, thumb up as an ear, little finger dropped as the jaw.
    build: () => {
      const p = shape(basePoses.relaxed(), { thumb: straight, index: straight, middle: straight, ring: 0.15, pinky: -0.1 });
      spread(p, 'thumb', 20); spread(p, 'pinky', -20);
      return orient(p, [0, 90, 10]);
    },
  },
  {
    id: 'elephant',
    creature: 'Elephant',
    line: 'An elephant swings its trunk and trumpets softly at the lantern.',
    motion: 'stalk',
    eyes: [[5, 6, 0.6]],
    // A loose fist as the head with the middle finger hanging down as the trunk.
    build: () => {
      const p = shape(basePoses.relaxed(), { thumb: 0.3, index: 0.7, middle: straight, ring: 0.7, pinky: 1 });
      return orient(p, [0, 0, 195]);
    },
  },
];

/** A target baked into its normalised template and a display silhouette. */
export interface BakedTarget {
  def: TargetDef;
  pose: HandPose;
  /** Two-hand creatures: the right hand (already mirrored) and each hand's shift from the pair centre. */
  partner?: HandPose;
  shifts: [number, number, number][];
  /** Every hand's ideal shadow (one, or two for a pair). */
  flats: FlatHand[];
  template: Uint8Array; // NORM x NORM
  /** Weighted IoU needed to wake the creature (tools/eval-targets.ts). */
  pass: number;
  /** The ideal shadow on the paper (screen metres, lantern axis at 0,0). */
  flat: FlatHand;
  display: Mask;
}

/** Canonical stage: light at the origin, cut-out centre up and ahead on -Z. */
const CANON: ScreenFrame = {
  ox: 0, oy: STAGE.lightDrop, oz: -STAGE.lightToScreen, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, nx: 0, ny: 0, nz: 1,
};

/**
 * Cast a hand-space pose from the canonical lantern: the pose is centred on
 * the lantern-to-cut-out line at the natural hand distance, hand-space +Z toward the light.
 */
export function castCanonical(
  p: Pose, out: FlatHand, joints = new Float32Array(JOINT_COUNT * 3), shift: readonly number[] = [0, 0, 0],
): FlatHand {
  let cx = 0, cy = 0, cz = 0;
  for (let j = 0; j < JOINT_COUNT; j++) {
    cx += p.mats[j * 16 + 12]; cy += p.mats[j * 16 + 13]; cz += p.mats[j * 16 + 14];
  }
  cx /= JOINT_COUNT; cy /= JOINT_COUNT; cz /= JOINT_COUNT;
  for (let j = 0; j < JOINT_COUNT; j++) {
    joints[j * 3] = p.mats[j * 16 + 12] - cx + shift[0];
    joints[j * 3 + 1] = p.mats[j * 16 + 13] - cy + shift[1] + (STAGE.lightDrop * STAGE.lightToHand) / STAGE.lightToScreen;
    joints[j * 3 + 2] = p.mats[j * 16 + 14] - cz + shift[2] - STAGE.lightToHand;
  }
  return projectFromLight(joints, p.radii, 0, 0, 0, CANON, out);
}

/** Hands of a target with each hand's shift from the pair centre (centroid to centroid). */
export function targetHands(def: TargetDef): { poses: HandPose[]; shifts: [number, number, number][] } {
  const pose = def.build();
  if (!def.partner) return { poses: [pose], shifts: [[0, 0, 0]] };
  const [ox, oy, oz] = def.partner.offset;
  return {
    poses: [pose, mirror(def.partner.build())],
    shifts: [[-ox / 2, -oy / 2, -oz / 2], [ox / 2, oy / 2, oz / 2]],
  };
}

export function bakeTarget(def: TargetDef): BakedTarget {
  const { poses, shifts } = targetHands(def);
  const flats = poses.map((p, k) => castCanonical(p, new FlatHand(), undefined, shifts[k]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const flat of flats) {
    for (let j = 0; j < flat.x.length; j++) {
      minX = Math.min(minX, flat.x[j] - flat.r[j]); maxX = Math.max(maxX, flat.x[j] + flat.r[j]);
      minY = Math.min(minY, flat.y[j] - flat.r[j]); maxY = Math.max(maxY, flat.y[j] + flat.r[j]);
    }
  }
  const cell = 0.003;
  const w = Math.ceil((maxX - minX) / cell) + 4, h = Math.ceil((maxY - minY) / cell) + 4;
  const display = new Mask(w, h, minX - 2 * cell, minY - 2 * cell, cell);
  for (const flat of flats) drawHand(display, flat);
  const template = new Uint8Array(NORM * NORM);
  normalise(display, moments(display, { area: 0, cx: 0, cy: 0 }), template);
  return {
    def, pose: poses[0], partner: poses[1], shifts, flats, flat: flats[0],
    template, display, pass: PASS[def.id] ?? 0.65,
  };
}

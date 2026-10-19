import {
  JOINT_COUNT, JOINT_NAMES, basePoses, clonePose, curl, mirror, orient, spread, type HandPose,
} from '../src/shadow/hand-model.js';
import { FlatHand, projectFromLight, STAGE, type ScreenFrame } from '../src/shadow/silhouette.js';
import { TARGETS, targetHands, type TargetDef } from '../src/shadow/targets.js';

export const JOURNEY_P1_GESTURES = ['bark', 'peck', 'snip', 'hop', 'fan', 'fly', 'giant', 'tiny'] as const;
export type JourneyP1Gesture = (typeof JOURNEY_P1_GESTURES)[number];
export type JourneyP1Scenario = 'true' | 'negative' | 'held';
export type JourneyP1NegativeKind = 'relaxed' | 'held-creature' | 'slow-drift' | 'two-hand-idle';

export interface SyntheticHand {
  joints: Float32Array;
  radii: Float32Array;
  flat: FlatHand;
  valid: boolean;
  lastSeen: number;
  handedness: 'left' | 'right';
  inputSource: SyntheticInputSource;
}

export interface SyntheticJointSpace {
  readonly handIndex: number;
  readonly jointIndex: number;
}

export interface SyntheticInputSource {
  readonly handedness: 'left' | 'right';
  readonly hand: { get(name: string): SyntheticJointSpace | undefined };
}

export interface SyntheticXRFrame {
  readonly predictedDisplayTime: number;
  readonly session: { readonly inputSources: readonly SyntheticInputSource[] };
  getJointPose(space: SyntheticJointSpace, referenceSpace?: unknown): {
    transform: { position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } };
    radius: number;
  } | undefined;
}

export interface JourneyP1Sample {
  readonly time: number;
  readonly dt: number;
  readonly index: number;
  readonly hands: SyntheticHand[];
  readonly frame: ScreenFrame;
  readonly xrFrame: SyntheticXRFrame;
}

export interface JourneyP1Sequence {
  readonly gesture: JourneyP1Gesture;
  readonly scenario: JourneyP1Scenario;
  readonly negativeKind?: JourneyP1NegativeKind;
  readonly seed: number;
  readonly rateHz: number;
  readonly targetId: string;
  readonly targetIndex: number;
  readonly duration: number;
  readonly gestureStart: number;
  readonly samples: JourneyP1Sample[];
}

export interface JourneyP1SequenceOptions {
  gesture: JourneyP1Gesture;
  scenario: JourneyP1Scenario;
  seed: number;
  targetId?: string;
  negativeKind?: JourneyP1NegativeKind;
}

export const JOURNEY_P1_SCREEN_FRAME: ScreenFrame = {
  ox: 0, oy: STAGE.lightDrop, oz: -STAGE.lightToScreen,
  rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, nx: 0, ny: 0, nz: 1,
};
export const JOURNEY_P1_LANTERN = { x: 0, y: 0, z: 0 };
const GESTURE_SOURCE: Record<JourneyP1Gesture, readonly string[]> = {
  bark: ['dog'],
  peck: ['heron', 'duck'],
  snip: ['crab'],
  hop: ['rabbit'],
  fan: ['peacock'],
  fly: ['butterfly'],
  giant: ['dog'],
  tiny: ['dog'],
};
class RandomSource {
  private state: number;
  private spareNormal: number | undefined;

  constructor(seed: number) {
    this.state = (Math.trunc(seed) >>> 0) || 1;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  integer(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  normal(): number {
    if (this.spareNormal !== undefined) {
      const value = this.spareNormal;
      this.spareNormal = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, this.next())));
    const angle = Math.PI * 2 * this.next();
    this.spareNormal = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }
}

function targetIndex(targetId: string): number {
  const index = TARGETS.findIndex((target) => target.id === targetId);
  if (index < 0) throw new Error(`Unknown P1 target: ${targetId}`);
  return index;
}

function pickTargetId(gesture: JourneyP1Gesture, scenario: JourneyP1Scenario, seed: number, requested?: string): string {
  if (requested) {
    targetIndex(requested);
    return requested;
  }
  if (scenario !== 'true') return TARGETS[seed % TARGETS.length].id;
  const choices = GESTURE_SOURCE[gesture];
  return choices[seed % choices.length];
}

function heldCreatureForNegative(gesture: JourneyP1Gesture, seed: number): string {
  const excluded = new Set(GESTURE_SOURCE[gesture]);
  const choices = TARGETS.filter((target) => !excluded.has(target.id));
  return choices[seed % choices.length].id;
}

function makeInputSource(handIndex: number, handedness: 'left' | 'right'): SyntheticInputSource {
  const spaces = new Map<string, SyntheticJointSpace>();
  for (let jointIndex = 0; jointIndex < JOINT_COUNT; jointIndex++) {
    spaces.set(JOINT_NAMES[jointIndex], { handIndex, jointIndex });
  }
  return { handedness, hand: { get: (name) => spaces.get(name) } };
}

function makeHand(handIndex: number): SyntheticHand {
  const handedness = handIndex === 0 ? 'left' : 'right';
  return {
    joints: new Float32Array(JOINT_COUNT * 3),
    radii: new Float32Array(JOINT_COUNT),
    flat: new FlatHand(),
    valid: false,
    lastSeen: 0,
    handedness,
    inputSource: makeInputSource(handIndex, handedness),
  };
}

function makeFrame(time: number, hands: SyntheticHand[]): SyntheticXRFrame {
  const inputSources = hands.filter((hand) => hand.valid).map((hand) => hand.inputSource);
  return {
    predictedDisplayTime: time * 1000,
    session: { inputSources },
    getJointPose(space) {
      const hand = hands[space.handIndex];
      if (!hand?.valid) return undefined;
      const offset = space.jointIndex * 3;
      return {
        transform: {
          position: { x: hand.joints[offset], y: hand.joints[offset + 1], z: hand.joints[offset + 2] },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
        radius: hand.radii[space.jointIndex],
      };
    },
  };
}

function applyFingerMotion(
  pose: HandPose,
  gesture: JourneyP1Gesture,
  amount: number,
  targetId: string,
): void {
  switch (gesture) {
    case 'bark':
      curl(pose, 'thumb', 1.6 * amount);
      curl(pose, 'index', 1.0 * amount);
      spread(pose, 'index', 60 * amount);
      break;
    case 'peck':
      if (targetId === 'duck') {
        spread(pose, 'index', 52 * amount);
      } else {
        curl(pose, 'thumb', 1.4 * amount);
        curl(pose, 'index', 0.8 * amount);
        spread(pose, 'index', 60 * amount);
      }
      break;
    case 'snip':
      curl(pose, 'thumb', 0.8 * amount);
      curl(pose, 'index', 2.0 * amount);
      spread(pose, 'index', 80 * amount);
      break;
    case 'fan': {
      const spreadDirection = amount * 24;
      spread(pose, 'index', spreadDirection);
      spread(pose, 'middle', spreadDirection * 0.35);
      spread(pose, 'ring', -spreadDirection * 0.35);
      spread(pose, 'pinky', -spreadDirection);
      break;
    }
    case 'hop':
    case 'fly':
    case 'giant':
    case 'tiny':
      break;
  }
}

function gestureAmount(gesture: JourneyP1Gesture, time: number): number {
  const period = gesture === 'peck' || gesture === 'snip' ? 0.62 : 0.78;
  return 0.5 - 0.5 * Math.cos((Math.PI * 2 * time) / period);
}

function motionOffset(gesture: JourneyP1Gesture, time: number): number {
  if (gesture === 'hop') return Math.max(0, Math.sin((Math.PI * 2 * time) / 0.84)) * 0.115;
  if (gesture === 'fly') return Math.sin((Math.PI * 2 * time) / 0.66) * 0.078;
  return 0;
}

function scaleDistance(gesture: JourneyP1Gesture, scenario: JourneyP1Scenario, negativeKind: JourneyP1NegativeKind | undefined, time: number): number {
  if (scenario === 'true' && (gesture === 'giant' || gesture === 'tiny')) {
    const progress = Math.min(1, Math.max(0, (time - 0.45) / 0.75));
    const eased = progress * progress * (3 - 2 * progress);
    const targetDistance = gesture === 'giant' ? 0.218 : 0.392;
    return 0.3 + (targetDistance - 0.3) * eased;
  }
  if (scenario === 'negative' && negativeKind === 'slow-drift') {
    return 0.3 + 0.035 * Math.sin((Math.PI * 2 * time) / 3.6);
  }
  return 0.3;
}

function negativePoses(kind: JourneyP1NegativeKind, target: TargetDef, random: RandomSource): { poses: HandPose[]; shifts: [number, number, number][] } {
  if (kind === 'relaxed') {
    return { poses: [basePoses.relaxed()], shifts: [[0, 0, 0]] };
  }
  if (kind === 'two-hand-idle') {
    const left = random.next() < 0.5 ? basePoses.relaxed() : basePoses.point();
    const right = mirror(random.next() < 0.5 ? basePoses.relaxed() : basePoses.point());
    return { poses: [left, right], shifts: [[-0.07, 0, 0], [0.07, 0, 0]] };
  }
  return targetHands(target);
}

function makePose(
  original: HandPose,
  gesture: JourneyP1Gesture,
  scenario: JourneyP1Scenario,
  targetId: string,
  time: number,
  yaw: number,
  handIndex: number,
): HandPose {
  const mirrorForArticulation = gesture === 'snip' && handIndex === 1;
  let pose = clonePose(original);
  if (mirrorForArticulation) pose = mirror(pose);
  const activeTime = Math.max(0, time - 0.45);
  if (scenario === 'true' && activeTime > 0) {
    const amount = gestureAmount(gesture, activeTime);
    applyFingerMotion(pose, gesture, amount, targetId);
  }
  if (mirrorForArticulation) pose = mirror(pose);
  orient(pose, [0, yaw, 0]);
  return pose;
}

function populateHand(
  hand: SyntheticHand,
  pose: HandPose,
  shift: readonly number[],
  distance: number,
  verticalOffset: number,
  time: number,
  noiseSigma: number,
  random: RandomSource,
): void {
  let centerX = 0, centerY = 0, centerZ = 0;
  for (let joint = 0; joint < JOINT_COUNT; joint++) {
    const offset = joint * 16 + 12;
    centerX += pose.mats[offset] / JOINT_COUNT;
    centerY += pose.mats[offset + 1] / JOINT_COUNT;
    centerZ += pose.mats[offset + 2] / JOINT_COUNT;
  }
  for (let joint = 0; joint < JOINT_COUNT; joint++) {
    const poseOffset = joint * 16 + 12;
    const jointOffset = joint * 3;
    for (let axis = 0; axis < 3; axis++) {
      const local = pose.mats[poseOffset + axis] - (axis === 0 ? centerX : axis === 1 ? centerY : centerZ);
      const placement = axis === 0 ? shift[0] : axis === 1
        ? shift[1] + (STAGE.lightDrop * distance) / STAGE.lightToScreen + verticalOffset
        : shift[2] - distance;
      const noise = Math.max(-3 * noiseSigma, Math.min(3 * noiseSigma, random.normal() * noiseSigma));
      hand.joints[jointOffset + axis] = local + placement + noise;
    }
    hand.radii[joint] = pose.radii[joint];
  }
  hand.valid = true;
  hand.lastSeen = time;
  projectFromLight(hand.joints, hand.radii, JOURNEY_P1_LANTERN.x, JOURNEY_P1_LANTERN.y,
    JOURNEY_P1_LANTERN.z, JOURNEY_P1_SCREEN_FRAME, hand.flat);
}

function sequenceDuration(scenario: JourneyP1Scenario, gesture: JourneyP1Gesture): number {
  if (scenario === 'held') return 1.8;
  if (scenario === 'negative') return 2.45;
  return gesture === 'hop' ? 2.35 : 2.55;
}

export function generateJourneyP1Sequence(options: JourneyP1SequenceOptions): JourneyP1Sequence {
  const { gesture, scenario, seed, negativeKind } = options;
  const random = new RandomSource(seed);
  const chosenNegative = scenario === 'negative'
    ? negativeKind ?? (['relaxed', 'held-creature', 'slow-drift', 'two-hand-idle'] as const)[seed % 4]
    : undefined;
  const targetId = scenario === 'negative' && chosenNegative === 'held-creature'
    ? heldCreatureForNegative(gesture, seed)
    : pickTargetId(gesture, scenario, seed, options.targetId);
  const target = TARGETS[targetIndex(targetId)];
  const source = scenario === 'negative'
    ? negativePoses(chosenNegative!, target, random)
    : targetHands(target);
  const duration = sequenceDuration(scenario, gesture);
  const gestureStart = scenario === 'true' ? 0.45 : duration;
  const rateHz = 30 + random.integer(61);
  const dt = 1 / rateHz;
  const yaw = random.next() < 0.5 ? -5 : 5;
  const noiseSigma = random.between(0.004, 0.006);
  const hands = [makeHand(0), makeHand(1)];
  const samples: JourneyP1Sample[] = [];
  const frameCount = Math.floor(duration * rateHz) + 1;

  for (let index = 0; index < frameCount; index++) {
    const time = index * dt;
    const distance = scaleDistance(gesture, scenario, chosenNegative, time);
    for (let handIndex = 0; handIndex < hands.length; handIndex++) {
      const original = source.poses[handIndex];
      if (!original) {
        hands[handIndex].valid = false;
        hands[handIndex].flat.valid = false;
        continue;
      }
      const animated = makePose(original, gesture, scenario, targetId, time, yaw, handIndex);
      const offset = scenario === 'true' ? motionOffset(gesture, Math.max(0, time - 0.45)) : 0;
      populateHand(hands[handIndex], animated, source.shifts[handIndex], distance, offset, time, noiseSigma, random);
    }
    const frameHands = hands.map((hand) => {
      const flat = new FlatHand();
      flat.x.set(hand.flat.x);
      flat.y.set(hand.flat.y);
      flat.r.set(hand.flat.r);
      flat.valid = hand.flat.valid;
      return {
        joints: hand.joints.slice(),
        radii: hand.radii.slice(),
        flat,
        valid: hand.valid,
        lastSeen: hand.lastSeen,
        handedness: hand.handedness,
        inputSource: hand.inputSource,
      };
    });
    samples.push({
      time, dt, index, hands: frameHands, frame: JOURNEY_P1_SCREEN_FRAME,
      xrFrame: makeFrame(time, frameHands),
    });
  }

  return {
    gesture, scenario, negativeKind: chosenNegative, seed, rateHz, targetId,
    targetIndex: targetIndex(targetId), duration, gestureStart, samples,
  };
}

export function negativeKindAt(index: number): JourneyP1NegativeKind {
  if (index < 40) return 'relaxed';
  if (index < 150) return 'held-creature';
  if (index < 175) return 'slow-drift';
  return 'two-hand-idle';
}

export function createEmptySyntheticHands(): SyntheticHand[] {
  return [makeHand(0), makeHand(1)];
}

export function copySyntheticHands(source: readonly SyntheticHand[], destination: SyntheticHand[]): void {
  for (let index = 0; index < destination.length; index++) {
    const from = source[index];
    const to = destination[index];
    if (!from || !to) continue;
    to.joints.set(from.joints);
    to.radii.set(from.radii);
    to.flat.x.set(from.flat.x);
    to.flat.y.set(from.flat.y);
    to.flat.r.set(from.flat.r);
    to.flat.valid = from.flat.valid;
    to.valid = from.valid;
    to.lastSeen = from.lastSeen;
  }
}

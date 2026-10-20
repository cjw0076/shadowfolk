import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { InkField } from '../src/play/ink-field.js';
import { FolkWorld } from '../src/play/folk.js';
import { basePoses, orient, shape } from '../src/shadow/hand-model.js';
import type { HandPose } from '../src/shadow/hand-model.js';
import { FlatHand, projectFromLight, STAGE, type ScreenFrame } from '../src/shadow/silhouette.js';

const DT = 1 / 60;
const TRIALS = readIntegerOption('--trials', 5, 1, 100);
const PROFILE_FRAMES = readIntegerOption('--profile-frames', 900, 60, 20_000);
const NOISE_METRES = 0.0015;
const THROTTLE_FACTOR = 6;
const PLAY_P95_BUDGET_MS = 1.5;
const OUTPUT_ARGUMENT = readStringOption('--output') ?? process.env.SHADOW_PHYSICS_OUTPUT ?? '/tmp/codex-20-shadow-physics.json';
const SCREEN: ScreenFrame = {
  ox: 0, oy: STAGE.lightDrop, oz: -STAGE.lightToScreen,
  rx: 1, ry: 0, rz: 0,
  ux: 0, uy: 1, uz: 0,
  nx: 0, ny: 0, nz: 1,
};
const DOOR = { doorX: 0.42, doorY: -0.18, doorW: 0.24, doorH: 0.24 };

type AgentState = 'inactive' | 'walking' | 'falling' | 'ash' | 'home';
interface FolkAgent {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: AgentState;
  heading: number;
}

interface SyntheticHand {
  flat: FlatHand;
  baseX: Float32Array;
  baseY: Float32Array;
  scale: number;
  side: number;
}

interface Simulation {
  field: InkField;
  world: FolkWorld;
}

interface TrialResult {
  trial: number;
  successes: number;
  required: number;
  details: Record<string, number | boolean | number[]>;
}

function readStringOption(name: string): string | undefined {
  const equals = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readIntegerOption(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = readStringOption(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function makeRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function makeProjectedHand(
  pose: HandPose, scale: number, side: number, seed: number, noise = 0, opticalScale = scale,
): SyntheticHand {
  let centreX = 0, centreY = 0;
  for (let joint = 0; joint < pose.radii.length; joint++) {
    centreX += pose.mats[joint * 16 + 12];
    centreY += pose.mats[joint * 16 + 13];
  }
  centreX /= pose.radii.length;
  centreY /= pose.radii.length;

  const lightToHand = STAGE.lightToScreen / opticalScale;
  const joints = new Float32Array(pose.radii.length * 3);
  for (let joint = 0; joint < pose.radii.length; joint++) {
    joints[joint * 3] = pose.mats[joint * 16 + 12] - centreX;
    joints[joint * 3 + 1] = pose.mats[joint * 16 + 13] - centreY + STAGE.lightDrop / opticalScale;
    joints[joint * 3 + 2] = -lightToHand;
  }

  const flat = new FlatHand();
  projectFromLight(joints, pose.radii, 0, 0, 0, SCREEN, flat);
  const baseX = flat.x.slice();
  const baseY = flat.y.slice();
  if (noise > 0) {
    const random = makeRandom(seed);
    for (let joint = 0; joint < baseX.length; joint++) {
      baseX[joint] += (random() * 2 - 1) * noise;
      baseY[joint] += (random() * 2 - 1) * noise;
    }
  }
  return { flat, baseX, baseY, scale, side };
}

function flatBridgePose(): HandPose {
  const pose = basePoses.relaxed();
  shape(pose, { thumb: -0.12, index: -0.18, middle: -0.18, ring: -0.18, pinky: -0.15 });
  return orient(pose, [0, 0, -90]);
}

function cuppedPose(): HandPose {
  const pose = basePoses.relaxed();
  shape(pose, { thumb: 0.28, index: 0.38, middle: 0.42, ring: 0.4, pinky: 0.34 });
  return orient(pose, [0, 0, 0]);
}

function gapBridgePose(): HandPose {
  return orient(basePoses.relaxed(), [-25, 0, 0]);
}

function placeHand(hand: SyntheticHand, x: number, y: number): void {
  const { flat, baseX, baseY } = hand;
  for (let joint = 0; joint < baseX.length; joint++) {
    flat.x[joint] = baseX[joint] + x;
    flat.y[joint] = baseY[joint] + y;
  }
}

function handTop(hand: SyntheticHand): number {
  let top = -Infinity;
  for (let joint = 0; joint < hand.baseY.length; joint++) {
    top = Math.max(top, hand.baseY[joint] + hand.flat.r[joint]);
  }
  return top;
}

function makeSimulation(seed: number, staticRects: readonly (readonly [number, number, number, number])[]): Simulation {
  const field = new InkField();
  for (const [left, bottom, right, top] of staticRects) field.setStaticRect(left, bottom, right, top);
  const world = new FolkWorld(field, seed);
  world.configure({ ...DOOR, spawnX: -0.42, spawnY: 0.022, waveCount: 0 });
  return { field, world };
}

function spawnWave(world: FolkWorld, points: readonly (readonly [number, number])[]): void {
  for (const [x, y] of points) world.spawn(x, y, 1);
}

function spawnFiveOnGround(world: FolkWorld, startX = -0.22, y = 0.022, spacing = 0.025): void {
  for (let folk = 0; folk < 5; folk++) world.spawn(startX - folk * spacing, y, 1);
}

function updateFrame(simulation: Simulation, hands: readonly (readonly [SyntheticHand, number, number])[]): void {
  simulation.field.beginFrame();
  for (const [hand, x, y] of hands) {
    placeHand(hand, x, y);
    simulation.field.addHand(hand.flat, hand.scale, DT, hand.side);
  }
  simulation.world.update(DT);
}

function agentSnapshot(world: FolkWorld): FolkAgent[] {
  return world.agents as FolkAgent[];
}

function observeGap(
  world: FolkWorld,
  maxX: Float32Array,
  turned: Uint8Array,
): void {
  const agents = agentSnapshot(world);
  for (let folk = 0; folk < 5; folk++) {
    const agent = agents[folk];
    if (!agent || agent.state === 'inactive') continue;
    maxX[folk] = Math.max(maxX[folk], agent.x);
    if (agent.heading !== 1) turned[folk] = 1;
  }
}

function runGapPoseTrial(
  trial: number,
  seed: number,
  noise: number,
  pose: HandPose,
  centreY: number,
): TrialResult {
  const floor = [
    [-0.62, -0.26, -0.06, -0.20],
    [0.06, -0.26, 0.58, -0.20],
  ] as const;
  const simulation = makeSimulation(seed, floor);
  spawnFiveOnGround(simulation.world, -0.22, -0.178);
  const hand = makeProjectedHand(pose, 1, 0, seed + 17, noise, 2.5);
  const maxX = new Float32Array(5);
  maxX.fill(-Infinity);
  const turned = new Uint8Array(5);
  let elapsedSeconds = 0;

  for (let frame = 0; frame < 24 * 60; frame++) {
    updateFrame(simulation, [[hand, 0, centreY]]);
    elapsedSeconds = (frame + 1) * DT;
    observeGap(simulation.world, maxX, turned);
    if (allAbove(maxX, 0.09) || allSet(turned)) break;
  }
  const crossed = countAbove(maxX, 0.09);
  const turnedCount = countSet(turned);
  return {
    trial,
    successes: crossed,
    required: 5,
    details: {
      crossedMaxXAbove009: crossed,
      maximumCrossedX: Number(maxX.reduce((maximum, value) => Math.max(maximum, value), -Infinity).toFixed(4)),
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      turnedBack: turnedCount,
      perFolkMaxX: Array.from(maxX, (value) => Number(value.toFixed(4))),
    },
  };
}

function runBridgeTrial(trial: number, seed: number, noise: number): {
  bridge: TrialResult;
  control: TrialResult;
  negativeY: TrialResult;
  negativeOrientation: TrialResult;
} {
  const floor = [
    [-0.62, -0.26, -0.06, -0.20],
    [0.06, -0.26, 0.58, -0.20],
  ] as const;
  const bridge = makeSimulation(seed, floor);
  const control = makeSimulation(seed + 1, floor);
  spawnFiveOnGround(bridge.world, -0.22, -0.178);
  spawnFiveOnGround(control.world, -0.22, -0.178);
  const bridgeHand = makeProjectedHand(gapBridgePose(), 1, 0, seed + 17, noise, 2.5);
  const noHandMaxX = new Float32Array(5);
  noHandMaxX.fill(-Infinity);
  const noHandFell = new Uint8Array(5);
  const ignoredTurns = new Uint8Array(5);
  const bridgeMaxX = new Float32Array(5);
  bridgeMaxX.fill(-Infinity);
  const bridgeTurns = new Uint8Array(5);
  let elapsedSeconds = 0;

  for (let frame = 0; frame < 24 * 60; frame++) {
    updateFrame(bridge, [[bridgeHand, 0, -0.23]]);
    elapsedSeconds = (frame + 1) * DT;
    updateFrame(control, []);
    observeGap(bridge.world, bridgeMaxX, bridgeTurns);
    observeGap(control.world, noHandMaxX, ignoredTurns);
    const controlAgents = agentSnapshot(control.world);
    for (let folk = 0; folk < 5; folk++) {
      const controlAgent = controlAgents[folk];
      if (controlAgent && (controlAgent.state === 'falling' || controlAgent.state === 'ash' || controlAgent.y < -0.23)) noHandFell[folk] = 1;
    }
    if (allAbove(bridgeMaxX, 0.09) && allSet(noHandFell)) break;
  }
  const bridgeCrossed = countAbove(bridgeMaxX, 0.09);
  const fellCount = countSet(noHandFell);
  const bridgeTurned = countSet(bridgeTurns);
  const negativeY = runGapPoseTrial(trial, seed + 10_000, noise, gapBridgePose(), -0.19);
  const negativeOrientation = runGapPoseTrial(trial, seed + 20_000, noise,
    orient(basePoses.relaxed(), [0, 0, 90]), -0.23);
  return {
    bridge: {
      trial,
      successes: bridgeCrossed,
      required: 5,
      details: {
        crossedMaxXAbove009: bridgeCrossed,
        maximumCrossedX: Number(bridgeMaxX.reduce((maximum, value) => Math.max(maximum, value), -Infinity).toFixed(4)),
        elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
        turnedBack: bridgeTurned,
        perFolkMaxX: Array.from(bridgeMaxX, (value) => Number(value.toFixed(4))),
      },
    },
    control: { trial, successes: fellCount, required: 5, details: { fell: fellCount } },
    negativeY,
    negativeOrientation,
  };
}

function runCatchTrial(trial: number, seed: number, noise: number): TrialResult {
  const simulation = makeSimulation(seed, [[-0.58, -0.32, 0.58, -0.30]]);
  const starts: [number, number][] = [];
  for (let folk = 0; folk < 5; folk++) starts.push([-0.025 + folk * 0.0125, 0.28]);
  spawnWave(simulation.world, starts);
  const hand = makeProjectedHand(cuppedPose(), 1, 0, seed + 17, noise);
  const caught = new Uint8Array(5);
  const firstCatchFrames = new Int16Array(5);
  firstCatchFrames.fill(-1);

  for (let frame = 0; frame < 8 * 60; frame++) {
    updateFrame(simulation, [[hand, 0, 0.055]]);
    const agents = agentSnapshot(simulation.world);
    for (let folk = 0; folk < 5; folk++) {
      const agent = agents[folk];
      if (agent && agent.state === 'walking' && agent.y > -0.08 && !caught[folk]) {
        caught[folk] = 1;
        firstCatchFrames[folk] = frame;
      }
    }
    if (countSet(caught) >= 5) break;
  }
  return {
    trial,
    successes: countSet(caught),
    required: 4,
    details: {
      caught: countSet(caught),
      caughtPerFolk: Array.from(caught),
      firstCatchSeconds: Array.from(firstCatchFrames, (frame) => frame < 0 ? -1 : Number(((frame + 1) * DT).toFixed(3))),
    },
  };
}

function runFlickTrial(trial: number, seed: number, noise: number): TrialResult {
  const ledgeStart = 0.32;
  const ledgeTop = -0.10;
  const simulation = makeSimulation(seed, [
    [-0.48, -0.26, ledgeStart, -0.20],
    [ledgeStart, -0.20, 0.58, ledgeTop],
    [-0.58, -0.38, 0.58, -0.36],
  ]);
  simulation.world.configure({ doorX: 0.7, doorY: 0.5, doorW: 0.02, doorH: 0.02 });
  spawnWave(simulation.world, [[0.23, -0.18]]);
  const hand = makeProjectedHand(gapBridgePose(), 1, 0, seed + 17, noise, 2.5);
  let landed = false;
  let maxVerticalVelocity = 0;
  let landingX = -1;
  let landingY = -1;
  let landingTimeSeconds = -1;

  for (let frame = 0; frame < 8 * 60; frame++) {
    const time = frame * DT;
    const progress = Math.min(1, Math.max(0, (time - 0.5) / 0.10));
    const handX = 0.23 + 0.05 * progress;
    const handY = -0.23 + 0.12 * progress;
    updateFrame(simulation, [[hand, handX, handY]]);
    const agent = agentSnapshot(simulation.world)[0];
    if (!agent) continue;
    maxVerticalVelocity = Math.max(maxVerticalVelocity, agent.vy);
    if (agent.state === 'walking' && agent.x >= ledgeStart && agent.y >= ledgeTop + 0.004) {
      landed = true;
      landingX = agent.x;
      landingY = agent.y;
      landingTimeSeconds = (frame + 1) * DT;
      break;
    }
  }
  return {
    trial,
    successes: landed ? 1 : 0,
    required: 1,
    details: {
      landedOnLedge: landed,
      spawnX: 0.23,
      spawnY: -0.18,
      handStartX: 0.23,
      handStartY: -0.23,
      handDeltaX: 0.05,
      handDeltaY: 0.12,
      movementStartSeconds: 0.5,
      movementDurationSeconds: 0.10,
      handVerticalSpeed: 1.2,
      ledgeStartX: ledgeStart,
      ledgeTopY: ledgeTop,
      maxVerticalVelocity: Number(maxVerticalVelocity.toFixed(4)),
      landingTimeSeconds: Number(landingTimeSeconds.toFixed(3)),
      landingX: Number(landingX.toFixed(4)),
      landingY: Number(landingY.toFixed(4)),
    },
  };
}

function runSolidityTrial(trial: number, seed: number, noise: number): { crisp: TrialResult; soft: TrialResult } {
  const floor = [[-0.58, -0.06, 0.58, 0]] as const;
  const crisp = makeSimulation(seed, floor);
  const soft = makeSimulation(seed + 1, floor);
  const points: [number, number][] = [];
  for (let folk = 0; folk < 5; folk++) points.push([-0.05 + folk * 0.006, 0.22]);
  spawnWave(crisp.world, points);
  spawnWave(soft.world, points);
  const crispHand = makeProjectedHand(flatBridgePose(), 1, 0, seed + 17, noise);
  const softHand = makeProjectedHand(flatBridgePose(), 1.45, 0, seed + 31, noise);
  const heldSeconds = new Float32Array(5);
  const maxHeldSeconds = new Float32Array(5);
  const firstHeldFrames = new Int16Array(5);
  firstHeldFrames.fill(-1);
  const held = new Uint8Array(5);
  const sank = new Uint8Array(5);

  for (let frame = 0; frame < 10 * 60; frame++) {
    updateFrame(crisp, [[crispHand, 0, 0.10]]);
    updateFrame(soft, [[softHand, 0, 0.10]]);
    const crispAgents = agentSnapshot(crisp.world);
    const softAgents = agentSnapshot(soft.world);
    for (let folk = 0; folk < 5; folk++) {
      const agent = crispAgents[folk];
      if (agent && agent.state === 'walking' && agent.y >= 0.085) {
        heldSeconds[folk] += DT;
        maxHeldSeconds[folk] = Math.max(maxHeldSeconds[folk], heldSeconds[folk]);
        if (firstHeldFrames[folk] < 0) firstHeldFrames[folk] = frame;
      } else heldSeconds[folk] = 0;
      if (heldSeconds[folk] >= 0.5) held[folk] = 1;
      const softAgent = softAgents[folk];
      if (softAgent && softAgent.state === 'walking' && softAgent.y <= 0.07) sank[folk] = 1;
    }
    if (allSet(held) && allSet(sank)) break;
  }
  const heldCount = countSet(held);
  const sankCount = countSet(sank);
  return {
    crisp: {
      trial,
      successes: heldCount,
      required: 5,
      details: {
        heldAtLeastHalfSecond: heldCount,
        heldPerFolk: Array.from(held),
        maxContinuousHoldSeconds: Array.from(maxHeldSeconds, (seconds) => Number(seconds.toFixed(3))),
        firstLandingSeconds: Array.from(firstHeldFrames, (frame) => frame < 0 ? -1 : Number(((frame + 1) * DT).toFixed(3))),
      },
    },
    soft: { trial, successes: sankCount, required: 5, details: { sankAndLandedUnharmed: sankCount } },
  };
}

function allSet(values: Uint8Array): boolean {
  for (let index = 0; index < values.length; index++) if (!values[index]) return false;
  return true;
}

function countSet(values: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < values.length; index++) count += values[index] ? 1 : 0;
  return count;
}

function allAbove(values: Float32Array, threshold: number): boolean {
  for (let index = 0; index < values.length; index++) if (values[index] <= threshold) return false;
  return true;
}

function countAbove(values: Float32Array, threshold: number): number {
  let count = 0;
  for (let index = 0; index < values.length; index++) count += values[index] > threshold ? 1 : 0;
  return count;
}

function scenarioReport(results: readonly TrialResult[], requiredPerTrial: number): Record<string, unknown> {
  let successes = 0;
  for (const result of results) successes += result.successes;
  return {
    trials: results.length,
    folkPerTrial: 5,
    successes,
    possible: results.length * 5,
    requiredPerTrial,
    pass: results.length > 0 && results.every((result) => result.successes >= requiredPerTrial),
    perTrial: results,
  };
}

function trialRateReport(results: readonly TrialResult[], requiredRate: number): Record<string, unknown> {
  const successfulTrials = results.filter((result) => result.successes >= result.required).length;
  const requiredTrials = Math.ceil(results.length * requiredRate);
  return {
    trials: results.length,
    folkPerTrial: 1,
    successfulTrials,
    requiredTrials,
    requiredRate,
    pass: results.length > 0 && successfulTrials >= requiredTrials,
    perTrial: results,
  };
}

function wallControlReport(results: readonly TrialResult[]): Record<string, unknown> {
  const turns = results.map((result) => Number(result.details.turnedBack ?? 0));
  const pass = results.length > 0 && results.every((result, index) => result.successes === 0 && turns[index] >= 4);
  return {
    trials: results.length,
    folkPerTrial: 5,
    falsePositiveCrossings: results.reduce((sum, result) => sum + result.successes, 0),
    minimumTurnsPerTrial: 4,
    pass,
    perTrial: results,
  };
}

function runSuite(noise: number, seedBase: number): Record<string, unknown> {
  const bridge: TrialResult[] = [];
  const noBridge: TrialResult[] = [];
  const negativeY: TrialResult[] = [];
  const negativeOrientation: TrialResult[] = [];
  const catchTrials: TrialResult[] = [];
  const flick: TrialResult[] = [];
  const crisp: TrialResult[] = [];
  const soft: TrialResult[] = [];

  for (let trial = 0; trial < TRIALS; trial++) {
    const seed = seedBase + trial * 101;
    const bridgePair = runBridgeTrial(trial + 1, seed, noise);
    bridge.push(bridgePair.bridge);
    noBridge.push(bridgePair.control);
    negativeY.push(bridgePair.negativeY);
    negativeOrientation.push(bridgePair.negativeOrientation);
    catchTrials.push(runCatchTrial(trial + 1, seed + 1_000, noise));
    flick.push(runFlickTrial(trial + 1, seed + 2_000, noise));
    const solidity = runSolidityTrial(trial + 1, seed + 3_000, noise);
    crisp.push(solidity.crisp);
    soft.push(solidity.soft);
  }

  const scenarios = {
    bridge: scenarioReport(bridge, 5),
    noHandControlFalls: scenarioReport(noBridge, 5),
    negativeYWall: wallControlReport(negativeY),
    negativeOrientationWall: wallControlReport(negativeOrientation),
    cuppedHandCatch: scenarioReport(catchTrials, 4),
    flickToLedge: trialRateReport(flick, 0.8),
    crispHandHolds: scenarioReport(crisp, 5),
    softHandSinksUnharmed: scenarioReport(soft, 5),
  };
  return { jointJitterMetres: noise, scenarios, pass: Object.values(scenarios).every((scenario) => (scenario as { pass: boolean }).pass) };
}

function percentile95(samples: Float64Array): number {
  const sorted = samples.slice().sort();
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function runPerformanceProfile(seed: number): Record<string, unknown> {
  const simulation = makeSimulation(seed, [[-0.62, -0.06, 0.62, 0]]);
  for (let folk = 0; folk < 40; folk++) simulation.world.spawn(-0.55 + folk * 0.019, 0.022, 1);
  const handA = makeProjectedHand(flatBridgePose(), 1, 0, seed + 1, NOISE_METRES);
  const handB = makeProjectedHand(cuppedPose(), 1, 1, seed + 2, NOISE_METRES);
  const playSamples = new Float64Array(PROFILE_FRAMES);
  const wholeSamples = new Float64Array(PROFILE_FRAMES);

  for (let frame = 0; frame < PROFILE_FRAMES + 120; frame++) {
    const time = frame * DT;
    const fullStart = performance.now();
    simulation.field.beginFrame();
    placeHand(handA, -0.22 + Math.sin(time * 1.8) * 0.045, 0.12 + Math.sin(time * 1.2) * 0.025);
    placeHand(handB, 0.22 + Math.cos(time * 1.5) * 0.045, 0.12 + Math.cos(time * 1.1) * 0.025);
    simulation.field.addHand(handA.flat, handA.scale, DT, handA.side);
    simulation.field.addHand(handB.flat, handB.scale, DT, handB.side);
    const playStart = performance.now();
    simulation.world.update(DT);
    const playElapsed = performance.now() - playStart;
    const wholeElapsed = performance.now() - fullStart;
    if (frame >= 120) {
      const sample = frame - 120;
      playSamples[sample] = playElapsed;
      wholeSamples[sample] = wholeElapsed;
    }
  }

  const playNative = percentile95(playSamples);
  const wholeNative = percentile95(wholeSamples);
  const playScaled = playNative * THROTTLE_FACTOR;
  const wholeScaled = wholeNative * THROTTLE_FACTOR;
  return {
    agents: 40,
    movingHands: 2,
    samples: PROFILE_FRAMES,
    warmupFrames: 120,
    nativeNode: {
      playUpdateP95Ms: Number(playNative.toFixed(4)),
      wholeUpdateP95Ms: Number(wholeNative.toFixed(4)),
    },
    sixXEstimate: {
      method: 'native Node timings multiplied by six; no operating-system CPU throttle applied',
      factor: THROTTLE_FACTOR,
      playUpdateP95Ms: Number(playScaled.toFixed(4)),
      wholeUpdateP95Ms: Number(wholeScaled.toFixed(4)),
      playBudgetMs: PLAY_P95_BUDGET_MS,
      pass: playScaled <= PLAY_P95_BUDGET_MS,
    },
  };
}

function writeReport(report: Record<string, unknown>): string | null {
  if (OUTPUT_ARGUMENT === '-') return null;
  const path = resolve(OUTPUT_ARGUMENT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function main(): void {
  const standard = runSuite(0, 20_201);
  const noisy = runSuite(NOISE_METRES, 30_101);
  const performanceReport = runPerformanceProfile(40_001);
  const failures: string[] = [];
  if (!standard.pass) failures.push('one or more baseline physics scenarios missed their target');
  if (!noisy.pass) failures.push('one or more joint-noise physics scenarios missed their target');
  if (!(performanceReport as { sixXEstimate: { pass: boolean } }).sixXEstimate.pass) failures.push('six-times play-update p95 exceeded 1.5 ms');

  const report: Record<string, unknown> = {
    benchmark: 'codex-20-shadow-physics',
    node: process.version,
    geometry: {
      projection: 'synthetic hand-model joints projected through STAGE lantern geometry with projectFromLight',
      inkCellMetres: new InkField().cell,
      trials: TRIALS,
      noise: 'fixed per-joint uniform x/y jitter per trial',
    },
    baseline: standard,
    noise: noisy,
    performance: performanceReport,
    rendering: {
      newPerFrameTextureUploads: 'not measured by this Node-only physics bench; it has no renderer or textures',
    },
    pass: failures.length === 0,
    failures,
  };
  const output = writeReport(report);
  process.stdout.write(`${JSON.stringify({ ...report, output }, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}

main();

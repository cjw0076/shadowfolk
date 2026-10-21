import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { InkField } from '../src/play/ink-field.js';
import { FolkWorld } from '../src/play/folk.js';
import { basePoses, orient, shape } from '../src/shadow/hand-model.js';
import type { HandPose } from '../src/shadow/hand-model.js';
import { FlatHand, projectFromLight, STAGE, type ScreenFrame } from '../src/shadow/silhouette.js';

const DT = 1 / 60;
const NIGHT_COUNT = 8;
const DEFAULT_SEEDS = 20;
const DEFAULT_SEED_START = 21_001;
const DEFAULT_PHYSICS_TRIALS = 5;
const SOLVER_HOME_TARGET = 0.75;
const NO_HAND_HOME_CEILING = 0.4;
const RAIN_SHELTER_TARGET = 0.9;
const GUST_SHELTER_TARGET = 0.8;
const CROW_SWAT_TARGET = 0.8;
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(TOOL_DIRECTORY, '../../collab/codex/21-evidence/crossing-bench.json');
const SCREEN: ScreenFrame = {
  ox: 0, oy: STAGE.lightDrop, oz: -STAGE.lightToScreen,
  rx: 1, ry: 0, rz: 0,
  ux: 0, uy: 1, uz: 0,
  nx: 0, ny: 0, nz: 1,
};
const DOOR = { doorX: 0.42, doorY: -0.18, doorW: 0.24, doorH: 0.24 };
const FLOOR_WITH_GAP = [
  [-0.62, -0.26, -0.06, -0.20],
  [0.06, -0.26, 0.58, -0.20],
] as const;

type Resolution = 'home' | 'ash' | 'walking' | 'falling' | 'inactive';

interface AgentSnapshot {
  x: number;
  y: number;
  state: Resolution;
}

interface SyntheticHand {
  flat: FlatHand;
  baseX: Float32Array;
  baseY: Float32Array;
  scale: number;
  side: number;
}

interface P1Trial {
  seed: number;
  total: number;
  home: number;
  ash: number;
  resolved: boolean;
}

interface CrossingTrial {
  night: number;
  seed: number;
  total: number;
  home: number;
  ash: number;
  lost: number;
}

interface HazardTrial {
  seed: number;
  sheltered?: number;
  total?: number;
  swatted?: number;
}

interface RatioReport {
  numerator: number;
  denominator: number;
  rate: number;
  trials: HazardTrial[];
  pass?: boolean;
}

interface LayoutValidation {
  valid: boolean;
  errors?: readonly string[];
}

interface CrossingBenchAdapter {
  generateLevel(night: number, seed: number): unknown | Promise<unknown>;
  validateLayout(level: unknown, night: number, seed: number): LayoutValidation | boolean | Promise<LayoutValidation | boolean>;
  runLevel(
    level: unknown,
    options: { night: number; seed: number; hands: 'solver' | 'none' },
  ): CrossingTrial | Promise<CrossingTrial>;
  runRainSoft(seed: number): HazardTrial | Promise<HazardTrial>;
  runGustWall(seed: number): HazardTrial | Promise<HazardTrial>;
  runCrowSwat(seed: number): HazardTrial | Promise<HazardTrial>;
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
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function readOptions(): {
  seeds: number;
  seedStart: number;
  physicsTrials: number;
  adapterPath?: string;
  outputPath: string;
  requireP2: boolean;
} {
  const output = readStringOption('--output') ?? process.env.CROSSING_BENCH_OUTPUT ?? DEFAULT_OUTPUT;
  const adapter = readStringOption('--adapter') ?? process.env.CROSSING_BENCH_ADAPTER;
  return {
    seeds: readIntegerOption('--seeds', DEFAULT_SEEDS, 1, 10_000),
    seedStart: readIntegerOption('--seed-start', DEFAULT_SEED_START, 0, 0xffff_ffff),
    physicsTrials: readIntegerOption('--physics-trials', DEFAULT_PHYSICS_TRIALS, 1, 100),
    adapterPath: adapter,
    outputPath: output,
    requireP2: process.argv.includes('--require-p2'),
  };
}

function makeRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function makeProjectedHand(
  pose: HandPose,
  scale: number,
  side: number,
  seed: number,
  noise = 0,
  opticalScale = scale,
): SyntheticHand {
  let centreX = 0;
  let centreY = 0;
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

function gapBridgePose(): HandPose {
  return orient(basePoses.relaxed(), [-25, 0, 0]);
}

function placeHand(hand: SyntheticHand, x: number, y: number): void {
  for (let joint = 0; joint < hand.baseX.length; joint++) {
    hand.flat.x[joint] = hand.baseX[joint] + x;
    hand.flat.y[joint] = hand.baseY[joint] + y;
  }
}

function makeSimulation(seed: number, staticRects: readonly (readonly [number, number, number, number])[]): {
  field: InkField;
  world: FolkWorld;
} {
  const field = new InkField();
  for (const [left, bottom, right, top] of staticRects) field.setStaticRect(left, bottom, right, top);
  const world = new FolkWorld(field, seed);
  world.configure({ ...DOOR, spawnX: -0.42, spawnY: 0.022, waveCount: 0 });
  return { field, world };
}

function updateFrame(
  field: InkField,
  world: FolkWorld,
  hands: readonly (readonly [SyntheticHand, number, number])[],
): void {
  field.beginFrame();
  for (const [hand, x, y] of hands) {
    placeHand(hand, x, y);
    field.addHand(hand.flat, hand.scale, DT, hand.side);
  }
  world.update(DT);
}

function snapshots(world: FolkWorld): AgentSnapshot[] {
  return world.agents.slice(0, world.count) as AgentSnapshot[];
}

function runP1GapTrial(seed: number, bridge: boolean): P1Trial {
  const simulation = makeSimulation(seed, FLOOR_WITH_GAP);
  for (let folk = 0; folk < 5; folk++) simulation.world.spawn(-0.22 - folk * 0.025, -0.178, 1);
  const hand = makeProjectedHand(gapBridgePose(), 1, 0, seed + 17, 0, 2.5);
  const hands: readonly (readonly [SyntheticHand, number, number])[] = bridge ? [[hand, 0, -0.23]] : [];
  const maxFrames = 24 * 60;

  for (let frame = 0; frame < maxFrames; frame++) {
    updateFrame(simulation.field, simulation.world, hands);
    const agents = snapshots(simulation.world);
    if (agents.every((agent) => agent.state === 'home' || agent.state === 'ash')) break;
  }

  const agents = snapshots(simulation.world);
  const home = agents.filter((agent) => agent.state === 'home').length;
  const ash = agents.filter((agent) => agent.state === 'ash').length;
  return { seed, total: agents.length, home, ash, resolved: home + ash === agents.length };
}

function coverageRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function runRainSoftTrial(seed: number): HazardTrial {
  const field = new InkField();
  const umbrella = makeProjectedHand(flatBridgePose(), 1.45, 0, seed, 0, 1.45);
  field.beginFrame();
  placeHand(umbrella, 0, 0.035);
  field.addHand(umbrella.flat, umbrella.scale, DT, umbrella.side);

  const lanes = 50;
  const samplesPerDrop = 41;
  let sheltered = 0;
  for (let lane = 0; lane < lanes; lane++) {
    const x = -0.125 + (lane + 0.5) * 0.25 / lanes;
    let caught = false;
    for (let step = 0; step < samplesPerDrop; step++) {
      const y = 0.18 - step * 0.01;
      if (field.sample(x, y) === 2) {
        caught = true;
        break;
      }
    }
    if (caught) sheltered++;
  }
  return { seed, sheltered, total: lanes };
}

function runGustWallTrial(seed: number): HazardTrial {
  const field = new InkField();
  const wallPose = orient(basePoses.relaxed(), [0, 0, 0]);
  const wall = makeProjectedHand(wallPose, 1, 0, seed, 0, 2.5);
  field.beginFrame();
  placeHand(wall, 0.035, -0.105);
  field.addHand(wall.flat, wall.scale, DT, wall.side);

  const walkers = 20;
  let sheltered = 0;
  for (let walker = 0; walker < walkers; walker++) {
    const x = -0.12 + walker * 0.006;
    let protectedByWall = false;
    for (let offset = field.cell; offset <= 0.12 && !protectedByWall; offset += field.cell) {
      for (let y = -0.205; y <= -0.105; y += field.cell) {
        if (field.sample(x + offset, y) === 1) {
          protectedByWall = true;
          break;
        }
      }
    }
    if (protectedByWall) sheltered++;
  }
  return { seed, sheltered, total: walkers };
}

function cubicPoint(
  start: readonly [number, number],
  controlA: readonly [number, number],
  controlB: readonly [number, number],
  end: readonly [number, number],
  t: number,
): readonly [number, number] {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t * t * t;
  return [
    a * start[0] + b * controlA[0] + c * controlB[0] + d * end[0],
    a * start[1] + b * controlA[1] + c * controlB[1] + d * end[1],
  ];
}

function runCrowSwatTrial(seed: number): HazardTrial {
  const random = makeRandom(seed);
  const hand = makeProjectedHand(flatBridgePose(), 1, 0, seed + 31, 0.001, 2.5);
  const pathStart: readonly [number, number] = [0.31, 0.10];
  const controlA: readonly [number, number] = [0.25, -0.14];
  const controlB: readonly [number, number] = [-0.18, 0.08];
  const pathEnd: readonly [number, number] = [-0.31, -0.18];
  const crossing = 0.32 + random() * 0.36;
  const [targetX, targetY] = cubicPoint(pathStart, controlA, controlB, pathEnd, crossing);
  const field = new InkField();
  let crossed = false;

  for (let frame = 0; frame <= 72; frame++) {
    const time = frame / 72;
    const [crowX, crowY] = cubicPoint(pathStart, controlA, controlB, pathEnd, time);
    field.beginFrame();
    const approach = Math.max(0, Math.min(1, (time - (crossing - 0.08)) / 0.16));
    const handX = targetX - 0.18 + approach * 0.36;
    const handY = targetY - 0.12 + approach * 0.24;
    placeHand(hand, handX, handY);
    field.addHand(hand.flat, hand.scale, DT, hand.side);
    for (let wing = 0; wing <= 8; wing++) {
      const x = crowX - 0.08 + wing * 0.02;
      if (field.sample(x, crowY) === 1) {
        crossed = true;
        break;
      }
    }
    if (crossed) break;
  }
  return { seed, swatted: crossed ? 1 : 0, total: 1 };
}

function ratioReport(trials: readonly HazardTrial[], valueKey: 'sheltered' | 'swatted'): RatioReport {
  const numerator = trials.reduce((sum, trial) => sum + (trial[valueKey] ?? 0), 0);
  const denominator = trials.reduce((sum, trial) => sum + (trial.total ?? 0), 0);
  return { numerator, denominator, rate: coverageRatio(numerator, denominator), trials: [...trials] };
}

function assertTrialCount(trial: CrossingTrial, expected: { night: number; seed: number }): CrossingTrial {
  const counts = [trial.total, trial.home, trial.ash, trial.lost];
  if (trial.night !== expected.night || trial.seed !== expected.seed
    || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || trial.total <= 0 || trial.home + trial.ash + trial.lost !== trial.total) {
    throw new Error(`adapter returned invalid crossing counts for night ${expected.night}, seed ${expected.seed}: ${JSON.stringify(trial)}`);
  }
  return trial;
}

function assertHazardTrial(trial: HazardTrial, metric: 'sheltered' | 'swatted', context: string): HazardTrial {
  const numerator = trial[metric];
  const denominator = trial.total;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator === undefined || denominator === undefined || numerator < 0 || denominator <= 0 || numerator > denominator) {
    throw new Error(`${context} adapter returned invalid counts: ${JSON.stringify(trial)}`);
  }
  return trial;
}

async function loadAdapter(path: string | undefined): Promise<CrossingBenchAdapter | null> {
  if (!path) return null;
  const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const loaded = await import(pathToFileURL(resolved).href) as {
    default?: CrossingBenchAdapter | (() => CrossingBenchAdapter | Promise<CrossingBenchAdapter>);
    crossingBench?: CrossingBenchAdapter | (() => CrossingBenchAdapter | Promise<CrossingBenchAdapter>);
    createCrossingBenchAdapter?: () => CrossingBenchAdapter | Promise<CrossingBenchAdapter>;
  };
  const candidate = loaded.createCrossingBenchAdapter ?? loaded.crossingBench ?? loaded.default;
  const adapter = typeof candidate === 'function' ? await candidate() : candidate;
  if (!adapter || typeof adapter.generateLevel !== 'function' || typeof adapter.validateLayout !== 'function'
    || typeof adapter.runLevel !== 'function' || typeof adapter.runRainSoft !== 'function'
    || typeof adapter.runGustWall !== 'function' || typeof adapter.runCrowSwat !== 'function') {
    throw new Error('adapter must expose generateLevel, validateLayout, runLevel, runRainSoft, runGustWall, and runCrowSwat');
  }
  return adapter;
}

async function runP2Suite(
  adapter: CrossingBenchAdapter,
  seeds: number,
  seedStart: number,
): Promise<Record<string, unknown>> {
  const nights: Record<string, unknown>[] = [];
  const rainTrials: HazardTrial[] = [];
  const gustTrials: HazardTrial[] = [];
  const crowTrials: HazardTrial[] = [];
  let invalidLayouts = 0;

  const nightList = (process.env.CROSSING_NIGHTS ?? '').split(',').map(Number).filter((night) => night >= 1);
  for (const night of nightList.length ? nightList : Array.from({ length: NIGHT_COUNT }, (_, index) => index + 1)) {
    const solverTrials: CrossingTrial[] = [];
    const noHandTrials: CrossingTrial[] = [];
    const layoutChecks: Record<string, unknown>[] = [];
    for (let index = 0; index < seeds; index++) {
      const seed = (seedStart + (night - 1) * seeds + index) >>> 0;
      const level = await adapter.generateLevel(night, seed);
      const validation = await adapter.validateLayout(level, night, seed);
      const valid = typeof validation === 'boolean' ? validation : validation.valid;
      if (!valid) invalidLayouts++;
      layoutChecks.push({ seed, valid, errors: typeof validation === 'boolean' ? [] : validation.errors ?? [] });
      if (!valid) continue;

      const solver = assertTrialCount(await adapter.runLevel(level, { night, seed, hands: 'solver' }), { night, seed });
      const noHands = assertTrialCount(await adapter.runLevel(level, { night, seed, hands: 'none' }), { night, seed });
      solverTrials.push(solver);
      noHandTrials.push(noHands);
    }
    const solverHome = solverTrials.reduce((sum, trial) => sum + trial.home, 0);
    const solverTotal = solverTrials.reduce((sum, trial) => sum + trial.total, 0);
    const noHandHome = noHandTrials.reduce((sum, trial) => sum + trial.home, 0);
    const noHandTotal = noHandTrials.reduce((sum, trial) => sum + trial.total, 0);
    const solverRate = coverageRatio(solverHome, solverTotal);
    const noHandRate = coverageRatio(noHandHome, noHandTotal);
    const everySolverSeedPasses = solverTrials.length === seeds
      && solverTrials.every((trial) => coverageRatio(trial.home, trial.total) >= SOLVER_HOME_TARGET);
    nights.push({
      night,
      seeds: seeds,
      layoutsValid: layoutChecks.every((layout) => layout.valid),
      layoutChecks,
      solver: { home: solverHome, total: solverTotal, rate: solverRate,
        pass: everySolverSeedPasses, trials: solverTrials },
      noHands: {
        home: noHandHome,
        total: noHandTotal,
        rate: noHandRate,
        applies: night >= 2,
        pass: night === 1 || noHandRate <= NO_HAND_HOME_CEILING,
        trials: noHandTrials,
      },
    });
  }

  for (let index = 0; index < seeds; index++) {
    const seed = (seedStart + NIGHT_COUNT * seeds + index) >>> 0;
    rainTrials.push(assertHazardTrial(await adapter.runRainSoft(seed), 'sheltered', 'rain-soft'));
    gustTrials.push(assertHazardTrial(await adapter.runGustWall(seed), 'sheltered', 'gust-wall'));
    crowTrials.push(assertHazardTrial(await adapter.runCrowSwat(seed), 'swatted', 'crow-swat'));
  }

  const rain = ratioReport(rainTrials, 'sheltered');
  const gust = ratioReport(gustTrials, 'sheltered');
  const crow = ratioReport(crowTrials, 'swatted');
  rain.pass = rain.rate >= RAIN_SHELTER_TARGET;
  gust.pass = gust.rate >= GUST_SHELTER_TARGET;
  crow.pass = crow.rate >= CROW_SWAT_TARGET;
  const nightChecks = nights as Array<{
    layoutsValid: boolean;
    solver: { pass: boolean };
    noHands: { pass: boolean };
  }>;
  const pass = invalidLayouts === 0 && nightChecks.every((night) => night.layoutsValid && night.solver.pass && night.noHands.pass)
    && rain.pass && gust.pass && crow.pass;
  return {
    status: 'complete',
    dimensions: { nights: NIGHT_COUNT, seedsPerNight: seeds },
    gates: {
      everyLayoutValid: invalidLayouts === 0,
      solverHomeRateByNightAtLeast: SOLVER_HOME_TARGET,
      noHandHomeRateNights2To8AtMost: NO_HAND_HOME_CEILING,
      rainSoftShelterAtLeast: RAIN_SHELTER_TARGET,
      gustWallShelterAtLeast: GUST_SHELTER_TARGET,
      crowSwatRateAtLeast: CROW_SWAT_TARGET,
    },
    invalidLayouts,
    nights,
    hazards: { rainSoft: rain, gustWall: gust, crowSwat: crow },
    pass,
  };
}

function runP1Physics(trials: number, seedStart: number): Record<string, unknown> {
  const bridgeTrials: P1Trial[] = [];
  const noHandTrials: P1Trial[] = [];
  const rainTrials: HazardTrial[] = [];
  const gustTrials: HazardTrial[] = [];
  const crowTrials: HazardTrial[] = [];
  const bridgeStart = performance.now();

  for (let index = 0; index < trials; index++) {
    const seed = (seedStart + index * 101) >>> 0;
    bridgeTrials.push(runP1GapTrial(seed, true));
    noHandTrials.push(runP1GapTrial((seed + 1) >>> 0, false));
    rainTrials.push(runRainSoftTrial((seed + 2) >>> 0));
    gustTrials.push(runGustWallTrial((seed + 3) >>> 0));
    crowTrials.push(runCrowSwatTrial((seed + 4) >>> 0));
  }

  const bridgeHome = bridgeTrials.reduce((sum, trial) => sum + trial.home, 0);
  const bridgeTotal = bridgeTrials.reduce((sum, trial) => sum + trial.total, 0);
  const noHandHome = noHandTrials.reduce((sum, trial) => sum + trial.home, 0);
  const noHandTotal = noHandTrials.reduce((sum, trial) => sum + trial.total, 0);
  const rain = ratioReport(rainTrials, 'sheltered');
  const gust = ratioReport(gustTrials, 'sheltered');
  const crow = ratioReport(crowTrials, 'swatted');
  const bridgeRate = coverageRatio(bridgeHome, bridgeTotal);
  const noHandRate = coverageRatio(noHandHome, noHandTotal);
  rain.pass = rain.rate >= RAIN_SHELTER_TARGET;
  gust.pass = gust.rate >= GUST_SHELTER_TARGET;
  crow.pass = crow.rate >= CROW_SWAT_TARGET;
  const pass = bridgeRate >= SOLVER_HOME_TARGET && noHandRate <= NO_HAND_HOME_CEILING
    && rain.pass && gust.pass && crow.pass;

  return {
    scope: 'P1 InkField/FolkWorld substrate fixtures; not generated P2 level evidence',
    elapsedMs: Number((performance.now() - bridgeStart).toFixed(2)),
    gates: {
      gapBridgeHomeRateAtLeast: SOLVER_HOME_TARGET,
      noHandGapHomeRateAtMost: NO_HAND_HOME_CEILING,
      rainSoftShelterAtLeast: RAIN_SHELTER_TARGET,
      gustWallShelterAtLeast: GUST_SHELTER_TARGET,
      crowPathInkIntersectionAtLeast: CROW_SWAT_TARGET,
    },
    gapBridge: { home: bridgeHome, total: bridgeTotal, rate: bridgeRate, pass: bridgeRate >= SOLVER_HOME_TARGET, trials: bridgeTrials },
    noHandsGap: { home: noHandHome, total: noHandTotal, rate: noHandRate, pass: noHandRate <= NO_HAND_HOME_CEILING, trials: noHandTrials },
    rainSoft: rain,
    gustWall: gust,
    crowPathInkIntersection: crow,
    pass,
  };
}

function writeReport(path: string, report: Record<string, unknown>): string | null {
  if (path === '-') return null;
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  return output;
}

async function main(): Promise<void> {
  const options = readOptions();
  const physics = runP1Physics(options.physicsTrials, options.seedStart ^ 0x50485953);
  const adapter = await loadAdapter(options.adapterPath);
  let crossing: Record<string, unknown>;
  if (adapter) {
    crossing = await runP2Suite(adapter, options.seeds, options.seedStart);
  } else {
    crossing = {
      status: 'pending',
      reason: 'Pass --adapter=<module> after levels/hazards expose the crossing bench interface.',
      dimensions: { nights: NIGHT_COUNT, seedsPerNight: options.seeds },
      requiredExports: [
        'generateLevel(night, seed)',
        'validateLayout(level, night, seed)',
        'runLevel(level, { night, seed, hands: "solver" | "none" })',
        'runRainSoft(seed)',
        'runGustWall(seed)',
        'runCrowSwat(seed)',
      ],
      pass: false,
    };
  }

  const p2Pass = crossing.status === 'complete' && crossing.pass === true;
  const p1Pass = physics.pass === true;
  const pass = p1Pass && p2Pass;
  const report: Record<string, unknown> = {
    benchmark: 'codex-21-crossing-p2',
    node: process.version,
    dimensions: { nights: NIGHT_COUNT, seedsPerNight: options.seeds, seedStart: options.seedStart },
    thresholds: {
      solverHomeRate: SOLVER_HOME_TARGET,
      noHandHomeRateNights2To8: NO_HAND_HOME_CEILING,
      rainSoftShelterRate: RAIN_SHELTER_TARGET,
      gustWallShelterRate: GUST_SHELTER_TARGET,
      crowSwatRate: CROW_SWAT_TARGET,
    },
    p1Physics: physics,
    crossing,
    pass,
    status: p2Pass ? (pass ? 'pass' : 'fail') : options.requireP2 ? 'fail' : 'pending',
  };
  const output = writeReport(options.outputPath, report);
  process.stdout.write(`${JSON.stringify({ ...report, output }, null, 2)}\n`);
  if (!p1Pass || options.requireP2 && !p2Pass || p2Pass && !pass) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

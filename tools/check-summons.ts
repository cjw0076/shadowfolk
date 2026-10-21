import { crossingBench } from './crossing-bench-adapter.js';
import { arcNight } from '../src/play/arc.js';
import { FolkWorld } from '../src/play/folk.js';
import { HazardWorld, type HazardHandPose, type HazardSolution } from '../src/play/hazards.js';
import { InkField } from '../src/play/ink-field.js';
import { applyLevel, type HazardKind, type ScreenLevel } from '../src/play/levels.js';
import { SummonWorld } from '../src/play/summons.js';
import type { SummonKind } from '../src/play/summon-contract.js';
import { SummonTrigger } from '../src/play/summon-trigger.js';
import { basePoses, orient, shape, type HandPose } from '../src/shadow/hand-model.js';
import { FlatHand, projectFromLight, STAGE, type ScreenFrame } from '../src/shadow/silhouette.js';

const DT = 0.05;
const STAGED_WALKERS = 5;
const WALKER_Y = -0.189;
const WALKER_START_X = -0.44;
const WALKER_SPEED = 0.055;
const MAX_STAGE_SECONDS = 30;
const MAX_SCREEN_SECONDS = 50;
const GIFT_THRESHOLD = 4;
const CONTROL_CEILING = 1;
const NIGHT_SEED = 22_031;
const BUILT_IN_GIFTS: readonly SummonKind[] = [
  'peacock', 'rabbit', 'snail', 'dog', 'duck', 'fish', 'elephant', 'heron', 'crab', 'butterfly', 'stag',
];
const GIFT_CASES: readonly { kind: SummonKind; hazard: HazardKind; width: number }[] = [
  { kind: 'peacock', hazard: 'gap', width: 0.16 },
  { kind: 'rabbit', hazard: 'gap', width: 0.14 },
  { kind: 'snail', hazard: 'highLedge', width: 0.18 },
  { kind: 'dog', hazard: 'crow', width: 0.16 },
  { kind: 'duck', hazard: 'river', width: 0.16 },
  { kind: 'fish', hazard: 'river', width: 0.16 },
  { kind: 'elephant', hazard: 'rain', width: 0.20 },
  { kind: 'heron', hazard: 'thorns', width: 0.12 },
  { kind: 'crab', hazard: 'thorns', width: 0.12 },
  { kind: 'butterfly', hazard: 'ledge', width: 0.18 },
  { kind: 'stag', hazard: 'boulder', width: 0.07 },
];
const GIFT_OPTIONS: Record<HazardKind, readonly SummonKind[]> = {
  gap: ['rabbit', 'snail'],
  ledge: ['snail', 'butterfly'],
  highLedge: ['snail', 'butterfly'],
  river: ['duck', 'fish', 'rabbit'],
  crow: ['dog', 'crab'],
  rain: ['elephant'],
  thorns: ['heron', 'crab', 'rabbit'],
  gust: ['peacock', 'stag'],
  boulder: ['stag'],
};
const LEVEL_WIDTH: Record<HazardKind, number> = {
  gap: 0.14,
  ledge: 0.18,
  highLedge: 0.18,
  river: 0.16,
  crow: 0.16,
  rain: 0.20,
  thorns: 0.12,
  gust: 0.12,
  boulder: 0.07,
};
const HAND_SCREEN: ScreenFrame = {
  ox: 0, oy: STAGE.lightDrop, oz: -STAGE.lightToScreen,
  rx: 1, ry: 0, rz: 0,
  ux: 0, uy: 1, uz: 0,
  nx: 0, ny: 0, nz: 1,
};

interface SyntheticHand {
  flat: FlatHand;
  baseX: Float32Array;
  baseY: Float32Array;
  scale: number;
  side: number;
}

interface HandPlacement {
  hand: SyntheticHand;
  x: number;
  y: number;
  resetTracker?: boolean;
}

interface Runtime {
  field: InkField;
  folk: FolkWorld;
  hazards: HazardWorld;
  summons: SummonWorld;
}

interface TriggerCheck {
  name: string;
  pass: boolean;
  observed: Record<string, unknown>;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function makeLevel(kind: HazardKind, width: number, kindlings: number): ScreenLevel {
  return {
    index: 0,
    kindlings,
    hazards: [{ kind, slot: 0, x: -0.17, width }],
  };
}

function makeRuntime(level: ScreenLevel, seed: number): Runtime {
  const field = new InkField();
  applyLevel(field, level);
  const folk = new FolkWorld(field, seed);
  folk.configure({
    doorX: 0.43, doorY: -0.15, doorW: 0.07, doorH: 0.16,
    spawnX: WALKER_START_X, spawnY: WALKER_Y, waveCount: STAGED_WALKERS,
  });
  const hazards = new HazardWorld(field, folk);
  hazards.start(level);
  const summons = new SummonWorld(field, folk, hazards);
  summons.start(level);
  return { field, folk, hazards, summons };
}

function stagedGiftX(kind: SummonKind, hazard: ScreenLevel['hazards'][number]): number {
  const left = hazard.x - hazard.width * 0.5;
  if (kind === 'rabbit') return left - 0.04;
  if (kind === 'snail') return left - (hazard.kind === 'gap' ? 0.01 : 0.08);
  if (kind === 'duck') return left - 0.02;
  if (kind === 'peacock') return hazard.x - 0.15;
  return hazard.x;
}

function walkerApproachSeconds(
  hazard: ScreenLevel['hazards'][number],
  startX = WALKER_START_X,
): number {
  if (hazard.kind === 'boulder') {
    const boulderStartX = 0.5;
    const boulderSpeed = 0.25;
    return Math.max(0, (boulderStartX - startX) / (WALKER_SPEED + boulderSpeed));
  }
  const left = hazard.x - hazard.width * 0.5;
  const contactX = hazard.kind === 'river' ? left + 0.02 : left;
  return Math.max(0, (contactX - startX) / WALKER_SPEED);
}

function snailRouteSeconds(hazard: ScreenLevel['hazards'][number]): number {
  const routeLength = hazard.width + (hazard.kind === 'gap' ? 0.02 : 0.10);
  return routeLength / 0.05;
}

function giftApproachSpawnAt(
  kind: SummonKind,
  hazard: ScreenLevel['hazards'][number],
  startX = WALKER_START_X,
): number {
  const arrival = walkerApproachSeconds(hazard, startX);
  if (kind === 'snail') {
    return Math.max(DT, arrival * 0.6, arrival - snailRouteSeconds(hazard) - 0.35);
  }
  if (kind === 'fish') {
    const patrolSeconds = (hazard.width * 1.5 + 0.045) / 0.10;
    return Math.max(DT, arrival - patrolSeconds - 0.1);
  }
  const lead = kind === 'peacock' ? 2.0 : kind === 'duck' ? 1.0 : 0.75;
  return Math.max(DT, arrival - lead);
}

function copyHazardStats(hazards: HazardWorld): Record<string, number> {
  const stats = hazards.stats;
  return {
    crowSwats: stats.crowSwats,
    crowGrabs: stats.crowGrabs,
    riverDouses: stats.riverDouses,
    rainDropsSpawned: stats.rainDropsSpawned,
    rainDropsSheltered: stats.rainDropsSheltered,
    rainDropsHit: stats.rainDropsHit,
    gustShelteredAgentSeconds: round(stats.gustShelteredAgentSeconds),
    gustExposedAgentSeconds: round(stats.gustExposedAgentSeconds),
    thornTurns: stats.thornTurns,
    boulderHits: stats.boulderHits,
    bouldersBlocked: stats.bouldersBlocked,
    bouldersCrumbled: stats.bouldersCrumbled,
  };
}

function thornTerrainProbe(field: InkField, hazard: ScreenLevel['hazards'][number]): Record<string, unknown> {
  const left = hazard.x - hazard.width * 0.5;
  const right = hazard.x + hazard.width * 0.5;
  const footY = WALKER_Y - 0.014;
  const bodySamples = [left - 0.005, left + 0.005, hazard.x, right - 0.005, right + 0.005]
    .map((x) => {
      const index = field.index(x, WALKER_Y);
      return {
        x: round(x),
        solid: field.sample(x, WALKER_Y),
        staticSolid: index < 0 ? 0 : field.staticSolid[index],
      };
    });
  return {
    bounds: { left: round(left), right: round(right) },
    floorSupportAtCenter: field.sample(hazard.x, footY),
    thornAtWalkerBody: field.sample(hazard.x, WALKER_Y),
    floorSupportBeforeHazard: field.sample(left - 0.02, footY),
    walkerBodyAcrossThorns: bodySamples,
  };
}

function activeSummonCellCount(field: InkField): number {
  let count = 0;
  for (const until of field.summonUntil) if (until > field.summonTime) count++;
  return count;
}

function runStagedGift(
  giftKind: SummonKind | null,
  stagedCase: (typeof GIFT_CASES)[number],
  seed: number,
): Record<string, unknown> {
  const level = makeLevel(stagedCase.hazard, stagedCase.width, STAGED_WALKERS);
  const { field, folk, hazards, summons } = makeRuntime(level, seed);
  const hazard = level.hazards[0];
  const left = hazard.x - hazard.width * 0.5;
  const checkpointX = hazard.x + hazard.width * 0.5 + 0.05;
  const heldForSnailRamp = stagedCase.kind === 'snail';
  const walkerReleaseDelaySeconds = heldForSnailRamp ? round(snailRouteSeconds(hazard) + 3 * DT, 2) : 0;
  if (heldForSnailRamp) folk.configure({ waveCount: 0 });
  const giftSpawnAtSeconds = stagedCase.kind === 'snail' ? 0 : giftApproachSpawnAt(stagedCase.kind, hazard);
  let spawned = false;
  let spawnAttempted = false;
  let actualGiftSpawnAtSeconds: number | null = null;
  let walkersReleased = !heldForSnailRamp;
  const thornTerrainBefore = hazard.kind === 'thorns' ? thornTerrainProbe(field, hazard) : null;
  let thornTerrainAfterUse: Record<string, unknown> | null = null;
  let snailRampProbe: Record<string, unknown> | null = null;
  const previousHeadings = new Int8Array(STAGED_WALKERS);
  const headingChanges: Array<Record<string, number>> = [];
  const crossed = new Uint8Array(STAGED_WALKERS);
  let frames = 0;
  const frameLimit = Math.ceil(MAX_STAGE_SECONDS / DT);
  for (; frames < frameLimit; frames++) {
    const elapsed = frames * DT;
    if (!walkersReleased && elapsed >= walkerReleaseDelaySeconds) {
      folk.configure({ waveCount: STAGED_WALKERS });
      walkersReleased = true;
    }
    if (giftKind !== null && !spawnAttempted && elapsed >= giftSpawnAtSeconds) {
      spawnAttempted = true;
      actualGiftSpawnAtSeconds = elapsed;
      spawned = summons.spawn(giftKind, stagedGiftX(giftKind, hazard));
    }
    field.beginFrame();
    summons.update(DT);
    const currentUses = summons.agents.reduce((sum, agent) => sum + agent.uses, 0);
    if (hazard.kind === 'thorns' && currentUses > 0 && thornTerrainAfterUse === null) {
      thornTerrainAfterUse = thornTerrainProbe(field, hazard);
    }
    if (stagedCase.kind === 'snail' && currentUses > 0 && snailRampProbe === null) {
      const routeStartX = left - 0.08;
      const routeEndX = hazard.x + hazard.width * 0.5 + 0.02;
      const samples = [0.1, 0.5, 0.9].map((fraction) => {
        const x = routeStartX + (routeEndX - routeStartX) * fraction;
        const y = -0.20 + 0.16 * fraction;
        return { fraction, x: round(x), y: round(y), solid: field.sample(x, y) };
      });
      snailRampProbe = { activeSummonCells: activeSummonCellCount(field), samples };
    }
    hazards.update(DT);
    folk.update(DT);
    for (let index = 0; index < folk.count; index++) {
      const walker = folk.agents[index];
      if (previousHeadings[index] !== 0 && previousHeadings[index] !== walker.heading && headingChanges.length < 12) {
        headingChanges.push({
          walker: index,
          atSeconds: round((frames + 1) * DT, 2),
          x: round(walker.x),
          y: round(walker.y),
          from: previousHeadings[index],
          to: walker.heading,
          obstacleAhead: field.sample(walker.x + walker.heading * 0.014, walker.y - 0.002),
          obstacleInOldForwardDirection: field.sample(walker.x - walker.heading * 0.014, walker.y - 0.002),
        });
      }
      previousHeadings[index] = walker.heading;
      if (walker.state === 'home' || walker.x >= checkpointX) crossed[index] = 1;
    }
    if (crossed.reduce((sum, value) => sum + value, 0) === STAGED_WALKERS) {
      frames++;
      break;
    }
  }
  const crossedCount = crossed.reduce((sum, value) => sum + value, 0);
  const uses = summons.agents.reduce((sum, agent) => sum + agent.uses, 0);
  const result = {
    gift: giftKind,
    scheduledGiftKind: stagedCase.kind,
    spawned,
    giftSpawnAtSeconds,
    actualGiftSpawnAtSeconds: actualGiftSpawnAtSeconds === null ? null : round(actualGiftSpawnAtSeconds, 2),
    walkerReleaseDelaySeconds,
    snailRampHold: heldForSnailRamp ? 'same fixed hold for gift and control; walkers wait upstream while the snail lays its route' : null,
    crossed: crossedCount,
    total: STAGED_WALKERS,
    rate: crossedCount / STAGED_WALKERS,
    home: folk.homeCount,
    ash: folk.ashCount,
    unresolved: STAGED_WALKERS - folk.homeCount - folk.ashCount,
    summonUses: uses,
    terminalWalkers: folk.agents.slice(0, folk.count).map((walker) => ({
      state: walker.state,
      x: round(walker.x),
      y: round(walker.y),
      heading: walker.heading,
    })),
    headingChanges,
    thornTerrain: thornTerrainBefore === null ? null : {
      beforeDisable: thornTerrainBefore,
      afterDisable: thornTerrainAfterUse,
    },
    snailRamp: snailRampProbe,
    seconds: round(frames * DT, 2),
    checkpointX: round(checkpointX),
    hazardStats: copyHazardStats(hazards),
  };
  hazards.dispose();
  summons.dispose();
  return result;
}

function firstCrowSwoopAtSeconds(level: ScreenLevel, seed: number, walkerX: number): number {
  const { field, folk, hazards, summons } = makeRuntime(level, seed);
  folk.configure({ waveCount: 0 });
  const walker = folk.spawn(walkerX, WALKER_Y);
  if (walker) walker.heading = 0;
  const pose = new Float32Array(2);
  let firstSwoopAtSeconds = MAX_STAGE_SECONDS;
  for (let frame = 0; frame < Math.ceil(MAX_STAGE_SECONDS / DT); frame++) {
    field.beginFrame();
    summons.update(DT);
    hazards.update(DT);
    if (hazards.crowPose(0, pose)) {
      firstSwoopAtSeconds = (frame + 1) * DT;
      break;
    }
    folk.update(DT);
  }
  hazards.dispose();
  summons.dispose();
  return firstSwoopAtSeconds;
}

function runDogTrials(giftKind: 'dog' | null, seed: number): Record<string, unknown> {
  const trials: Array<Record<string, unknown>> = [];
  for (let index = 0; index < STAGED_WALKERS; index++) {
    const trialSeed = seed + index;
    const level = makeLevel('crow', 0.16, index + 1);
    level.index = index % 3;
    const { field, folk, hazards, summons } = makeRuntime(level, trialSeed);
    folk.configure({ waveCount: 0 });
    const hazard = level.hazards[0];
    const checkpointX = hazard.x + hazard.width * 0.5 + 0.05;
    const walkerStartX = hazard.x - 0.04;
    const crowSwoopAtSeconds = firstCrowSwoopAtSeconds(level, trialSeed, walkerStartX);
    const dogSpawnAtSeconds = Math.max(DT, crowSwoopAtSeconds - 2 * DT);
    const walkerReleaseAtSeconds = crowSwoopAtSeconds + 1.05;
    const walker = folk.spawn(walkerStartX, WALKER_Y);
    if (walker) walker.heading = 0;
    let spawned = false;
    let actualGiftSpawnAtSeconds: number | null = null;
    let walkerReleased = false;
    let reachedCheckpoint = false;
    let checkpointAtSeconds: number | null = null;
    let frames = 0;
    for (; frames < Math.ceil(MAX_STAGE_SECONDS / DT); frames++) {
      const elapsed = frames * DT;
      if (!walkerReleased && elapsed >= walkerReleaseAtSeconds) {
        for (let agentIndex = 0; agentIndex < folk.count; agentIndex++) folk.agents[agentIndex].heading = 1;
        walkerReleased = true;
      }
      if (giftKind !== null && !spawned && elapsed >= dogSpawnAtSeconds) {
        spawned = summons.spawn('dog', stagedGiftX('dog', hazard));
        actualGiftSpawnAtSeconds = elapsed;
      }
      field.beginFrame();
      summons.update(DT);
      hazards.update(DT);
      folk.update(DT);
      const walker = folk.agents[0];
      if (walker.state === 'home' || walker.x >= checkpointX) {
        reachedCheckpoint = true;
        checkpointAtSeconds = round((frames + 1) * DT, 2);
        frames++;
        break;
      }
    }
    const hazardStats = copyHazardStats(hazards);
    trials.push({
      index,
      seed: trialSeed,
      hazardIndex: level.index,
      walkersPerTrial: 1,
      hazardSeedKindlings: level.kindlings,
      calibratedFirstCrowSwoopAtSeconds: round(crowSwoopAtSeconds, 2),
      spawned: giftKind === null ? false : spawned,
      giftSpawnAtSeconds: dogSpawnAtSeconds,
      actualGiftSpawnAtSeconds: actualGiftSpawnAtSeconds === null ? null : round(actualGiftSpawnAtSeconds, 2),
      walkerStartX: round(hazard.x - 0.04),
      walkerReleaseAtSeconds,
      reachedCheckpoint,
      checkpointAtSeconds,
      crowGrabs: hazardStats.crowGrabs,
      reachedWithoutCrowGrab: reachedCheckpoint && hazardStats.crowGrabs === 0,
      hazardStats,
    });
    hazards.dispose();
    summons.dispose();
  }
  const actualCheckpointArrivals = trials.filter((trial) => trial.reachedCheckpoint).length;
  const safeNoGrabArrivals = trials.filter((trial) => trial.reachedWithoutCrowGrab).length;
  return {
    gift: giftKind,
    scheduledGiftKind: 'dog',
    spawned: giftKind === null ? false : trials.every((trial) => trial.spawned),
    crossed: actualCheckpointArrivals,
    safeNoGrabArrivals,
    gateCrossings: safeNoGrabArrivals,
    total: STAGED_WALKERS,
    rate: safeNoGrabArrivals / STAGED_WALKERS,
    metric: 'checkpoint reached before any crow grab, across five paired one-walker trials; later arrivals after a grab are reported but do not count',
    trialMethod: 'Each walker is held at a grounded stopline 0.04m before the crow. A same-seed calibration run observes the first natural crow swoop; the dog is staged 0.1s before it, and both arms release 1.05s after the calibrated swoop begins. Paired arms use the same hazard index/seed and release time.',
    trials,
  };
}

function makeProjectedHand(pose: HandPose, scale: number, side: number): SyntheticHand {
  let centreX = 0;
  let centreY = 0;
  for (let joint = 0; joint < pose.radii.length; joint++) {
    centreX += pose.mats[joint * 16 + 12];
    centreY += pose.mats[joint * 16 + 13];
  }
  centreX /= pose.radii.length;
  centreY /= pose.radii.length;
  const opticalScale = 2.5 * scale;
  const lightToHand = STAGE.lightToScreen / opticalScale;
  const joints = new Float32Array(pose.radii.length * 3);
  for (let joint = 0; joint < pose.radii.length; joint++) {
    joints[joint * 3] = pose.mats[joint * 16 + 12] - centreX;
    joints[joint * 3 + 1] = pose.mats[joint * 16 + 13] - centreY + STAGE.lightDrop / opticalScale;
    joints[joint * 3 + 2] = -lightToHand;
  }
  const flat = new FlatHand();
  projectFromLight(joints, pose.radii, 0, 0, 0, HAND_SCREEN, flat);
  return { flat, baseX: flat.x.slice(), baseY: flat.y.slice(), scale, side };
}

function flatBridgePose(): HandPose {
  const pose = basePoses.relaxed();
  shape(pose, { thumb: -0.12, index: -0.18, middle: -0.18, ring: -0.18, pinky: -0.15 });
  return orient(pose, [0, 0, -90]);
}

function gapBridgePose(): HandPose {
  return orient(basePoses.relaxed(), [-25, 0, 0]);
}

function palmWallPose(angle: number): HandPose {
  const pose = orient(basePoses.relaxed(), [0, 0, angle * 180 / Math.PI]);
  let centreX = 0;
  for (let joint = 0; joint < pose.radii.length; joint++) centreX += pose.mats[joint * 16 + 12];
  centreX /= pose.radii.length;
  for (let joint = 0; joint < pose.radii.length; joint++) {
    const offset = joint * 16 + 12;
    pose.mats[offset] = centreX + (pose.mats[offset] - centreX) * 0.15;
  }
  return pose;
}

function poseForSolution(solution: HazardSolution, hand: HazardHandPose): HandPose {
  if (solution.action === 'palm-wall') return palmWallPose(hand.angle);
  if (solution.action === 'bridge' && solution.kind === 'gap') return gapBridgePose();
  if (solution.action === 'swat') return orient(basePoses.relaxed(), [0, 0, hand.angle * 180 / Math.PI]);
  let pose = flatBridgePose();
  if (solution.action === 'ramp' && hand.angle !== 0) {
    pose = orient(pose, [0, 0, hand.angle * 180 / Math.PI]);
  }
  return pose;
}

function placeHand(hand: SyntheticHand, x: number, y: number): void {
  for (let joint = 0; joint < hand.baseX.length; joint++) {
    hand.flat.x[joint] = hand.baseX[joint] + x;
    hand.flat.y[joint] = hand.baseY[joint] + y;
  }
}

function cachedHand(
  cache: Map<string, SyntheticHand>,
  key: string,
  pose: HandPose,
  scale: number,
  side: number,
): SyntheticHand {
  let hand = cache.get(key);
  if (!hand) {
    hand = makeProjectedHand(pose, scale, side);
    cache.set(key, hand);
  }
  return hand;
}

function placementsForSolutions(
  solutions: readonly HazardSolution[],
  cache: Map<string, SyntheticHand>,
  include: (solution: HazardSolution, hand: HazardHandPose) => boolean = () => true,
): HandPlacement[] {
  const placements: HandPlacement[] = [];
  for (const solution of solutions) {
    if (solution.slot !== 0) continue;
    for (let index = 0; index < solution.hands.length; index++) {
      const descriptor = solution.hands[index];
      if (!include(solution, descriptor)) continue;
      const key = `${solution.slot}:${solution.kind}:${solution.action}:${index}:${descriptor.angle}:${descriptor.scale}:${descriptor.soft}`;
      const hand = cachedHand(cache, key, poseForSolution(solution, descriptor), descriptor.scale, solution.slot);
      const y = solution.action === 'bridge' ? descriptor.y - 0.039 : descriptor.y;
      placements.push({ hand, x: descriptor.x, y });
    }
  }
  return placements;
}

function addHands(field: InkField, placements: readonly HandPlacement[]): void {
  for (const placement of placements) {
    placeHand(placement.hand, placement.x, placement.y);
    if (placement.resetTracker !== false) field.clearHand(placement.hand.side);
    field.addHand(placement.hand.flat, placement.hand.scale, DT, placement.hand.side);
  }
}

function rightmostActiveAgentNear(folk: FolkWorld, left: number, right: number): number | null {
  let rightmost = -Infinity;
  for (let index = 0; index < folk.count; index++) {
    const agent = folk.agents[index];
    if ((agent.state === 'walking' || agent.state === 'falling') && agent.x >= left && agent.x <= right) {
      rightmost = Math.max(rightmost, agent.x);
    }
  }
  return Number.isFinite(rightmost) ? rightmost : null;
}

function hasActiveAgentPast(folk: FolkWorld, x: number): boolean {
  for (let index = 0; index < folk.count; index++) {
    const agent = folk.agents[index];
    if ((agent.state === 'walking' || agent.state === 'falling') && agent.x > x) return true;
  }
  return false;
}

function crowIsSwooping(
  previousPositions: Map<number, { x: number; y: number }>,
  solution: HazardSolution,
  hand: HazardHandPose,
  floorY: number,
): boolean {
  const previous = previousPositions.get(solution.slot);
  previousPositions.set(solution.slot, { x: hand.x, y: hand.y });
  return hand.y < floorY + 0.12
    && previous !== undefined
    && Math.hypot(hand.x - previous.x, hand.y - previous.y) > 0.0005;
}

interface FlickRun {
  agentIndex: number;
  startedAt: number;
}

function flickPlacements(
  field: InkField,
  folk: FolkWorld,
  hazards: HazardWorld,
  cache: Map<string, SyntheticHand>,
  flicks: (FlickRun | undefined)[],
  lastFlickAt: Map<string, number>,
  elapsed: number,
): HandPlacement[] {
  const placements: HandPlacement[] = [];
  for (const hazard of hazards.layouts) {
    if (hazard.slot !== 0 || hazard.kind !== 'ledge' && hazard.kind !== 'highLedge' && hazard.kind !== 'thorns') continue;
    const highLedge = hazard.kind === 'highLedge';
    const sweepDuration = highLedge ? 0.16 : 0.08;
    const slot = hazard.slot;
    let flick = flicks[slot];
    const flickDuration = highLedge ? 0.36 : 0.28;
    if (flick && elapsed - flick.startedAt >= flickDuration) {
      field.clearHand(slot);
      flicks[slot] = flick = undefined;
    }
    if (!flick) {
      const left = hazard.x - hazard.width * 0.5;
      let candidate = -1;
      let candidateDistance = Infinity;
      for (let agentIndex = 0; agentIndex < folk.count; agentIndex++) {
        const agent = folk.agents[agentIndex];
        const key = `${slot}:${agentIndex}`;
        if (agent.state !== 'walking' || agent.heading <= 0) continue;
        if (agent.x < left - 0.10 || agent.x > left + 0.02 || lastFlickAt.has(key)) continue;
        candidate = agentIndex;
        break;
      }
      if (candidate >= 0) {
        field.clearHand(slot);
        flick = flicks[slot] = { agentIndex: candidate, startedAt: elapsed };
        lastFlickAt.set(`${slot}:${candidate}`, elapsed);
      }
    }
    if (!flick) continue;
    const age = elapsed - flick.startedAt;
    const progress = Math.max(0, Math.min(1, age / sweepDuration));
    const hand = cachedHand(cache, `${slot}:${hazard.kind}:near-flame-flick`, gapBridgePose(), 2.5, slot);
    placements.push({
      hand,
      x: hazard.x - hazard.width * 0.5 - 0.08 + (highLedge ? 0.14 : 0.10) * progress,
      y: -0.20 + (highLedge ? 0.16 : 0.12) * progress,
      resetTracker: false,
    });
  }
  return placements;
}

function placementsForLevel(
  field: InkField,
  folk: FolkWorld,
  hazards: HazardWorld,
  cache: Map<string, SyntheticHand>,
  flicks: (FlickRun | undefined)[],
  lastFlickAt: Map<string, number>,
  previousCrowPositions: Map<number, { x: number; y: number }>,
  previousBoulderPositions: Map<number, number>,
  elapsed: number,
): HandPlacement[] {
  const placements = flickPlacements(field, folk, hazards, cache, flicks, lastFlickAt, elapsed);
  const solution = hazards.solve().find((candidate) => candidate.slot === 0);
  if (!solution) return placements;
  const layout = hazards.layouts.find((candidate) => candidate.slot === 0);
  if (!layout) return placements;
  if (layout.kind === 'ledge' || layout.kind === 'thorns' || layout.kind === 'highLedge') return placements;
  if (layout.kind === 'gap' || layout.kind === 'river') {
    const hand = cachedHand(cache, `${layout.slot}:${layout.kind}:bridge`, gapBridgePose(), 1, layout.slot);
    placements.push({ hand, x: layout.x, y: -0.23 });
    return placements;
  }
  if (layout.kind === 'crow') {
    placements.push(...placementsForSolutions(
      [solution], cache,
      (entry, hand) => crowIsSwooping(previousCrowPositions, entry, hand, layout.floorY),
    ));
    return placements;
  }
  if (layout.kind === 'gust') {
    const phase = elapsed % 5;
    const left = layout.x - layout.width * 0.5;
    const right = layout.x + layout.width * 0.5;
    const rightmost = rightmostActiveAgentNear(folk, left - 0.03, right + 0.03);
    const walkerBeyondBand = hasActiveAgentPast(folk, right + 0.03);
    if (phase < 2 && rightmost !== null && !walkerBeyondBand) {
      for (const placement of placementsForSolutions([solution], cache)) {
        placement.x = layout.x + 0.18;
        placement.y = -0.105;
        placements.push(placement);
      }
    }
    return placements;
  }
  if (layout.kind === 'boulder') {
    const boulderX = solution.hands[0]?.x;
    if (boulderX === undefined) return placements;
    const previousX = previousBoulderPositions.get(layout.slot);
    const active = Math.abs(boulderX - layout.x) > 0.000001
      || (previousX !== undefined && previousX > layout.x);
    previousBoulderPositions.set(layout.slot, boulderX);
    if (active) {
      const intercept = Math.min(0.40, boulderX - 0.10);
      for (const placement of placementsForSolutions([solution], cache)) {
        placement.x = intercept;
        placement.y = -0.16;
        placements.push(placement);
      }
    }
    return placements;
  }
  placements.push(...placementsForSolutions([solution], cache));
  return placements;
}

function chooseNightGift(kind: HazardKind, unlocked: ReadonlySet<SummonKind>): SummonKind | null {
  return GIFT_OPTIONS[kind].find((candidate) => unlocked.has(candidate)) ?? null;
}

function unlockedGifts(night: number, seed: number): Set<SummonKind> {
  const unlocked = new Set<SummonKind>();
  for (let currentNight = 1; currentNight <= night; currentNight++) {
    for (const gift of arcNight(currentNight, seed).wakes) {
      if (BUILT_IN_GIFTS.includes(gift as SummonKind)) unlocked.add(gift as SummonKind);
    }
  }
  return unlocked;
}

interface NightSummary {
  total: number;
  home: number;
  ash: number;
  lost: number;
  homeRate: number;
  screens: Array<Record<string, unknown>>;
}

function runConstrainedNight(
  night: number,
  seed: number,
  levels: readonly ScreenLevel[],
  includeSummons: boolean,
): NightSummary {
  const field = new InkField();
  const folk = new FolkWorld(field, seed);
  const hazards = new HazardWorld(field, folk);
  const summons = new SummonWorld(field, folk, hazards);
  const unlocked = unlockedGifts(night, seed);
  const screens: NightSummary['screens'] = [];
  let total = 0;
  let home = 0;
  let ash = 0;
  let lost = 0;

  for (const level of levels) {
    applyLevel(field, level);
    folk.reset();
    folk.configure({ waveCount: level.kindlings });
    hazards.start(level);
    summons.start(level);
    field.clearHand(0);
    const handCache = new Map<string, SyntheticHand>();
    const flicks: (FlickRun | undefined)[] = [undefined, undefined];
    const lastFlickAt = new Map<string, number>();
    const previousCrowPositions = new Map<number, { x: number; y: number }>();
    const previousBoulderPositions = new Map<number, number>();
    const giftSchedule: Array<{
      kind: SummonKind;
      hazard: HazardKind;
      slot: number;
      positionX: number;
      spawnAtSeconds: number;
      attempted: boolean;
      accepted: boolean | null;
      attemptedAtSeconds: number | null;
    }> = [];
    if (includeSummons) {
      for (const hazard of level.hazards) {
        if (giftSchedule.length >= 2) break;
        const gift = chooseNightGift(hazard.kind, unlocked);
        if (!gift || giftSchedule.some((scheduled) => scheduled.kind === gift)) continue;
        giftSchedule.push({
          kind: gift,
          hazard: hazard.kind,
          slot: hazard.slot,
          positionX: stagedGiftX(gift, hazard),
          spawnAtSeconds: giftApproachSpawnAt(gift, hazard),
          attempted: false,
          accepted: null,
          attemptedAtSeconds: null,
        });
      }
    }

    let elapsed = 0;
    const frameLimit = Math.ceil(MAX_SCREEN_SECONDS / DT);
    for (let frame = 0; frame < frameLimit; frame++) {
      for (const scheduled of giftSchedule) {
        if (scheduled.attempted || elapsed < scheduled.spawnAtSeconds) continue;
        scheduled.attempted = true;
        scheduled.attemptedAtSeconds = round(elapsed, 2);
        scheduled.accepted = summons.spawn(scheduled.kind, scheduled.positionX);
      }
      field.beginFrame();
      summons.update(DT);
      addHands(field, placementsForLevel(
        field, folk, hazards, handCache, flicks, lastFlickAt,
        previousCrowPositions, previousBoulderPositions, elapsed,
      ));
      hazards.update(DT);
      folk.update(DT);
      elapsed += DT;
      if (folk.count >= level.kindlings && folk.homeCount + folk.ashCount >= level.kindlings) break;
    }

    const screenHome = folk.homeCount;
    const screenAsh = folk.ashCount;
    const screenLost = Math.max(0, level.kindlings - screenHome - screenAsh);
    screens.push({
      index: level.index,
      hazards: level.hazards.map((hazard) => hazard.kind),
      giftSchedule,
      total: level.kindlings,
      home: screenHome,
      ash: screenAsh,
      lost: screenLost,
      homeRate: level.kindlings > 0 ? screenHome / level.kindlings : 0,
      seconds: round(elapsed, 2),
      handConstraint: 'one synthetic solver hand, slot 0 only; same adapter action and flick rules in both modes, with no attention to slot 1',
      hazardStats: copyHazardStats(hazards),
    });
    total += level.kindlings;
    home += screenHome;
    ash += screenAsh;
    lost += screenLost;
  }

  hazards.dispose();
  summons.dispose();
  return { total, home, ash, lost, homeRate: total > 0 ? home / total : 0, screens };
}

function triggerChecks(): { checks: TriggerCheck[]; pass: boolean } {
  const stableMatch = (form: number): { form: number; score: number; stable: boolean } => ({ form, score: 1, stable: true });
  const invalidMatch = { form: -1, score: 0, stable: false };
  const underThreshold = new SummonTrigger();
  underThreshold.update(0, stableMatch(2), true);
  const firedEarly = underThreshold.update(0.799, stableMatch(2), true);
  const hold = new SummonTrigger();
  hold.update(0, stableMatch(2), true);
  const firedAtThreshold = hold.update(0.8, stableMatch(2), true);
  let heldRepeat = false;
  for (let frame = 0; frame < 12; frame++) heldRepeat = hold.update(0.1, stableMatch(2), true) || heldRepeat;
  hold.update(0.01, invalidMatch, true);
  hold.update(0, stableMatch(2), true);
  const rearmedAtThreshold = hold.update(0.8, stableMatch(2), true);

  const reset = new SummonTrigger();
  reset.update(0, stableMatch(1), true);
  const partialTriggeredBeforeReset = reset.update(0.4, stableMatch(1), true);
  reset.reset();
  const progressImmediatelyAfterReset = reset.progress;
  reset.update(0, stableMatch(1), true);
  const resetFiredAtThreshold = reset.update(0.8, stableMatch(1), true);

  const formChange = new SummonTrigger();
  formChange.update(0, stableMatch(1), true);
  formChange.update(0.4, stableMatch(1), true);
  formChange.update(0, stableMatch(2), true);
  const progressAfterFormChange = formChange.progress;

  const level: ScreenLevel = { index: 0, kindlings: 0, hazards: [] };
  const field = new InkField();
  const folk = new FolkWorld(field, 17);
  const hazards = new HazardWorld(field, folk);
  hazards.start(level);
  const summons = new SummonWorld(field, folk, hazards);
  summons.start(level);
  const first = summons.spawn('dog', -0.2);
  const second = summons.spawn('rabbit', 0);
  const thirdRejected = !summons.spawn('stag', 0.2);
  const duplicateRejected = !summons.spawn('dog', -0.2);
  const cappedActiveCount = summons.activeCount();
  for (let frame = 0; frame < 161; frame++) summons.update(DT);
  const firstAgentAgeAfterEightSeconds = summons.agents[0].age;
  const exitPhaseReached = firstAgentAgeAfterEightSeconds >= 8;
  for (let frame = 0; frame < 17; frame++) summons.update(DT);
  const activeCountAfterExit = summons.activeCount();
  const slotsFreedAfterExit = activeCountAfterExit === 0;
  const cooldownStillBlocksDog = !summons.spawn('dog', -0.2);
  const otherKindUsesFreedSlot = summons.spawn('stag', 0.2);
  while (summons.time < 12.05) summons.update(DT);
  const cooldownExpiredAtTwelveSeconds = summons.cooldownRemaining('dog') === 0;
  const cooldownRemainingAtExpiry = summons.cooldownRemaining('dog');
  const dogAcceptedAfterCooldown = summons.spawn('dog', -0.2);
  const checks = [
    { name: 'stable hold fires at 0.8s, not earlier', pass: firedAtThreshold && !firedEarly, observed: { holdSeconds: hold.holdSeconds, firedEarly, firedAtThreshold } },
    { name: 'held match does not repeat until released', pass: !heldRepeat, observed: { heldRepeat } },
    { name: 'release re-arms a fresh 0.8s hold', pass: rearmedAtThreshold, observed: { rearmedAtThreshold } },
    { name: 'reset clears partial trigger progress and starts a fresh 0.8s hold', pass: !partialTriggeredBeforeReset && progressImmediatelyAfterReset === 0 && resetFiredAtThreshold, observed: { partialTriggeredBeforeReset, progressImmediatelyAfterReset, resetFiredAtThreshold } },
    { name: 'changing matched form clears partial hold', pass: progressAfterFormChange === 0, observed: { progressAfterFormChange } },
    { name: 'summon cap is two active agents', pass: first && second && thirdRejected && cappedActiveCount === 2, observed: { first, second, thirdRejected, activeCount: cappedActiveCount } },
    { name: 'same-kind summon cooldown blocks repeat', pass: duplicateRejected && cooldownStillBlocksDog, observed: { duplicateRejected, cooldownStillBlocksDog } },
    { name: 'eight-second active lifetime enters exit phase', pass: exitPhaseReached, observed: { ageSeconds: round(firstAgentAgeAfterEightSeconds, 3) } },
    { name: 'exit clears both slots after 8.8 seconds', pass: slotsFreedAfterExit, observed: { activeCount: activeCountAfterExit, timeSeconds: round(8.9, 2) } },
    { name: 'different kind uses a freed slot during cooldown', pass: otherKindUsesFreedSlot, observed: { otherKindUsesFreedSlot } },
    { name: 'same-kind cooldown expires at 12 seconds', pass: cooldownExpiredAtTwelveSeconds && dogAcceptedAfterCooldown, observed: { cooldownRemaining: cooldownRemainingAtExpiry, dogAcceptedAfterCooldown, timeSeconds: round(summons.time, 2) } },
  ];
  hazards.dispose();
  summons.dispose();
  return { checks, pass: checks.every((check) => check.pass) };
}

function main(): void {
  const trigger = triggerChecks();
  const gifts = GIFT_CASES.map((gift, index) => {
    const seed = 31_100 + index;
    const dogCase = gift.kind === 'dog';
    const withGift = dogCase ? runDogTrials('dog', seed) : runStagedGift(gift.kind, gift, seed);
    const control = dogCase ? runDogTrials(null, seed) : runStagedGift(null, gift, seed);
    const giftCrossings = (withGift.gateCrossings ?? withGift.crossed) as number;
    const controlCrossings = (control.gateCrossings ?? control.crossed) as number;
    const pass = withGift.spawned === true
      && giftCrossings >= GIFT_THRESHOLD
      && controlCrossings <= CONTROL_CEILING;
    return {
      kind: gift.kind,
      stagedHazard: gift.hazard,
      width: gift.width,
      seed,
      gate: {
        metric: dogCase ? 'safe no-grab checkpoint arrivals' : 'checkpoint crossings',
        giftAtLeast: GIFT_THRESHOLD,
        controlAtMost: CONTROL_CEILING,
        pass,
      },
      withGift,
      control,
    };
  });

  const nights = [];
  for (let night = 1; night <= 8; night++) {
    const seed = NIGHT_SEED + night;
    const levels = crossingBench.generateLevel(night, seed) as ScreenLevel[];
    const adapterReference = crossingBench.runLevel(levels, { night, seed, hands: 'solver' });
    const singleHand = runConstrainedNight(night, seed, levels, false);
    const singleHandPlusSummons = runConstrainedNight(night, seed, levels, true);
    const perScreenDelta = singleHand.screens.map((screen, index) => {
      const withSummons = singleHandPlusSummons.screens[index];
      const screenTotal = screen.total as number;
      const handHome = screen.home as number;
      const handAndSummonsHome = withSummons.home as number;
      return {
        index: screen.index,
        hazards: screen.hazards,
        total: screenTotal,
        singleHandHome: handHome,
        singleHandPlusSummonsHome: handAndSummonsHome,
        homeCountDelta: handAndSummonsHome - handHome,
        homeRateDelta: screenTotal > 0 ? round((handAndSummonsHome - handHome) / screenTotal) : 0,
      };
    });
    nights.push({
      night,
      seed,
      screens: levels.map((level) => ({
        index: level.index,
        hazards: level.hazards.map((hazard) => hazard.kind),
        kindlings: level.kindlings,
      })),
      constraint: 'same one synthetic solver hand in both modes; slot 0 only; adapter action/flick repositioning allowed there; gifts unlocked through this night and capped by SummonWorld',
      singleHand,
      singleHandPlusSummons,
      homeRateDelta: round(singleHandPlusSummons.homeRate - singleHand.homeRate),
      perScreenDelta,
      unrestrictedAdapterReference: {
        source: 'tools/crossing-bench-adapter.ts crossingBench.runLevel(hands: solver)',
        home: adapterReference.home,
        total: adapterReference.total,
        homeRate: adapterReference.homeRate,
        ash: adapterReference.ash,
        lost: adapterReference.lost,
      },
    });
  }

  const aggregateTotal = nights.reduce((sum, night) => sum + (night.singleHand as NightSummary).total, 0);
  const aggregateSingleHandHome = nights.reduce((sum, night) => sum + (night.singleHand as NightSummary).home, 0);
  const aggregateHandAndSummonsHome = nights.reduce((sum, night) => sum + (night.singleHandPlusSummons as NightSummary).home, 0);

  const giftPass = gifts.every((gift) => gift.gate.pass);
  const pass = trigger.pass && giftPass;
  const report = {
    benchmark: 'codex-22-summons-p3',
    node: process.version,
    deterministic: true,
    scope: 'Node headless simulation using InkField, FolkWorld, HazardWorld and SummonWorld. Staged gift cases use five walkers; dog uses five paired one-walker trials and counts checkpoint arrivals only if no crow grab occurred. Gifts launch near estimated walker approach; snail gift/control pairs share a fixed wave-release hold while its ramp is laid.',
    thresholds: { giftCrossingsAtLeast: GIFT_THRESHOLD, controlCrossingsAtMost: CONTROL_CEILING },
    triggerAndLifecycle: trigger,
    gifts,
    difficultyAcrossNights: {
      reference: 'crossing-bench-adapter full solver; incremental comparison uses one constrained synthetic hand to avoid its two-hand ceiling.',
      handModel: 'The one-hand placements follow crossing-bench-adapter synthetic projection, action scheduling and flick rules; the hand addresses slot 0 only, leaving slot 1 for gifts.',
      aggregateDelta: {
        total: aggregateTotal,
        singleHandHome: aggregateSingleHandHome,
        singleHandPlusSummonsHome: aggregateHandAndSummonsHome,
        homeCountDelta: aggregateHandAndSummonsHome - aggregateSingleHandHome,
        singleHandHomeRate: aggregateTotal > 0 ? round(aggregateSingleHandHome / aggregateTotal) : 0,
        singleHandPlusSummonsHomeRate: aggregateTotal > 0 ? round(aggregateHandAndSummonsHome / aggregateTotal) : 0,
        homeRateDelta: aggregateTotal > 0 ? round((aggregateHandAndSummonsHome - aggregateSingleHandHome) / aggregateTotal) : 0,
      },
      nights,
    },
    pass,
    failures: [
      ...gifts.filter((gift) => !gift.gate.pass).map((gift) => ({
        area: 'gift-threshold',
        gift: gift.kind,
        hazard: gift.stagedHazard,
        giftCrossed: gift.withGift.gateCrossings ?? gift.withGift.crossed,
        controlCrossed: gift.control.gateCrossings ?? gift.control.crossed,
        required: { giftAtLeast: GIFT_THRESHOLD, controlAtMost: CONTROL_CEILING },
      })),
      ...trigger.checks.filter((check) => !check.pass).map((check) => ({ area: 'trigger-lifecycle', check: check.name, observed: check.observed })),
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!pass) process.exitCode = 1;
}

main();

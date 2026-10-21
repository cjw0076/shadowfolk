import { InkField } from '../src/play/ink-field.js';
import { FolkWorld } from '../src/play/folk.js';
import { HazardWorld, type HazardHandPose, type HazardSolution } from '../src/play/hazards.js';
import { applyLevel, generateScreens, type ScreenLevel } from '../src/play/levels.js';
import { validateLevel } from '../src/play/solver.js';
import { arcNight } from '../src/play/arc.js';
import { basePoses, orient, shape, type HandPose } from '../src/shadow/hand-model.js';
import { FlatHand, projectFromLight, STAGE, type ScreenFrame } from '../src/shadow/silhouette.js';

const DT = 0.05;
const SCREEN: ScreenFrame = {
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

interface FlickRun {
  agentIndex: number;
  startedAt: number;
}

interface CrossingTrial {
  night: number;
  seed: number;
  total: number;
  home: number;
  ash: number;
  lost: number;
  homeRate: number;
  screens: Array<{
    index: number;
    hazards: string[];
    total: number;
    home: number;
    ash: number;
    lost: number;
    homeRate: number;
    seconds: number;
    flickStarts: number;
    flickEvents: Array<{ slot: number; agentIndex: number; at: number }>;
    ashEvents: Array<{ agentIndex: number; at: number; x: number; y: number; cause: 'left-edge' | 'right-edge' | 'below-paper' | 'fall-depth' }>;
    hazardStats: {
      crowSwats: number;
      crowGrabs: number;
      riverDouses: number;
      rainDropsHit: number;
      gustShelteredAgentSeconds: number;
      gustExposedAgentSeconds: number;
      thornTurns: number;
      boulderHits: number;
      bouldersBlocked: number;
      bouldersCrumbled: number;
      ashByHazard: Record<string, number>;
    };
  }>;
}

interface HazardTrial {
  seed: number;
  sheltered?: number;
  swatted?: number;
  total: number;
  home?: number;
  homeTotal?: number;
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
  projectFromLight(joints, pose.radii, 0, 0, 0, SCREEN, flat);
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

function placementsForSolutions(
  solutions: readonly HazardSolution[],
  cache: Map<string, SyntheticHand>,
  include: (solution: HazardSolution, hand: HazardHandPose) => boolean = () => true,
): HandPlacement[] {
  const placements: HandPlacement[] = [];
  for (const solution of solutions) {
    for (let index = 0; index < solution.hands.length; index++) {
      const descriptor = solution.hands[index];
      if (!include(solution, descriptor)) continue;
      const key = `${solution.slot}:${solution.kind}:${solution.action}:${index}:${descriptor.angle}:${descriptor.scale}:${descriptor.soft}`;
      let hand = cache.get(key);
      if (!hand) {
        const scale = descriptor.scale;
        hand = makeProjectedHand(poseForSolution(solution, descriptor), scale, solution.slot);
        cache.set(key, hand);
      }
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

function updateRuntime(hazards: HazardWorld, folk: FolkWorld): void {
  hazards.update(DT);
  folk.update(DT);
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
    if (hazard.kind !== 'ledge' && hazard.kind !== 'highLedge' && hazard.kind !== 'thorns') continue;
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
      const isBrowserFlick = hazard.kind === 'ledge' || hazard.kind === 'highLedge' || hazard.kind === 'thorns';
      for (let agentIndex = 0; agentIndex < folk.count; agentIndex++) {
        const agent = folk.agents[agentIndex];
        const key = `${slot}:${agentIndex}`;
        if (isBrowserFlick) {
          if (agent.state !== 'walking' || agent.heading <= 0) continue;
          if (agent.x < left - 0.10 || agent.x > left + 0.02 || lastFlickAt.has(key)) continue;
          candidate = agentIndex;
          break;
        }
        if (agent.state !== 'walking' && agent.state !== 'falling') continue;
        if (agent.x < left - 0.13 || agent.x > left + hazard.width + 0.08) continue;
        if (agent.y < hazard.floorY - 0.07 || agent.y > hazard.floorY + 0.18) continue;
        if (elapsed - (lastFlickAt.get(key) ?? -Infinity) < 0.8) continue;
        const distance = Math.abs(agent.x - (left - 0.025));
        if (distance < candidateDistance) {
          candidate = agentIndex;
          candidateDistance = distance;
        }
      }
      if (candidate >= 0) {
        field.clearHand(slot);
        flick = flicks[slot] = { agentIndex: candidate, startedAt: elapsed };
        lastFlickAt.set(`${slot}:${candidate}`, elapsed);
      }
    }

    if (!flick) continue;
    const age = elapsed - flick.startedAt;
    let progress = Math.max(0, Math.min(1, age / sweepDuration));
    const flickPose = gapBridgePose();
    const hand = cachedHand(cache, `${slot}:${hazard.kind}:near-flame-flick`, flickPose, 2.5, slot);
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
  const solutions = hazards.solve();

  for (const solution of solutions) {
    const layout = hazards.layouts.find((candidate) => candidate.slot === solution.slot);
    if (!layout) continue;
    if (layout.kind === 'ledge' || layout.kind === 'thorns') continue;

    if (layout.kind === 'highLedge') {
      continue;
    }

    if (layout.kind === 'gap' || layout.kind === 'river') {
      const hand = cachedHand(cache, `${layout.slot}:${layout.kind}:bridge`, gapBridgePose(), 1, layout.slot);
      placements.push({ hand, x: layout.x, y: -0.23 });
      continue;
    }

    if (layout.kind === 'crow') {
      placements.push(...placementsForSolutions(
        [solution],
        cache,
        (entry, hand) => crowIsSwooping(previousCrowPositions, entry, hand, layout.floorY),
      ));
      continue;
    }

    if (layout.kind === 'gust') {
      const phase = elapsed % 5;
      const left = layout.x - layout.width * 0.5;
      const right = layout.x + layout.width * 0.5;
      const rightmost = rightmostActiveAgentNear(folk, left - 0.03, right + 0.03);
      const walkerBeyondBand = hasActiveAgentPast(folk, right + 0.03);
      if (phase >= 2 || rightmost === null || walkerBeyondBand) continue;
      for (const placement of placementsForSolutions([solution], cache)) {
        placement.x = layout.x + 0.18;
        placement.y = -0.105;
        placements.push(placement);
      }
      continue;
    }

    if (layout.kind === 'boulder') {
      const boulderX = solution.hands[0]?.x;
      if (boulderX === undefined) continue;
      const previousX = previousBoulderPositions.get(layout.slot);
      const active = Math.abs(boulderX - layout.x) > 0.000001
        || (previousX !== undefined && previousX > layout.x);
      previousBoulderPositions.set(layout.slot, boulderX);
      if (!active) continue;
      const intercept = Math.min(0.40, boulderX - 0.10);
      for (const placement of placementsForSolutions([solution], cache)) {
        placement.x = intercept;
        placement.y = -0.16;
        placements.push(placement);
      }
      continue;
    }

    placements.push(...placementsForSolutions([solution], cache));
  }

  return placements;
}

function screenLevels(value: unknown): ScreenLevel[] {
  if (!Array.isArray(value)) throw new Error('crossing level must be an array of screens');
  return value as ScreenLevel[];
}

function runLevel(
  value: unknown,
  options: { night: number; seed: number; hands: 'solver' | 'none' },
): CrossingTrial {
  const levels = screenLevels(value);
  if (levels.length !== 3) throw new Error(`night ${options.night} has ${levels.length} screens; expected 3`);

  const field = new InkField();
  const folk = new FolkWorld(field, options.seed);
  const hazards = new HazardWorld(field, folk);
  const handCache = new Map<string, SyntheticHand>();
  let total = 0;
  let home = 0;
  let ash = 0;
  let lost = 0;
  const screens: CrossingTrial['screens'] = [];

  for (const level of levels) {
    const ashEvents: CrossingTrial['screens'][number]['ashEvents'] = [];
    folk.onEvent = (kind, agent) => {
      if (kind !== 'ash') return;
      const cause = agent.x < -0.62 ? 'left-edge'
        : agent.x > 0.62 ? 'right-edge'
          : agent.y < -0.37 ? 'below-paper' : 'fall-depth';
      ashEvents.push({ agentIndex: folk.agents.indexOf(agent), at: elapsed, x: agent.x, y: agent.y, cause });
    };
    applyLevel(field, level);
    folk.reset();
    folk.configure({ waveCount: level.kindlings });
    hazards.start(level);
    total += level.kindlings;
    const flicks: (FlickRun | undefined)[] = [undefined, undefined];
    const lastFlickAt = new Map<string, number>();
    const previousCrowPositions = new Map<number, { x: number; y: number }>();
    const previousBoulderPositions = new Map<number, number>();
    let elapsed = 0;

    const maxFrames = Math.ceil(50 / DT);
    for (let frame = 0; frame < maxFrames; frame++) {
      field.beginFrame();
      if (options.hands === 'solver') {
        addHands(field, placementsForLevel(
          field, folk, hazards, handCache, flicks, lastFlickAt,
          previousCrowPositions, previousBoulderPositions, elapsed,
        ));
      }
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
      total: level.kindlings,
      home: screenHome,
      ash: screenAsh,
      lost: screenLost,
      homeRate: level.kindlings > 0 ? screenHome / level.kindlings : 0,
      seconds: elapsed,
      flickStarts: lastFlickAt.size,
      flickEvents: Array.from(lastFlickAt, ([key, at]) => {
        const [slot, agentIndex] = key.split(':').map(Number);
        return { slot, agentIndex, at };
      }),
      ashEvents,
      hazardStats: {
        crowSwats: hazards.stats.crowSwats,
        crowGrabs: hazards.stats.crowGrabs,
        riverDouses: hazards.stats.riverDouses,
        rainDropsHit: hazards.stats.rainDropsHit,
        gustShelteredAgentSeconds: hazards.stats.gustShelteredAgentSeconds,
        gustExposedAgentSeconds: hazards.stats.gustExposedAgentSeconds,
        thornTurns: hazards.stats.thornTurns,
        boulderHits: hazards.stats.boulderHits,
        bouldersBlocked: hazards.stats.bouldersBlocked,
        bouldersCrumbled: hazards.stats.bouldersCrumbled,
        ashByHazard: { ...hazards.stats.ashByHazard },
      },
    });
    home += screenHome;
    ash += screenAsh;
    lost += screenLost;
  }

  hazards.dispose();
  return {
    night: options.night,
    seed: options.seed,
    total,
    home,
    ash,
    lost,
    homeRate: total > 0 ? home / total : 0,
    screens,
  };
}

function createRuntime(level: ScreenLevel, seed: number): { field: InkField; folk: FolkWorld; hazards: HazardWorld } {
  const field = new InkField();
  const folk = new FolkWorld(field, seed);
  folk.configure({ waveCount: 0 });
  applyLevel(field, level);
  const hazards = new HazardWorld(field, folk);
  hazards.start(level);
  return { field, folk, hazards };
}

function validateLayout(value: unknown, night: number, seed: number): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(value)) return { valid: false, errors: ['layout must be an array of screens'] };
  const levels = value as ScreenLevel[];
  const arc = arcNight(night, seed);
  if (levels.length !== 3) errors.push(`expected 3 screens, received ${levels.length}`);
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index];
    const validation = validateLevel(level);
    errors.push(...validation.errors.map((error) => `screen ${index}: ${error}`));
    if (level.index !== index) errors.push(`screen ${index}: index mismatch`);
    if (level.kindlings !== arc.kindlings[index]) errors.push(`screen ${index}: kindling count mismatch`);
    const newest = arc.troubles[0] ?? 'gap';
    if (night >= 9) {
      const [first, second = first, third = second] = arc.troubles;
      const expected = [[first], [first, second], [second, third]][index] ?? [];
      if (level.hazards.length !== expected.length || expected.some((kind, slot) => level.hazards[slot]?.kind !== kind)) {
        errors.push(`screen ${index} must hold daily troubles ${expected.join('+')}`);
      }
      continue;
    }
    if (index === 0) {
      if (level.hazards.length !== 1 || level.hazards[0]?.kind !== newest) errors.push('screen 0 must contain only the newest trouble');
    } else {
      if (level.hazards.length !== 2 || level.hazards[0]?.kind !== newest) errors.push(`screen ${index} must place the newest trouble in slot 0`);
      const secondary = arc.troubles.length > 1 ? arc.troubles.slice(1) : [newest];
      if (!secondary.some((kind) => kind === level.hazards[1]?.kind)) errors.push(`screen ${index} has a trouble outside tonight's pool`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function runRainSoft(seed: number): HazardTrial {
  const level = generateScreens(5, seed, ['rain'], 1)[0];
  const { field, folk, hazards } = createRuntime(level, seed);
  const umbrella = makeProjectedHand(flatBridgePose(), 1.45, 0);
  const duration = 12;
  for (let frame = 0; frame < Math.ceil(duration / DT); frame++) {
    field.beginFrame();
    placeHand(umbrella, level.hazards[0].x, 0.035);
    field.clearHand(0);
    field.addHand(umbrella.flat, umbrella.scale, DT, umbrella.side);
    updateRuntime(hazards, folk);
  }
  const result = { seed, sheltered: hazards.stats.rainDropsSheltered, total: hazards.stats.rainDropsSpawned };
  hazards.dispose();
  return result;
}

function runGustWall(seed: number): HazardTrial {
  const level = generateScreens(7, seed, ['gust'], 20)[0];
  const { field, folk, hazards } = createRuntime(level, seed);
  const x = level.hazards[0].x;
  const count = 20;
  for (let index = 0; index < count; index++) {
    const position = x - 0.055 + (index / (count - 1)) * 0.05;
    const agent = folk.spawn(position, -0.189, 1);
    if (agent) agent.state = 'walking';
  }
  const handCache = new Map<string, SyntheticHand>();
  for (let frame = 0; frame < 10 * 60; frame++) {
    field.beginFrame();
    const phase = (frame * DT) % 5;
    if (phase < 2) addHands(field, placementsForSolutions(hazards.solve(), handCache));
    hazards.update(DT);
    folk.update(DT);
  }
  const sheltered = Math.round(hazards.stats.gustShelteredAgentSeconds * 60);
  const total = Math.round((hazards.stats.gustShelteredAgentSeconds + hazards.stats.gustExposedAgentSeconds) * 60);
  hazards.dispose();
  return { seed, sheltered, total };
}

function runCrowSwat(seed: number): HazardTrial {
  const kindlings = 6;
  const level = generateScreens(3, seed, ['crow'], kindlings)[0];
  const { field, folk, hazards } = createRuntime(level, seed);
  folk.configure({ waveCount: kindlings });
  const handCache = new Map<string, SyntheticHand>();
  const previousCrowPositions = new Map<number, { x: number; y: number }>();
  for (let frame = 0; frame < 30 * 60; frame++) {
    field.beginFrame();
    const layout = hazards.layouts.find((candidate) => candidate.kind === 'crow');
    addHands(field, placementsForSolutions(
      hazards.solve(),
      handCache,
      (solution, hand) => solution.kind !== 'crow'
        || (!!layout && crowIsSwooping(previousCrowPositions, solution, hand, layout.floorY)),
    ));
    hazards.update(DT);
    folk.update(DT);
    if (folk.count >= kindlings && folk.homeCount + folk.ashCount >= kindlings) break;
  }
  const swatted = hazards.stats.crowSwats;
  const total = Math.max(1, hazards.stats.crowSwats + hazards.stats.crowGrabs);
  const home = folk.homeCount;
  hazards.dispose();
  return { seed, swatted, total, home, homeTotal: kindlings };
}

export const crossingBench = {
  generateLevel(night: number, seed: number): ScreenLevel[] {
    return generateScreens(night, seed);
  },
  validateLayout,
  runLevel,
  runRainSoft,
  runGustWall,
  runCrowSwat,
};

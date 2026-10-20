import { arcNight, type ArcTrouble } from './arc.js';
import { InkField } from './ink-field.js';
import { solveLevel } from './solver.js';

export type HazardKind = ArcTrouble;
export type HazardSlot = 0 | 1;

export interface LevelHazard {
  kind: HazardKind;
  slot: HazardSlot;
  x: number;
  width: number;
}

export interface ScreenLevel {
  hazards: LevelHazard[];
  kindlings: number;
  index: number;
}

const SLOT_X: readonly [number, number] = [-0.17, 0.16];
const FLOOR_LEFT = -0.68;
const FLOOR_RIGHT = 0.68;
const FLOOR_BOTTOM = -0.29;
const FLOOR_TOP = -0.20;
const RIVER_DEPTH = 0.06;
const RIVER_RAMP_RUN = 0.06;
const RIVER_RAMP_STEP = 0.02;

const WIDTHS: Record<HazardKind, readonly number[]> = {
  gap: [0.10, 0.12, 0.14, 0.16],
  ledge: [0.16, 0.18, 0.20],
  highLedge: [0.16, 0.18, 0.20],
  river: [0.14, 0.16, 0.18],
  crow: [0.16],
  rain: [0.20, 0.22],
  thorns: [0.12],
  gust: [0.12],
  boulder: [0.07],
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function levelSeed(seed: number, night: number, index: number): number {
  return (seed ^ Math.imul(night + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0;
}

function makeScreen(
  index: number,
  kinds: readonly HazardKind[],
  kindlings: number,
  seed: number,
  night: number,
): ScreenLevel {
  const random = seededRandom(levelSeed(seed, night, index));
  const hazards = kinds.slice(0, 2).map((kind, slot): LevelHazard => {
    const widths = WIDTHS[kind];
    if (!widths) throw new Error(`Unknown hazard kind: ${String(kind)}`);
    const width = widths[Math.floor(random() * widths.length)];
    return { kind, slot: slot as HazardSlot, x: SLOT_X[slot], width };
  });
  const level = { hazards, kindlings, index };
  const plan = solveLevel(level);
  if (!plan.valid) throw new Error(`Generated invalid screen ${index}: ${plan.errors.join('; ')}`);
  return level;
}

function boundedKindlings(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(48, Math.floor(value)));
}

export function generateScreens(
  night: number,
  seed: number,
  hazardsOverride?: HazardKind[],
  kindlingsOverride?: number,
): ScreenLevel[] {
  const safeNight = Number.isFinite(night) ? Math.max(0, Math.floor(night)) : 1;
  const arc = arcNight(safeNight, seed);
  if (safeNight === 0) return [makeScreen(0, ['gap'], 1, seed, safeNight)];

  if (hazardsOverride !== undefined || kindlingsOverride !== undefined) {
    const kinds = hazardsOverride ?? [arc.troubles[0] ?? 'gap'];
    const kindlings = kindlingsOverride === undefined
      ? arc.kindlings[0]
      : boundedKindlings(kindlingsOverride, arc.kindlings[0]);
    return [makeScreen(0, kinds, kindlings, seed, safeNight)];
  }

  const newest = arc.troubles[0] ?? 'gap';
  const secondaryPool = arc.troubles.length > 1 ? arc.troubles.slice(1) : [newest];
  const pickRandom = seededRandom(levelSeed(seed, safeNight, 17));
  return arc.kindlings.map((kindlings, index) => {
    const secondary = index === 0 ? newest
      : safeNight >= 7 && index === 1 ? 'boulder'
      : safeNight >= 7 ? ['highLedge', 'gap', 'river'][Math.floor(pickRandom() * 3)] as HazardKind
        : secondaryPool[Math.floor(pickRandom() * secondaryPool.length)];
    const kinds: HazardKind[] = index === 0
      ? [newest]
      : [newest, secondary];
    return makeScreen(index, kinds, kindlings, seed, safeNight);
  });
}

function floorCuts(level: ScreenLevel): Array<{ left: number; right: number }> {
  return level.hazards.flatMap((hazard) => {
    const halfWidth = hazard.width * 0.5;
    if (hazard.kind === 'gap') return [{ left: hazard.x - halfWidth, right: hazard.x + halfWidth }];
    if (hazard.kind === 'river') {
      return [{
        left: hazard.x - halfWidth - RIVER_RAMP_RUN,
        right: hazard.x + halfWidth + RIVER_RAMP_RUN,
      }];
    }
    return [];
  }).sort((first, second) => first.left - second.left);
}

function paintBaseFloor(field: InkField, level: ScreenLevel): void {
  const cuts = floorCuts(level);
  let cursor = FLOOR_LEFT;
  for (const cut of cuts) {
    const left = Math.max(FLOOR_LEFT, cut.left);
    const right = Math.min(FLOOR_RIGHT, cut.right);
    if (left > cursor) field.setStaticRect(cursor, FLOOR_BOTTOM, left, FLOOR_TOP);
    cursor = Math.max(cursor, right);
  }
  if (cursor < FLOOR_RIGHT) field.setStaticRect(cursor, FLOOR_BOTTOM, FLOOR_RIGHT, FLOOR_TOP);
}

function paintRiver(field: InkField, hazard: LevelHazard): void {
  const halfWidth = hazard.width * 0.5;
  const waterLeft = hazard.x - halfWidth;
  const waterRight = hazard.x + halfWidth;
  const bedTop = FLOOR_TOP - RIVER_DEPTH;
  const steps = Math.round(RIVER_RAMP_RUN / RIVER_RAMP_STEP);
  for (let step = 0; step < steps; step++) {
    const left = waterLeft - RIVER_RAMP_RUN + step * RIVER_RAMP_STEP;
    field.setStaticRect(left, FLOOR_BOTTOM, left + RIVER_RAMP_STEP, FLOOR_TOP - (step + 1) * RIVER_RAMP_STEP);
  }
  field.setStaticRect(waterLeft, FLOOR_BOTTOM, waterRight, bedTop);
  for (let step = 0; step < steps; step++) {
    const left = waterRight + step * RIVER_RAMP_STEP;
    field.setStaticRect(left, FLOOR_BOTTOM, left + RIVER_RAMP_STEP, bedTop + (step + 1) * RIVER_RAMP_STEP);
  }
}

export function applyLevel(field: InkField, level: ScreenLevel): void {
  const plan = solveLevel(level);
  if (!plan.valid) throw new Error(`Cannot apply invalid screen ${level.index}: ${plan.errors.join('; ')}`);

  field.clearStatic();
  paintBaseFloor(field, level);
  for (const hazard of level.hazards) {
    if (hazard.kind === 'river') paintRiver(field, hazard);
    if (hazard.kind === 'ledge' || hazard.kind === 'highLedge' || hazard.kind === 'thorns') {
      const rise = hazard.kind === 'ledge' ? 0.09 : hazard.kind === 'highLedge' ? 0.16 : 0.04;
      field.setStaticRect(hazard.x - hazard.width * 0.5, FLOOR_TOP, hazard.x + hazard.width * 0.5, FLOOR_TOP + rise);
    }
  }
}

import type { HazardKind, ScreenLevel } from './levels.js';

export type SolverAnswer = 'bridge' | 'ramp' | 'two-step-ramp' | 'swat' | 'umbrella' | 'palm-wall' | 'block';

export interface SolverAction {
  kind: HazardKind;
  slot: 0 | 1;
  x: number;
  answer: SolverAnswer;
}

export interface SolverPlan {
  valid: boolean;
  screen: number;
  actions: SolverAction[];
  errors: string[];
}

export interface LevelValidation {
  valid: boolean;
  errors: string[];
}

const SLOT_X: readonly [number, number] = [-0.17, 0.16];
const RIVER_RAMP_RUN = 0.06;
const ANSWERS: Record<HazardKind, SolverAnswer> = {
  gap: 'bridge',
  ledge: 'ramp',
  highLedge: 'two-step-ramp',
  river: 'bridge',
  crow: 'swat',
  rain: 'umbrella',
  thorns: 'bridge',
  gust: 'palm-wall',
  boulder: 'block',
};
const WIDTH_LIMITS: Record<HazardKind, readonly [number, number]> = {
  gap: [0.10, 0.16],
  ledge: [0.12, 0.22],
  highLedge: [0.12, 0.22],
  river: [0.14, 0.18],
  crow: [0.16, 0.22],
  rain: [0.14, 0.22],
  thorns: [0.12, 0.12],
  gust: [0.12, 0.12],
  boulder: [0.07, 0.07],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function terrainFootprint(hazard: { kind: HazardKind; width: number }): number {
  return hazard.width + (hazard.kind === 'river' ? RIVER_RAMP_RUN * 2 : 0);
}

export function validateLevel(value: unknown): LevelValidation {
  const errors: string[] = [];
  if (!isObject(value)) return { valid: false, errors: ['screen must be an object'] };

  const level = value as Partial<ScreenLevel>;
  if (!Number.isSafeInteger(level.index) || level.index! < 0 || level.index! > 2) errors.push('index must be 0, 1, or 2');
  if (!Number.isSafeInteger(level.kindlings) || level.kindlings! < 0 || level.kindlings! > 48) errors.push('kindlings must be an integer from 0 to 48');
  if (!Array.isArray(level.hazards) || level.hazards.length > 2) {
    errors.push('hazards must contain zero, one, or two entries');
    return { valid: errors.length === 0, errors };
  }

  const occupiedSlots = new Set<number>();
  const footprints: Array<{ left: number; right: number }> = [];
  for (let index = 0; index < level.hazards.length; index++) {
    const rawHazard: unknown = level.hazards[index];
    if (!isObject(rawHazard)) {
      errors.push(`hazard ${index} must be an object`);
      continue;
    }
    const kind = rawHazard.kind as HazardKind;
    const slot = rawHazard.slot;
    const x = rawHazard.x;
    const width = rawHazard.width;
    if (!Object.prototype.hasOwnProperty.call(ANSWERS, kind)) {
      errors.push(`hazard ${index} has an unknown kind`);
      continue;
    }
    if (slot !== 0 && slot !== 1) errors.push(`hazard ${index} slot must be 0 or 1`);
    else if (occupiedSlots.has(slot)) errors.push(`slot ${slot} is occupied more than once`);
    else occupiedSlots.add(slot);
    if (typeof x !== 'number' || !Number.isFinite(x)) errors.push(`hazard ${index} x must be finite`);
    else if ((slot === 0 || slot === 1) && Math.abs(x - SLOT_X[slot]) > 0.001) errors.push(`hazard ${index} x does not match its slot`);
    if (typeof width !== 'number' || !Number.isFinite(width)) {
      errors.push(`hazard ${index} width must be finite`);
      continue;
    }
    const [minimum, maximum] = WIDTH_LIMITS[kind];
    if (width < minimum - 1e-6 || width > maximum + 1e-6 || width > 0.22) errors.push(`hazard ${index} width is outside its supported range`);
    if (typeof x === 'number' && Number.isFinite(x)) {
      const footprint = terrainFootprint({ kind, width });
      footprints.push({ left: x - footprint * 0.5, right: x + footprint * 0.5 });
    }
  }

  footprints.sort((first, second) => first.left - second.left);
  for (let index = 1; index < footprints.length; index++) {
    if (footprints[index].left < footprints[index - 1].right + 0.02) errors.push('hazard terrain footprints leave no walking lane between slots');
  }
  for (const footprint of footprints) {
    if (footprint.left <= -0.38 || footprint.right >= 0.38) errors.push('hazard terrain overlaps a lantern or moon door approach');
  }

  return { valid: errors.length === 0, errors };
}

export function solveLevel(level: ScreenLevel): SolverPlan {
  const validation = validateLevel(level);
  const actions = validation.valid
    ? level.hazards.map((hazard): SolverAction => ({
      kind: hazard.kind,
      slot: hazard.slot,
      x: hazard.x,
      answer: ANSWERS[hazard.kind],
    }))
    : [];
  return { valid: validation.valid, screen: level.index, actions, errors: validation.errors };
}

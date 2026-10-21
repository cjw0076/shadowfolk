import type { FolkWorld, Kindling } from './folk.js';
import type { HazardWorld } from './hazards.js';
import type { InkField } from './ink-field.js';
import type { HazardKind, ScreenLevel } from './levels.js';

export type SummonKind = 'peacock' | 'rabbit' | 'snail' | 'dog' | 'duck' | 'fish'
  | 'elephant' | 'heron' | 'crab' | 'butterfly' | 'stag' | 'invented';

export interface SummonAgent {
  kind: SummonKind;
  id: string;
  name: string;
  x: number;
  y: number;
  age: number;
  timer: number;
  uses: number;
  state: number;
  target: Kindling | null;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  carryElapsed: number;
  carryDuration: number;
}

export interface SummonContext {
  readonly dt: number;
  readonly field: InkField;
  readonly folk: FolkWorld;
  readonly hazards: HazardWorld;
  readonly level: ScreenLevel;
  readonly time: number;
  nearest(kind: HazardKind, x: number): { x: number; width: number; kind: HazardKind } | null;
  walkerNear(x: number, radius: number, beforeX?: number): Kindling | null;
  carry(agent: SummonAgent, walker: Kindling, toX: number, toY: number, duration: number): void;
  advanceCarry(agent: SummonAgent): boolean;
  addBridge(left: number, right: number, bottom: number, top: number, duration: number): void;
}

export type GiftUpdate = (agent: SummonAgent, context: SummonContext) => void;

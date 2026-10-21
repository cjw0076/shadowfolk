import {
  CanvasTexture, DynamicDrawUsage, Group, InstancedMesh, LinearFilter, Mesh, MeshBasicMaterial,
  Object3D, PlaneGeometry, RepeatWrapping, SRGBColorSpace,
} from '@iwsdk/core';
import { boulder, crow, crowFlying, fogBank, ledge, vineCurtain } from '../journey/props-art.js';
import type { HazardKind, ScreenLevel } from './levels.js';
import { FolkWorld, type Kindling } from './folk.js';
import { InkField } from './ink-field.js';

export type HazardSlot = 0 | 1;
export type HazardRng = () => number;

export interface HazardPlacement {
  kind: HazardKind;
  slot: HazardSlot;
  x: number;
  width: number;
}

export interface HazardLayout extends HazardPlacement {
  floorY: number;
  rise: number;
  dip: number;
  radius: number;
  wingspan: number;
}

export interface HazardHandPose {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  scale: number;
  soft: boolean;
}

export type HazardAction = 'bridge' | 'ramp' | 'flick' | 'swat' | 'umbrella' | 'palm-wall' | 'block';

export interface HazardSolution {
  kind: HazardKind;
  slot: HazardSlot;
  action: HazardAction;
  hands: HazardHandPose[];
  flick?: { x: number; y: number; direction: -1 | 1 };
}

export interface HazardPuppet {
  applyHazardSolution(solution: HazardSolution): void;
}

export interface HazardStats {
  crowSwats: number;
  crowGrabs: number;
  riverDouses: number;
  rainDropsSpawned: number;
  rainDropsSheltered: number;
  rainDropsHit: number;
  rainDropsGrounded: number;
  gustShelteredAgentSeconds: number;
  gustExposedAgentSeconds: number;
  thornTurns: number;
  boulderHits: number;
  bouldersBlocked: number;
  bouldersCrumbled: number;
  ashByHazard: Record<HazardKind, number>;
}

export interface HazardEvent {
  kind: 'crow-swat' | 'crow-grab' | 'river-douse' | 'rain-hit' | 'thorn-turn' | 'boulder-hit' | 'boulder-crumble';
  hazard: HazardKind;
  x: number;
  y: number;
  agent?: Kindling;
}

interface RuntimeHazard extends HazardLayout {
  clock: number;
  suppressedUntil: number;
  removed: boolean;
  random: number;
  casualties: number;
  hinted: boolean;
  crowMode: 0 | 1 | 2;
  crowTimer: number;
  crowProgress: number;
  crowX: number;
  crowY: number;
  crowStartX: number;
  crowStartY: number;
  crowControlX: number;
  crowControlY: number;
  crowTargetX: number;
  crowTargetY: number;
  crowSwatted: boolean;
  crowSwatElapsed: number;
  crowSwatX: number;
  crowSwatY: number;
  crowSafeGlintShown: boolean;
  rainAccumulator: number;
  rainCursor: number;
  rainX: Float32Array;
  rainY: Float32Array;
  rainActive: Uint8Array;
  gustSheltered: number;
  gustExposed: number;
  boulderActive: boolean;
  boulderX: number;
  boulderBlockedFor: number;
  boulderWasBlocked: boolean;
  boulderNext: number;
}

type HazardSprite = Mesh<PlaneGeometry, MeshBasicMaterial>;

interface InstanceEffectPool {
  mesh: InstancedMesh;
  age: Float32Array;
  x: Float32Array;
  y: Float32Array;
  rotation: Float32Array;
  cursor: number;
}

interface HazardVisual {
  root: Group;
  textures: CanvasTexture[];
  crow: HazardSprite | null;
  crowFeathers: InstancedMesh | null;
  safeGlints: InstanceEffectPool | null;
  rainStreaks: InstancedMesh | null;
  rainStreakX: Float32Array | null;
  rainStreakProgress: Float32Array | null;
  rainStreakHold: Float32Array | null;
  rainStreakStopY: Float32Array | null;
  rainSplashes: InstanceEffectPool | null;
  steamPuffs: InstanceEffectPool | null;
  boulder: HazardSprite | null;
  wind: HazardSprite[];
  waterTexture: CanvasTexture | null;
}

interface PlacementOverride {
  x?: number;
  width?: number;
}

const FLOOR_Y = -0.20;
const MAX_RAINDROPS = 32;
const MAX_FOLK = 48;
const MAX_RAIN_STREAKS = 45;
const MAX_RAIN_SPLASHES = 24;
const MAX_RAIN_STEAM_PUFFS = 16;
const MAX_CROW_FEATHERS = 4;
const MAX_SAFE_GLINTS = 4;
const RAIN_CLOUD_WIDTH = 0.30;
const RAIN_STREAK_LENGTH = 0.035;
const RAIN_STREAK_TOP = 0.035;
const RAIN_STREAK_SPEED = 0.6;
const RAIN_STREAK_HOLD = 0.055;
const RAIN_SPLASH_LIFETIME = 0.18;
const RAIN_STEAM_LIFETIME = 0.62;
const SAFE_GLINT_LIFETIME = 0.5;
const CROW_TUMBLE_DURATION = 0.5;
const CROW_EXIT_DURATION = 0.42;
const STEP_RADIUS = 0.011;
const DEFAULT_X: readonly [number, number] = [-0.17, 0.16];
const FEATHER_VELOCITY_X: readonly number[] = [-0.065, -0.022, 0.028, 0.064];
const FEATHER_VELOCITY_Y: readonly number[] = [0.075, 0.11, 0.095, 0.06];
const FEATHER_ROTATION: readonly number[] = [-0.7, 0.35, -0.2, 0.85];
const FEATHER_SPIN: readonly number[] = [8, -10, 12, -7];

function boundedRandom(rng: HazardRng): number {
  const value = rng();
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0;
}

function between(rng: HazardRng, low: number, high: number): number {
  return low + (high - low) * boundedRandom(rng);
}

function defaultWidth(kind: HazardKind, rng: HazardRng): number {
  switch (kind) {
    case 'gap': return between(rng, 0.10, 0.16);
    case 'ledge': return between(rng, 0.14, 0.22);
    case 'highLedge': return between(rng, 0.16, 0.22);
    case 'river': return between(rng, 0.14, 0.18);
    case 'crow': return 0.16;
    case 'rain': return 0.25;
    case 'thorns': return 0.12;
    case 'gust': return 0.12;
    case 'boulder': return 0.12;
  }
}

export function layoutHazard(
  kind: HazardKind,
  slot: HazardSlot,
  rng: HazardRng,
  placement: PlacementOverride = {},
): HazardLayout {
  const width = placement.width ?? defaultWidth(kind, rng);
  return {
    kind,
    slot,
    x: placement.x ?? DEFAULT_X[slot],
    width,
    floorY: FLOOR_Y,
    rise: kind === 'highLedge' ? between(rng, 0.14, 0.18)
      : kind === 'ledge' ? between(rng, 0.07, 0.11) : 0,
    dip: kind === 'river' ? 0.06 : 0,
    radius: kind === 'boulder' ? 0.035 : 0,
    wingspan: kind === 'crow' ? 0.16 : 0,
  };
}

function initialRandom(seed: number, kind: HazardKind, slot: HazardSlot): number {
  let hash = (seed ^ ((slot + 1) * 0x9e3779b9)) | 0;
  for (let index = 0; index < kind.length; index++) hash = Math.imul(hash ^ kind.charCodeAt(index), 0x45d9f3b);
  return hash >>> 0 || 1;
}

function nextRandom(hazard: RuntimeHazard): number {
  let value = hazard.random | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  hazard.random = value >>> 0 || 1;
  return hazard.random / 0x100000000;
}

function createStats(): HazardStats {
  return {
    crowSwats: 0,
    crowGrabs: 0,
    riverDouses: 0,
    rainDropsSpawned: 0,
    rainDropsSheltered: 0,
    rainDropsHit: 0,
    rainDropsGrounded: 0,
    gustShelteredAgentSeconds: 0,
    gustExposedAgentSeconds: 0,
    thornTurns: 0,
    boulderHits: 0,
    bouldersBlocked: 0,
    bouldersCrumbled: 0,
    ashByHazard: {
      gap: 0, ledge: 0, highLedge: 0, river: 0, crow: 0, rain: 0, thorns: 0, gust: 0, boulder: 0,
    },
  };
}

function resetStats(stats: HazardStats): void {
  stats.crowSwats = stats.crowGrabs = stats.riverDouses = 0;
  stats.rainDropsSpawned = stats.rainDropsSheltered = stats.rainDropsHit = stats.rainDropsGrounded = 0;
  stats.gustShelteredAgentSeconds = stats.gustExposedAgentSeconds = 0;
  stats.thornTurns = stats.boulderHits = stats.bouldersBlocked = stats.bouldersCrumbled = 0;
  for (const kind of Object.keys(stats.ashByHazard) as HazardKind[]) stats.ashByHazard[kind] = 0;
}

function makeRuntime(layout: HazardLayout, seed: number): RuntimeHazard {
  const random = initialRandom(seed, layout.kind, layout.slot);
  const hazard: RuntimeHazard = {
    ...layout,
    clock: 0,
    suppressedUntil: 0,
    removed: false,
    random,
    casualties: 0,
    hinted: false,
    crowMode: 0,
    crowTimer: 6 + (random % 0xffff) / 0xffff * 3,
    crowProgress: 0,
    crowX: layout.x,
    crowY: layout.floorY + 0.16,
    crowStartX: layout.x,
    crowStartY: layout.floorY + 0.16,
    crowControlX: layout.x,
    crowControlY: layout.floorY + 0.16,
    crowTargetX: layout.x,
    crowTargetY: layout.floorY + 0.04,
    crowSwatted: false,
    crowSwatElapsed: 0,
    crowSwatX: layout.x,
    crowSwatY: layout.floorY + 0.16,
    crowSafeGlintShown: false,
    rainAccumulator: 0,
    rainCursor: 0,
    rainX: new Float32Array(MAX_RAINDROPS),
    rainY: new Float32Array(MAX_RAINDROPS),
    rainActive: new Uint8Array(MAX_RAINDROPS),
    gustSheltered: 0,
    gustExposed: 0,
    boulderActive: false,
    boulderX: layout.x + layout.width * 0.5 + layout.radius,
    boulderBlockedFor: 0,
    boulderWasBlocked: false,
    boulderNext: 0,
  };
  hazard.crowTimer = 6 + nextRandom(hazard) * 3;
  return hazard;
}

type HazardArt = {
  crowAtlas: HTMLCanvasElement;
  feather: HTMLCanvasElement;
  safeGlint: HTMLCanvasElement;
  steamPuff: HTMLCanvasElement;
  rainCloud: HTMLCanvasElement;
  river: HTMLCanvasElement;
  bramble: HTMLCanvasElement;
  gust: HTMLCanvasElement;
  boulderAtlas: HTMLCanvasElement;
  gap: HTMLCanvasElement;
  ledge: HTMLCanvasElement;
};

let bakedHazardArt: HazardArt | null = null;

function frameAtlas(frames: HTMLCanvasElement[]): HTMLCanvasElement {
  const width = Math.max(...frames.map((frame) => frame.width));
  const height = Math.max(...frames.map((frame) => frame.height));
  const canvas = document.createElement('canvas');
  canvas.width = width * frames.length;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  frames.forEach((frame, index) => context.drawImage(frame,
    width * index + (width - frame.width) * 0.5, (height - frame.height) * 0.5));
  return canvas;
}

function riverArt(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const wash = context.createLinearGradient(0, 8, 0, 58);
  wash.addColorStop(0, 'rgba(73, 99, 111, 0)');
  wash.addColorStop(0.45, 'rgba(73, 99, 111, 0.32)');
  wash.addColorStop(1, 'rgba(73, 99, 111, 0.08)');
  context.fillStyle = wash;
  context.beginPath();
  context.ellipse(128, 36, 126, 25, 0, 0, Math.PI * 2);
  context.fill();
  context.lineCap = 'round';
  context.strokeStyle = 'rgba(35, 22, 15, 0.52)';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(10, 24);
  context.bezierCurveTo(66, 18, 112, 29, 162, 23);
  context.bezierCurveTo(196, 19, 222, 20, 246, 17);
  context.stroke();
  context.lineWidth = 2.2;
  context.beginPath();
  context.moveTo(5, 43);
  context.bezierCurveTo(58, 38, 112, 47, 164, 41);
  context.bezierCurveTo(198, 37, 224, 40, 251, 35);
  context.stroke();
  return canvas;
}

function rainCloudArt(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 280;
  canvas.height = 176;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(fogBank(0.45), 0, 0);
  context.beginPath();
  context.moveTo(47, 110);
  context.bezierCurveTo(35, 95, 45, 78, 67, 77);
  context.bezierCurveTo(71, 52, 103, 49, 118, 68);
  context.bezierCurveTo(134, 43, 177, 49, 184, 76);
  context.bezierCurveTo(207, 61, 239, 77, 234, 99);
  context.bezierCurveTo(246, 119, 221, 129, 202, 120);
  context.quadraticCurveTo(178, 135, 151, 119);
  context.quadraticCurveTo(124, 137, 99, 119);
  context.quadraticCurveTo(65, 132, 47, 110);
  context.closePath();
  context.fillStyle = 'rgba(43,49,59,0.62)';
  context.fill();
  context.strokeStyle = 'rgba(31,36,44,0.82)';
  context.lineWidth = 4;
  context.stroke();
  return canvas;
}

function featherArt(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 80;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.fillStyle = '#333a40';
  context.strokeStyle = 'rgba(26,31,36,0.88)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(24, 4);
  context.bezierCurveTo(43, 19, 38, 48, 26, 67);
  context.quadraticCurveTo(23, 73, 20, 77);
  context.quadraticCurveTo(20, 65, 17, 59);
  context.bezierCurveTo(6, 41, 7, 17, 24, 4);
  context.closePath();
  context.fill();
  context.stroke();
  context.strokeStyle = 'rgba(176,184,185,0.72)';
  context.lineWidth = 1.6;
  context.beginPath();
  context.moveTo(24, 10);
  context.quadraticCurveTo(26, 39, 21, 72);
  context.stroke();
  return canvas;
}

function steamPuffArt(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const haze = context.createRadialGradient(40, 35, 4, 40, 35, 34);
  haze.addColorStop(0, 'rgba(219,227,225,0.72)');
  haze.addColorStop(0.62, 'rgba(192,205,205,0.48)');
  haze.addColorStop(1, 'rgba(177,191,192,0)');
  context.fillStyle = haze;
  context.beginPath();
  context.ellipse(40, 36, 37, 27, 0, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = 'rgba(224,230,227,0.72)';
  context.lineWidth = 2.5;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(28, 42);
  context.bezierCurveTo(18, 31, 33, 27, 31, 18);
  context.moveTo(47, 42);
  context.bezierCurveTo(58, 31, 43, 26, 49, 15);
  context.stroke();
  return canvas;
}

function safeGlintArt(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const glow = context.createRadialGradient(32, 32, 1, 32, 32, 29);
  glow.addColorStop(0, 'rgba(255,252,211,0.96)');
  glow.addColorStop(0.18, 'rgba(255,237,157,0.86)');
  glow.addColorStop(1, 'rgba(255,226,132,0)');
  context.fillStyle = glow;
  context.beginPath();
  context.moveTo(32, 2);
  context.quadraticCurveTo(37, 25, 62, 32);
  context.quadraticCurveTo(37, 37, 32, 62);
  context.quadraticCurveTo(27, 37, 2, 32);
  context.quadraticCurveTo(27, 27, 32, 2);
  context.fill();
  context.fillStyle = '#fff8d4';
  context.beginPath();
  context.arc(32, 32, 3, 0, Math.PI * 2);
  context.fill();
  return canvas;
}

function gustArt(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 96;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = 'rgba(35, 22, 15, 0.72)';
  context.fillStyle = 'rgba(35, 22, 15, 0.68)';
  context.lineWidth = 3.2;
  context.beginPath();
  context.moveTo(12, 55);
  context.bezierCurveTo(57, 18, 125, 78, 180, 33);
  context.stroke();
  for (let index = 0; index < 4; index++) {
    const x = 38 + index * 35;
    const y = 43 + Math.sin(index * 1.7) * 13;
    const direction = index % 2 === 0 ? -1 : 1;
    context.beginPath();
    context.moveTo(x - 7, y + direction * 5);
    context.quadraticCurveTo(x + 1, y - direction * 14, x + 17, y - direction * 8);
    context.quadraticCurveTo(x + 8, y + direction * 3, x - 7, y + direction * 5);
    context.fill();
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x - 5, y + direction * 4);
    context.lineTo(x + 13, y - direction * 7);
    context.stroke();
    context.lineWidth = 3.2;
  }
  return canvas;
}

function gapArt(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 48;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const wash = context.createLinearGradient(0, 8, 0, 48);
  wash.addColorStop(0, 'rgba(35, 22, 15, 0)');
  wash.addColorStop(0.55, 'rgba(35, 22, 15, 0.34)');
  wash.addColorStop(1, 'rgba(35, 22, 15, 0.12)');
  context.fillStyle = wash;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = 'rgba(35, 22, 15, 0.66)';
  context.lineWidth = 1.5;
  for (let index = -16; index < 38; index += 8) {
    context.beginPath();
    context.moveTo(index, 14);
    context.lineTo(index + 26, 45);
    context.moveTo(canvas.width - index, 14);
    context.lineTo(canvas.width - index - 26, 45);
    context.stroke();
  }
  return canvas;
}

function hazardArt(): HazardArt {
  if (!bakedHazardArt) {
    bakedHazardArt = {
      crowAtlas: frameAtlas([crow(true), ...[0, 1, 2, 3].map((frame) => crowFlying(frame))]),
      feather: featherArt(),
      safeGlint: safeGlintArt(),
      steamPuff: steamPuffArt(),
      rainCloud: rainCloudArt(),
      river: riverArt(),
      bramble: vineCurtain(),
      gust: gustArt(),
      boulderAtlas: frameAtlas([boulder(0), boulder(0.65), boulder(1)]),
      gap: gapArt(),
      ledge: ledge(220),
    };
  }
  return bakedHazardArt;
}

function createHazardTexture(visual: HazardVisual, source: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(source);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = LinearFilter;
  visual.textures.push(texture);
  return texture;
}

function addInkSprite(
  parent: Group,
  map: CanvasTexture,
  width: number,
  height: number,
  opacity = 1,
): HazardSprite {
  const material = new MeshBasicMaterial({ map, transparent: true, opacity, depthWrite: false, toneMapped: false });
  const mesh = new Mesh(new PlaneGeometry(width, height), material);
  mesh.renderOrder = 8;
  mesh.frustumCulled = false;
  parent.add(mesh);
  return mesh;
}

function createEffectPool(
  parent: Group,
  count: number,
  width: number,
  height: number,
  color: string,
  opacity: number,
  renderOrder: number,
  map: CanvasTexture | null = null,
): InstanceEffectPool {
  const mesh = new InstancedMesh(
    new PlaneGeometry(width, height),
    new MeshBasicMaterial({ color, map, transparent: true, opacity, depthWrite: false, toneMapped: false }),
    count,
  );
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = count;
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  const hidden = new Object3D();
  hidden.scale.set(0, 0, 0);
  hidden.updateMatrix();
  for (let index = 0; index < count; index++) mesh.setMatrixAt(index, hidden.matrix);
  parent.add(mesh);
  return {
    mesh,
    age: new Float32Array(count).fill(-1),
    x: new Float32Array(count),
    y: new Float32Array(count),
    rotation: new Float32Array(count),
    cursor: 0,
  };
}

function triggerEffect(pool: InstanceEffectPool, x: number, y: number, rotation = 0): void {
  const index = pool.cursor;
  pool.cursor = (index + 1) % pool.age.length;
  pool.age[index] = 0;
  pool.x[index] = x;
  pool.y[index] = y;
  pool.rotation[index] = rotation;
}

function updateEffectPool(
  pool: InstanceEffectPool,
  transform: Object3D,
  dt: number,
  duration: number,
  rise: number,
  startScale: number,
  endScale: number,
  spin: number,
  z: number,
): void {
  let changed = false;
  for (let index = 0; index < pool.age.length; index++) {
    const age = pool.age[index];
    if (age < 0) continue;
    const nextAge = age + dt;
    if (nextAge >= duration) {
      pool.age[index] = -1;
      transform.position.set(0, 0, 0);
      transform.rotation.z = 0;
      transform.scale.set(0, 0, 0);
      transform.updateMatrix();
      pool.mesh.setMatrixAt(index, transform.matrix);
      changed = true;
      continue;
    }
    pool.age[index] = nextAge;
    const progress = nextAge / duration;
    const scale = startScale + (endScale - startScale) * progress;
    transform.position.set(pool.x[index], pool.y[index] + rise * progress, z);
    transform.rotation.z = pool.rotation[index] + spin * nextAge;
    transform.scale.set(scale, scale, 1);
    transform.updateMatrix();
    pool.mesh.setMatrixAt(index, transform.matrix);
    changed = true;
  }
  if (changed) pool.mesh.instanceMatrix.needsUpdate = true;
}

function newVisual(layout: HazardLayout): HazardVisual {
  const root = new Group();
  root.name = `hazard-${layout.kind}-${layout.slot}`;
  root.position.set(layout.x, 0, 0.0035);
  root.renderOrder = 8;
  const visual: HazardVisual = {
    root,
    textures: [],
    crow: null,
    crowFeathers: null,
    safeGlints: null,
    rainStreaks: null,
    rainStreakX: null,
    rainStreakProgress: null,
    rainStreakHold: null,
    rainStreakStopY: null,
    rainSplashes: null,
    steamPuffs: null,
    boulder: null,
    wind: [],
    waterTexture: null,
  };
  const width = layout.width;
  const art = hazardArt();

  if (layout.kind === 'gap') {
    const gap = addInkSprite(root, createHazardTexture(visual, art.gap), width, 0.035, 0.34);
    gap.position.set(0, layout.floorY - 0.018, 0.001);
  } else if (layout.kind === 'ledge' || layout.kind === 'highLedge') {
    const face = addInkSprite(root, createHazardTexture(visual, art.ledge), width, layout.rise, 0.34);
    face.position.set(0, layout.floorY + layout.rise * 0.5, 0.001);
  } else if (layout.kind === 'river') {
    visual.waterTexture = createHazardTexture(visual, art.river);
    visual.waterTexture.wrapS = RepeatWrapping;
    visual.waterTexture.repeat.x = 1.5;
    const water = addInkSprite(root, visual.waterTexture, width, 0.034, 0.86);
    water.position.set(0, layout.floorY - layout.dip * 0.55, 0);
    water.renderOrder = 9;
  } else if (layout.kind === 'crow') {
    const crowMap = createHazardTexture(visual, art.crowAtlas);
    crowMap.repeat.set(1 / 5, 1);
    visual.crow = addInkSprite(root, crowMap, 0.16, 0.151, 0.96);
    visual.crow.position.set(0, layout.floorY + 0.16, 0.008);
    visual.crow.renderOrder = 9;
    const featherMap = createHazardTexture(visual, art.feather);
    visual.crowFeathers = new InstancedMesh(
      new PlaneGeometry(0.014, 0.027),
      new MeshBasicMaterial({ map: featherMap, transparent: true, opacity: 0.94, depthWrite: false, toneMapped: false }),
      MAX_CROW_FEATHERS,
    );
    visual.crowFeathers.instanceMatrix.setUsage(DynamicDrawUsage);
    visual.crowFeathers.count = 0;
    visual.crowFeathers.renderOrder = 10;
    visual.crowFeathers.frustumCulled = false;
    root.add(visual.crowFeathers);
    visual.safeGlints = createEffectPool(
      root, MAX_SAFE_GLINTS, 0.025, 0.025, '#ffffff', 0.94, 11,
      createHazardTexture(visual, art.safeGlint),
    );
  } else if (layout.kind === 'rain') {
    const cloud = addInkSprite(root, createHazardTexture(visual, art.rainCloud), RAIN_CLOUD_WIDTH, 0.105, 0.92);
    cloud.position.set(0, 0.075, 0.004);
    visual.rainStreaks = new InstancedMesh(
      new PlaneGeometry(0.0022, RAIN_STREAK_LENGTH),
      new MeshBasicMaterial({ color: '#4d6879', transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }),
      MAX_RAIN_STREAKS,
    );
    visual.rainStreaks.instanceMatrix.setUsage(DynamicDrawUsage);
    visual.rainStreaks.count = MAX_RAIN_STREAKS;
    visual.rainStreaks.renderOrder = 10;
    visual.rainStreaks.frustumCulled = false;
    visual.rainStreakX = new Float32Array(MAX_RAIN_STREAKS);
    visual.rainStreakProgress = new Float32Array(MAX_RAIN_STREAKS);
    visual.rainStreakHold = new Float32Array(MAX_RAIN_STREAKS);
    visual.rainStreakStopY = new Float32Array(MAX_RAIN_STREAKS);
    for (let index = 0; index < MAX_RAIN_STREAKS; index++) {
      const row = Math.floor(index / 15);
      const column = index % 15;
      visual.rainStreakX[index] = ((column + 0.5 + (row % 2) * 0.32) / 15 - 0.5) * RAIN_CLOUD_WIDTH;
      visual.rainStreakProgress[index] = (index * 0.61803398875) % 1;
    }
    root.add(visual.rainStreaks);
    visual.rainSplashes = createEffectPool(
      root, MAX_RAIN_SPLASHES, 0.018, 0.0028, '#526b79', 0.88, 11,
    );
    visual.steamPuffs = createEffectPool(
      root, MAX_RAIN_STEAM_PUFFS, 0.046, 0.036, '#ffffff', 0.9, 12,
      createHazardTexture(visual, art.steamPuff),
    );
  } else if (layout.kind === 'thorns') {
    const bramble = addInkSprite(root, createHazardTexture(visual, art.bramble), 0.06, width, 0.84);
    bramble.rotation.z = -Math.PI / 2;
    bramble.position.set(0, layout.floorY + 0.03, 0.002);
  } else if (layout.kind === 'gust') {
    const gustTexture = createHazardTexture(visual, art.gust);
    for (let index = 0; index < 4; index++) {
      const streak = addInkSprite(root, gustTexture, 0.072, 0.036, 0.72);
      streak.position.set(-0.03 + index * 0.018, layout.floorY + 0.025 + index * 0.016, 0.002);
      streak.rotation.z = (index - 1.5) * 0.08;
      visual.wind.push(streak);
    }
  } else if (layout.kind === 'boulder') {
    const boulderMap = createHazardTexture(visual, art.boulderAtlas);
    boulderMap.repeat.set(1 / 3, 1);
    visual.boulder = addInkSprite(root, boulderMap, 0.113, 0.1, 0.9);
    visual.boulder.position.set(width * 0.5 + layout.radius, layout.floorY + layout.radius, 0.006);
    visual.boulder.visible = false;
  }
  return visual;
}

function disposeVisual(visual: HazardVisual): void {
  visual.root.traverse((object) => {
    const mesh = object as Mesh;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) material.dispose();
    } else if (mesh.material) {
      mesh.material.dispose();
    }
  });
  for (const texture of visual.textures) texture.dispose();
  visual.root.clear();
}

function isActive(agent: Kindling): boolean {
  return !agent.carried && (agent.state === 'walking' || agent.state === 'falling');
}

function hasDynamicSolid(field: InkField, x: number, y: number): boolean {
  const index = field.index(x, y);
  return index >= 0 && field.solid[index] !== 0;
}

function hasSolidNear(field: InkField, x: number, y: number, radius: number): boolean {
  const steps = Math.max(1, Math.ceil(radius / field.cell));
  for (let oy = -steps; oy <= steps; oy++) {
    for (let ox = -steps; ox <= steps; ox++) {
      const dx = ox * field.cell, dy = oy * field.cell;
      if (dx * dx + dy * dy > radius * radius) continue;
      if (hasDynamicSolid(field, x + dx, y + dy)) return true;
    }
  }
  return false;
}

function hasFastSoftInkNear(field: InkField, x: number, y: number, radius: number): boolean {
  const steps = Math.max(1, Math.ceil(radius / field.cell));
  for (let offsetY = -steps; offsetY <= steps; offsetY++) {
    for (let offsetX = -steps; offsetX <= steps; offsetX++) {
      const dx = offsetX * field.cell, dy = offsetY * field.cell;
      if (dx * dx + dy * dy > radius * radius) continue;
      const index = field.index(x + dx, y + dy);
      if (index >= 0 && field.soft[index] && Math.hypot(field.vx[index], field.vy[index]) >= 0.8) return true;
    }
  }
  return false;
}

function hasShelterAbove(field: InkField, x: number, y: number): boolean {
  const verticalSteps = Math.ceil(0.08 / field.cell);
  for (let row = 1; row <= verticalSteps; row++) {
    const up = y + row * field.cell;
    for (let column = -1; column <= 1; column++) {
      if (hasDynamicSolid(field, x + column * field.cell, up)) return true;
    }
  }
  return false;
}

function isPalmWall(field: InkField, x: number, y: number): boolean {
  const steps = Math.ceil(0.12 / field.cell);
  const verticalSteps = Math.ceil(0.06 / field.cell);
  for (let column = 1; column <= steps; column++) {
    for (let row = -verticalSteps; row <= verticalSteps; row++) {
      if (hasDynamicSolid(field, x + column * field.cell, y + row * field.cell)) return true;
    }
  }
  return false;
}

function setAsh(folk: FolkWorld, agent: Kindling): void {
  if (agent.state === 'ash' || agent.state === 'home' || agent.state === 'inactive') return;
  agent.state = 'ash';
  folk.ashCount++;
  folk.onEvent?.('ash', agent);
}

function resetAgentAtDoor(folk: FolkWorld, agent: Kindling): void {
  agent.x = folk.spawnX;
  agent.y = folk.spawnY;
  agent.vx = 0;
  agent.vy = 0;
  agent.fallStartY = folk.spawnY;
  agent.state = 'falling';
  agent.age = 0;
}

export class HazardWorld {
  readonly view = new Group();
  readonly stats = createStats();
  readonly layouts: HazardLayout[] = [];
  onEvent?: (event: HazardEvent) => void;
  onHint?: (kind: HazardKind, layout: HazardLayout) => void;
  private readonly hazards: [RuntimeHazard | null, RuntimeHazard | null] = [null, null];
  private readonly visuals: [HazardVisual | null, HazardVisual | null] = [null, null];
  private readonly observedAsh = new Uint8Array(MAX_FOLK);
  private readonly transform = new Object3D();

  constructor(readonly field: InkField, readonly folk: FolkWorld) {
    this.view.name = 'HazardWorld';
  }

  start(level: ScreenLevel): void {
    this.clearVisuals();
    this.hazards[0] = this.hazards[1] = null;
    this.layouts.length = 0;
    this.observedAsh.fill(0);
    resetStats(this.stats);
    const seed = (Math.imul(level.index + 1, 0x9e3779b1) ^ Math.imul(level.kindlings + 7, 0x85ebca6b)) | 0;
    for (let index = 0; index < level.hazards.length; index++) {
      const entry = level.hazards[index];
      const slot = entry.slot;
      let layoutRandom = initialRandom(seed, entry.kind, slot);
      const layoutRng = () => {
        layoutRandom = (Math.imul(layoutRandom, 1664525) + 1013904223) >>> 0;
        return layoutRandom / 0x100000000;
      };
      const randomHazard = makeRuntime(layoutHazard(entry.kind, slot, layoutRng, entry), seed);
      this.hazards[slot] = randomHazard;
      this.layouts.push(randomHazard);
      if (typeof document !== 'undefined') {
        const visual = newVisual(randomHazard);
        this.visuals[slot] = visual;
        this.view.add(visual.root);
      }
    }
  }

  update(dt: number): void {
    const delta = Math.max(0, Math.min(0.1, dt));
    if (delta === 0) return;
    for (let slot = 0; slot < 2; slot++) {
      const hazard = this.hazards[slot];
      if (!hazard) continue;
      hazard.clock += delta;
      switch (hazard.kind) {
        case 'river': this.updateRiver(hazard); break;
        case 'crow': this.updateCrow(hazard, delta); break;
        case 'rain': this.updateRain(hazard, delta); break;
        case 'thorns': this.updateThorns(hazard); break;
        case 'gust': this.updateGust(hazard, delta); break;
        case 'boulder': this.updateBoulder(hazard, delta); break;
        case 'gap':
        case 'ledge':
        case 'highLedge': break;
      }
      const visual = this.visuals[slot];
      if (visual) this.updateVisual(hazard, visual, delta);
    }
    this.observeAsh();
  }

  solve(puppet?: HazardPuppet): HazardSolution[] {
    const solutions: HazardSolution[] = [];
    for (let slot = 0; slot < 2; slot++) {
      const hazard = this.hazards[slot];
      if (!hazard) continue;
      const solution = this.solutionFor(hazard);
      solutions.push(solution);
      puppet?.applyHazardSolution(solution);
    }
    return solutions;
  }

  crowPose(slot: HazardSlot, out: Float32Array): boolean {
    const hazard = this.hazards[slot];
    if (!hazard || hazard.kind !== 'crow' || hazard.crowMode !== 1) return false;
    out[0] = hazard.crowX;
    out[1] = hazard.crowY;
    return true;
  }

  boulderPose(slot: HazardSlot, out: Float32Array): boolean {
    const hazard = this.hazards[slot];
    if (!hazard || hazard.kind !== 'boulder' || !hazard.boulderActive) return false;
    out[0] = hazard.boulderX;
    out[1] = hazard.floorY + hazard.radius;
    return true;
  }

  repelCrow(x: number, radius: number, seconds: number): boolean {
    let repelled = false;
    for (const hazard of this.hazards) {
      if (!hazard || hazard.kind !== 'crow' || Math.abs(hazard.crowX - x) > radius) continue;
      hazard.crowMode = 2;
      hazard.crowTimer = Math.max(hazard.crowTimer, seconds);
      hazard.crowSwatted = true;
      hazard.crowSwatElapsed = 0;
      hazard.crowSwatX = hazard.crowX;
      hazard.crowSwatY = hazard.crowY;
      this.stats.crowSwats++;
      this.onEvent?.({ kind: 'crow-swat', hazard: 'crow', x: hazard.crowX, y: hazard.crowY });
      repelled = true;
    }
    return repelled;
  }

  suspendRain(x: number, radius: number, seconds: number): boolean {
    let found = false;
    for (const hazard of this.hazards) {
      if (!hazard || hazard.kind !== 'rain' || Math.abs(hazard.x - x) > radius) continue;
      hazard.suppressedUntil = Math.max(hazard.suppressedUntil, hazard.clock + seconds);
      hazard.rainActive.fill(0);
      found = true;
    }
    return found;
  }

  disableThorns(x: number, radius: number): boolean {
    let found = false;
    for (const hazard of this.hazards) {
      if (!hazard || hazard.kind !== 'thorns' || hazard.removed || Math.abs(hazard.x - x) > radius) continue;
      hazard.removed = true;
      const left = hazard.x - hazard.width * 0.5;
      const right = hazard.x + hazard.width * 0.5;
      for (let row = 0; row < this.field.h; row++) {
        const y = this.field.y0 + (row + 0.5) * this.field.cell;
        if (y < hazard.floorY || y > hazard.floorY + 0.045) continue;
        for (let column = 0; column < this.field.w; column++) {
          const px = this.field.x0 + (column + 0.5) * this.field.cell;
          if (px >= left - this.field.cell && px <= right + this.field.cell * 2)
            this.field.staticSolid[row * this.field.w + column] = 0;
        }
      }
      const visual = this.visuals[hazard.slot];
      if (visual) visual.root.visible = false;
      found = true;
    }
    return found;
  }

  cancelGust(x: number, radius: number, seconds: number): boolean {
    let found = false;
    for (const hazard of this.hazards) {
      if (!hazard || hazard.kind !== 'gust' || Math.abs(hazard.x - x) > radius) continue;
      hazard.suppressedUntil = Math.max(hazard.suppressedUntil, hazard.clock + seconds);
      found = true;
    }
    return found;
  }

  shieldGust(x: number, radius: number, seconds: number): boolean {
    return this.cancelGust(x, radius, seconds);
  }

  shatterBoulder(x: number, radius: number): boolean {
    let found = false;
    for (const hazard of this.hazards) {
      if (!hazard || hazard.kind !== 'boulder' || !hazard.boulderActive || Math.abs(hazard.boulderX - x) > radius) continue;
      hazard.boulderActive = false;
      hazard.boulderNext = 8;
      this.stats.bouldersCrumbled++;
      this.onEvent?.({ kind: 'boulder-crumble', hazard: 'boulder', x: hazard.boulderX, y: hazard.floorY + hazard.radius });
      found = true;
    }
    return found;
  }

  dispose(): void {
    this.clearVisuals();
    this.hazards[0] = this.hazards[1] = null;
    this.layouts.length = 0;
  }

  private clearVisuals(): void {
    for (let slot = 0; slot < 2; slot++) {
      const visual = this.visuals[slot];
      if (visual) disposeVisual(visual);
      this.visuals[slot] = null;
    }
    this.view.clear();
  }

  private updateRiver(hazard: RuntimeHazard): void {
    const left = hazard.x - hazard.width * 0.5;
    const right = hazard.x + hazard.width * 0.5;
    const waterY = hazard.floorY - hazard.dip * 0.55;
    for (let index = 0; index < this.folk.count; index++) {
      const agent = this.folk.agents[index];
      if (!isActive(agent) || agent.x < left || agent.x > right || agent.y > waterY + STEP_RADIUS) continue;
      setAsh(this.folk, agent);
      this.stats.riverDouses++;
      this.onEvent?.({ kind: 'river-douse', hazard: hazard.kind, x: agent.x, y: agent.y, agent });
    }
  }

  private triggerSafeGlint(hazard: RuntimeHazard, agent: Kindling): void {
    if (hazard.crowSafeGlintShown) return;
    hazard.crowSafeGlintShown = true;
    const visual = this.visuals[hazard.slot];
    if (visual?.safeGlints) triggerEffect(visual.safeGlints, agent.x - hazard.x, agent.y + 0.022);
  }

  private glintShelteredWalkerNear(hazard: RuntimeHazard, x: number, y: number, radius: number): void {
    if (hazard.crowSafeGlintShown) return;
    const radiusSquared = radius * radius;
    for (let index = 0; index < this.folk.count; index++) {
      const agent = this.folk.agents[index];
      if (!isActive(agent) || !hasShelterAbove(this.field, agent.x, agent.y)) continue;
      const dx = agent.x - x, dy = agent.y - y;
      if (dx * dx + dy * dy > radiusSquared) continue;
      this.triggerSafeGlint(hazard, agent);
      return;
    }
  }

  private updateCrow(hazard: RuntimeHazard, dt: number): void {
    if (hazard.crowMode === 2) {
      if (hazard.crowSwatted) hazard.crowSwatElapsed += dt;
      hazard.crowTimer -= dt;
      if (hazard.crowTimer <= 0) {
        hazard.crowMode = 0;
        hazard.crowTimer = 0;
        hazard.crowSwatted = false;
        hazard.crowSafeGlintShown = false;
        hazard.crowX = hazard.x;
        hazard.crowY = hazard.floorY + 0.16;
      }
      return;
    }
    if (hazard.crowMode === 0) {
      hazard.crowTimer -= dt;
      if (hazard.crowTimer > 0) return;
      let nearest: Kindling | null = null;
      let nearestDistance = Infinity;
      for (let index = 0; index < this.folk.count; index++) {
        const agent = this.folk.agents[index];
        if (!isActive(agent)) continue;
        const distance = Math.abs(agent.x - hazard.x);
        if (distance < nearestDistance) { nearest = agent; nearestDistance = distance; }
      }
      if (!nearest) {
        hazard.crowTimer = 1;
        return;
      }
      hazard.crowMode = 1;
      hazard.crowProgress = 0;
      hazard.crowSafeGlintShown = false;
      hazard.crowStartX = hazard.x;
      hazard.crowStartY = hazard.floorY + 0.16;
      hazard.crowTargetX = nearest.x;
      hazard.crowTargetY = nearest.y + 0.015;
      hazard.crowControlX = (hazard.crowStartX + hazard.crowTargetX) * 0.5;
      hazard.crowControlY = Math.min(hazard.crowStartY, hazard.crowTargetY) - 0.04;
      return;
    }

    hazard.crowProgress = Math.min(1, hazard.crowProgress + dt / 0.9);
    const t = hazard.crowProgress, inverse = 1 - t;
    hazard.crowX = inverse * inverse * hazard.crowStartX
      + 2 * inverse * t * hazard.crowControlX + t * t * hazard.crowTargetX;
    hazard.crowY = inverse * inverse * hazard.crowStartY
      + 2 * inverse * t * hazard.crowControlY + t * t * hazard.crowTargetY;
    if (hasSolidNear(this.field, hazard.crowX, hazard.crowY, 0.014)
      || hasFastSoftInkNear(this.field, hazard.crowX, hazard.crowY, 0.014)) {
      this.glintShelteredWalkerNear(hazard, hazard.crowX, hazard.crowY, 0.18);
      hazard.crowMode = 2;
      hazard.crowTimer = 8;
      hazard.crowSwatted = true;
      hazard.crowSwatElapsed = 0;
      hazard.crowSwatX = hazard.crowX;
      hazard.crowSwatY = hazard.crowY;
      this.stats.crowSwats++;
      this.onEvent?.({ kind: 'crow-swat', hazard: hazard.kind, x: hazard.crowX, y: hazard.crowY });
      return;
    }
    for (let index = 0; index < this.folk.count; index++) {
      const agent = this.folk.agents[index];
      if (!isActive(agent)) continue;
      const dx = agent.x - hazard.crowX, dy = agent.y - hazard.crowY;
      if (dx * dx + dy * dy > 0.00042) continue;
      if (hasShelterAbove(this.field, agent.x, agent.y)) {
        this.triggerSafeGlint(hazard, agent);
        continue;
      }
      resetAgentAtDoor(this.folk, agent);
      hazard.crowMode = 2;
      hazard.crowTimer = 1.5;
      hazard.crowSwatted = false;
      this.stats.crowGrabs++;
      this.onEvent?.({ kind: 'crow-grab', hazard: hazard.kind, x: agent.x, y: agent.y, agent });
      return;
    }
    if (hazard.crowProgress >= 1) {
      hazard.crowMode = 0;
      hazard.crowTimer = 6 + nextRandom(hazard) * 3;
      hazard.crowSafeGlintShown = false;
    }
  }

  private updateRain(hazard: RuntimeHazard, dt: number): void {
    if (hazard.clock < hazard.suppressedUntil) return;
    hazard.rainAccumulator += dt * 30;
    while (hazard.rainAccumulator >= 1) {
      hazard.rainAccumulator -= 1;
      let chosen = -1;
      for (let offset = 0; offset < MAX_RAINDROPS; offset++) {
        const index = (hazard.rainCursor + offset) % MAX_RAINDROPS;
        if (hazard.rainActive[index] === 0) { chosen = index; break; }
      }
      if (chosen < 0) continue;
      hazard.rainCursor = (chosen + 1) % MAX_RAINDROPS;
      hazard.rainActive[chosen] = 1;
      hazard.rainX[chosen] = hazard.x + (nextRandom(hazard) - 0.5) * hazard.width;
      hazard.rainY[chosen] = 0.082;
      this.stats.rainDropsSpawned++;
    }

    for (let drop = 0; drop < MAX_RAINDROPS; drop++) {
      if (hazard.rainActive[drop] === 0) continue;
      hazard.rainY[drop] -= 0.6 * dt;
      const x = hazard.rainX[drop], y = hazard.rainY[drop];
      const fieldIndex = this.field.index(x, y);
      if (fieldIndex >= 0 && (this.field.solid[fieldIndex] || this.field.soft[fieldIndex])) {
        hazard.rainActive[drop] = 0;
        this.stats.rainDropsSheltered++;
        const visual = this.visuals[hazard.slot];
        if (visual?.rainSplashes) triggerEffect(visual.rainSplashes, x - hazard.x, y, -0.45);
        continue;
      }
      let hit = false;
      for (let index = 0; index < this.folk.count; index++) {
        const agent = this.folk.agents[index];
        if (!isActive(agent)) continue;
        const dx = agent.x - x, dy = agent.y - y;
        if (dx * dx + dy * dy > 0.00036) continue;
        setAsh(this.folk, agent);
        this.stats.rainDropsHit++;
        const visual = this.visuals[hazard.slot];
        if (visual?.steamPuffs) triggerEffect(visual.steamPuffs, agent.x - hazard.x, agent.y + 0.006);
        this.onEvent?.({ kind: 'rain-hit', hazard: hazard.kind, x, y, agent });
        hit = true;
        break;
      }
      if (hit) { hazard.rainActive[drop] = 0; continue; }
      if (y <= hazard.floorY - 0.005 || fieldIndex < 0) {
        hazard.rainActive[drop] = 0;
        this.stats.rainDropsGrounded++;
        const visual = this.visuals[hazard.slot];
        if (visual?.rainSplashes) triggerEffect(visual.rainSplashes, x - hazard.x, hazard.floorY, 0);
      }
    }
  }

  private updateThorns(hazard: RuntimeHazard): void {
    if (hazard.removed) return;
    const left = hazard.x - hazard.width * 0.5 - STEP_RADIUS;
    const right = hazard.x + hazard.width * 0.5 + STEP_RADIUS;
    for (let index = 0; index < this.folk.count; index++) {
      const agent = this.folk.agents[index];
      if (agent.state !== 'walking' || agent.x < left || agent.x > right) continue;
      const movingToward = agent.heading > 0 ? agent.x < hazard.x : agent.x > hazard.x;
      if (!movingToward) continue;
      agent.heading = agent.heading > 0 ? -1 : 1;
      agent.x += agent.heading * 0.004;
      this.stats.thornTurns++;
      this.onEvent?.({ kind: 'thorn-turn', hazard: hazard.kind, x: agent.x, y: agent.y, agent });
    }
  }

  private updateGust(hazard: RuntimeHazard, dt: number): void {
    if (hazard.clock < hazard.suppressedUntil) return;
    const phase = hazard.clock % 5;
    if (phase >= 2) return;
    const left = hazard.x - hazard.width * 0.5;
    const right = hazard.x + hazard.width * 0.5;
    for (let index = 0; index < this.folk.count; index++) {
      const agent = this.folk.agents[index];
      if (agent.state !== 'walking' || agent.x < left || agent.x > right
        || Math.abs(agent.y - hazard.floorY) > 0.08) continue;
      if (isPalmWall(this.field, agent.x, agent.y)) {
        hazard.gustSheltered += dt;
        this.stats.gustShelteredAgentSeconds += dt;
      } else {
        hazard.gustExposed += dt;
        this.stats.gustExposedAgentSeconds += dt;
        agent.x -= 0.25 * dt;
      }
    }
  }

  private updateBoulder(hazard: RuntimeHazard, dt: number): void {
    if (!hazard.boulderActive) {
      hazard.boulderNext -= dt;
      if (hazard.boulderNext > 0) return;
      hazard.boulderActive = true;
      hazard.boulderX = this.folk.doorX + this.folk.doorW * 0.5 + hazard.radius;
      hazard.boulderBlockedFor = 0;
      hazard.boulderWasBlocked = false;
      hazard.boulderNext += 8;
    }
    const nextX = hazard.boulderX - 0.25 * dt;
    const boulderY = hazard.floorY + hazard.radius;
    if (hasSolidNear(this.field, nextX, boulderY, hazard.radius)) {
      hazard.boulderBlockedFor += dt;
      if (!hazard.boulderWasBlocked) {
        hazard.boulderWasBlocked = true;
        this.stats.bouldersBlocked++;
      }
      if (hazard.boulderBlockedFor >= 1) {
        hazard.boulderActive = false;
        hazard.boulderNext = 8;
        this.stats.bouldersCrumbled++;
        this.onEvent?.({ kind: 'boulder-crumble', hazard: hazard.kind, x: hazard.boulderX, y: boulderY });
      }
      return;
    }
    hazard.boulderBlockedFor = 0;
    hazard.boulderWasBlocked = false;
    hazard.boulderX = nextX;
    for (let index = 0; index < this.folk.count; index++) {
      const agent = this.folk.agents[index];
      if (!isActive(agent)) continue;
      const dx = agent.x - hazard.boulderX, dy = agent.y - boulderY;
      const reach = hazard.radius + STEP_RADIUS;
      if (dx * dx + dy * dy > reach * reach) continue;
      setAsh(this.folk, agent);
      this.stats.boulderHits++;
      this.onEvent?.({ kind: 'boulder-hit', hazard: hazard.kind, x: hazard.boulderX, y: boulderY, agent });
    }
    if (hazard.boulderX < this.folk.spawnX - hazard.radius) {
      hazard.boulderActive = false;
      hazard.boulderNext = 8;
    }
  }

  private updateVisual(hazard: RuntimeHazard, visual: HazardVisual, _dt: number): void {
    if (visual.waterTexture) visual.waterTexture.offset.x = (hazard.clock * 0.18) % 1;
    if (visual.crow) this.updateCrowVisual(hazard, visual);
    if (visual.rainStreaks) this.updateRainVisual(hazard, visual, _dt);
    if (visual.rainSplashes) {
      updateEffectPool(visual.rainSplashes, this.transform, _dt, RAIN_SPLASH_LIFETIME, 0.001, 0.62, 0, 0, 0.011);
    }
    if (visual.steamPuffs) {
      updateEffectPool(visual.steamPuffs, this.transform, _dt, RAIN_STEAM_LIFETIME, 0.026, 0.32, 1.28, 0.4, 0.012);
    }
    if (visual.safeGlints) {
      updateEffectPool(visual.safeGlints, this.transform, _dt, SAFE_GLINT_LIFETIME, 0.006, 0.9, 0, 7, 0.012);
    }
    for (let index = 0; index < visual.wind.length; index++) {
      const streak = visual.wind[index];
      const active = hazard.clock % 5 < 2;
      streak.visible = active;
      streak.position.x = -0.035 + ((hazard.clock * 0.11 + index * 0.04) % Math.max(0.04, hazard.width)) - hazard.width * 0.5;
    }
    if (visual.boulder) {
      visual.boulder.visible = hazard.boulderActive;
      visual.boulder.position.x = hazard.boulderX - hazard.x;
      visual.boulder.position.y = hazard.floorY + hazard.radius;
      const frame = Math.floor(hazard.clock * 8) % 3;
      visual.boulder.material.map!.offset.x = frame / 3;
    }
  }

  private updateCrowVisual(hazard: RuntimeHazard, visual: HazardVisual): void {
    const crow = visual.crow!;
    if (hazard.crowMode === 1) {
      crow.visible = true;
      crow.position.set(hazard.crowX - hazard.x, hazard.crowY, 0.008);
      crow.material.map!.offset.x = (1 + Math.floor(hazard.clock * 12) % 4) / 5;
      crow.rotation.z = 0;
      crow.scale.x = hazard.crowTargetX < hazard.crowStartX ? -1 : 1;
    } else if (hazard.crowMode === 2 && hazard.crowSwatted) {
      const elapsed = hazard.crowSwatElapsed;
      const exitEnd = CROW_TUMBLE_DURATION + CROW_EXIT_DURATION;
      crow.visible = elapsed < exitEnd;
      crow.material.map!.offset.x = 0;
      crow.scale.x = hazard.crowTargetX < hazard.crowStartX ? -1 : 1;
      if (elapsed < CROW_TUMBLE_DURATION) {
        const progress = elapsed / CROW_TUMBLE_DURATION;
        crow.position.set(
          hazard.crowSwatX - hazard.x + Math.sin(progress * Math.PI * 4) * 0.008,
          hazard.crowSwatY + Math.sin(progress * Math.PI * 3) * 0.012,
          0.008,
        );
        crow.rotation.z = progress * Math.PI * 6;
      } else {
        const progress = Math.min(1, (elapsed - CROW_TUMBLE_DURATION) / CROW_EXIT_DURATION);
        crow.position.set(hazard.crowSwatX - hazard.x, hazard.crowSwatY + progress * 0.62, 0.008);
        crow.rotation.z = (1 - progress) * Math.PI * 6;
      }
    } else {
      crow.visible = hazard.crowMode !== 2;
      crow.position.set(hazard.crowX - hazard.x, hazard.crowY, 0.008);
      crow.material.map!.offset.x = 0;
      crow.rotation.z = 0;
      crow.scale.x = 1;
    }

    const feathers = visual.crowFeathers;
    if (!feathers) return;
    const age = hazard.crowSwatElapsed;
    if (!hazard.crowSwatted || age >= 0.72) {
      feathers.count = 0;
      return;
    }
    feathers.count = MAX_CROW_FEATHERS;
    for (let index = 0; index < MAX_CROW_FEATHERS; index++) {
      const featherAge = Math.min(age, 0.72);
      const x = hazard.crowSwatX - hazard.x + FEATHER_VELOCITY_X[index] * featherAge;
      const y = hazard.crowSwatY + FEATHER_VELOCITY_Y[index] * featherAge - 0.175 * featherAge * featherAge;
      const scale = 1 - featherAge / 0.9;
      this.transform.position.set(x, y, 0.009);
      this.transform.rotation.z = FEATHER_ROTATION[index] + FEATHER_SPIN[index] * featherAge;
      this.transform.scale.set(scale, scale, 1);
      this.transform.updateMatrix();
      feathers.setMatrixAt(index, this.transform.matrix);
    }
    feathers.instanceMatrix.needsUpdate = true;
  }

  private updateRainVisual(hazard: RuntimeHazard, visual: HazardVisual, dt: number): void {
    if (hazard.clock < hazard.suppressedUntil) {
      visual.root.position.y = Math.min(0.18, (hazard.suppressedUntil - hazard.clock) * 0.08);
      if (visual.rainStreaks) visual.rainStreaks.visible = false;
      return;
    }
    visual.root.position.y = 0;
    if (visual.rainStreaks) visual.rainStreaks.visible = true;
    const streaks = visual.rainStreaks!;
    const streakX = visual.rainStreakX!;
    const progress = visual.rainStreakProgress!;
    const hold = visual.rainStreakHold!;
    const stopY = visual.rainStreakStopY!;
    const halfLength = RAIN_STREAK_LENGTH * 0.5;
    const travel = RAIN_STREAK_TOP - (hazard.floorY + halfLength);
    const progressStep = RAIN_STREAK_SPEED * dt / travel;

    for (let index = 0; index < MAX_RAIN_STREAKS; index++) {
      let centerY = RAIN_STREAK_TOP;
      if (hold[index] > 0) {
        hold[index] -= dt;
        if (hold[index] > 0) {
          centerY = stopY[index] + halfLength;
        } else {
          hold[index] = 0;
          progress[index] = 0;
        }
      } else {
        progress[index] += progressStep;
        if (progress[index] >= 1) {
          progress[index] = 1;
          hold[index] = RAIN_STREAK_HOLD;
          stopY[index] = hazard.floorY;
          centerY = stopY[index] + halfLength;
          if (visual.rainSplashes) triggerEffect(visual.rainSplashes, streakX[index], hazard.floorY);
        } else {
          centerY = RAIN_STREAK_TOP - progress[index] * travel;
          const impactY = centerY - halfLength;
          const worldX = hazard.x + streakX[index];
          if (impactY <= hazard.floorY) {
            hold[index] = RAIN_STREAK_HOLD;
            stopY[index] = hazard.floorY;
            centerY = stopY[index] + halfLength;
            if (visual.rainSplashes) triggerEffect(visual.rainSplashes, streakX[index], hazard.floorY);
          } else {
            const fieldIndex = this.field.index(worldX, impactY);
            if (fieldIndex >= 0 && (this.field.solid[fieldIndex] || this.field.soft[fieldIndex])) {
              const contactY = impactY + this.field.cell * 0.5;
              hold[index] = RAIN_STREAK_HOLD;
              stopY[index] = contactY;
              centerY = contactY + halfLength;
              if (visual.rainSplashes) triggerEffect(visual.rainSplashes, streakX[index], contactY, -0.45);
            }
          }
        }
      }
      this.transform.position.set(streakX[index], centerY, 0.006);
      this.transform.rotation.z = -0.12;
      this.transform.scale.set(1, 1, 1);
      this.transform.updateMatrix();
      streaks.setMatrixAt(index, this.transform.matrix);
    }
    streaks.instanceMatrix.needsUpdate = true;
  }

  private observeAsh(): void {
    for (let index = 0; index < this.folk.count && index < MAX_FOLK; index++) {
      const agent = this.folk.agents[index];
      if (agent.state !== 'ash' || this.observedAsh[index]) continue;
      this.observedAsh[index] = 1;
      const hazard = this.closestFailureHazard(agent.x);
      if (!hazard) continue;
      this.stats.ashByHazard[hazard.kind]++;
      hazard.casualties++;
      if (hazard.casualties >= 2 && !hazard.hinted) {
        hazard.hinted = true;
        this.onHint?.(hazard.kind, hazard);
      }
    }
  }

  private closestFailureHazard(x: number): RuntimeHazard | null {
    let closest: RuntimeHazard | null = null;
    let distance = Infinity;
    for (let slot = 0; slot < 2; slot++) {
      const hazard = this.hazards[slot];
      if (!hazard || (hazard.kind !== 'gap' && hazard.kind !== 'river' && hazard.kind !== 'rain' && hazard.kind !== 'boulder')) continue;
      const current = Math.abs(x - (hazard.kind === 'boulder' ? hazard.boulderX : hazard.x));
      const reach = hazard.kind === 'boulder' ? hazard.radius + 0.04 : hazard.width * 0.5 + 0.04;
      if (current > reach || current >= distance) continue;
      distance = current;
      closest = hazard;
    }
    return closest;
  }

  private solutionFor(hazard: RuntimeHazard): HazardSolution {
    const floor = hazard.floorY + 0.009;
    switch (hazard.kind) {
      case 'gap':
      case 'river':
      case 'thorns':
        return {
          kind: hazard.kind, slot: hazard.slot, action: 'bridge',
          hands: [{ x: hazard.x, y: floor, width: hazard.width + 0.045, height: 0.022, angle: 0, scale: 1, soft: false }],
        };
      case 'ledge':
      case 'highLedge': {
        const steps = hazard.kind === 'highLedge' ? 2 : 1;
        const hands: HazardHandPose[] = [];
        for (let step = 0; step < steps; step++) {
          const fraction = (step + 0.5) / steps;
          hands.push({
            x: steps === 1 ? hazard.x : hazard.x - hazard.width * 0.5 + hazard.width * fraction,
            y: hazard.floorY + hazard.rise * fraction,
            width: steps === 1 ? hazard.width + 0.035 : hazard.width / steps + 0.025,
            height: 0.022,
            angle: Math.atan2(hazard.rise, hazard.width),
            scale: 1,
            soft: false,
          });
        }
        return {
          kind: hazard.kind, slot: hazard.slot, action: 'ramp', hands,
          ...(hazard.kind === 'highLedge' ? { flick: { x: hazard.x, y: hazard.floorY + hazard.rise, direction: 1 as const } } : {}),
        };
      }
      case 'crow':
        return {
          kind: hazard.kind, slot: hazard.slot, action: 'swat',
          hands: [{ x: hazard.crowX, y: hazard.crowY, width: hazard.wingspan, height: 0.045, angle: -0.2, scale: 1, soft: false }],
          flick: { x: hazard.crowX, y: hazard.crowY, direction: hazard.crowX < hazard.x ? 1 : -1 },
        };
      case 'rain':
        return {
          kind: hazard.kind, slot: hazard.slot, action: 'umbrella',
          hands: [{ x: hazard.x, y: 0.025, width: hazard.width, height: 0.05, angle: 0, scale: 1.45, soft: true }],
        };
      case 'gust':
        return {
          kind: hazard.kind, slot: hazard.slot, action: 'palm-wall',
          hands: [{ x: hazard.x + 0.055, y: hazard.floorY + 0.015, width: 0.035, height: 0.12, angle: Math.PI / 2, scale: 1, soft: false }],
        };
      case 'boulder':
        return {
          kind: hazard.kind, slot: hazard.slot, action: 'block',
          hands: [{ x: hazard.boulderActive ? hazard.boulderX : hazard.x, y: hazard.floorY + hazard.radius, width: 0.075, height: 0.075, angle: 0, scale: 1, soft: false }],
        };
    }
  }
}

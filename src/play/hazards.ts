import {
  BoxGeometry, ConeGeometry, DataTexture, DynamicDrawUsage, Group, InstancedMesh, LinearFilter,
  Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, RGBAFormat, RepeatWrapping, SphereGeometry,
  UnsignedByteType,
} from '@iwsdk/core';
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

interface HazardVisual {
  root: Group;
  crow: Group | null;
  crowWings: [Mesh, Mesh] | null;
  drops: InstancedMesh | null;
  boulder: Mesh | null;
  wind: Mesh[];
  waterTexture: DataTexture | null;
}

interface PlacementOverride {
  x?: number;
  width?: number;
}

const FLOOR_Y = -0.20;
const MAX_RAINDROPS = 32;
const MAX_FOLK = 48;
const STEP_RADIUS = 0.011;
const DEFAULT_X: readonly [number, number] = [-0.17, 0.16];

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

function addMesh(
  parent: Group,
  geometry: BoxGeometry | ConeGeometry | PlaneGeometry | SphereGeometry,
  color: string,
  options: { transparent?: boolean; opacity?: number } = {},
): Mesh {
  const material = new MeshBasicMaterial({
    color,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    depthWrite: options.transparent ? false : true,
    toneMapped: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 8;
  mesh.frustumCulled = false;
  parent.add(mesh);
  return mesh;
}

function rippleTexture(): DataTexture {
  const width = 32, height = 16;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const stripe = Math.sin((x / width) * Math.PI * 4 + Math.sin((y / height) * Math.PI * 2) * 0.8);
      data[offset] = 226;
      data[offset + 1] = 244;
      data[offset + 2] = 238;
      data[offset + 3] = stripe > 0.72 ? 190 : 20;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function newVisual(layout: HazardLayout): HazardVisual {
  const root = new Group();
  root.name = `hazard-${layout.kind}-${layout.slot}`;
  root.position.set(layout.x, 0, 0.0035);
  root.renderOrder = 8;
  const visual: HazardVisual = { root, crow: null, crowWings: null, drops: null, boulder: null, wind: [], waterTexture: null };
  const width = layout.width;

  if (layout.kind === 'gap') {
    const gapShade = addMesh(root, new PlaneGeometry(1, 1), '#241b1a');
    gapShade.position.set(0, layout.floorY - 0.018, 0);
    gapShade.scale.set(width, 0.035, 1);
  } else if (layout.kind === 'ledge' || layout.kind === 'highLedge') {
    const block = addMesh(root, new BoxGeometry(1, 1, 0.003), '#543827');
    block.position.set(0, layout.floorY + layout.rise * 0.5, 0);
    block.scale.set(width, layout.rise, 1);
    const top = addMesh(root, new PlaneGeometry(1, 1), '#8a6040');
    top.position.set(0, layout.floorY + layout.rise, 0.001);
    top.scale.set(width, 0.007, 1);
  } else if (layout.kind === 'river') {
    visual.waterTexture = rippleTexture();
    const water = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      color: '#548da0', map: visual.waterTexture, transparent: true, opacity: 0.86, depthWrite: false,
      toneMapped: false,
    }));
    water.position.set(0, layout.floorY - layout.dip * 0.55, 0);
    water.scale.set(width, 0.028, 1);
    water.renderOrder = 9;
    root.add(water);
  } else if (layout.kind === 'crow') {
    const crow = new Group();
    crow.position.set(0, layout.floorY + 0.16, 0.008);
    visual.crow = crow;
    const body = addMesh(crow, new SphereGeometry(1, 10, 7), '#282329');
    body.scale.set(0.016, 0.009, 0.004);
    const head = addMesh(crow, new SphereGeometry(1, 8, 6), '#282329');
    head.position.set(0.012, 0.006, 0);
    head.scale.set(0.007, 0.007, 0.004);
    const beak = addMesh(crow, new ConeGeometry(0.004, 0.009, 3), '#b88746');
    beak.position.set(0.02, 0.004, 0);
    beak.rotation.z = -Math.PI / 2;
    const leftWing = addMesh(crow, new PlaneGeometry(0.023, 0.009), '#211d22');
    leftWing.position.set(-0.002, 0.001, -0.001);
    const rightWing = addMesh(crow, new PlaneGeometry(0.023, 0.009), '#211d22');
    rightWing.position.set(-0.002, 0.001, 0.001);
    visual.crowWings = [leftWing, rightWing];
    root.add(crow);
  } else if (layout.kind === 'rain') {
    const cloud = addMesh(root, new SphereGeometry(1, 10, 7), '#77706c');
    cloud.position.set(0, 0.075, 0.004);
    cloud.scale.set(width * 0.31, 0.018, 0.006);
    for (const offset of [-0.055, 0, 0.055]) {
      const puff = addMesh(root, new SphereGeometry(1, 8, 6), '#89817a');
      puff.position.set(offset, 0.085, 0.004);
      puff.scale.set(0.043, 0.017, 0.005);
    }
    const dropGeometry = new PlaneGeometry(0.0022, 0.017);
    const dropMaterial = new MeshBasicMaterial({ color: '#c4e1e8', transparent: true, opacity: 0.82, depthWrite: false });
    visual.drops = new InstancedMesh(dropGeometry, dropMaterial, MAX_RAINDROPS);
    visual.drops.instanceMatrix.setUsage(DynamicDrawUsage);
    visual.drops.count = 0;
    visual.drops.renderOrder = 10;
    visual.drops.frustumCulled = false;
    root.add(visual.drops);
  } else if (layout.kind === 'thorns') {
    const ground = addMesh(root, new PlaneGeometry(1, 1), '#443124');
    ground.position.set(0, layout.floorY + 0.004, 0);
    ground.scale.set(width, 0.009, 1);
    for (const offset of [-width * 0.32, 0, width * 0.32]) {
      const thorn = addMesh(root, new ConeGeometry(0.009, 0.033, 3), '#463123');
      thorn.position.set(offset, layout.floorY + 0.025, 0.001);
    }
  } else if (layout.kind === 'gust') {
    for (let index = 0; index < 3; index++) {
      const streak = addMesh(root, new PlaneGeometry(0.055, 0.0025), '#d6c4a5', { transparent: true, opacity: 0.5 });
      streak.position.set(-0.025 + index * 0.018, layout.floorY + 0.025 + index * 0.018, 0.001);
      visual.wind.push(streak);
    }
  } else if (layout.kind === 'boulder') {
    visual.boulder = addMesh(root, new SphereGeometry(1, 12, 9), '#665345');
    visual.boulder.scale.setScalar(layout.radius);
    visual.boulder.position.set(width * 0.5 + layout.radius, layout.floorY + layout.radius, 0.006);
    visual.boulder.visible = false;
    const mark = addMesh(root, new SphereGeometry(1, 7, 5), '#826b56');
    mark.scale.set(0.012, 0.005, 0.002);
    mark.position.set(width * 0.5 + layout.radius, layout.floorY + layout.radius + 0.006, 0.007);
    mark.visible = false;
  }
  return visual;
}

function disposeVisual(root: Group): void {
  root.traverse((object) => {
    const mesh = object as Mesh;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) {
        if (material instanceof MeshBasicMaterial) material.map?.dispose();
        material.dispose();
      }
    } else if (mesh.material) {
      if (mesh.material instanceof MeshBasicMaterial) mesh.material.map?.dispose();
      mesh.material.dispose();
    }
  });
  root.clear();
}

function isActive(agent: Kindling): boolean {
  return agent.state === 'walking' || agent.state === 'falling';
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
      const visual = newVisual(randomHazard);
      this.visuals[slot] = visual;
      this.view.add(visual.root);
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
      this.updateVisual(hazard, this.visuals[slot]!, delta);
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

  dispose(): void {
    this.clearVisuals();
    this.hazards[0] = this.hazards[1] = null;
    this.layouts.length = 0;
  }

  private clearVisuals(): void {
    for (let slot = 0; slot < 2; slot++) {
      const visual = this.visuals[slot];
      if (visual) disposeVisual(visual.root);
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

  private updateCrow(hazard: RuntimeHazard, dt: number): void {
    if (hazard.crowMode === 2) {
      hazard.crowTimer -= dt;
      if (hazard.crowTimer <= 0) {
        hazard.crowMode = 0;
        hazard.crowTimer = 0;
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
    if (hasSolidNear(this.field, hazard.crowX, hazard.crowY, 0.014)) {
      hazard.crowMode = 2;
      hazard.crowTimer = 8;
      this.stats.crowSwats++;
      this.onEvent?.({ kind: 'crow-swat', hazard: hazard.kind, x: hazard.crowX, y: hazard.crowY });
      return;
    }
    for (let index = 0; index < this.folk.count; index++) {
      const agent = this.folk.agents[index];
      if (!isActive(agent) || hasShelterAbove(this.field, agent.x, agent.y)) continue;
      const dx = agent.x - hazard.crowX, dy = agent.y - hazard.crowY;
      if (dx * dx + dy * dy > 0.00042) continue;
      resetAgentAtDoor(this.folk, agent);
      hazard.crowMode = 2;
      hazard.crowTimer = 1.5;
      this.stats.crowGrabs++;
      this.onEvent?.({ kind: 'crow-grab', hazard: hazard.kind, x: agent.x, y: agent.y, agent });
      return;
    }
    if (hazard.crowProgress >= 1) {
      hazard.crowMode = 0;
      hazard.crowTimer = 6 + nextRandom(hazard) * 3;
    }
  }

  private updateRain(hazard: RuntimeHazard, dt: number): void {
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
        this.onEvent?.({ kind: 'rain-hit', hazard: hazard.kind, x, y, agent });
        hit = true;
        break;
      }
      if (hit) { hazard.rainActive[drop] = 0; continue; }
      if (y <= hazard.floorY - 0.005 || fieldIndex < 0) {
        hazard.rainActive[drop] = 0;
        this.stats.rainDropsGrounded++;
      }
    }
  }

  private updateThorns(hazard: RuntimeHazard): void {
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
      hazard.boulderX = hazard.x + hazard.width * 0.5 + hazard.radius;
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
    if (hazard.boulderX < hazard.x - hazard.width * 0.5 - hazard.radius) {
      hazard.boulderActive = false;
      hazard.boulderNext = 8;
    }
  }

  private updateVisual(hazard: RuntimeHazard, visual: HazardVisual, _dt: number): void {
    if (visual.waterTexture) visual.waterTexture.offset.x = (hazard.clock * 0.18) % 1;
    if (visual.crow) {
      visual.crow.visible = hazard.crowMode !== 2;
      visual.crow.position.set(hazard.crowX - hazard.x, hazard.crowY, 0.008);
      if (visual.crowWings) {
        const flap = hazard.crowMode === 1 ? Math.sin(hazard.clock * 24) * 0.55 : 0.08;
        visual.crowWings[0].rotation.z = flap;
        visual.crowWings[1].rotation.z = -flap;
      }
    }
    if (visual.drops) {
      let visible = 0;
      for (let index = 0; index < MAX_RAINDROPS; index++) {
        if (hazard.rainActive[index] === 0) continue;
        this.transform.position.set(hazard.rainX[index] - hazard.x, hazard.rainY[index], 0.006);
        this.transform.rotation.z = -0.12;
        this.transform.scale.set(1, 1, 1);
        this.transform.updateMatrix();
        visual.drops.setMatrixAt(visible++, this.transform.matrix);
      }
      visual.drops.count = visible;
      visual.drops.instanceMatrix.needsUpdate = visible > 0;
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
      visual.boulder.rotation.z = -hazard.clock * 6;
    }
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
      const current = Math.abs(x - hazard.x);
      if (current > hazard.width * 0.5 + 0.04 || current >= distance) continue;
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

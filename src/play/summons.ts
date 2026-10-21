import { AdditiveBlending, CanvasTexture, Group, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';
import type { Stencil } from '../theater/painter.js';
import { FolkWorld, type Kindling } from './folk.js';
import { HazardWorld } from './hazards.js';
import { InkField } from './ink-field.js';
import type { HazardKind, ScreenLevel } from './levels.js';
import type { SummonAgent, SummonContext, SummonKind } from './summon-contract.js';
import { updateGiftA } from './summon-gifts-a.js';
import { updateGiftB } from './summon-gifts-b.js';
import { updateGiftC } from './summon-gifts-c.js';

const MAX_SUMMONS = 2;
const LIFE = 8;
const COOLDOWN = 12;
const EXIT = 0.8;

interface SummonSprite {
  ink: Mesh<PlaneGeometry, MeshBasicMaterial>;
  glow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  eye: Mesh<PlaneGeometry, MeshBasicMaterial>;
  slime: Mesh<PlaneGeometry, MeshBasicMaterial>;
}

function eyeTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 48;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const halo = context.createRadialGradient(24, 24, 1, 24, 24, 22);
  halo.addColorStop(0, 'rgba(255,248,190,1)');
  halo.addColorStop(0.16, 'rgba(255,198,94,0.98)');
  halo.addColorStop(0.42, 'rgba(255,132,44,0.65)');
  halo.addColorStop(1, 'rgba(255,120,20,0)');
  context.fillStyle = halo;
  context.fillRect(0, 0, 48, 48);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = LinearFilter;
  return texture;
}

function slimeTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.strokeStyle = 'rgba(77,57,36,0.78)';
  context.lineWidth = 11;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(5, 18);
  context.bezierCurveTo(34, 10, 49, 21, 70, 15);
  context.bezierCurveTo(92, 9, 107, 19, 123, 14);
  context.stroke();
  context.strokeStyle = 'rgba(230,184,102,0.56)';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(5, 14);
  context.bezierCurveTo(34, 6, 49, 17, 70, 11);
  context.bezierCurveTo(92, 5, 107, 15, 123, 10);
  context.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = LinearFilter;
  return texture;
}

function emptyAgent(): SummonAgent {
  return {
    kind: 'invented', id: '', name: '', x: 0, y: -0.18, age: Infinity, timer: 0, uses: 0, state: 0,
    target: null, passengers: [], fromX: 0, fromY: 0, toX: 0, toY: 0, carryElapsed: 0, carryDuration: 0,
  };
}

export class SummonWorld implements SummonContext {
  readonly root = new Group();
  readonly agents: readonly SummonAgent[] = [emptyAgent(), emptyAgent()];
  readonly field: InkField;
  readonly folk: FolkWorld;
  readonly hazards: HazardWorld;
  readonly cooldown = new Map<string, number>();
  readonly sprites: SummonSprite[] = [];
  readonly slimeUntil = [0, 0];
  readonly slimeMap: CanvasTexture | null;
  readonly eyeMap: CanvasTexture | null;
  readonly agentArt: (Stencil | null)[] = [null, null];
  readonly art = new Map<SummonKind, Stencil>();
  readonly charge: Mesh<PlaneGeometry, MeshBasicMaterial> | null;
  level!: ScreenLevel;
  time = 0;
  dt = 0;
  fireCount = 0;
  autoFireCount = 0;
  falseFireCount = 0;
  onFire?: (agent: SummonAgent) => void;

  constructor(field: InkField, folk: FolkWorld, hazards: HazardWorld) {
    this.field = field;
    this.folk = folk;
    this.hazards = hazards;
    this.root.name = 'SummonWorld';
    this.slimeMap = typeof document !== 'undefined' ? slimeTexture() : null;
    this.eyeMap = typeof document !== 'undefined' ? eyeTexture() : null;
    this.charge = typeof document !== 'undefined' ? new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false,
    })) : null;
    if (this.charge) {
      this.charge.renderOrder = 11;
      this.charge.position.z = 0.005;
      this.charge.visible = false;
      this.root.add(this.charge);
    }
    if (typeof document !== 'undefined') {
      for (let index = 0; index < MAX_SUMMONS; index++) {
        const ink = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
          transparent: true, depthWrite: false, toneMapped: false,
        }));
        const glow = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
          transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false,
        }));
        const eye = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
          map: this.eyeMap, transparent: true, opacity: 0, blending: AdditiveBlending,
          depthWrite: false, toneMapped: false,
        }));
        const slime = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
          map: this.slimeMap, transparent: true, opacity: 0.82, depthWrite: false, toneMapped: false,
        }));
        ink.renderOrder = 10;
        glow.renderOrder = 9;
        eye.renderOrder = 11;
        slime.renderOrder = 7.2;
        slime.position.z = 0.003;
        ink.visible = glow.visible = eye.visible = slime.visible = false;
        eye.scale.set(0.035, 0.035, 1);
        this.root.add(slime, glow, ink, eye);
        this.sprites.push({ ink, glow, eye, slime });
      }
    }
  }

  setArt(kind: SummonKind, stencil: Stencil): void { this.art.set(kind, stencil); }

  setCharge(kind: SummonKind | null, x: number, y: number, opacity: number, override?: Stencil): void {
    const charge = this.charge;
    if (!charge) return;
    const stencil = override ?? (kind ? this.art.get(kind) : null);
    if (!stencil || opacity <= 0) { charge.visible = false; return; }
    if (charge.material.map !== stencil.glowTexture) {
      charge.material.map = stencil.glowTexture;
      charge.material.needsUpdate = true;
    }
    charge.position.set(x + stencil.cx * 0.75, y + stencil.cy * 0.75, 0.005);
    charge.scale.set(stencil.w * 0.75, stencil.h * 0.75, 1);
    charge.material.opacity = Math.min(0.88, opacity * 0.88);
    charge.visible = true;
  }

  start(level: ScreenLevel): void {
    this.level = level;
    if (this.charge) this.charge.visible = false;
    for (let index = 0; index < MAX_SUMMONS; index++) {
      this.retire(index);
      this.slimeUntil[index] = 0;
      if (this.sprites[index]) this.sprites[index].slime.visible = false;
    }
  }

  reset(): void {
    this.time = 0;
    this.cooldown.clear();
    this.fireCount = 0;
    this.autoFireCount = 0;
    this.falseFireCount = 0;
    for (let index = 0; index < MAX_SUMMONS; index++) {
      this.retire(index);
      this.slimeUntil[index] = 0;
      if (this.sprites[index]) this.sprites[index].slime.visible = false;
    }
  }

  activeCount(): number {
    let count = 0;
    for (const agent of this.agents) if (agent.age < LIFE + EXIT) count++;
    return count;
  }

  cooldownRemaining(id: string): number {
    return Math.max(0, (this.cooldown.get(id) ?? 0) - this.time);
  }

  spawn(kind: SummonKind, x: number, y = -0.18, name: string = kind, id: string = kind, override?: Stencil): boolean {
    if (this.cooldownRemaining(id) > 0) return false;
    let slot = -1;
    for (let index = 0; index < MAX_SUMMONS; index++) {
      if (this.agents[index].age >= LIFE + EXIT) { slot = index; break; }
    }
    if (slot < 0) return false;
    const agent = this.agents[slot];
    agent.kind = kind;
    agent.id = id;
    agent.name = name;
    agent.x = Math.max(-0.48, Math.min(0.45, x));
    agent.y = Math.max(-0.18, Math.min(0.15, y));
    agent.age = 0;
    agent.timer = 0;
    agent.uses = 0;
    agent.state = 0;
    agent.target = null;
    agent.passengers.length = 0;
    agent.carryElapsed = 0;
    agent.carryDuration = 0;
    this.cooldown.set(id, this.time + COOLDOWN);
    this.fireCount++;
    this.onFire?.(agent);
    const sprite = this.sprites[slot];
    const stencil = override ?? this.art.get(kind);
    this.agentArt[slot] = stencil ?? null;
    if (sprite && stencil) {
      sprite.ink.material.map = stencil.inkOpen;
      sprite.glow.material.map = stencil.glowTexture;
      sprite.ink.material.needsUpdate = true;
      sprite.glow.material.needsUpdate = true;
      const scale = Math.min(0.18 / stencil.w, 0.15 / stencil.h);
      sprite.ink.scale.set(stencil.w * scale, stencil.h * scale, 1);
      sprite.glow.scale.copy(sprite.ink.scale).multiplyScalar(1.3);
      sprite.ink.visible = sprite.glow.visible = true;
      sprite.eye.visible = stencil.eyes.length > 0;
    }
    return true;
  }

  update(dt: number): void {
    this.dt = Math.max(0, Math.min(0.05, dt));
    this.time += this.dt;
    this.field.summonTime = this.time;
    for (let index = 0; index < MAX_SUMMONS; index++) {
      const agent = this.agents[index];
      const sprite = this.sprites[index];
      if (sprite?.slime.visible) {
        sprite.slime.material.opacity = Math.min(0.82, Math.max(0, this.slimeUntil[index] - this.time) * 0.41);
        if (this.slimeUntil[index] <= this.time) sprite.slime.visible = false;
      }
      if (agent.age >= LIFE + EXIT) continue;
      agent.age += this.dt;
      if (agent.age >= LIFE + EXIT) { this.retire(index); continue; }
      if (agent.age < LIFE) {
        if (agent.kind === 'peacock' || agent.kind === 'rabbit' || agent.kind === 'snail') updateGiftA(agent, this);
        else if (agent.kind === 'dog' || agent.kind === 'duck' || agent.kind === 'fish' || agent.kind === 'elephant') updateGiftB(agent, this);
        else updateGiftC(agent, this);
      } else {
        if (agent.target) this.release(agent);
        agent.x += 0.15 * this.dt;
      }
      if (sprite && agent.kind === 'snail' && agent.state >= 2 && agent.state <= 3) {
        const length = Math.max(0, agent.x - agent.fromX);
        if (length > 0.005) {
          const fraction = length / Math.max(0.001, agent.toX - agent.fromX);
          sprite.slime.position.set(agent.fromX + length * 0.5,
            agent.fromY + (agent.toY - agent.fromY) * fraction * 0.5 + 0.012, 0.003);
          sprite.slime.scale.set(Math.hypot(length, (agent.toY - agent.fromY) * fraction), 0.024, 1);
          sprite.slime.rotation.z = Math.atan2(agent.toY - agent.fromY, agent.toX - agent.fromX);
          sprite.slime.material.opacity = 0.82;
          sprite.slime.visible = true;
          if (agent.state === 2) this.slimeUntil[index] = this.time + 10;
        }
      }
      if (sprite?.ink.visible) {
        const peel = Math.min(1, agent.age / 0.35);
        const lift = (1 - peel) * 0.04;
        const wobble = 1 + 0.035 * Math.sin(agent.age * 13) + 0.08 * Math.sin(peel * Math.PI);
        const fade = Math.min(1, (LIFE + EXIT - agent.age) / EXIT);
        sprite.ink.position.set(Math.max(-0.37, Math.min(0.37, agent.x)), agent.y + 0.04 + lift, 0.0046);
        const stencil = this.agentArt[index];
        if (stencil) {
          const scale = Math.min(0.18 / stencil.w, 0.15 / stencil.h);
          sprite.ink.scale.set(stencil.w * scale, stencil.h * scale * wobble, 1);
        }
        sprite.ink.material.opacity = fade;
        sprite.glow.position.copy(sprite.ink.position);
        sprite.glow.position.z -= 0.0002;
        sprite.glow.material.opacity = fade * (0.36 + (1 - peel) * 0.32);
        if (sprite.eye.visible && stencil) {
          const [eyeX, eyeY] = stencil.eyes[0];
          sprite.eye.position.set(sprite.ink.position.x + (eyeX - 0.5) * sprite.ink.scale.x,
            sprite.ink.position.y + (0.5 - eyeY) * sprite.ink.scale.y, 0.0048);
          sprite.eye.material.opacity = fade * (0.75 + 0.18 * Math.sin(agent.age * 7));
        }
      }
    }
  }

  nearest(kind: HazardKind, x: number): { x: number; width: number; kind: HazardKind } | null {
    let nearest: { x: number; width: number; kind: HazardKind } | null = null;
    let distance = Infinity;
    for (const hazard of this.level.hazards) {
      const nextDistance = Math.abs(hazard.x - x);
      if (hazard.kind === kind && nextDistance < distance) { nearest = hazard; distance = nextDistance; }
    }
    return nearest;
  }

  walkerNear(x: number, radius: number, beforeX = Infinity): Kindling | null {
    let nearest: Kindling | null = null;
    let distance = radius;
    for (let index = 0; index < this.folk.count; index++) {
      const walker = this.folk.agents[index];
      if (walker.state !== 'walking' && walker.state !== 'falling' || walker.carried || walker.x > beforeX) continue;
      const gap = Math.abs(walker.x - x);
      if (gap < distance) { nearest = walker; distance = gap; }
    }
    return nearest;
  }

  carry(agent: SummonAgent, walker: Kindling, toX: number, toY: number, duration: number): void {
    if (agent.target || walker.carried) return;
    agent.target = walker;
    agent.fromX = walker.x;
    agent.fromY = walker.y;
    agent.toX = toX;
    agent.toY = toY;
    agent.carryElapsed = 0;
    agent.carryDuration = Math.max(0.05, duration);
    agent.passengers.length = 0;
    walker.carried = true;
    walker.vx = walker.vy = 0;
  }

  board(agent: SummonAgent, walker: Kindling): boolean {
    if (!agent.target || walker.carried || agent.passengers.length >= 2) return false;
    agent.passengers.push(walker);
    walker.carried = true;
    walker.vx = walker.vy = 0;
    return true;
  }

  advanceCarry(agent: SummonAgent): boolean {
    const walker = agent.target;
    if (!walker) return false;
    agent.carryElapsed = Math.min(agent.carryDuration, agent.carryElapsed + this.dt);
    const progress = agent.carryElapsed / agent.carryDuration;
    walker.x = agent.fromX + (agent.toX - agent.fromX) * progress;
    walker.y = agent.fromY + (agent.toY - agent.fromY) * progress + Math.sin(progress * Math.PI) * 0.08;
    for (let index = 0; index < agent.passengers.length; index++) {
      const passenger = agent.passengers[index];
      passenger.x = walker.x - (index + 1) * 0.018;
      passenger.y = walker.y + (index + 1) * 0.006;
    }
    agent.x = walker.x;
    agent.y = walker.y;
    if (progress < 1) return false;
    this.release(agent);
    return true;
  }

  addBridge(left: number, right: number, bottom: number, top: number, duration: number): void {
    this.field.setSummonRect(left, bottom, right, top, duration);
  }

  private release(agent: SummonAgent): void {
    const walker = agent.target;
    if (!walker) return;
    for (const passenger of agent.passengers) {
      passenger.carried = false;
      passenger.state = 'falling';
      passenger.fallStartY = passenger.y;
      passenger.vx = 0.055;
      passenger.vy = 0;
    }
    agent.passengers.length = 0;
    walker.carried = false;
    walker.state = 'falling';
    walker.fallStartY = walker.y;
    walker.vx = 0.055;
    walker.vy = 0;
    agent.target = null;
  }

  private retire(index: number): void {
    const agent = this.agents[index];
    this.release(agent);
    agent.age = Infinity;
    this.agentArt[index] = null;
    if (this.sprites[index]) {
      this.sprites[index].ink.visible = false;
      this.sprites[index].glow.visible = false;
      this.sprites[index].eye.visible = false;
    }
  }

  dispose(): void {
    if (this.charge) { this.charge.geometry.dispose(); this.charge.material.dispose(); }
    for (const sprite of this.sprites) {
      sprite.ink.geometry.dispose();
      sprite.ink.material.dispose();
      sprite.glow.geometry.dispose();
      sprite.glow.material.dispose();
      sprite.eye.geometry.dispose();
      sprite.eye.material.dispose();
      sprite.slime.geometry.dispose();
      sprite.slime.material.dispose();
    }
    this.slimeMap?.dispose();
    this.eyeMap?.dispose();
    this.root.clear();
  }
}

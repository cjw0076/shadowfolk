import { InkField } from './ink-field.js';

export type FolkState = 'inactive' | 'walking' | 'falling' | 'ash' | 'home';

export interface Kindling {
  x: number; y: number; vx: number; vy: number; heading: number;
  state: FolkState; fallStartY: number; age: number; homeAge: number;
  pushCooldown: number; tint: number; scale: number; isWick: boolean;
  carried: boolean;
  /** Stopped at an edge it will not walk off (prologue): drawn wobbling. */
  waiting: boolean;
}

const MAX_FOLK = 48;
const RADIUS = 0.011;
const STEP = 1 / 120;

export class FolkWorld {
  readonly agents: Kindling[] = Array.from({ length: MAX_FOLK }, () => ({
    x: 0, y: 0, vx: 0, vy: 0, heading: 1, state: 'inactive', fallStartY: 0, age: 0, homeAge: 0, pushCooldown: 0,
    tint: 0xffe0a0, scale: 1, isWick: false, carried: false, waiting: false,
  }));
  count = 0;
  homeCount = 0;
  ashCount = 0;
  doorX = 0.43;
  doorY = -0.15;
  doorW = 0.07;
  doorH = 0.16;
  spawnX = -0.44;
  spawnY = -0.185;
  waveCount = 0;
  /** Walkers stop and wobble at a drop instead of walking off it (the prologue: Wick waits for your hand). */
  edgeWait = false;
  onEvent?: (kind: 'walk' | 'ash' | 'home', agent: Kindling) => void;
  private clock = 0;
  private accumulator = 0;
  private emitted = 0;
  private nextSpawn = 0;
  private random: number;
  private lastWalkCue = -Infinity;

  constructor(readonly field: InkField, private readonly seed = 1) { this.random = seed | 0 || 1; }

  configure(options: Partial<Pick<FolkWorld, 'doorX' | 'doorY' | 'doorW' | 'doorH' | 'spawnX' | 'spawnY' | 'waveCount'>>): void {
    if (options.doorX !== undefined) this.doorX = options.doorX;
    if (options.doorY !== undefined) this.doorY = options.doorY;
    if (options.doorW !== undefined) this.doorW = options.doorW;
    if (options.doorH !== undefined) this.doorH = options.doorH;
    if (options.spawnX !== undefined) this.spawnX = options.spawnX;
    if (options.spawnY !== undefined) this.spawnY = options.spawnY;
    if (options.waveCount !== undefined) this.waveCount = options.waveCount;
  }

  reset(): void {
    for (let index = 0; index < MAX_FOLK; index++) this.agents[index].state = 'inactive';
    this.count = this.homeCount = this.ashCount = this.clock = this.accumulator = this.emitted = this.nextSpawn = 0;
    this.random = this.seed | 0 || 1;
    this.lastWalkCue = -Infinity;
  }

  spawn(x = this.spawnX, y = this.spawnY, heading = 1): Kindling | null {
    if (this.count >= MAX_FOLK) return null;
    const agent = this.agents[this.count++];
    agent.x = x; agent.y = y; agent.vx = 0; agent.vy = 0;
    agent.heading = heading < 0 ? -1 : 1;
    agent.state = 'falling'; agent.fallStartY = y; agent.age = 0; agent.homeAge = 0; agent.pushCooldown = 0;
    agent.carried = false;
    agent.waiting = false;
    agent.isWick = this.count === 1;
    agent.tint = agent.isWick ? 0xfff5d2 : 0xffe0a0;
    agent.scale = agent.isWick ? 1.2 : 1;
    return agent;
  }

  update(dt: number): void {
    this.accumulator = Math.min(this.accumulator + Math.max(0, dt), STEP * 8);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.substep();
    }
  }

  private substep(): void {
    this.clock += STEP;
    if (this.emitted < this.waveCount && this.clock >= this.nextSpawn) {
      this.spawn();
      this.emitted++;
      this.nextSpawn += 0.6;
    }
    const cell = this.field.cell;
    for (let index = 0; index < this.count; index++) {
      const agent = this.agents[index];
      if (agent.state === 'home') { agent.homeAge += STEP; continue; }
      if (agent.state === 'inactive' || agent.state === 'ash') continue;
      if (agent.carried) continue;
      agent.age += STEP;
      agent.pushCooldown = Math.max(0, agent.pushCooldown - STEP);
      if (agent.x >= this.doorX - this.doorW * 0.5 && agent.x <= this.doorX + this.doorW * 0.5
        && agent.y >= this.doorY - this.doorH * 0.5 && agent.y <= this.doorY + this.doorH * 0.5) {
        agent.state = 'home'; this.homeCount++; this.onEvent?.('home', agent); continue;
      }
      const bodyIndex = this.field.index(agent.x, agent.y);
      if (bodyIndex >= 0 && this.field.solid[bodyIndex] && !this.field.staticSolid[bodyIndex]) {
        let freeX = agent.x, freeY = agent.y, found = false;
        const column = Math.floor((agent.x - this.field.x0) / cell);
        const row = Math.floor((agent.y - this.field.y0) / cell);
        for (let radius = 1; radius <= 4 && !found; radius++) {
          let best = Infinity;
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
              const candidateX = this.field.x0 + (column + dx + 0.5) * cell;
              const candidateY = this.field.y0 + (row + dy + 0.5) * cell;
              if (this.field.sample(candidateX, candidateY) === 1) continue;
              const cost = dx * dx + dy * dy + (dy < 0 ? 2 : 0);
              if (cost < best) { best = cost; freeX = candidateX; freeY = candidateY; found = true; }
            }
          }
        }
        const inkVX = this.field.vx[bodyIndex], inkVY = this.field.vy[bodyIndex];
        if (found) { agent.x = freeX; agent.y = freeY; }
        else { agent.x += inkVX * STEP; agent.y += inkVY * STEP; }
        if (agent.pushCooldown === 0) {
          agent.vx = Math.max(-1.6, Math.min(1.6, agent.vx + inkVX));
          agent.vy = Math.max(-1.6, Math.min(1.6, agent.vy + inkVY));
          agent.pushCooldown = 0.12;
        }
        agent.state = 'falling';
      }
      const footY = agent.y - RADIUS - cell * 0.5;
      const supportX = agent.x + agent.heading * RADIUS * 0.45;
      const support = this.field.sample(supportX, footY);
      const inSoft = this.field.sample(agent.x, agent.y) === 2 || support === 2;
      const softIndex = inSoft ? this.field.index(agent.x, agent.y) : -1;
      if (softIndex >= 0 && this.field.soft[softIndex] && this.field.vy[softIndex] > 0.25
        && agent.pushCooldown === 0) {
        agent.vx = Math.max(-1.6, Math.min(1.6, this.field.vx[softIndex] * 0.7));
        agent.vy = Math.min(1.6, this.field.vy[softIndex] * 0.7);
        agent.state = 'falling';
        agent.fallStartY = agent.y;
        agent.pushCooldown = 0.12;
      }
      if (agent.state === 'walking') {
        if (support === 1) {
          const aheadX = agent.x + agent.heading * (RADIUS + cell * 0.5);
          const aheadY = agent.y - RADIUS * 0.2;
          if (this.field.sample(aheadX, aheadY) === 1) {
            let height = 0;
            while (height <= 2 && this.field.sample(aheadX, aheadY + height * cell) === 1) height++;
            if (height <= 2) agent.y += height * cell;
            else agent.heading = -agent.heading;
          } else if (this.edgeWait && this.dropAhead(agent, footY)) agent.waiting = true;
          else { agent.waiting = false; agent.x += agent.heading * 0.055 * STEP; }
          const supportIndex = this.field.index(supportX, footY);
          const inkY = supportIndex >= 0 ? this.field.vy[supportIndex] : 0;
          if (inkY > 0.14 && agent.pushCooldown === 0 && supportIndex >= 0 && this.field.solid[supportIndex]) {
            agent.vy = Math.min(1.6, inkY);
            agent.vx = agent.heading * 0.055;
            agent.pushCooldown = 0.12;
            agent.state = 'falling'; agent.fallStartY = agent.y;
          } else {
            agent.y += Math.max(-0.025, Math.min(0.025, inkY)) * STEP;
            this.walkTick(agent);
          }
          continue;
        }
        agent.state = 'falling'; agent.fallStartY = agent.y; agent.vy = inSoft ? -0.04 : 0;
      }
      if (support === 1 && agent.vy <= 0) {
        if (agent.fallStartY - agent.y > 0.24 && !inSoft && !this.edgeWait) {
          agent.state = 'ash'; this.ashCount++; this.onEvent?.('ash', agent); continue;
        }
        agent.y = this.field.y0 + (Math.floor((footY - this.field.y0) / cell) + 1) * cell + RADIUS;
        agent.vy = 0; agent.vx = 0; agent.state = 'walking'; this.walkTick(agent); continue;
      }
      if (inSoft) agent.vy = Math.max(-0.05, agent.vy - 1.1 * STEP);
      else agent.vy = Math.max(-0.9, agent.vy - 1.1 * STEP);
      agent.y += agent.vy * STEP;
      agent.x += (agent.vx || agent.heading * 0.02) * STEP;
      agent.vx *= 0.995;
      if (inSoft) agent.fallStartY = agent.y;
      if (agent.y < -0.37 || agent.x < -0.62 || agent.x > 0.62) {
        // Prologue: nothing is lost; a stray spark tumbles back out of the lantern door.
        if (this.edgeWait) { agent.x = this.spawnX; agent.y = this.spawnY; agent.vx = agent.vy = 0; agent.fallStartY = agent.y; }
        else { agent.state = 'ash'; this.ashCount++; this.onEvent?.('ash', agent); }
      }
    }
  }

  /** True when the next step would leave every support within three cells below the feet. */
  private dropAhead(agent: Kindling, footY: number): boolean {
    const cell = this.field.cell;
    const leadX = agent.x + agent.heading * (RADIUS * 0.45 + cell);
    for (let depth = 0; depth <= 3; depth++) if (this.field.sample(leadX, footY - depth * cell) === 1) return false;
    return true;
  }

  private walkTick(agent: Kindling): void {
    const cycle = Math.floor(agent.age * 4);
    if (cycle === Math.floor((agent.age - STEP) * 4)) return;
    this.random = (Math.imul(this.random, 1664525) + 1013904223) | 0;
    if ((this.random & 3) === 0 && this.clock - this.lastWalkCue >= 0.16) {
      this.lastWalkCue = this.clock;
      this.onEvent?.('walk', agent);
    }
  }
}

export interface MothPoint { x: number; y: number; z: number }

export interface MothStage {
  flame: MothPoint;
  paper: MothPoint;
  right: MothPoint;
  head: MothPoint;
  moon: MothPoint;
}

export interface MothHand {
  valid: boolean;
  joints: Float32Array;
}

export type MothPhase = 'hidden' | 'paper' | 'approach' | 'orbit' | 'dive' | 'tumble' | 'depart' | 'queenOrbit' | 'queenDive' | 'moon';

export interface MothAgent {
  phase: MothPhase;
  queen: boolean;
  x: number;
  y: number;
  z: number;
  age: number;
  phaseTime: number;
  angle: number;
  paperX: number;
  paperY: number;
  intro: boolean;
  hitSide: number;
  flap: number;
  opacity: number;
  swats: number;
  dives: number;
}

export type MothEvent = 'spawn' | 'peel' | 'flutter' | 'shoo' | 'gutter' | 'queen-moon';

const SMALL_COUNT = 7;
const ALL_COUNT = SMALL_COUNT + 1;
const PAPER_SECONDS = 1.5;
const ORBIT_SECONDS = 1.8;
const TWO_PI = Math.PI * 2;

function distanceSquared(x: number, y: number, z: number, point: MothPoint): number {
  const dx = x - point.x, dy = y - point.y, dz = z - point.z;
  return dx * dx + dy * dy + dz * dz;
}

function advanceToward(agent: MothAgent, targetX: number, targetY: number, targetZ: number, distance: number): boolean {
  const dx = targetX - agent.x, dy = targetY - agent.y, dz = targetZ - agent.z;
  const remaining = Math.hypot(dx, dy, dz);
  if (remaining <= distance || remaining < 1e-6) {
    agent.x = targetX; agent.y = targetY; agent.z = targetZ;
    return true;
  }
  const scale = distance / remaining;
  agent.x += dx * scale; agent.y += dy * scale; agent.z += dz * scale;
  return false;
}

function setPhase(agent: MothAgent, phase: MothPhase): void {
  agent.phase = phase;
  agent.phaseTime = 0;
}

export class MothWorld {
  readonly agents: MothAgent[] = Array.from({ length: ALL_COUNT }, (_, index) => ({
    phase: 'hidden', queen: index === SMALL_COUNT, x: 0, y: 0, z: 0, age: 0, phaseTime: 0,
    angle: 0, paperX: 0, paperY: 0.2, intro: false, hitSide: -1,
    flap: 0, opacity: 0, swats: 0, dives: 0,
  }));
  onEvent?: (event: MothEvent, agent: MothAgent) => void;
  night = 0;
  time = 0;
  gutterSeconds = 0;
  shielded = false;
  queenOnMoon = false;
  gutters = 0;
  shooed = 0;
  deflections = 0;
  peeled = 0;
  private nextSpawn = Infinity;
  private queenStarted = false;
  private winning = false;
  private newMoon = false;
  private festival = false;
  private random = 1;
  private previousJoints = [new Float32Array(75), new Float32Array(75)];
  private previousValid = [false, false];
  private moonStart: MothPoint | null = null;
  private spawned = 0;

  start(night: number, seed: number, lunarPhase: number): void {
    this.night = night;
    this.time = this.gutterSeconds = this.gutters = this.shooed = this.deflections = this.peeled = 0;
    this.shielded = this.queenOnMoon = this.queenStarted = this.winning = false;
    this.newMoon = lunarPhase < 0.08 || lunarPhase > 0.92;
    this.festival = night > 8 && Math.abs(lunarPhase - 0.5) < 0.034;
    this.random = seed | 0 || 1;
    this.nextSpawn = night >= 6 && !this.festival ? night === 8 ? 6 : 4 : Infinity;
    this.previousValid[0] = this.previousValid[1] = false;
    this.moonStart = null;
    this.spawned = 0;
    for (const agent of this.agents) {
      agent.phase = 'hidden'; agent.age = agent.phaseTime = agent.opacity = agent.swats = agent.dives = 0;
    }
  }

  get activeCount(): number { return this.agents.reduce((count, agent) => count + (agent.phase !== 'hidden' ? 1 : 0), 0); }
  get isFestival(): boolean { return this.festival; }
  get flameFactor(): number { return this.gutterSeconds > 0 ? 0.4 : 1; }

  spawn(stage: MothStage): MothAgent | null {
    const agent = this.agents.find((entry) => !entry.queen && entry.phase === 'hidden');
    if (!agent) return null;
    this.random = (Math.imul(this.random, 1664525) + 1013904223) | 0;
    agent.paperX = (((this.random >>> 8) & 1023) / 1023 - 0.5) * 0.42;
    agent.intro = this.night === 6 && this.spawned++ === 0;
    agent.paperY = agent.intro ? 0.30 : 0.20;
    agent.hitSide = -1;
    agent.x = stage.paper.x + stage.right.x * agent.paperX;
    agent.y = stage.paper.y + agent.paperY;
    agent.z = stage.paper.z + stage.right.z * agent.paperX;
    agent.age = agent.phaseTime = agent.swats = agent.dives = 0;
    agent.angle = 0;
    agent.opacity = 1;
    setPhase(agent, 'paper');
    this.onEvent?.('spawn', agent);
    return agent;
  }

  beginQueenVictory(): void {
    if (this.winning) return;
    this.winning = true;
    this.nextSpawn = Infinity;
    for (const agent of this.agents) {
      if (!agent.queen && agent.phase !== 'hidden') setPhase(agent, 'depart');
    }
    const queen = this.agents[SMALL_COUNT];
    // The last look is back at the small lantern before she chooses the moon.
    this.moonStart = null;
    queen.opacity = 1;
    setPhase(queen, 'moon');
  }

  update(dt: number, stage: MothStage, hands: readonly MothHand[], controllers: readonly (MothPoint | null)[] = []): void {
    const step = Math.max(0, Math.min(dt, 0.05));
    this.time += step;
    this.gutterSeconds = Math.max(0, this.gutterSeconds - step);
    this.shielded = this.isFlameShielded(stage.flame, hands);
    if (this.time >= this.nextSpawn) {
      this.spawn(stage);
      this.nextSpawn = this.time + this.spawnInterval();
    }
    if (this.night === 8 && !this.queenStarted && this.time >= 15) this.startQueen(stage);
    for (const agent of this.agents) {
      if (agent.phase === 'hidden') continue;
      agent.age += step;
      agent.phaseTime += step;
      agent.flap = Math.sin(agent.age * (agent.queen ? 9 : 22));
      if (agent.phase === 'paper') {
        agent.opacity = Math.min(1, agent.phaseTime / 0.25);
        if (agent.intro) {
          const progress = Math.min(1, agent.phaseTime / 2.5);
          agent.paperY = 0.30 - 0.16 * progress;
          agent.y = stage.paper.y + agent.paperY;
        }
        if (agent.phaseTime >= (agent.intro ? 2.5 : PAPER_SECONDS)) {
          setPhase(agent, agent.queen ? 'queenOrbit' : 'approach');
          this.peeled++;
          this.onEvent?.('peel', agent);
        }
      } else if (agent.phase === 'approach') {
        const swirl = Math.sin(agent.age * 4 + agent.paperX * 9) * 0.014;
        const targetX = stage.flame.x + stage.right.x * 0.25;
        const targetY = stage.flame.y + 0.08 + swirl;
        const targetZ = stage.flame.z + stage.right.z * 0.25;
        if (advanceToward(agent, targetX, targetY, targetZ, 0.22 * step)) setPhase(agent, 'orbit');
      } else if (agent.phase === 'orbit') {
        agent.angle = Math.min(TWO_PI, agent.phaseTime / ORBIT_SECONDS * TWO_PI);
        agent.x = stage.flame.x + stage.right.x * Math.cos(agent.angle) * 0.25;
        agent.y = stage.flame.y + 0.08 + Math.sin(agent.angle) * 0.035;
        agent.z = stage.flame.z + stage.right.z * Math.cos(agent.angle) * 0.25
          + stage.right.x * Math.sin(agent.angle) * 0.25;
        agent.x -= stage.right.z * Math.sin(agent.angle) * 0.25;
        if (agent.phaseTime >= ORBIT_SECONDS) setPhase(agent, 'dive');
      } else if (agent.phase === 'dive') {
        advanceToward(agent, stage.flame.x, stage.flame.y, stage.flame.z, 0.34 * step);
      } else if (agent.phase === 'queenOrbit') {
        agent.angle += step * 0.36;
        agent.x = stage.head.x + Math.cos(agent.angle) * 1.05;
        agent.y = stage.head.y - 0.08 + 0.12 * Math.sin(agent.angle * 1.3);
        agent.z = stage.head.z + Math.sin(agent.angle) * 1.05;
        if (!this.winning && agent.phaseTime >= 12) setPhase(agent, 'queenDive');
      } else if (agent.phase === 'queenDive') {
        advanceToward(agent, stage.flame.x, stage.flame.y, stage.flame.z, 0.55 * step);
      } else if (agent.phase === 'moon') {
        if (!this.moonStart) this.moonStart = { x: stage.flame.x, y: stage.flame.y + 0.08, z: stage.flame.z };
        const fraction = Math.min(1, agent.phaseTime / 3.5);
        const eased = fraction * fraction * (3 - 2 * fraction);
        const start = this.moonStart;
        agent.x = start.x + (stage.moon.x - start.x) * eased;
        agent.y = start.y + (stage.moon.y - start.y) * eased + Math.sin(Math.PI * eased) * 0.10;
        agent.z = start.z + (stage.moon.z - start.z) * eased - Math.sin(Math.PI * eased) * 0.11;
        agent.opacity = 1 - Math.max(0, (fraction - 0.88) / 0.12);
        if (fraction >= 1) {
          this.queenOnMoon = true;
          setPhase(agent, 'hidden');
          this.onEvent?.('queen-moon', agent);
        }
      } else if (agent.phase === 'tumble') {
        agent.angle += step * 16;
        agent.x += stage.right.x * step * 0.42;
        agent.y += step * 0.20;
        agent.z += stage.right.z * step * 0.42;
        if (agent.phaseTime >= 0.55) setPhase(agent, 'depart');
      } else if (agent.phase === 'depart') {
        agent.x += stage.right.x * step * 0.28;
        agent.y += step * 0.16;
        agent.z += stage.right.z * step * 0.28;
        agent.opacity = Math.max(0, 1 - agent.phaseTime / 1.5);
        if (agent.phaseTime >= 1.5) setPhase(agent, 'hidden');
      }

      if (agent.opacity <= 0 || agent.phase === 'paper' || agent.phase === 'tumble'
        || agent.phase === 'depart' || agent.phase === 'moon') continue;
      if (this.shielded && distanceSquared(agent.x, agent.y, agent.z, stage.flame) < (agent.queen ? 0.28 : 0.18) ** 2) {
        this.deflections++;
        if (agent.queen) { setPhase(agent, 'queenOrbit'); agent.phaseTime = -3; }
        else setPhase(agent, 'tumble');
        this.onEvent?.('shoo', agent);
        continue;
      }
      const hitSide = this.swatted(agent, hands, controllers, step);
      if (hitSide >= 0) {
        this.shooed++;
        agent.swats++;
        agent.hitSide = hitSide;
        setPhase(agent, agent.queen ? 'queenOrbit' : 'tumble');
        if (agent.queen) agent.phaseTime = -3;
        this.onEvent?.('shoo', agent);
        continue;
      }
      if (distanceSquared(agent.x, agent.y, agent.z, stage.flame) < 0.07 ** 2) {
        this.gutters++;
        agent.dives++;
        this.gutterSeconds = Math.max(this.gutterSeconds, agent.queen ? 6 : 3);
        this.onEvent?.('gutter', agent);
        if (agent.queen) { setPhase(agent, 'queenOrbit'); agent.phaseTime = -3; }
        else setPhase(agent, 'depart');
      }
    }
    for (let side = 0; side < 2; side++) {
      const hand = hands[side];
      this.previousValid[side] = !!hand?.valid;
      if (hand?.valid) this.previousJoints[side].set(hand.joints);
    }
  }

  private startQueen(stage: MothStage): void {
    this.queenStarted = true;
    const queen = this.agents[SMALL_COUNT];
    queen.x = stage.paper.x;
    queen.y = stage.paper.y + 0.06;
    queen.z = stage.paper.z;
    queen.paperX = 0;
    queen.age = queen.phaseTime = queen.swats = queen.dives = 0;
    queen.opacity = 1;
    queen.angle = -Math.PI / 2;
    setPhase(queen, 'paper');
    this.onEvent?.('spawn', queen);
  }

  private spawnInterval(): number {
    if (this.night === 8) return 6 / (this.newMoon ? 1.5 : 1);
    if (this.night === 6) return 20 / (this.newMoon ? 1.5 : 1);
    if (this.night === 7) return 14 / (this.newMoon ? 1.5 : 1);
    this.random = (Math.imul(this.random, 1664525) + 1013904223) | 0;
    return (16 + ((this.random >>> 8) % 9)) / (this.newMoon ? 1.5 : 1);
  }

  private isFlameShielded(flame: MothPoint, hands: readonly MothHand[]): boolean {
    for (let side = 0; side < Math.min(2, hands.length); side++) {
      const hand = hands[side];
      if (!hand?.valid) continue;
      const joints = hand.joints;
      const centerX = (joints[0] + joints[15] + joints[60]) / 3;
      const centerY = (joints[1] + joints[16] + joints[61]) / 3;
      const centerZ = (joints[2] + joints[17] + joints[62]) / 3;
      const towardX = flame.x - centerX, towardY = flame.y - centerY, towardZ = flame.z - centerZ;
      const distance = Math.hypot(towardX, towardY, towardZ);
      if (distance > 0.15) continue;
      const indexX = joints[15] - joints[0], indexY = joints[16] - joints[1], indexZ = joints[17] - joints[2];
      const pinkyX = joints[60] - joints[0], pinkyY = joints[61] - joints[1], pinkyZ = joints[62] - joints[2];
      const normalX = indexY * pinkyZ - indexZ * pinkyY;
      const normalY = indexZ * pinkyX - indexX * pinkyZ;
      const normalZ = indexX * pinkyY - indexY * pinkyX;
      const normalLength = Math.hypot(normalX, normalY, normalZ);
      if (normalLength > 1e-5 && (side === 0 ? 1 : -1)
        * (normalX * towardX + normalY * towardY + normalZ * towardZ) > normalLength * distance * 0.25) return true;
    }
    return false;
  }

  private swatted(agent: MothAgent, hands: readonly MothHand[], controllers: readonly (MothPoint | null)[], dt: number): number {
    const baseReach = agent.queen ? 0.12 : 0.06;
    for (let side = 0; side < Math.min(2, hands.length); side++) {
      const hand = hands[side];
      if (!hand?.valid) continue;
      const previous = this.previousJoints[side];
      for (let joint = 0; joint < hand.joints.length; joint += 3) {
        const x = hand.joints[joint], y = hand.joints[joint + 1], z = hand.joints[joint + 2];
        const speed = this.previousValid[side]
          ? Math.hypot(x - previous[joint], y - previous[joint + 1], z - previous[joint + 2]) / Math.max(dt, 1 / 240) : 0;
        const reach = agent.queen ? baseReach : speed > 0.6 ? 0.09 : baseReach;
        if ((x - agent.x) ** 2 + (y - agent.y) ** 2 + (z - agent.z) ** 2 < reach * reach) return side;
      }
    }
    for (let side = 0; side < controllers.length; side++) {
      const controller = controllers[side];
      if (controller && distanceSquared(agent.x, agent.y, agent.z, controller) < baseReach * baseReach) return side;
    }
    return -1;
  }
}

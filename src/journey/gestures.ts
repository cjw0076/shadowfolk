import { JOINT_COUNT } from '../shadow/hand-model.js';
import { STAGE, type ScreenFrame } from '../shadow/silhouette.js';

export interface GestureHand {
  joints: Float32Array;
  valid: boolean;
}

export interface GestureState {
  bark: boolean;
  peck: boolean;
  snip: boolean;
  hop: boolean;
  fan: boolean;
  fly: boolean;
  scale: number;
  giant: boolean;
  tiny: boolean;
  jaw: number;
  beak: number;
  spread: number;
  verticalVelocity: number;
}

function distance(joints: Float32Array, first: number, second: number): number {
  const a = first * 3, b = second * 3;
  return Math.hypot(joints[a] - joints[b], joints[a + 1] - joints[b + 1], joints[a + 2] - joints[b + 2]);
}

class DoubleCycle {
  private high = NaN;
  private low = 0;
  private closed = false;
  private cycles = 0;
  private remaining = 0;

  constructor(private readonly closeBy: number, private readonly reopenBy: number,
    private readonly reopenFromHigh = 0.45) {}

  update(dt: number, value: number): boolean {
    if (!Number.isFinite(this.high)) this.high = value;
    if (this.remaining > 0) {
      this.remaining -= dt;
      if (this.remaining <= 0) this.cycles = 0;
    }
    if (!this.closed) {
      if (value > this.high) this.high = value;
      else this.high = Math.max(value, this.high - dt * 0.005);
      if (this.high - value >= this.closeBy) {
        this.closed = true;
        this.low = value;
      }
      return false;
    }
    this.low = Math.min(this.low, value);
    if (value - this.low < this.reopenBy || value < this.high - this.closeBy * this.reopenFromHigh) return false;
    this.closed = false;
    this.high = value;
    this.cycles++;
    if (this.cycles < 2) {
      this.remaining = 2;
      return false;
    }
    this.cycles = 0;
    this.remaining = 0;
    return true;
  }

  reset(): void {
    this.high = NaN;
    this.low = 0;
    this.closed = false;
    this.cycles = 0;
    this.remaining = 0;
  }
}

export class GestureDetector {
  private readonly state: GestureState = {
    bark: false, peck: false, snip: false, hop: false, fan: false, fly: false,
    scale: 1, giant: false, tiny: false, jaw: 0, beak: 0, spread: 0, verticalVelocity: 0,
  };
  private readonly barkCycle = new DoubleCycle(0.025, 0.020);
  private readonly fanCycle = new DoubleCycle(0.020, 0.016, 1.5);
  private readonly flyCycle = new DoubleCycle(0.036, 0.030);
  private handMask = 0;
  private jaw = NaN;
  private spread = NaN;
  private beak = [NaN, NaN];
  private beakArmed = [false, false];
  private beakTime = [0, 0];
  private snaps = [0, 0];
  private snapEvents = [false, false];
  private y = NaN;
  private verticalVelocity = 0;
  private hopOrigin = 0;
  private hopTime = 0;
  private hopRising = false;

  update(dt: number, hands: readonly GestureHand[], lanternPos: { x: number; y: number; z: number }, frame: ScreenFrame): GestureState {
    const out = this.state;
    out.bark = out.peck = out.snip = out.hop = out.fan = out.fly = false;
    const left = hands[0];
    const right = hands[1];
    const leftValid = !!left?.valid;
    const rightValid = !!right?.valid;
    const count = Number(leftValid) + Number(rightValid);
    const handMask = Number(leftValid) | (Number(rightValid) << 1);
    if (handMask !== this.handMask) {
      this.resetMotion();
      this.handMask = handMask;
    }
    if (!count || !Number.isFinite(dt) || dt <= 0) {
      out.scale = 1;
      out.giant = out.tiny = false;
      return out;
    }

    let centreX = 0, centreY = 0, centreZ = 0;
    let yLeft = 0, yRight = 0;
    for (let side = 0; side < 2; side++) {
      if (side === 0 && !leftValid || side === 1 && !rightValid) continue;
      const joints = hands[side].joints;
      let handY = 0;
      for (let joint = 0; joint < JOINT_COUNT; joint++) {
        const offset = joint * 3;
        centreX += joints[offset];
        centreY += joints[offset + 1];
        centreZ += joints[offset + 2];
        handY += joints[offset + 1];
      }
      if (side === 0) yLeft = handY / JOINT_COUNT;
      else yRight = handY / JOINT_COUNT;
    }
    const invCount = 1 / (count * JOINT_COUNT);
    centreX *= invCount;
    centreY *= invCount;
    centreZ *= invCount;
    const lightToScreen = (lanternPos.x - frame.ox) * frame.nx
      + (lanternPos.y - frame.oy) * frame.ny + (lanternPos.z - frame.oz) * frame.nz;
    const lightToHand = (lanternPos.x - centreX) * frame.nx
      + (lanternPos.y - centreY) * frame.ny + (lanternPos.z - centreZ) * frame.nz;
    const magnification = lightToScreen / Math.max(0.03, lightToHand);
    out.scale = Number.isFinite(magnification) && lightToScreen > 0
      ? magnification / (STAGE.lightToScreen / STAGE.lightToHand) : 1;
    if (out.giant ? out.scale < 1.25 : out.scale >= 1.35) out.giant = !out.giant;
    if (out.tiny ? out.scale > 0.85 : out.scale <= 0.78) out.tiny = !out.tiny;

    const active = leftValid ? left.joints : right.joints;
    const jawRaw = (distance(active, 4, 9) + distance(active, 4, 14)) * 0.5;
    const spreadRaw = distance(active, 9, 24);
    const smoothing = Math.min(1, dt * 18);
    this.jaw = Number.isFinite(this.jaw) ? this.jaw + (jawRaw - this.jaw) * smoothing : jawRaw;
    this.spread = Number.isFinite(this.spread) ? this.spread + (spreadRaw - this.spread) * smoothing : spreadRaw;
    out.jaw = this.jaw;
    out.spread = this.spread;
    if (count === 1) {
      out.bark = this.barkCycle.update(dt, this.jaw);
      out.fan = this.fanCycle.update(dt, this.spread);
    }

    const snapEvents = this.snapEvents;
    snapEvents[0] = snapEvents[1] = false;
    for (let side = 0; side < 2; side++) {
      if (side === 0 && !leftValid || side === 1 && !rightValid) continue;
      const raw = distance(hands[side].joints, 4, 9);
      const smooth = Number.isFinite(this.beak[side]) ? this.beak[side] + (raw - this.beak[side]) * smoothing : raw;
      this.beak[side] = smooth;
      if (smooth > 0.04) {
        this.beakArmed[side] = true;
        this.beakTime[side] = 0;
      } else if (this.beakArmed[side]) {
        this.beakTime[side] += dt;
        if (smooth < 0.02 && this.beakTime[side] <= 0.5) {
          snapEvents[side] = true;
          this.beakArmed[side] = false;
          this.snaps[side] = 0.35;
        } else if (this.beakTime[side] > 0.5) this.beakArmed[side] = false;
      }
    }
    out.beak = leftValid ? this.beak[0] : this.beak[1];
    if (count === 1) out.peck = snapEvents[leftValid ? 0 : 1];
    else if (count === 2) {
      if (snapEvents[0] && this.snaps[1] > 0 || snapEvents[1] && this.snaps[0] > 0) {
        out.snip = true;
        this.snaps[0] = this.snaps[1] = 0;
      }
      this.snaps[0] = Math.max(0, this.snaps[0] - dt);
      this.snaps[1] = Math.max(0, this.snaps[1] - dt);
    }

    const handY = count === 2 ? (yLeft + yRight) * 0.5 : leftValid ? yLeft : yRight;
    if (Number.isFinite(this.y)) {
      const rawVelocity = (handY - this.y) / dt;
      this.verticalVelocity += (rawVelocity - this.verticalVelocity) * Math.min(1, dt * 16);
    }
    this.y = handY;
    out.verticalVelocity = this.verticalVelocity;
    if (count === 1) {
      if (!this.hopRising && this.verticalVelocity > 0.6) {
        this.hopRising = true;
        this.hopOrigin = handY;
        this.hopTime = 0;
      } else if (this.hopRising) {
        this.hopTime += dt;
        if (this.verticalVelocity < -0.2 && this.hopTime < 0.8) {
          out.hop = true;
          this.hopRising = false;
        } else if (this.hopTime > 0.8 || handY < this.hopOrigin - 0.02) this.hopRising = false;
      }
    } else {
      const flap = this.flyCycle.update(dt, handY);
      out.fly = flap && Math.abs(yLeft - yRight) < 0.10;
    }
    return out;
  }

  reset(): void {
    this.handMask = 0;
    this.state.giant = this.state.tiny = false;
    this.state.scale = 1;
    this.resetMotion();
  }

  private resetMotion(): void {
    this.barkCycle.reset();
    this.fanCycle.reset();
    this.flyCycle.reset();
    this.jaw = this.spread = this.y = NaN;
    this.beak[0] = this.beak[1] = NaN;
    this.beakArmed[0] = this.beakArmed[1] = false;
    this.beakTime[0] = this.beakTime[1] = 0;
    this.snaps[0] = this.snaps[1] = 0;
    this.verticalVelocity = 0;
    this.hopRising = false;
    this.hopTime = 0;
  }
}

import type { FormState } from './forms.js';
import type { GestureState } from './gestures.js';
import type { Ability, JourneyObstacle, JourneyPlan, ObstacleKind } from './generator.js';

export interface JourneyInput {
  form: FormState;
  formId: string;
  gesture: GestureState;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
}

export interface JourneyEvent {
  kind: 'pickup' | 'solve' | 'arrival' | 'hint';
  obstacle?: ObstacleKind;
  ability?: Ability;
}

export class JourneyRuntime {
  readonly spark = { x: -0.42, y: -0.18, vx: 0, vy: 0 };
  readonly states: ('blocked' | 'solved' | 'passed')[];
  readonly plan: JourneyPlan;
  index = 0;
  carried = false;
  completed = false;
  wait = 0;
  hint = false;
  event: JourneyEvent | null = null;
  private count = 0;
  private hold = 0;
  private started = false;

  constructor(plan: JourneyPlan) {
    this.plan = plan;
    this.states = plan.obstacles.map(() => 'blocked');
  }

  get current(): JourneyObstacle | undefined { return this.plan.obstacles[this.index]; }

  update(dt: number, input: JourneyInput): void {
    this.event = null;
    if (this.completed || dt <= 0) return;
    const form = input.form.stable && input.form.form >= 0;
    if (form && !this.carried && Math.hypot(input.x - this.spark.x, input.y - this.spark.y) < 0.09) {
      this.carried = true;
      this.event = { kind: 'pickup' };
    }
    if (!form) this.carried = false;
    let desiredX = this.carried ? input.anchorX : this.spark.x;
    const obstacle = this.current;
    if (obstacle && this.states[this.index] === 'blocked') desiredX = Math.min(desiredX, obstacle.x - 0.025);
    const desiredY = this.carried ? input.anchorY : -0.18;
    const step = Math.min(dt, 0.05);
    this.spark.vx += (desiredX - this.spark.x) * step * 90;
    this.spark.vy += (desiredY - this.spark.y) * step * 90;
    this.spark.vx *= Math.max(0, 1 - step * 14);
    this.spark.vy *= Math.max(0, 1 - step * 14);
    this.spark.x += this.spark.vx * step;
    this.spark.y += this.spark.vy * step;
    if (!obstacle) {
      if (this.carried && this.spark.x >= 0.35 && Math.abs(this.spark.y + 0.12) < 0.19) {
        this.completed = true;
        this.event = { kind: 'arrival' };
      }
      return;
    }
    if (this.states[this.index] === 'solved') {
      if (this.carried && this.spark.x >= obstacle.x + 0.035) {
        this.states[this.index++] = 'passed';
        this.wait = this.count = this.hold = 0;
        this.hint = false;
        this.started = false;
      }
      return;
    }
    if (!this.started && this.carried && this.spark.x >= obstacle.x - 0.16) this.started = true;
    if (this.started) this.wait += dt;
    if (!this.hint && this.wait >= 12) { this.hint = true; this.event = { kind: 'hint', obstacle: obstacle.kind }; }
    const atZone = this.carried && Math.abs(input.x - obstacle.x) <= 0.12
      && Math.abs(input.y + 0.10) <= 0.22 && Math.abs(this.spark.x - obstacle.x) <= 0.16;
    if (!atZone) { this.hold = 0; return; }
    const gesture = input.gesture;
    const correct = obstacle.kind === 'crow' ? input.formId === 'dog' && input.x < obstacle.x && gesture.bark
      : obstacle.kind === 'vine' ? (input.formId === 'heron' || input.formId === 'duck') && gesture.peck
        || input.formId === 'crab' && gesture.snip
      : obstacle.kind === 'gap' ? input.formId === 'rabbit' && gesture.hop
      : obstacle.kind === 'fog' ? input.formId === 'peacock' && gesture.fan
      : obstacle.kind === 'ledge' ? obstacle.ramp ? input.formId === 'rabbit' && gesture.hop
        : input.formId === 'butterfly' && gesture.fly
      : obstacle.kind === 'boulder' ? gesture.giant
      : gesture.tiny;
    const anyGesture = gesture.bark || gesture.peck || gesture.snip || gesture.hop || gesture.fan || gesture.fly
      || gesture.giant || gesture.tiny;
    if (correct && (obstacle.kind === 'fog' || obstacle.ramp)) this.count++;
    const required = obstacle.kind === 'fog' || obstacle.ramp ? 2 : 1;
    this.hold = correct || this.wait >= 25 && form ? this.hold + dt : 0;
    if ((correct && this.count >= required || correct && required === 1 || this.wait >= 25 && form
      && (anyGesture || this.hold >= 1.5))) {
      this.states[this.index] = 'solved';
      this.event = { kind: 'solve', obstacle: obstacle.kind,
        ability: correct ? obstacle.kind === 'vine' ? input.formId === 'crab' ? 'snip' : 'peck'
          : obstacle.ability : undefined };
    }
  }
}

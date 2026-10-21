import type { FormState } from '../journey/forms.js';

export class SummonTrigger {
  readonly holdSeconds = 0.8;
  progress = 0;
  form = -1;
  private released = true;

  update(dt: number, match: FormState, canFire: boolean): boolean {
    const valid = canFire && match.stable && match.form >= 0;
    if (!valid || match.form !== this.form) {
      this.form = valid ? match.form : -1;
      this.progress = 0;
      this.released = true;
      return false;
    }
    if (!this.released) return false;
    this.progress = Math.min(1, this.progress + Math.max(0, dt) / this.holdSeconds);
    if (this.progress < 1) return false;
    this.released = false;
    return true;
  }

  reset(): void { this.form = -1; this.progress = 0; this.released = true; }
}

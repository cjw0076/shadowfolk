import type { HandSource } from '../shadow/async-matcher.js';
import type { BakedTarget } from '../shadow/targets.js';

export interface FormScorer {
  ready: boolean;
  scoreCandidates(indices: readonly number[], hands: readonly HandSource[]): Float32Array;
}

export interface FormState {
  form: number;
  score: number;
  stable: boolean;
}

export class FormTracker {
  private readonly chosen: number[] = [];
  private readonly state: FormState = { form: -1, score: 0, stable: false };
  private belowFor = 0;
  private preferredFor = 0;

  constructor(private readonly targets: readonly BakedTarget[], private readonly scorer: FormScorer) {}

  update(dt: number, hands: readonly HandSource[], candidates: readonly number[], preferred = -1): FormState {
    let count = 0;
    for (let index = 0; index < candidates.length && count < 4; index++) {
      const candidate = candidates[index];
      if (!Number.isInteger(candidate) || candidate < 0 || candidate >= this.targets.length) continue;
      let duplicate = false;
      for (let prior = 0; prior < count; prior++) if (this.chosen[prior] === candidate) duplicate = true;
      if (!duplicate) this.chosen[count++] = candidate;
    }
    if (this.state.form >= 0) {
      let present = false;
      for (let index = 0; index < count; index++) if (this.chosen[index] === this.state.form) present = true;
      if (!present) this.chosen[Math.min(count++, 3)] = this.state.form;
    }
    this.chosen.length = Math.min(count, 4);
    const selected = this.chosen;
    const scores = this.scorer.scoreCandidates(selected, hands);
    if (!this.scorer.ready) return this.state;

    let bestForm = -1;
    let bestScore = 0;
    let bestRatio = 0;
    let currentScore = 0;
    let currentPresent = false;
    let preferredScore = 0;
    let handCount = 0;
    for (let index = 0; index < hands.length; index++) {
      if (hands[index].valid && hands[index].flat.valid) handCount++;
    }
    for (let index = 0; index < selected.length; index++) {
      const candidate = selected[index];
      const target = this.targets[candidate];
      const value = handCount === 0 || target.partner && handCount < 2 ? 0 : scores[index];
      if (candidate === this.state.form) { currentScore = value; currentPresent = true; }
      if (candidate === preferred) preferredScore = value;
      const ratio = value / target.pass;
      if (ratio >= 0.9 && ratio > bestRatio) {
        bestRatio = ratio;
        bestScore = value;
        bestForm = candidate;
      }
    }

    if (this.state.form < 0) {
      if (bestForm >= 0) {
        this.state.form = bestForm;
        this.state.score = bestScore;
        this.state.stable = true;
      } else {
        this.state.score = 0;
        this.state.stable = false;
      }
      return this.state;
    }

    this.state.score = currentPresent ? currentScore : 0;
    if (preferred >= 0 && preferred !== this.state.form
      && preferredScore >= 0.9 * this.targets[preferred].pass) {
      this.preferredFor += Math.max(0, dt);
      if (this.preferredFor >= 0.25) {
        this.state.form = preferred;
        this.state.score = preferredScore;
        this.state.stable = true;
        this.belowFor = this.preferredFor = 0;
        return this.state;
      }
    } else this.preferredFor = 0;
    if (this.state.score < 0.75 * this.targets[this.state.form].pass) {
      this.belowFor += Math.max(0, dt);
      if (this.belowFor >= 0.35) {
        this.state.form = bestForm;
        this.state.score = bestForm >= 0 ? bestScore : 0;
        this.state.stable = bestForm >= 0;
        this.belowFor = 0;
      }
    } else {
      this.belowFor = 0;
    }
    return this.state;
  }

  reset(): void {
    this.state.form = -1;
    this.state.score = 0;
    this.state.stable = false;
    this.belowFor = 0;
    this.preferredFor = 0;
  }
}

import { FormTracker } from '../src/journey/forms.js';
import { GestureDetector } from '../src/journey/gestures.js';
import type { HandSource } from '../src/shadow/async-matcher.js';
import { drawHand, FlatHand, Mask, Matcher } from '../src/shadow/silhouette.js';
import { TARGETS, bakeTarget, type BakedTarget } from '../src/shadow/targets.js';
import {
  JOURNEY_P1_GESTURES, JOURNEY_P1_LANTERN, generateJourneyP1Sequence, negativeKindAt,
} from './journey-p1-sequences.js';
import type { JourneyP1Gesture, JourneyP1NegativeKind } from './journey-p1-sequences.js';

const TRUE_SEQUENCES = 40;
const NEGATIVE_SEQUENCES = 200;
const CANDIDATE_COUNT = 4;
const FORM_SCORE_REFRESH_HZ = 15;
const FORM_HOLD_TARGET = 0.95;
const TRUE_DETECTION_TARGET = 0.95;
const FALSE_TRIGGER_TARGET = 0.02;
const CONFUSION_TARGET = 0.97;
const GIANT_SCALE_TARGET = 1.35;
const TINY_SCALE_TARGET = 0.78;

interface FormResult {
  form: number;
  score: number;
  stable: boolean;
}

interface GestureResult {
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

interface GestureMetrics {
  detected: number;
  falseTriggers: number;
  formHeld: number;
  stableHeld: number;
  formFrames: number;
  missScores: number[];
  falseByKind: Record<JourneyP1NegativeKind, number>;
  candidates: Record<JourneyP1NegativeKind, number>;
  scalePeak: number;
  scaleFloor: number;
  signalQualified: number;
  signalRangeMin: number;
  signalRangeMax: number;
}

class SynchronousMatcherScorer {
  ready = true;
  private readonly unionMask = new Mask(170, 120, -0.68, -0.48, 0.008);
  private readonly individualMasks = Array.from({ length: 4 }, () => new Mask(170, 120, -0.68, -0.48, 0.008));
  private readonly matcher = new Matcher();
  private readonly scores = new Float32Array(4);
  private readonly cachedIndices = new Int16Array(4).fill(-1);
  private cachedCount = -1;
  private currentTime = 0;
  private lastRefreshTime = -Infinity;

  constructor(private readonly baked: readonly BakedTarget[]) {}

  setTime(time: number): void {
    if (time < this.currentTime) this.resetSequence();
    this.currentTime = time;
  }

  resetSequence(): void {
    this.cachedIndices.fill(-1);
    this.cachedCount = -1;
    this.currentTime = 0;
    this.lastRefreshTime = -Infinity;
    this.scores.fill(0);
  }

  scoreCandidates(indices: readonly number[], hands: readonly HandSource[]): Float32Array {
    const count = Math.min(indices.length, this.scores.length);
    let candidatesChanged = count !== this.cachedCount;
    for (let index = 0; index < this.cachedIndices.length; index++) {
      const candidate = index < count ? indices[index] : -1;
      if (candidate !== this.cachedIndices[index]) candidatesChanged = true;
    }
    if (candidatesChanged) {
      this.scores.fill(0);
      this.cachedIndices.fill(-1);
      for (let index = 0; index < count; index++) this.cachedIndices[index] = indices[index];
      this.cachedCount = count;
    } else if (this.currentTime - this.lastRefreshTime < 1 / FORM_SCORE_REFRESH_HZ) {
      return this.scores;
    }

    this.unionMask.clear();
    for (const mask of this.individualMasks) mask.clear();
    this.scores.fill(0);
    for (let handIndex = 0; handIndex < hands.length && handIndex < this.individualMasks.length; handIndex++) {
      const hand = hands[handIndex];
      if (!hand.valid || !hand.flat.valid) continue;
      drawHand(this.unionMask, hand.flat);
      drawHand(this.individualMasks[handIndex], hand.flat);
    }
    for (let index = 0; index < count; index++) {
      const targetIndex = indices[index];
      const target = this.baked[targetIndex];
      if (!target) throw new Error(`FormTracker requested unknown target index ${indices[index]}`);
      if (target.partner) {
        this.scores[index] = this.matcher.score(this.unionMask, target.template);
      } else {
        let best = 0;
        for (let handIndex = 0; handIndex < hands.length && handIndex < this.individualMasks.length; handIndex++) {
          const hand = hands[handIndex];
          if (hand.valid && hand.flat.valid) {
            best = Math.max(best, this.matcher.score(this.individualMasks[handIndex], target.template));
          }
        }
        this.scores[index] = best;
      }
    }
    this.lastRefreshTime = this.currentTime;
    return this.scores;
  }
}

function seeded(seed: number): () => number {
  let state = (Math.trunc(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseCandidates(targetIndex: number, seed: number): number[] {
  const random = seeded(seed);
  const candidates = [targetIndex];
  while (candidates.length < CANDIDATE_COUNT) {
    const next = Math.floor(random() * TARGETS.length);
    if (!candidates.includes(next)) candidates.push(next);
  }
  for (let index = candidates.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }
  return candidates;
}

function isGestureActive(result: GestureResult, gesture: JourneyP1Gesture): boolean {
  if (gesture === 'giant' || gesture === 'tiny') return result[gesture];
  return result[gesture];
}

function newMetrics(): GestureMetrics {
  const zeroes = (): Record<JourneyP1NegativeKind, number> => ({
    relaxed: 0, 'held-creature': 0, 'slow-drift': 0, 'two-hand-idle': 0,
  });
  return {
    detected: 0,
    falseTriggers: 0,
    formHeld: 0,
    stableHeld: 0,
    formFrames: 0,
    missScores: [],
    falseByKind: zeroes(),
    candidates: zeroes(),
    scalePeak: -Infinity,
    scaleFloor: Infinity,
    signalQualified: 0,
    signalRangeMin: Infinity,
    signalRangeMax: 0,
  };
}

function targetForTrueTrial(gesture: JourneyP1Gesture, trial: number): string | undefined {
  if (gesture === 'peck') return trial % 2 === 0 ? 'duck' : 'heron';
  return undefined;
}

function runTrueTrial(
  gesture: JourneyP1Gesture,
  trial: number,
  tracker: FormTracker,
  scorer: SynchronousMatcherScorer,
  baked: readonly BakedTarget[],
  metrics: GestureMetrics,
): void {
  const seed = 0x170000 + JOURNEY_P1_GESTURES.indexOf(gesture) * 10000 + trial * 17 + 1;
  const sequence = generateJourneyP1Sequence({
    gesture,
    scenario: 'true',
    seed,
    targetId: targetForTrueTrial(gesture, trial),
  });
  const detector = new GestureDetector();
  const candidates = chooseCandidates(sequence.targetIndex, seed + 71);
  let detected = false;
  let minFormScore = Infinity;
  let signalMin = Infinity;
  let signalMax = -Infinity;
  const pinchMin = [Infinity, Infinity];
  const pinchMax = [-Infinity, -Infinity];
  let upwardVelocityPeak = -Infinity;
  let downwardVelocityFloor = Infinity;
  const entryScore = baked[sequence.targetIndex].pass * 0.9;
  tracker.reset();
  scorer.resetSequence();

  for (const sample of sequence.samples) {
    const gestureResult = detector.update(sample.dt, sample.hands, JOURNEY_P1_LANTERN, sample.frame) as GestureResult;
    if (sample.time >= sequence.gestureStart) {
      if (isGestureActive(gestureResult, gesture)) detected = true;
      const observeSignal = (value: number) => {
        if (!Number.isFinite(value)) return;
        signalMin = Math.min(signalMin, value);
        signalMax = Math.max(signalMax, value);
      };
      if (gesture === 'bark') observeSignal(gestureResult.jaw);
      else if (gesture === 'peck' || gesture === 'snip') {
        for (let handIndex = 0; handIndex < sample.hands.length; handIndex++) {
          const hand = sample.hands[handIndex];
          if (!hand.valid) continue;
          const distance = tipDistance(hand.joints, 4, 9);
          pinchMin[handIndex] = Math.min(pinchMin[handIndex], distance);
          pinchMax[handIndex] = Math.max(pinchMax[handIndex], distance);
          observeSignal(distance);
        }
      } else if (gesture === 'fan') observeSignal(gestureResult.spread);
      else if (gesture === 'hop') {
        observeSignal(gestureResult.verticalVelocity);
        upwardVelocityPeak = Math.max(upwardVelocityPeak, gestureResult.verticalVelocity);
        downwardVelocityFloor = Math.min(downwardVelocityFloor, gestureResult.verticalVelocity);
      } else if (gesture === 'fly') observeSignal(averageJointY(sample.hands));
      else observeSignal(gestureResult.scale);
      if (Number.isFinite(gestureResult.scale)) {
        if (gesture === 'giant') metrics.scalePeak = Math.max(metrics.scalePeak, gestureResult.scale);
        if (gesture === 'tiny') metrics.scaleFloor = Math.min(metrics.scaleFloor, gestureResult.scale);
      }
    }

    scorer.setTime(sample.time);
    const formResult = tracker.update(sample.dt, sample.hands, candidates) as FormResult;
    if (sample.time >= sequence.gestureStart) {
      metrics.formFrames++;
      if (formResult.form === sequence.targetIndex) {
        metrics.formHeld++;
        if (formResult.stable) metrics.stableHeld++;
      }
      minFormScore = Math.min(minFormScore, formResult.score);
    }
  }

  const signalRange = signalMax - signalMin;
  const qualifies = gesture === 'bark' ? signalRange >= 0.025
    : gesture === 'peck' ? pinchMax[0] > 0.04 && pinchMin[0] < 0.02
      : gesture === 'snip' ? pinchMax.every((maximum) => maximum > 0.04) && pinchMin.every((minimum) => minimum < 0.02)
        : gesture === 'hop' ? upwardVelocityPeak > 0.6 && downwardVelocityFloor < -0.2
          : gesture === 'fan' ? signalRange >= 0.036
            : gesture === 'fly' ? signalRange >= 0.066
              : gesture === 'giant' ? signalMax >= GIANT_SCALE_TARGET : signalMin <= TINY_SCALE_TARGET;
  if (qualifies) metrics.signalQualified++;
  metrics.signalRangeMin = Math.min(metrics.signalRangeMin, signalRange);
  metrics.signalRangeMax = Math.max(metrics.signalRangeMax, signalRange);
  if (detected) metrics.detected++;
  else metrics.missScores.push(minFormScore - entryScore);
}

function runNegativeTrial(
  gesture: JourneyP1Gesture,
  trial: number,
  metrics: GestureMetrics,
): void {
  const seed = 0x270000 + JOURNEY_P1_GESTURES.indexOf(gesture) * 100000 + trial * 29 + 3;
  const negativeKind = negativeKindAt(trial);
  const sequence = generateJourneyP1Sequence({ gesture, scenario: 'negative', seed, negativeKind });
  const detector = new GestureDetector();
  let triggered = false;
  for (const sample of sequence.samples) {
    const result = detector.update(sample.dt, sample.hands, JOURNEY_P1_LANTERN, sample.frame) as GestureResult;
    if (isGestureActive(result, gesture)) triggered = true;
  }
  metrics.candidates[negativeKind]++;
  if (triggered) {
    metrics.falseTriggers++;
    metrics.falseByKind[negativeKind]++;
  }
}

function updateFormSequence(
  tracker: FormTracker,
  scorer: SynchronousMatcherScorer,
  sequence: ReturnType<typeof generateJourneyP1Sequence>,
  candidates: number[],
): FormResult {
  let result: FormResult = { form: -1, score: 0, stable: false };
  tracker.reset();
  scorer.resetSequence();
  for (const sample of sequence.samples) {
    scorer.setTime(sample.time);
    result = tracker.update(sample.dt, sample.hands, candidates) as FormResult;
  }
  return result;
}

function runConfusionMatrix(
  tracker: FormTracker,
  scorer: SynchronousMatcherScorer,
): { counts: number[][]; correct: number; total: number } {
  const counts = Array.from({ length: TARGETS.length }, () => Array(TARGETS.length + 1).fill(0) as number[]);
  let correct = 0;
  let total = 0;
  for (let target = 0; target < TARGETS.length; target++) {
    for (let trial = 0; trial < TRUE_SEQUENCES; trial++) {
      const seed = 0x370000 + target * 1000 + trial * 31 + 7;
      const sequence = generateJourneyP1Sequence({
        gesture: 'bark', scenario: 'held', seed, targetId: TARGETS[target].id,
      });
      const result = updateFormSequence(tracker, scorer, sequence, chooseCandidates(target, seed + 13));
      const prediction = result.form >= 0 && result.form < TARGETS.length ? result.form : TARGETS.length;
      counts[target][prediction]++;
      if (prediction === target) correct++;
      total++;
    }
  }
  return { counts, correct, total };
}

function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => (row[column] ?? '').length),
  ));
  const format = (values: readonly string[]) => `| ${values.map((value, i) => value.padEnd(widths[i])).join(' | ')} |`;
  console.log(format(headers));
  console.log(`| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`);
  for (const row of rows) console.log(format(row));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function tipDistance(joints: Float32Array, first: number, second: number): number {
  const a = first * 3, b = second * 3;
  return Math.hypot(joints[a] - joints[b], joints[a + 1] - joints[b + 1], joints[a + 2] - joints[b + 2]);
}

function averageJointY(hands: readonly { joints: Float32Array; valid: boolean }[]): number {
  let total = 0, count = 0;
  for (const hand of hands) {
    if (!hand.valid) continue;
    for (let joint = 0; joint < 25; joint++) total += hand.joints[joint * 3 + 1];
    count += 25;
  }
  return count ? total / count : NaN;
}

function signalCriterion(gesture: JourneyP1Gesture): string {
  switch (gesture) {
    case 'bark': return 'jaw range ≥25 mm';
    case 'peck': return 'thumb-index >40 mm then <20 mm';
    case 'snip': return 'both thumb-index pairs >40 mm then <20 mm';
    case 'hop': return 'vertical velocity >0.6 then <-0.2 m/s';
    case 'fan': return 'finger-spread excursion ≥36 mm';
    case 'fly': return 'hand-center vertical excursion ≥66 mm';
    case 'giant': return 'scale ≥1.35×';
    case 'tiny': return 'scale ≤0.78×';
  }
}

function checkHysteresis(baked: readonly BakedTarget[]): void {
  const scores = new Float32Array(4);
  const scorer = { ready: true, scoreCandidates: () => scores };
  const tracker = new FormTracker(baked, scorer);
  const hand = { valid: true, flat: new FlatHand() };
  hand.flat.valid = true;
  const target = 0;
  const pass = baked[target].pass;
  scores[0] = pass * 0.9 - 0.001;
  if (tracker.update(0.01, [hand], [target]).form !== -1) throw new Error('form entered below 0.9× pass');
  scores[0] = pass * 0.9;
  if (tracker.update(0.01, [hand], [target]).form !== target) throw new Error('form did not enter at 0.9× pass');
  scores[0] = pass * 0.75 - 0.001;
  if (tracker.update(0.34, [hand], [target]).form !== target) throw new Error('form left before 0.35 s');
  scores[0] = pass * 0.75;
  tracker.update(0.02, [hand], [target]);
  scores[0] = pass * 0.75 - 0.001;
  tracker.update(0.34, [hand], [target]);
  if (tracker.update(0.02, [hand], [target]).form !== -1) throw new Error('form did not leave after 0.35 s');
  scores[0] = pass;
  if (tracker.update(0.02, [], [target]).form !== -1) throw new Error('stale score entered without a hand');
  const pair = baked.findIndex((entry) => entry.def.id === 'crab');
  scores[0] = baked[pair].pass;
  if (tracker.update(0.02, [hand], [pair]).form !== -1) throw new Error('paired form entered with one hand');
  if (tracker.update(0.02, [hand, hand], [pair]).form !== pair) throw new Error('paired form did not enter with two hands');
  console.log('PASS: form enter/leave hysteresis, tracking loss, and two-hand guard');
}

function main(): void {
  const baked = TARGETS.map(bakeTarget);
  checkHysteresis(baked);
  const scorer = new SynchronousMatcherScorer(baked);
  const formTracker = new FormTracker(baked, scorer);
  const metrics = new Map<JourneyP1Gesture, GestureMetrics>();

  for (const gesture of JOURNEY_P1_GESTURES) {
    const current = newMetrics();
    metrics.set(gesture, current);
    for (let trial = 0; trial < TRUE_SEQUENCES; trial++) {
      runTrueTrial(gesture, trial, formTracker, scorer, baked, current);
    }
    for (let trial = 0; trial < NEGATIVE_SEQUENCES; trial++) {
      runNegativeTrial(gesture, trial, current);
    }
  }

  const confusionTracker = new FormTracker(baked, scorer);
  const confusion = runConfusionMatrix(confusionTracker, scorer);
  const rows = JOURNEY_P1_GESTURES.map((gesture) => {
    const value = metrics.get(gesture)!;
    const trueRate = value.detected / TRUE_SEQUENCES;
    const falseRate = value.falseTriggers / NEGATIVE_SEQUENCES;
    const holdRate = value.formFrames ? value.formHeld / value.formFrames : 0;
    const stableRate = value.formFrames ? value.stableHeld / value.formFrames : 0;
    const scalePass = gesture === 'giant' ? value.scalePeak >= GIANT_SCALE_TARGET
      : gesture === 'tiny' ? value.scaleFloor <= TINY_SCALE_TARGET : true;
    const verdict = trueRate >= TRUE_DETECTION_TARGET && falseRate <= FALSE_TRIGGER_TARGET
      && holdRate >= FORM_HOLD_TARGET && scalePass ? 'PASS' : 'FAIL';
    return [
      gesture,
      `${value.detected}/${TRUE_SEQUENCES} ${percent(trueRate)}`,
      `${value.falseTriggers}/${NEGATIVE_SEQUENCES} ${percent(falseRate)}`,
      `${percent(holdRate)} (${value.formHeld}/${value.formFrames})`,
      percent(stableRate),
      gesture === 'giant' ? `${value.scalePeak.toFixed(2)}× max` : gesture === 'tiny' ? `${value.scaleFloor.toFixed(2)}× min` : '—',
      verdict,
    ];
  });

  console.log('Synthetic Journey P1 bench');
  console.log('Sequences: 40 true and 200 negative per gesture; deterministic seeds; 30–90 Hz; ±5° yaw; joint noise σ=4–6 mm.');
  console.log(`Form matcher refresh: ≤${FORM_SCORE_REFRESH_HZ} Hz; cached scores invalidate on sequence or candidate changes.`);
  console.log('Form hold is the fraction of gesture-window frames where FormTracker.form remains the target.');
  printTable(['Gesture', 'True detection (≥95%)', 'False trigger (≤2%)', 'Form hold (≥95%)', 'Stable target', 'Scale', 'Result'], rows);

  const signalRows = JOURNEY_P1_GESTURES.map((gesture) => {
    const value = metrics.get(gesture)!;
    return [
      gesture,
      signalCriterion(gesture),
      `${value.signalQualified}/${TRUE_SEQUENCES}`,
      `${value.signalRangeMin.toFixed(3)}–${value.signalRangeMax.toFixed(3)}`,
    ];
  });
  console.log('\nPhysical signal thresholds (diagnostic only; positives count detector events)');
  printTable(['Gesture', 'Physical criterion', 'Sequences reaching criterion', 'Per-sequence excursion range'], signalRows);

  const confusionRows = TARGETS.map((target, index) => [
    target.id,
    ...confusion.counts[index].map((count) => String(count)),
  ]);
  console.log(`\n11-form confusion matrix (held poses; top-1 ${(confusion.correct)}/${confusion.total} = ${percent(confusion.correct / confusion.total)}, target ≥97%)`);
  printTable(['Actual \\ Predicted', ...TARGETS.map((target) => target.id), 'none'], confusionRows);

  const falseRows: string[][] = [];
  for (const gesture of JOURNEY_P1_GESTURES) {
    const value = metrics.get(gesture)!;
    falseRows.push([
      gesture,
      `${value.falseByKind.relaxed}/${value.candidates.relaxed}`,
      `${value.falseByKind['held-creature']}/${value.candidates['held-creature']}`,
      `${value.falseByKind['slow-drift']}/${value.candidates['slow-drift']}`,
      `${value.falseByKind['two-hand-idle']}/${value.candidates['two-hand-idle']}`,
    ]);
  }
  console.log('\nFalse triggers by negative sequence class (triggers / sequences)');
  printTable(['Gesture', 'Relaxed', 'Held creature', 'Slow drift', 'Two-hand idle'], falseRows);

  const failures: string[] = [];
  for (const gesture of JOURNEY_P1_GESTURES) {
    const value = metrics.get(gesture)!;
    const trueRate = value.detected / TRUE_SEQUENCES;
    const falseRate = value.falseTriggers / NEGATIVE_SEQUENCES;
    const holdRate = value.formHeld / value.formFrames;
    if (trueRate < TRUE_DETECTION_TARGET && value.missScores.length) {
      const scoreDips = value.missScores.filter((scoreDelta) => scoreDelta < 0).length;
      const reason = scoreDips > value.missScores.length / 2
        ? 'misses coincide with FormTracker scores below the 0.9× entry threshold; reduce the articulation amplitude by 10% first.'
        : 'form score mostly clears entry; inspect the gesture joint pair or motion direction, then raise only that motion by 10%.';
      failures.push(`${gesture}: ${TRUE_SEQUENCES - value.detected}/${TRUE_SEQUENCES} misses; ${reason}`);
    }
    if (falseRate > FALSE_TRIGGER_TARGET) {
      const worst = Object.entries(value.falseByKind).sort((a, b) => b[1] - a[1])[0];
      failures.push(`${gesture}: false triggers cluster in ${worst[0]} (${worst[1]}); tighten the smallest gesture-specific excursion before changing a detector threshold.`);
    }
    if (holdRate < FORM_HOLD_TARGET) {
      failures.push(`${gesture}: form hold ${percent(holdRate)}; reduce the gesture articulation that causes the largest shadow change before changing form thresholds.`);
    }
  }
  if (confusion.correct / confusion.total < CONFUSION_TARGET) {
    failures.push(`form confusion: ${confusion.total - confusion.correct}/${confusion.total} held poses are not top-1; inspect the implicated template pairs before changing thresholds.`);
  }
  console.log('\nFailure diagnosis');
  if (failures.length) for (const failure of failures) console.log(`- ${failure}`);
  else console.log('All measured targets pass; no pose or threshold adjustment suggested.');

  const allPass = rows.every((row) => row[6] === 'PASS') && confusion.correct / confusion.total >= CONFUSION_TARGET;
  console.log(`\n${allPass ? 'PASS' : 'FAIL'}: synthetic Journey P1 acceptance`);

  const summary = {
    bench: 'synthetic-codex-17-journey-p1',
    conditions: {
      trueSequencesPerGesture: TRUE_SEQUENCES,
      negativeSequencesPerGesture: NEGATIVE_SEQUENCES,
      candidatesPerFormRequest: CANDIDATE_COUNT,
      formScoreRefreshHz: FORM_SCORE_REFRESH_HZ,
      sampleRateHz: [30, 90],
      yawDegrees: [-5, 5],
      jointNoiseSigmaMeters: [0.004, 0.006],
      negativeClasses: ['relaxed', 'held-creature', 'slow-drift', 'two-hand-idle'],
      formHoldWindow: 'gesture interval only',
    },
    targets: {
      trueDetectionRate: TRUE_DETECTION_TARGET,
      falseTriggerRate: FALSE_TRIGGER_TARGET,
      formHoldRate: FORM_HOLD_TARGET,
      heldPoseTop1Accuracy: CONFUSION_TARGET,
      giantScale: GIANT_SCALE_TARGET,
      tinyScale: TINY_SCALE_TARGET,
    },
    gestures: Object.fromEntries(JOURNEY_P1_GESTURES.map((gesture) => {
      const value = metrics.get(gesture)!;
      const trueRate = value.detected / TRUE_SEQUENCES;
      const falseRate = value.falseTriggers / NEGATIVE_SEQUENCES;
      const holdRate = value.formFrames ? value.formHeld / value.formFrames : 0;
      const stableRate = value.formFrames ? value.stableHeld / value.formFrames : 0;
      const scalePass = gesture === 'giant' ? value.scalePeak >= GIANT_SCALE_TARGET
        : gesture === 'tiny' ? value.scaleFloor <= TINY_SCALE_TARGET : true;
      return [gesture, {
        true: { detected: value.detected, total: TRUE_SEQUENCES, rate: trueRate },
        negative: {
          falseTriggers: value.falseTriggers,
          total: NEGATIVE_SEQUENCES,
          rate: falseRate,
          byClass: Object.fromEntries(Object.keys(value.candidates).map((kind) => [kind, {
            falseTriggers: value.falseByKind[kind as JourneyP1NegativeKind],
            sequences: value.candidates[kind as JourneyP1NegativeKind],
          }])),
        },
        formHold: {
          correctFrames: value.formHeld,
          stableCorrectFrames: value.stableHeld,
          totalFrames: value.formFrames,
          rate: holdRate,
          stableRate,
        },
        scale: gesture === 'giant' ? { max: value.scalePeak, pass: scalePass }
          : gesture === 'tiny' ? { min: value.scaleFloor, pass: scalePass } : null,
        signal: {
          criterion: signalCriterion(gesture),
          thresholdQualifiedSequences: value.signalQualified,
          total: TRUE_SEQUENCES,
          minSequenceExcursion: value.signalRangeMin,
          maxSequenceExcursion: value.signalRangeMax,
          diagnosticOnly: true,
        },
        pass: trueRate >= TRUE_DETECTION_TARGET && falseRate <= FALSE_TRIGGER_TARGET
          && holdRate >= FORM_HOLD_TARGET && scalePass,
      }];
    })),
    confusion: {
      labels: TARGETS.map((target) => target.id),
      rejectionLabel: 'none',
      matrix: confusion.counts,
      total: confusion.total,
      correct: confusion.correct,
      top1Accuracy: confusion.correct / confusion.total,
      pass: confusion.correct / confusion.total >= CONFUSION_TARGET,
    },
    failures,
    pass: allPass,
  };
  console.log('\nJSON summary');
  console.log(JSON.stringify(summary, null, 2));
  if (!allPass) {
    const runtime = globalThis as typeof globalThis & { process?: { exitCode?: number } };
    if (runtime.process) runtime.process.exitCode = 1;
  }
}

main();

import assert from 'node:assert/strict';
import { abilityForForm, generateJourney, type ObstacleKind, type JourneyPlan } from '../src/journey/generator.js';
import { JourneyRuntime, type JourneyInput } from '../src/journey/runtime.js';

const gesture = { bark: false, peck: false, snip: false, hop: false, fan: false, fly: false,
  scale: 1, giant: false, tiny: false, jaw: 0, beak: 0, spread: 0, verticalVelocity: 0 };
const input: JourneyInput = { form: { form: 0, score: 1, stable: true }, formId: 'dog', gesture,
  x: -0.42, y: -0.10, anchorX: -0.42, anchorY: -0.12 };
const kinds: ObstacleKind[] = ['crow', 'vine', 'gap', 'fog', 'ledge', 'boulder', 'crack'];
const formFor: Record<ObstacleKind, string> = { crow: 'dog', vine: 'heron', gap: 'rabbit', fog: 'peacock',
  ledge: 'butterfly', boulder: 'dog', crack: 'dog' };
const gestureFor: Record<ObstacleKind, keyof typeof gesture> = { crow: 'bark', vine: 'peck', gap: 'hop',
  fog: 'fan', ledge: 'fly', boulder: 'giant', crack: 'tiny' };
const run = (runtime: JourneyRuntime, x: number, seconds: number) => {
  input.x = input.anchorX = x;
  for (let frame = 0; frame < Math.ceil(seconds * 60); frame++) runtime.update(1 / 60, input);
};
const plan = (kind: ObstacleKind, ramp = false): JourneyPlan => ({ day: 42, night: 3,
  obstacles: [{ kind, ability: gestureFor[kind] as JourneyPlan['obstacles'][number]['ability'],
    x: -0.05, combined: false, ramp }] });

for (let night = 1; night <= 6; night++) {
  const learned = ['peacock', 'rabbit', 'snail', 'fish', 'duck', 'butterfly', 'heron', 'stag', 'crab', 'dog']
    .slice(0, 4 + night);
  const newcomer = learned.at(-1)!;
  const first = generateJourney(20378, night, learned, newcomer);
  const second = generateJourney(20378, night, learned, newcomer);
  assert.deepEqual(first, second, `night ${night} deterministic`);
  assert.equal(first.obstacles.length, Math.min(5, 3 + Math.floor((night - 1) / 2)));
  assert.ok(first.obstacles.some((obstacle) => obstacle.ability === abilityForForm(newcomer)), `night ${night} newcomer`);
  for (let index = 1; index < first.obstacles.length; index++) {
    assert.ok(first.obstacles[index].x >= first.obstacles[index - 1].x, `night ${night} left-to-right path`);
  }
  const available = new Set(learned.map(abilityForForm));
  available.add('giant'); available.add('tiny');
  for (const obstacle of first.obstacles) assert.ok(available.has(obstacle.ability), `night ${night} learned ${obstacle.ability}`);
  if (night >= 4 && first.obstacles.some((obstacle) => obstacle.kind === 'boulder')
    && first.obstacles.some((obstacle) => obstacle.kind === 'crow' || obstacle.kind === 'vine')) {
    assert.ok(first.obstacles.some((obstacle) => obstacle.combined), `night ${night} combined obstacle`);
  }
  console.log(`PASS: generator night ${night}: ${first.obstacles.map((obstacle) => obstacle.kind).join(',')}`);
}

for (const kind of kinds) {
  const runtime = new JourneyRuntime(plan(kind));
  input.form.stable = true; input.form.form = 0;
  input.formId = formFor[kind];
  Object.assign(gesture, { bark: false, peck: false, snip: false, hop: false, fan: false, fly: false, giant: false, tiny: false });
  run(runtime, -0.42, 0.1);
  assert.ok(runtime.carried, `${kind} pickup`);
  run(runtime, 0.25, 2);
  assert.equal(runtime.states[0], 'blocked', `${kind} wrong location rejected`);
  assert.ok(runtime.spark.x <= -0.05, `${kind} barrier holds spark`);
  run(runtime, -0.09, 1);
  const wrongForm = input.formId;
  input.formId = 'fish';
  if (kind !== 'boulder' && kind !== 'crack') gesture[gestureFor[kind]] = true;
  runtime.update(1 / 60, input);
  if (kind !== 'boulder' && kind !== 'crack') assert.equal(runtime.states[0], 'blocked', `${kind} wrong form rejected`);
  input.formId = wrongForm;
  gesture[gestureFor[kind]] = false;
  input.form.stable = false;
  runtime.update(1 / 60, input);
  assert.ok(!runtime.carried, `${kind} drop`);
  gesture[gestureFor[kind]] = true;
  runtime.update(1 / 60, input);
  assert.equal(runtime.states[0], 'blocked', `${kind} uncarried gesture rejected`);
  gesture[gestureFor[kind]] = false;
  input.form.stable = true;
  run(runtime, runtime.spark.x, 0.2);
  run(runtime, -0.09, 1);
  gesture[gestureFor[kind]] = true;
  runtime.update(1 / 60, input);
  if (kind === 'fog') {
    assert.equal(runtime.states[0], 'blocked', 'fog needs two fans');
    runtime.update(1 / 60, input);
  }
  assert.equal(runtime.states[0], 'solved', `${kind} positive`);
  gesture[gestureFor[kind]] = false;
  run(runtime, 0.05, 2);
  assert.equal(runtime.index, 1, `${kind} carried across`);
  run(runtime, 0.43, 2);
  assert.ok(runtime.completed, `${kind} moon arrival`);
  console.log(`PASS: ${kind} positive, spatial/form/drop negatives, crossing and arrival`);
}

const ramp = new JourneyRuntime(plan('ledge', true));
input.formId = 'rabbit'; input.form.stable = true;
run(ramp, -0.42, 0.1); run(ramp, -0.09, 2);
gesture.hop = true;
ramp.update(1 / 60, input);
assert.equal(ramp.states[0], 'blocked');
ramp.update(1 / 60, input);
assert.equal(ramp.states[0], 'solved');
gesture.hop = false;
const oneHand = generateJourney(20378, 3, ['peacock', 'rabbit', 'duck', 'butterfly', 'crab'], 'butterfly', true);
assert.ok(oneHand.obstacles.some((obstacle) => obstacle.kind === 'ledge' && obstacle.ability === 'hop' && obstacle.ramp));
assert.ok(oneHand.obstacles.every((obstacle) => obstacle.ability !== 'fly' && obstacle.ability !== 'snip'));
console.log('PASS: one-hand fly-to-hop ramp and snip-to-peck substitution');

const snip = new JourneyRuntime(plan('vine'));
input.formId = 'crab'; input.form.stable = true;
run(snip, -0.42, 0.1); run(snip, -0.09, 1);
gesture.snip = true;
snip.update(1 / 60, input);
assert.equal(snip.states[0], 'solved');
assert.equal(snip.event?.ability, 'snip', 'actual alternative ability is counted');
gesture.snip = false;
console.log('PASS: vine accepts crab snip and records actual ability');

const access = new JourneyRuntime(plan('crow'));
input.formId = 'fish'; input.form.stable = true;
run(access, -0.42, 0.1); run(access, -0.09, 12.6);
assert.ok(access.hint, 'ghost appears at 12s');
assert.equal(access.states[0], 'blocked');
run(access, -0.09, 14.5);
assert.equal(access.states[0], 'solved', 'any stable form and hold yields after 25s');
console.log('PASS: 12s hint and 25s yield');

console.log('PASS: journey P2 state bench');

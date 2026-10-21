import { FolkWorld } from '../src/play/folk.js';
import { InkField } from '../src/play/ink-field.js';
import { MothWorld, type MothHand, type MothStage } from '../src/play/moths.js';

const STEP = 1 / 60;
const stage: MothStage = {
  flame: { x: 0, y: 0, z: 0 },
  paper: { x: 0, y: 0.24, z: -0.75 },
  right: { x: 1, y: 0, z: 0 },
  head: { x: 0, y: 0.3, z: 0.25 },
  moon: { x: 0.4, y: 0.45, z: -0.75 },
};

function handAt(x: number, y: number, z: number): MothHand {
  const joints = new Float32Array(75);
  for (let index = 0; index < joints.length; index += 3) {
    joints[index] = 9; joints[index + 1] = 9; joints[index + 2] = 9;
  }
  joints[27] = x; joints[28] = y; joints[29] = z;
  return { valid: true, joints };
}

function shieldingHand(): MothHand {
  const hand = handAt(9, 9, 9);
  const joints = hand.joints;
  joints[0] = 0; joints[1] = -0.03; joints[2] = 0.12;
  joints[15] = -0.03; joints[16] = 0.03; joints[17] = 0.12;
  joints[60] = 0.03; joints[61] = 0.03; joints[62] = 0.12;
  return hand;
}

function advance(world: MothWorld, seconds: number, hands: MothHand[] = []): void {
  for (let frame = 0; frame < Math.ceil(seconds / STEP); frame++) world.update(STEP, stage, hands);
}

function walkingDistance(speedFactor: number, soft = false): number {
  const field = new InkField();
  field.setStaticRect(-0.5, -0.212, 0.5, -0.196);
  if (soft) {
    for (let row = 0; row < field.h; row++) {
      for (let column = 0; column < field.w; column++) {
        const x = field.x0 + (column + 0.5) * field.cell;
        const y = field.y0 + (row + 0.5) * field.cell;
        if (x > -0.4 && x < 0.4 && y > -0.22 && y < -0.14) field.soft[row * field.w + column] = 1;
      }
    }
  }
  const folk = new FolkWorld(field);
  folk.configure({ waveCount: 0 });
  const agent = folk.spawn(-0.2, -0.185)!;
  folk.walkSpeedFactor = speedFactor;
  for (let frame = 0; frame < 240; frame++) folk.update(STEP);
  return agent.x + 0.2;
}

const path: number[] = [];
const swatNear: boolean[] = [];
const swatFar: boolean[] = [];
const cup: boolean[] = [];
for (let trial = 0; trial < 5; trial++) {
  const world = new MothWorld();
  world.start(6, 21021 + trial * 37, 0.25);
  world.spawn(stage);
  for (let frame = 0; frame < 600 && world.gutters === 0; frame++) world.update(STEP, stage, []);
  path.push(+world.time.toFixed(3));

  const near = new MothWorld();
  near.start(6, 30000 + trial, 0.25);
  const nearMoth = near.spawn(stage)!;
  advance(near, 1.55);
  near.update(STEP, stage, [handAt(nearMoth.x + 0.05, nearMoth.y, nearMoth.z)]);
  swatNear.push(near.shooed === 1 && nearMoth.phase === 'tumble');

  const far = new MothWorld();
  far.start(6, 40000 + trial, 0.25);
  const farMoth = far.spawn(stage)!;
  advance(far, 1.55);
  far.update(STEP, stage, [handAt(farMoth.x + 0.12, farMoth.y, farMoth.z)]);
  swatFar.push(far.shooed === 0);

  const guarded = new MothWorld();
  guarded.start(6, 50000 + trial, 0.25);
  guarded.spawn(stage);
  const hand = shieldingHand();
  advance(guarded, 10, [hand]);
  cup.push(guarded.shielded && guarded.gutters === 0 && guarded.deflections > 0);
}

const normalWalk = walkingDistance(1);
const gutterWalk = walkingDistance(0.5);
const softWalk = walkingDistance(1, true);
const queen = new MothWorld();
queen.start(8, 21021, 0.4);
advance(queen, 17);
const queenPeelsAt15 = queen.agents[queen.agents.length - 1].phase === 'queenOrbit';
queen.beginQueenVictory();
advance(queen, 3.1);
const queenReachesMoon = queen.queenOnMoon;
const victoryClearsSmallMoths = queen.agents.every((agent) => agent.queen || agent.phase === 'hidden');
const festival = new MothWorld();
festival.start(9, 21021, 0.5);
advance(festival, 60);
const festivalHasNoMoths = festival.isFestival && festival.activeCount === 0;
const output = {
  benchmark: 'codex-23-p4-small-moths',
  pathSeconds: path,
  swatAt5cm: swatNear,
  noSwatAt12cm: swatFar,
  cupDeflects: cup,
  queenPeelsAt15, queenReachesMoon, victoryClearsSmallMoths, festivalHasNoMoths,
  walkingMetres: { normal: normalWalk, gutter: gutterWalk, softInk: softWalk },
  pass: path.every((seconds) => seconds >= 6 && seconds <= 9)
    && swatNear.every(Boolean) && swatFar.every(Boolean) && cup.every(Boolean)
    && queenPeelsAt15 && queenReachesMoon && victoryClearsSmallMoths && festivalHasNoMoths
    && Math.abs(gutterWalk / normalWalk - 0.5) < 0.04
    && Math.abs(softWalk / normalWalk - 0.5) < 0.04,
};
console.log(JSON.stringify(output, null, 2));
if (!output.pass) process.exitCode = 1;

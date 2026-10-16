// Bundle like eval-targets.ts; deterministic synthetic poses, no DOM or renderer.
import { performance } from 'node:perf_hooks';
import { JOINT_COUNT, clonePose, mirror, orient } from '../src/shadow/hand-model';
import { FlatHand, Mask, Matcher, STAGE, drawHand, projectFromLight, ScreenFrame } from '../src/shadow/silhouette';
import { TARGETS, bakeTarget } from '../src/shadow/targets';

const FRAMES = 2000, WARMUP = 300;
const mode = process.argv[2] ?? 'one-hand';
if (!['one-hand', 'two-hands', 'near-light'].includes(mode)) throw new Error('Use one-hand, two-hands, or near-light');
const handCount = mode === 'one-hand' ? 1 : 2;
const baked = TARGETS.map(bakeTarget);
const screen: ScreenFrame = {
  ox: 0, oy: STAGE.lightDrop - 0.02, oz: -STAGE.lightToScreen,
  rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, nx: 0, ny: 0, nz: 1,
};
// Prepare centering, mirrored hands and pose variation outside the timed region.
const poses = Array.from({ length: 120 }, (_, k) => {
  const target = baked[k % baked.length];
  let pose = clonePose(target.pose);
  orient(pose, [Math.sin(k) * 12, Math.cos(k * 0.7) * 10, Math.sin(k * 0.4) * 25]);
  if (k % 2) pose = mirror(pose);
  const center = [0, 0, 0];
  for (let j = 0; j < JOINT_COUNT; j++) for (let c = 0; c < 3; c++) center[c] += pose.mats[j * 16 + 12 + c];
  for (let c = 0; c < 3; c++) center[c] /= JOINT_COUNT;
  const dist = mode === 'near-light' ? 0.015 : STAGE.lightToHand + 0.06 * Math.sin(k * 0.3);
  const joints = new Float32Array(JOINT_COUNT * 3);
  for (let j = 0; j < JOINT_COUNT; j++) {
    joints[j * 3] = pose.mats[j * 16 + 12] - center[0] + Math.sin(k) * 0.04;
    joints[j * 3 + 1] = pose.mats[j * 16 + 13] - center[1] + STAGE.lightDrop * dist / STAGE.lightToScreen;
    joints[j * 3 + 2] = pose.mats[j * 16 + 14] - center[2] - dist;
  }
  return { joints, radii: pose.radii, template: target.template };
});
const mask = new Mask(170, 120, -0.68, -0.48, 0.008);
const flat = new FlatHand(), matcher = new Matcher();
function frame(k: number): number {
  const p = poses[k % poses.length];
  mask.clear();
  for (let h = 0; h < handCount; h++) {
    const hand = poses[(k + h * 37) % poses.length];
    projectFromLight(hand.joints, hand.radii, 0, 0, 0, screen, flat);
    drawHand(mask, flat);
  }
  return matcher.score(mask, p.template);
}
for (let k = 0; k < WARMUP; k++) frame(k);
const samples = new Float64Array(FRAMES);
let sum = 0, checksum = 0;
for (let k = 0; k < FRAMES; k++) {
  const start = performance.now();
  checksum += frame(k);
  sum += (samples[k] = performance.now() - start);
}
samples.sort();
console.log(`project -> raster -> Matcher.score: ${FRAMES} frames (${WARMUP} warmup; ${mode})`);
console.log(`mean ${(sum / FRAMES).toFixed(4)} ms/frame; p95 ${samples[Math.ceil(FRAMES * 0.95) - 1].toFixed(4)} ms/frame`);
console.log(`score checksum ${checksum.toFixed(9)}`);

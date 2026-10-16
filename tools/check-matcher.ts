// Strict comparison against the original 14-resample algorithm, including ties.
import assert from 'node:assert/strict';
import { FlatHand, Mask, Matcher, MATCH_ROTATIONS, NORM, drawHand, iou, moments, normalise, projectFromLight, STAGE } from '../src/shadow/silhouette';
import { JOINT_COUNT, clonePose, mirror, orient } from '../src/shadow/hand-model';
import { TARGETS, bakeTarget } from '../src/shadow/targets';
// Original raster implementation, retained as a reference for binary union checks.
class OriginalMask extends Mask {
  capsule(ax: number, ay: number, bx: number, by: number, ra: number, rb: number): void {
    const { w, h, x0, y0, cell, data } = this;
    const rmax = Math.max(ra, rb);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - rmax - x0) / cell));
    const i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + rmax - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - rmax - y0) / cell));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(ay, by) + rmax - y0) / cell));
    const ex = bx - ax, ey = by - ay;
    const len2 = ex * ex + ey * ey || 1e-12;
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell;
        let t = ((px - ax) * ex + (py - ay) * ey) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (ax + ex * t), dy = py - (ay + ey * t);
        const r = ra + (rb - ra) * t;
        if (dx * dx + dy * dy <= r * r) data[j * w + i] = 1;
      }
    }
  }

}
const baked = TARGETS.map(bakeTarget), matcher = new Matcher();
const buf = new Uint8Array(NORM * NORM), mo = { area: 0, cx: 0, cy: 0 };
let expectedRot = 0, expectedMirror = false;
function original(mask: Mask, template: Uint8Array): number {
  moments(mask, mo);
  if (mo.area < 4) return 0;
  let best = 0;
  for (const mirrorX of [false, true]) for (const rot of MATCH_ROTATIONS) {
    normalise(mask, mo, buf, rot, mirrorX);
    const v = iou(buf, template);
    if (v > best) { best = v; expectedRot = rot; expectedMirror = mirrorX; }
  }
  return best;
}
let seed = 7;
const random = () => ((seed = seed * 16807 % 2147483647) / 2147483647);
const screen = { ox: 0, oy: STAGE.lightDrop, oz: -STAGE.lightToScreen, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, nx: 0, ny: 0, nz: 1 };
const mask = new Mask(170, 120, -0.68, -0.48, 0.008), flat = new FlatHand();
const reference = new OriginalMask(mask.w, mask.h, mask.x0, mask.y0, mask.cell);
const joints = new Float32Array(JOINT_COUNT * 3);
for (let k = 0; k < 2000; k++) {
  let pose = clonePose(baked[k % baked.length].pose);
  orient(pose, [(random() - .5) * 120, (random() - .5) * 120, (random() - .5) * 120]);
  if (random() < .5) pose = mirror(pose);
  const center = [0, 0, 0];
  for (let j = 0; j < JOINT_COUNT; j++) for (let c = 0; c < 3; c++) center[c] += pose.mats[j * 16 + 12 + c] / JOINT_COUNT;
  const distance = k % 7 ? .1 + random() * .6 : .015, x = random() - .5, y = random() - .5;
  for (let j = 0; j < JOINT_COUNT; j++) {
    joints[j * 3] = pose.mats[j * 16 + 12] - center[0] + x;
    joints[j * 3 + 1] = pose.mats[j * 16 + 13] - center[1] + y + STAGE.lightDrop * distance / STAGE.lightToScreen;
    joints[j * 3 + 2] = pose.mats[j * 16 + 14] - center[2] - distance;
  }
  projectFromLight(joints, pose.radii, 0, 0, 0, screen, flat);
  mask.clear(); reference.clear();
  if (k % 11) { drawHand(mask, flat); drawHand(reference, flat); } // include empty and clipped masks
  assert.deepEqual(mask.data, reference.data, `raster frame ${k}`);
  const template = baked[(k * 7 + 3) % baked.length].template;
  assert.equal(matcher.score(mask, template), original(reference, template), `score frame ${k}`);
  assert.equal(matcher.bestRot, expectedRot, `rotation frame ${k}`);
  assert.equal(matcher.bestMirror, expectedMirror, `mirror frame ${k}`);
}
console.log('PASS: 2000 projected/clipped/empty/near-light masks match original raster pixels, scores and tie choices exactly');

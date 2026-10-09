// Compare where the live shadow of a hand at the runtime anchor lands vs the baked cut-out.
import { JOINT_COUNT } from '../src/shadow/hand-model';
import { FlatHand, projectFromLight, ScreenFrame, STAGE } from '../src/shadow/silhouette';
import { TARGETS, bakeTarget } from '../src/shadow/targets';
const head = [0, 1.2, 0];
const L = [0, head[1] - 0.3, -0.2];
const centre = [0, head[1] - 0.3 + STAGE.lightDrop - 0.02, -0.2 - STAGE.lightToScreen];
const cut = [centre[0], centre[1] + 0.02, centre[2]];
const f: ScreenFrame = { ox: centre[0], oy: centre[1], oz: centre[2], rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, nx: 0, ny: 0, nz: 1 };
const k = STAGE.lightToHand / STAGE.lightToScreen;
const A = L.map((v, i) => v + (cut[i] - v) * k);
const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
for (const def of TARGETS) {
  const b = bakeTarget(def), p = b.pose, j = new Float32Array(75);
  let c = [0, 0, 0];
  for (let i = 0; i < JOINT_COUNT; i++) for (let d = 0; d < 3; d++) c[d] += p.mats[i * 16 + 12 + d] / JOINT_COUNT;
  for (let i = 0; i < JOINT_COUNT; i++) for (let d = 0; d < 3; d++) j[i * 3 + d] = A[d] + p.mats[i * 16 + 12 + d] - c[d];
  const live = projectFromLight(j, p.radii, L[0], L[1], L[2], f, new FlatHand());
  console.log(def.id.padEnd(8), 'live centroid', mean(live.x).toFixed(3), mean(live.y).toFixed(3), '| baked+cy', mean(b.flat.x).toFixed(3), (mean(b.flat.y) + 0.02).toFixed(3));
}

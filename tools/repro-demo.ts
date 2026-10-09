// Reproduce the runtime stage geometry and the demo hand to check its score.
import { JOINT_COUNT, HandPose } from '../src/shadow/hand-model';
import { FlatHand, Mask, Matcher, drawHand, projectFromLight, ScreenFrame } from '../src/shadow/silhouette';
import { TARGETS, bakeTarget } from '../src/shadow/targets';
// @ts-ignore
import { writeSheet } from './sheet.mjs';
const frac = Number(process.argv[3] ?? 0.3), dl = Number(process.argv[4] ?? 0.2);
// head (0,1.2,0) fwd -Z; lantern head+fwd*dl - 0.3 up; screen centre head+fwd*0.95 - 0.06
const L = [0, 0.9, -dl], C = [0, 0.9 + 0.26 - 0.02, -dl - 0.75];
const f: ScreenFrame = { ox: C[0], oy: C[1], oz: C[2], rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, nx: 0, ny: 0, nz: 1 };
const cut = [C[0], C[1] + 0.02, C[2]];
const A = L.map((v, i) => v + (cut[i] - v) * frac);
function toWorld(p: HandPose, out: Float32Array) {
  let cx = 0, cy = 0, cz = 0;
  for (let j = 0; j < JOINT_COUNT; j++) { cx += p.mats[j*16+12]; cy += p.mats[j*16+13]; cz += p.mats[j*16+14]; }
  cx /= JOINT_COUNT; cy /= JOINT_COUNT; cz /= JOINT_COUNT;
  for (let j = 0; j < JOINT_COUNT; j++) {
    out[j*3] = A[0] + p.mats[j*16+12] - cx; out[j*3+1] = A[1] + p.mats[j*16+13] - cy; out[j*3+2] = A[2] + p.mats[j*16+14] - cz;
  }
}
const live = new Mask(170, 120, -0.68, -0.48, 0.008), m = new Matcher(), flat = new FlatHand();
const joints = new Float32Array(75); const tiles: any[] = [];
for (const def of TARGETS) {
  const b = bakeTarget(def); toWorld(b.pose, joints);
  projectFromLight(joints, b.pose.radii, L[0], L[1], L[2], f, flat);
  live.clear(); drawHand(live, flat);
  const s = m.score(live, b.template);
  console.log(def.id.padEnd(8), 'score', s.toFixed(3), 'pass', b.pass, s >= b.pass ? 'OK' : 'FAIL');
  tiles.push({ w: live.w, h: live.h, data: live.data.slice(), label: def.id });
}
writeSheet(process.argv[2], tiles, 3);

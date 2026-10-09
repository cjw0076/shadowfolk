import { basePoses, clonePose, orient, shape, curl } from '../src/shadow/hand-model';
import { FlatHand, Mask, drawHand, flattenOrtho } from '../src/shadow/silhouette';
// @ts-ignore
import { writeSheet } from './sheet.mjs';
const tiles: any[] = [];
const views: [number, number, number][] = [[0,0,0],[90,0,0],[-90,0,0],[0,90,0],[0,-90,0],[0,180,0]];
const poses: Record<string, any> = {
  relaxed: basePoses.relaxed(), point: basePoses.point(), pinch: basePoses.pinch(),
  open: shape(basePoses.relaxed(), { index: -0.3, middle: -0.3, ring: -0.3, pinky: -0.3, thumb: -0.3 }),
  fist: shape(basePoses.relaxed(), { index: 1, middle: 1, ring: 1, pinky: 1, thumb: 0.6 }),
};
for (const [name, p] of Object.entries(poses)) for (const v of views) {
  const q = orient(clonePose(p), v);
  const f = flattenOrtho(q, new FlatHand());
  const m = new Mask(100, 100, -0.15, -0.12, 0.003); m.clear(); drawHand(m, f);
  // mark wrist (gray) and index tip
  tiles.push({ w: 100, h: 100, data: m.data, label: `${name} view ${v}` });
}
writeSheet(process.argv[2], tiles, views.length, process.argv[3]);

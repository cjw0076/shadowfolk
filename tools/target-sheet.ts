// Render every target's ideal shadow (display mask) into a labelled contact sheet.
// Usage: node target-sheet.mjs out.png
import { TARGETS, bakeTarget } from '../src/shadow/targets';
// @ts-ignore
import { writeSheet } from './sheet.mjs';
const tiles = TARGETS.map(bakeTarget).map((b) => ({ w: b.display.w, h: b.display.h, data: b.display.data, label: b.def.id }));
writeSheet(process.argv[2], tiles, 5, process.argv[2].replace('.png', '.txt'));
console.log(tiles.map((t, k) => `${k}:${t.label}`).join(' '));

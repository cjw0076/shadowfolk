import { detectWave, type WaveSample } from '../src/play/wave.js';

function motion(amplitude: number, hz: number, open = true): WaveSample[] {
  const samples: WaveSample[] = [];
  for (let i = 0; i <= 90; i++) {
    const t = i / 60;
    samples.push({ t, x: amplitude * Math.sin(2 * Math.PI * hz * t), open });
  }
  return samples;
}

const positives = Array.from({ length: 20 }, (_, i) =>
  detectWave(motion(0.06 + i / 19 * 0.14, 1.2 + i / 19 * 1.8)));
const negatives = Array.from({ length: 20 }, (_, i) => {
  const kind = i % 4;
  if (kind === 0) return detectWave(motion(0, 2));
  if (kind === 1) return detectWave(Array.from({ length: 91 }, (_, j) =>
    ({ t: j / 60, x: j / 60 * 0.06, open: true })));
  if (kind === 2) return detectWave(Array.from({ length: 91 }, (_, j) =>
    ({ t: j / 60, x: Math.min(0.2, j / 60 * 0.4), open: true })));
  return detectWave(motion(0.12, 2, false));
});
const output = { positives: positives.filter(Boolean).length, negatives: negatives.filter(Boolean).length,
  pass: positives.every(Boolean) && negatives.every((value) => !value) };
console.log(JSON.stringify(output));
if (!output.pass) process.exitCode = 1;

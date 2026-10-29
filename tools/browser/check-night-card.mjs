import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const out = process.env.XR_NIGHT_CARD_OUT ?? '../collab/codex/25-night-card-browser.json';
const errors = [];
const result = { base, nights: [], replay: null, pageErrors: errors, passed: false };
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error.stack ?? error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const night of [1, 2, 3]) {
    const best = Array(9).fill(0);
    for (let prior = 1; prior < night; prior++) best[prior] = 0.8;
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(({ night, best }) => {
      localStorage.setItem('shadow-theater.v1', JSON.stringify({
        nights: night - 1, woken: { peacock: 1, rabbit: 1, snail: 1 },
        v3: { night, prologue: false, complete: false, best, fireflies: 0, nightsPlayed: night - 1 },
      }));
      localStorage.removeItem('shadowfolk.rig-anchor.v1');
    }, { night, best });
    const url = new URL(base);
    url.search = new URLSearchParams({ capture: 'keepdom', demo: '', crossingOnly: '', night: String(night), seed: '25025' }).toString();
    await page.goto(url.toString(), { waitUntil: 'load' });
    await page.waitForFunction(() => window.__capture?.step && window.__theater?.crossing, null, { timeout: 60_000 });
    const data = await page.evaluate(async ({ night }) => {
      const theater = window.__theater;
      const crossing = theater.crossing;
      // Let the demo hands finish the real Crossing before inspecting the Home timeline.
      for (let frame = 0; frame < 3000 && theater.phase !== 8; frame++)
        await window.__capture.step(0.05);
      if (theater.phase !== 8) throw new Error(`Night ${night} did not reach Home`);
      const total = crossing.total, home = crossing.home, earned = crossing.stars;
      const initial = { before: theater.cardMoonBefore, after: theater.cardMoonAfter,
        teaser: theater.cardTeaser, seed: theater.activeCrossingSeed };
      const samples = [];
      for (let frame = 0; frame < 120; frame++) {
        await window.__capture.step(0.05);
        if ([10, 34, 48, 72, 115].includes(frame)) samples.push({
          t: theater.phaseTime, stamped: theater.nightCard.stamped,
          starVisible: theater.nightCard.root.visible,
          moonWipe: theater.cardMoon.wipe.value,
          moonVisible: theater.cardMoon.mesh.visible,
          phase: theater.phase,
        });
      }
      return { night, total, home, earned, ...initial, samples,
        actualBefore: theater.cardMoonBefore, actualAfter: theater.cardMoonAfter,
        storedFill: (await import('/src/play/arc.ts')).moonFill(theater.saved.v3.best) };
    }, { night });
    result.nights.push(data);
    if (night === 2) {
      mkdirSync('../collab/codex/25-night-card', { recursive: true });
      await page.screenshot({ path: '../collab/codex/25-night-card/card-night2.png' });
    }
  }

  // Browser injected joint trials exercise the real hold gate without waiting through a whole Crossing.
  result.replay = await page.evaluate(() => {
    const theater = window.__theater;
    theater.summonForms = null;
    theater.immersive = true;
    theater.demo = false;
    const hand = theater.hands[0];
    const j = hand.joints;
    const seed = theater.activeCrossingSeed;
    const night = theater.crossing.night;
    const trials = {};
    const pose = (kind, frame) => {
      const wristX = theater.lanternPos.x + (kind === 'moving' ? frame * 0.01 : 0);
      const wristY = theater.lanternPos.y;
      const wristZ = theater.lanternPos.z + 0.2;
      j.fill(0);
      j[0] = wristX; j[1] = wristY; j[2] = wristZ;
      for (let finger = 0; finger < 4; finger++) {
        const base = [5, 10, 15, 20][finger];
        const tip = [9, 14, 19, 24][finger];
        const x = (-1.5 + finger) * 0.025;
        j[base * 3] = wristX + x; j[base * 3 + 1] = wristY + 0.055; j[base * 3 + 2] = wristZ;
        j[tip * 3] = wristX + x * 1.4;
        j[tip * 3 + 1] = wristY + (kind === 'fist' ? 0.035 : 0.15);
        j[tip * 3 + 2] = wristZ;
      }
      // The left palm normal points toward the lantern (negative z).
      j[15] = wristX - 0.04; j[16] = wristY + 0.055;
      j[60] = wristX + 0.04; j[61] = wristY + 0.055;
      hand.valid = true;
      hand.flat.valid = true;
    };
    for (const kind of ['still', 'moving', 'fist']) {
      trials[kind] = [];
      for (let trial = 0; trial < 5; trial++) {
        theater.phase = 8; // Home
        theater.crossing.night = night;
        theater.replayHold = [0, 0];
        theater.replayWristSeen = [false, false];
        let restarted = false;
        for (let frame = 0; frame < 30; frame++) {
          pose(kind, frame);
          if (theater.updateReplay(0.05, true, false)) { restarted = true; break; }
        }
        trials[kind].push({ restarted, night: theater.crossing.night,
          seed: theater.activeCrossingSeed });
      }
    }
    return { seed, night, trials };
  });
  const expected = ['snail', 'dog', 'duck'];
  result.passed = !errors.length && result.nights.every((entry, index) =>
    entry.earned >= 2 && entry.samples.some(sample => sample.stamped === entry.earned)
    && entry.samples.some(sample => sample.moonVisible && sample.moonWipe > 0.2)
    && Math.abs(entry.actualAfter - entry.storedFill) < 1e-6
    && entry.teaser === expected[index])
    && result.replay.trials.still.every(trial => trial.restarted && trial.night === result.replay.night && trial.seed === result.replay.seed)
    && result.replay.trials.moving.every(trial => !trial.restarted)
    && result.replay.trials.fist.every(trial => !trial.restarted);
} finally {
  await browser.close();
  writeFileSync(out, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;

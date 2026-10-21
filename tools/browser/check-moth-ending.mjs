import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const url = new URL(base);
url.search = 'capture=keepdom&demo&crossingOnly&night=8&seed=21021&moon=0.4';
const errors = [];
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  page.on('pageerror', (error) => errors.push(String(error.stack ?? error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture?.step && window.__theater?.crossing);
  if (process.env.XR_ENDING_IWER === '1') await page.evaluate(async () => {
    const theater = window.__theater, device = window.IWER_DEVICE;
    device.position.set(-0.9, 1.25, -1.19);
    const pitch = -8 * Math.PI / 180, yaw = Math.PI / 2;
    device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2),
      Math.cos(pitch / 2) * Math.sin(yaw / 2), -Math.sin(pitch / 2) * Math.sin(yaw / 2),
      Math.cos(pitch / 2) * Math.cos(yaw / 2));
    device.remote.activateCaptureMode();
    device.controlMode = 'programmatic'; device.primaryInputMode = 'hand';
    device.hands.left.connected = device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
    for (let frame = 0; frame < 20 && !theater.immersive; frame++) await window.__capture.step(1 / 60);
    if (!theater.immersive) throw new Error('IWER did not enter XR');
    theater.endSession(); theater.beginSession();
    for (let frame = 0; frame < 300 && (!theater.placed || theater.settle || theater.fitUntil); frame++)
      await window.__capture.step(1 / 30);
    if (!theater.placed || theater.settle || theater.fitUntil) throw new Error('XR stage not settled');
  });
  const result = await page.evaluate(async () => {
    const theater = window.__theater;
    const moonImage = theater.moon.canvas;
    const pixels = () => {
      const data = moonImage.getContext('2d').getImageData(0, 0, 128, 128).data;
      let dark = 0;
      for (let row = 35; row < 85; row++) for (let column = 35; column < 95; column++) {
        const index = (row * 128 + column) * 4;
        if (data[index] < 60 && data[index + 3] > 150) dark++;
      }
      return dark;
    };
    let queenSeen = false, queenPeel = false, moonArrival = false, finished = false;
    let firstMothSwat = false, minStars = 3;
    let queenAt = null, moonAt = null, savedAt = null;
    const beforeDark = pixels();
    for (let frame = 0; frame < 8000; frame++) {
      await window.__capture.step(0.05);
      const queen = theater.moths.agents.at(-1);
      const time = window.__capture.time;
      if (queen.phase !== 'hidden' && !queenSeen) { queenSeen = true; queenAt = time; }
      if (queen.phase === 'queenOrbit' || queen.phase === 'queenDive') queenPeel = true;
      if (theater.moths.shooed > 0) firstMothSwat = true;
      if (theater.crossing?.finished) {
        finished = true;
        minStars = Math.min(minStars, theater.crossing.stars);
      }
      if (theater.moths.queenOnMoon && !moonArrival) { moonArrival = true; moonAt = time; }
      if (theater.saved.v3.complete) { savedAt = time; break; }
    }
    return {
      queenSeen, queenPeel, moonArrival, finished, firstMothSwat, minStars,
      mothSwats: theater.moths.shooed, cupDeflections: theater.moths.deflections,
      queenAt, moonAt, savedAt, beforeDark, afterDark: pixels(),
      nextNight: theater.saved.v3.night, complete: theater.saved.v3.complete,
      phase: window.__capture.state().phase,
      crossing: { night: theater.crossing.night, home: theater.crossing.home,
        total: theater.crossing.total, stars: theater.crossing.stars },
      persistedComplete: JSON.parse(localStorage.getItem('shadow-theater.v1') ?? '{}').v3?.complete,
    };
  });
  const dailyUrl = new URL(url);
  dailyUrl.searchParams.set('night', '9');
  await page.goto(dailyUrl.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__theater?.saved?.v3 && window.__theater?.moon);
  result.daily = await page.evaluate(() => ({
    complete: window.__theater.saved.v3.complete,
    moonQueen: window.__theater.moon.queen,
    night: window.__theater.crossing?.night,
  }));
  result.errors = errors;
  result.pass = errors.length === 0 && result.queenSeen && result.queenPeel
    && result.moonArrival && result.finished && result.minStars >= 2
    && result.afterDark > result.beforeDark + 100 && result.complete && result.persistedComplete
    && result.nextNight === 9 && result.daily.complete && result.daily.moonQueen;
  writeFileSync(`../collab/codex/23-ending-${process.env.XR_ENDING_IWER === '1' ? 'xr' : 'browser'}.json`,
    `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
  await page.close();
} finally {
  await browser.close();
}

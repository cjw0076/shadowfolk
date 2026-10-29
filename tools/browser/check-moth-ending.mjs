import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const url = new URL(base);
url.search = 'capture=keepdom&demo&crossingOnly&night=8&seed=21021&moon=0.4';
if (process.env.XR_ENDING_NOWAVE === '1') url.searchParams.set('noWaveDemo', '');
const errors = [];
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  page.on('pageerror', (error) => errors.push(String(error.stack ?? error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(base, { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.setItem('shadow-theater.v1', JSON.stringify({
      nights: 8,
      woken: Object.fromEntries(['peacock', 'rabbit', 'snail', 'dog', 'duck', 'fish',
        'elephant', 'heron', 'crab', 'butterfly', 'stag'].map((id) => [id, 1])),
      order: ['peacock', 'rabbit', 'snail', 'dog', 'duck', 'fish',
        'elephant', 'heron', 'crab', 'butterfly', 'stag'],
      v3: { night: 8, prologue: false, complete: false,
        best: [0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0],
        fireflies: 124, nightsPlayed: 7 },
    }));
  });
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
  const result = await page.evaluate(async ({ realWave, noWave, fastWave }) => {
    const theater = window.__theater;
    if (fastWave) {
      theater.phase = 3;
      theater.phaseTime = 12;
      theater.crossingHomeAt = theater.animationTime - 20;
      theater.endingMoonLit = true;
      theater.moon.setPhase(0.5);
    }
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
    let landingOffset = null, diameterAt8 = null, entriesAt16 = null, leapsAt20 = null;
    let wallAt20 = null, waveAt = null, handHiddenFrames = 0, endingFrames = 0;
    let trackedWaveFrames = 0, openWaveFrames = 0, waveSamples = 0;
    let waveWristMin = Infinity, waveWristMax = -Infinity, waveSpeedMax = 0, waveDirectionChanges = 0;
    let lastWaveX = null, lastWaveDirection = 0;
    const waveTrials = [false, false, false, false, false];
    const device = window.IWER_DEVICE;
    const input = realWave ? device.hands.left : null;
    const names = input ? Array.from(input.inputSource.hand.keys()) : [];
    const poseState = input ? Object.getOwnPropertySymbols(input).map((symbol) => input[symbol])
      .find((value) => value?.poses?.default && value?.poses?.pinch) : null;
    const Vector3 = theater.anchor.constructor;
    let wavePoseSerial = 0;
    const injectWave = (seconds) => {
      const frame = theater.frame;
      const center = theater.lanternPos;
      const x = 0.12 * Math.sin(seconds * 2 * Math.PI * 2.5);
      const inverse = theater.player.matrixWorld.clone().invert();
      const points = [];
      for (let joint = 0; joint < 25; joint++) {
        const finger = joint === 0 ? 2 : joint <= 4 ? 0 : Math.floor((joint - 5) / 5) + 1;
        const segment = joint === 0 ? 0 : joint <= 4 ? joint : (joint - 5) % 5;
        const px = x + (finger - 2) * 0.028;
        const py = 0.14 + segment * 0.035;
        const p = new Vector3(center.x + px * frame.rx + py * frame.ux + 0.20 * frame.nx,
          center.y + px * frame.ry + py * frame.uy + 0.20 * frame.ny,
          center.z + px * frame.rz + py * frame.uz + 0.20 * frame.nz).applyMatrix4(inverse);
        points.push(p);
      }
      const mean = new Vector3();
      for (const point of points) mean.add(point);
      mean.multiplyScalar(1 / points.length);
      const jointTransforms = {};
      for (let joint = 0; joint < 25; joint++) {
        const point = points[joint];
        jointTransforms[names[joint]] = { offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0,
          0, 0, 1, 0, point.x - mean.x, point.y - mean.y, point.z - mean.z, 1], radius: 0.008 };
      }
      const poseId = `ending-wave-${wavePoseSerial++}`;
      poseState.poses[poseId] = { jointTransforms };
      input.position.copy(mean);
      input.quaternion.set(0, 0, 0, 1);
      input.poseId = poseId;
      input.connected = true;
      device.notifyStateChange?.();
    };
    const beforeDark = pixels();
    for (let frame = 0; frame < 8000; frame++) {
      const previousEndingTime = Number.isFinite(theater.crossingHomeAt) ? theater.animationTime - theater.crossingHomeAt : -1;
      if (realWave && previousEndingTime >= 20 && previousEndingTime < 24.5) {
        const trial = Math.floor((previousEndingTime - 20) / 0.9);
        if (trial < 5 && !waveTrials[trial]) injectWave(previousEndingTime - 20 - trial * 0.9);
        else input.connected = false;
      }
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
      const endingTime = Number.isFinite(theater.crossingHomeAt) ? theater.animationTime - theater.crossingHomeAt : -1;
      if (endingTime >= 0 && endingTime <= 30.5) {
        endingFrames++;
        if (endingTime < 20 && !theater.puppeteer.root.visible && !theater.puppeteer2.root.visible) handHiddenFrames++;
        if (theater.moths.queenOnMoon && landingOffset === null) landingOffset = endingTime;
        if (endingTime >= 8 && diameterAt8 === null) diameterAt8 = 0.11 * theater.moon.mesh.scale.x;
        if (endingTime >= 16 && entriesAt16 === null) entriesAt16 = theater.endingEntries;
        if (endingTime >= 20 && leapsAt20 === null) {
          leapsAt20 = theater.endingLeaps;
          wallAt20 = theater.wall.residentCount;
        }
        if (theater.endingWaveAt !== -Infinity && waveAt === null) waveAt = theater.endingWaveAt;
        if (realWave && endingTime >= 20 && endingTime < 24.5) {
          if (theater.hands[0].valid) trackedWaveFrames++;
          if (theater.hands[0].valid && theater.openPalm(theater.hands[0].joints)) openWaveFrames++;
          waveSamples += theater.endingWaveHistory[0].length;
          const samples = theater.endingWaveHistory[0];
          if (samples.length) {
            const x = samples.at(-1).x;
            waveWristMin = Math.min(waveWristMin, x);
            waveWristMax = Math.max(waveWristMax, x);
            if (lastWaveX !== null) {
              const speed = (x - lastWaveX) / 0.05;
              waveSpeedMax = Math.max(waveSpeedMax, Math.abs(speed));
              const direction = Math.sign(speed);
              if (lastWaveDirection && direction && direction !== lastWaveDirection) waveDirectionChanges++;
              if (direction) lastWaveDirection = direction;
            }
            lastWaveX = x;
          }
        }
        if (realWave && theater.endingWaveAt !== -Infinity && endingTime >= 20 && endingTime < 24.5) {
          const trial = Math.floor((endingTime - 20) / 0.9);
          if (trial < 5) waveTrials[trial] = true;
          theater.endingWaveAt = -Infinity;
          theater.endingWaveHistory[0].length = theater.endingWaveHistory[1].length = 0;
        }
      }
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
      landingOffset, diameterAt8, entriesAt16, leapsAt20, wallAt20, waveAt,
      waveTrials, handHiddenFrames, endingFrames, endingDuration: theater.animationTime - theater.crossingHomeAt,
      trackedWaveFrames, openWaveFrames, waveSamples,
      waveWristMin, waveWristMax, waveSpeedMax, waveDirectionChanges,
    };
  }, { realWave: process.env.XR_ENDING_IWER === '1', noWave: process.env.XR_ENDING_NOWAVE === '1',
    fastWave: process.env.XR_ENDING_FAST === '1' });
  const dailyUrl = new URL(url);
  dailyUrl.searchParams.set('night', '9');
  await page.goto(dailyUrl.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__theater?.saved?.v3 && window.__theater?.moon);
  result.daily = await page.evaluate(() => ({
    complete: window.__theater.saved.v3.complete,
    moonQueen: window.__theater.moon.queen,
    moonDiameter: 0.11 * window.__theater.moon.mesh.scale.x,
    night: window.__theater.crossing?.night,
  }));
  result.errors = errors;
  const fastWave = process.env.XR_ENDING_FAST === '1';
  result.pass = fastWave
    ? errors.length === 0 && result.waveTrials.every(Boolean)
      && result.trackedWaveFrames >= 20 && result.openWaveFrames >= 20
      && result.waveSpeedMax > 0.25
    : errors.length === 0 && result.queenSeen && result.queenPeel
    && result.moonArrival && result.finished && result.minStars >= 2
    && result.afterDark > result.beforeDark + 100 && result.complete && result.persistedComplete
    && result.nextNight === 9 && result.daily.complete && result.daily.moonQueen
    && Math.abs(result.landingOffset - 3.5) <= 0.3 && result.diameterAt8 >= 0.29
    && result.entriesAt16 === 40 && result.leapsAt20 === 11 && result.wallAt20 === 11
    && result.handHiddenFrames >= 390
    && result.endingDuration <= 30.5 && result.daily.moonDiameter <= 0.12
    && (process.env.XR_ENDING_NOWAVE === '1' ? result.waveAt === null : result.waveAt !== null)
    && (process.env.XR_ENDING_IWER !== '1' || result.waveTrials.every(Boolean));
  writeFileSync(process.env.XR_ENDING_OUT
    ?? `../collab/codex/24-ending-${fastWave ? 'xr-wave' : process.env.XR_ENDING_NOWAVE === '1' ? 'nowave' : 'browser'}.json`,
    `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
  await page.close();
} finally {
  await browser.close();
}

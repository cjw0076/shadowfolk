import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const out = process.env.XR_TRACKING_GRACE_OUT ?? '../collab/codex/25-tracking-grace.json';
const result = { base, trials: [], pageErrors: [], passed: false };
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => result.pageErrors.push(String(error.stack ?? error)));
  page.on('console', message => { if (message.type() === 'error') result.pageErrors.push(message.text()); });
  const url = new URL(base);
  url.search = 'capture=keepdom&crossingOnly&night=2&hazards=gap&kindlings=5&seed=25025';
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture?.step && window.__theater?.crossing && window.IWER_DEVICE?.sessionOffered,
    null, { timeout: 60_000 });
  const placement = await page.evaluate(async () => {
    const t = window.__theater, device = window.IWER_DEVICE;
    device.position.set(-0.9, 1.25, -1.19);
    const pitch = -8 * Math.PI / 180, yaw = Math.PI / 2;
    device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2),
      Math.cos(pitch / 2) * Math.sin(yaw / 2), -Math.sin(pitch / 2) * Math.sin(yaw / 2),
      Math.cos(pitch / 2) * Math.cos(yaw / 2));
    device.remote.activateCaptureMode();
    device.controlMode = 'programmatic'; device.primaryInputMode = 'hand';
    device.hands.left.connected = device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
    for (let frame = 0; frame < 20 && !t.immersive; frame++) await window.__capture.step(1 / 60);
    if (!t.immersive) throw new Error('IWER did not enter XR');
    t.endSession(); t.beginSession();
    for (let frame = 0; frame < 300 && (!t.placed || t.settle || t.fitUntil); frame++) await window.__capture.step(1 / 30);
    if (!t.placed || t.settle || t.fitUntil) throw new Error('XR stage did not settle');
    return { immersive: t.immersive, placed: t.placed, mode: t.mode };
  });
  result.placement = placement;
  for (const seconds of [2, 6]) {
    const trial = await page.evaluate(async seconds => {
      const t = window.__theater;
      const device = window.IWER_DEVICE;
      device.hands.left.position.set(-0.18, -0.2, -0.35);
      device.hands.left.connected = true;
      device.notifyStateChange?.();
      for (let frame = 0; frame < 4; frame++) await window.__capture.step(0.05);
      const trackedBefore = t.handMask !== 0;
      device.hands.left.connected = false;
      device.notifyStateChange?.();
      t.beginCrossing(2, 25025);
      const folk = t.playFolk;
      folk.reset();
      folk.configure({ waveCount: 1 });
      const gap = t.crossing.level.hazards[0];
      const agent = folk.spawn(gap.x - gap.width * 0.5 - 0.05, -0.185);
      if (!agent) throw new Error('Could not spawn a test Kindling');
      const samples = [];
      for (let frame = 0; frame < seconds * 20; frame++) {
        await window.__capture.step(0.05);
        if ([4, 5, 20, 39, 80, 85, 90, 119].includes(frame)) samples.push({
          time: Number(((frame + 1) * 0.05).toFixed(2)),
          grace: folk.trackingGrace,
          waiting: agent.waiting,
          state: agent.state,
          x: Number(agent.x.toFixed(3)),
          ash: folk.ashCount,
          candle: t.crossing.candle,
        });
      }
      return { seconds, trackedBefore, gap, samples, ash: folk.ashCount, state: agent.state,
        candle: t.crossing.candle, tracked: t.handMask !== 0 };
    }, seconds);
    result.trials.push(trial);
  }
  result.trackedIdle = await page.evaluate(async () => {
    const t = window.__theater, device = window.IWER_DEVICE;
    device.hands.left.position.set(1, -0.2, -0.35);
    device.hands.left.connected = true;
    device.notifyStateChange?.();
    t.beginCrossing(2, 25025);
    const folk = t.playFolk;
    folk.reset(); folk.configure({ waveCount: 1 });
    const gap = t.crossing.level.hazards[0];
    const agent = folk.spawn(gap.x - gap.width * 0.5 - 0.05, -0.185);
    let trackedFrames = 0, graceFrames = 0;
    for (let frame = 0; frame < 40; frame++) {
      await window.__capture.step(0.05);
      if (t.handMask) trackedFrames++;
      if (folk.trackingGrace) graceFrames++;
    }
    device.hands.left.connected = false;
    return { trackedFrames, graceFrames, ash: folk.ashCount, state: agent.state };
  });
  result.handReturn = await page.evaluate(async () => {
    const t = window.__theater, device = window.IWER_DEVICE;
    device.hands.left.position.set(1, -0.2, -0.35);
    device.hands.left.connected = true;
    device.notifyStateChange?.();
    await window.__capture.step(0.05);
    t.beginCrossing(2, 25025);
    device.hands.left.connected = false;
    device.notifyStateChange?.();
    for (let frame = 0; frame < 20; frame++) await window.__capture.step(0.05);
    const graceDuringLoss = t.playFolk.trackingGrace;
    device.hands.left.connected = true;
    device.notifyStateChange?.();
    await window.__capture.step(0.05);
    const afterReturn = { tracked: t.handMask !== 0, grace: t.playFolk.trackingGrace };
    device.hands.left.connected = false;
    return { graceDuringLoss, afterReturn };
  });
  const short = result.trials[0], long = result.trials[1];
  result.passed = !result.pageErrors.length && placement.immersive && short.trackedBefore && long.trackedBefore
    && !short.tracked && !long.tracked
    && short.ash === 0 && short.samples.some(sample => sample.grace && sample.waiting)
    && long.samples.some(sample => sample.time >= 4.25 && !sample.grace)
    && long.ash > 0 && long.candle < short.candle
    && result.trackedIdle.trackedFrames === 40 && result.trackedIdle.graceFrames === 0
    && result.trackedIdle.ash > 0 && result.handReturn.graceDuringLoss
    && result.handReturn.afterReturn.tracked && !result.handReturn.afterReturn.grace;
} finally {
  await browser.close();
  writeFileSync(out, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;

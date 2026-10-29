import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const url = new URL(base);
url.search = 'capture=keepdom&demo&crossingOnly&night=2&seed=25025&perf';
const output = process.env.XR_NIGHT_CARD_BUDGET_OUT ?? '../collab/codex/25-night-card-budget.json';
const errors = [];
const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error.stack ?? error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('shadow-theater.v1', JSON.stringify({
    nights: 1, woken: { peacock: 1, rabbit: 1 },
    v3: { night: 2, prologue: false, complete: false,
      best: [0, 0.8, 0, 0, 0, 0, 0, 0, 0], fireflies: 10, nightsPlayed: 1 },
  })));
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__perf && window.__capture?.step
    && window.IWER_DEVICE?.sessionOffered && window.__theater?.crossing);
  const setup = await page.evaluate(async () => {
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
    t.crossing.home = Math.ceil(t.crossing.total * 0.8);
    t.crossing.stars = 2;
    t.crossing.finished = true;
    t.finishCrossing();
    for (let frame = 0; frame < 320; frame++) await window.__capture.step(1 / 60);
    return { immersed: t.immersive, phase: t.phase, cardTime: t.phaseTime,
      stamps: t.nightCard.stamped, moonWipe: t.cardMoon.wipe.value };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const readings = await page.evaluate(async () => {
    const t = window.__theater, perf = window.__perf;
    const textures = [t.painter.softTexture, t.painter.texture, t.moon.texture,
      t.cardMoon.texture, t.nightCard.filled, t.nightCard.outline, t.nightCard.splash,
      ...t.painter.captions.map(layer => layer.mesh.material.map), t.wall.texture];
    const before = textures.map(texture => texture.version);
    for (const key of ['play', 'update']) perf[key].count = 0;
    for (let frame = 0; frame < 120; frame++) await window.__capture.step(1 / 60);
    const values = series => Array.from(series.values.slice(0, series.count));
    return { play: values(perf.play), update: values(perf.update),
      textureUpdates: textures.map((texture, index) => texture.version - before[index]),
      finalTime: t.phaseTime, stamped: t.nightCard.stamped };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const report = { setup, frames: readings.play.length, p95PlayMs: percentile(readings.play, 0.95),
    p95WholeMs: percentile(readings.update, 0.95), textureUpdates: readings.textureUpdates,
    finalTime: readings.finalTime, stamped: readings.stamped, loadAverage: loadavg(), errors };
  report.pass = setup.phase === 8 && setup.cardTime >= 5 && report.frames === 120
    && report.p95PlayMs <= 2.6 && report.p95WholeMs <= 6
    && report.textureUpdates.every(count => count === 0) && !errors.length;
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  await browser.close();
}

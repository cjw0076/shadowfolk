import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const url = new URL(base);
url.search = 'capture=keepdom&demo&crossingOnly&night=8&hazards=gust,boulder&kindlings=40&seed=21021&perf&moon=0.4';
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
const errors = [];
const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  await page.addInitScript(() => {
    const ids = ['peacock', 'rabbit', 'snail', 'dog', 'duck', 'fish', 'elephant',
      'heron', 'crab', 'butterfly', 'stag'];
    localStorage.setItem('shadow-theater.v1', JSON.stringify({
      nights: 8, woken: Object.fromEntries(ids.map((id) => [id, 1])), order: ids,
      v3: { night: 8, prologue: false, complete: false,
        best: [0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0], fireflies: 124, nightsPlayed: 7 },
    }));
  });
  page.on('pageerror', (error) => errors.push(String(error.stack ?? error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__perf && window.__capture?.step
    && window.IWER_DEVICE?.sessionOffered && window.__theater?.crossing);
  const setup = await page.evaluate(async () => {
    const theater = window.__theater;
    const device = window.IWER_DEVICE;
    device.position.set(-0.9, 1.25, -1.19);
    const pitch = -8 * Math.PI / 180, yaw = Math.PI / 2;
    device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2),
      Math.cos(pitch / 2) * Math.sin(yaw / 2), -Math.sin(pitch / 2) * Math.sin(yaw / 2),
      Math.cos(pitch / 2) * Math.cos(yaw / 2));
    device.remote.activateCaptureMode();
    device.controlMode = 'programmatic';
    device.primaryInputMode = 'hand';
    device.hands.left.connected = device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
    for (let frame = 0; frame < 20 && !theater.immersive; frame++) await window.__capture.step(1 / 60);
    if (!theater.immersive) throw new Error('IWER did not enter XR');
    theater.endSession(); theater.beginSession();
    for (let frame = 0; frame < 300 && (!theater.placed || theater.settle || theater.fitUntil); frame++)
      await window.__capture.step(1 / 30);
    if (!theater.placed || theater.settle || theater.fitUntil) throw new Error('XR stage not settled');
    theater.beginCrossing(8);
    const folk = theater.playFolk;
    folk.reset(); folk.configure({ waveCount: 0 });
    for (let index = 0; index < 40; index++) folk.spawn(-0.46 + index * 0.019, -0.185, index % 2 ? 1 : -1);
    const prior = folk.onEvent;
    folk.onEvent = (kind, agent) => {
      if (kind === 'home' || kind === 'ash') {
        if (kind === 'home') folk.homeCount--;
        else folk.ashCount--;
        agent.state = 'falling'; agent.x = folk.spawnX; agent.y = folk.spawnY;
        agent.vx = agent.vy = 0; agent.age = 0; agent.heading = 1;
      } else prior?.(kind, agent);
    };
    const summons = [theater.crossing.summons.spawn('dog', -0.25, -0.18),
      theater.crossing.summons.spawn('elephant', 0.16, -0.18)];
    theater.moths.time = 15;
    await window.__capture.step(1 / 60);
    for (let index = 0; index < 2; index++) {
      const moth = theater.moths.spawn(theater.mothStage);
      moth.phase = 'orbit'; moth.phaseTime = -100;
      moth.x = theater.lanternPos.x + 0.25;
      moth.y = theater.lanternPos.y + 0.08;
      moth.z = theater.lanternPos.z;
    }
    for (let frame = 0; frame < 120; frame++) await window.__capture.step(1 / 60);
    return { immersed: theater.immersive, folk: folk.count, summons,
      residents: theater.wall.residents.length, fireflies: theater.wall.fireflies.count,
      activeSummons: theater.crossing.summons.activeCount(),
      queen: theater.moths.agents.at(-1).phase,
      small: theater.moths.agents.filter((agent) => !agent.queen && agent.phase !== 'hidden').length };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const readings = await page.evaluate(async () => {
    const perf = window.__perf;
    for (const key of ['play', 'update']) perf[key].count = 0;
    for (let frame = 0; frame < 300; frame++) await window.__capture.step(1 / 60);
    const values = (series) => Array.from(series.values.slice(0, series.count));
    const theater = window.__theater;
    return { play: values(perf.play), update: values(perf.update),
      folk: theater.playFolk.count, activeSummons: theater.crossing.summons.activeCount(),
      queen: theater.moths.agents.at(-1).phase,
      small: theater.moths.agents.filter((agent) => !agent.queen && agent.phase !== 'hidden').length };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const report = { setup, p95PlayMs: percentile(readings.play, 0.95),
    p95WholeMs: percentile(readings.update, 0.95),
    frames: readings.play.length, final: { folk: readings.folk, activeSummons: readings.activeSummons,
      queen: readings.queen, small: readings.small }, loadAverage: loadavg(), errors };
  report.pass = report.frames === 300 && report.p95PlayMs <= 2.6 && report.p95WholeMs <= 6
    && setup.folk === 40 && setup.summons.every(Boolean) && setup.activeSummons === 2
    && setup.residents === 11 && setup.fireflies >= 124
    && setup.small === 3 && setup.queen !== 'hidden' && errors.length === 0;
  writeFileSync('../collab/codex/23-moth-budget.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
  await page.close();
} finally {
  await browser.close();
}

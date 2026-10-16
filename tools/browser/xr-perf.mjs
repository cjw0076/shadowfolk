import { mkdirSync, writeFileSync } from 'node:fs';
import { injectCase } from './xr-case.mjs';

const EVIDENCE = '../collab/codex/08-evidence';

export default async function run({ page, frame }) {
  const target = frame ?? page;
  const initialized = await target.evaluate(() => !!window.__xrPerfState);
  if (!initialized) {
    await target.evaluate(() => {
      localStorage.removeItem('shadowfolk.rig-anchor.v1');
      localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
    });
    const url = new URL(target.url());
    url.search = '?perf&day=20378';
    await target.goto(url.toString(), { waitUntil: 'load' });
    await target.waitForFunction(() => window.__theater && window.__perf && window.IWER_DEVICE, null, { timeout: 30000 });
    await target.waitForFunction(() => window.IWER_DEVICE.sessionOffered, null, { timeout: 30000 });
    await target.evaluate(async () => {
      const device = window.IWER_DEVICE;
      device.position.set(-0.9, 1.25, -1.19);
      const pitch = -8 * Math.PI / 180;
      const yaw = 90 * Math.PI / 180;
      device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2), Math.cos(pitch / 2) * Math.sin(yaw / 2),
        -Math.sin(pitch / 2) * Math.sin(yaw / 2), Math.cos(pitch / 2) * Math.cos(yaw / 2));
      device.primaryInputMode = 'hand';
      device.hands.left.connected = false;
      device.hands.right.connected = false;
      await device.remote.dispatch('accept_session', {});
    });
    await target.waitForFunction(() => window.__theater.immersive, null, { timeout: 30000 });
    await target.evaluate(() => { window.__theater.endSession(); window.__theater.beginSession(); });
    await target.waitForFunction(() => {
      const theater = window.__theater;
      return theater.mode === 'table' && theater.placed && !theater.settle && theater.fitUntil === 0;
    }, null, { timeout: 30000 });
    const prepared = await injectCase(target, { targetId: 'butterfly', kind: 'fists' });
    await target.evaluate(() => { window.__xrPerfState = { prepared: true }; });
    return { stage: 'setup', mode: 'table', xrFrameRate: await target.evaluate(() => window.__theater.renderer.xr.getSession().frameRate),
      hands: prepared.hands, next: 'Run the same command once more for 60 seconds of measurements.' };
  }

  const result = await target.evaluate(async () => {
    const theater = window.__theater;
    const perf = window.__perf;
    const renderer = theater.renderer;
    const samples = { update: [], painter: [], frameInterval: [], drawCalls: [], triangles: [] };
    const counters = { update: perf.update.count, painter: perf.painter.count, frameInterval: perf.frameInterval.count };
    const originalRender = renderer.render;
    renderer.render = function (...args) {
      const output = originalRender.apply(this, args);
      samples.drawCalls.push(this.info.render.calls);
      samples.triangles.push(this.info.render.triangles);
      return output;
    };
    const began = performance.now();
    try {
      for (let chunk = 0; chunk < 12; chunk++) {
        window.IWER_DEVICE.remote.activateCaptureMode();
        window.IWER_DEVICE.controlMode = 'programmatic';
        await new Promise((resolve) => setTimeout(resolve, 5000));
        for (const name of ['update', 'painter', 'frameInterval']) {
          const source = perf[name];
          for (let index = counters[name]; index < source.count; index++) samples[name].push(source.values[index % perf.capacity]);
          counters[name] = source.count;
        }
      }
    } finally {
      renderer.render = originalRender;
    }
    const stats = (values) => {
      const sorted = values.slice().sort((left, right) => left - right);
      return { count: sorted.length, mean: sorted.length ? +(sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3) : null,
        p95: sorted.length ? +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3) : null,
        min: sorted.length ? +sorted[0].toFixed(3) : null,
        max: sorted.length ? +sorted.at(-1).toFixed(3) : null };
    };
    return { elapsedSeconds: +((performance.now() - began) / 1000).toFixed(2), mode: theater.mode,
      sessionMode: renderer.xr.getSession()?.mode, xrFrameRate: renderer.xr.getSession()?.frameRate,
      twoTrackedHands: theater.hands.every((hand) => hand.valid), scriptedHands: theater.demoHand.valid || theater.demoHand2.valid,
      updateMs: stats(samples.update), painterMs: stats(samples.painter), frameIntervalMs: stats(samples.frameInterval),
      drawCalls: stats(samples.drawCalls), triangles: stats(samples.triangles) };
  });
  if (result.elapsedSeconds < 60 || !result.twoTrackedHands || result.scriptedHands || result.updateMs.count < 100 || result.drawCalls.count < 100) {
    throw new Error(`XR performance capture incomplete: ${JSON.stringify(result)}`);
  }
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}/xr-perf.png` });
  writeFileSync(`${EVIDENCE}/xr-perf.json`, JSON.stringify(result, null, 2));
  return { stage: 'measure', done: true, result };
}

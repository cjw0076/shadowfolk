import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { injectCase, measureCase, validateCase } from './xr-case.mjs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const output = process.env.XR_WAKE_OUT ?? '../collab/codex/15-evidence/wakes';
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.removeItem('shadow-theater.v1');
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
    localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
  });
  const url = new URL(base);
  url.search = '?capture=keepdom&day=20378';
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater && window.IWER_DEVICE?.sessionOffered,
    null, { timeout: 60000 });
  await page.evaluate(async () => {
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
  const placement = await page.evaluate(async () => {
    for (let index = 0; index < 20 && !window.__theater.immersive; index++) await window.__capture.step(1 / 20);
    const theater = window.__theater;
    if (!theater.immersive) throw new Error('IWER did not enter XR');
    theater.endSession();
    theater.beginSession();
    for (let index = 0; index < 220; index++) {
      await window.__capture.step(1 / 20);
      if (theater.mode === 'table' && theater.placed && !theater.settle && theater.fitUntil === 0) {
        return { mode: theater.mode, time: window.__capture.time };
      }
    }
    throw new Error('IWER table placement failed');
  });
  const rows = [];
  for (const spec of [
    { targetId: 'peacock', kind: 'wake', side: 'left' },
    { targetId: 'rabbit', kind: 'wake', side: 'right' },
    { targetId: 'butterfly', kind: 'wake' },
  ]) {
    const prepared = await injectCase(page, spec);
    const outcome = await measureCase(page, 2);
    const row = validateCase(prepared, outcome);
    if (row.timeToWake > 0.8) throw new Error(`Wake exceeded 0.8 s: ${JSON.stringify(row)}`);
    rows.push(row);
    await page.evaluate(() => {
      window.IWER_DEVICE.hands.left.connected = false;
      window.IWER_DEVICE.hands.right.connected = false;
    });
  }
  if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
  const result = { placement, rows, errors };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { injectCase, measureCase, validateCase } from './xr-case.mjs';

const EVIDENCE = '../collab/codex/08-evidence';
const CASES = [
  { id: 'negative-relaxed-peacock', targetId: 'peacock', kind: 'relaxed' },
  { id: 'wake-peacock', targetId: 'peacock', kind: 'wake', side: 'left' },
  { id: 'wake-rabbit', targetId: 'rabbit', kind: 'wake', side: 'right' },
  { id: 'wake-snail', targetId: 'snail', kind: 'wake', side: 'left' },
  { id: 'wake-fish', targetId: 'fish', kind: 'wake', side: 'right' },
  { id: 'wake-duck', targetId: 'duck', kind: 'wake', side: 'left' },
  { id: 'wake-heron', targetId: 'heron', kind: 'wake', side: 'right' },
  { id: 'wake-dog', targetId: 'dog', kind: 'wake', side: 'left' },
  { id: 'wake-elephant', targetId: 'elephant', kind: 'wake', side: 'right' },
  { id: 'wake-butterfly', targetId: 'butterfly', kind: 'wake' },
  { id: 'wake-stag', targetId: 'stag', kind: 'wake' },
  { id: 'wake-crab', targetId: 'crab', kind: 'wake' },
  { id: 'negative-half-butterfly', targetId: 'butterfly', kind: 'half' },
  { id: 'negative-half-stag', targetId: 'stag', kind: 'half' },
  { id: 'negative-half-crab', targetId: 'crab', kind: 'half' },
  { id: 'negative-fists-butterfly', targetId: 'butterfly', kind: 'fists' },
  { id: 'negative-fists-stag', targetId: 'stag', kind: 'fists' },
  { id: 'negative-fists-crab', targetId: 'crab', kind: 'fists' },
];

export default async function run({ page, frame }) {
  const target = frame ?? page;
  const initialized = await target.evaluate(() => !!window.__xrAll);
  if (!initialized) {
    await target.evaluate(() => {
      localStorage.removeItem('shadow-theater.v1');
      localStorage.removeItem('shadowfolk.rig-anchor.v1');
      localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
    });
    const url = new URL(target.url());
    url.search = '?capture=keepdom&day=20378&classic';
    await target.goto(url.toString(), { waitUntil: 'load' });
    await target.waitForFunction(() => window.__theater && window.__capture && window.IWER_DEVICE, null, { timeout: 30000 });
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
    const placement = await target.evaluate(async () => {
      for (let index = 0; index < 20 && !window.__theater.immersive; index++) await window.__capture.step(1 / 20);
      if (!window.__theater.immersive) throw new Error('IWER did not enter immersive XR');
      window.__theater.endSession();
      window.__theater.beginSession();
      for (let index = 0; index < 220; index++) {
        await window.__capture.step(1 / 20);
        const theater = window.__theater;
        if (theater.mode === 'table' && theater.placed && !theater.settle && theater.fitUntil === 0) {
          window.__xrAll = { index: 0, rows: [], order: theater.order.map((entry) => theater.baked[entry].def.id) };
          return { mode: theater.mode, head: theater.camera.getWorldPosition(new theater.anchor.constructor()).toArray(),
            order: window.__xrAll.order, anchored: theater.anchored, time: window.__capture.time };
        }
      }
      const theater = window.__theater;
      throw new Error(`Table placement failed: ${JSON.stringify({ mode: theater.mode, placed: theater.placed, fitUntil: theater.fitUntil })}`);
    });
    return { stage: 'setup', placement, next: CASES[0].id };
  }

  const state = await target.evaluate(() => ({ index: window.__xrAll.index, rows: window.__xrAll.rows }));
  if (state.index >= CASES.length) return { done: true, table: state.rows };
  const spec = CASES[state.index];
  const prepared = await injectCase(target, spec);
  const outcome = await measureCase(target);
  mkdirSync(EVIDENCE, { recursive: true });
  const screenshot = `${EVIDENCE}/${spec.id}.png`;
  await page.screenshot({ path: screenshot });
  const row = { id: spec.id, ...validateCase(prepared, outcome) };
  const progress = await target.evaluate((row) => {
    const state = window.__xrAll;
    state.rows.push(row);
    state.index++;
    window.IWER_DEVICE.hands.left.connected = false;
    window.IWER_DEVICE.hands.right.connected = false;
    return { index: state.index, rows: state.rows };
  }, row);
  if (progress.index === CASES.length) writeFileSync(`${EVIDENCE}/all-results.json`, JSON.stringify(progress.rows, null, 2));
  return { stage: spec.id, row, screenshot, done: progress.index === CASES.length,
    next: CASES[progress.index]?.id ?? null, table: progress.index === CASES.length ? progress.rows : undefined };
}

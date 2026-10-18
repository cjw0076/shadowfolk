import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const shotPath = process.argv[2] ?? '../video/shots/final/xr/12-onehand.json';
const shot = JSON.parse(readFileSync(shotPath, 'utf8'));
const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const output = process.env.XR_ONE_HAND_TIMELINE_OUT ?? '../collab/codex/16-evidence';
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((storage) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage ?? {})) localStorage.setItem(key, JSON.stringify(value));
  }, shot.storage);
  const url = new URL(base);
  url.search = `?capture=keepdom&${shot.params}`;
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater && window.IWER_DEVICE?.sessionOffered,
    null, { timeout: 60000 });
  await page.evaluate(async () => {
    const device = window.IWER_DEVICE;
    device.controlMode = 'programmatic';
    device.position.set(-0.9, 1.25, -1.19);
    const pitch = Math.atan2(-0.13, 1.08);
    const yaw = Math.PI / 2;
    device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2), Math.cos(pitch / 2) * Math.sin(yaw / 2),
      -Math.sin(pitch / 2) * Math.sin(yaw / 2), Math.cos(pitch / 2) * Math.cos(yaw / 2));
    device.primaryInputMode = 'hand';
    device.hands.left.connected = false;
    device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
  });
  const step = () => page.evaluate((delta) => window.__capture.step(delta), 1 / shot.fps);
  let preRollFrames = 0;
  for (; preRollFrames < 280; preRollFrames++) {
    await step();
    if (await page.evaluate(() => {
      const theater = window.__theater;
      return theater.immersive && theater.mode === 'table' && theater.placed && theater.anchored
        && !theater.settle && theater.fitUntil === 0;
    })) break;
  }
  if (preRollFrames === 280) throw new Error('IWER table placement did not settle');
  for (let index = 0; index < Math.round(shot.warmup * shot.fps); index++) await step();
  const startTime = await page.evaluate(() => window.__capture.time);
  const rows = [];
  for (let frame = 0; frame < Math.round(shot.seconds * shot.fps); frame++) {
    rows.push(await page.evaluate(async (delta) => {
      await window.__capture.step(delta);
      const theater = window.__theater;
      return { t: window.__capture.time, phase: theater.phase, phaseTime: theater.phaseTime,
        target: theater.baked[theater.order[theater.step % theater.order.length]]?.def.id,
        ghostOpacity: theater.ghost.material.opacity, reform: theater.reform?.elapsed ?? null,
        oneHand: theater.oneHand, hold: theater.hold, secondHand: theater.demoHand2.valid,
        leapt: theater.leapt };
    }, 1 / shot.fps));
  }
  const first = (predicate) => rows.find(predicate)?.t ?? null;
  const last = (predicate) => rows.findLast(predicate)?.t ?? null;
  const relative = (time) => time === null ? null : +(time - startTime).toFixed(3);
  const events = {
    ghostIn: relative(first((row) => row.ghostOpacity > 0.01)),
    ghostOut: relative(last((row) => row.ghostOpacity > 0.01)),
    burnOut: relative(first((row) => row.reform !== null)),
    cutoutComplete: relative(first((row) => row.reform !== null && row.reform >= 1.4)),
    wakeFlare: relative(first((row) => row.phase === 1)),
    walkOffIn: relative(first((row) => row.phase === 1 && row.phaseTime >= 1.5)),
    walkOffOut: relative(first((row) => row.phase === 1 && row.phaseTime >= 2.7)),
  };
  const result = { shotPath, startTime, preRollFrames: preRollFrames + 1, events,
    final: rows.at(-1), secondHandEverValid: rows.some((row) => row.secondHand), errors };
  writeFileSync(`${output}/demo-timeline.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (Object.values(events).some((time) => time === null) || result.secondHandEverValid || errors.length) {
    throw new Error('Incomplete one-hand XR timeline');
  }
} finally {
  await browser.close();
}

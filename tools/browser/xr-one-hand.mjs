import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { injectCase, measureCase, validateCase } from './xr-case.mjs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const output = process.env.XR_ONE_HAND_OUT ?? '../collab/codex/13-evidence';
const frames = [
  ['butterfly', 0.15],
  ['ghost-hint', 7.5],
  ['burn-out', 8.25],
  ['burn-in', 8.8],
  ['one-hand-cutout', 9.5],
];
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
  ...(process.env.CHROME_EXTRA ?? '').split(' ').filter(Boolean)] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.removeItem('shadow-theater.v1');
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
    localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
  });
  const url = new URL(base);
  url.search = '?capture=keepdom&day=20378&first=butterfly';
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
    for (let index = 0; index < 280; index++) {
      await window.__capture.step(1 / 20);
      if (theater.placed && !theater.settle && theater.fitUntil === 0) return {
        mode: theater.mode, first: theater.baked[theater.order[0]].def.id,
        anchored: theater.anchored,
      };
    }
    throw new Error('XR stage did not settle');
  });
  if (placement.first !== 'butterfly') throw new Error(`Expected first butterfly: ${JSON.stringify(placement)}`);
  const prepared = await injectCase(page, { targetId: 'butterfly', kind: 'half' });
  await page.evaluate(() => {
    const painter = window.__theater.painter;
    const caption = painter.caption.bind(painter);
    window.__oneHandCaption = false;
    painter.caption = (text, ...args) => {
      if (text === 'One hand is enough tonight.') window.__oneHandCaption = true;
      return caption(text, ...args);
    };
  });
  const start = await page.evaluate(() => window.__capture.time);
  const observations = [];
  for (const [label, seconds] of frames) {
    const observation = await page.evaluate(async ({ until }) => {
      const theater = window.__theater;
      while (window.__capture.time < until - 0.0001) await window.__capture.step(1 / 20);
      const target = theater.baked[theater.order[0]];
      const sources = theater.renderer.xr.getSession().inputSources.filter((source) => source.hand)
        .map((source) => source.handedness);
      return {
        time: +window.__capture.time.toFixed(2), target: target.def.id, phase: theater.phase,
        leftValid: theater.hands[0].valid, rightValid: theater.hands[1].valid,
        ghostOpacity: +theater.ghost.material.opacity.toFixed(3), oneHandSeconds: +theater.oneHand.toFixed(2),
        reformSeconds: theater.reform ? +theater.reform.elapsed.toFixed(2) : null,
        savedOneHand: !!theater.saved.oneHand, sources,
      };
    }, { until: start + seconds });
    if (!observation.leftValid || observation.rightValid || !observation.sources.includes('left')
      || observation.phase !== 0) throw new Error(`Not a one-hand real-joint seek: ${JSON.stringify(observation)}`);
    observations.push({ label, ...observation });
    await page.screenshot({ path: `${output}/${label}.png` });
  }
  if (observations[1].target !== 'butterfly' || observations[1].ghostOpacity <= 0
    || observations[2].target === 'butterfly' || observations[2].reformSeconds === null
    || observations[4].target === 'butterfly') {
    throw new Error(`One-hand adaptation did not pass through hint and reform: ${JSON.stringify(observations)}`);
  }
  const replacement = observations[4].target;
  const wakePrepared = await injectCase(page, { targetId: replacement, kind: 'wake', side: 'left' });
  const wakeOutcome = await measureCase(page);
  const wake = validateCase(wakePrepared, wakeOutcome);
  await page.screenshot({ path: `${output}/single-hand-wake.png` });
  const state = await page.evaluate(() => ({
    woken: window.__theater.saved.woken,
    deferred: window.__theater.saved.deferred,
    rightConnected: window.IWER_DEVICE.hands.right.connected,
    captionShown: window.__oneHandCaption,
  }));
  if (state.woken[replacement] !== 1 || !state.deferred.includes('butterfly') || state.rightConnected
    || !state.captionShown || errors.length) throw new Error(`XR wake evidence failed: ${JSON.stringify({ state, errors })}`);
  const labels = [...frames.map(([label]) => label), 'single-hand-wake'];
  const tileWidth = 480;
  const tileHeight = 270;
  const strips = await Promise.all(labels.map(async (label, index) => {
    const screenshot = readFileSync(`${output}/${label}.png`);
    const image = await sharp(screenshot).resize(tileWidth, tileHeight).png().toBuffer();
    const caption = Buffer.from(`<svg width="${tileWidth}" height="${tileHeight}"><rect x="0" y="0" width="${tileWidth}" height="30" fill="#0b1220" fill-opacity="0.9"/><text x="12" y="21" font-size="17" fill="#f4e7d0" font-family="sans-serif">${index + 1}. ${label.replaceAll('-', ' ')}</text></svg>`);
    return { image, caption, left: index * tileWidth };
  }));
  await sharp({ create: { width: tileWidth * strips.length, height: tileHeight, channels: 4, background: '#0b1220' } })
    .composite(strips.flatMap(({ image, caption, left }) => [
      { input: image, left, top: 0 }, { input: caption, left, top: 0 },
    ])).png().toFile(`${output}/one-hand-strip.png`);
  const result = { placement, prepared, observations, replacement, wake, state, errors,
    strip: `${output}/one-hand-strip.png` };
  writeFileSync(`${output}/xr-one-hand-results.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}

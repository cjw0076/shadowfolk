import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '../..');
const evidenceDir = resolve(projectRoot, '../collab/codex/21-evidence');
const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const width = 1920;
const height = 1080;
const fps = 30;
const cases = [
  { name: 'gap', night: 1, kindlings: 4, at: 0.8 },
  { name: 'ledge', night: 2, kindlings: 5, at: 0.8 },
  { name: 'highLedge', night: 7, kindlings: 7, at: 0.8 },
  { name: 'river', night: 4, kindlings: 6, at: 0.8 },
  { name: 'crow', night: 3, kindlings: 5, at: 1.0 },
  { name: 'rain', night: 5, kindlings: 6, at: 0.25 },
  { name: 'thorns', night: 6, kindlings: 6, at: 0.8 },
  { name: 'gust', night: 7, kindlings: 7, at: 1.2 },
  { name: 'boulder', night: 7, kindlings: 7, at: 0.25 },
];
const pageErrors = [];

function urlFor(testCase, seed) {
  const url = new URL(base);
  url.search = new URLSearchParams({
    capture: '',
    demo: '',
    crossingOnly: '',
    night: String(testCase.night),
    hazards: testCase.name,
    kindlings: String(testCase.kindlings),
    seed: String(seed),
    day: '20378',
  }).toString();
  return url.toString();
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function captureCase(browser, testCase, index) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (error) => pageErrors.push(`${testCase.name} pageerror: ${error.stack ?? error}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`${testCase.name} console.error: ${message.text()}`);
  });

  try {
    await page.goto(urlFor(testCase, 21_100 + index), { waitUntil: 'load' });
    await page.waitForFunction((kind) => typeof window.__capture?.step === 'function'
      && typeof window.__capture?.state === 'function'
      && window.__theater?.crossing?.level?.hazards?.some((hazard) => hazard.kind === kind),
    testCase.name, { timeout: 60_000 });

    const observation = await page.evaluate(async ({ kind, targetTime, frameRate, maxFrames }) => {
      const capture = window.__capture;
      const theater = window.__theater;
      const expectedRoot = `hazard-${kind}-`;
      let ready = false;
      let frames = 0;
      for (; frames < maxFrames; frames++) {
        const crossing = theater.crossing;
        const layoutKinds = crossing.level.hazards.map((hazard) => hazard.kind);
        const rootNames = crossing.hazards.view.children.map((child) => child.name);
        const rootVisible = rootNames.some((name) => name.startsWith(expectedRoot));
        if (theater.placed && !theater.settle && theater.fitUntil === 0
          && crossing.screenElapsed >= targetTime && layoutKinds.includes(kind) && rootVisible) {
          ready = true;
          break;
        }
        await capture.step(1 / frameRate);
      }
      if (!ready) {
        const crossing = theater.crossing;
        throw new Error(`Timed out waiting for ${kind}: ${JSON.stringify({
          placed: theater.placed,
          settling: !!theater.settle,
          fitUntil: theater.fitUntil,
          screenElapsed: crossing?.screenElapsed,
          layoutKinds: crossing?.level?.hazards?.map((hazard) => hazard.kind),
          roots: crossing?.hazards?.view?.children?.map((child) => child.name),
        })}`);
      }

      capture.camera = {
        pos: [0, 1.2, 0],
        look: [0, 1.2, -1],
        fov: 50,
      };
      await capture.step(1 / frameRate);

      const canvas = document.querySelector('#scene-container canvas') ?? document.querySelector('canvas');
      const crossing = theater.crossing;
      const hazard = crossing.hazards.layouts.find((layout) => layout.kind === kind);
      const runtimeHazard = hazard && crossing.hazards.hazards[hazard.slot];
      const visual = hazard && crossing.hazards.visuals[hazard.slot];
      const witness = kind === 'rain' ? (visual?.drops?.count ?? 0) > 0
        : kind === 'boulder' ? !!runtimeHazard?.boulderActive && !!visual?.boulder?.visible
          : kind === 'gust' ? visual?.wind?.some((streak) => streak.visible) ?? false
            : kind === 'crow' ? !!visual?.crow?.visible
              : !!crossing.hazards.view.children.find((child) => child.name.startsWith(expectedRoot))?.children.length;
      return {
        captureTime: capture.time,
        screenElapsed: crossing.screenElapsed,
        phase: capture.state().phase,
        visualWitness: witness,
        layoutKinds: crossing.level.hazards.map((hazard) => hazard.kind),
        roots: crossing.hazards.view.children.map((child) => ({ name: child.name, visible: child.visible })),
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      };
    }, { kind: testCase.name, targetTime: testCase.at, frameRate: fps, maxFrames: 900 });

    if (!observation.layoutKinds.includes(testCase.name)
      || !observation.roots.some((root) => root.name.startsWith(`hazard-${testCase.name}-`) && root.visible)) {
      throw new Error(`${testCase.name} hazard is not visible in the scene: ${JSON.stringify(observation)}`);
    }
    if (!observation.visualWitness) throw new Error(`${testCase.name} has no visible hazard geometry: ${JSON.stringify(observation)}`);
    if (observation.canvas?.width !== width || observation.canvas?.height !== height) {
      throw new Error(`${testCase.name} render canvas is not ${width}x${height}: ${JSON.stringify(observation.canvas)}`);
    }

    const image = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 60_000 });
    const metadata = await sharp(image).metadata();
    if (metadata.width !== width || metadata.height !== height) {
      throw new Error(`${testCase.name} screenshot is not ${width}x${height}: ${metadata.width}x${metadata.height}`);
    }
    const path = resolve(evidenceDir, `hazard-${testCase.name}.png`);
    writeFileSync(path, image);
    console.log(`PASS ${testCase.name}: ${path} at ${observation.screenElapsed.toFixed(2)}s, ${metadata.width}x${metadata.height}`);
    return { name: testCase.name, buffer: image, path, observation };
  } finally {
    await context.close();
  }
}

async function writeStrip(images) {
  const tileWidth = width / 3;
  const tileHeight = height / 3;
  const tiles = await Promise.all(images.map(async ({ name, buffer }, index) => {
    const label = Buffer.from(`<svg width="${tileWidth}" height="38" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#100d12" fill-opacity="0.82"/><text x="14" y="26" fill="#fff4e4" font-family="Arial, sans-serif" font-size="20" font-weight="700">${String(index + 1).padStart(2, '0')} · ${xml(name)}</text></svg>`);
    const resized = await sharp(buffer).resize(tileWidth, tileHeight, { fit: 'cover' }).png().toBuffer();
    return sharp(resized).composite([{ input: label, left: 0, top: 0 }]).png().toBuffer();
  }));
  const path = resolve(evidenceDir, 'hazards-strip.png');
  await sharp({ create: { width, height, channels: 4, background: '#100d12' } })
    .composite(tiles.map((input, index) => ({
      input,
      left: (index % 3) * tileWidth,
      top: Math.floor(index / 3) * tileHeight,
    })))
    .png()
    .toFile(path);
  const metadata = await sharp(path).metadata();
  if (metadata.width !== width || metadata.height !== height) {
    throw new Error(`Hazard strip is not ${width}x${height}: ${metadata.width}x${metadata.height}`);
  }
  console.log(`PASS hazard strip: ${path} (${metadata.width}x${metadata.height}, 3x3)`);
}

mkdirSync(evidenceDir, { recursive: true });
const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const images = [];
  for (const [index, testCase] of cases.entries()) {
    images.push(await captureCase(browser, testCase, index));
  }
  await writeStrip(images);
  if (pageErrors.length) throw new Error(`Browser errors:\n${pageErrors.join('\n')}`);
  console.log(`PASS: ${images.length} hazard screenshots, all ${width}x${height}; private Playwright Chromium; ${base}`);
} finally {
  await browser.close();
}

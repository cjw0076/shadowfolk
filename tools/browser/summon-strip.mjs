import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '../..');
const evidenceDir = resolve(projectRoot, '../collab/codex/22-evidence');
const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const width = 1920;
const height = 1080;
const captureWidth = 960;
const captureHeight = 540;
const dt = 1 / 30;
const maxFrames = 240;
const seed = 22_205;
const pageErrors = [];

const cases = [
  { kind: 'peacock', hazards: ['gust'], actionHazard: 'gust', night: 1, start: (h) => h.x - 0.15 },
  { kind: 'rabbit', hazards: ['gap'], actionHazard: 'gap', night: 2, start: (h) => h.x - h.width * 0.5 - 0.06 },
  { kind: 'snail', hazards: ['gap'], actionHazard: 'gap', night: 3, start: (h) => h.x - h.width * 0.5 - 0.08 },
  { kind: 'fish', hazards: ['river'], actionHazard: 'river', night: 4, stage: 'river', start: (h) => h.x },
  { kind: 'duck', hazards: ['river'], actionHazard: 'river', night: 5, stage: 'river',
    start: (h) => h.x - h.width * 0.5 + 0.01 },
  { kind: 'butterfly', hazards: ['ledge'], actionHazard: 'ledge', night: 6, stage: 'ledge',
    start: (h) => h.x - h.width * 0.5 - 0.04 },
  { kind: 'heron', hazards: ['gap'], actionHazard: 'gap', night: 7, stage: 'gap', start: (h) => h.x },
  { kind: 'stag', hazards: ['gust'], actionHazard: 'gust', night: 8,
    start: (_h, layouts) => layouts.find((entry) => entry.kind === 'gust').x },
  { kind: 'crab', hazards: ['crow'], actionHazard: 'crow', night: 9, start: (h) => h.x - 0.08 },
  { kind: 'dog', hazards: ['crow'], actionHazard: 'crow', night: 10, start: (h) => h.x - 0.08 },
  { kind: 'elephant', hazards: ['rain'], actionHazard: 'rain', night: 11, start: (h) => h.x },
];

function urlFor(testCase) {
  const url = new URL(base);
  url.search = new URLSearchParams({
    capture: '',
    demo: '',
    crossingOnly: '',
    night: String(testCase.night),
    hazards: testCase.hazards.join(','),
    kindlings: '5',
    seed: String(seed),
    day: '20378',
  }).toString();
  return url.toString();
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function captureCase(page, testCase, index) {
  page.setDefaultTimeout(60_000);
  const url = urlFor(testCase);
  const response = await page.goto(url, { waitUntil: 'load' });
  if (!response?.ok()) throw new Error(`${url} returned HTTP ${response?.status() ?? 'no response'}`);
  await page.waitForFunction((expectedKinds) => typeof window.__capture?.step === 'function'
    && typeof window.__capture?.state === 'function'
    && expectedKinds.every((kind) => window.__theater?.crossing?.level?.hazards?.some((hazard) => hazard.kind === kind)),
  testCase.hazards, { timeout: 60_000 });

  const layouts = await page.evaluate((hazardKinds) => window.__theater.crossing.hazards.layouts
    .filter((entry) => hazardKinds.includes(entry.kind))
    .map(({ kind, slot, x, width }) => ({ kind, slot, x, width })), testCase.hazards);
  const startX = testCase.start(layouts.find((entry) => entry.kind === testCase.hazards[0]), layouts);

  const result = await page.evaluate(async ({ kind, actionHazard, stagingHazardKind, startX, frames, stepSeconds, camera }) => {
      const capture = window.__capture;
      const theater = window.__theater;
      const crossing = theater.crossing;
      const layouts = crossing.hazards.layouts;
      const primary = layouts.find((entry) => entry.kind === actionHazard.split(' + ')[0]);
      if (!primary) throw new Error(`Missing primary hazard ${actionHazard}`);
      capture.camera = camera;

      let settled = false;
      for (let frame = 0; frame < frames; frame++) {
        if (theater.placed && !theater.settle && theater.fitUntil === 0
          && !crossing.wiping && !crossing.finished) {
          settled = true;
          break;
        }
        await capture.step(stepSeconds);
      }
      if (!settled) throw new Error(`Theater did not settle before capture for ${kind}`);

      theater.summonDemoKind = null;
      if (stagingHazardKind) {
        const walker = crossing.folk.agents.slice(0, crossing.folk.count)
          .find((entry) => entry.state === 'walking' || entry.state === 'falling');
        if (!walker) throw new Error(`No active Kindling to stage for ${kind}`);
        const layout = layouts.find((entry) => entry.kind === stagingHazardKind);
        if (!layout) throw new Error(`Missing staging hazard ${stagingHazardKind}`);
        walker.heading = 1;
        walker.vx = walker.vy = 0;
        walker.carried = false;
        if (kind === 'fish') {
          walker.x = layout.x;
          walker.y = layout.floorY - 0.02;
          walker.state = 'falling';
        } else if (kind === 'duck') {
          walker.x = layout.x - layout.width * 0.5 + 0.01;
          walker.y = layout.floorY + 0.011;
          walker.state = 'walking';
        } else if (kind === 'butterfly') {
          walker.x = layout.x - 0.03;
          walker.y = layout.floorY + 0.011;
          walker.state = 'walking';
        } else {
          walker.x = layout.x;
          walker.y = layout.floorY - 0.02;
          walker.state = 'falling';
        }
        walker.fallStartY = walker.y;
      }
      const spawned = crossing.summons.spawn(kind, startX, -0.18);
      if (!spawned) throw new Error(`${kind} summon was rejected at x=${startX.toFixed(3)}`);
      theater.driveCrossingDemo = () => {
        theater.demoHand.valid = false;
        theater.demoHand2.valid = false;
      };
      theater.demoHand.valid = false;
      theater.demoHand2.valid = false;

      let effectSeen = false;
      let advanced = 0;
      for (; advanced < frames; advanced++) {
        const agent = crossing.summons.agents.find((entry) => entry.kind === kind && entry.age < 8.8);
        if (!agent) break;
        const firstHazard = layouts.find((entry) => entry.kind === actionHazard.split(' + ')[0]);
        const runtime = firstHazard && crossing.hazards.hazards[firstHazard.slot];
        const condition = kind === 'peacock'
          ? layouts.some((entry) => entry.kind === 'gust'
            && crossing.hazards.hazards[entry.slot]?.suppressedUntil > crossing.hazards.hazards[entry.slot]?.clock)
        : agent.uses > 0;
        if (condition) {
          effectSeen = true;
          break;
        }
        if (crossing.finished || crossing.wiping) break;
        await capture.step(stepSeconds);
      }

      const agent = crossing.summons.agents.find((entry) => entry.kind === kind && entry.age < 8.8);
      const namedHazards = actionHazard.split(' + ').map((name) => name.toLowerCase());
      const visibleHazards = layouts.filter((entry) => namedHazards.includes(entry.kind.toLowerCase()));
      const hazardStates = visibleHazards.map((entry) => {
        const runtime = crossing.hazards.hazards[entry.slot];
        return {
          kind: entry.kind,
          slot: entry.slot,
          x: +entry.x.toFixed(3),
          width: +entry.width.toFixed(3),
          visible: !!crossing.hazards.visuals[entry.slot]?.root.visible,
          removed: runtime?.removed ?? false,
          suppressed: runtime ? runtime.suppressedUntil > runtime.clock : false,
          crowMode: runtime?.crowMode ?? null,
          boulderActive: runtime?.boulderActive ?? null,
          activeRaindrops: runtime?.rainActive?.reduce((count, active) => count + active, 0) ?? null,
        };
      });
      const sprite = crossing.summons.sprites.find((entry, slot) => crossing.summons.agents[slot] === agent);
      const canvas = document.querySelector('#scene-container canvas') ?? document.querySelector('canvas');
      return {
        time: capture.time,
        screenElapsed: crossing.screenElapsed,
        uses: agent?.uses ?? 0,
        agentVisible: !!sprite?.ink.visible,
        hazardVisible: hazardStates.some((entry) => entry.visible),
        hazardStates,
        hazardStats: {
          ...crossing.hazards.stats,
          ashByHazard: { ...crossing.hazards.stats.ashByHazard },
          active: hazardStates,
        },
        effectSeen,
        crossingFinished: crossing.finished,
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      };
    }, {
      kind: testCase.kind,
      actionHazard: testCase.actionHazard,
      stagingHazardKind: testCase.stage ?? '',
      startX,
      frames: maxFrames,
      stepSeconds: dt,
      camera: { pos: [0, 1.2, 0], look: [0, 1.2, -1], fov: 50 },
    });

  if (!result.agentVisible) throw new Error(`${testCase.kind} stencil was not visible at capture time`);
  if (!result.hazardVisible) throw new Error(`${testCase.actionHazard} visual was not visible at capture time`);
  if (result.canvas?.width !== captureWidth || result.canvas?.height !== captureHeight) {
    throw new Error(`Render canvas was ${JSON.stringify(result.canvas)}, expected ${captureWidth}x${captureHeight}`);
  }

  const image = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 60_000 });
  const metadata = await sharp(image).metadata();
  if (metadata.width !== captureWidth || metadata.height !== captureHeight) {
    throw new Error(`Screenshot was ${metadata.width}x${metadata.height}, expected ${captureWidth}x${captureHeight}`);
  }
  const filename = `${String(index + 1).padStart(2, '0')}-${testCase.kind}.png`;
  writeFileSync(resolve(evidenceDir, filename), image);
  const snapshot = {
    kind: testCase.kind,
    hazard: testCase.actionHazard,
    time: +result.time.toFixed(3),
    uses: result.uses,
    hazardStats: result.hazardStats,
    screenshot: filename,
  };
  console.log(`${result.effectSeen ? 'PASS' : 'MISS'} ${testCase.kind} / ${testCase.actionHazard}: uses=${result.uses}, t=${snapshot.time}s, ${filename}`);
  return { snapshot, effectSeen: result.effectSeen };
}

async function captureCaseWithRetries(page, testCase, index) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await captureCase(page, testCase, index);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`Retry ${testCase.kind} after navigation/runtime interruption (${attempt}/3)`);
        await page.waitForTimeout(750);
      }
    }
  }
  throw lastError;
}

async function writeStrip(captures) {
  const columns = 4;
  const rows = 3;
  const tileWidth = width / columns;
  const tileHeight = height / rows;
  const imageTop = 44;
  const imageHeight = 270;
  const tileBuffers = await Promise.all(captures.map(async ({ snapshot }, index) => {
    const screenshot = await sharp(resolve(evidenceDir, snapshot.screenshot))
      .resize(tileWidth, imageHeight, { fit: 'fill' }).png().toBuffer();
    const title = `${String(index + 1).padStart(2, '0')}  ${snapshot.kind.toUpperCase()}  ·  ${snapshot.hazard.toUpperCase()}`;
    const header = Buffer.from(`<svg width="${tileWidth}" height="${tileHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#100d12"/><rect width="100%" height="38" fill="#251e21"/><text x="14" y="26" fill="#fff4e4" font-family="Arial, sans-serif" font-size="17" font-weight="700">${xml(title)}</text><text x="14" y="344" fill="#dfcbb1" font-family="Arial, sans-serif" font-size="14">USES ${snapshot.uses}  ·  ${snapshot.time.toFixed(2)} s</text></svg>`);
    return sharp(header).composite([{ input: screenshot, left: 0, top: imageTop }]).png().toBuffer();
  }));

  const summary = Buffer.from(`<svg width="${tileWidth}" height="${tileHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#171317"/><path d="M28 32h424v1H28z" fill="#8d7152"/><text x="30" y="94" fill="#fff4e4" font-family="Arial, sans-serif" font-size="23" font-weight="700">11 SUMMON GIFTS</text><text x="30" y="139" fill="#d7c4ad" font-family="Arial, sans-serif" font-size="17">Built-in creature stencils</text><text x="30" y="170" fill="#d7c4ad" font-family="Arial, sans-serif" font-size="17">Playwright Chromium · fixed steps</text><text x="30" y="201" fill="#d7c4ad" font-family="Arial, sans-serif" font-size="17">1920 × 1080 · 4 × 3</text><path d="M28 226h424v1H28z" fill="#8d7152"/><text x="30" y="267" fill="#fff4e4" font-family="Arial, sans-serif" font-size="15">A missed use is reported with its snapshot.</text></svg>`);
  tileBuffers.push(summary);

  const stripPath = resolve(evidenceDir, 'summons-strip.png');
  await sharp({ create: { width, height, channels: 4, background: '#100d12' } })
    .composite(tileBuffers.map((input, index) => ({
      input,
      left: (index % columns) * tileWidth,
      top: Math.floor(index / columns) * tileHeight,
    })))
    .png()
    .toFile(stripPath);
  const metadata = await sharp(stripPath).metadata();
  if (metadata.width !== width || metadata.height !== height) {
    throw new Error(`Strip was ${metadata.width}x${metadata.height}, expected ${width}x${height}`);
  }
  console.log(`PASS strip: ${stripPath} (${metadata.width}x${metadata.height}, ${columns}x${rows})`);
}

mkdirSync(evidenceDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  viewport: { width: captureWidth, height: captureHeight },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
});
context.addInitScript(() => localStorage.clear());
const page = await context.newPage();
let activeCase = 'startup';
page.on('pageerror', (error) => pageErrors.push(`${activeCase}: ${error.stack ?? error}`));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`${activeCase}: ${message.text()}`);
});

try {
  const captures = [];
  for (const [index, testCase] of cases.entries()) {
    activeCase = testCase.kind;
    captures.push(await captureCaseWithRetries(page, testCase, index));
  }
  await writeStrip(captures);
  const snapshots = captures.map(({ snapshot }) => snapshot);
  const snapshotsPath = resolve(evidenceDir, 'summon-snapshots.json');
  writeFileSync(snapshotsPath, `${JSON.stringify(snapshots, null, 2)}\n`);
  const misses = captures.filter(({ effectSeen }) => !effectSeen).map(({ snapshot }) => snapshot.kind);
  console.log(`Wrote ${snapshots.length} snapshots: ${snapshotsPath}`);
  if (misses.length) {
    console.error(`No gift use observed before capture fallback: ${misses.join(', ')}`);
    process.exitCode = 1;
  }
  if (pageErrors.length) {
    console.error(`Browser errors:\n${pageErrors.join('\n')}`);
    process.exitCode = 1;
  }
} finally {
  await context.close();
  await browser.close();
}

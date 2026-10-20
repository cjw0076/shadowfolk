import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [secondsArgument = '20'] = process.argv.slice(2);
const seconds = Number(secondsArgument);
if (!Number.isFinite(seconds) || seconds <= 0) {
  throw new Error('Usage: node tools/browser/xr-play-budget.mjs [seconds]');
}

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const url = new URL(base);
url.searchParams.set('playSandbox', '');
url.searchParams.set('perf', '');
url.searchParams.set('capture', 'keepdom');
const outputPath = process.env.XR_PLAY_BUDGET_OUT
  ? resolve(process.cwd(), process.env.XR_PLAY_BUDGET_OUT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../../collab/codex/20-evidence/xr-play-budget.json');
const folkCount = 40;
const stepSeconds = 1 / 60;
const warmupFrames = 300;
const measuredFrames = Math.ceil(seconds / stepSeconds);
const chunkFrames = 30;
const round = (value) => Number.isFinite(value) ? +value.toFixed(3) : null;

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, p50: null, p95: null, mean: null, max: null };
  return {
    count: sorted.length,
    p50: round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    max: round(sorted.at(-1)),
  };
}

const browser = await chromium.launch({ args: [
  '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan',
  '--ignore-gpu-blocklist', '--enable-gpu', '--ignore-certificate-errors',
  ...(process.env.CHROME_EXTRA ?? '').split(' ').filter(Boolean),
] });

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  const cleanUrl = new URL(url);
  cleanUrl.search = '';
  await page.goto(cleanUrl.toString(), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.removeItem('shadow-theater.v1');
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
    localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
  });
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater && window.__perf
    && window.IWER_DEVICE?.sessionOffered, null, { timeout: 60000 });

  await page.evaluate(async () => {
    const device = window.IWER_DEVICE;
    device.position.set(-0.9, 1.25, -1.19);
    const pitch = -8 * Math.PI / 180;
    const yaw = 90 * Math.PI / 180;
    device.quaternion.set(
      Math.sin(pitch / 2) * Math.cos(yaw / 2),
      Math.cos(pitch / 2) * Math.sin(yaw / 2),
      -Math.sin(pitch / 2) * Math.sin(yaw / 2),
      Math.cos(pitch / 2) * Math.cos(yaw / 2),
    );
    device.remote.activateCaptureMode();
    device.controlMode = 'programmatic';
    device.primaryInputMode = 'hand';
    device.hands.left.connected = false;
    device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
  });

  const placement = await page.evaluate(async () => {
    const theater = window.__theater;
    for (let frame = 0; frame < 20 && !theater.immersive; frame++) await window.__capture.step(1 / 60);
    if (!theater.immersive) throw new Error('IWER did not enter immersive XR');
    theater.endSession();
    theater.beginSession();
    for (let frame = 0; frame < 300; frame++) {
      await window.__capture.step(1 / 30);
      if (theater.placed && !theater.settle && theater.fitUntil === 0 && theater.mode === 'table') {
        return { immersive: theater.immersive, mode: theater.mode, placed: theater.placed, settled: true };
      }
    }
    return {
      immersive: theater.immersive,
      mode: theater.mode,
      placed: theater.placed,
      settled: false,
      settling: !!theater.settle,
      fitUntil: theater.fitUntil,
    };
  });
  if (!placement.settled || !placement.immersive) {
    throw new Error(`IWER table placement failed: ${JSON.stringify(placement)}`);
  }

  const setup = await page.evaluate((requestedFolk) => {
    const theater = window.__theater;
    const world = theater.playFolk;
    if (!world || !theater.playField || !theater.playView) throw new Error('Play sandbox is unavailable');

    theater.demo = true;
    theater.playDemoAct = 0;
    theater.playDemoAt = theater.animationTime;
    theater.playDemoSpawned = 0;
    const drivePlayDemo = theater.drivePlayDemo.bind(theater);
    drivePlayDemo(1 / 60);

    world.reset();
    world.configure({ waveCount: 0 });
    theater.playField.setStaticRect(-0.50, -0.212, -0.48, -0.16);
    theater.playField.setStaticRect(-0.13, -0.212, -0.11, -0.16);
    for (let index = 0; index < requestedFolk; index++) {
      const x = -0.47 + (index / (requestedFolk - 1)) * 0.32;
      const agent = world.spawn(x, -0.181, index % 2 === 0 ? 1 : -1);
      if (!agent) throw new Error(`Could only spawn ${index} of ${requestedFolk} folk`);
    }

    const first = theater.demoHand;
    const second = theater.demoHand2;
    const firstJoints = first.joints.slice();
    const firstRadii = first.radii.slice();
    const frame = theater.frame;
    const moveRig = (rig, dx, dy) => {
      rig.joints.set(firstJoints);
      rig.radii.set(firstRadii);
      for (let joint = 0; joint < firstRadii.length; joint++) {
        const offset = joint * 3;
        rig.joints[offset] += dx * frame.rx + dy * frame.ux;
        rig.joints[offset + 1] += dx * frame.ry + dy * frame.uy;
        rig.joints[offset + 2] += dx * frame.rz + dy * frame.uz;
      }
      rig.valid = true;
    };
    theater.drivePlayDemo = (dt) => {
      theater.playDemoAt = theater.animationTime;
      drivePlayDemo(dt);
      const time = theater.animationTime;
      moveRig(first, 0.15 + 0.035 * Math.sin(time * 1.4), 0.01 * Math.sin(time * 1.1));
      moveRig(second, 0.35 + 0.035 * Math.sin(time * 1.05 + 1.2), 0.01 * Math.cos(time * 1.25));
    };

    return {
      folkCount: world.count,
      activeFolk: world.agents.slice(0, world.count).filter((agent) => agent.state !== 'inactive').length,
      mode: theater.mode,
      demoEnabled: theater.demo,
      proceduralHandRigs: 2,
      realInputHandsConnected: deviceHandsConnected(),
      collisionFixture: '40 walkers sustained on the authored left platform between two bench-only stops; the authored gap remains unchanged',
    };

    function deviceHandsConnected() {
      return window.IWER_DEVICE.hands.left.connected || window.IWER_DEVICE.hands.right.connected;
    }
  }, folkCount);
  if (setup.folkCount !== folkCount || setup.activeFolk !== folkCount || setup.proceduralHandRigs !== 2) {
    throw new Error(`XR play setup incomplete: ${JSON.stringify(setup)}`);
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

  const advance = async (frames) => page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame++) await window.__capture.step(1 / 60);
  }, frames);
  for (let warmed = 0; warmed < warmupFrames; warmed += chunkFrames) {
    await advance(Math.min(chunkFrames, warmupFrames - warmed));
  }

  const playViewTextureVersionsBefore = await page.evaluate(() => {
    const view = window.__theater.playView;
    const meshes = {
      terrain: view.terrain,
      folk: view.folk,
      ash: view.ash,
      sparkle: view.sparkle,
      debug: view.debugMesh,
    };
    return Object.fromEntries(Object.entries(meshes).map(([name, mesh]) => [
      name, mesh?.material?.map?.version ?? null,
    ]));
  });
  await page.evaluate(() => {
    const perf = window.__perf;
    for (const key of ['play', 'playClear', 'playInk', 'playAgents', 'playView', 'update', 'uploadSubmissions', 'uploadBytes']) perf[key].count = 0;
    perf.pendingUploadSubmissions = 0;
    perf.pendingUploadBytes = 0;
  });

  const samples = { play: [], playClear: [], playInk: [], playAgents: [], playView: [], update: [], uploadSubmissions: [], uploadBytes: [] };
  const cursors = { play: 0, playClear: 0, playInk: 0, playAgents: 0, playView: 0, update: 0, uploadSubmissions: 0, uploadBytes: 0 };
  const measurementStartedAt = Date.now();
  for (let measured = 0; measured < measuredFrames; measured += chunkFrames) {
    const frameCount = Math.min(chunkFrames, measuredFrames - measured);
    const batch = await page.evaluate(async ({ frames, previousCounts }) => {
      for (let frame = 0; frame < frames; frame++) await window.__capture.step(1 / 60);
      const perf = window.__perf;
      const read = (series, cursor) => {
        const end = series.count;
        const start = Math.max(cursor, end - series.values.length);
        const values = [];
        for (let index = start; index < end; index++) values.push(series.values[index % series.values.length]);
        return { count: end, values };
      };
      return {
        play: read(perf.play, previousCounts.play),
        playClear: read(perf.playClear, previousCounts.playClear),
        playInk: read(perf.playInk, previousCounts.playInk),
        playAgents: read(perf.playAgents, previousCounts.playAgents),
        playView: read(perf.playView, previousCounts.playView),
        update: read(perf.update, previousCounts.update),
        uploadSubmissions: read(perf.uploadSubmissions, previousCounts.uploadSubmissions),
        uploadBytes: read(perf.uploadBytes, previousCounts.uploadBytes),
      };
    }, { frames: frameCount, previousCounts: cursors });
    for (const key of Object.keys(samples)) {
      samples[key].push(...batch[key].values);
      cursors[key] = batch[key].count;
    }
  }
  const measurementWallSeconds = (Date.now() - measurementStartedAt) / 1000;

  const finalState = await page.evaluate(() => {
    const theater = window.__theater;
    const world = theater.playFolk;
    const counts = { walking: 0, falling: 0, ash: 0, home: 0, inactive: 0 };
    for (let index = 0; index < world.count; index++) counts[world.agents[index].state]++;
    const perf = window.__perf;
    const view = theater.playView;
    const meshes = {
      terrain: view.terrain,
      folk: view.folk,
      ash: view.ash,
      sparkle: view.sparkle,
      debug: view.debugMesh,
    };
    return {
      immersive: theater.immersive,
      mode: theater.mode,
      placed: theater.placed,
      folkCount: world.count,
      folkStates: counts,
      activeFolk: counts.walking + counts.falling,
      playViewTextureVersions: Object.fromEntries(Object.entries(meshes).map(([name, mesh]) => [
        name, mesh?.material?.map?.version ?? null,
      ])),
      firstDemoHandValid: theater.demoHand.valid && theater.demoHand.flat.valid,
      secondDemoHandValid: theater.demoHand2.valid && theater.demoHand2.flat.valid,
      pendingUploadSubmissions: perf.pendingUploadSubmissions,
      pendingUploadBytes: perf.pendingUploadBytes,
    };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const uploadPerFrame = samples.uploadSubmissions.slice(1).concat(finalState.pendingUploadSubmissions);
  const uploadBytesPerFrame = samples.uploadBytes.slice(1).concat(finalState.pendingUploadBytes);
  const uploadDistribution = {};
  for (const count of uploadPerFrame) uploadDistribution[count] = (uploadDistribution[count] ?? 0) + 1;
  const playViewTextureChanges = Object.fromEntries(Object.entries(playViewTextureVersionsBefore)
    .filter(([name, version]) => version !== null && finalState.playViewTextureVersions[name] !== null)
    .map(([name, version]) => [name, finalState.playViewTextureVersions[name] - version]));
  const playViewTextureUpdates = Object.values(playViewTextureChanges).reduce((sum, value) => sum + value, 0);
  const framesAboveShadowAllowance = uploadPerFrame.filter((count) => count > 1).length;
  const textureUploads = {
    globalObserved: {
      source: 'window.__perf uploadSubmissions/uploadBytes (WebGL texSubImage2D)',
      existingShadowUploadAllowancePerFrame: 1,
      measuredFrames: uploadPerFrame.length,
      submissionsPerFrameDistribution: uploadDistribution,
      submissionsPerFrame: summarize(uploadPerFrame),
      totalSubmissions: uploadPerFrame.reduce((sum, count) => sum + count, 0),
      framesAboveShadowAllowance,
      excessSubmissionsAboveShadowAllowance: uploadPerFrame.reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      totalBytes: uploadBytesPerFrame.reduce((sum, bytes) => sum + bytes, 0),
      baselineComparison: 'Not run; global submissions include ScreenPainter’s existing shadow-canvas upload.',
    },
    playView: {
      textureVersionChangesAfterWarmup: playViewTextureChanges,
      dynamicTextureUpdatesAfterWarmup: playViewTextureUpdates,
      noNewPerFrameTextureUploads: playViewTextureUpdates === 0,
    },
  };
  const playUpdate = summarize(samples.play);
  const wholeUpdate = summarize(samples.update);
  const passed = playUpdate.count > 0 && wholeUpdate.count === measuredFrames
    && playUpdate.p95 <= 1.5 && textureUploads.playView.noNewPerFrameTextureUploads
    && finalState.immersive && finalState.placed && finalState.folkCount === folkCount
    && finalState.activeFolk === folkCount
    && finalState.firstDemoHandValid && finalState.secondDemoHandValid && errors.length === 0;
  const result = {
    benchmark: 'codex-20-xr-play-budget',
    url: url.toString(),
    browser: 'own Playwright Chromium process',
    cpuThrottleRate: 6,
    requestedSeconds: seconds,
    simulatedSeconds: round(measuredFrames * stepSeconds),
    measurementWallSeconds: round(measurementWallSeconds),
    warmupSeconds: round(warmupFrames * stepSeconds),
    placement,
    setup,
    finalState,
    hands: {
      method: 'two moving theater.demoHand procedural rigs during IWER XR',
      realXRHandJointsInjected: false,
      note: 'Uses the permitted procedural demo-hand option; real IWER joint injection is covered by the separate real-joint bench.',
    },
    metrics: { playUpdateMs: playUpdate, inkClearMs: summarize(samples.playClear),
      inkHandMs: summarize(samples.playInk), folkMs: summarize(samples.playAgents),
      playViewMs: summarize(samples.playView), wholeUpdateMs: wholeUpdate },
    target: { playUpdateP95Ms: 1.5, met: playUpdate.p95 !== null && playUpdate.p95 <= 1.5 },
    textureUploads,
    errors,
    passed,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputPath, result }, null, 2));
} finally {
  await browser.close();
}

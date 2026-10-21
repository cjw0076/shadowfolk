import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [secondsArgument = '20'] = process.argv.slice(2);
const seconds = Number(secondsArgument);
const summonBudget = process.env.XR_SUMMON_BUDGET === '1';
if (!Number.isFinite(seconds) || seconds <= 0) {
  throw new Error('Usage: node tools/browser/xr-crossing-budget.mjs [seconds]');
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const url = new URL(base);
url.search = new URLSearchParams({
  capture: 'keepdom',
  perf: '',
  crossingOnly: '',
  night: '5',
  hazards: 'rain,crow',
  kindlings: '40',
  seed: '21021',
}).toString();
const outputPath = process.env.XR_CROSSING_BUDGET_OUT
  ? resolve(process.cwd(), process.env.XR_CROSSING_BUDGET_OUT)
  : resolve(projectRoot, '../collab/codex/21-evidence/xr-crossing-budget.json');
const kindlingCount = 40;
const stepSeconds = 1 / 60;
const warmupFrames = summonBudget ? 120 : 300;
const measuredFrames = Math.ceil(seconds / stepSeconds);
const chunkFrames = 30;
const sampleKeys = [
  'play', 'playHazards', 'playClear', 'playInk', 'playAgents', 'playView', 'update',
  'uploadSubmissions', 'uploadBytes',
];
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

function histogram(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => Number(left[0]) - Number(right[0])));
}

function changedTextureNames(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]);
}

const result = {
  benchmark: summonBudget ? 'codex-22-xr-summon-budget' : 'codex-21-xr-crossing-budget',
  url: url.toString(),
  browser: 'private Playwright Chromium with IWER',
  cpuThrottleRate: 6,
  requestedSeconds: seconds,
  simulatedSeconds: round(measuredFrames * stepSeconds),
  warmupSeconds: round(warmupFrames * stepSeconds),
  setup: null,
  finalState: null,
  metrics: null,
  thresholds: { playP95Ms: summonBudget ? 2.3 : 2, hazardsP95Ms: 0.5, wholeP95Ms: 5.5, playTextureVersionChanges: 0 },
  textureUploads: null,
  pageErrors: [],
  passed: false,
};

const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan',
  '--ignore-gpu-blocklist', '--enable-gpu',
  ...(process.env.CHROME_EXTRA ?? '').split(' ').filter(Boolean),
] });
let cdp = null;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  page.on('pageerror', (error) => result.pageErrors.push(error.stack ?? String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') result.pageErrors.push(`console.error: ${message.text()}`);
  });

  const cleanUrl = new URL(url);
  cleanUrl.search = '';
  await page.goto(cleanUrl.toString(), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.removeItem('shadow-theater.v1');
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
    localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
  });
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater?.crossing && window.__perf
    && window.IWER_DEVICE?.sessionOffered, null, { timeout: 60_000 });

  const placement = await page.evaluate(async () => {
    const device = window.IWER_DEVICE;
    device.position.set(-0.9, 1.25, -1.19);
    const pitch = -8 * Math.PI / 180;
    const yaw = Math.PI / 2;
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

    const theater = window.__theater;
    for (let frame = 0; frame < 20 && !theater.immersive; frame++) await window.__capture.step(1 / 60);
    if (!theater.immersive) throw new Error('IWER did not enter immersive XR');
    theater.endSession();
    theater.beginSession();

    let earlySpawned = 0;
    for (let frame = 0; frame < 300 && (!theater.placed || theater.settle || theater.fitUntil); frame++) {
      await window.__capture.step(1 / 30);
      if (!theater.placed || theater.settle || theater.fitUntil) earlySpawned = Math.max(earlySpawned, theater.playFolk.count);
    }
    if (!theater.placed || theater.settle || theater.fitUntil) {
      throw new Error(`IWER table placement failed: ${JSON.stringify({
        mode: theater.mode, placed: theater.placed, settling: !!theater.settle, fitUntil: theater.fitUntil,
      })}`);
    }
    if (earlySpawned) throw new Error(`Kindlings spawned before placement settled: ${earlySpawned}`);
    return { immersive: theater.immersive, mode: theater.mode, placed: theater.placed, earlySpawned };
  });

  await page.waitForFunction(() => {
    const theater = window.__theater;
    const device = window.IWER_DEVICE;
    return theater?.playField?.sample && theater?.playFolk?.spawn && theater?.playView?.root
      && theater?.crossing?.hazards?.layouts && device?.hands?.left?.inputSource?.hand
      && device?.hands?.right?.inputSource?.hand;
  }, null, { timeout: 30_000 });

  const setup = await page.evaluate(({ requestedKindlings, seed }) => {
    const rounded = (value) => Number.isFinite(value) ? Number(value.toFixed(6)) : null;
    const theater = window.__theater;
    const crossing = theater.crossing;
    const folk = theater.playFolk;
    const device = window.IWER_DEVICE;
    const perf = window.__perf;
    if (!crossing || !folk || !theater.playField || !theater.playView || !perf?.playHazards) {
      throw new Error('Crossing runtime, play field/view, or hazard timing samples are unavailable');
    }

    theater.demo = false;
    theater.demoHand.valid = false;
    theater.demoHand2.valid = false;
    theater.crossingSeed = seed;
    theater.beginCrossing(5);
    const screenIndex = crossing.levels.findIndex((level) => {
      const kinds = level.hazards.map((hazard) => hazard.kind);
      return kinds.includes('rain') && kinds.includes('crow');
    });
    if (screenIndex < 0) throw new Error('Generated crossing has no screen containing both rain and crow');
    crossing.screen = screenIndex;
    if (typeof crossing.startScreen !== 'function') throw new Error('Crossing screen reset hook is unavailable');
    crossing.startScreen();
    const level = crossing.level;
    if (level.kindlings !== requestedKindlings) {
      throw new Error(`Expected ${requestedKindlings} Kindlings on the selected screen, got ${level.kindlings}`);
    }
    const rain = crossing.hazards.layouts.find((hazard) => hazard.kind === 'rain');
    const crow = crossing.hazards.layouts.find((hazard) => hazard.kind === 'crow');
    if (!rain || !crow) throw new Error('Rain or crow runtime layout is missing');

    folk.reset();
    folk.configure({ waveCount: 0 });
    for (let index = 0; index < requestedKindlings; index++) {
      const x = -0.46 + index / (requestedKindlings - 1) * 0.78;
      const agent = folk.spawn(x, -0.185, index % 2 === 0 ? 1 : -1);
      if (!agent) throw new Error(`Could only place ${index} of ${requestedKindlings} Kindlings`);
    }
    const originalFolkEvent = folk.onEvent;
    folk.onEvent = (kind, agent) => {
      if (kind === 'home' || kind === 'ash') {
        if (kind === 'home') folk.homeCount = Math.max(0, folk.homeCount - 1);
        else folk.ashCount = Math.max(0, folk.ashCount - 1);
        agent.x = folk.spawnX;
        agent.y = folk.spawnY;
        agent.vx = 0;
        agent.vy = 0;
        agent.heading = 1;
        agent.fallStartY = folk.spawnY;
        agent.age = 0;
        agent.state = 'falling';
        return;
      }
      originalFolkEvent?.(kind, agent);
    };

    const handModelPromise = import('/src/shadow/hand-model.ts');
    const createHandRig = async (side, normalizedScale, poseId) => {
      const handModel = await handModelPromise;
      const input = device.hands[side];
      let pose = handModel.orient(handModel.basePoses.relaxed(), [-25, 0, 0]);
      if (side === 'right') pose = handModel.mirror(pose);
      const poseState = Object.getOwnPropertySymbols(input).map((symbol) => input[symbol])
        .find((value) => value?.poses?.default && value?.poses?.pinch);
      if (!poseState) throw new Error(`IWER ${side}-hand pose registry is unavailable`);
      const names = Array.from(input.inputSource.hand.keys());
      if (names.length !== handModel.JOINT_COUNT || pose.radii.length !== handModel.JOINT_COUNT) {
        throw new Error(`IWER ${side}-hand joint layout mismatch: ${names.length}`);
      }
      let meanX = 0, meanY = 0;
      for (let joint = 0; joint < handModel.JOINT_COUNT; joint++) {
        meanX += pose.mats[joint * 16 + 12] / handModel.JOINT_COUNT;
        meanY += pose.mats[joint * 16 + 13] / handModel.JOINT_COUNT;
      }
      const jointTransforms = {};
      for (let joint = 0; joint < handModel.JOINT_COUNT; joint++) {
        jointTransforms[names[joint]] = {
          offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          radius: pose.radii[joint],
        };
      }
      poseState.poses[poseId] = { jointTransforms };
      const Vector3 = theater.anchor.constructor;
      const inversePlayer = theater.player.matrixWorld.clone();
      const center = new Vector3();
      const worldPoints = Array.from({ length: handModel.JOINT_COUNT }, () => new Vector3());
      const localPoints = Array.from({ length: handModel.JOINT_COUNT }, () => new Vector3());
      const projection = {
        input, pose, poseState, poseId, normalizedScale, jointTransforms, names, worldPoints, localPoints,
        center, inversePlayer, meanX, meanY,
      };
      return projection;
    };

    const rigsPromise = Promise.all([
      createHandRig('left', 1.45, 'codex-21-crossing-budget-left'),
      createHandRig('right', 1, 'codex-21-crossing-budget-right'),
    ]);
    return rigsPromise.then((rigs) => {
      const frame = theater.frame;
      const light = theater.lanternPos;
      const lightX = (light.x - frame.ox) * frame.rx + (light.y - frame.oy) * frame.ry + (light.z - frame.oz) * frame.rz;
      const lightY = (light.x - frame.ox) * frame.ux + (light.y - frame.oy) * frame.uy + (light.z - frame.oz) * frame.uz;
      const lightDepth = (light.x - frame.ox) * frame.nx + (light.y - frame.oy) * frame.ny + (light.z - frame.oz) * frame.nz;
      const deviceHands = [device.hands.left, device.hands.right];
      device.primaryInputMode = 'hand';
      deviceHands[0].connected = true;
      deviceHands[1].connected = true;
      device.controlMode = 'programmatic';

      const movement = {
        simulatedSeconds: 0,
        leftMinX: Infinity,
        leftMaxX: -Infinity,
        rightMinX: Infinity,
        rightMaxX: -Infinity,
      };
      const inject = (rig, screenPoint) => {
        const poseScale = 2.5 * rig.normalizedScale;
        const handDepth = lightDepth * (1 - 1 / poseScale);
        const handX = lightX + (screenPoint.x - lightX) / poseScale;
        const handY = lightY + (screenPoint.y - lightY) / poseScale;
        theater.player.updateMatrixWorld(true);
        rig.inversePlayer.copy(theater.player.matrixWorld).invert();
        rig.center.set(0, 0, 0);
        for (let joint = 0; joint < rig.worldPoints.length; joint++) {
          const offset = joint * 16 + 12;
          const x = rig.pose.mats[offset] - rig.meanX;
          const y = rig.pose.mats[offset + 1] - rig.meanY;
          rig.worldPoints[joint].set(
            frame.ox + (handX + x) * frame.rx + (handY + y) * frame.ux + handDepth * frame.nx,
            frame.oy + (handX + x) * frame.ry + (handY + y) * frame.uy + handDepth * frame.ny,
            frame.oz + (handX + x) * frame.rz + (handY + y) * frame.uz + handDepth * frame.nz,
          );
          rig.localPoints[joint].copy(rig.worldPoints[joint]).applyMatrix4(rig.inversePlayer);
          rig.center.add(rig.localPoints[joint]);
        }
        rig.center.multiplyScalar(1 / rig.worldPoints.length);
        for (let joint = 0; joint < rig.localPoints.length; joint++) {
          const point = rig.localPoints[joint];
          const matrix = rig.jointTransforms[rig.names[joint]].offsetMatrix;
          matrix[12] = point.x - rig.center.x;
          matrix[13] = point.y - rig.center.y;
          matrix[14] = point.z - rig.center.z;
        }
        rig.input.position.set(rig.center.x, rig.center.y, rig.center.z);
        rig.input.quaternion.set(0, 0, 0, 1);
        rig.input.setPinchValueImmediate(0);
        rig.input.poseId = rig.poseId;
        rig.input.connected = true;
      };

      const advance = async (frames) => {
        for (let index = 0; index < frames; index++) {
          const time = movement.simulatedSeconds += 1 / 60;
          const leftPoint = {
            x: rain.x + Math.sin(time * 1.1) * Math.min(0.045, rain.width * 0.28),
            y: 0.03 + Math.sin(time * 0.83) * 0.006,
          };
          const rightPoint = {
            x: crow.x + Math.sin(time * 0.91 + 0.6) * Math.min(0.075, crow.width * 0.47),
            y: crow.floorY + 0.10 + Math.sin(time * 1.27) * 0.07,
          };
          device.remote.activateCaptureMode();
          device.primaryInputMode = 'hand';
          device.controlMode = 'programmatic';
          inject(rigs[0], leftPoint);
          inject(rigs[1], rightPoint);
          movement.leftMinX = Math.min(movement.leftMinX, leftPoint.x);
          movement.leftMaxX = Math.max(movement.leftMaxX, leftPoint.x);
          movement.rightMinX = Math.min(movement.rightMinX, rightPoint.x);
          movement.rightMaxX = Math.max(movement.rightMaxX, rightPoint.x);
          await window.__capture.step(1 / 60);
        }
      };

      const textureSnapshot = () => {
        const versions = {};
        for (const root of [theater.playView.root, crossing.summons.root]) root.traverse((object) => {
          if (!object.isMesh) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (let index = 0; index < materials.length; index++) {
            const texture = materials[index]?.map;
            if (texture) versions[`${object.uuid}:${index}`] = `${texture.uuid}:${texture.version}`;
          }
        });
        return versions;
      };
      const state = () => {
        const counts = { walking: 0, falling: 0, ash: 0, home: 0, inactive: 0 };
        for (let index = 0; index < folk.count; index++) counts[folk.agents[index].state]++;
        const left = theater.hands[0], right = theater.hands[1];
        return {
          immersive: theater.immersive,
          mode: theater.mode,
          placed: theater.placed,
          screen: crossing.screen,
          levelIndex: screenIndex,
          hazards: level.hazards.map((hazard) => hazard.kind),
          folkCount: folk.count,
          activeFolk: counts.walking + counts.falling,
          folkStates: counts,
          activeSummons: crossing.summons.activeCount(),
          liveJointHands: {
            left: !!left?.valid && !!left.flat?.valid,
            right: !!right?.valid && !!right.flat?.valid,
          },
          movement: {
            simulatedSeconds: rounded(movement.simulatedSeconds),
            leftXRange: [rounded(movement.leftMinX), rounded(movement.leftMaxX)],
            rightXRange: [rounded(movement.rightMinX), rounded(movement.rightMaxX)],
          },
        };
      };
      const resetMovement = () => {
        movement.leftMinX = movement.rightMinX = Infinity;
        movement.leftMaxX = movement.rightMaxX = -Infinity;
      };
      window.__crossingBudget = { advance, textureSnapshot, state, resetMovement };
      return {
        screenIndex,
        hazards: level.hazards.map((hazard) => ({ kind: hazard.kind, slot: hazard.slot, x: hazard.x, width: hazard.width })),
        kindlings: folk.count,
        activeKindlings: state().activeFolk,
        iwerHands: { leftJointCount: device.hands.left.inputSource.hand.size, rightJointCount: device.hands.right.inputSource.hand.size },
        method: 'two moving IWER hand inputs populated with projected 25-joint poses each frame',
      };
    });
  }, { requestedKindlings: kindlingCount, seed: 21_021 });
  if (setup.kindlings !== kindlingCount || setup.activeKindlings !== kindlingCount
    || setup.iwerHands.leftJointCount !== 25 || setup.iwerHands.rightJointCount !== 25) {
    throw new Error(`Crossing budget setup incomplete: ${JSON.stringify(setup)}`);
  }
  result.setup = { placement, ...setup };

  cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  for (let warmed = 0; warmed < warmupFrames; warmed += chunkFrames) {
    await page.evaluate((frames) => window.__crossingBudget.advance(frames), Math.min(chunkFrames, warmupFrames - warmed));
  }
  if (summonBudget) {
    const spawned = await page.evaluate(() => {
      const crossing = window.__theater.crossing;
      const rain = crossing.hazards.layouts.find((hazard) => hazard.kind === 'rain');
      const crow = crossing.hazards.layouts.find((hazard) => hazard.kind === 'crow');
      return {
        elephant: crossing.summons.spawn('elephant', rain.x, -0.18),
        dog: crossing.summons.spawn('dog', crow.x - 0.08, -0.18),
        active: crossing.summons.activeCount(),
      };
    });
    if (!spawned.elephant || !spawned.dog || spawned.active !== 2) {
      throw new Error(`Could not start two-summon budget: ${JSON.stringify(spawned)}`);
    }
    result.setup.summons = spawned;
    await page.evaluate(() => window.__crossingBudget.advance(1));
  }

  await page.evaluate(() => window.__crossingBudget.resetMovement());
  const textureVersionsBefore = await page.evaluate(() => window.__crossingBudget.textureSnapshot());
  await page.evaluate((keys) => {
    const perf = window.__perf;
    for (const key of keys) perf[key].count = 0;
    perf.pendingUploadSubmissions = 0;
    perf.pendingUploadBytes = 0;
  }, sampleKeys);

  const samples = Object.fromEntries(sampleKeys.map((key) => [key, []]));
  const cursors = Object.fromEntries(sampleKeys.map((key) => [key, 0]));
  const textureChanges = new Set();
  const measurementStartedAt = Date.now();
  for (let measured = 0; measured < measuredFrames; measured += chunkFrames) {
    const frames = Math.min(chunkFrames, measuredFrames - measured);
    const batch = await page.evaluate(async ({ frameCount, previousCounts }) => {
      await window.__crossingBudget.advance(frameCount);
      const perf = window.__perf;
      const read = (series, cursor) => {
        const end = series.count;
        const start = Math.max(cursor, end - series.values.length);
        const values = [];
        for (let index = start; index < end; index++) values.push(series.values[index % series.values.length]);
        return { count: end, values };
      };
      const result = {};
      for (const key of Object.keys(previousCounts)) result[key] = read(perf[key], previousCounts[key]);
      result.textureVersions = window.__crossingBudget.textureSnapshot();
      result.state = window.__crossingBudget.state();
      return result;
    }, { frameCount: frames, previousCounts: cursors });
    for (const key of sampleKeys) {
      samples[key].push(...batch[key].values);
      cursors[key] = batch[key].count;
    }
    for (const name of changedTextureNames(textureVersionsBefore, batch.textureVersions)) textureChanges.add(name);
  }
  const measurementWallSeconds = (Date.now() - measurementStartedAt) / 1000;
  const finalState = await page.evaluate(() => ({
    ...window.__crossingBudget.state(),
    textureVersions: window.__crossingBudget.textureSnapshot(),
    pendingUploadSubmissions: window.__perf.pendingUploadSubmissions,
    pendingUploadBytes: window.__perf.pendingUploadBytes,
  }));
  for (const name of changedTextureNames(textureVersionsBefore, finalState.textureVersions)) textureChanges.add(name);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const uploadSubmissionsPerFrame = samples.uploadSubmissions.slice(1).concat(finalState.pendingUploadSubmissions);
  const uploadBytesPerFrame = samples.uploadBytes.slice(1).concat(finalState.pendingUploadBytes);
  const textureUploads = {
    source: 'window.__perf uploadSubmissions/uploadBytes (WebGL texSubImage2D)',
    measuredFrames: uploadSubmissionsPerFrame.length,
    submissionsPerFrame: {
      distribution: histogram(uploadSubmissionsPerFrame),
      summary: summarize(uploadSubmissionsPerFrame),
      framesWithUploads: uploadSubmissionsPerFrame.filter((count) => count > 0).length,
      total: uploadSubmissionsPerFrame.reduce((sum, count) => sum + count, 0),
    },
    bytesPerFrame: {
      distribution: histogram(uploadBytesPerFrame),
      summary: summarize(uploadBytesPerFrame),
      total: uploadBytesPerFrame.reduce((sum, bytes) => sum + bytes, 0),
    },
    playTextures: {
      snapshotAfterWarmup: textureVersionsBefore,
      snapshotAfterSample: finalState.textureVersions,
      texturesChanged: [...textureChanges],
      versionChangesAfterWarmup: textureChanges.size,
      noPerFrameVersionChanges: textureChanges.size === 0,
    },
  };
  const play = summarize(samples.play);
  const hazards = summarize(samples.playHazards);
  const whole = summarize(samples.update);
  const handsMoved = finalState.movement.leftXRange[1] - finalState.movement.leftXRange[0] > 0.02
    && finalState.movement.rightXRange[1] - finalState.movement.rightXRange[0] > 0.02;
  const passed = play.count === measuredFrames && hazards.count === measuredFrames && whole.count === measuredFrames
    && play.p95 <= result.thresholds.playP95Ms && hazards.p95 <= 0.5 && whole.p95 <= 5.5
    && textureUploads.playTextures.noPerFrameVersionChanges
    && finalState.immersive && finalState.placed && finalState.folkCount === kindlingCount
    && finalState.activeFolk === kindlingCount && finalState.liveJointHands.left && finalState.liveJointHands.right
    && (!summonBudget || finalState.activeSummons === 2)
    && handsMoved && result.pageErrors.length === 0;
  result.finalState = finalState;
  result.measurementWallSeconds = round(measurementWallSeconds);
  result.hands = {
    method: 'two moving IWER hand inputs with projected 25-joint poses',
    leftScale: 1.45,
    rightScale: 1,
    movedDuringSample: handsMoved,
    note: 'Joint transforms are updated before every captured XR frame; both live theater hand slots must remain valid.',
  };
  result.metrics = {
    playMs: play,
    hazardsAloneMs: hazards,
    wholeUpdateMs: whole,
    supporting: {
      inkClearMs: summarize(samples.playClear),
      inkHandMs: summarize(samples.playInk),
      folkMs: summarize(samples.playAgents),
      playViewMs: summarize(samples.playView),
    },
  };
  result.textureUploads = textureUploads;
  result.passed = passed;
  if (!passed) result.error = 'One or more crossing budget gates failed';
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  throw error;
} finally {
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputPath, result }, null, 2));
  await browser.close();
}

if (!result.passed) process.exitCode = 1;

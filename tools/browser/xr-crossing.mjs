import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const outputPath = resolve(projectRoot,
  process.env.XR_CROSSING_OUT ?? '../collab/codex/21-evidence/xr-crossing.json');
const TRIALS = 5;
const KINDLINGS = 6;
const DT = 0.05;
const MAX_FRAMES = 1_020;
const MAX_JOINT_ERROR = 0.002;
const MAX_RADIUS_ERROR = 0.002;
const MAX_SCALE_ERROR = 0.04;
const cases = [
  { name: 'prologue-bridge', night: 0, hazard: 'gap', kindlings: 1, hand: 'bridge', scale: 1 },
  { name: 'night1-gap', night: 1, hazard: 'gap', kindlings: KINDLINGS, hand: 'bridge', scale: 1 },
  { name: 'rain-soft', night: 5, hazard: 'rain', kindlings: KINDLINGS, hand: 'umbrella', scale: 1.45 },
];

const result = {
  benchmark: 'codex-21-crossing-real-joint-iwer',
  base,
  browser: 'private Playwright Chromium',
  trialsPerCase: TRIALS,
  thresholds: {
    prologueWickHomeTrials: TRIALS,
    night1GapHomePerTrial: 4,
    night1GapKindlings: KINDLINGS,
    rainShelteredPerTrial: 5,
    rainKindlings: KINDLINGS,
    maxJointErrorMetres: MAX_JOINT_ERROR,
    maxRadiusErrorMetres: MAX_RADIUS_ERROR,
    maxNormalizedScaleError: MAX_SCALE_ERROR,
  },
  placement: [],
  cases: {},
  pageErrors: [],
  passed: false,
};

function makeUrl(testCase, seed) {
  const url = new URL(base);
  url.search = new URLSearchParams({
    capture: 'keepdom',
    crossingOnly: '',
    night: String(testCase.night),
    hazards: testCase.hazard,
    seed: String(seed),
    ...(testCase.night === 0 ? {} : { kindlings: String(testCase.kindlings) }),
  }).toString();
  return url.toString();
}

function watchPageErrors(page, label) {
  page.on('pageerror', (error) => result.pageErrors.push(`${label}: ${error.stack ?? error}`));
  page.on('console', (message) => {
    if (message.type() === 'error') result.pageErrors.push(`${label} console.error: ${message.text()}`);
  });
}

async function prepareIwer(page, testCase, seed) {
  const url = makeUrl(testCase, seed);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater
    && window.__theater.crossing && window.IWER_DEVICE?.sessionOffered, null, { timeout: 60_000 });

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
    for (let frame = 0; frame < 20 && !theater.immersive; frame++) {
      await window.__capture.step(1 / 60);
    }
    if (!theater.immersive) throw new Error('IWER did not enter immersive XR');
    theater.endSession();
    theater.beginSession();

    let earlySpawned = 0;
    for (let frame = 0; frame < 300 && (!theater.placed || theater.settle || theater.fitUntil); frame++) {
      await window.__capture.step(1 / 30);
      if (!theater.placed || theater.settle || theater.fitUntil) {
        earlySpawned = Math.max(earlySpawned, theater.playFolk.count);
      }
    }
    if (!theater.placed || theater.settle || theater.fitUntil) {
      throw new Error(`IWER stage did not settle: ${JSON.stringify({
        mode: theater.mode, placed: theater.placed, fitUntil: theater.fitUntil, settling: !!theater.settle,
      })}`);
    }
    if (earlySpawned) throw new Error(`Kindlings spawned before placement settled: ${earlySpawned}`);
    if (!theater.crossing || !theater.playField || !theater.playFolk || theater.hands?.length !== 2) {
      throw new Error('Crossing runtime, ink field, folk world, or live-hand slots are unavailable');
    }
    return { immersive: theater.immersive, placed: theater.placed, mode: theater.mode, earlySpawned };
  });

  result.placement.push({ case: testCase.name, ...placement });
  await page.waitForFunction(() => {
    const theater = window.__theater;
    return theater?.playField?.sample && theater.playField.clearHand
      && theater?.playFolk?.spawn && Array.isArray(theater.playFolk.agents)
      && theater.crossing?.hazards?.layouts && window.IWER_DEVICE?.hands?.left?.inputSource?.hand;
  }, null, { timeout: 30_000 });

  await page.evaluate(async () => {
    const theater = window.__theater;
    const device = window.IWER_DEVICE;
    const handModel = await import('/src/shadow/hand-model.ts');
    const Vector3 = theater.anchor.constructor;
    const dt = 1 / 30;
    const folkRadius = 0.011;
    const rounded = (value) => Number.isFinite(value) ? Number(value.toFixed(6)) : null;

    const bridgePose = () => handModel.orient(handModel.basePoses.relaxed(), [-25, 0, 0]);
    const umbrellaPose = () => {
      const pose = handModel.basePoses.relaxed();
      handModel.shape(pose, { thumb: -0.12, index: -0.18, middle: -0.18, ring: -0.18, pinky: -0.15 });
      return handModel.orient(pose, [0, 0, -90]);
    };

    const locatePoseState = (input) => Object.getOwnPropertySymbols(input).map((symbol) => input[symbol])
      .find((value) => value?.poses?.default && value?.poses?.pinch);

    const injectPose = (pose, normalizedScale, screenPoint, poseId) => {
      const input = device.hands.left;
      const poseState = locatePoseState(input);
      if (!poseState) throw new Error('IWER left-hand pose registry unavailable');
      const jointNames = Array.from(input.inputSource.hand.keys());
      if (jointNames.length !== handModel.JOINT_COUNT || pose.radii.length !== handModel.JOINT_COUNT) {
        throw new Error(`XRHand layout mismatch: ${jointNames.length} joints`);
      }

      const poseScale = 2.5 * normalizedScale;
      let poseX = 0;
      let poseY = 0;
      for (let joint = 0; joint < handModel.JOINT_COUNT; joint++) {
        const offset = joint * 16 + 12;
        poseX += pose.mats[offset] / handModel.JOINT_COUNT;
        poseY += pose.mats[offset + 1] / handModel.JOINT_COUNT;
      }

      theater.player.updateMatrixWorld(true);
      const inversePlayer = theater.player.matrixWorld.clone().invert();
      const frame = theater.frame;
      const light = theater.lanternPos;
      const lightX = (light.x - frame.ox) * frame.rx + (light.y - frame.oy) * frame.ry
        + (light.z - frame.oz) * frame.rz;
      const lightY = (light.x - frame.ox) * frame.ux + (light.y - frame.oy) * frame.uy
        + (light.z - frame.oz) * frame.uz;
      const lightDepth = (light.x - frame.ox) * frame.nx + (light.y - frame.oy) * frame.ny
        + (light.z - frame.oz) * frame.nz;
      const handDepth = lightDepth * (1 - 1 / poseScale);
      const handX = lightX + (screenPoint.x - lightX) / poseScale;
      const handY = lightY + (screenPoint.y - lightY) / poseScale;
      const worldPoints = [];
      const referencePoints = [];
      const center = new Vector3();

      for (let joint = 0; joint < handModel.JOINT_COUNT; joint++) {
        const offset = joint * 16 + 12;
        const x = pose.mats[offset] - poseX;
        const y = pose.mats[offset + 1] - poseY;
        const world = new Vector3(
          frame.ox + (handX + x) * frame.rx + (handY + y) * frame.ux + handDepth * frame.nx,
          frame.oy + (handX + x) * frame.ry + (handY + y) * frame.uy + handDepth * frame.ny,
          frame.oz + (handX + x) * frame.rz + (handY + y) * frame.uz + handDepth * frame.nz,
        );
        worldPoints.push(world);
        const reference = world.clone().applyMatrix4(inversePlayer);
        referencePoints.push(reference);
        center.add(reference);
      }
      center.multiplyScalar(1 / handModel.JOINT_COUNT);

      const jointTransforms = {};
      for (let joint = 0; joint < handModel.JOINT_COUNT; joint++) {
        const point = referencePoints[joint];
        jointTransforms[jointNames[joint]] = {
          offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
            point.x - center.x, point.y - center.y, point.z - center.z, 1],
          radius: pose.radii[joint],
        };
      }
      poseState.poses[poseId] = { jointTransforms };
      input.position.set(center.x, center.y, center.z);
      input.quaternion.set(0, 0, 0, 1);
      input.setPinchValueImmediate(0);
      input.poseId = poseId;
      input.connected = true;
      device.hands.right.connected = false;
      return { worldPoints, radii: pose.radii };
    };

    const disconnectHands = () => {
      device.hands.left.connected = false;
      device.hands.right.connected = false;
    };

    const trackAgent = (history, agent, layout, field) => {
      history.state = agent.state;
      history.home ||= agent.state === 'home';
      history.ash ||= agent.state === 'ash';
      history.wickHome ||= agent.isWick && agent.state === 'home';

      const footY = agent.y - folkRadius - field.cell * 0.5;
      const supportX = agent.x + agent.heading * folkRadius * 0.45;
      const supportIndex = field.index(supportX, footY);
      history.handSupported ||= agent.state === 'walking' && supportIndex >= 0
        && field.solid[supportIndex] === 1 && field.staticSolid[supportIndex] === 0;

      if (!layout || agent.state === 'ash' || agent.x < layout.x - layout.width * 0.5
        || agent.x > layout.x + layout.width * 0.5) return;
      const firstY = Math.max(agent.y + 0.02, layout.floorY + 0.03);
      for (let y = firstY; y <= 0.082; y += field.cell) {
        if (field.sample(agent.x, y) === 2) {
          history.shelteredBySoftInk = true;
          break;
        }
      }
    };

    const runTrial = async (options) => {
      const field = theater.playField;
      const folk = theater.playFolk;
      const crossing = theater.crossing;
      const pose = options.hand === 'umbrella' ? umbrellaPose() : bridgePose();
      const poseId = `codex-21-${options.name}-${options.repeat}`;
      const histories = Array.from({ length: options.kindlings }, () => ({
        state: 'inactive', home: false, ash: false, wickHome: false,
        handSupported: false, shelteredBySoftInk: false,
      }));
      const originalHandler = crossing.onEvent;
      let finished = null;
      let wickHomeEvent = false;
      crossing.onEvent = (event) => {
        originalHandler?.(event);
        if (event.kind === 'home' && event.agent?.isWick) wickHomeEvent = true;
        if (event.kind === 'finished') {
          finished = {
            ...event,
            night: crossing.night,
            lost: crossing.lost,
            stars: crossing.stars,
            rainStats: JSON.parse(JSON.stringify(crossing.hazards.stats)),
          };
        }
      };

      disconnectHands();
      field.clearHand(0);
      field.clearHand(1);
      theater.crossingSeed = options.seed;
      theater.beginCrossing(options.night);
      const layout = crossing.hazards.layouts.find((hazard) => hazard.kind === options.hazard);
      if (!layout) throw new Error(`${options.name}: ${options.hazard} layout missing`);
      const point = { x: layout.x, y: options.hand === 'umbrella' ? 0.035 : -0.23 };
      const maxFrames = options.night === 0 ? 1_200 : Math.ceil(50 / dt) + 20;
      let maxJointError = 0;
      let maxRadiusError = 0;
      let maxScaleError = 0;
      let validJointFrames = 0;
      let controlModeFlipFrames = 0;
      let frames = 0;
      const startedAt = window.__capture.time;

      try {
        while (!finished && frames < maxFrames) {
          const modeAtFrameStart = device.controlMode;
          device.remote.activateCaptureMode();
          device.controlMode = 'programmatic';
          const expected = injectPose(pose, options.scale, point, poseId);
          await window.__capture.step(dt);
          frames++;

          if (device.controlMode !== 'programmatic') {
            controlModeFlipFrames++;
            device.controlMode = 'programmatic';
            injectPose(pose, options.scale, point, poseId);
            device.notifyStateChange?.();
          }
          if (modeAtFrameStart !== 'programmatic') controlModeFlipFrames++;
          device.controlMode = 'programmatic';

          const live = theater.hands[0];
          if (!live?.valid || !live.flat?.valid) throw new Error(`IWER left hand invalid in ${options.name}`);
          let meanDepth = 0;
          for (let joint = 0; joint < handModel.JOINT_COUNT; joint++) {
            const offset = joint * 3;
            const point3 = expected.worldPoints[joint];
            maxJointError = Math.max(maxJointError,
              Math.abs(live.joints[offset] - point3.x),
              Math.abs(live.joints[offset + 1] - point3.y),
              Math.abs(live.joints[offset + 2] - point3.z));
            maxRadiusError = Math.max(maxRadiusError, Math.abs(live.radii[joint] - expected.radii[joint]));
            meanDepth += (theater.lanternPos.x - live.joints[offset]) * theater.frame.nx
              + (theater.lanternPos.y - live.joints[offset + 1]) * theater.frame.ny
              + (theater.lanternPos.z - live.joints[offset + 2]) * theater.frame.nz;
          }
          const lightToScreen = (theater.lanternPos.x - theater.frame.ox) * theater.frame.nx
            + (theater.lanternPos.y - theater.frame.oy) * theater.frame.ny
            + (theater.lanternPos.z - theater.frame.oz) * theater.frame.nz;
          const actualScale = lightToScreen / (meanDepth / handModel.JOINT_COUNT) / 2.5;
          maxScaleError = Math.max(maxScaleError, Math.abs(actualScale - options.scale));
          validJointFrames++;

          for (let index = 0; index < folk.count; index++) {
            const agent = folk.agents[index];
            trackAgent(histories[index], agent, options.hazard === 'rain' ? layout : null, field);
          }
        }
      } finally {
        crossing.onEvent = originalHandler;
      }

      if (!finished) throw new Error(`${options.name} timed out after ${maxFrames} frames`);
      const metrics = {
        home: finished.home,
        total: finished.total,
        lost: finished.lost,
        stars: finished.stars,
        wickHome: wickHomeEvent,
        handSupported: histories.filter((history) => history.handSupported).length,
        shelteredFolk: histories.filter((history) => history.shelteredBySoftInk).length,
        shelteredHome: histories.filter((history) => history.shelteredBySoftInk && history.home).length,
        ash: histories.filter((history) => history.ash).length,
        rainDropsSpawned: finished.rainStats.rainDropsSpawned,
        rainDropsSheltered: finished.rainStats.rainDropsSheltered,
        rainDropsHit: finished.rainStats.rainDropsHit,
      };
      let passed = false;
      if (options.night === 0) {
        passed = metrics.total === 1 && metrics.home === 1 && metrics.wickHome
          && metrics.handSupported >= 1;
      } else if (options.hazard === 'gap') {
        passed = metrics.total === options.kindlings && metrics.home >= 4 && metrics.handSupported >= 1;
      } else {
        passed = metrics.total === options.kindlings && metrics.shelteredHome >= 5
          && metrics.rainDropsSheltered > 0;
      }
      if (validJointFrames !== frames || maxJointError > 0.002 || maxRadiusError > 0.002
        || maxScaleError > 0.04) passed = false;
      return {
        name: options.name,
        repeat: options.repeat,
        night: options.night,
        hazard: options.hazard,
        seed: options.seed,
        frames,
        simulatedSeconds: Number((window.__capture.time - startedAt).toFixed(3)),
        validJointFrames,
        maxJointError: rounded(maxJointError),
        maxRadiusError: rounded(maxRadiusError),
        maxScaleError: rounded(maxScaleError),
        controlModeFlipFrames,
        layout: { x: rounded(layout.x), width: rounded(layout.width), floorY: rounded(layout.floorY) },
        metrics,
        passed,
      };
    };

    window.__xrCrossing = { runTrial };
  });

  return url;
}

async function runCase(browser, testCase) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  watchPageErrors(page, testCase.name);
  const initialSeed = 21_021 + testCase.night * 101;
  const report = { url: makeUrl(testCase, initialSeed), trials: [], passedTrials: 0, passed: false };
  try {
    report.url = await prepareIwer(page, testCase, initialSeed);
    for (let repeat = 1; repeat <= TRIALS; repeat++) {
      const row = await page.evaluate((options) => window.__xrCrossing.runTrial(options), {
        ...testCase,
        repeat,
        seed: initialSeed + (repeat - 1) * 37,
      });
      report.trials.push(row);
      if (row.passed) report.passedTrials++;
      console.log(JSON.stringify(row));
    }
    report.passed = report.passedTrials === TRIALS;
    return report;
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ args: [
    '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
    '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  try {
    for (const testCase of cases) {
      const report = await runCase(browser, testCase);
      result.cases[testCase.name] = report;
      if (!report.passed) throw new Error(`${testCase.name} passed ${report.passedTrials}/${TRIALS} trials`);
    }
    if (result.pageErrors.length) throw new Error(`Browser errors: ${result.pageErrors.join('\n')}`);
    result.passed = true;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    throw error;
  } finally {
    result.pageErrors = [...result.pageErrors];
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output: outputPath, passed: result.passed, cases: result.cases }, null, 2));
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const targets = ['dog', 'rabbit', 'snail'];
const trialsPerTarget = 5;
const targetStep = 1 / 60;
const demoStep = 1 / 20;
const demoChunkFrames = 200;
const seedBase = 22_300;
const result = {
  benchmark: 'codex-22-summons-real-iwer-and-demo-guard',
  base,
  browser: 'private Playwright Chromium',
  targetTrials: [],
  demoNights: [],
  browserErrors: [],
  browserNavigations: [],
  passed: false,
};

function makeUrl(params) {
  const url = new URL(base);
  url.search = '';
  url.searchParams.set('capture', 'keepdom');
  url.searchParams.set('crossingOnly', '');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

function watchErrors(page, label) {
  let mainFrameNavigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    mainFrameNavigations++;
    if (mainFrameNavigations > 1) result.browserNavigations.push(`${label}: ${frame.url()}`);
  });
  page.on('pageerror', (error) => result.browserErrors.push(`${label}: ${error.stack ?? error}`));
  page.on('console', (message) => {
    if (message.type() === 'error') result.browserErrors.push(`${label} console.error: ${message.text()}`);
  });
}

function isNavigationFailure(error) {
  const message = String(error?.stack ?? error);
  return message.includes('Execution context was destroyed') || message.includes('navigation');
}

async function prepareIwer(page) {
  await page.waitForFunction(() => window.__capture && window.__theater?.crossing
    && window.IWER_DEVICE?.sessionOffered, null, { timeout: 60_000 });

  const placement = await page.evaluate(async () => {
    const theater = window.__theater;
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

    for (let frame = 0; frame < 20 && !theater.immersive; frame++) {
      await window.__capture.step(1 / 60);
    }
    if (!theater.immersive) throw new Error('IWER did not enter an immersive XR session');
    theater.endSession();
    theater.beginSession();

    for (let frame = 0; frame < 300; frame++) {
      await window.__capture.step(1 / 30);
      if (theater.placed && !theater.settle && theater.fitUntil === 0) {
        return { immersive: theater.immersive, placed: theater.placed, mode: theater.mode };
      }
    }
    throw new Error(`IWER stage did not settle: ${JSON.stringify({
      mode: theater.mode, placed: theater.placed, fitUntil: theater.fitUntil, settling: !!theater.settle,
    })}`);
  });

  if (!placement.immersive || !placement.placed) throw new Error(`Invalid IWER placement: ${JSON.stringify(placement)}`);
  await page.waitForFunction(() => window.__theater?.journeyMatcher?.ready === true,
    null, { timeout: 30_000 });
  const state = await page.evaluate(() => ({
    night: window.__theater.crossing.night,
    finished: window.__theater.crossing.finished,
    targetIds: window.__theater.baked.map((target) => target.def.id),
  }));
  if (state.night !== 3 || state.finished) throw new Error(`Summon test did not start on night 3: ${JSON.stringify(state)}`);
  return { ...placement, state };
}

async function installTargetRunner(page) {
  await page.evaluate(() => {
    const device = window.IWER_DEVICE;
    const theater = window.__theater;
    const dt = 1 / 60;
    const maxFrames = 180;

    const locatePoseState = (input) => Object.getOwnPropertySymbols(input).map((symbol) => input[symbol])
      .find((value) => value?.poses?.default && value?.poses?.pinch);

    const injectPose = (targetIndex, poseId) => {
      const target = theater.baked[targetIndex];
      const input = device.hands.left;
      const jointNames = Array.from(input.inputSource.hand.keys());
      if (jointNames.length !== target.pose.radii.length) {
        throw new Error(`IWER joint count ${jointNames.length} differs from ${target.def.id} pose ${target.pose.radii.length}`);
      }
      const poseState = locatePoseState(input);
      if (!poseState) throw new Error('IWER left-hand pose registry unavailable');

      theater.player.updateMatrixWorld(true);
      const toReference = theater.player.matrixWorld.clone().invert();
      const positions = new Float32Array(target.pose.radii.length * 3);
      theater.poseToWorld(target.pose, positions, 0, target.shifts[0]);
      const Vector3 = theater.anchor.constructor;
      const referencePoints = [];
      const center = new Vector3();
      for (let joint = 0; joint < target.pose.radii.length; joint++) {
        const offset = joint * 3;
        const point = new Vector3(positions[offset], positions[offset + 1], positions[offset + 2])
          .applyMatrix4(toReference);
        referencePoints.push(point);
        center.add(point);
      }
      center.multiplyScalar(1 / referencePoints.length);

      const jointTransforms = {};
      for (let joint = 0; joint < jointNames.length; joint++) {
        const point = referencePoints[joint];
        jointTransforms[jointNames[joint]] = {
          offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
            point.x - center.x, point.y - center.y, point.z - center.z, 1],
          radius: target.pose.radii[joint],
        };
      }
      poseState.poses[poseId] = { jointTransforms };
      input.position.set(center.x, center.y, center.z);
      input.quaternion.set(0, 0, 0, 1);
      input.setPinchValueImmediate(0);
      input.poseId = poseId;
      input.connected = true;
      device.hands.right.connected = false;
      return { positions: Array.from(positions), radii: Array.from(target.pose.radii) };
    };

    window.__xrSummonRunner = {
      async run({ targetId, repeat }) {
        const targetIndex = theater.baked.findIndex((entry) => entry.def.id === targetId);
        if (targetIndex < 0) throw new Error(`Unknown summon target ${targetId}`);
        const target = theater.baked[targetIndex];
        if (target.partner) throw new Error(`${targetId} requires a partner hand for this summon test`);

        device.remote.activateCaptureMode();
        device.controlMode = 'programmatic';
        device.primaryInputMode = 'hand';
        device.hands.left.connected = false;
        device.hands.right.connected = false;
        await window.__capture.step(dt);
        theater.beginCrossing(3);
        const fireStart = theater.crossing.summons.fireCount;
        const autoStart = theater.crossing.summons.autoFireCount;
        const startedAt = window.__capture.time;
        const poseId = `codex-22-summon-${targetId}-${repeat}`;
        let maxProgress = 0;
        let chargingFrames = 0;
        let validFrames = 0;
        let maxJointError = 0;
        let maxRadiusError = 0;
        let wrongFormFrames = 0;
        let expected = null;

        for (let frame = 0; frame < maxFrames; frame++) {
          device.remote.activateCaptureMode();
          device.controlMode = 'programmatic';
          expected = injectPose(targetIndex, poseId);
          await window.__capture.step(dt);
          if (device.controlMode !== 'programmatic') {
            device.controlMode = 'programmatic';
            expected = injectPose(targetIndex, poseId);
            device.notifyStateChange?.();
          }
          device.controlMode = 'programmatic';

          const hand = theater.hands[0];
          if (hand.valid && hand.flat.valid) {
            validFrames++;
            for (let joint = 0; joint < expected.radii.length; joint++) {
              const offset = joint * 3;
              maxJointError = Math.max(maxJointError,
                Math.abs(hand.joints[offset] - expected.positions[offset]),
                Math.abs(hand.joints[offset + 1] - expected.positions[offset + 1]),
                Math.abs(hand.joints[offset + 2] - expected.positions[offset + 2]));
              maxRadiusError = Math.max(maxRadiusError, Math.abs(hand.radii[joint] - expected.radii[joint]));
            }
          }

          const trigger = theater.summonTrigger;
          if (trigger.form === targetIndex && trigger.progress > 0) {
            chargingFrames++;
            maxProgress = Math.max(maxProgress, trigger.progress);
          } else if (trigger.progress > 0) {
            wrongFormFrames++;
          }
          if (theater.crossing.summons.fireCount > fireStart) break;
        }

        const sourceSides = theater.renderer.xr.getSession().inputSources
          .filter((source) => source.hand).map((source) => source.handedness);
        const fireDelta = theater.crossing.summons.fireCount - fireStart;
        const autoFireDelta = theater.crossing.summons.autoFireCount - autoStart;
        const holdSeconds = theater.summonTrigger.holdSeconds;
        const row = {
          targetId,
          repeat,
          targetIndex,
          targetPass: target.pass,
          fireDelta,
          autoFireDelta,
          triggerForm: theater.summonTrigger.form,
          peakCharge: +maxProgress.toFixed(3),
          chargedSeconds: +(maxProgress * holdSeconds).toFixed(3),
          holdThresholdSeconds: holdSeconds,
          chargingFrames,
          wrongFormFrames,
          simulatedSeconds: +(window.__capture.time - startedAt).toFixed(3),
          validJointFrames: validFrames,
          maxJointError: +maxJointError.toFixed(6),
          maxRadiusError: +maxRadiusError.toFixed(6),
          sourceSides,
        };
        row.passed = fireDelta === 1 && autoFireDelta === 1 && row.triggerForm === targetIndex
          && maxProgress >= 1 && holdSeconds === 0.8 && chargingFrames >= 5 && wrongFormFrames === 0
          && sourceSides.includes('left') && validFrames >= 5
          && maxJointError <= 0.002 && maxRadiusError <= 0.002;
        return row;
      },
    };
  });
}

async function runTargetTrial(browser, targetId, repeat) {
  const url = makeUrl({ night: 3, summonTarget: targetId, seed: seedBase, hazards: 'crow,ledge,gap' });
  const label = `iwer-${targetId}-${repeat}`;
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  watchErrors(page, label);
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    if (!response?.ok()) throw new Error(`App URL returned HTTP ${response?.status() ?? 'no response'}: ${url}`);
    const placement = await prepareIwer(page);
    await installTargetRunner(page);
    const row = await page.evaluate((options) => window.__xrSummonRunner.run(options), { targetId, repeat });
    return { ...row, placement, url };
  } finally {
    await context.close();
  }
}

async function runTargetTrials(browser, targetId) {
  const trials = [];
  for (let repeat = 1; repeat <= trialsPerTarget; repeat++) {
    const navigationRetries = [];
    let row = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        row = await runTargetTrial(browser, targetId, repeat);
        row.attempts = attempt;
        row.navigationRetries = navigationRetries;
        break;
      } catch (error) {
        const message = String(error?.stack ?? error);
        if (!isNavigationFailure(error) || attempt === 3) {
          row = { targetId, repeat, attempts: attempt, navigationRetries,
            passed: false, error: message };
          break;
        }
        navigationRetries.push(message);
        console.warn(`IWER summon ${targetId}: retrying trial ${repeat} after page navigation (${attempt}/3)`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    trials.push(row);
    console.log(`IWER summon ${targetId}: ${repeat}/${trialsPerTarget} ${row.passed ? 'PASS' : 'FAIL'} ${JSON.stringify(row)}`);
  }
  return { targetId, url: makeUrl({ night: 3, summonTarget: targetId, seed: seedBase, hazards: 'crow,ledge,gap' }), trials,
    passedTrials: trials.filter((row) => row.passed).length,
    passed: trials.length === trialsPerTarget && trials.every((row) => row.passed) };
}

async function runDemoNight(browser, night) {
  const seed = seedBase + night * 97;
  const url = makeUrl({ night, seed });
  const label = `demo-night-${night}`;
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  watchErrors(page, label);
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    if (!response?.ok()) throw new Error(`App URL returned HTTP ${response?.status() ?? 'no response'}: ${url}`);
    await page.waitForFunction(() => window.__capture && window.__theater?.crossing?.levels?.length,
      null, { timeout: 60_000 });
    const setup = await page.evaluate(({ night, seed }) => {
      const theater = window.__theater;
      const crossing = theater.crossing;
      if (window.__capture.state().phase !== 'crossing') {
        throw new Error(`Demo did not enter crossing phase: ${window.__capture.state().phase}`);
      }
      crossing.start(night, seed);
      theater.summonTrigger.reset();
      theater.crossingDemoScreen = -1;
      theater.summonDemoScreen = -1;
      return {
        night: crossing.night,
        screens: crossing.levels.map((level) => ({
          hazards: level.hazards.map((hazard) => hazard.kind), kindlings: level.kindlings,
        })),
        screenCount: crossing.levels.length,
        started: !crossing.finished,
        immersive: theater.immersive,
        autoFireCount: crossing.summons.autoFireCount,
      };
    }, { night, seed });
    if (setup.night !== night || !setup.started || setup.immersive) {
      throw new Error(`Demo did not start in a flat puppet session: ${JSON.stringify(setup)}`);
    }

    const maxFrames = Math.ceil((setup.screenCount * 52 + 5) / demoStep);
    let frames = 0;
    let puppetFrames = 0;
    let state = null;
    while (frames < maxFrames) {
      const chunk = Math.min(demoChunkFrames, maxFrames - frames);
      state = await page.evaluate(async ({ count, dt }) => {
        const theater = window.__theater;
        const crossing = theater.crossing;
        let observedPuppetFrames = 0;
        let stepped = 0;
        for (; stepped < count && !crossing.finished; stepped++) {
          await window.__capture.step(dt);
          if (theater.demoHand.valid || theater.demoHand2.valid) observedPuppetFrames++;
        }
        return {
          stepped,
          finished: crossing.finished,
          night: crossing.night,
          screen: crossing.screen,
          screens: crossing.levels.length,
          home: crossing.home,
          total: crossing.total,
          lost: crossing.lost,
          fireCount: crossing.summons.fireCount,
          autoFireCount: crossing.summons.autoFireCount,
          puppetFrames: observedPuppetFrames,
          captureTime: window.__capture.time,
        };
      }, { count: chunk, dt: demoStep });
      frames += state.stepped;
      puppetFrames += state.puppetFrames;
      if (state.finished) break;
      console.log(`Demo night ${night}: screen ${state.screen + 1}/${state.screens}, ${frames}/${maxFrames} frames`);
      if (state.stepped === 0) throw new Error(`Demo night ${night} stopped advancing: ${JSON.stringify(state)}`);
    }

    const row = {
      night,
      seed,
      url,
      screens: setup.screenCount,
      frames,
      simulatedSeconds: +(frames * demoStep).toFixed(2),
      puppetFrames,
      home: state?.home ?? 0,
      total: state?.total ?? 0,
      lost: state?.lost ?? 0,
      totalSummons: state?.fireCount ?? 0,
      explicitDemoSummons: (state?.fireCount ?? 0) - (state?.autoFireCount ?? 0),
      autoFireCount: state?.autoFireCount ?? null,
      finished: !!state?.finished,
    };
    row.passed = row.finished && row.puppetFrames > 0 && row.autoFireCount === 0;
    console.log(`Demo night ${night}: ${row.passed ? 'PASS' : 'FAIL'} ${JSON.stringify(row)}`);
    return row;
  } finally {
    await context.close();
  }
}

let browser;
try {
  browser = await chromium.launch({ args: [
    '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
    '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  for (const targetId of targets) {
    try {
      result.targetTrials.push(await runTargetTrials(browser, targetId));
    } catch (error) {
      result.targetTrials.push({ targetId, passed: false, error: String(error?.stack ?? error) });
      console.error(`IWER summon ${targetId}: setup failed ${String(error?.stack ?? error)}`);
    }
  }
  for (let night = 1; night <= 8; night++) {
    const navigationRetries = [];
    let row = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        row = await runDemoNight(browser, night);
        row.attempts = attempt;
        row.navigationRetries = navigationRetries;
        break;
      } catch (error) {
        const message = String(error?.stack ?? error);
        if (!isNavigationFailure(error) || attempt === 3) {
          row = { night, attempts: attempt, navigationRetries, passed: false, error: message };
          break;
        }
        navigationRetries.push(message);
        console.warn(`Demo night ${night}: retrying after page navigation (${attempt}/3)`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    result.demoNights.push(row);
    if (!row.passed) console.error(`Demo night ${night}: failed ${row.error}`);
  }
} catch (error) {
  result.error = String(error?.stack ?? error);
} finally {
  await browser?.close();
}

result.passed = result.targetTrials.length === targets.length
  && result.targetTrials.every((entry) => entry.passed)
  && result.demoNights.length === 8
  && result.demoNights.every((entry) => entry.passed)
  && result.browserErrors.length === 0
  && !result.error;
console.log(JSON.stringify(result, null, 2));
if (process.env.XR_SUMMON_OUT) writeFileSync(process.env.XR_SUMMON_OUT, `${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;

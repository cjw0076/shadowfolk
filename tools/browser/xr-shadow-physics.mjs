import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/?playSandbox&capture=keepdom';
const outputPath = resolve(projectRoot, process.env.XR_SHADOW_OUT ?? '../collab/codex/20-evidence/xr-shadow-physics.json');
const trialRepeats = Math.max(5, Number.parseInt(process.env.XR_SHADOW_TRIALS ?? '5', 10) || 5);
const requestedCaseFilters = (process.env.XR_SHADOW_CASES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const folkCount = 5;
const cases = [
  { label: 'bridge-flat', scenario: 'bridge', pose: 'flat', scale: 1, expected: 'crossed' },
  { label: 'bridge-no-hand', scenario: 'bridge', pose: null, scale: null, expected: 'fell' },
  { label: 'catch-cupped', scenario: 'catch', pose: 'cupped', scale: 1, expected: 'caught' },
  { label: 'soft-crisp', scenario: 'soft', pose: 'flat', scale: 1, expected: 'crossed' },
  { label: 'soft-near-flame', scenario: 'soft', pose: 'flat', scale: 1.45, expected: 'safe-sink' },
];
const recognizedCaseFilters = new Set(cases.flatMap(({ label, scenario }) => [label, scenario]));
const unknownCaseFilters = requestedCaseFilters.filter((value) => !recognizedCaseFilters.has(value));
if (unknownCaseFilters.length) throw new Error(`Unknown XR_SHADOW_CASES value(s): ${unknownCaseFilters.join(', ')}`);
const selectedCases = requestedCaseFilters.length
  ? cases.filter(({ label, scenario }) => requestedCaseFilters.includes(label) || requestedCaseFilters.includes(scenario))
  : cases;
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const result = {
  benchmark: 'codex-20-real-joint-iwer-shadow-physics',
  url: null,
  caseFilter: requestedCaseFilters,
  casesSelected: selectedCases.map(({ label }) => label),
  trialsRequestedPerCase: trialRepeats,
  folkPerTrial: folkCount,
  placement: null,
  trials: [],
  criteria: null,
  pageErrors,
  passed: false,
};

try {
  const url = new URL(base);
  if (!url.searchParams.has('playSandbox')) url.searchParams.append('playSandbox', '');
  if (url.searchParams.get('capture') !== 'keepdom') url.searchParams.set('capture', 'keepdom');
  result.url = url.toString();
  await page.goto(result.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater && window.IWER_DEVICE?.sessionOffered,
    null, { timeout: 60000 });

  result.placement = await page.evaluate(async () => {
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
      throw new Error(`IWER sandbox stage did not settle: ${JSON.stringify({
        mode: theater.mode, placed: theater.placed, fitUntil: theater.fitUntil, settling: !!theater.settle,
      })}`);
    }
    if (earlySpawned) throw new Error(`Kindlings spawned before XR placement settled: ${earlySpawned}`);
    return { immersive: theater.immersive, placed: theater.placed, mode: theater.mode, earlySpawned };
  });

  await page.waitForFunction(() => {
    const theater = window.__theater;
    return theater?.playField?.clearStatic && theater.playField.setStaticRect && theater.playField.sample
      && theater?.playFolk?.reset && theater.playFolk.configure && theater.playFolk.spawn
      && Array.isArray(theater.playFolk.agents) && Number.isFinite(theater.playFolk.count)
      && theater.hands?.length === 2;
  }, null, { timeout: 30000 });

  await page.evaluate(async () => {
    const theater = window.__theater;
    const device = window.IWER_DEVICE;
    const field = theater.playField;
    const folk = theater.playFolk;
    const handModel = await import('/src/shadow/hand-model.ts');
    const Vector3 = theater.anchor.constructor;
    const cell = field.cell;
    const dt = 1 / 30;
    const folkRadius = 0.011;
    const groundY = -0.185;
    const gap = { left: -0.06, right: 0.06 };
    const trialDuration = { bridge: 20, catch: 8, soft: 16 };
    const centerByScenario = {
      bridge: { x: 0, y: -0.23 },
      catch: { x: 0, y: -0.23 },
      soft: { x: 0, y: -0.23 },
    };
    const rounded = (value) => Number.isFinite(value) ? Number(value.toFixed(6)) : null;
    const vectorSnapshot = (value) => value ? [rounded(value.x), rounded(value.y), rounded(value.z)] : null;
    const stageSnapshot = (poseId) => {
      theater.player.updateMatrixWorld(true);
      const input = device.hands.left;
      const poseState = Object.getOwnPropertySymbols(input).map((symbol) => input[symbol])
        .find((value) => value?.poses?.default && value?.poses?.pinch);
      const registeredPose = poseState?.poses?.[poseId];
      const carry = theater.carry;
      return {
        frame: Object.fromEntries(Object.entries(theater.frame).map(([key, value]) => [key, rounded(value)])),
        lanternPos: vectorSnapshot(theater.lanternPos),
        mode: theater.mode ?? null,
        anchored: !!theater.anchored,
        anchorReady: !!theater.rigAnchor?.ready,
        carry: carry ? (carry === theater.hands[0] ? 'left' : carry === theater.hands[1] ? 'right' : 'other') : null,
        playerMatrix: Array.from(theater.player.matrixWorld.elements, rounded),
        device: {
          position: vectorSnapshot(device.position),
          quaternion: device.quaternion ? [rounded(device.quaternion.x), rounded(device.quaternion.y),
            rounded(device.quaternion.z), rounded(device.quaternion.w)] : null,
          controlMode: device.controlMode ?? null,
          primaryInputMode: device.primaryInputMode ?? null,
          hand: {
            connected: input.connected,
            poseId: input.poseId,
            position: vectorSnapshot(input.position),
            quaternion: input.quaternion ? [rounded(input.quaternion.x), rounded(input.quaternion.y),
              rounded(input.quaternion.z), rounded(input.quaternion.w)] : null,
            pinchValue: rounded(input.pinchValue),
            registeredPose: !!registeredPose,
            registeredWristOffset: registeredPose?.jointTransforms?.wrist?.offsetMatrix
              ? Array.from(registeredPose.jointTransforms.wrist.offsetMatrix.slice(12, 15), rounded) : null,
          },
        },
      };
    };
    const poseFor = (poseName) => {
      if (poseName === 'flat') return handModel.orient(handModel.basePoses.relaxed(), [-25, 0, 0]);
      const pose = handModel.basePoses.relaxed();
      handModel.shape(pose, { thumb: 0.28, index: 0.38, middle: 0.42, ring: 0.4, pinky: 0.34 });
      return handModel.orient(pose, [0, 0, 0]);
    };

    const setTerrain = (scenario) => {
      field.clearStatic();
      if (scenario === 'bridge' || scenario === 'soft') {
        field.setStaticRect(-0.5, -0.212, gap.left, -0.196);
        field.setStaticRect(gap.right, -0.212, 0.5, -0.196);
      }
      if (scenario === 'soft') field.setStaticRect(-0.12, -0.372, 0.12, -0.356);
    };

    const disconnectHands = () => {
      device.hands.left.connected = false;
      device.hands.right.connected = false;
    };

    const injectPose = (pose, normalizedScale, screenPoint, poseId) => {
      if (!pose) {
        disconnectHands();
        return null;
      }
      const input = device.hands.left;
      const poseState = Object.getOwnPropertySymbols(input).map((symbol) => input[symbol])
        .find((value) => value?.poses?.default && value?.poses?.pinch);
      if (!poseState) throw new Error('IWER left-hand pose registry unavailable');
      const jointNames = Array.from(input.inputSource.hand.keys());
      if (jointNames.length !== handModel.JOINT_COUNT || pose.radii.length !== handModel.JOINT_COUNT) {
        throw new Error(`XRHand layout mismatch: ${jointNames.length} joints`);
      }
      const poseScale = 2.5 * normalizedScale;
      let poseX = 0, poseY = 0;
      for (let joint = 0; joint < handModel.JOINT_COUNT; joint++) {
        const offset = joint * 16 + 12;
        poseX += pose.mats[offset] / handModel.JOINT_COUNT;
        poseY += pose.mats[offset + 1] / handModel.JOINT_COUNT;
      }

      theater.player.updateMatrixWorld(true);
      const inversePlayer = theater.player.matrixWorld.clone().invert();
      const frame = theater.frame;
      const light = theater.lanternPos;
      const lightX = (light.x - frame.ox) * frame.rx + (light.y - frame.oy) * frame.ry + (light.z - frame.oz) * frame.rz;
      const lightY = (light.x - frame.ox) * frame.ux + (light.y - frame.oy) * frame.uy + (light.z - frame.oz) * frame.uz;
      const lightDepth = (light.x - frame.ox) * frame.nx + (light.y - frame.oy) * frame.ny + (light.z - frame.oz) * frame.nz;
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

    const observeFolk = (history, index) => {
      const agent = folk.agents[index];
      history.state = agent.state;
      history.x = agent.x;
      history.y = agent.y;
      history.minY = Math.min(history.minY, agent.y);
      history.crossed ||= agent.x >= gap.right;
      history.fell ||= agent.y < groundY - 0.025 || agent.state === 'ash';
      history.sank ||= agent.y < groundY - 0.025;
      const footY = agent.y - folkRadius - cell * 0.5;
      const supportX = agent.x + agent.heading * folkRadius * 0.45;
      const support = field.sample(supportX, footY);
      const indexAtFoot = field.index(supportX, footY);
      const dynamicSupport = agent.state === 'walking' && support === 1 && indexAtFoot >= 0
        && field.solid[indexAtFoot] === 1 && field.staticSolid[indexAtFoot] === 0;
      const staticSupport = agent.state === 'walking' && support === 1 && indexAtFoot >= 0
        && field.staticSolid[indexAtFoot] === 1;
      history.handSupportFrames += dynamicSupport ? 1 : 0;
      history.caught ||= dynamicSupport;
      history.safeLanding ||= staticSupport && agent.y < -0.25;
    };

    const completed = (expected, histories) => {
      if (expected === 'crossed') return histories.every((history) => history.crossed || history.state === 'ash');
      if (expected === 'fell') return histories.every((history) => history.fell);
      if (expected === 'caught') return histories.every((history) => history.caught || history.state === 'ash');
      return histories.every((history) => history.safeLanding || history.state === 'ash');
    };

    const runTrial = async (options) => {
      setTerrain(options.scenario);
      folk.reset();
      const spawn = options.scenario === 'catch'
        ? { x: -0.025, y: 0.08, heading: 1 }
        : { x: -0.44, y: -0.185, heading: 1 };
      folk.configure({
        waveCount: 0,
        spawnX: spawn.x,
        spawnY: spawn.y,
        doorX: 0.58,
        doorY: 0.35,
        doorW: 0.01,
        doorH: 0.01,
      });
      const pose = options.pose ? poseFor(options.pose) : null;
      const screenPoint = centerByScenario[options.scenario];
      const histories = Array.from({ length: options.count }, () => ({
        state: 'inactive', x: spawn.x, y: spawn.y, minY: spawn.y,
        crossed: false, fell: false, sank: false, caught: false, safeLanding: false, handSupportFrames: 0,
      }));
      let emitted = 0;
      const emitDue = (time) => {
        while (emitted < options.count && time + 1e-6 >= emitted * 0.6) {
          const agent = folk.spawn(spawn.x, spawn.y, spawn.heading);
          if (!agent) throw new Error(`FolkWorld.spawn failed at ${emitted}/${options.count}`);
          emitted++;
        }
      };
      let maxJointError = 0;
      let maxRadiusError = 0;
      let maxScaleError = 0;
      let validJointFrames = 0;
      let frameCount = 0;
      let controlModeFlipFrames = 0;
      let firstErrorFrame = null;
      const startedAt = window.__capture.time;
      const stepLimit = Math.ceil(trialDuration[options.scenario] / dt);
      for (let frame = 0; frame < stepLimit; frame++) {
        const simTime = frame * dt;
        emitDue(simTime);
        const controlModeAtFrameStart = device.controlMode;
        device.remote.activateCaptureMode();
        device.controlMode = 'programmatic';
        const controlModeBeforeStep = device.controlMode;
        const poseId = `codex-20-${options.label}-trial-${options.repeatIndex ?? 0}`;
        const expected = injectPose(pose, options.scale, screenPoint, poseId);
        const stageBefore = expected ? stageSnapshot(poseId) : null;
        const captureTimeBefore = window.__capture.time;
        await window.__capture.step(dt);
        frameCount++;
        const controlModeAfterStep = device.controlMode;
        const controlModeFlippedDuringStep = controlModeAfterStep !== 'programmatic';
        const stageAfterStep = pose ? stageSnapshot(poseId) : null;
        if (controlModeAtFrameStart !== 'programmatic' || controlModeFlippedDuringStep) controlModeFlipFrames++;
        let stageAfterCorrection = null;
        if (controlModeFlippedDuringStep) {
          device.controlMode = 'programmatic';
          if (pose) injectPose(pose, options.scale, screenPoint, poseId);
          else disconnectHands();
          device.notifyStateChange?.();
        }
        device.controlMode = 'programmatic';
        const controlModeAfterGuard = device.controlMode;
        if (controlModeFlippedDuringStep && pose) stageAfterCorrection = stageSnapshot(poseId);
        if (pose) {
          const live = theater.hands[0];
          if (!live?.valid || !live.flat?.valid) throw new Error(`IWER left hand not live during ${options.label}`);
          let meanDepth = 0;
          let frameMaxJointError = 0;
          let frameWorstJoint = -1;
          let frameWorstDelta = null;
          let frameMaxRadiusError = 0;
          const actualLiveWorld = [];
          for (let joint = 0; joint < handModel.JOINT_COUNT; joint++) {
            const offset = joint * 3;
            const point = expected.worldPoints[joint];
            const actual = [live.joints[offset], live.joints[offset + 1], live.joints[offset + 2]];
            const delta = [actual[0] - point.x, actual[1] - point.y, actual[2] - point.z];
            const jointError = Math.max(Math.abs(delta[0]), Math.abs(delta[1]), Math.abs(delta[2]));
            actualLiveWorld.push(actual.map(rounded));
            if (jointError > frameMaxJointError) {
              frameMaxJointError = jointError;
              frameWorstJoint = joint;
              frameWorstDelta = delta.map(rounded);
            }
            frameMaxRadiusError = Math.max(frameMaxRadiusError, Math.abs(live.radii[joint] - expected.radii[joint]));
            meanDepth += (theater.lanternPos.x - live.joints[offset]) * theater.frame.nx
              + (theater.lanternPos.y - live.joints[offset + 1]) * theater.frame.ny
              + (theater.lanternPos.z - live.joints[offset + 2]) * theater.frame.nz;
          }
          const lightToScreen = (theater.lanternPos.x - theater.frame.ox) * theater.frame.nx
            + (theater.lanternPos.y - theater.frame.oy) * theater.frame.ny
            + (theater.lanternPos.z - theater.frame.oz) * theater.frame.nz;
          const actualNormalizedScale = lightToScreen / (meanDepth / handModel.JOINT_COUNT) / 2.5;
          const frameScaleError = Math.abs(actualNormalizedScale - options.scale);
          maxJointError = Math.max(maxJointError, frameMaxJointError);
          maxRadiusError = Math.max(maxRadiusError, frameMaxRadiusError);
          maxScaleError = Math.max(maxScaleError, frameScaleError);
          if (!firstErrorFrame && (frameMaxJointError > 0.002 || frameMaxRadiusError > 0.002 || frameScaleError > 0.04)) {
            firstErrorFrame = {
              frame: frameCount - 1,
              captureTime: { before: rounded(captureTimeBefore), after: rounded(window.__capture.time) },
              errors: {
                maxJointError: rounded(frameMaxJointError),
                worstJoint: frameWorstJoint,
                worstJointDelta: frameWorstDelta,
                maxRadiusError: rounded(frameMaxRadiusError),
                expectedNormalizedScale: options.scale,
                actualNormalizedScale: rounded(actualNormalizedScale),
                normalizedScaleError: rounded(frameScaleError),
                controlMode: {
                  atFrameStart: controlModeAtFrameStart,
                  beforeStep: controlModeBeforeStep,
                  afterStep: controlModeAfterStep,
                  afterGuard: controlModeAfterGuard,
                  flippedAtFrameStart: controlModeAtFrameStart !== 'programmatic',
                  flippedDuringStep: controlModeFlippedDuringStep,
                  poseReappliedAfterFlip: controlModeFlippedDuringStep && !!pose,
                },
              },
              expectedWorld: expected.worldPoints.map(vectorSnapshot),
              actualLiveWorld,
              theaterBefore: stageBefore,
              theaterAfter: stageAfterStep,
              theaterAfterCorrection: stageAfterCorrection,
            };
          }
          validJointFrames++;
        } else if (theater.hands.some((hand) => hand.valid)) {
          throw new Error(`IWER hands remained live during no-hand control ${options.label}`);
        }
        for (let index = 0; index < folk.count; index++) observeFolk(histories[index], index);
        if (emitted === options.count && completed(options.expected, histories)) break;
      }
      const agents = Array.from({ length: folk.count }, (_, index) => {
        const agent = folk.agents[index];
        const history = histories[index];
        return {
          id: index,
          state: agent.state,
          x: +agent.x.toFixed(4),
          y: +agent.y.toFixed(4),
          crossedGap: history.crossed,
          fellThrough: history.fell,
          handSupported: history.handSupportFrames > 0,
          caught: history.caught,
          sankBelowGround: history.sank,
          landedSafely: history.safeLanding,
        };
      });
      const metrics = {
        spawned: folk.count,
        crossed: agents.filter((agent) => agent.crossedGap).length,
        fell: agents.filter((agent) => agent.fellThrough).length,
        handSupported: agents.filter((agent) => agent.handSupported).length,
        caught: agents.filter((agent) => agent.caught).length,
        sankBelowGround: agents.filter((agent) => agent.sankBelowGround).length,
        landedSafely: agents.filter((agent) => agent.landedSafely).length,
        ash: folk.ashCount,
        home: folk.homeCount,
      };
      let passed = false;
      if (options.expected === 'crossed') passed = metrics.crossed === options.count && metrics.handSupported === options.count;
      else if (options.expected === 'fell') passed = metrics.fell === options.count && metrics.crossed === 0;
      else if (options.expected === 'caught') passed = metrics.caught >= 4;
      else passed = metrics.landedSafely === options.count && metrics.ash === 0;
      const requestedJointFrames = pose ? frameCount : 0;
      if (pose && (validJointFrames !== requestedJointFrames || maxJointError > 0.002
        || maxRadiusError > 0.002 || maxScaleError > 0.04)) passed = false;
      const timedOut = frameCount >= stepLimit && !completed(options.expected, histories);
      if (timedOut || metrics.spawned !== options.count) passed = false;
      return {
        label: options.label,
        scenario: options.scenario,
        pose: options.pose,
        normalizedScale: options.scale,
        projectionMagnification: options.scale === null ? null : +(2.5 * options.scale).toFixed(3),
        projectedCenter: screenPoint,
        staticGap: gap,
        frames: frameCount,
        simulatedSeconds: +(window.__capture.time - startedAt).toFixed(3),
        timedOut,
        validJointFrames,
        maxJointError: +maxJointError.toFixed(6),
        maxRadiusError: +maxRadiusError.toFixed(6),
        maxScaleError: +maxScaleError.toFixed(5),
        controlModeFlipFrames,
        firstErrorFrame,
        metrics,
        agents,
        passed,
      };
    };

    window.__xrShadowPhysics = { runTrial };
  });

  for (const testCase of selectedCases) {
    for (let repeat = 0; repeat < trialRepeats; repeat++) {
      const row = await page.evaluate((options) => window.__xrShadowPhysics.runTrial(options), {
        ...testCase,
        count: folkCount,
        repeatIndex: repeat + 1,
      });
      result.trials.push(row);
      console.log(JSON.stringify(row));
    }
  }

  result.criteria = Object.fromEntries(selectedCases.map((testCase) => {
    const rows = result.trials.filter((row) => row.label === testCase.label);
    return [testCase.label, {
      trials: rows.length,
      minimumTrials: 5,
      passedTrials: rows.filter((row) => row.passed).length,
      requiredPassedTrials: trialRepeats,
      passed: rows.length >= 5 && rows.length === trialRepeats && rows.every((row) => row.passed),
    }];
  }));
  result.passed = Object.values(result.criteria).every((criterion) => criterion.passed) && pageErrors.length === 0;
  if (!result.passed) throw new Error(`Real-joint shadow physics bench failed: ${JSON.stringify(result.criteria)}`);
} catch (error) {
  result.error = String(error?.stack ?? error);
  result.passed = false;
  throw error;
} finally {
  result.pageErrors = [...pageErrors];
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputPath, passed: result.passed, criteria: result.criteria }, null, 2));
  await browser.close();
}

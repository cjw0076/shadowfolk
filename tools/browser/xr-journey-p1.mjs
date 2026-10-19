import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = resolve(projectRoot, process.env.XR_JOURNEY_OUT ?? '../collab/codex/17-evidence/xr-journey-p1.json');
const eventNames = ['bark', 'peck', 'snip', 'hop', 'fan', 'fly', 'giant', 'tiny'];
const negativeKinds = ['relaxed', 'held-creature', 'slow-drift', 'two-hand-idle'];
const formRepeats = Math.max(1, Number.parseInt(process.env.XR_FORM_REPEATS ?? '3', 10) || 3);

const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  const navigationEvents = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navigationEvents.push(frame.url());
      if (navigationEvents.length > 1) console.warn(`Browser main-frame navigation: ${frame.url()}`);
    }
  });
  page.on('crash', () => console.error('Browser renderer crashed'));

  const url = new URL(base);
  url.search = '?capture=keepdom&journeyDebug&day=20378&first=dog,heron,crab,rabbit,peacock,butterfly';
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
    const theater = window.__theater;
    for (let index = 0; index < 20 && !theater.immersive; index++) await window.__capture.step(1 / 60);
    if (!theater.immersive) throw new Error('IWER did not enter immersive XR');
    theater.endSession();
    theater.beginSession();
    for (let index = 0; index < 300; index++) {
      await window.__capture.step(1 / 30);
      if (theater.placed && !theater.settle && theater.fitUntil === 0) {
        return { mode: theater.mode, placed: theater.placed, immersive: theater.immersive };
      }
    }
    throw new Error(`XR stage did not settle: ${JSON.stringify({ mode: theater.mode, placed: theater.placed, fitUntil: theater.fitUntil, settling: !!theater.settle })}`);
  });

  await page.evaluate(async () => {
    const theater = window.__theater;
    const eventNames = ['bark', 'peck', 'snip', 'hop', 'fan', 'fly', 'giant', 'tiny'];
    const sequenceModule = await import(`/tools/journey-p1-sequences.ts?journeyP1=${Date.now()}`);
    if (typeof sequenceModule.generateJourneyP1Sequence !== 'function') {
      throw new Error('Shared journey-p1-sequences.ts does not export generateJourneyP1Sequence');
    }
    if (!theater.journeyForms || !theater.journeyGestures || !theater.journeyMatcher) {
      throw new Error('journeyDebug did not expose the production form and gesture trackers');
    }
    const Vector3 = theater.anchor.constructor;
    const expectedJoints = [new Float32Array(75), new Float32Array(75)];
    const expectedRadii = [new Float32Array(25), new Float32Array(25)];

    const mapCanonicalPoint = (x, y, z, out) => {
      const frame = theater.frame;
      const light = theater.lanternPos;
      out.set(
        light.x + x * frame.rx + y * frame.ux + z * frame.nx,
        light.y + x * frame.ry + y * frame.uy + z * frame.ny,
        light.z + x * frame.rz + y * frame.uz + z * frame.nz,
      );
      return out;
    };

    const injectHand = (handIndex, source, inversePlayer) => {
      const side = handIndex === 0 ? 'left' : 'right';
      const inputHand = window.IWER_DEVICE.hands[side];
      const liveExpected = expectedJoints[handIndex];
      if (!source?.valid) {
        inputHand.connected = false;
        return false;
      }
      const jointNames = Array.from(inputHand.inputSource.hand.keys());
      if (jointNames.length !== 25 || source.joints.length !== 75) {
        throw new Error(`Unexpected XRHand joint layout for ${side}: ${jointNames.length} names, ${source.joints.length} values`);
      }
      const referencePoints = [];
      const worldPoint = new Vector3();
      const centre = new Vector3();
      for (let joint = 0; joint < 25; joint++) {
        const offset = joint * 3;
        mapCanonicalPoint(source.joints[offset], source.joints[offset + 1], source.joints[offset + 2], worldPoint);
        liveExpected[offset] = worldPoint.x;
        liveExpected[offset + 1] = worldPoint.y;
        liveExpected[offset + 2] = worldPoint.z;
        referencePoints.push(worldPoint.clone().applyMatrix4(inversePlayer));
        centre.add(referencePoints[joint]);
        expectedRadii[handIndex][joint] = source.radii[joint];
      }
      centre.multiplyScalar(1 / 25);
      const poseState = Object.getOwnPropertySymbols(inputHand).map((symbol) => inputHand[symbol])
        .find((value) => value?.poses?.default && value?.poses?.pinch);
      if (!poseState) throw new Error(`IWER pose registry unavailable for ${side}`);
      const jointTransforms = {};
      for (let joint = 0; joint < 25; joint++) {
        const point = referencePoints[joint];
        const localX = point.x - centre.x;
        jointTransforms[jointNames[joint]] = {
          offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
            side === 'right' ? -localX : localX, point.y - centre.y, point.z - centre.z, 1],
          radius: source.radii[joint],
        };
      }
      const poseId = `codex-17-real-joints-${side}`;
      poseState.poses[poseId] = { jointTransforms };
      inputHand.position.set(centre.x, centre.y, centre.z);
      inputHand.quaternion.set(0, 0, 0, 1);
      inputHand.setPinchValueImmediate(0);
      inputHand.poseId = poseId;
      inputHand.connected = true;
      return true;
    };

    const candidateList = (targetIndex, seed) => {
      let state = (seed >>> 0) || 1;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const picks = [];
      while (picks.length < 3) {
        const candidate = Math.floor(random() * theater.baked.length);
        if (candidate !== targetIndex && !picks.includes(candidate)) picks.push(candidate);
      }
      return [targetIndex, ...picks];
    };

    window.__xrJourneySetup = { matcher: theater.journeyMatcher };
    window.__xrJourneyRunner = {
      targetIds: theater.baked.map((target) => target.def.id),
      async run(options) {
        const sequence = sequenceModule.generateJourneyP1Sequence(options);
        const candidates = candidateList(sequence.targetIndex, options.seed * 7919 + 17);
        theater.order = candidates.slice();
        theater.step = 0;
        const device = window.IWER_DEVICE;
        device.remote.activateCaptureMode();
        device.controlMode = 'programmatic';
        device.primaryInputMode = 'hand';
        theater.journeyForms.reset();
        theater.journeyGestures.reset();
        theater.journeyMatcher.scoreCandidates([], theater.journeyHands);
        const observed = Object.fromEntries(eventNames.map((name) => [name, false]));
        const eventTimes = Object.fromEntries(eventNames.map((name) => [name, null]));
        let activeFrames = 0;
        let heldFrames = 0;
        let maxJointError = 0;
        let maxRadiusError = 0;
        let validJointFrames = 0;
        let finalForm = -1;
        let finalScore = 0;
        let finalStable = false;
        let scaleMin = Infinity;
        let scaleMax = -Infinity;
        const trace = options.trace ? [] : null;

        for (const sample of sequence.samples) {
          theater.step = 0;
          theater.player.updateMatrixWorld(true);
          const inversePlayer = theater.player.matrixWorld.clone().invert();
          const sourceHands = sample.hands;
          const leftConnected = injectHand(0, sourceHands[0], inversePlayer);
          const rightConnected = injectHand(1, sourceHands[1], inversePlayer);
          await window.__capture.step(sample.dt);
          const liveHands = theater.hands;
          const journeyHands = theater.journeyHands;
          if (journeyHands[0] !== liveHands[0] || journeyHands[1] !== liveHands[1]) {
            throw new Error('journeyDebug switched away from the actual IWER hands');
          }
          const gestureState = theater.journeyGestureState;
          const formState = theater.journeyFormState;
          if (!gestureState || !formState) throw new Error('journeyDebug states were not updated by the theater frame');
          if (trace) trace.push({ time: sample.time, handMask: theater.journeyGestures.handMask,
            valid: theater.hands.map((hand) => hand.valid), jaw: gestureState.jaw, beak: gestureState.beak,
            spread: gestureState.spread, velocity: gestureState.verticalVelocity,
            barkHigh: theater.journeyGestures.barkCycle.high,
            barkLow: theater.journeyGestures.barkCycle.low,
            barkClosed: theater.journeyGestures.barkCycle.closed,
            barkCycles: theater.journeyGestures.barkCycle.cycles,
            fanHigh: theater.journeyGestures.fanCycle.high,
            fanLow: theater.journeyGestures.fanCycle.low,
            fanClosed: theater.journeyGestures.fanCycle.closed,
            fanCycles: theater.journeyGestures.fanCycle.cycles,
            fanRemaining: theater.journeyGestures.fanCycle.remaining,
            beakArmed: [...theater.journeyGestures.beakArmed],
            beakTime: [...theater.journeyGestures.beakTime],
            snaps: [...theater.journeyGestures.snaps],
            events: Object.fromEntries(eventNames.map((name) => [name, gestureState[name]])) });
          if (theater.journeyCandidates[0] !== sequence.targetIndex) {
            throw new Error(`journeyDebug candidate target drifted: ${theater.journeyCandidates[0]} != ${sequence.targetIndex}`);
          }
          const expectedConnected = [leftConnected, rightConnected];
          for (let handIndex = 0; handIndex < 2; handIndex++) {
            if (!expectedConnected[handIndex]) continue;
            const live = liveHands[handIndex];
            if (!live.valid || !live.flat.valid) throw new Error(`IWER did not deliver a valid ${handIndex ? 'right' : 'left'} XRHand`);
            for (let joint = 0; joint < 25; joint++) {
              const offset = joint * 3;
              for (let axis = 0; axis < 3; axis++) {
                maxJointError = Math.max(maxJointError, Math.abs(live.joints[offset + axis] - expectedJoints[handIndex][offset + axis]));
              }
              maxRadiusError = Math.max(maxRadiusError, Math.abs(live.radii[joint] - expectedRadii[handIndex][joint]));
            }
            validJointFrames++;
          }
          finalForm = formState.form;
          finalScore = formState.score;
          finalStable = formState.stable;
          scaleMin = Math.min(scaleMin, gestureState.scale);
          scaleMax = Math.max(scaleMax, gestureState.scale);
          for (const name of eventNames) {
            if (gestureState[name] && !observed[name]) {
              observed[name] = true;
              eventTimes[name] = sample.time;
            }
          }
          if (sample.time + 1e-6 >= sequence.gestureStart) {
            activeFrames++;
            if (formState.form === sequence.targetIndex && formState.stable) heldFrames++;
          }
          if (theater.demoHand.valid || theater.demoHand2.valid) throw new Error('Scripted puppet active during real-joint sequence');
        }

        const event = options.gesture;
        return {
          gesture: event,
          scenario: options.scenario,
          negativeKind: sequence.negativeKind ?? null,
          seed: sequence.seed,
          rateHz: sequence.rateHz,
          targetId: sequence.targetId,
          targetIndex: sequence.targetIndex,
          candidates: theater.journeyCandidates.map((index) => theater.baked[index].def.id),
          duration: sequence.duration,
          gestureStart: sequence.gestureStart,
          frames: sequence.samples.length,
          detected: observed[event],
          events: observed,
          eventTimes,
          form: finalForm,
          score: +finalScore.toFixed(4),
          stable: finalStable,
          formHoldRate: activeFrames ? heldFrames / activeFrames : null,
          formActiveFrames: activeFrames,
          formHeldFrames: heldFrames,
          scaleRange: [+scaleMin.toFixed(3), +scaleMax.toFixed(3)],
          maxJointError: +maxJointError.toFixed(6),
          maxRadiusError: +maxRadiusError.toFixed(6),
          validJointFrames,
          ...(trace ? { trace } : {}),
        };
      },
    };
  });

  await page.waitForFunction(() => window.__xrJourneySetup?.matcher?.ready === true, null, { timeout: 30000 });
  const targetIds = await page.evaluate(() => window.__xrJourneyRunner.targetIds);
  if (process.env.XR_JOURNEY_DIAG) {
    const gesture = process.env.XR_JOURNEY_DIAG;
    const row = await page.evaluate((options) => window.__xrJourneyRunner.run(options),
      { gesture, scenario: 'true', seed: Number(process.env.XR_JOURNEY_SEED ?? 17000 + eventNames.indexOf(gesture) * 101), trace: true });
    console.log(JSON.stringify(row));
  } else {
  const allRows = [];
  const positiveRows = [];
  let completed = 0;
  const total = eventNames.length * 10 + negativeKinds.length * 10 + targetIds.length * formRepeats;
  const runCase = async (options) => {
    const row = await page.evaluate((input) => window.__xrJourneyRunner.run(input), options);
    allRows.push(row);
    completed++;
    if (completed % 10 === 0 || completed === total) console.log(`IWER journey sequences: ${completed}/${total}`);
    return row;
  };

  for (let eventIndex = 0; eventIndex < eventNames.length; eventIndex++) {
    const gesture = eventNames[eventIndex];
    for (let repeat = 0; repeat < 10; repeat++) {
      const row = await runCase({ gesture, scenario: 'true', seed: 17000 + eventIndex * 101 + repeat });
      positiveRows.push(row);
    }
  }

  const negativeRows = [];
  for (let kindIndex = 0; kindIndex < negativeKinds.length; kindIndex++) {
    const negativeKind = negativeKinds[kindIndex];
    for (let repeat = 0; repeat < 10; repeat++) {
      const gesture = eventNames[(kindIndex * 3 + repeat) % eventNames.length];
      negativeRows.push(await runCase({
        gesture, scenario: 'negative', negativeKind, seed: 27000 + kindIndex * 101 + repeat,
      }));
    }
  }

  const confusionRows = [];
  for (let targetIndex = 0; targetIndex < targetIds.length; targetIndex++) {
    for (let repeat = 0; repeat < formRepeats; repeat++) {
      confusionRows.push(await runCase({
        gesture: 'hop', scenario: 'held', targetId: targetIds[targetIndex],
        seed: 37000 + targetIndex * 101 + repeat,
      }));
    }
  }

  const gestureSummary = eventNames.map((gesture) => {
    const rows = positiveRows.filter((row) => row.gesture === gesture);
    const detected = rows.filter((row) => row.detected).length;
    const holdSamples = rows.filter((row) => row.formHoldRate !== null);
    const formHoldRate = holdSamples.length
      ? holdSamples.reduce((sum, row) => sum + row.formHoldRate, 0) / holdSamples.length : 0;
    return { gesture, detected, total: rows.length, trueDetectionRate: detected / rows.length,
      formHoldRate, ratesHz: rows.map((row) => row.rateHz) };
  });
  const negativeSummary = negativeKinds.map((kind) => {
    const rows = negativeRows.filter((row) => row.negativeKind === kind);
    const falseRows = rows.filter((row) => eventNames.some((name) => row.events[name]));
    const events = Object.fromEntries(eventNames.map((name) => [name, rows.filter((row) => row.events[name]).length]));
    return { kind, falseTriggers: falseRows.length, total: rows.length,
      falseTriggerRate: rows.length ? falseRows.length / rows.length : 0, events };
  });
  const formLabels = [...targetIds, 'unclassified'];
  const confusionMatrix = targetIds.map(() => Array(formLabels.length).fill(0));
  let confusionCorrect = 0;
  for (const row of confusionRows) {
    const expectedIndex = row.targetIndex;
    const predictedColumn = row.form >= 0 ? row.form : targetIds.length;
    confusionMatrix[expectedIndex][predictedColumn]++;
    if (row.form === expectedIndex && row.stable) confusionCorrect++;
  }
  const confusionTotal = confusionRows.length;
  const confusionAccuracy = confusionTotal ? confusionCorrect / confusionTotal : 0;
  const maxJointError = Math.max(...allRows.map((row) => row.maxJointError));
  const maxRadiusError = Math.max(...allRows.map((row) => row.maxRadiusError));
  const falseTriggers = negativeRows.filter((row) => eventNames.some((name) => row.events[name])).length;
  const formHoldRate = gestureSummary.reduce((sum, row) => sum + row.formHoldRate, 0) / gestureSummary.length;
  const failures = [];
  for (const row of gestureSummary) {
    if (row.trueDetectionRate < 0.95) failures.push(`${row.gesture} detection ${row.detected}/${row.total}`);
    if (row.formHoldRate < 0.95) failures.push(`${row.gesture} form hold ${(row.formHoldRate * 100).toFixed(1)}%`);
  }
  if (falseTriggers / negativeRows.length > 0.02) failures.push(`negative false triggers ${falseTriggers}/${negativeRows.length}`);
  if (confusionAccuracy < 0.97) failures.push(`form confusion top-1 ${(confusionAccuracy * 100).toFixed(1)}%`);
  if (maxJointError > 0.002 || maxRadiusError > 0.002) failures.push(`IWER joint fidelity ${maxJointError}m / radius ${maxRadiusError}m`);
  if (pageErrors.length) failures.push(`browser page errors: ${pageErrors.length}`);

  const result = {
    base,
    browser: { engine: 'Playwright Chromium', version: browser.version(), isolatedContext: true },
    placement,
    sequenceSource: 'tools/journey-p1-sequences.ts',
    injection: 'IWER XRHand pose registry -> WebXR frame.getJointPose -> TheaterSystem.readHands',
    sequences: { total: allRows.length, positive: positiveRows.length, negative: negativeRows.length,
      heldPose: confusionRows.length, eventMinimum: Math.min(...gestureSummary.map((row) => row.total)) },
    gestures: gestureSummary,
    negatives: { falseTriggers, total: negativeRows.length, falseTriggerRate: falseTriggers / negativeRows.length, byKind: negativeSummary },
    form: {
      gestureHoldRate: formHoldRate,
      confusionLabels: formLabels,
      confusionMatrix,
      confusionTotal,
      top1Correct: confusionCorrect,
      top1Accuracy: confusionAccuracy,
      repeatsPerCreature: formRepeats,
    },
    cases: { positive: positiveRows, negatives: negativeRows, heldPose: confusionRows },
    jointFidelity: { maxPositionErrorMetres: maxJointError, maxRadiusErrorMetres: maxRadiusError },
    failures,
    pageErrors,
  };
  result.evidencePath = outputPath;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
  }
  await context.close();
} finally {
  await browser.close();
}

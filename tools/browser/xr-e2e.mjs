import { mkdirSync } from 'node:fs';

const EVIDENCE = '../collab/codex/07-evidence';
const STEP = 1 / 20;
const MAX_STEPS = 120;

export default async function run({ page, frame }) {
  const target = frame ?? page;
  const initialized = await target.evaluate(() => !!window.__xrE2E);

  if (!initialized) {
    await target.evaluate(() => {
      localStorage.removeItem('shadow-theater.v1');
      localStorage.removeItem('shadowfolk.rig-anchor.v1');
    });
    const url = new URL(target.url());
    url.search = '?capture=keepdom&day=20378&classic';
    await target.goto(url.toString(), { waitUntil: 'load' });
    await target.waitForFunction(() => window.__theater && window.__capture && window.IWER_DEVICE, null, { timeout: 30000 });
    await target.waitForFunction(() => window.IWER_DEVICE.sessionOffered, null, { timeout: 30000 });
    await target.evaluate(async () => {
      const device = window.IWER_DEVICE;
      device.position.set(-0.9, 1.25, -1.19);
      const halfPitch = -8 * Math.PI / 360;
      const halfYaw = Math.PI / 4;
      const sinePitch = Math.sin(halfPitch), cosinePitch = Math.cos(halfPitch);
      const sineYaw = Math.sin(halfYaw), cosineYaw = Math.cos(halfYaw);
      device.quaternion.set(sinePitch * cosineYaw, cosinePitch * sineYaw,
        -sinePitch * sineYaw, cosinePitch * cosineYaw);
      device.primaryInputMode = 'hand';
      device.hands.left.connected = false;
      device.hands.right.connected = false;
      if (!device.remote.executeGetSessionStatus().sessionActive) await device.remote.dispatch('accept_session', {});
    });
    const placement = await target.evaluate(async () => {
      for (let index = 0; index < 20 && !window.__theater.immersive; index++) await window.__capture.step(1 / 20);
      if (!window.__theater.immersive) throw new Error('IWER did not enter immersive XR');
      window.__theater.endSession();
      window.__theater.beginSession();
      for (let index = 0; index < 220; index++) {
        await window.__capture.step(1 / 20);
        const theater = window.__theater;
        if (theater.immersive && theater.mode === 'table' && theater.placed && !theater.settle && theater.fitUntil === 0) {
          const order = theater.order.map((targetIndex) => theater.baked[targetIndex].def.id);
          window.__xrE2E = { stage: 'negative', order, rows: [], expected: {} };
          const head = theater.camera.getWorldPosition(new theater.anchor.constructor());
          return { mode: theater.mode, order, time: window.__capture.time, immersive: theater.immersive,
            head: [head.x, head.y, head.z] };
        }
      }
      const theater = window.__theater;
      throw new Error(`Table placement failed: ${JSON.stringify({ mode: theater.mode, placed: theater.placed, fitUntil: theater.fitUntil, settling: !!theater.settle, time: window.__capture.time })}`);
    });
    return { stage: 'setup', placement, next: 'Run the same command for the negative case.' };
  }

  const stage = await target.evaluate(() => window.__xrE2E.stage);
  if (stage === 'complete') return await target.evaluate(() => ({ done: true, table: [window.__xrE2E.negative, ...window.__xrE2E.rows] }));

  const prepared = await target.evaluate((negative) => {
    const theater = window.__theater;
    const device = window.IWER_DEVICE;
    const state = window.__xrE2E;
    device.remote.activateCaptureMode();
    device.controlMode = 'programmatic';
    const targetIndex = theater.order[theater.step];
    const baked = theater.baked[targetIndex];
    if (theater.phase !== 0) throw new Error(`Expected Seek, found phase ${theater.phase}`);
    const hands = negative
      ? [{ side: 'left', pose: theater.demoFrom, shift: [0, 0, 0] }]
      : baked.partner
        ? [{ side: 'left', pose: baked.pose, shift: baked.shifts[0] }, { side: 'right', pose: baked.partner, shift: baked.shifts[1] }]
        : [{ side: theater.step % 2 ? 'right' : 'left', pose: theater.step % 2 ? theater.mirrored[targetIndex] : baked.pose, shift: baked.shifts[0] }];
    device.primaryInputMode = 'hand';
    device.hands.left.connected = false;
    device.hands.right.connected = false;
    theater.player.updateMatrixWorld(true);
    const toReference = theater.player.matrixWorld.clone().invert();
    const Vector3 = theater.anchor.constructor;
    state.expected = {};
    for (const { side, pose, shift } of hands) {
      const positions = new Float32Array(pose.radii.length * 3);
      theater.poseToWorld(pose, positions, 0, shift);
      const angle = negative ? 0 : ((theater.step + (side === 'right' ? 1 : 0)) % 2 ? -5 : 5) * Math.PI / 180;
      const sine = Math.sin(angle), cosine = Math.cos(angle);
      const translation = negative ? [0, 0, 0] : [(theater.step % 3 - 1) * 0.005, 0.004, (theater.step % 2 ? -1 : 1) * 0.006];
      const reference = [];
      for (let joint = 0; joint < pose.radii.length; joint++) {
        const offset = joint * 3;
        const x = positions[offset] - theater.anchor.x;
        const z = positions[offset + 2] - theater.anchor.z;
        const world = new Vector3(
          theater.anchor.x + x * cosine - z * sine + translation[0],
          positions[offset + 1] + translation[1],
          theater.anchor.z + x * sine + z * cosine + translation[2],
        );
        positions[offset] = world.x;
        positions[offset + 1] = world.y;
        positions[offset + 2] = world.z;
        world.applyMatrix4(toReference);
        reference.push(world);
      }
      const centre = new Vector3();
      for (const point of reference) centre.add(point);
      centre.multiplyScalar(1 / reference.length);
      const hand = device.hands[side];
      const poseState = Object.getOwnPropertySymbols(hand).map((symbol) => hand[symbol])
        .find((value) => value?.poses?.default && value?.poses?.pinch);
      if (!poseState) throw new Error(`IWER hand pose registry unavailable for ${side}`);
      const jointTransforms = {};
      const jointNames = Array.from(hand.inputSource.hand.keys());
      for (let joint = 0; joint < pose.radii.length; joint++) {
        const point = reference[joint];
        const localX = point.x - centre.x;
        const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
          side === 'right' ? -localX : localX, point.y - centre.y, point.z - centre.z, 1];
        jointTransforms[jointNames[joint]] = { offsetMatrix: matrix, radius: pose.radii[joint] };
      }
      const poseId = `shadowfolk-e2e-${side}`;
      poseState.poses[poseId] = { jointTransforms };
      hand.position.set(centre.x, centre.y, centre.z);
      hand.quaternion.set(0, 0, 0, 1);
      hand.setPinchValueImmediate(0);
      hand.poseId = poseId;
      hand.connected = true;
      state.expected[side] = Array.from(positions);
    }
    return { id: baked.def.id, step: theater.step, pass: baked.pass, sides: hands.map((hand) => hand.side), noise: negative ? null : { translationMaxMetres: 0.006, rotationDegrees: 5 } };
  }, stage === 'negative');

  const outcome = await target.evaluate(async ({ negative, maxSteps, dt }) => {
    const theater = window.__theater;
    const state = window.__xrE2E;
    const started = window.__capture.time;
    let peakScore = 0;
    let maxJointError = 0;
    let validFrames = 0;
    for (let index = 0; index < maxSteps; index++) {
      await window.__capture.step(dt);
      peakScore = Math.max(peakScore, theater.score);
      let allValid = true;
      for (const [side, expected] of Object.entries(state.expected)) {
        const hand = theater.hands[side === 'left' ? 0 : 1];
        allValid &&= hand.valid;
        if (hand.valid && index > 1) {
          for (let joint = 0; joint < expected.length; joint++) maxJointError = Math.max(maxJointError, Math.abs(hand.joints[joint] - expected[joint]));
        }
      }
      if (allValid) validFrames++;
      if (theater.demoHand.valid || theater.demoHand2.valid) throw new Error('Scripted demo hand active during XR test');
      if (theater.phase === 1) {
        return { woke: true, seconds: +(window.__capture.time - started).toFixed(2), peakScore: +peakScore.toFixed(3), maxJointError: +maxJointError.toFixed(5), validFrames };
      }
    }
    return { woke: false, seconds: +(window.__capture.time - started).toFixed(2), peakScore: +peakScore.toFixed(3), maxJointError: +maxJointError.toFixed(5), validFrames };
  }, { negative: stage === 'negative', maxSteps: MAX_STEPS, dt: STEP });

  mkdirSync(EVIDENCE, { recursive: true });
  const screenshot = `${EVIDENCE}/${stage === 'negative' ? 'negative' : `wake-${prepared.id}`}.png`;
  await page.screenshot({ path: screenshot });

  const result = await target.evaluate(async ({ prepared, outcome, negative, dt }) => {
    const theater = window.__theater;
    const state = window.__xrE2E;
    const row = { target: prepared.id, sides: prepared.sides.join('+'), pass: prepared.pass,
      timeToWake: outcome.woke ? outcome.seconds : null, peakScore: outcome.peakScore,
      woke: outcome.woke, validFrames: outcome.validFrames, maxJointError: outcome.maxJointError };
    if (outcome.validFrames < 5 || outcome.maxJointError > 0.002) throw new Error(`XR joints did not reach readHands: ${JSON.stringify(row)}`);
    if (negative) {
      if (outcome.woke) throw new Error(`Negative hand woke ${prepared.id}: ${JSON.stringify(row)}`);
      state.negative = row;
      state.stage = 'targets';
    } else {
      if (!outcome.woke || outcome.seconds > 6) throw new Error(`Target failed to wake: ${JSON.stringify(row)}`);
      state.rows.push(row);
      deviceCleanup();
      if (state.rows.length < state.order.length) {
        for (let index = 0; index < 110; index++) {
          await window.__capture.step(dt);
          if (theater.phase === 0 && theater.step === state.rows.length) break;
        }
        if (theater.phase !== 0 || theater.step !== state.rows.length) throw new Error(`Next target not ready: phase ${theater.phase}, step ${theater.step}`);
      } else state.stage = 'complete';
    }
    return { stage: negative ? 'negative' : 'target', row, done: state.stage === 'complete', table: [state.negative, ...state.rows], next: state.stage };

    function deviceCleanup() {
      window.IWER_DEVICE.hands.left.connected = false;
      window.IWER_DEVICE.hands.right.connected = false;
    }
  }, { prepared, outcome, negative: stage === 'negative', dt: STEP });
  return { ...result, screenshot };
}

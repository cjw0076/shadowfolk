import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const output = resolve(process.env.XR_JOURNEY_OUT ?? '../collab/codex/18-evidence');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const url = new URL(base);
  url.search = '?capture=keepdom&journeyOnly&obstacles=crow,gap,fog,boulder&day=20378';
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater?.journey && window.IWER_DEVICE?.sessionOffered,
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
    const theater = window.__theater;
    for (let frame = 0; frame < 20 && !theater.immersive; frame++) await window.__capture.step(1 / 60);
    if (!theater.immersive) throw new Error('IWER did not enter XR');
    theater.endSession(); theater.beginSession();
    for (let frame = 0; frame < 300 && (!theater.placed || theater.settle || theater.fitUntil); frame++) {
      await window.__capture.step(1 / 30);
    }
    if (!theater.placed || theater.settle || theater.fitUntil) throw new Error('IWER stage did not settle');
    const sequences = await import(`/tools/journey-p1-sequences.ts?journeyP2=${Date.now()}`);
    const Vector3 = theater.anchor.constructor;
    let maxJointError = 0;
    let validJointFrames = 0;
    const solves = [];
    const inputs = device.hands;
    const inject = (side, source, inversePlayer, offsetX, offsetY) => {
      const input = inputs[side];
      if (!source?.valid) { input.connected = false; return null; }
      const names = Array.from(input.inputSource.hand.keys());
      if (names.length !== 25 || source.joints.length !== 75) throw new Error('XRHand layout mismatch');
      const poseState = Object.getOwnPropertySymbols(input).map((symbol) => input[symbol])
        .find((value) => value?.poses?.default && value?.poses?.pinch);
      if (!poseState) throw new Error('IWER pose registry unavailable');
      const points = [];
      const centre = new Vector3();
      const frame = theater.frame, light = theater.lanternPos;
      for (let joint = 0; joint < 25; joint++) {
        const offset = joint * 3, x = source.joints[offset] + offsetX, y = source.joints[offset + 1] + offsetY;
        const z = source.joints[offset + 2];
        const world = new Vector3(light.x + x * frame.rx + y * frame.ux + z * frame.nx,
          light.y + x * frame.ry + y * frame.uy + z * frame.ny,
          light.z + x * frame.rz + y * frame.uz + z * frame.nz);
        points.push({ local: world.clone().applyMatrix4(inversePlayer), world });
        centre.add(points.at(-1).local);
      }
      centre.multiplyScalar(1 / 25);
      const jointTransforms = {};
      for (let joint = 0; joint < 25; joint++) {
        const point = points[joint].local;
        jointTransforms[names[joint]] = {
          offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
            side === 'right' ? centre.x - point.x : point.x - centre.x,
            point.y - centre.y, point.z - centre.z, 1],
          radius: source.radii[joint],
        };
      }
      const poseId = `codex-18-${side}`;
      poseState.poses[poseId] = { jointTransforms };
      input.position.set(centre.x, centre.y, centre.z);
      input.quaternion.set(0, 0, 0, 1);
      input.setPinchValueImmediate(0);
      input.poseId = poseId;
      input.connected = true;
      return points;
    };
    const play = async (gesture, scenario, targetId, fromX, toX, seed) => {
      const sequence = sequences.generateJourneyP1Sequence({ gesture, scenario, targetId, seed });
      const firstHand = sequence.samples[0].hands.find((hand) => hand.valid);
      let baselineY = 0, baselineZ = 0;
      for (let joint = 0; joint < 25; joint++) {
        baselineY += firstHand.flat.y[joint] / 25;
        baselineZ += firstHand.joints[joint * 3 + 2] / 25;
      }
      const baselineRatio = Math.max(0.8, 0.75 / Math.max(0.1, -baselineZ));
      const offsetY = (-0.11 - baselineY) / baselineRatio;
      device.remote.activateCaptureMode();
      device.controlMode = 'programmatic';
      device.primaryInputMode = 'hand';
      let observed = false;
      let stableFrames = 0;
      let minSpread = Infinity, maxSpread = -Infinity;
      for (const sample of sequence.samples) {
        theater.player.updateMatrixWorld(true);
        const inversePlayer = theater.player.matrixWorld.clone().invert();
        const source = sample.hands.find((hand) => hand.valid);
        const flat = source?.flat;
        let flatX = 0, flatY = 0, meanZ = 0;
        if (source && flat?.valid) {
          for (let joint = 0; joint < 25; joint++) {
            flatX += flat.x[joint] / 25;
            flatY += flat.y[joint] / 25;
            meanZ += source.joints[joint * 3 + 2] / 25;
          }
        }
        const ratio = Math.max(0.8, 0.75 / Math.max(0.1, -meanZ));
        const fraction = sequence.duration ? sample.time / sequence.duration : 1;
        const desiredX = fromX + (toX - fromX) * fraction;
        const offsetX = (desiredX - flatX) / ratio;
        const expected = [inject('left', sample.hands[0], inversePlayer, offsetX, offsetY),
          inject('right', sample.hands[1], inversePlayer, offsetX, offsetY)];
        await window.__capture.step(sample.dt);
        if (theater.journeyFormState?.stable && theater.journeyInput.formId === targetId) stableFrames++;
        if (theater.journeyGestureState?.[gesture]) observed = true;
        minSpread = Math.min(minSpread, theater.journeyGestureState?.spread ?? Infinity);
        maxSpread = Math.max(maxSpread, theater.journeyGestureState?.spread ?? -Infinity);
        if (theater.journey.event?.kind === 'solve') solves.push({ kind: theater.journey.event.obstacle,
          form: theater.journeyInput.formId, wait: +theater.journey.wait.toFixed(2) });
        for (let side = 0; side < 2; side++) {
          if (!expected[side]) continue;
          const live = theater.hands[side];
          if (!live.valid || !live.flat.valid) throw new Error(`IWER ${side} hand invalid`);
          for (let joint = 0; joint < 25; joint++) {
            const point = expected[side][joint].world;
            maxJointError = Math.max(maxJointError,
              Math.abs(live.joints[joint * 3] - point.x),
              Math.abs(live.joints[joint * 3 + 1] - point.y),
              Math.abs(live.joints[joint * 3 + 2] - point.z));
          }
          validJointFrames++;
        }
      }
      return { scenario, gesture, targetId, frames: sequence.samples.length, stableFrames, observed,
        index: theater.journey.index, states: [...theater.journey.states], carried: theater.journey.carried,
        sparkX: +theater.journey.spark.x.toFixed(3), form: { ...theater.journeyFormState },
        candidates: [...theater.journeyCandidates], spread: [minSpread, maxSpread],
        fan: { high: theater.journeyGestures.fanCycle.high, low: theater.journeyGestures.fanCycle.low,
          closed: theater.journeyGestures.fanCycle.closed, cycles: theater.journeyGestures.fanCycle.cycles } };
    };
    window.__xrP2 = { play, summary: () => ({ solves, maxJointError, validJointFrames,
      index: theater.journey.index, completed: theater.journey.completed,
      states: [...theater.journey.states], errors: [...theater.reported] }) };
  });

  await page.waitForFunction(() => window.__theater?.journeyMatcher?.ready, null, { timeout: 30000 });
  const steps = [];
  const screenshotBuffers = [];
  const play = async (...args) => {
    const row = await page.evaluate((parameters) => window.__xrP2.play(...parameters), args);
    steps.push(row);
    console.log(JSON.stringify(row));
    return row;
  };
  const frame = async (label) => {
    const buffer = await page.screenshot({ type: 'png' });
    screenshotBuffers.push(buffer);
    writeFileSync(resolve(output, `${String(screenshotBuffers.length).padStart(2, '0')}-${label}.png`), buffer);
  };
  await play('bark', 'held', 'dog', -0.42, -0.42, 18501);
  await frame('pickup');
  const kinds = [
    { kind: 'crow', gesture: 'bark', form: 'dog' },
    { kind: 'gap', gesture: 'hop', form: 'rabbit' },
    { kind: 'fog', gesture: 'fan', form: 'peacock' },
    { kind: 'boulder', gesture: 'giant', form: 'dog' },
  ];
  for (let index = 0; index < kinds.length; index++) {
    const row = kinds[index];
    const zone = await page.evaluate((slot) => window.__theater.journey.plan.obstacles[slot].x, index);
    const previous = index === 0 ? -0.42 : await page.evaluate(() => window.__theater.journey.spark.x);
    await play(row.gesture, 'held', row.form, previous, zone - 0.045, 18510 + index);
    await play(row.gesture, 'held', row.form, zone - 0.045, zone - 0.045, 18520 + index);
    const repeats = row.kind === 'fog' ? 3 : 2;
    for (let repeat = 0; repeat < repeats; repeat++) {
      if (await page.evaluate((slot) => window.__theater.journey.states[slot] !== 'blocked', index)) break;
      await play(row.gesture, 'true', row.form, zone - 0.045, zone - 0.045, 18530 + index * 10 + repeat);
    }
    await frame(row.kind);
    if (!await page.evaluate((slot) => window.__theater.journey.states[slot] !== 'blocked', index)) {
      throw new Error(`Real-joint ${row.kind} failed to solve`);
    }
    await play(row.gesture, 'held', row.form, zone - 0.045, zone + 0.09, 18570 + index);
  }
  await play('bark', 'held', 'dog', 0.24, 0.50, 18599);
  await frame('moon');
  const summary = await page.evaluate(() => window.__xrP2.summary());
  summary.steps = steps;
  summary.pageErrors = errors;
  writeFileSync(resolve(output, 'xr-journey-p2.json'), JSON.stringify(summary, null, 2));
  if (!summary.completed || summary.states.some((state) => state !== 'passed') || summary.solves.length !== 4
    || summary.maxJointError > 0.001 || summary.pageErrors.length || summary.errors.length) {
    throw new Error(`Real-joint journey failed: ${JSON.stringify(summary)}`);
  }
  const thumbnails = await Promise.all(screenshotBuffers.map((buffer) => sharp(buffer)
    .extract({ left: 550, top: 240, width: 520, height: 350 }).resize(720, 485).toBuffer()));
  await sharp({ create: { width: 2160, height: 970, channels: 4, background: '#110c0c' } })
    .composite(thumbnails.map((input, index) => ({ input, left: (index % 3) * 720, top: Math.floor(index / 3) * 485 })))
    .png().toFile(resolve(output, 'xr-journey-strip.png'));
  console.log(`PASS: real IWER joints, ${summary.solves.map((solve) => solve.kind).join('→')}, moon arrival, max error ${summary.maxJointError}`);
} finally { await browser.close(); }

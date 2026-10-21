import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const url = new URL(base);
url.search = 'capture=keepdom&crossingOnly&night=6&hazards=thorns&seed=21021&kindlings=6';
const errors = [];
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  page.on('pageerror', (error) => errors.push(String(error.stack ?? error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture?.step && window.IWER_DEVICE?.sessionOffered && window.__theater?.crossing);
  const result = await page.evaluate(async () => {
    const theater = window.__theater;
    const device = window.IWER_DEVICE;
    device.position.set(-0.9, 1.25, -1.19);
    const pitch = -8 * Math.PI / 180, yaw = Math.PI / 2;
    device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2),
      Math.cos(pitch / 2) * Math.sin(yaw / 2), -Math.sin(pitch / 2) * Math.sin(yaw / 2),
      Math.cos(pitch / 2) * Math.cos(yaw / 2));
    device.remote.activateCaptureMode();
    device.controlMode = 'programmatic';
    device.primaryInputMode = 'hand';
    device.hands.left.connected = device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
    for (let frame = 0; frame < 20 && !theater.immersive; frame++) await window.__capture.step(1 / 60);
    if (!theater.immersive) throw new Error('IWER did not enter XR');
    theater.endSession();
    theater.beginSession();
    for (let frame = 0; frame < 300 && (!theater.placed || theater.settle || theater.fitUntil); frame++)
      await window.__capture.step(1 / 30);
    if (!theater.placed || theater.settle || theater.fitUntil) throw new Error('XR stage not settled');
    theater.beginCrossing(6);
    const input = device.hands.left;
    const names = Array.from(input.inputSource.hand.keys());
    const state = Object.getOwnPropertySymbols(input).map((symbol) => input[symbol])
      .find((value) => value?.poses?.default && value?.poses?.pinch);
    if (!state || names.length !== 25) throw new Error('IWER joints unavailable');
    const Vector3 = theater.anchor.constructor;
    const toReference = theater.player.matrixWorld.clone().invert();
    const inject = (points, id) => {
      theater.player.updateMatrixWorld(true);
      toReference.copy(theater.player.matrixWorld).invert();
      const reference = points.map((point) => new Vector3(point.x, point.y, point.z).applyMatrix4(toReference));
      const center = new Vector3();
      for (const point of reference) center.add(point);
      center.multiplyScalar(1 / reference.length);
      const jointTransforms = {};
      for (let index = 0; index < names.length; index++) {
        const point = reference[index];
        jointTransforms[names[index]] = { offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0,
          0, 0, 1, 0, point.x - center.x, point.y - center.y, point.z - center.z, 1], radius: 0.008 };
      }
      state.poses[id] = { jointTransforms };
      input.position.copy(center);
      input.quaternion.set(0, 0, 0, 1);
      input.poseId = id;
      input.connected = true;
      device.controlMode = 'programmatic';
      device.notifyStateChange?.();
    };
    const pointsAt = (position) => Array.from({ length: 25 }, () => ({ ...position }));
    const swats = [], cups = [];
    let maxJointError = 0;
    for (let trial = 0; trial < 5; trial++) {
      theater.moths.start(6, 21021 + trial, 0.25);
      const moth = theater.moths.spawn(theater.mothStage);
      moth.phase = 'approach'; moth.x = theater.lanternPos.x + 0.2;
      moth.y = theater.lanternPos.y + 0.04; moth.z = theater.lanternPos.z;
      const expected = { x: moth.x + 0.05, y: moth.y, z: moth.z };
      inject(pointsAt(expected), `moth-swat-${trial}`);
      await window.__capture.step(1 / 60);
      const actual = theater.hands[0].joints;
      maxJointError = Math.max(maxJointError, Math.abs(actual[27] - expected.x),
        Math.abs(actual[28] - expected.y), Math.abs(actual[29] - expected.z));
      swats.push({ tracked: theater.hands[0].valid, shooed: theater.moths.shooed,
        phase: moth.phase });
      input.connected = false;
      await window.__capture.step(1 / 60);
    }
    for (let trial = 0; trial < 5; trial++) {
      theater.moths.start(6, 31021 + trial, 0.25);
      const flame = theater.lanternPos;
      const cup = pointsAt({ x: flame.x - 0.08, y: flame.y - 0.025, z: flame.z });
      cup[0] = { x: flame.x - 0.08, y: flame.y - 0.07, z: flame.z };
      for (let finger = 0; finger < 5; finger++) {
        const base = [1, 5, 10, 15, 20][finger];
        const z = flame.z - 0.045 + finger * 0.022;
        for (let joint = 0; joint < 4 && base + joint < 25; joint++)
          cup[base + joint] = { x: flame.x - 0.08, y: flame.y - 0.025 + joint * 0.026, z };
      }
      cup[5] = { x: flame.x - 0.08, y: flame.y - 0.025, z: flame.z - 0.045 };
      cup[20] = { x: flame.x - 0.08, y: flame.y - 0.025, z: flame.z + 0.045 };
      inject(cup, `moth-cup-${trial}`);
      const moth = theater.moths.spawn(theater.mothStage);
      moth.phase = 'dive'; moth.x = flame.x + 0.14; moth.y = flame.y; moth.z = flame.z;
      for (let frame = 0; frame < 45 && theater.moths.deflections === 0; frame++) await window.__capture.step(1 / 60);
      let soft = 0;
      for (const value of theater.playField.soft) if (value > 0) soft++;
      cups.push({ tracked: theater.hands[0].valid, shielded: theater.moths.shielded,
        deflections: theater.moths.deflections, shooed: theater.moths.shooed,
        phase: moth.phase, gutters: theater.moths.gutters,
        softFraction: soft / theater.playField.soft.length,
        flatValid: theater.hands[0].flat.valid,
        projectedWrist: [theater.hands[0].flat.x[0], theater.hands[0].flat.y[0]],
        projectedIndex: [theater.hands[0].flat.x[5], theater.hands[0].flat.y[5]],
        flame: theater.lanternPos.toArray(), paper: theater.screenCentre.toArray(), frame: { ...theater.frame } });
      input.connected = false;
      await window.__capture.step(1 / 60);
    }
    return { swats, cups, maxJointError };
  });
  result.errors = errors;
  result.pass = errors.length === 0 && result.maxJointError < 0.002
    && result.swats.every((row) => row.tracked && row.shooed === 1 && row.phase === 'tumble')
    && result.cups.every((row) => row.tracked && row.shielded && row.deflections > 0
      && row.gutters === 0 && row.softFraction >= 0.6);
  writeFileSync('../collab/codex/23-moths-xr.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
  await page.close();
} finally {
  await browser.close();
}

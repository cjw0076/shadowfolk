export async function injectCase(frame, { targetId, kind = 'wake', side = 'left' }) {
  return await frame.evaluate(async ({ targetId, kind, side }) => {
    const theater = window.__theater;
    const device = window.IWER_DEVICE;
    const targetIndex = theater.baked.findIndex((entry) => entry.def.id === targetId);
    if (targetIndex < 0) throw new Error(`Unknown target ${targetId}`);
    const baked = theater.baked[targetIndex];
    if ((kind === 'half' || kind === 'fists') && !baked.partner) throw new Error(`${targetId} has no partner hand`);
    const handModel = kind === 'fists' ? await import('/src/shadow/hand-model.ts') : null;
    const fist = handModel?.shape(handModel.basePoses.relaxed(), {
      thumb: 0.7, index: 1, middle: 1, ring: 1, pinky: 1,
    });
    const hands = kind === 'relaxed'
      ? [{ side: 'left', pose: theater.demoFrom, shift: [0, 0, 0] }]
      : kind === 'half'
        ? [{ side: 'left', pose: baked.pose, shift: baked.shifts[0] }]
        : kind === 'fists'
          ? [{ side: 'left', pose: fist, shift: baked.shifts[0] },
            { side: 'right', pose: handModel.mirror(fist), shift: baked.shifts[1] }]
          : baked.partner
            ? [{ side: 'left', pose: baked.pose, shift: baked.shifts[0] },
              { side: 'right', pose: baked.partner, shift: baked.shifts[1] }]
            : [{ side, pose: side === 'right' ? theater.mirrored[targetIndex] : baked.pose, shift: baked.shifts[0] }];

    device.remote.activateCaptureMode();
    device.controlMode = 'programmatic';
    device.primaryInputMode = 'hand';
    device.hands.left.connected = false;
    device.hands.right.connected = false;
    theater.order[0] = targetIndex;
    theater.step = 0;
    theater.enter(0);
    theater.player.updateMatrixWorld(true);
    const toReference = theater.player.matrixWorld.clone().invert();
    const Vector3 = theater.anchor.constructor;
    const expected = {};
    for (const { side: handSide, pose, shift } of hands) {
      const positions = new Float32Array(pose.radii.length * 3);
      theater.poseToWorld(pose, positions, 0, shift);
      const angle = kind === 'wake' ? (handSide === 'right' ? -5 : 5) * Math.PI / 180 : 0;
      const sine = Math.sin(angle), cosine = Math.cos(angle);
      const translation = kind === 'wake' ? [handSide === 'right' ? -0.005 : 0.005, 0.004, 0.006] : [0, 0, 0];
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
      const hand = device.hands[handSide];
      const poseState = Object.getOwnPropertySymbols(hand).map((symbol) => hand[symbol])
        .find((value) => value?.poses?.default && value?.poses?.pinch);
      if (!poseState) throw new Error(`IWER pose registry unavailable for ${handSide}`);
      const jointNames = Array.from(hand.inputSource.hand.keys());
      if (jointNames.length !== pose.radii.length) throw new Error(`IWER joint count ${jointNames.length} differs from target ${pose.radii.length}`);
      const jointTransforms = {};
      for (let joint = 0; joint < jointNames.length; joint++) {
        const point = reference[joint];
        const localX = point.x - centre.x;
        jointTransforms[jointNames[joint]] = {
          offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
            handSide === 'right' ? -localX : localX, point.y - centre.y, point.z - centre.z, 1],
          radius: pose.radii[joint],
        };
      }
      const poseId = `shadowfolk-e2e-${handSide}`;
      poseState.poses[poseId] = { jointTransforms };
      hand.position.set(centre.x, centre.y, centre.z);
      hand.quaternion.set(0, 0, 0, 1);
      hand.setPinchValueImmediate(0);
      hand.poseId = poseId;
      hand.connected = true;
      expected[handSide] = { positions: Array.from(positions), radii: Array.from(pose.radii) };
    }
    window.__xrCaseExpected = expected;
    return { targetId, kind, hands: hands.map((hand) => hand.side), pass: baked.pass,
      noise: kind === 'wake' ? { translationMaxMetres: 0.006, rotationDegrees: 5 } : null };
  }, { targetId, kind, side });
}

export async function measureCase(frame, seconds = 6) {
  return await frame.evaluate(async ({ seconds }) => {
    const theater = window.__theater;
    const expected = window.__xrCaseExpected;
    const start = window.__capture.time;
    let peakScore = 0;
    let maxJointError = 0;
    let maxRadiusError = 0;
    let validFrames = 0;
    const maxSteps = Math.ceil(seconds * 20);
    for (let index = 0; index < maxSteps; index++) {
      await window.__capture.step(1 / 20);
      peakScore = Math.max(peakScore, theater.score);
      let allValid = true;
      for (const [side, points] of Object.entries(expected)) {
        const hand = theater.hands[side === 'left' ? 0 : 1];
        allValid &&= hand.valid;
        if (hand.valid && index > 1) {
          for (let joint = 0; joint < points.positions.length; joint++) {
            maxJointError = Math.max(maxJointError, Math.abs(hand.joints[joint] - points.positions[joint]));
          }
          for (let joint = 0; joint < points.radii.length; joint++) {
            maxRadiusError = Math.max(maxRadiusError, Math.abs(hand.radii[joint] - points.radii[joint]));
          }
        }
      }
      if (allValid) validFrames++;
      if (theater.demoHand.valid || theater.demoHand2.valid) throw new Error('Scripted puppet active during XR case');
      if (theater.phase === 1) break;
    }
    const sources = theater.renderer.xr.getSession().inputSources.filter((source) => source.hand).map((source) => source.handedness);
    return { woke: theater.phase === 1, seconds: +(window.__capture.time - start).toFixed(2),
      peakScore: +peakScore.toFixed(3), validFrames,
      maxJointError: +maxJointError.toFixed(6), maxRadiusError: +maxRadiusError.toFixed(6), sources };
  }, { seconds });
}

export function validateCase(prepared, outcome) {
  const row = { case: prepared.kind, target: prepared.targetId, hands: prepared.hands.join('+'), pass: prepared.pass,
    peakScore: outcome.peakScore, timeToWake: outcome.woke ? outcome.seconds : null,
    heldSeconds: outcome.woke ? null : outcome.seconds, woke: outcome.woke,
    validFrames: outcome.validFrames, maxJointError: outcome.maxJointError,
    maxRadiusError: outcome.maxRadiusError };
  if (outcome.validFrames < 5 || outcome.maxJointError > 0.002 || outcome.maxRadiusError > 0.002) {
    throw new Error(`XR joints did not reach readHands: ${JSON.stringify(row)}`);
  }
  if (prepared.hands.some((side) => !outcome.sources.includes(side))) {
    throw new Error(`Missing WebXR hand input source: ${JSON.stringify(row)}`);
  }
  if (prepared.kind === 'wake' && (!outcome.woke || outcome.seconds > 6)) {
    throw new Error(`Target did not wake: ${JSON.stringify(row)}`);
  }
  if (prepared.kind !== 'wake' && (outcome.woke || outcome.seconds < 6)) {
    throw new Error(`Negative case woke or ended early: ${JSON.stringify(row)}`);
  }
  return row;
}

export async function injectLanternHand(frame, { position, open = false }) {
  return await frame.evaluate(async ({ position, open }) => {
    const theater = window.__theater;
    const device = window.IWER_DEVICE;
    const { basePoses } = await import('/src/shadow/hand-model.ts');
    const pose = open ? basePoses.relaxed() : basePoses.pinch();
    const thumb = 4 * 16 + 12;
    const index = 9 * 16 + 12;
    const midpoint = [0, 1, 2].map((axis) => (pose.mats[thumb + axis] + pose.mats[index + axis]) / 2);
    device.remote.activateCaptureMode();
    device.controlMode = 'programmatic';
    device.primaryInputMode = 'hand';
    device.hands.right.connected = false;
    theater.player.updateMatrixWorld(true);
    const inverse = theater.player.matrixWorld.clone().invert();
    const Vector3 = theater.anchor.constructor;
    const reference = [];
    for (let joint = 0; joint < pose.radii.length; joint++) {
      const offset = joint * 16 + 12;
      reference.push(new Vector3(
        position[0] + pose.mats[offset] - midpoint[0],
        position[1] + pose.mats[offset + 1] - midpoint[1],
        position[2] + pose.mats[offset + 2] - midpoint[2],
      ).applyMatrix4(inverse));
    }
    const centre = new Vector3();
    for (const point of reference) centre.add(point);
    centre.multiplyScalar(1 / reference.length);
    const hand = device.hands.left;
    const poseState = Object.getOwnPropertySymbols(hand).map((symbol) => hand[symbol])
      .find((value) => value?.poses?.default && value?.poses?.pinch);
    if (!poseState) throw new Error('IWER left-hand pose registry unavailable');
    const names = Array.from(hand.inputSource.hand.keys());
    const jointTransforms = {};
    for (let joint = 0; joint < names.length; joint++) {
      const point = reference[joint];
      jointTransforms[names[joint]] = {
        offsetMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
          point.x - centre.x, point.y - centre.y, point.z - centre.z, 1],
        radius: pose.radii[joint],
      };
    }
    const poseId = 'shadowfolk-carry-left';
    poseState.poses[poseId] = { jointTransforms };
    hand.position.set(centre.x, centre.y, centre.z);
    hand.quaternion.set(0, 0, 0, 1);
    hand.setPinchValueImmediate(0);
    hand.poseId = poseId;
    hand.connected = true;
    const gap = Math.hypot(...[0, 1, 2].map((axis) => pose.mats[thumb + axis] - pose.mats[index + axis]));
    return { open, gapMetres: +gap.toFixed(5), position };
  }, { position, open });
}

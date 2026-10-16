import { mkdirSync, writeFileSync } from 'node:fs';
import { injectCase, injectLanternHand, measureCase, validateCase } from './xr-case.mjs';

const EVIDENCE = '../collab/codex/08-evidence';

export default async function run({ page, frame }) {
  const target = frame ?? page;
  mkdirSync(EVIDENCE, { recursive: true });
  const initialized = await target.evaluate(() => !!window.__xrRoom);
  if (!initialized) {
    await target.evaluate(() => {
      localStorage.removeItem('shadow-theater.v1');
      localStorage.removeItem('shadowfolk.rig-anchor.v1');
      localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
    });
    const url = new URL(target.url());
    url.search = '?capture=keepdom&day=20378';
    await target.goto(url.toString(), { waitUntil: 'load' });
    await target.waitForFunction(() => window.__theater && window.__capture && window.IWER_DEVICE, null, { timeout: 30000 });
    await target.waitForFunction(() => window.IWER_DEVICE.sessionOffered, null, { timeout: 30000 });
    await target.evaluate(async () => {
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
    const table = await target.evaluate(async () => {
      const theater = window.__theater;
      for (let index = 0; index < 20 && !theater.immersive; index++) await window.__capture.step(1 / 20);
      if (!theater.immersive) throw new Error('IWER did not enter XR');
      theater.endSession();
      theater.beginSession();
      for (let index = 0; index < 280; index++) {
        await window.__capture.step(1 / 20);
        const uuid = localStorage.getItem('shadowfolk.rig-anchor.v1');
        if (theater.mode === 'table' && theater.anchored && uuid && !theater.settle && theater.fitUntil === 0) {
          const result = { mode: theater.mode, anchored: theater.anchored, uuid,
            lantern: theater.lanternPos.toArray(), head: theater.camera.getWorldPosition(new theater.anchor.constructor()).toArray(),
            time: window.__capture.time };
          window.__xrRoom = { stage: 'restore', table: result };
          return result;
        }
      }
      throw new Error(`Table anchor not ready: ${JSON.stringify({ mode: theater.mode, anchored: theater.anchored, uuid: localStorage.getItem('shadowfolk.rig-anchor.v1') })}`);
    });
    await page.screenshot({ path: `${EVIDENCE}/anchor-before.png` });
    return { stage: 'table', table, next: 'restore' };
  }

  const stage = await target.evaluate(() => window.__xrRoom.stage);
  if (stage === 'restore') {
    await target.evaluate(async () => {
      const device = window.IWER_DEVICE;
      const theater = window.__theater;
      let restore = theater.restore;
      window.__xrRoom.restoreTransitions = [restore];
      Object.defineProperty(theater, 'restore', {
        configurable: true,
        get: () => restore,
        set: (next) => { restore = next; window.__xrRoom.restoreTransitions.push(next); },
      });
      device.hands.left.connected = false;
      device.hands.right.connected = false;
      await theater.renderer.xr.getSession().end();
      device.position.set(-0.9, 1.25, -0.89);
      const pitch = -8 * Math.PI / 180;
      const yaw = 110 * Math.PI / 180;
      device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2), Math.cos(pitch / 2) * Math.sin(yaw / 2),
        -Math.sin(pitch / 2) * Math.sin(yaw / 2), Math.cos(pitch / 2) * Math.cos(yaw / 2));
    });
    await target.waitForFunction(() => window.IWER_DEVICE.sessionOffered, null, { timeout: 30000 });
    await target.evaluate(async () => await window.IWER_DEVICE.remote.dispatch('accept_session', {}));
    const restored = await target.evaluate(async () => {
      const theater = window.__theater;
      const before = window.__xrRoom.table;
      const seen = new Set(window.__xrRoom.restoreTransitions);
      for (let index = 0; index < 240; index++) {
        await window.__capture.step(1 / 20);
        seen.add(theater.restore);
        for (const transition of window.__xrRoom.restoreTransitions) seen.add(transition);
        if (theater.anchored && theater.mode === 'table' && !theater.settle) {
          const after = theater.lanternPos.toArray();
          const metres = Math.hypot(...after.map((value, axis) => value - before.lantern[axis]));
          const result = { restoreStates: Array.from(seen), anchored: theater.anchored, mode: theater.mode,
            previousLantern: before.lantern, restoredLantern: after, displacementMetres: +metres.toFixed(5),
            uuidBefore: before.uuid, uuidAfter: localStorage.getItem('shadowfolk.rig-anchor.v1'),
            movedHead: theater.camera.getWorldPosition(new theater.anchor.constructor()).toArray() };
          if (!seen.has('ready') || metres > 0.02 || result.uuidBefore !== result.uuidAfter) {
            throw new Error(`Persistent anchor failed: ${JSON.stringify(result)}`);
          }
          window.__xrRoom.restore = result;
          window.__xrRoom.stage = 'carry';
          return result;
        }
      }
      throw new Error(`Anchor restore timed out: ${JSON.stringify({ states: Array.from(seen), mode: theater.mode, anchored: theater.anchored })}`);
    });
    await page.screenshot({ path: `${EVIDENCE}/anchor-restored.png` });
    return { stage: 'restore', restored, next: 'carry' };
  }

  if (stage === 'carry') {
    const move = await target.evaluate(async () => {
      const theater = window.__theater;
      const { fitTable } = await import('/src/theater/room.ts');
      const lantern = theater.lanternPos.clone();
      const candidates = [1, -1].map((sign) => lantern.clone().addScaledVector(theater.right, sign * 0.3));
      const destination = candidates.find((point) => fitTable(theater.surfaces(), point, theater.fwd, theater.right, 0.44, 0.75, [0, -0.04, 0.04]));
      if (!destination) throw new Error('Neither 30 cm lateral table position fits');
      return { before: lantern.toArray(), destination: destination.toArray(), mode: theater.mode,
        previousUuid: localStorage.getItem('shadowfolk.rig-anchor.v1') };
    });
    const pinch = await injectLanternHand(target, { position: move.before });
    const pickedUp = await target.evaluate(async () => {
      const theater = window.__theater;
      for (let index = 0; index < 20; index++) {
        await window.__capture.step(1 / 20);
        if (theater.carry) {
          const joints = theater.hands[0].joints;
          const gap = Math.hypot(...[0, 1, 2].map((axis) => joints[4 * 3 + axis] - joints[9 * 3 + axis]));
          return { carrying: true, handValid: theater.hands[0].valid, gapMetres: +gap.toFixed(5), mode: theater.mode };
        }
      }
      throw new Error(`Real-joint pinch did not pick up the lantern: ${JSON.stringify({ mode: theater.mode, handValid: theater.hands[0].valid })}`);
    });
    await page.screenshot({ path: `${EVIDENCE}/carry-picked-up.png` });
    await injectLanternHand(target, { position: move.destination });
    const moved = await target.evaluate(async () => {
      const theater = window.__theater;
      for (let index = 0; index < 8; index++) await window.__capture.step(1 / 20);
      if (!theater.carry || !theater.hands[0].valid) throw new Error('Lantern lost its real XR hand during carry');
      return { lantern: theater.lanternPos.toArray(), mode: theater.mode };
    });
    const released = await injectLanternHand(target, { position: move.destination, open: true });
    const setDown = await target.evaluate(async (before) => {
      const theater = window.__theater;
      for (let index = 0; index < 100; index++) {
        await window.__capture.step(1 / 20);
        if (!theater.carry && theater.mode === 'table' && !theater.settle && theater.anchored) {
          const lantern = theater.lanternPos.toArray();
          const distance = Math.hypot(...lantern.map((value, axis) => value - before[axis]));
          const joints = theater.hands[0].joints;
          const gap = Math.hypot(...[0, 1, 2].map((axis) => joints[4 * 3 + axis] - joints[9 * 3 + axis]));
          const result = { mode: theater.mode, anchored: theater.anchored, handValid: theater.hands[0].valid,
            openGapMetres: +gap.toFixed(5), displacementMetres: +distance.toFixed(5), lantern,
            savedCarried: theater.saved.carried, uuid: localStorage.getItem('shadowfolk.rig-anchor.v1') };
          if (!result.handValid || gap < 0.035 || distance < 0.24 || distance > 0.36 || !result.savedCarried || !result.uuid) {
            throw new Error(`Carry set-down failed: ${JSON.stringify(result)}`);
          }
          window.__xrRoom.carry = result;
          window.__xrRoom.stage = 'pinned';
          return result;
        }
      }
      throw new Error(`Carry did not refit and re-anchor: ${JSON.stringify({ mode: theater.mode, anchored: theater.anchored, carrying: !!theater.carry })}`);
    }, move.before);
    await page.screenshot({ path: `${EVIDENCE}/carry-set-down.png` });
    return { stage: 'carry', move, pinch, pickedUp, moved, released, setDown, next: 'pinned' };
  }

  if (stage === 'pinned') {
    await target.evaluate(async () => {
      const device = window.IWER_DEVICE;
      await window.__theater.renderer.xr.getSession().end();
      localStorage.removeItem('shadowfolk.rig-anchor.v1');
      localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
      device.position.set(-1.9, 1.25, 1.2);
      const pitch = -8 * Math.PI / 180;
      const yaw = 90 * Math.PI / 180;
      device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2), Math.cos(pitch / 2) * Math.sin(yaw / 2),
        -Math.sin(pitch / 2) * Math.sin(yaw / 2), Math.cos(pitch / 2) * Math.cos(yaw / 2));
    });
    await target.waitForFunction(() => window.IWER_DEVICE.sessionOffered, null, { timeout: 30000 });
    await target.evaluate(async () => await window.IWER_DEVICE.remote.dispatch('accept_session', {}));
    const pinned = await target.evaluate(async () => {
      const theater = window.__theater;
      for (let index = 0; index < 260; index++) {
        await window.__capture.step(1 / 20);
        if (theater.mode === 'pinned' && theater.placed && !theater.settle && theater.fitUntil === 0) {
          const result = { mode: theater.mode, head: theater.camera.getWorldPosition(new theater.anchor.constructor()).toArray(),
            lantern: theater.lanternPos.toArray(), screen: theater.screenCentre.toArray(), wallActive: theater.wall.active };
          window.__xrRoom.pinned = result;
          window.__xrRoom.stage = 'pinnedWake';
          return result;
        }
      }
      throw new Error(`Pinned fit failed: ${JSON.stringify({ mode: theater.mode, placed: theater.placed, fitUntil: theater.fitUntil })}`);
    });
    await page.screenshot({ path: `${EVIDENCE}/pinned-before.png` });
    return { stage: 'pinned', pinned, next: 'pinnedWake' };
  }

  if (stage === 'pinnedWake') {
    const prepared = await injectCase(target, { targetId: 'peacock', kind: 'wake', side: 'left' });
    const outcome = await measureCase(target);
    await page.screenshot({ path: `${EVIDENCE}/pinned-wake-peacock.png` });
    const row = validateCase(prepared, outcome);
    const result = await target.evaluate((row) => {
      window.__xrRoom.pinnedWake = row;
      window.__xrRoom.stage = 'complete';
      return { table: window.__xrRoom.table, restore: window.__xrRoom.restore,
        carry: window.__xrRoom.carry, pinned: window.__xrRoom.pinned, pinnedWake: row };
    }, row);
    writeFileSync(`${EVIDENCE}/room-results.json`, JSON.stringify(result, null, 2));
    return { stage: 'pinnedWake', done: true, result };
  }
  return await target.evaluate(() => ({ done: true, result: { table: window.__xrRoom.table,
    restore: window.__xrRoom.restore, carry: window.__xrRoom.carry, pinned: window.__xrRoom.pinned,
    pinnedWake: window.__xrRoom.pinnedWake } }));
}

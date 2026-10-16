import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { injectCase, measureCase, validateCase } from './xr-case.mjs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const output = process.env.XR_ROOMS_OUT ?? '../collab/codex/12-evidence';
const rooms = {
  living_room: {
    table: { position: [-0.9, 1.25, -1.19], yaw: 90 },
    wall: { position: [-1.9, 1.25, -1.9], yaw: 90 },
    open: { position: [0, 1.25, 0], yaw: 0 },
  },
  office_small: {
    table: { position: [0.55, 1.2, -0.75], yaw: 180 },
    wall: { position: [0.64, 1.25, 0.1], yaw: 0 },
    open: { position: [-0.4, 1.25, 0.1], yaw: 180 },
  },
  office_large: {
    table: { position: [-0.66, 1.25, 0.9], yaw: 180 },
    wall: { position: [-0.6, 1.25, -1.32], yaw: 90 },
    open: { position: [0, 1.25, 0.5], yaw: 0 },
  },
  music_room: {
    table: { position: [1.4, 1.08, -0.97], yaw: 90 },
    wall: { position: [-1.5, 1.25, -1.7], yaw: 0 },
    open: { position: [-0.3, 1.25, 0.2], yaw: 0 },
  },
  meeting_room: {
    table: { position: [0, 1.18, -0.35], yaw: 0 },
    wall: { position: [-1.53, 1.25, -3.1], yaw: 0 },
    open: { position: [-1, 1.25, -1.2], yaw: 0 },
  },
};

const selected = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const cases = Object.entries(rooms).flatMap(([room, seats]) => Object.entries(seats)
  .filter(([seat]) => !selected.length || selected.includes(room) || selected.includes(`${room}:${seat}`))
  .map(([seat, head]) => ({ room, seat, head })));
if (!cases.length) throw new Error(`No room/seat matches: ${selected.join(', ')}`);
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
  ...(process.env.CHROME_EXTRA ?? '').split(' ').filter(Boolean)] });
const results = [];
try {
  for (const { room, seat, head } of cases) {
    const page = await browser.newPage({ viewport: { width: 800, height: 450 }, ignoreHTTPSErrors: true });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    try {
      await page.goto(`${base}?capture=keepdom&day=20378&first=peacock`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__capture && window.__theater && window.IWER_DEVICE?.sessionOffered,
        null, { timeout: 60000 });
      await page.evaluate(async ({ room, head }) => {
        localStorage.removeItem('shadow-theater.v1');
        localStorage.removeItem('shadowfolk.rig-anchor.v1');
        localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
        const device = window.IWER_DEVICE;
        device.sem.loadDefaultEnvironment(room);
        device.position.set(...head.position);
        const yaw = head.yaw * Math.PI / 180;
        const pitch = -8 * Math.PI / 180;
        device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2),
          Math.cos(pitch / 2) * Math.sin(yaw / 2),
          -Math.sin(pitch / 2) * Math.sin(yaw / 2),
          Math.cos(pitch / 2) * Math.cos(yaw / 2));
        device.primaryInputMode = 'hand';
        device.hands.left.connected = false;
        device.hands.right.connected = false;
        await device.remote.dispatch('accept_session', {});
      }, { room, head });
      let placement;
      for (let index = 0; index < 280; index++) {
        await page.evaluate(() => window.__capture.step(1 / 20));
        placement = await page.evaluate(() => {
          const theater = window.__theater;
          return theater.immersive && theater.placed && !theater.settle && theater.fitUntil === 0;
        });
        if (placement) break;
      }
      if (!placement) throw new Error('Placement did not settle');
      const before = await page.evaluate(async () => {
        const theater = window.__theater;
        const { SCREEN_W, SCREEN_H } = await import('/src/theater/painter.ts');
        const head = theater.camera.getWorldPosition(theater.anchor.clone()).toArray();
        const paper = theater.screenCentre.toArray();
        const lantern = theater.lanternPos.toArray();
        const forward = theater.fwd.toArray();
        const toPaper = paper.map((value, axis) => value - head[axis]);
        const distance = Math.hypot(...toPaper);
        const horizontal = Math.hypot(toPaper[0], toPaper[2]);
        const yawError = Math.acos(Math.max(-1, Math.min(1,
          (toPaper[0] * forward[0] + toPaper[2] * forward[2]) / horizontal))) * 180 / Math.PI;
        const pitchError = (Math.atan2(toPaper[1], horizontal) - (-8 * Math.PI / 180)) * 180 / Math.PI;
        const points = [];
        const Vector3 = theater.anchor.constructor;
        for (const radius of [0.055]) {
          points.push({ part: 'lantern', point: new Vector3(...lantern), radius });
        }
        if (theater.table) points.push({ part: 'stand',
          point: new Vector3(...lantern).add(new Vector3(0, -0.128, 0)), radius: 0.004 });
        for (const side of [-1, 0, 1]) for (const vertical of [-1, 0, 1]) {
          points.push({ part: 'paper', point: new Vector3(...paper)
            .addScaledVector(theater.right, side * SCREEN_W / 2)
            .add(new Vector3(0, vertical * SCREEN_H / 2, 0)), radius: 0.006 });
        }
        const signedBox = (box, point) => {
          const outside = [0, 1, 2].map((axis) => Math.max(box.min.getComponent(axis) - point.getComponent(axis),
            point.getComponent(axis) - box.max.getComponent(axis), 0));
          const d = Math.hypot(...outside);
          if (d > 0) return d;
          return -Math.min(...[0, 1, 2].flatMap((axis) => [point.getComponent(axis) - box.min.getComponent(axis),
            box.max.getComponent(axis) - point.getComponent(axis)]));
        };
        const clearances = [];
        const surfaces = theater.surfaces();
        let nearestWall = Infinity;
        for (const surface of surfaces) {
          if (surface.label !== 'wall' || !surface.polygon?.length) continue;
          surface.object.updateMatrixWorld(true);
          const localHead = new Vector3(...head).applyMatrix4(surface.object.matrixWorld.clone().invert());
          const horizontal = surface.polygon.map((vertex) => vertex.x);
          const vertical = surface.polygon.map((vertex) => vertex.z);
          if (localHead.x >= Math.min(...horizontal) && localHead.x <= Math.max(...horizontal)
            && localHead.z >= Math.min(...vertical) && localHead.z <= Math.max(...vertical)) {
            nearestWall = Math.min(nearestWall, Math.abs(localHead.y));
          }
        }
        for (const surface of surfaces) {
          const box = surface.box;
          for (const sample of points) {
            if (box) {
              const d = signedBox(box, sample.point) - sample.radius;
              clearances.push({ part: sample.part, surface: `${surface.label} mesh`,
                metres: sample.part === 'stand' && surface.label === 'table' && d > -0.005 ? Math.max(0, d) : d });
            } else if (surface.polygon?.length >= 3) {
              surface.object.updateMatrixWorld(true);
              const local = sample.point.clone().applyMatrix4(surface.object.matrixWorld.clone().invert());
              const polygon = surface.polygon;
              let inside = false;
              let edge = Infinity;
              for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
                const start = polygon[previous], end = polygon[index];
                if ((end.z > local.z) !== (start.z > local.z)
                  && local.x < (start.x - end.x) * (local.z - end.z) / (start.z - end.z) + end.x) inside = !inside;
                const dx = end.x - start.x, dz = end.z - start.z;
                const fraction = Math.max(0, Math.min(1,
                  ((local.x - start.x) * dx + (local.z - start.z) * dz) / (dx * dx + dz * dz || 1)));
                edge = Math.min(edge, Math.hypot(local.x - start.x - fraction * dx,
                  local.z - start.z - fraction * dz));
              }
              const d = Math.hypot(local.y, inside ? 0 : edge) - sample.radius;
              clearances.push({ part: sample.part, surface: surface.label,
                metres: sample.part === 'stand' && surface.label === 'table' && d > -0.005 ? Math.max(0, d) : d });
            }
          }
        }
        const Box3 = surfaces.find((surface) => surface.box)?.box?.constructor;
        if (Box3) for (const entity of theater.queries.meshes.entities) {
          if (!entity.object3D) continue;
          const box = new Box3().setFromObject(entity.object3D);
          if (box.isEmpty()) continue;
          const size = box.getSize(new Vector3());
          if (size.x * size.y * size.z > 50 || (size.y > 1.5 && (size.x < 0.5 || size.z < 0.5))) continue;
          for (const sample of points) {
            const d = signedBox(box, sample.point) - sample.radius;
            clearances.push({ part: sample.part, surface: 'tracked mesh',
              metres: sample.part === 'stand' && d > -0.005 ? Math.max(0, d) : d });
          }
        }
        clearances.sort((first, second) => first.metres - second.metres);
        return { mode: theater.mode, anchored: theater.anchored, head, lantern, paper,
          distance: +distance.toFixed(3), yawError: +yawError.toFixed(2), pitchError: +pitchError.toFixed(2),
          clearance: clearances[0] && { ...clearances[0], metres: +clearances[0].metres.toFixed(4) },
          nearestWall: Number.isFinite(nearestWall) ? +nearestWall.toFixed(3) : null,
          wallActive: theater.wall.active,
          wallPoint: theater.wall.fit?.point?.toArray() ?? null,
          wallLabel: theater.wall.fit?.label ?? null,
          trackedSurfaces: theater.surfaces().length };
      });
      const prepared = await injectCase(page, { targetId: 'peacock', kind: 'wake' });
      const outcome = await measureCase(page);
      const wake = validateCase(prepared, outcome);
      const wall = await page.evaluate(async () => {
        const theater = window.__theater;
        for (let index = 0; index < 100; index++) await window.__capture.step(1 / 20);
        return { active: theater.wall.active, resident: theater.wall.has('peacock'),
          leaping: !!theater.wall.leaper, slots: theater.wall.slots?.length ?? 0 };
      });
      if (before.wallActive && !wall.resident) throw new Error('Woken creature did not settle on active wall');
      if (before.distance < 0.6 || before.distance > 1.6 || before.yawError > 35 || Math.abs(before.pitchError) > 35) {
        throw new Error(`Paper out of view: ${JSON.stringify(before)}`);
      }
      if (before.clearance && before.clearance.metres < 0) throw new Error(`Rig intersects ${JSON.stringify(before.clearance)}`);
      if (seat === 'wall' && (before.nearestWall == null || before.nearestWall > 0.7)) {
        throw new Error(`Wall seat is too far from a wall: ${before.nearestWall}`);
      }
      const result = { room, seat, head, ...before, wake, wall, errors };
      results.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      const result = { room, seat, head, error: String(error), errors };
      results.push(result);
      console.error(JSON.stringify(result));
    } finally {
      writeFileSync(`${output}/room-sweep.json`, JSON.stringify(results, null, 2));
      await page.close();
    }
  }
} finally { await browser.close(); }
if (results.some((result) => result.error)) process.exitCode = 1;

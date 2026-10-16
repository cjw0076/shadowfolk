import assert from 'node:assert/strict';
import { Box3, Object3D, Vector3 } from '@iwsdk/core';
import { fitPinWall, fitTable, fitWall, LANTERN_ON_TABLE, wallClearance, type Surface } from '../src/theater/room.ts';

let seed = 12062026;
const random = () => ((seed = seed * 16807 % 2147483647) / 2147483647);
const between = (min: number, max: number) => min + random() * (max - min);
const point = (x: number, z: number): DOMPointReadOnly => ({ x, z }) as DOMPointReadOnly;
const polygon = (width: number, depth: number) => [point(-width / 2, -depth / 2),
  point(width / 2, -depth / 2), point(width / 2, depth / 2), point(-width / 2, depth / 2)];
const horizontal = (label: string, x: number, y: number, z: number, width: number, depth: number, rotation: number): Surface => {
  const object = new Object3D();
  object.position.set(x, y, z);
  object.rotation.y = rotation;
  return { label, object, orientation: 'horizontal', polygon: polygon(width, depth) };
};
const wallAt = (distance: number, width: number, height: number): Surface => {
  const object = new Object3D();
  object.position.set(0, 1.2, -distance);
  object.rotation.x = Math.PI / 2;
  return { label: 'wall', object, orientation: 'vertical', polygon: polygon(width, height) };
};
const clutterAt = (x: number, y: number, z: number, width: number, height: number, depth: number): Surface => {
  const object = new Object3D();
  const box = new Box3(new Vector3(x - width / 2, y, z - depth / 2),
    new Vector3(x + width / 2, y + height, z + depth / 2));
  return { label: 'other', object, orientation: 'unknown', box };
};
const signedBox = (box: Box3, position: Vector3) => {
  const outside = [0, 1, 2].map((axis) => Math.max(box.min.getComponent(axis) - position.getComponent(axis),
    position.getComponent(axis) - box.max.getComponent(axis), 0));
  const distance = Math.hypot(...outside);
  if (distance > 0) return distance;
  return -Math.min(...[0, 1, 2].flatMap((axis) => [position.getComponent(axis) - box.min.getComponent(axis),
    box.max.getComponent(axis) - position.getComponent(axis)]));
};
const paperBounds = (centre: Vector3) => {
  const bounds = new Box3().makeEmpty();
  for (const horizontal of [-1, 1]) for (const vertical of [-1, 1]) for (const depth of [-1, 1]) {
    bounds.expandByPoint(centre.clone().addScaledVector(right, horizontal * 0.522)
      .addScaledVector(forward, depth * 0.012).add(new Vector3(0, vertical * 0.352, 0)));
  }
  return bounds;
};
const lantern = new Vector3(0, 1, -0.25);
const head = new Vector3(0, 1.25, 0);
const forward = new Vector3(0, 0, -1);
const right = new Vector3(1, 0, 0);
const lightToScreen = 0.75;
const halfFeet = 0.44;
const screenWidth = 1;
const screenHeight = 0.66;
const summary = { table: 0, pinned: 0, float: 0, wall: 0, failures: 0 };
const checkView = (paper: Vector3, room: number) => {
  const horizontal = Math.hypot(paper.x - head.x, paper.z - head.z);
  const distance = paper.distanceTo(head);
  const pitchError = Math.atan2(paper.y - head.y, horizontal) * 180 / Math.PI + 8;
  assert.ok(distance >= 0.6 && distance <= 1.6, `room ${room}: paper distance ${distance}`);
  assert.ok(Math.abs(pitchError) <= 35, `room ${room}: paper angle ${pitchError}`);
};

const broadTable = horizontal('table', 0, 0.77, -0.65, 2, 2, 0);
assert.equal(fitTable([broadTable, clutterAt(0, 0, -1.1, 1, 1.4, 0.65)],
  lantern, forward, right, halfFeet, lightToScreen), null, 'paper must not pass through furniture');
assert.equal(fitTable([broadTable, clutterAt(0, 0, -0.25, 0.2, 0.78, 0.2)],
  lantern, forward, right, halfFeet, lightToScreen, [0]), null, 'stand must not pass through tabletop clutter');
assert.equal(fitPinWall([wallAt(1.05, 2, 2), clutterAt(0, 0, -1.03, 0.5, 1.6, 0.3)],
  head, forward, 1.24, lightToScreen, 0.14, 0.5, 0.015), null, 'pinned paper must not pass through furniture');
const door = wallAt(1.05, 1, 2);
door.label = 'door';
assert.equal(fitPinWall([door], head, forward, 1.24, lightToScreen, 0.14, 0.5, 0.015),
  null, 'paper must not pin to a door');

for (let index = 0; index < 1000; index++) {
  const table = horizontal('table', between(-0.55, 0.55), between(0.45, 0.9), between(-0.9, -0.25),
    between(0.5, 2.2), between(0.4, 2), between(-Math.PI, Math.PI));
  const wall = wallAt(between(0.2, 3), between(1.1, 4), between(1.5, 3));
  const clutter = Array.from({ length: 3 }, () => clutterAt(between(-1.5, 1.5), 0,
    between(-2, 0.7), between(0.1, 0.45), between(0.2, 1.4), between(0.1, 0.45)));
  const surfaces = [table, wall, ...clutter];
  const calculate = () => {
    const pin = fitPinWall(surfaces, head, forward, 1.24, lightToScreen, 0.14, 0.5, 0.015);
    const tableFit = fitTable(surfaces, lantern, forward, right, halfFeet, lightToScreen);
    const wallFit = fitWall(surfaces, lantern, lantern.clone().addScaledVector(forward, lightToScreen)
      .add(new Vector3(0, 0.24, 0)), forward);
    return { pin, tableFit, wallFit };
  };
  const first = calculate();
  const second = calculate();
  const serialize = (result: ReturnType<typeof calculate>) => JSON.stringify({
    pin: result.pin && { depth: result.pin.depth, point: result.pin.wall.point.toArray() },
    tableFit: result.tableFit,
    wallFit: result.wallFit && { point: result.wallFit.point.toArray(), distance: result.wallFit.distance },
  });
  assert.equal(serialize(first), serialize(second), `room ${index}: nondeterministic fit`);
  try {
    if (first.pin) {
      summary.pinned++;
      assert.ok(first.pin.depth >= 0.905 - 1e-6 && first.pin.depth <= 1.265 + 1e-6);
      assert.ok(wallClearance(first.pin.wall, 0, 0) >= 0.22 - 1e-6);
      assert.ok(first.pin.wall.normal.dot(forward) < -0.75);
      const centre = head.clone().addScaledVector(forward, first.pin.depth - 0.015 - lightToScreen);
      centre.y = 1;
      const paper = centre.clone().addScaledVector(forward, lightToScreen).add(new Vector3(0, 0.24, 0));
      checkView(paper, index);
      for (const box of clutter.map((item) => item.box!)) {
        assert.ok(signedBox(box, centre) >= 0.055 - 1e-6, `room ${index}: pinned lantern intersects clutter`);
        assert.ok(!box.intersectsBox(paperBounds(paper)), `room ${index}: pinned frame intersects clutter`);
        for (const horizontal of [-screenWidth / 2, 0, screenWidth / 2]) {
          for (const vertical of [-screenHeight / 2, 0, screenHeight / 2]) {
            const sample = paper.clone().addScaledVector(right, horizontal).add(new Vector3(0, vertical, 0));
            assert.ok(signedBox(box, sample) >= 0.006 - 1e-6, `room ${index}: pinned paper intersects clutter`);
          }
        }
      }
    } else if (first.tableFit) {
      summary.table++;
      assert.equal(first.tableFit.label, 'table', `room ${index}: clutter mistaken for table`);
      assert.ok(Math.abs(first.tableFit.shift) <= 0.2);
      assert.ok(first.tableFit.top >= 0.45 && first.tableFit.top <= 0.9);
      const centre = lantern.clone().addScaledVector(forward, first.tableFit.shift);
      centre.y = first.tableFit.top + LANTERN_ON_TABLE;
      assert.ok(Math.abs(centre.y - first.tableFit.top - LANTERN_ON_TABLE) < 1e-9);
      const standFoot = centre.clone().add(new Vector3(0, -0.128, 0));
      const paper = centre.clone().addScaledVector(forward, lightToScreen).add(new Vector3(0, 0.24, 0));
      checkView(paper, index);
      for (const box of clutter.map((item) => item.box!)) {
        assert.ok(signedBox(box, centre) >= 0.055 - 1e-6, `room ${index}: lantern intersects clutter`);
        assert.ok(signedBox(box, standFoot) >= 0.004 - 1e-6, `room ${index}: stand intersects clutter`);
        assert.ok(!box.intersectsBox(paperBounds(paper)), `room ${index}: frame intersects clutter`);
        for (const horizontal of [-screenWidth / 2, 0, screenWidth / 2]) {
          for (const vertical of [-screenHeight / 2, 0, screenHeight / 2]) {
            const sample = paper.clone().addScaledVector(right, horizontal).add(new Vector3(0, vertical, 0));
            assert.ok(signedBox(box, sample) >= 0.006 - 1e-6, `room ${index}: paper intersects clutter`);
          }
        }
      }
    } else {
      summary.float++;
      checkView(lantern.clone().addScaledVector(forward, lightToScreen).add(new Vector3(0, 0.24, 0)), index);
    }
    if (first.wallFit) {
      summary.wall++;
      assert.ok(first.wallFit.distance >= 0.08 && first.wallFit.distance <= 4);
      assert.ok(wallClearance(first.wallFit, 0, 0) >= 0.05 - 1e-6);
      assert.ok(first.wallFit.normal.dot(forward) < -0.5);
    }
  } catch (error) {
    summary.failures++;
    if (summary.failures <= 10) console.error(`room ${index}: ${String(error)}`);
  }
}

console.table(summary);
assert.equal(summary.failures, 0, `Fitting failed in ${summary.failures}/1000 rooms`);

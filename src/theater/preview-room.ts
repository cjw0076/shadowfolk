/**
 * A small night room for the browser preview: a wooden table and a plaster
 * wall. On a headset the real room takes their place; here they let the same
 * room-fitting code stand the theater on a table and hang the woken shadows
 * on a wall, so the preview shows what the headset does with your room.
 */
import {
  BoxGeometry, Box3, Color, Group, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry,
} from '@iwsdk/core';
import type { Surface } from './room.js';

export const PREVIEW_TABLE_TOP = 0.8;
const WALL_Z = -1.85;

export class PreviewRoom {
  readonly root = new Group();
  readonly surfaces: Surface[] = [];

  constructor() {
    this.root.name = 'PreviewRoom';
    const wood = new MeshStandardMaterial({ color: new Color('#4a2f22'), roughness: 0.7 });
    const table = new Mesh(new BoxGeometry(1.7, 0.05, 1.45), wood);
    table.position.set(0, PREVIEW_TABLE_TOP - 0.025, -0.68);
    const plaster = new MeshStandardMaterial({ color: new Color('#3a2c26'), roughness: 0.95 });
    const wall = new Mesh(new PlaneGeometry(5, 3.2), plaster);
    wall.position.set(0, 1.5, WALL_Z);
    this.root.add(table, wall);
    this.root.visible = false;

    // The same shapes, described the way the WebXR scene model describes a room.
    table.updateMatrixWorld(true);
    this.surfaces.push({ label: 'table', object: table, box: new Box3().setFromObject(table), orientation: 'horizontal' });
    const wallPlane = new Object3D();
    wallPlane.position.set(0, 1.5, WALL_Z + 0.001);
    wallPlane.rotation.x = Math.PI / 2; // plane-space +Y (normal) faces the viewer
    this.root.add(wallPlane);
    const pt = (x: number, z: number) => ({ x, y: 0, z, w: 1 }) as DOMPointReadOnly;
    this.surfaces.push({
      label: 'wall', object: wallPlane, orientation: 'vertical',
      polygon: [pt(-2.5, -1.6), pt(2.5, -1.6), pt(2.5, 1.6), pt(-2.5, 1.6)],
    });
  }
}

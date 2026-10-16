/**
 * A small night room for the browser preview: a wooden table and a plaster
 * wall. On a headset the real room takes their place; here they let the same
 * room-fitting code stand the theater on a table and hang the woken shadows
 * on a wall, so the preview shows what the headset does with your room.
 */
import {
  BoxGeometry, Box3, CanvasTexture, Color, Group, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry,
  RepeatWrapping, SRGBColorSpace,
} from '@iwsdk/core';
import type { Surface } from './room.js';

export const PREVIEW_TABLE_TOP = 0.8;
const WALL_Z = -1.85;

/** Seeded procedural canvas: wood grain or plaster, drawn once. */
function surfaceTexture(kind: 'wood' | 'plaster', size = 512): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let seed = kind === 'wood' ? 97 : 131;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (kind === 'wood') {
    g.fillStyle = '#4b2e20';
    g.fillRect(0, 0, size, size);
    for (let k = 0; k < 220; k++) {
      const y = rnd() * size, amp = 2 + rnd() * 6, f = 0.004 + rnd() * 0.01, ph = rnd() * 6.28;
      g.strokeStyle = rnd() < 0.5 ? `rgba(30,16,10,${0.10 + rnd() * 0.18})` : `rgba(120,78,50,${0.06 + rnd() * 0.12})`;
      g.lineWidth = 0.6 + rnd() * 2.2;
      g.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const yy = y + Math.sin(x * f + ph) * amp;
        if (x) g.lineTo(x, yy); else g.moveTo(x, yy);
      }
      g.stroke();
    }
  } else {
    g.fillStyle = '#3b2e29';
    g.fillRect(0, 0, size, size);
    const img = g.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 18;
      img.data[i] += n; img.data[i + 1] += n * 0.9; img.data[i + 2] += n * 0.8;
    }
    g.putImageData(img, 0, 0);
    for (let k = 0; k < 60; k++) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? '20,14,12' : '90,72,62'},${0.04 + rnd() * 0.05})`;
      g.beginPath();
      g.arc(rnd() * size, rnd() * size, 10 + rnd() * 60, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

export class PreviewRoom {
  readonly root = new Group();
  readonly surfaces: Surface[] = [];

  constructor() {
    this.root.name = 'PreviewRoom';
    const woodMap = surfaceTexture('wood');
    woodMap.repeat.set(1.6, 1.2);
    const wood = new MeshStandardMaterial({ map: woodMap, color: new Color('#ffffff'), roughness: 0.55, metalness: 0.02 });
    const table = new Mesh(new BoxGeometry(1.7, 0.05, 1.45), wood);
    table.position.set(0, PREVIEW_TABLE_TOP - 0.025, -0.68);
    const plasterMap = surfaceTexture('plaster');
    plasterMap.repeat.set(3, 2);
    const plaster = new MeshStandardMaterial({ map: plasterMap, color: new Color('#ffffff'), roughness: 0.95 });
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

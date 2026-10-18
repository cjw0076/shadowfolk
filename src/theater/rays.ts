/**
 * `?rays` (filming / explainer): thin light rays from the lantern through each
 * fingertip and the wrist of every casting hand, continuing on to where that
 * joint's shadow lands on the paper. It draws the same projection the matcher
 * uses, so the picture is the algorithm. Rays are instanced thin cylinders so
 * they keep a visible width at any output resolution.
 */
import {
  AdditiveBlending, Color, CylinderGeometry, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3,
} from '@iwsdk/core';
import { ScreenFrame } from '../shadow/silhouette.js';

const JOINTS = [0, 4, 9, 14, 19, 24]; // wrist + five fingertips
const MAX = 4 * JOINTS.length; // up to four casting hands

export class LightRays {
  readonly root = new Group();
  private light: InstancedMesh;
  private dark: InstancedMesh;
  private n = 0;
  private m = new Matrix4();
  private q = new Quaternion();
  private a = new Vector3();
  private b = new Vector3();
  private d = new Vector3();
  private s = new Vector3();
  private up = new Vector3(0, 1, 0);
  private c = new Color();

  constructor() {
    const geo = new CylinderGeometry(1, 1, 1, 6, 1, true);
    const mat = () => new MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    });
    this.light = new InstancedMesh(geo, mat(), MAX);
    this.dark = new InstancedMesh(geo, mat(), MAX);
    for (const im of [this.light, this.dark]) {
      im.frustumCulled = false;
      im.renderOrder = 6;
      im.count = 0;
      this.root.add(im);
    }
    this.root.name = 'LightRays';
  }

  begin(): void { this.n = 0; }

  /** Add one hand's rays; `fade` 0..1 scales the brightness. */
  add(joints: Float32Array, L: Vector3, s: ScreenFrame, fade: number): void {
    const hLight = (L.x - s.ox) * s.nx + (L.y - s.oy) * s.ny + (L.z - s.oz) * s.nz;
    if (hLight <= 0.01) return;
    for (const j of JOINTS) {
      if (this.n >= MAX) return;
      const px = joints[j * 3], py = joints[j * 3 + 1], pz = joints[j * 3 + 2];
      const hP = (px - s.ox) * s.nx + (py - s.oy) * s.ny + (pz - s.oz) * s.nz;
      const h = Math.min(Math.max(hP, 0.002), hLight - 0.03);
      const t = hLight / (hLight - h);
      this.a.set(px, py, pz);
      this.b.set(L.x + (px - L.x) * t, L.y + (py - L.y) * t, L.z + (pz - L.z) * t);
      // Warm light up to the joint, then a fainter line behind it to where its shadow lands.
      this.place(this.light, L, this.a, 0.0011, this.c.setRGB(0.9 * fade, 0.62 * fade, 0.3 * fade));
      this.place(this.dark, this.a, this.b, 0.0007, this.c.setRGB(0.22 * fade, 0.15 * fade, 0.08 * fade));
      this.n++;
    }
  }

  end(): void {
    this.light.count = this.dark.count = this.n;
    this.light.instanceMatrix.needsUpdate = true;
    this.dark.instanceMatrix.needsUpdate = true;
    if (this.light.instanceColor) this.light.instanceColor.needsUpdate = true;
    if (this.dark.instanceColor) this.dark.instanceColor.needsUpdate = true;
    this.root.visible = this.n > 0;
  }

  private place(im: InstancedMesh, from: Vector3, to: Vector3, radius: number, color: Color): void {
    this.d.subVectors(to, from);
    const len = this.d.length();
    if (len < 1e-5) { this.m.makeScale(0, 0, 0); im.setMatrixAt(this.n, this.m); return; }
    this.q.setFromUnitVectors(this.up, this.d.divideScalar(len));
    this.s.set(radius, len, radius);
    this.m.compose(this.d.copy(from).add(to).multiplyScalar(0.5), this.q, this.s);
    im.setMatrixAt(this.n, this.m);
    im.setColorAt(this.n, color);
  }
}

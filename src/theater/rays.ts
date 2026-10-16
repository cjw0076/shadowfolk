/**
 * `?rays` (filming / explainer): thin light rays from the lantern through each
 * fingertip and the wrist of every casting hand, continuing on to where that
 * joint's shadow lands on the paper. It draws the same projection the matcher
 * uses, so the picture is the algorithm.
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments, Vector3,
} from '@iwsdk/core';
import { ScreenFrame } from '../shadow/silhouette.js';

const JOINTS = [0, 4, 9, 14, 19, 24]; // wrist + five fingertips
const MAX_HANDS = 4;
const SEGS = MAX_HANDS * JOINTS.length * 2; // lantern→joint, joint→paper

export class LightRays {
  readonly lines: LineSegments;
  private pos = new Float32Array(SEGS * 2 * 3);
  private col = new Float32Array(SEGS * 2 * 3);
  private geo = new BufferGeometry();
  private n = 0;

  constructor() {
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new BufferAttribute(this.col, 3));
    const mat = new LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    });
    this.lines = new LineSegments(this.geo, mat);
    this.lines.name = 'LightRays';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
  }

  begin(): void { this.n = 0; }

  /** Add one hand's rays; `fade` 0..1 scales the brightness. */
  add(joints: Float32Array, L: Vector3, s: ScreenFrame, fade: number): void {
    const hLight = (L.x - s.ox) * s.nx + (L.y - s.oy) * s.ny + (L.z - s.oz) * s.nz;
    if (hLight <= 0.01) return;
    for (const j of JOINTS) {
      if (this.n >= SEGS - 1) return;
      const px = joints[j * 3], py = joints[j * 3 + 1], pz = joints[j * 3 + 2];
      const hP = (px - s.ox) * s.nx + (py - s.oy) * s.ny + (pz - s.oz) * s.nz;
      const h = Math.min(Math.max(hP, 0.002), hLight - 0.03);
      const t = hLight / (hLight - h);
      const qx = L.x + (px - L.x) * t, qy = L.y + (py - L.y) * t, qz = L.z + (pz - L.z) * t;
      // Warm light up to the joint, then a dimmer "shadow line" behind it to the paper.
      this.seg(L.x, L.y, L.z, px, py, pz, 1.0 * fade, 0.78 * fade, 0.42 * fade, 0.55 * fade, 0.4 * fade, 0.2 * fade);
      this.seg(px, py, pz, qx, qy, qz, 0.3 * fade, 0.2 * fade, 0.12 * fade, 0.12 * fade, 0.08 * fade, 0.05 * fade);
    }
  }

  end(): void {
    this.geo.setDrawRange(0, this.n * 2);
    (this.geo.attributes.position as BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as BufferAttribute).needsUpdate = true;
    this.lines.visible = this.n > 0;
  }

  private seg(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    r0: number, g0: number, b0: number, r1: number, g1: number, b1: number,
  ): void {
    const k = this.n * 6;
    this.pos[k] = ax; this.pos[k + 1] = ay; this.pos[k + 2] = az;
    this.pos[k + 3] = bx; this.pos[k + 4] = by; this.pos[k + 5] = bz;
    this.col[k] = r0; this.col[k + 1] = g0; this.col[k + 2] = b0;
    this.col[k + 3] = r1; this.col[k + 4] = g1; this.col[k + 5] = b1;
    this.n++;
  }
}

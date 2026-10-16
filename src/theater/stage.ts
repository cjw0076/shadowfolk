/**
 * Procedural stage props: the paper lantern (the light that casts every
 * shadow), the framed paper screen, and the translucent ghost hand that
 * demonstrates a pose when the player is stuck.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import { BONES, JOINT_COUNT } from '../shadow/hand-model.js';
import { SCREEN_H, SCREEN_W, ScreenPainter } from './painter.js';

export interface Lantern {
  root: Group;
  body: Mesh;
  bodyMat: MeshBasicMaterial;
  halo: Sprite;
  /** Warm pool of light on the table top around the lantern's foot. */
  pool: Mesh;
  /** Wooden stand under the lantern, shown when it rests on a real table. */
  setStand(height: number): void;
}

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,220,150,1)');
  grad.addColorStop(0.3, 'rgba(255,180,90,0.45)');
  grad.addColorStop(1, 'rgba(255,150,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

/** A small round paper lantern, ~9 cm tall, origin at its light centre. */
export function buildLantern(): Lantern {
  const root = new Group();
  root.name = 'Lantern';
  const profile: Vector2[] = [];
  for (let k = 0; k <= 16; k++) {
    const a = (k / 16) * Math.PI;
    profile.push(new Vector2(0.008 + Math.sin(a) * 0.036, -0.045 + (1 - Math.cos(a)) * 0.045));
  }
  const bodyMat = new MeshBasicMaterial({ color: new Color('#ffcf8a') });
  const body = new Mesh(new LatheGeometry(profile, 28), bodyMat);
  body.name = 'LanternBody';
  root.add(body);
  const ribMat = new MeshBasicMaterial({ color: new Color('#c98a4b'), transparent: true, opacity: 0.55 });
  for (let k = 1; k < 6; k++) {
    const y = -0.045 + (k / 6) * 0.09;
    const r = 0.008 + Math.sin(Math.acos(1 - ((y + 0.045) / 0.045))) * 0.036 + 0.0006;
    const rib = new Mesh(new CylinderGeometry(r, r, 0.0016, 28, 1, true), ribMat);
    rib.position.y = y;
    root.add(rib);
  }
  const capMat = new MeshStandardMaterial({ color: new Color('#2b1d16'), roughness: 0.6 });
  for (const y of [-0.049, 0.049]) {
    const cap = new Mesh(new CylinderGeometry(0.014, 0.016, 0.008, 20), capMat);
    cap.position.y = y;
    root.add(cap);
  }
  const halo = new Sprite(new SpriteMaterial({
    map: glowTexture(), blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9,
  }));
  halo.scale.setScalar(0.26);
  root.add(halo);

  // Stand: a turned post and a round foot, scaled to reach the table top.
  const stand = new Group();
  stand.name = 'LanternStand';
  const woodMat = new MeshStandardMaterial({ color: new Color('#3a2418'), roughness: 0.55 });
  const post = new Mesh(new CylinderGeometry(0.009, 0.012, 1, 12), woodMat);
  const foot = new Mesh(new CylinderGeometry(0.04, 0.045, 0.008, 24), woodMat);
  stand.add(post, foot);
  stand.visible = false;
  root.add(stand);
  const pool = new Mesh(
    new PlaneGeometry(0.9, 0.9),
    new MeshBasicMaterial({
      map: glowTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.35, toneMapped: false,
    }),
  );
  pool.name = 'LanternPool';
  pool.rotation.x = -Math.PI / 2;
  pool.renderOrder = -2;
  pool.visible = false;
  root.add(pool);
  const setStand = (h: number) => {
    stand.visible = h > 0.012;
    pool.visible = stand.visible;
    if (!stand.visible) return;
    pool.position.y = -0.053 - h + 0.002;
    const top = -0.053; // under the bottom cap
    post.scale.y = h - 0.008;
    post.position.y = top - (h - 0.008) / 2;
    foot.position.y = top - h + 0.004;
  };
  return { root, body, bodyMat, halo, pool, setStand };
}

export interface PaperScreen {
  root: Group;
  paper: Mesh;
  /** Pinned to a real wall: no frame or feet, two strips of tape instead. */
  setPinned(on: boolean): void;
}

/** Framed paper screen facing +Z, centred on its origin. */
export function buildScreen(painter: ScreenPainter): PaperScreen {
  const root = new Group();
  root.name = 'PaperScreen';
  const paper = painter.paperMesh;
  root.add(painter.root);
  const wood = new MeshStandardMaterial({ color: new Color('#3a2418'), roughness: 0.55, metalness: 0.05 });
  const frame = new Group();
  root.add(frame);
  const t = 0.022, d = 0.02;
  const bars: [number, number, number, number][] = [
    [0, SCREEN_H / 2 + t / 2, SCREEN_W + 2 * t, t],
    [0, -SCREEN_H / 2 - t / 2, SCREEN_W + 2 * t, t],
    [-SCREEN_W / 2 - t / 2, 0, t, SCREEN_H],
    [SCREEN_W / 2 + t / 2, 0, t, SCREEN_H],
  ];
  for (const [x, y, w, h] of bars) {
    const bar = new Mesh(new BoxGeometry(w, h, d), wood);
    bar.position.set(x, y, -d / 2 + 0.004);
    frame.add(bar);
  }
  // Two short feet so the screen reads as an object standing on the table.
  for (const x of [-SCREEN_W / 2 + 0.06, SCREEN_W / 2 - 0.06]) {
    const foot = new Mesh(new BoxGeometry(0.03, 0.02, 0.16), wood);
    foot.position.set(x, -SCREEN_H / 2 - t - 0.01, 0);
    frame.add(foot);
  }
  // Washi tape for the pinned-to-the-wall look.
  const tapeMat = new MeshBasicMaterial({ color: new Color('#d9c7a3'), transparent: true, opacity: 0.85, toneMapped: false });
  const tape = new Group();
  for (const x of [-1, 1]) {
    const strip = new Mesh(new PlaneGeometry(0.11, 0.035), tapeMat);
    strip.position.set(x * (SCREEN_W / 2 - 0.03), SCREEN_H / 2 - 0.005, 0.002);
    strip.rotation.z = x * -0.6;
    tape.add(strip);
  }
  tape.visible = false;
  root.add(tape);
  const setPinned = (on: boolean) => { frame.visible = !on; tape.visible = on; };
  return { root, paper, setPinned };
}

/** Translucent hand (joint spheres + bone cylinders) used as a pose hint. */
export class GhostHand {
  readonly root = new Group();
  private joints: InstancedMesh;
  private bones: InstancedMesh;
  private material: MeshBasicMaterial;
  private m = new Matrix4();
  private q = new Quaternion();
  private a = new Vector3();
  private b = new Vector3();
  private up = new Vector3(0, 1, 0);
  private s = new Vector3();
  private d = new Vector3();

  constructor(name = 'GhostHand', color = '#bfe6ff', solid = false) {
    this.root.name = name;
    this.material = solid
      ? new MeshStandardMaterial({ color: new Color(color), roughness: 0.75 }) as unknown as MeshBasicMaterial
      : new MeshBasicMaterial({ color: new Color(color), transparent: true, opacity: 0.0, depthWrite: false });
    this.joints = new InstancedMesh(new SphereGeometry(1, 12, 8), this.material, JOINT_COUNT);
    this.bones = new InstancedMesh(new CylinderGeometry(1, 1, 1, 10, 1, true), this.material, BONES.length);
    this.root.add(this.joints, this.bones);
    this.root.visible = false;
  }

  set opacity(v: number) {
    if (this.material.transparent) this.material.opacity = v;
    this.root.visible = v > 0.01;
  }

  /** World-space joint positions (xyz triples) and radii. */
  update(pos: Float32Array, radii: Float32Array): void {
    for (let j = 0; j < JOINT_COUNT; j++) {
      this.s.setScalar(radii[j] * 1.05);
      this.a.set(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
      this.m.compose(this.a, this.q.identity(), this.s);
      this.joints.setMatrixAt(j, this.m);
    }
    for (let k = 0; k < BONES.length; k++) {
      const [ia, ib] = BONES[k];
      this.a.set(pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2]);
      this.b.set(pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2]);
      const len = this.a.distanceTo(this.b);
      const r = (radii[ia] + radii[ib]) * 0.5;
      this.q.setFromUnitVectors(this.up, this.d.subVectors(this.b, this.a).normalize());
      this.s.set(r, len, r);
      this.a.add(this.b).multiplyScalar(0.5);
      this.m.compose(this.a, this.q, this.s);
      this.bones.setMatrixAt(k, this.m);
    }
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
  }
}

export function disposeTree(o: Object3D): void {
  o.traverse((n) => {
    const mesh = n as Mesh;
    mesh.geometry?.dispose?.();
  });
}

/**
 * Procedural stage props: the paper lantern (the light that casts every
 * shadow), the framed paper screen, and the translucent ghost hand that
 * demonstrates a pose when the player is stuck.
 */
import {
  AdditiveBlending,
  BackSide,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
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
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TextureLoader,
  TorusGeometry,
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
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,220,150,1)');
  grad.addColorStop(0.3, 'rgba(255,180,90,0.45)');
  grad.addColorStop(1, 'rgba(255,150,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

const textureLoader = new TextureLoader();
const visualTexture = (name: string) => {
  const loaded = textureLoader.load(`${import.meta.env?.BASE_URL ?? './'}textures/${name}`);
  loaded.colorSpace = SRGBColorSpace;
  return loaded;
};
const lanternPaper = visualTexture('lantern-paper.jpg');
const darkWood = visualTexture('dark-wood.jpg');
darkWood.wrapS = darkWood.wrapT = RepeatWrapping;
const ember = visualTexture('ember.png');

/** A small round paper lantern, ~9 cm tall, origin at its light centre. */
export function buildLantern(): Lantern {
  const root = new Group();
  root.name = 'Lantern';
  const profile: Vector2[] = [];
  for (let index = 0; index <= 28; index++) {
    const angle = (index / 28) * Math.PI;
    profile.push(new Vector2(0.008 + Math.pow(Math.sin(angle), 0.82) * 0.036,
      -0.045 + (1 - Math.cos(angle)) * 0.045));
  }
  const bodyMat = new MeshBasicMaterial({ color: new Color('#ffe8bc'), map: lanternPaper, toneMapped: false });
  bodyMat.onBeforeCompile = shader => {
    shader.vertexShader = `varying float vLanternFace;\nvarying float vLanternHeight;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 lanternNormal = normalize(normalMatrix * normal);
        vec3 lanternView = normalize(-(modelViewMatrix * vec4(position, 1.0)).xyz);
        vLanternFace = clamp(dot(lanternNormal, lanternView), 0.0, 1.0);
        vLanternHeight = uv.y;`);
    shader.fragmentShader = `varying float vLanternFace;\nvarying float vLanternHeight;\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', `#include <map_fragment>
        float equator = 1.0 - 0.38 * pow(abs(vLanternHeight * 2.0 - 1.0), 1.6);
        float rib = pow(0.5 + 0.5 * cos(vLanternHeight * 94.2478), 18.0);
        float rim = pow(1.0 - vLanternFace, 2.0);
        diffuseColor.rgb = diffuseColor.rgb * equator * (1.0 - 0.08 * rib)
          + vec3(0.23, 0.09, 0.02) * rim;`);
  };
  const body = new Mesh(new LatheGeometry(profile, 40), bodyMat);
  body.name = 'LanternBody';
  root.add(body);
  const ribMat = new MeshBasicMaterial({ color: new Color('#b97932'), transparent: true, opacity: 0.46 });
  for (let index = 1; index < 16; index++) {
    const y = -0.045 + (index / 16) * 0.09;
    const radius = 0.008 + Math.pow(Math.sqrt(Math.max(0, 1 - Math.pow(y / 0.045, 2))), 0.82) * 0.036 + 0.0004;
    const rib = new Mesh(new CylinderGeometry(radius, radius, 0.0012, 40, 1, true), ribMat);
    rib.position.y = y;
    root.add(rib);
  }
  const capMat = new MeshPhysicalMaterial({ color: new Color('#1e1b18'), roughness: 0.32, metalness: 0.16, clearcoat: 0.48 });
  for (const y of [-0.049, 0.049]) {
    const cap = new Mesh(new CylinderGeometry(0.016, 0.016, 0.008, 32), capMat);
    cap.position.y = y;
    root.add(cap);
  }
  const brass = new MeshPhysicalMaterial({ color: new Color('#c59e47'), metalness: 0.88, roughness: 0.23 });
  const loop = new Mesh(new TorusGeometry(0.017, 0.0012, 8, 32, Math.PI), brass);
  loop.position.y = 0.056;
  root.add(loop);
  for (const y of [-0.049, 0.049]) for (const x of [-0.010, 0.010]) {
    const rivet = new Mesh(new SphereGeometry(0.0018, 8, 6), brass);
    rivet.position.set(x, y, 0.013);
    root.add(rivet);
  }
  const halo = new Sprite(new SpriteMaterial({
    map: ember, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6,
  }));
  halo.scale.setScalar(0.26);
  root.add(halo);

  // Stand: a turned post and a round foot, scaled to reach the table top.
  const stand = new Group();
  stand.name = 'LanternStand';
  const woodMat = new MeshPhysicalMaterial({ map: darkWood, roughness: 0.54, metalness: 0.06, clearcoat: 0.22 });
  const postProfile = [
    new Vector2(0.012, -0.5), new Vector2(0.013, -0.42), new Vector2(0.008, -0.32),
    new Vector2(0.006, -0.12), new Vector2(0.010, 0.05), new Vector2(0.013, 0.2),
    new Vector2(0.009, 0.37), new Vector2(0.010, 0.5),
  ];
  const post = new Mesh(new LatheGeometry(postProfile, 24), woodMat);
  const footProfile = [
    new Vector2(0, -0.004), new Vector2(0.039, -0.004), new Vector2(0.045, -0.002),
    new Vector2(0.045, 0.002), new Vector2(0.039, 0.004), new Vector2(0, 0.004),
  ];
  const foot = new Mesh(new LatheGeometry(footProfile, 32), woodMat);
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
  const wood = new MeshPhysicalMaterial({ map: darkWood, roughness: 0.54, metalness: 0.06, clearcoat: 0.22 });
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

/**
 * Theater lights down: a large sphere around the viewer that darkens the
 * passthrough room, least in the direction of the lantern, so the real room
 * stays visible but the lantern light and the shadows carry the scene.
 */
export interface RoomDim {
  mesh: Mesh;
  update(head: Vector3, lantern: Vector3, amount: number): void;
}

export function buildRoomDim(): RoomDim {
  const material = new ShaderMaterial({
    // Drawn first in the opaque pass with explicit blending, without depth, so it
    // darkens only what is behind the scene (passthrough) and every prop draws over it.
    transparent: false,
    blending: CustomBlending,
    blendSrc: SrcAlphaFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    depthWrite: false,
    depthTest: false,
    side: BackSide,
    uniforms: {
      uHead: { value: new Vector3() },
      uLantern: { value: new Vector3(0, 0, -1) },
      uAmount: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHead;
      uniform vec3 uLantern;
      uniform float uAmount;
      varying vec3 vWorld;
      void main() {
        vec3 d = normalize(vWorld - uHead);
        vec3 l = normalize(uLantern - uHead);
        float c = dot(d, l);
        // Lightest toward the lantern and the paper beyond it, darkest behind the viewer;
        // toward the lantern the room takes a faint warm cast, as if lit by the flame.
        float toward = smoothstep(0.6, 0.98, c);
        float a = uAmount * (1.0 - 0.45 * toward);
        gl_FragColor = vec4(mix(vec3(0.012, 0.016, 0.03), vec3(0.16, 0.085, 0.025), 0.6 * smoothstep(0.75, 0.99, c)), a);
      }`,
  });
  const mesh = new Mesh(new SphereGeometry(8, 32, 16), material);
  mesh.name = 'RoomDim';
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;
  return {
    mesh,
    update(head, lantern, amount) {
      mesh.position.copy(head);
      material.uniforms.uHead.value.copy(head);
      material.uniforms.uLantern.value.copy(lantern);
      material.uniforms.uAmount.value = amount;
      mesh.visible = amount > 0.005;
    },
  };
}

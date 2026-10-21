/**
 * The filming stand-in hand: the WebXR generic hand mesh (MIT, @webxr-input-profiles/assets),
 * driven from the same 25 joint positions that cast the shadow. Joint orientations are
 * rebuilt from positions (bone along -Z, back of the hand along +Y, the WebXR joint
 * convention the mesh is rigged to). Until the mesh loads, the capsule hand stands in.
 * Only shown when no passthrough shows the player's own hands (browser preview, emulator capture).
 */
import {
  AssetManager, Color, Group, Matrix4, MeshPhysicalMaterial, Object3D, SkinnedMesh, Vector3,
} from '@iwsdk/core';
import { JOINT_COUNT, JOINT_NAMES } from '../shadow/hand-model.js';
import { GhostHand } from './stage.js';

/** The joint each joint's bone points toward; tips point away from their parent. */
const CHILD: readonly number[] = [
  11, // wrist → middle knuckle
  2, 3, 4, -3,
  6, 7, 8, 9, -8,
  11, 12, 13, 14, -13,
  16, 17, 18, 19, -18,
  21, 22, 23, 24, -23,
];
const isThumb = (joint: number) => joint >= 1 && joint <= 4;

export class SkinHand {
  readonly root = new Group();
  private fallback: GhostHand;
  private bones: (Object3D | null)[] = new Array(JOINT_COUNT).fill(null);
  private loaded = false;
  private requested = false;
  private visible = false;
  private material = new MeshPhysicalMaterial({
    color: new Color('#d8a684'), roughness: 0.62, metalness: 0, sheen: 0.5,
    sheenColor: new Color('#ffc59a'), sheenRoughness: 0.6,
  });
  private basis = new Matrix4();
  private dir = new Vector3();
  private up = new Vector3();
  private side = new Vector3();
  private across = new Vector3();
  private dorsal = new Vector3();
  private a = new Vector3();
  private b = new Vector3();
  private w = new Vector3();

  constructor(name: string, private readonly hand: 'left' | 'right') {
    this.root.name = name;
    this.fallback = new GhostHand(`${name}Capsules`, '#c99877', true);
    this.root.add(this.fallback.root);
    this.root.visible = false;
  }

  set opacity(v: number) {
    this.visible = v > 0.01;
    this.root.visible = this.visible;
    this.fallback.opacity = this.loaded ? 0 : v;
    if (this.visible && !this.requested) this.load();
  }

  private load(): void {
    this.requested = true;
    const url = `${import.meta.env?.BASE_URL ?? './'}gltf/hands/${this.hand}.glb`;
    AssetManager.loadGLTF(url).then((gltf) => {
      const scene = gltf.scene;
      scene.traverse((node) => {
        const mesh = node as SkinnedMesh;
        if (mesh.isSkinnedMesh) { mesh.material = this.material; mesh.frustumCulled = false; }
      });
      JOINT_NAMES.forEach((jointName, joint) => { this.bones[joint] = scene.getObjectByName(jointName) ?? null; });
      if (this.bones.some((bone) => !bone)) return; // keep the capsule hand
      this.root.add(scene);
      this.loaded = true;
      this.fallback.opacity = 0;
    }).catch(() => { /* keep the capsule hand */ });
  }

  /** World-space joint positions (xyz triples) and radii, as for the capsule hand. */
  update(pos: Float32Array, radii: Float32Array): void {
    if (!this.loaded) { this.fallback.update(pos, radii); return; }
    const at = (joint: number, out: Vector3) => out.set(pos[joint * 3], pos[joint * 3 + 1], pos[joint * 3 + 2]);
    // Back of the hand from the knuckle triangle; its sign depends on handedness.
    at(0, this.w); at(6, this.a); at(21, this.b);
    this.dorsal.crossVectors(this.a.sub(this.w), this.b.sub(this.w)).normalize();
    if (this.hand === 'right') this.dorsal.negate();
    at(6, this.a); at(21, this.b);
    this.across.subVectors(this.a, this.b).normalize(); // pinky → index
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      const bone = this.bones[joint]!;
      const child = CHILD[joint];
      at(joint, this.a);
      if (child >= 0) this.dir.subVectors(at(child, this.b), this.a);
      else this.dir.subVectors(this.a, at(-child, this.b));
      if (this.dir.lengthSq() < 1e-10) continue;
      this.dir.normalize();
      // The thumb is rolled toward the index side; the fingers share the back of the hand.
      if (isThumb(joint)) this.up.copy(this.dorsal).multiplyScalar(0.45).addScaledVector(this.across, 0.65);
      else this.up.copy(this.dorsal);
      this.up.addScaledVector(this.dir, -this.up.dot(this.dir));
      if (this.up.lengthSq() < 1e-8) continue;
      this.up.normalize();
      // -Z along the bone, +Y out of the back of the hand, X completes a right-handed frame.
      this.b.copy(this.dir).negate();
      this.side.crossVectors(this.up, this.b);
      this.basis.makeBasis(this.side, this.up, this.b);
      bone.position.copy(this.a);
      bone.quaternion.setFromRotationMatrix(this.basis);
    }
  }
}

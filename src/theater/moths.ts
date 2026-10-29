import { AdditiveBlending, CanvasTexture, DoubleSide, DynamicDrawUsage, Group, InstancedMesh, Mesh, MeshBasicMaterial,
  Object3D, PlaneGeometry, Shape, ShapeGeometry, SphereGeometry,
  SRGBColorSpace } from '@iwsdk/core';
import type { MothStage, MothWorld } from '../play/moths.js';

interface MothSprite {
  body: Group;
  left: Mesh;
  right: Mesh;
  paper: [Mesh, Mesh];
  materials: MeshBasicMaterial[];
}

function paperTexture(raised: boolean): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.dataset.shadowfolkMothUpload = 'paper';
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.translate(64, 64);
  context.fillStyle = '#110d14';
  for (const side of [-1, 1]) {
    context.save();
    context.scale(side, 1);
    context.beginPath();
    context.moveTo(0, 4);
    context.bezierCurveTo(raised ? 18 : 30, raised ? -44 : -21, 57, raised ? -57 : -18, 54, -1);
    context.bezierCurveTo(45, 13, 19, 26, 0, 10);
    context.fill();
    context.restore();
  }
  context.beginPath();
  context.ellipse(0, 7, 7, 22, 0, 0, Math.PI * 2);
  context.fill();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  return texture;
}

function wingGeometry(): ShapeGeometry {
  const shape = new Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(0.017, 0.031, 0.058, 0.031, 0.055, 0.005);
  shape.bezierCurveTo(0.051, -0.012, 0.029, -0.019, 0.012, -0.009);
  shape.bezierCurveTo(0.007, -0.004, 0.003, -0.004, 0, 0);
  return new ShapeGeometry(shape, 8);
}

function glowTexture(ring: boolean): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const gradient = context.createRadialGradient(32, 32, ring ? 15 : 0, 32, 32, 31);
  gradient.addColorStop(0, ring ? 'rgba(255,204,123,0)' : 'rgba(255,221,166,0.85)');
  gradient.addColorStop(0.62, 'rgba(255,186,91,0.75)');
  gradient.addColorStop(1, 'rgba(255,156,66,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  return texture;
}

export class MothView {
  readonly root = new Group();
  readonly paperRoot = new Group();
  private wing = wingGeometry();
  private bodyGeometry = new SphereGeometry(0.006, 7, 5);
  private paperGeometry = new PlaneGeometry(1, 1);
  private paperTextures: [CanvasTexture, CanvasTexture] = [paperTexture(false), paperTexture(true)];
  private sprites: MothSprite[] = [];
  private dust = new InstancedMesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
    map: glowTexture(false), transparent: true, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false,
  }), 42);
  private palms = new InstancedMesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
    map: glowTexture(true), transparent: true, depthWrite: false,
    blending: AdditiveBlending, toneMapped: false,
  }), 2);
  private particle = new Object3D();
  private palmHit = { x: 0, y: 0, z: 0, at: -Infinity };
  private cup = { x: 0, y: 0, z: 0, visible: false };

  constructor() {
    this.root.name = 'DuskMoths';
    this.paperRoot.name = 'PaperMothShadows';
    this.dust.instanceMatrix.setUsage(DynamicDrawUsage);
    this.palms.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dust.count = this.palms.count = 0;
    this.dust.frustumCulled = this.palms.frustumCulled = false;
    this.root.add(this.dust, this.palms);
    for (let index = 0; index < 8; index++) {
      const body = new Group();
      const materials: MeshBasicMaterial[] = [];
      const material = () => {
        const result = new MeshBasicMaterial({ color: '#130f16', side: DoubleSide, transparent: true,
          opacity: 0.95, depthWrite: false, toneMapped: false });
        materials.push(result);
        return result;
      };
      const left = new Mesh(this.wing, material());
      const right = new Mesh(this.wing, material());
      right.scale.x = -1;
      const middle = new Mesh(this.bodyGeometry, material());
      middle.scale.set(1, 3, 1);
      const antenna = new Mesh(this.bodyGeometry, material());
      antenna.scale.set(0.35, 1.7, 0.35);
      antenna.position.y = 0.026;
      body.add(left, right, middle, antenna);
      body.visible = false;
      this.root.add(body);
      const makePaper = (frame: number) => {
        const mesh = new Mesh(this.paperGeometry, new MeshBasicMaterial({ map: this.paperTextures[frame],
          transparent: true, depthWrite: false, toneMapped: false, opacity: 0.85, side: DoubleSide }));
        mesh.renderOrder = 8.5;
        mesh.position.z = 0.005;
        mesh.visible = false;
        this.paperRoot.add(mesh);
        return mesh;
      };
      const paper: [Mesh, Mesh] = [makePaper(0), makePaper(1)];
      this.sprites.push({ body, left, right, paper, materials });
    }
  }

  flashPalm(x: number, y: number, z: number, time: number): void {
    this.palmHit.x = x; this.palmHit.y = y; this.palmHit.z = z; this.palmHit.at = time;
  }

  cupPalm(x: number, y: number, z: number, visible: boolean): void {
    this.cup.x = x; this.cup.y = y; this.cup.z = z; this.cup.visible = visible;
  }

  update(world: MothWorld, stage: MothStage): void {
    const flame = stage.flame, paper = stage.paper, right = stage.right;
    const toPaperX = paper.x - flame.x, toPaperY = paper.y - flame.y, toPaperZ = paper.z - flame.z;
    const distanceToPaper = Math.hypot(toPaperX, toPaperY, toPaperZ);
    const forwardX = toPaperX / distanceToPaper, forwardY = toPaperY / distanceToPaper,
      forwardZ = toPaperZ / distanceToPaper;
    for (let index = 0; index < this.sprites.length; index++) {
      const agent = world.agents[index], sprite = this.sprites[index];
      const isPaper = agent.phase === 'paper';
      const isRoom = agent.phase !== 'hidden' && !isPaper;
      sprite.body.visible = isRoom && agent.opacity > 0;
      if (sprite.body.visible) {
        const peel = agent.intro && agent.phase === 'approach'
          ? Math.min(1, agent.phaseTime / 0.45) : 1;
        sprite.body.position.set(agent.x, agent.y, agent.z);
        sprite.body.lookAt(stage.head.x, stage.head.y, stage.head.z);
        sprite.body.scale.setScalar(agent.queen ? agent.phase === 'moon' ? 2.7 : 5.5
          : agent.intro ? 0.65 + 0.35 * peel : 1);
        sprite.left.rotation.y = agent.flap * 0.75;
        sprite.right.rotation.y = -agent.flap * 0.75;
        sprite.body.rotation.z = agent.phase === 'tumble' ? agent.angle : Math.sin(agent.age * 3) * 0.12;
        for (const material of sprite.materials) material.opacity = agent.opacity * 0.95 * (agent.intro ? 0.4 + 0.6 * peel : 1);
      }
      const shadow = isPaper || isRoom && agent.phase !== 'moon'
        && (agent.intro && agent.phase === 'approach' && agent.phaseTime < 0.45
          || Math.hypot(agent.x - flame.x, agent.y - flame.y, agent.z - flame.z) < 0.40);
      const frame = Math.floor(agent.age * 8) % 2;
      for (let part = 0; part < 2; part++) sprite.paper[part].visible = shadow && part === frame;
      if (!shadow) continue;
      let x = agent.paperX, y = agent.queen ? 0.06 : agent.paperY;
      if (!isPaper) {
        const along = (agent.x - flame.x) * forwardX + (agent.y - flame.y) * forwardY
          + (agent.z - flame.z) * forwardZ;
        const stretch = distanceToPaper / Math.max(0.06, along);
        const projectedX = flame.x + (agent.x - flame.x) * stretch - paper.x;
        const projectedY = flame.y + (agent.y - flame.y) * stretch - paper.y;
        const projectedZ = flame.z + (agent.z - flame.z) * stretch - paper.z;
        x = projectedX * right.x + projectedY * right.y + projectedZ * right.z;
        y = projectedY;
      }
      const size = agent.queen ? (isPaper ? 0.35 + 0.15 * Math.min(1, agent.phaseTime / 1.5) : 0.45)
        : isPaper ? agent.intro ? 0.04 + 0.06 * Math.min(1, agent.phaseTime / 2.5) : 0.09 : 0.12;
      const activePaper = sprite.paper[frame];
      activePaper.position.set(x, y, 0.005);
      activePaper.scale.set(size, size * 0.75, 1);
      (activePaper.material as MeshBasicMaterial).opacity = isPaper ? agent.opacity * (agent.queen ? 0.75 : 0.88)
        : agent.intro && agent.phase === 'approach' ? 0.88 * (1 - agent.phaseTime / 0.45) : 0.16;
    }
    let specks = 0;
    for (const agent of world.agents) {
      if (agent.phase !== 'tumble' || agent.phaseTime > 0.55) continue;
      for (let index = 0; index < 6 && specks < 42; index++) {
        const angle = index * Math.PI / 3 + agent.phaseTime * 3;
        const radius = 0.01 + agent.phaseTime * (0.10 + index % 2 * 0.04);
        this.particle.position.set(agent.x + Math.cos(angle) * radius,
          agent.y + Math.sin(angle) * radius, agent.z + 0.008);
        this.particle.lookAt(stage.head.x, stage.head.y, stage.head.z);
        const size = 0.012 * (1 - agent.phaseTime / 0.55);
        this.particle.scale.set(size, size, 1);
        this.particle.updateMatrix();
        this.dust.setMatrixAt(specks++, this.particle.matrix);
      }
    }
    this.dust.count = specks;
    this.dust.instanceMatrix.needsUpdate = specks > 0;
    let glowing = 0;
    const palmAge = world.time - this.palmHit.at;
    if (palmAge >= 0 && palmAge < 0.3) {
      this.particle.position.set(this.palmHit.x, this.palmHit.y, this.palmHit.z);
      this.particle.lookAt(stage.head.x, stage.head.y, stage.head.z);
      this.particle.scale.setScalar(0.11 * (1 - palmAge / 0.3));
      this.particle.updateMatrix();
      this.palms.setMatrixAt(glowing++, this.particle.matrix);
    }
    if (this.cup.visible) {
      this.particle.position.set(this.cup.x, this.cup.y, this.cup.z);
      this.particle.lookAt(stage.head.x, stage.head.y, stage.head.z);
      this.particle.scale.setScalar(0.105);
      this.particle.updateMatrix();
      this.palms.setMatrixAt(glowing++, this.particle.matrix);
    }
    this.palms.count = glowing;
    this.palms.instanceMatrix.needsUpdate = glowing > 0;
  }

  dispose(): void {
    this.wing.dispose();
    for (const mesh of [this.dust, this.palms]) {
      mesh.geometry.dispose(); mesh.material.map?.dispose(); mesh.material.dispose();
    }
    this.bodyGeometry.dispose();
    this.paperGeometry.dispose();
    for (const texture of this.paperTextures) texture.dispose();
    for (const sprite of this.sprites) {
      for (const material of sprite.materials) material.dispose();
      for (const paper of sprite.paper) (paper.material as MeshBasicMaterial).dispose();
    }
  }
}

import {
  CanvasTexture, Color, DynamicDrawUsage, Group, InstancedMesh, LinearFilter, Mesh, MeshBasicMaterial,
  Object3D, PlaneGeometry, SRGBColorSpace,
} from '@iwsdk/core';
import { InkField } from './ink-field.js';
import { FolkWorld } from './folk.js';

function bakedCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return [canvas, canvas.getContext('2d', { willReadFrequently: true })!];
}

function bakedTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

function folkTexture(): CanvasTexture {
  const [canvas, context] = bakedCanvas(96, 96);
  const glow = context.createRadialGradient(48, 50, 4, 48, 50, 43);
  glow.addColorStop(0, 'rgba(255,215,124,0.7)');
  glow.addColorStop(0.45, 'rgba(255,151,53,0.24)');
  glow.addColorStop(1, 'rgba(255,130,40,0)');
  context.fillStyle = glow; context.fillRect(0, 0, 96, 96);
  context.fillStyle = '#4b231c';
  context.beginPath(); context.moveTo(47, 15); context.bezierCurveTo(68, 35, 55, 43, 62, 58);
  context.bezierCurveTo(69, 79, 56, 84, 48, 82); context.bezierCurveTo(29, 86, 28, 67, 39, 54);
  context.bezierCurveTo(31, 43, 43, 33, 47, 15); context.fill();
  context.strokeStyle = '#4b231c'; context.lineWidth = 6; context.lineCap = 'round';
  context.beginPath(); context.moveTo(41, 75); context.lineTo(33, 87); context.moveTo(53, 76); context.lineTo(59, 87);
  context.moveTo(38, 54); context.lineTo(28, 68); context.moveTo(58, 52); context.lineTo(69, 65); context.stroke();
  context.fillStyle = '#ffdf9b'; context.beginPath(); context.arc(53, 48, 3, 0, Math.PI * 2); context.fill();
  return bakedTexture(canvas);
}

function particleTexture(spark: boolean): CanvasTexture {
  const [canvas, context] = bakedCanvas(48, 48);
  const gradient = context.createRadialGradient(24, 24, 1, 24, 24, 23);
  gradient.addColorStop(0, spark ? '#fff9d2' : '#5e514b');
  gradient.addColorStop(0.4, spark ? 'rgba(255,195,104,0.9)' : 'rgba(100,79,70,0.55)');
  gradient.addColorStop(1, 'rgba(130,85,52,0)');
  context.fillStyle = gradient; context.fillRect(0, 0, 48, 48);
  return bakedTexture(canvas);
}

export class PlayView {
  readonly root = new Group();
  readonly folk: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  readonly ash: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  readonly sparkle: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  readonly debugMesh: Mesh<PlaneGeometry, MeshBasicMaterial> | null;
  private readonly transform = new Object3D();
  private readonly color = new Color();
  private readonly tintBySlot = new Float64Array(48).fill(0xffe0a0);
  private readonly terrain: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private debugContext: CanvasRenderingContext2D | null = null;
  private debugPixels: ImageData | null = null;
  private debugAt = -Infinity;

  constructor(field: InkField, debug: boolean) {
    const [terrainCanvas, context] = bakedCanvas(1200, 792);
    const toX = (x: number) => (x + 0.5) * 1200;
    const toY = (y: number) => (0.33 - y) * 1200;
    context.strokeStyle = '#372318'; context.lineWidth = 6; context.lineCap = 'round';
    context.beginPath();
    context.moveTo(toX(-0.5), toY(-0.20)); context.lineTo(toX(-0.06), toY(-0.20));
    context.moveTo(toX(0.06), toY(-0.20)); context.lineTo(toX(0.30), toY(-0.20));
    context.lineTo(toX(0.30), toY(-0.10)); context.lineTo(toX(0.5), toY(-0.10));
    context.stroke();
    context.strokeStyle = '#4b2a1d'; context.lineWidth = 5;
    context.beginPath(); context.moveTo(toX(-0.48), toY(-0.20));
    context.lineTo(toX(-0.48), toY(-0.15));
    context.quadraticCurveTo(toX(-0.44), toY(-0.10), toX(-0.40), toY(-0.15));
    context.lineTo(toX(-0.40), toY(-0.20)); context.stroke();
    context.fillStyle = '#b7874b'; context.beginPath();
    context.ellipse(toX(-0.44), toY(-0.173), 7, 11, 0, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#3b241c'; context.beginPath();
    context.ellipse(toX(0.43), toY(-0.015), 43, 83, 0, Math.PI, Math.PI * 2); context.fill();
    context.fillStyle = '#b7874b'; context.beginPath();
    context.ellipse(toX(0.43), toY(-0.02), 30, 65, 0, Math.PI, Math.PI * 2); context.fill();
    context.strokeStyle = '#4b2a1d'; context.lineWidth = 5; context.beginPath();
    context.moveTo(toX(0.39), toY(-0.09)); context.lineTo(toX(0.39), toY(0.0));
    context.quadraticCurveTo(toX(0.43), toY(0.12), toX(0.47), toY(0.0));
    context.lineTo(toX(0.47), toY(-0.09)); context.stroke();
    this.terrain = new Mesh(new PlaneGeometry(1, 0.66), new MeshBasicMaterial({
      map: bakedTexture(terrainCanvas), transparent: true, depthWrite: false, toneMapped: false,
    }));
    this.terrain.position.z = 0.0022; this.terrain.renderOrder = 6;
    this.root.add(this.terrain);
    this.folk = this.instances(folkTexture(), 48, 7);
    this.ash = this.instances(particleTexture(false), 48, 8);
    this.sparkle = this.instances(particleTexture(true), 48, 9);
    if (debug) {
      const [canvas, debugContext] = bakedCanvas(field.w, field.h);
      this.debugContext = debugContext;
      this.debugPixels = debugContext.createImageData(field.w, field.h);
      this.debugMesh = new Mesh(new PlaneGeometry(field.w * field.cell, field.h * field.cell),
        new MeshBasicMaterial({ map: bakedTexture(canvas), transparent: true, opacity: 0.55,
          depthWrite: false, toneMapped: false }));
      this.debugMesh.position.set(field.x0 + field.w * field.cell * 0.5,
        field.y0 + field.h * field.cell * 0.5, 0.004);
      this.debugMesh.renderOrder = 12;
      this.root.add(this.debugMesh);
    } else this.debugMesh = null;
  }

  private instances(texture: CanvasTexture, capacity: number, order: number): InstancedMesh<PlaneGeometry, MeshBasicMaterial> {
    const mesh = new InstancedMesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false, toneMapped: false,
    }), capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    if (order === 7) {
      this.color.set('#ffe0a0');
      for (let index = 0; index < capacity; index++) mesh.setColorAt(index, this.color);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.root.add(mesh);
    return mesh;
  }

  update(world: FolkWorld, field: InkField, time: number): void {
    let visible = 0, ash = 0, sparkle = 0;
    let tintChanged = false;
    for (let index = 0; index < world.count; index++) {
      const agent = world.agents[index];
      if (agent.state === 'inactive') continue;
      const particle = agent.state === 'ash' ? this.ash : agent.state === 'home' ? this.sparkle : this.folk;
      const slot = agent.state === 'ash' ? ash++ : agent.state === 'home' ? sparkle++ : visible++;
      if (particle === this.folk && this.tintBySlot[slot] !== agent.tint) {
        this.folk.setColorAt(slot, this.color.setHex(agent.tint));
        this.tintBySlot[slot] = agent.tint;
        tintChanged = true;
      }
      const pulse = agent.state === 'walking' ? (Math.floor(time * 7 + index) % 2 ? 1 : 0.88) : 1;
      const size = agent.state === 'ash' ? 0.038 : agent.state === 'home' ? 0.029 : 0.038;
      this.transform.position.set(agent.x, agent.y + (agent.state === 'home' ? Math.sin(time * 5 + index) * 0.01 : 0), 0.003);
      this.transform.scale.set(size * agent.heading * pulse * agent.scale, size * agent.scale, 1);
      this.transform.rotation.z = agent.state === 'falling' ? Math.max(-0.45, Math.min(0.45, agent.vx * 0.3)) : 0;
      this.transform.updateMatrix();
      particle.setMatrixAt(slot, this.transform.matrix);
    }
    this.folk.count = visible; this.ash.count = ash; this.sparkle.count = sparkle;
    this.folk.instanceMatrix.needsUpdate = visible > 0;
    if (tintChanged && this.folk.instanceColor) this.folk.instanceColor.needsUpdate = true;
    this.ash.instanceMatrix.needsUpdate = ash > 0;
    this.sparkle.instanceMatrix.needsUpdate = sparkle > 0;
    if (this.debugContext && this.debugPixels && time - this.debugAt >= 0.1) {
      this.debugAt = time;
      const data = this.debugPixels.data;
      for (let row = 0; row < field.h; row++) {
        for (let column = 0; column < field.w; column++) {
          const source = row * field.w + column;
          const target = ((field.h - row - 1) * field.w + column) * 4;
          const staticInk = field.staticSolid[source] !== 0;
          const solid = field.solid[source] !== 0;
          const soft = field.soft[source] !== 0;
          data[target] = staticInk ? 35 : solid ? 25 : 130;
          data[target + 1] = staticInk ? 31 : solid ? 56 : 75;
          data[target + 2] = staticInk ? 43 : solid ? 112 : 48;
          data[target + 3] = staticInk || solid ? 210 : soft && ((row + column) & 1) ? 170 : 0;
        }
      }
      this.debugContext.putImageData(this.debugPixels, 0, 0);
      (this.debugMesh!.material.map as CanvasTexture).needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of [this.terrain, this.folk, this.ash, this.sparkle, this.debugMesh]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
  }
}

import {
  AdditiveBlending, CanvasTexture, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, LinearFilter, Mesh, MeshBasicMaterial,
  Object3D, PlaneGeometry, SRGBColorSpace,
} from '@iwsdk/core';
import { InkField } from './ink-field.js';
import { FolkWorld } from './folk.js';
import { KINDLING_CELLS, KINDLING_FOOT, KINDLING_FRAMES, kindlingAtlas, kindlingHalo } from './kindling-art.js';
import { groundLine, ledge } from '../journey/props-art.js';
import type { ScreenLevel } from './levels.js';

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
  readonly halo: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  readonly ash: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  readonly sparkle: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  readonly debugMesh: Mesh<PlaneGeometry, MeshBasicMaterial> | null;
  private readonly transform = new Object3D();
  private readonly color = new Color();
  private readonly tintBySlot = new Float64Array(48).fill(0xffe0a0);
  private readonly frames = new InstancedBufferAttribute(new Float32Array(48), 1);
  private readonly terrain: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly doorGlow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private doorHomeCount = 0;
  private doorPulseAt = -Infinity;
  private readonly field: InkField;
  private readonly terrainCanvas: HTMLCanvasElement;
  private readonly terrainContext: CanvasRenderingContext2D;
  private readonly wash: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private debugContext: CanvasRenderingContext2D | null = null;
  private debugPixels: ImageData | null = null;
  private debugAt = -Infinity;

  constructor(field: InkField, debug: boolean) {
    this.field = field;
    this.frames.setUsage(DynamicDrawUsage);
    const [terrainCanvas, context] = bakedCanvas(1200, 792);
    this.terrainCanvas = terrainCanvas;
    this.terrainContext = context;
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
    this.doorGlow = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      map: particleTexture(true), color: '#ffd49a', transparent: true, opacity: 0.16,
      blending: AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.doorGlow.position.set(0.43, -0.075, 0.0024);
    this.doorGlow.scale.set(0.13, 0.19, 1);
    this.doorGlow.renderOrder = 6.8;
    this.root.add(this.doorGlow);
    this.wash = new Mesh(new PlaneGeometry(1, 0.66), new MeshBasicMaterial({
      color: '#2b211c', transparent: true, opacity: 0.94, depthWrite: false, toneMapped: false,
    }));
    this.wash.position.z = 0.006;
    this.wash.renderOrder = 13;
    this.wash.visible = false;
    this.root.add(this.wash);
    this.halo = this.instances(kindlingHalo(), 48, 6.5);
    this.halo.material.blending = AdditiveBlending;
    this.halo.geometry.scale(0.085 / 0.067, 0.085 / 0.067, 1);
    this.halo.geometry.translate(0, 0, -0.0002);
    const atlas = kindlingAtlas();
    atlas.repeat.set(1 / KINDLING_CELLS, 1);
    this.folk = this.instances(atlas, 48, 7);
    this.halo.instanceMatrix = this.folk.instanceMatrix;
    this.folk.geometry.setAttribute('instanceFrame', this.frames);
    this.folk.material.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute float instanceFrame;\n${shader.vertexShader}`
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n vMapUv.x += instanceFrame / ${KINDLING_CELLS}.0;`);
    };
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

  setLevel(level: ScreenLevel): void {
    this.doorHomeCount = 0;
    this.doorPulseAt = -Infinity;
    const context = this.terrainContext;
    context.clearRect(0, 0, this.terrainCanvas.width, this.terrainCanvas.height);
    const toX = (x: number) => (x + 0.5) * 1200;
    const toY = (y: number) => (0.33 - y) * 1200;
    const gaps = level.hazards.filter((hazard) => hazard.kind === 'gap' || hazard.kind === 'river')
      .map((hazard) => {
        const reach = hazard.width * 0.5 + (hazard.kind === 'river' ? 0.06 : 0);
        return [toX(hazard.x - reach), toX(hazard.x + reach)] as const;
      });
    context.globalAlpha = 0.34;
    context.drawImage(groundLine(1200, gaps), 0, toY(-0.2) - 38);
    for (const hazard of level.hazards) {
      const x = toX(hazard.x), width = hazard.width * 1200;
      if (hazard.kind === 'ledge' || hazard.kind === 'highLedge') {
        const rise = hazard.kind === 'highLedge' ? 0.16 : 0.09;
        context.drawImage(ledge(rise), x - width / 2, toY(-0.2 + rise) - 8, width, rise * 1200 + 18);
      }
    }
    context.globalAlpha = 1;
    for (const hazard of level.hazards) {
      if (hazard.kind !== 'gap') continue;
      const left = toX(hazard.x - hazard.width * 0.5);
      const right = toX(hazard.x + hazard.width * 0.5);
      const edgeY = toY(-0.2);
      const fall = context.createLinearGradient(0, edgeY + 4, 0, edgeY + 66);
      fall.addColorStop(0, 'rgba(59,40,32,0.25)');
      fall.addColorStop(1, 'rgba(59,40,32,0)');
      context.fillStyle = fall;
      context.beginPath();
      context.ellipse((left + right) * 0.5, edgeY + 31, (right - left) * 0.52, 30, 0, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = 'rgba(77,45,29,0.66)';
      context.lineWidth = 3.5;
      for (const [edge, direction] of [[left, 1], [right, -1]] as const) {
        context.beginPath();
        context.moveTo(edge - direction * 9, edgeY - 3);
        context.quadraticCurveTo(edge + direction * 6, edgeY + 3, edge + direction * 2, edgeY + 14);
        context.bezierCurveTo(edge - direction * 2, edgeY + 25, edge + direction * 15, edgeY + 40,
          edge + direction * 10, edgeY + 51);
        context.stroke();
      }
      context.fillStyle = 'rgba(69,46,32,0.35)';
      for (let pebble = 0; pebble < 5; pebble++) {
        const pebbleX = left + (pebble + 0.5) * (right - left) / 5;
        const pebbleY = edgeY + 32 + (pebble * 17 % 24);
        context.beginPath();
        context.ellipse(pebbleX, pebbleY, 2 + pebble % 2, 1.3, 0, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.strokeStyle = '#704d34'; context.lineWidth = 3;
    context.beginPath(); context.moveTo(toX(-0.48), toY(-0.2));
    context.lineTo(toX(-0.48), toY(-0.15)); context.quadraticCurveTo(toX(-0.44), toY(-0.1), toX(-0.40), toY(-0.15));
    context.lineTo(toX(-0.40), toY(-0.2)); context.stroke();
    context.fillStyle = '#c39966'; context.beginPath();
    context.ellipse(toX(-0.44), toY(-0.173), 7, 11, 0, 0, Math.PI * 2); context.fill();
    const doorLight = context.createRadialGradient(toX(0.43), toY(-0.055), 4, toX(0.43), toY(-0.055), 91);
    doorLight.addColorStop(0, 'rgba(255,230,172,0.48)');
    doorLight.addColorStop(1, 'rgba(255,197,112,0)');
    context.fillStyle = doorLight;
    context.fillRect(toX(0.43) - 91, toY(-0.055) - 91, 182, 182);
    context.fillStyle = '#704b35'; context.beginPath();
    context.ellipse(toX(0.43), toY(-0.015), 43, 83, 0, Math.PI, Math.PI * 2); context.fill();
    context.fillStyle = '#efc98c'; context.beginPath();
    context.ellipse(toX(0.43), toY(-0.02), 30, 65, 0, Math.PI, Math.PI * 2); context.fill();
    this.terrain.material.map!.needsUpdate = true;
  }

  setWash(amount: number): void {
    this.wash.visible = amount > 0;
    this.wash.scale.x = Math.max(0.001, Math.min(1, amount));
    this.wash.position.x = -0.5 + this.wash.scale.x * 0.5;
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
    if (world.homeCount > this.doorHomeCount) this.doorPulseAt = time;
    this.doorHomeCount = world.homeCount;
    const doorPulse = Math.max(0, 1 - (time - this.doorPulseAt) / 0.7);
    this.doorGlow.material.opacity = 0.15 + doorPulse * 0.48;
    this.doorGlow.scale.set(0.13 + doorPulse * 0.07, 0.19 + doorPulse * 0.08, 1);
    let visible = 0, ash = 0, sparkle = 0;
    let tintChanged = false;
    for (let index = 0; index < world.count; index++) {
      const agent = world.agents[index];
      if (agent.state === 'inactive' || agent.state === 'home' && agent.homeAge >= 0.6) continue;
      const particle = agent.state === 'ash' ? this.ash : agent.state === 'home' && agent.homeAge >= 0.25
        ? this.sparkle : this.folk;
      const slot = particle === this.ash ? ash++ : particle === this.sparkle ? sparkle++ : visible++;
      if (particle === this.folk && this.tintBySlot[slot] !== agent.tint) {
        this.folk.setColorAt(slot, this.color.setHex(agent.tint));
        this.tintBySlot[slot] = agent.tint;
        tintChanged = true;
      }
      if (particle === this.folk) {
        const leftCell = field.index(agent.x - 0.08, agent.y + 0.05);
        const midCell = field.index(agent.x, agent.y + 0.05);
        const rightCell = field.index(agent.x + 0.08, agent.y + 0.05);
        const wickNearHand = agent.isWick && (leftCell >= 0 && field.solid[leftCell] !== 0
          || midCell >= 0 && field.solid[midCell] !== 0 || rightCell >= 0 && field.solid[rightCell] !== 0);
        this.frames.setX(slot, agent.state === 'home' ? KINDLING_FRAMES.cheer
          : agent.state === 'falling' ? KINDLING_FRAMES.fall
          : wickNearHand ? KINDLING_FRAMES.wave
            : KINDLING_FRAMES.walk[Math.floor(time * 7 + index) & 3]);
      }
      const pulse = agent.state === 'walking' ? (Math.floor(time * 7 + index) % 2 ? 1 : 0.88) : 1;
      const size = agent.state === 'ash' ? 0.038 : agent.state === 'home' ? 0.029 : 0.067;
      const arrival = agent.state === 'home' ? Math.min(1, agent.homeAge / 0.6) : 0;
      this.transform.position.set(agent.x - Math.sin(arrival * Math.PI) * 0.035,
        agent.y + (particle === this.folk ? size * (0.5 - KINDLING_FOOT) - 0.011 : 0)
          + (agent.state === 'home' ? (0.25 - agent.y) * arrival + Math.sin(arrival * Math.PI) * 0.06 : 0), 0.003);
      this.transform.scale.set(size * agent.heading * pulse * agent.scale, size * agent.scale, 1);
      this.transform.rotation.z = agent.state === 'falling' ? Math.max(-0.45, Math.min(0.45, agent.vx * 0.3)) : 0;
      this.transform.updateMatrix();
      particle.setMatrixAt(slot, this.transform.matrix);
    }
    this.folk.count = this.halo.count = visible; this.ash.count = ash; this.sparkle.count = sparkle;
    this.folk.instanceMatrix.needsUpdate = visible > 0;
    this.frames.needsUpdate = visible > 0;
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
    for (const mesh of [this.terrain, this.doorGlow, this.wash, this.folk, this.halo, this.ash, this.sparkle, this.debugMesh]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
  }
}

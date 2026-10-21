/**
 * The wall behind the theater. The lantern's light spills past the paper
 * onto the real wall, and every creature the player has ever woken walks off
 * the paper and settles there as a shadow with glowing eyes. The collection
 * lives in the room and grows night after night.
 */
import {
  AdditiveBlending, CanvasTexture, DynamicDrawUsage, Group, InstancedMesh, LinearFilter, Matrix4, Mesh, MeshBasicMaterial,
  Object3D, PlaneGeometry, SRGBColorSpace, Vector3,
} from '@iwsdk/core';
import type { Stencil } from './painter.js';
import { WallFit, wallClearance } from './room.js';

const PX = 170; // canvas px per wall metre
const MAX_W = 3.4, MAX_H = 2.4; // metres
const LEAP_TIME = 1.7;

interface Resident {
  id: string;
  st: Stencil;
  x: number; y: number; // wall-local metres
  seed: number;
}

interface Leaper {
  r: Resident;
  fx: number; fy: number;
  fromScale: number;
  t0: number;
}

interface WallInk { ink: CanvasTexture; eyes: CanvasTexture }
interface WallSprite {
  group: Group;
  ink: Mesh<PlaneGeometry, MeshBasicMaterial>;
  eyesOpen: Mesh<PlaneGeometry, MeshBasicMaterial>;
  eyesBlink: Mesh<PlaneGeometry, MeshBasicMaterial>;
  stencil: Stencil | null;
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class WallLayer {
  readonly root = new Group();
  private frame = new Group();
  private mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private bg = document.createElement('canvas');
  private texture = new CanvasTexture(this.bg);
  private inkGeometry = new PlaneGeometry(1, 1);
  private eyeOpenGeometry = new PlaneGeometry(1, 1);
  private eyeBlinkGeometry = new PlaneGeometry(1, 1);
  private sprites: WallSprite[] = [];
  private leapSprite: WallSprite;
  private fit: WallFit | null = null;
  private x0 = 0; private y1 = 0; private wM = 1; private hM = 1;
  private cx = 0; private cy = 0;
  private residents: Resident[] = [];
  private cooldownUntil = new Map<string, number>();
  private slots: [number, number][] = [];
  private leaper: Leaper | null = null;
  private start: [number, number] = [0, 0];
  private startScale = 1;
  private celebrate = 0;
  private eyePulse = 0;
  /** Woken shadows grow with the wall's distance behind the paper. */
  private scale = 1;
  private soft = new Map<Stencil, WallInk>();
  private fireflies: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  private fireflyCount = 0;
  private fireflyArrivalFrom = 0;
  private fireflyArrivalAt = -Infinity;
  private fireflyTransform = new Object3D();
  private v = new Vector3();
  private w = new Vector3();
  private basis = new Matrix4();

  constructor() {
    this.root.name = 'WallShadows';
    this.bg.dataset.shadowfolkWallUpload = 'background';
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = -1;
    this.frame.add(this.mesh);
    const glow = document.createElement('canvas');
    glow.width = glow.height = 48;
    const glowContext = glow.getContext('2d', { willReadFrequently: true })!;
    const glowGradient = glowContext.createRadialGradient(24, 24, 1, 24, 24, 23);
    glowGradient.addColorStop(0, '#fff9dd');
    glowGradient.addColorStop(0.28, 'rgba(255,207,101,0.9)');
    glowGradient.addColorStop(1, 'rgba(255,150,50,0)');
    glowContext.fillStyle = glowGradient;
    glowContext.fillRect(0, 0, 48, 48);
    const glowTexture = new CanvasTexture(glow);
    glowTexture.colorSpace = SRGBColorSpace;
    glowTexture.generateMipmaps = false;
    this.fireflies = new InstancedMesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      map: glowTexture, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false,
    }), 160);
    this.fireflies.instanceMatrix.setUsage(DynamicDrawUsage);
    this.fireflies.count = 0;
    this.fireflies.frustumCulled = false;
    this.fireflies.renderOrder = 6;
    this.frame.add(this.fireflies);
    this.root.add(this.frame);
    for (let index = 0; index < 4; index++) {
      this.eyeOpenGeometry.attributes.uv.setX(index, this.eyeOpenGeometry.attributes.uv.getX(index) * 0.5);
      this.eyeBlinkGeometry.attributes.uv.setX(index, 0.5 + this.eyeBlinkGeometry.attributes.uv.getX(index) * 0.5);
    }
    this.leapSprite = this.makeSprite(3);
    this.root.visible = false;
  }

  private makeSprite(order: number): WallSprite {
    const group = new Group();
    const material = () => new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    const ink = new Mesh(this.inkGeometry, material());
    const eyesOpen = new Mesh(this.eyeOpenGeometry, material());
    const eyesBlink = new Mesh(this.eyeBlinkGeometry, material());
    ink.position.z = 0.0004;
    eyesOpen.position.z = eyesBlink.position.z = 0.0008;
    ink.renderOrder = order;
    eyesOpen.renderOrder = eyesBlink.renderOrder = order + 1;
    ink.material.opacity = 0.78;
    eyesOpen.material.opacity = eyesBlink.material.opacity = 0;
    group.add(ink, eyesOpen, eyesBlink);
    group.visible = false;
    this.frame.add(group);
    return { group, ink, eyesOpen, eyesBlink, stencil: null };
  }

  private setStencil(sprite: WallSprite, stencil: Stencil): void {
    if (sprite.stencil === stencil) return;
    const textures = this.softInk(stencil);
    sprite.ink.material.map = textures.ink;
    sprite.eyesOpen.material.map = textures.eyes;
    sprite.eyesBlink.material.map = textures.eyes;
    sprite.ink.material.needsUpdate = true;
    sprite.eyesOpen.material.needsUpdate = true;
    sprite.eyesBlink.material.needsUpdate = true;
    sprite.stencil = stencil;
  }

  /** Called when a leaping shadow reaches its place on the wall. */
  onSettle?: () => void;

  get active(): boolean { return this.fit !== null; }

  setLight(level: number): void {
    this.mesh.material.opacity = Math.max(0, Math.min(1, level));
    this.fireflies.material.opacity = Math.max(0.15, Math.min(1, level));
  }

  setFireflies(count: number, time = -Infinity): void {
    if (count > this.fireflyCount && Number.isFinite(time)) {
      this.fireflyArrivalFrom = this.fireflyCount;
      this.fireflyArrivalAt = time;
    }
    this.fireflyCount = Math.max(0, Math.floor(count));
    this.fireflies.count = Math.min(160, this.fireflyCount);
  }

  /** Wall-local coordinates of the ray from `from` through `through` (null if it misses). */
  private onWall(from: Vector3, through: Vector3, out: [number, number]): boolean {
    const f = this.fit!;
    const d = this.v.subVectors(through, from);
    const denom = d.dot(f.normal);
    if (Math.abs(denom) < 1e-4) return false;
    const t = this.w.subVectors(f.point, from).dot(f.normal) / denom;
    if (t <= 0) return false;
    const hx = from.x + d.x * t - f.point.x, hy = from.y + d.y * t - f.point.y, hz = from.z + d.z * t - f.point.z;
    out[0] = hx * f.right.x + hy * f.right.y + hz * f.right.z;
    out[1] = hx * f.up.x + hy * f.up.y + hz * f.up.z;
    return true;
  }

  /**
   * Lay the wall out for the current stage. `corners` are the paper's four
   * world corners (TL, TR, BR, BL), `exit` the point where creatures leave
   * the paper, seen from the head.
   */
  layout(
    fit: WallFit | null, lantern: Vector3, head: Vector3, corners: Vector3[], exit: Vector3, exitScale: number,
    count: number, cell: { w: number; h: number } = { w: 0.3, h: 0.25 },
  ): void {
    this.fit = fit;
    this.leaper = null;
    if (!fit) { this.root.visible = false; return; }
    const shadow: [number, number][] = [], view: [number, number][] = [];
    for (const c of corners) {
      const a: [number, number] = [0, 0], b: [number, number] = [0, 0];
      if (this.onWall(lantern, c, a)) shadow.push(a);
      if (this.onWall(head, c, b)) view.push(b);
    }
    if (view.length < 4 || !this.onWall(head, exit, this.start)) { this.fit = null; this.root.visible = false; return; }
    // How big a paper-sized shape looks once it reaches the wall, seen from the head.
    const dHead = this.v.subVectors(fit.point, head).length();
    const dExit = this.w.subVectors(exit, head).length();
    this.startScale = exitScale * (dHead / Math.max(0.2, dExit));
    const vMinX = Math.min(...view.map((p) => p[0])), vMaxX = Math.max(...view.map((p) => p[0]));
    const vMaxY = Math.max(...view.map((p) => p[1]));
    const vMidY = view.reduce((s, p) => s + p[1], 0) / view.length;

    // Slots: a frieze above the paper as seen from the seat, then columns beside it.
    this.scale = 1 + Math.min(0.3, fit.distance * 0.25);
    const cand: [number, number][] = [];
    const sx = cell.w * this.scale * 0.92, sy = cell.h * this.scale * 0.95;
    for (let row = 0; row < 2; row++) {
      const y = vMaxY + 0.04 + sy / 2 + row * sy;
      for (let k = 0; k < 7; k++) {
        const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * sx;
        cand.push([(vMinX + vMaxX) / 2 + off, y]);
      }
    }
    for (let k = 0; k < 3; k++) {
      cand.push([vMaxX + 0.04 + sx / 2, vMidY + 0.15 - k * sy], [vMinX - 0.04 - sx / 2, vMidY + 0.15 - k * sy]);
    }
    this.slots = cand.filter(([x, y]) => wallClearance(fit, x, y) > 0.12).slice(0, Math.max(count, 1) + 4);

    // Canvas bounds: the paper's shadow and glow, the exit point, all slots.
    let minX = Math.min(this.start[0], vMinX) - 0.35, maxX = Math.max(this.start[0], vMaxX) + 0.35;
    let minY = Math.min(this.start[1], ...view.map((p) => p[1])) - 0.3;
    let maxY = vMaxY + 0.3;
    for (const [x, y] of this.slots) {
      minX = Math.min(minX, x - 0.3); maxX = Math.max(maxX, x + 0.3);
      minY = Math.min(minY, y - 0.25); maxY = Math.max(maxY, y + 0.25);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    this.cx = cx; this.cy = cy;
    this.wM = Math.min(MAX_W, maxX - minX); this.hM = Math.min(MAX_H, maxY - minY);
    this.x0 = cx - this.wM / 2; this.y1 = cy + this.hM / 2;
    this.bg.width = Math.ceil(this.wM * PX);
    this.bg.height = Math.ceil(this.hM * PX);

    // Mesh sits 8 mm in front of the wall, spanning the canvas bounds.
    const o = this.v.copy(fit.point).addScaledVector(fit.right, cx).addScaledVector(fit.up, cy).addScaledVector(fit.normal, 0.008);
    this.frame.position.copy(o);
    this.frame.quaternion.setFromRotationMatrix(this.basis.makeBasis(fit.right, fit.up, fit.normal));
    this.mesh.scale.set(this.wM, this.hM, 1);

    // Background: lantern light pooling on the wall, the paper's own shadow inside it.
    const g = this.bg.getContext('2d', { willReadFrequently: true })!;
    g.clearRect(0, 0, this.bg.width, this.bg.height);
    const beamX = shadow.length === 4 ? shadow.reduce((sum, point) => sum + point[0], 0) / 4 : 0;
    const beamY = shadow.length === 4 ? shadow.reduce((sum, point) => sum + point[1], 0) / 4 : 0;
    const [gx, gy] = this.toPx(beamX, beamY - 0.04);
    const wash = g.createImageData(this.bg.width, this.bg.height);
    const width = this.bg.width, height = this.bg.height;
    for (let row = 0; row < height; row++) {
      const vertical = (row - gy) / (PX * 0.8);
      const lowerGain = 1 + 0.1 * Math.max(-1, Math.min(1, vertical));
      const fadeY = Math.min(1, row / (PX * 0.28), (height - 1 - row) / (PX * 0.28));
      for (let column = 0; column < width; column++) {
        const horizontal = (column - gx) / (PX * 1.2);
        const falloff = Math.max(0, Math.exp(-0.45 * (horizontal * horizontal + vertical * vertical)) - 0.025);
        const fadeX = Math.min(1, column / (PX * 0.28), (width - 1 - column) / (PX * 0.28));
        const edge = Math.min(fadeX, fadeY);
        const alpha = 0.65 * falloff * lowerGain * edge * edge * (3 - 2 * edge);
        const pixel = (row * width + column) * 4;
        wash.data[pixel] = 247;
        wash.data[pixel + 1] = 155;
        wash.data[pixel + 2] = 64;
        wash.data[pixel + 3] = alpha * 255;
      }
    }
    g.putImageData(wash, 0, 0);
    if (shadow.length === 4) {
      g.filter = 'blur(10px)';
      g.fillStyle = 'rgba(18,10,8,0.32)';
      g.beginPath();
      shadow.forEach(([x, y], k) => { const [px, py] = this.toPx(x, y); if (k) g.lineTo(px, py); else g.moveTo(px, py); });
      g.closePath();
      g.fill();
      g.filter = 'none';
    }
    this.texture.needsUpdate = true;
    this.root.visible = true;
  }

  private toPx(x: number, y: number): [number, number] {
    return [(x - this.x0) * PX, (this.y1 - y) * PX];
  }

  /** Everyone already woken on earlier nights, in the order they first woke. */
  setResidents(list: { id: string; st: Stencil }[]): void {
    this.residents = [];
    list.forEach(({ id, st }, k) => {
      const slot = this.slots[k];
      if (!slot) return;
      this.residents.push({ id, st, x: slot[0], y: slot[1], seed: k * 1.37 });
      const sprite = this.sprites[k] ?? (this.sprites[k] = this.makeSprite(0));
      this.setStencil(sprite, st);
    });
    for (let index = this.residents.length; index < this.sprites.length; index++) this.sprites[index].group.visible = false;
  }

  has(id: string): boolean { return this.residents.some((r) => r.id === id); }

  setSummonCooldown(id: string, until: number): void { this.cooldownUntil.set(id, until); }

  /** A freshly woken creature steps off the paper and finds its place on the wall. */
  leap(id: string, st: Stencil, time: number): boolean {
    if (!this.fit) return false;
    let r = this.residents.find((q) => q.id === id);
    if (!r) {
      const slot = this.slots[this.residents.length];
      if (!slot) return false;
      r = { id, st, x: slot[0], y: slot[1], seed: this.residents.length * 1.37 };
      this.residents.push(r);
      const index = this.residents.length - 1;
      const sprite = this.sprites[index] ?? (this.sprites[index] = this.makeSprite(0));
      this.setStencil(sprite, st);
    }
    this.setStencil(this.leapSprite, r.st);
    this.leaper = { r, fx: this.start[0], fy: this.start[1], fromScale: this.startScale, t0: time };
    return true;
  }

  /** Finale: the whole wall wakes up for a moment. */
  cheer(level: number, eyePulse = 0): void {
    this.celebrate = level;
    this.eyePulse = eyePulse;
  }

  update(time: number): void {
    if (!this.fit) return;
    for (let index = 0; index < this.fireflies.count; index++) {
      const spreadX = ((Math.imul(index + 1, 1664525) >>> 0) / 4294967296 - 0.5) * this.wM * 0.85;
      const spreadY = ((Math.imul(index + 7, 22695477) >>> 0) / 4294967296 - 0.5) * this.hM * 0.72;
      const destinationX = spreadX + 0.022 * Math.sin(time * 0.9 + index * 1.71);
      const destinationY = spreadY + 0.018 * Math.sin(time * 1.2 + index * 2.31);
      const arrival = index >= this.fireflyArrivalFrom
        ? ease((time - this.fireflyArrivalAt - (index - this.fireflyArrivalFrom) * 0.035) / 1.7) : 1;
      const x = this.start[0] - this.cx + (destinationX - (this.start[0] - this.cx)) * arrival;
      const y = this.start[1] - this.cy + (destinationY - (this.start[1] - this.cy)) * arrival
        + Math.sin(arrival * Math.PI) * 0.16;
      const size = 0.018 + 0.009 * (0.5 + 0.5 * Math.sin(time * 4 + index * 3.7));
      this.fireflyTransform.position.set(x, y, 0.003);
      this.fireflyTransform.scale.set(size, size, 1);
      this.fireflyTransform.updateMatrix();
      this.fireflies.setMatrixAt(index, this.fireflyTransform.matrix);
    }
    this.fireflies.instanceMatrix.needsUpdate = this.fireflies.count > 0;
    let leaper = this.leaper;
    if (leaper && time - leaper.t0 >= LEAP_TIME) {
      this.leaper = leaper = null;
      this.leapSprite.group.visible = false;
      this.onSettle?.();
    }
    for (let index = 0; index < this.residents.length; index++) {
      const r = this.residents[index];
      const sprite = this.sprites[index];
      if (leaper?.r === r) { sprite.group.visible = false; continue; }
      const hop = this.celebrate * Math.abs(Math.sin(time * 4 + r.seed * 3)) * 0.05;
      this.placeSprite(sprite, r.x, r.y + hop, this.scale, 0, time, r.seed);
      if (time < (this.cooldownUntil.get(r.id) ?? 0)) {
        sprite.eyesOpen.material.opacity *= 0.2;
        sprite.eyesBlink.material.opacity *= 0.2;
      }
    }
    if (leaper) {
      const k = (time - leaper.t0) / LEAP_TIME;
      const e = ease(k);
      const x = leaper.fx + (leaper.r.x - leaper.fx) * e;
      const arc = Math.sin(Math.PI * e) * 0.28 + Math.abs(Math.sin(k * Math.PI * 3)) * 0.04 * (1 - e);
      const y = leaper.fy + (leaper.r.y - leaper.fy) * e + arc;
      const s = leaper.fromScale + (this.scale - leaper.fromScale) * e;
      this.placeSprite(this.leapSprite, x, y, s, Math.sin(k * Math.PI * 2) * 0.12, time, leaper.r.seed);
    }
    else this.leapSprite.group.visible = false;
  }

  /** Ink and both eye states are baked once, then only sprite transforms change. */
  private softInk(st: Stencil): WallInk {
    let cached = this.soft.get(st);
    if (cached) return cached;
    const ink = document.createElement('canvas');
    ink.width = st.ink.width;
    ink.height = st.ink.height;
    ink.dataset.shadowfolkWallUpload = 'sprite';
    const inkContext = ink.getContext('2d', { willReadFrequently: true })!;
    inkContext.filter = 'blur(4px)';
    inkContext.drawImage(st.ink, 0, 0);
    const eyes = document.createElement('canvas');
    eyes.width = st.ink.width * 2;
    eyes.height = st.ink.height;
    eyes.dataset.shadowfolkWallUpload = 'sprite';
    const eyeContext = eyes.getContext('2d', { willReadFrequently: true })!;
    for (const [u, v] of st.eyes) {
      for (let blink = 0; blink < 2; blink++) {
        const x = (u + blink) * st.ink.width;
        const y = v * st.ink.height;
        const glow = eyeContext.createRadialGradient(x, y, 0, x, y, 9);
        glow.addColorStop(0, '#ffd9a0');
        glow.addColorStop(0.35, 'rgba(217,143,63,0.85)');
        glow.addColorStop(1, 'rgba(217,143,63,0)');
        eyeContext.fillStyle = glow;
        eyeContext.beginPath();
        eyeContext.ellipse(x, y, blink ? 6 : 9, blink ? 1.8 : 9, 0, 0, Math.PI * 2);
        eyeContext.fill();
        if (!blink) {
          eyeContext.fillStyle = '#ffd985';
          eyeContext.beginPath();
          eyeContext.arc(x, y, 2.3, 0, Math.PI * 2);
          eyeContext.fill();
          eyeContext.fillStyle = '#fff';
          eyeContext.fillRect(x - 1, y - 1.5, 1, 1);
        }
      }
    }
    const makeTexture = (source: HTMLCanvasElement): CanvasTexture => {
      const result = new CanvasTexture(source);
      result.colorSpace = SRGBColorSpace;
      result.generateMipmaps = false;
      result.minFilter = LinearFilter;
      result.magFilter = LinearFilter;
      return result;
    };
    cached = { ink: makeTexture(ink), eyes: makeTexture(eyes) };
    this.soft.set(st, cached);
    return cached;
  }

  private placeSprite(sprite: WallSprite, x: number, y: number, scale: number, rot: number, time: number, seed: number): void {
    const stencil = sprite.stencil!;
    sprite.group.position.set(x - this.cx, y - this.cy, 0);
    sprite.group.rotation.z = -rot;
    sprite.group.scale.set(stencil.w * scale, stencil.h * scale, 1);
    const blink = Math.sin(time * 0.7 + seed * 5.1) > 0.985;
    const brightness = 1 + 1.1 * this.eyePulse;
    sprite.eyesOpen.material.color.setScalar(brightness);
    sprite.eyesBlink.material.color.setScalar(brightness);
    sprite.eyesOpen.scale.setScalar(1 + 0.16 * this.eyePulse);
    sprite.eyesBlink.scale.setScalar(1 + 0.16 * this.eyePulse);
    sprite.eyesOpen.material.opacity = blink ? 0 : 0.95;
    sprite.eyesBlink.material.opacity = blink ? 0.95 : 0;
    sprite.group.visible = true;
  }
}

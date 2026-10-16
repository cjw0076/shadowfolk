/**
 * The wall behind the theater. The lantern's light spills past the paper
 * onto the real wall, and every creature the player has ever woken walks off
 * the paper and settles there as a shadow with glowing eyes. The collection
 * lives in the room and grows night after night.
 */
import {
  CanvasTexture, Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3,
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

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class WallLayer {
  readonly root = new Group();
  private mesh: Mesh;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private bg = document.createElement('canvas');
  private texture = new CanvasTexture(this.canvas);
  private fit: WallFit | null = null;
  private x0 = 0; private y1 = 0; private wM = 1; private hM = 1;
  private residents: Resident[] = [];
  private slots: [number, number][] = [];
  private leaper: Leaper | null = null;
  private start: [number, number] = [0, 0];
  private startScale = 1;
  private lastDraw = -1;
  private dirty = true;
  private celebrate = 0;
  /** Woken shadows grow with the wall's distance behind the paper. */
  private scale = 1;
  private soft = new Map<Stencil, HTMLCanvasElement>();
  private v = new Vector3();
  private w = new Vector3();
  private basis = new Matrix4();

  constructor() {
    this.root.name = 'WallShadows';
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = -1;
    this.root.add(this.mesh);
    this.root.visible = false;
  }

  /** Called when a leaping shadow reaches its place on the wall. */
  onSettle?: () => void;

  get active(): boolean { return this.fit !== null; }

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
    this.wM = Math.min(MAX_W, maxX - minX); this.hM = Math.min(MAX_H, maxY - minY);
    this.x0 = cx - this.wM / 2; this.y1 = cy + this.hM / 2;
    this.canvas.width = this.bg.width = Math.ceil(this.wM * PX);
    this.canvas.height = this.bg.height = Math.ceil(this.hM * PX);
    this.texture.dispose();

    // Mesh sits 8 mm in front of the wall, spanning the canvas bounds.
    const o = this.v.copy(fit.point).addScaledVector(fit.right, cx).addScaledVector(fit.up, cy).addScaledVector(fit.normal, 0.008);
    this.mesh.position.copy(o);
    this.mesh.scale.set(this.wM, this.hM, 1);
    this.mesh.quaternion.setFromRotationMatrix(this.basis.makeBasis(fit.right, fit.up, fit.normal));

    // Background: lantern light pooling on the wall, the paper's own shadow inside it.
    const g = this.bg.getContext('2d')!;
    g.clearRect(0, 0, this.bg.width, this.bg.height);
    const [gx, gy] = this.toPx(0, 0);
    const pool = g.createRadialGradient(gx, gy, 10, gx, gy, PX * 1.5);
    pool.addColorStop(0, 'rgba(255,196,120,0.22)');
    pool.addColorStop(0.5, 'rgba(255,170,90,0.10)');
    pool.addColorStop(1, 'rgba(255,150,70,0)');
    g.fillStyle = pool;
    g.fillRect(0, 0, this.bg.width, this.bg.height);
    if (shadow.length === 4) {
      g.filter = 'blur(10px)';
      g.fillStyle = 'rgba(18,10,8,0.32)';
      g.beginPath();
      shadow.forEach(([x, y], k) => { const [px, py] = this.toPx(x, y); if (k) g.lineTo(px, py); else g.moveTo(px, py); });
      g.closePath();
      g.fill();
      g.filter = 'none';
    }
    this.root.visible = true;
    this.dirty = true;
  }

  private toPx(x: number, y: number): [number, number] {
    return [(x - this.x0) * PX, (this.y1 - y) * PX];
  }

  /** Everyone already woken on earlier nights, in the order they first woke. */
  setResidents(list: { id: string; st: Stencil }[]): void {
    this.residents = [];
    list.forEach(({ id, st }, k) => {
      const slot = this.slots[k];
      if (slot) this.residents.push({ id, st, x: slot[0], y: slot[1], seed: k * 1.37 });
    });
    this.dirty = true;
  }

  has(id: string): boolean { return this.residents.some((r) => r.id === id); }

  /** A freshly woken creature steps off the paper and finds its place on the wall. */
  leap(id: string, st: Stencil, time: number): boolean {
    if (!this.fit) return false;
    let r = this.residents.find((q) => q.id === id);
    if (!r) {
      const slot = this.slots[this.residents.length];
      if (!slot) return false;
      r = { id, st, x: slot[0], y: slot[1], seed: this.residents.length * 1.37 };
      this.residents.push(r);
    }
    this.leaper = { r, fx: this.start[0], fy: this.start[1], fromScale: this.startScale, t0: time };
    return true;
  }

  /** Finale: the whole wall wakes up for a moment. */
  cheer(level: number): void { this.celebrate = level; this.dirty = true; }

  update(time: number): void {
    if (!this.fit) return;
    const animating = this.leaper !== null || this.celebrate > 0;
    // Redraw at ~30 Hz while something moves, ~6 Hz for idle blinks.
    if (!this.dirty && time - this.lastDraw < (animating ? 0.033 : 0.16)) return;
    this.lastDraw = time;
    this.dirty = false;
    const g = this.ctx;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.bg, 0, 0);
    for (const r of this.residents) {
      if (this.leaper?.r === r) continue;
      const hop = this.celebrate * Math.abs(Math.sin(time * 4 + r.seed * 3)) * 0.05;
      this.drawShadow(r.st, r.x, r.y + hop, this.scale, 0, time, r.seed, 0.6);
    }
    const L = this.leaper;
    if (L) {
      const k = (time - L.t0) / LEAP_TIME;
      if (k >= 1) {
        this.leaper = null;
        this.dirty = true;
        this.onSettle?.();
      } else {
        const e = ease(k);
        const x = L.fx + (L.r.x - L.fx) * e;
        const arc = Math.sin(Math.PI * e) * 0.28 + Math.abs(Math.sin(k * Math.PI * 3)) * 0.04 * (1 - e);
        const y = L.fy + (L.r.y - L.fy) * e + arc;
        const s = L.fromScale + (this.scale - L.fromScale) * e;
        this.drawShadow(L.r.st, x, y, s, Math.sin(k * Math.PI * 2) * 0.12, time, L.r.seed, 0.6);
      }
    }
    this.texture.needsUpdate = true;
  }

  /** The creature's ink with a soft penumbra, rendered once per creature. */
  private softInk(st: Stencil): HTMLCanvasElement {
    let c = this.soft.get(st);
    if (!c) {
      c = document.createElement('canvas');
      c.width = st.ink.width;
      c.height = st.ink.height;
      const g = c.getContext('2d')!;
      g.filter = 'blur(4px)';
      g.drawImage(st.ink, 0, 0);
      this.soft.set(st, c);
    }
    return c;
  }

  private drawShadow(st: Stencil, x: number, y: number, scale: number, rot: number, time: number, seed: number, alpha: number): void {
    const g = this.ctx;
    const w = st.w * scale * PX, h = st.h * scale * PX;
    const [px, py] = this.toPx(x, y);
    g.save();
    g.translate(px, py);
    g.rotate(rot);
    g.globalAlpha = alpha;
    g.drawImage(this.softInk(st), -w / 2, -h / 2, w, h);
    // Eyes: lantern light shining through the cut-out's eye holes.
    const blink = Math.sin(time * 0.7 + seed * 5.1) > 0.985;
    g.globalAlpha = 0.95;
    g.fillStyle = '#ffd9a0';
    for (const [u, v] of st.eyes) {
      const ex = -w / 2 + u * w, ey = -h / 2 + v * h;
      g.beginPath();
      if (blink) g.ellipse(ex, ey, 2.4 * scale, 0.6 * scale, 0, 0, Math.PI * 2);
      else g.arc(ex, ey, 2.2 * scale, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}

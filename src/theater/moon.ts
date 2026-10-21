/**
 * Tonight's moon, cut into the corner of the paper: a small hole the lantern
 * shines through, shaped by the real lunar phase of the date. Every night of
 * play looks a little different, and a full moon brings its own line.
 */
import { AdditiveBlending, CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, RingGeometry, SRGBColorSpace } from '@iwsdk/core';

const SYNODIC = 29.530588853;
const NEW_MOON_2000 = Date.UTC(2000, 0, 6, 18, 14) / 86400000; // days since epoch

/** 0 = new moon, 0.5 = full moon, for a given date (or `?moon=0..1` while testing). */
export function moonPhase(date = new Date()): number {
  const forced = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('moon')) : NaN;
  if (Number.isFinite(forced) && forced > 0 && forced < 1) return forced;
  const days = date.getTime() / 86400000 - NEW_MOON_2000;
  return (((days / SYNODIC) % 1) + 1) % 1;
}

export const isFullMoon = (p: number) => Math.abs(p - 0.5) < 0.034; // about a day either side

export class Moon {
  readonly mesh: Mesh;
  private canvas = document.createElement('canvas');
  private texture: CanvasTexture;
  private material: MeshBasicMaterial;
  private phase = 0;
  private targetPhase = 0;
  private phaseDrawIn = 0;
  private flash = 0;
  private flashMaterial: MeshBasicMaterial;
  private stars = 0;
  private queen = false;

  constructor(diameter = 0.075) {
    this.canvas.width = this.canvas.height = 128;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false });
    this.mesh = new Mesh(new PlaneGeometry(diameter * 1.6, diameter * 1.6), this.material);
    this.mesh.name = 'Moon';
    this.mesh.renderOrder = 0.5;
    this.flashMaterial = new MeshBasicMaterial({
      color: '#ffd18a', transparent: true, opacity: 0, depthWrite: false,
      toneMapped: false, blending: AdditiveBlending,
    });
    const rimFlash = new Mesh(new RingGeometry(diameter * 0.47, diameter * 0.57, 48), this.flashMaterial);
    rimFlash.position.z = 0.0005;
    rimFlash.renderOrder = 0.6;
    this.mesh.add(rimFlash);
  }

  /** Paint the phase once (each night): lit part as light through the paper, the rest a faint scorched ring. */
  setPhase(p: number): void {
    this.phase = this.targetPhase = Math.max(0, Math.min(1, p));
    this.paintPhase();
  }

  setQueen(visible: boolean): void {
    if (this.queen === visible) return;
    this.queen = visible;
    this.paintPhase();
  }

  arrive(p: number): void {
    this.targetPhase = Math.max(0, Math.min(1, p));
    this.flash = 1;
  }

  update(dt: number): void {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt / 0.55);
      this.flashMaterial.opacity = 0.9 * this.flash * this.flash;
    }
    if (Math.abs(this.targetPhase - this.phase) < 0.0005) return;
    this.phase += (this.targetPhase - this.phase) * Math.min(1, dt * 7);
    if (Math.abs(this.targetPhase - this.phase) < 0.0005) this.phase = this.targetPhase;
    this.phaseDrawIn -= dt;
    if (this.phaseDrawIn > 0 && this.phase !== this.targetPhase) return;
    this.phaseDrawIn = 1 / 15;
    this.paintPhase();
  }

  private paintPhase(): void {
    const c = this.canvas, g = c.getContext('2d', { willReadFrequently: true })!, N = c.width, R = N * 0.31, cx = N / 2, cy = N / 2;
    g.clearRect(0, 0, N, N);
    const glow = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, N / 2);
    glow.addColorStop(0, `rgba(255,236,190,${0.25 + 0.35 * (1 - Math.cos(this.phase * Math.PI * 2)) / 2})`);
    glow.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, N, N);
    const img = g.getImageData(0, 0, N, N);
    const th = this.phase * Math.PI * 2, sx = Math.sin(th), sz = -Math.cos(th);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5 - cx) / R, v = (y + 0.5 - cy) / R, d2 = u * u + v * v;
        if (d2 > 1.04) continue;
        const k = (y * N + x) * 4;
        const edge = Math.max(0, Math.min(1, (1.04 - d2) / 0.08));
        if (d2 > 1) { // scorched rim of the hole
          img.data[k] = 90; img.data[k + 1] = 55; img.data[k + 2] = 30; img.data[k + 3] = 150 * edge;
          continue;
        }
        const z = Math.sqrt(1 - d2);
        const lit = Math.max(0, Math.min(1, (u * sx + z * sz) * 6 + 0.5));
        // Lit: light through the hole. Dark: the paper is still there, so only a faint ash tint.
        img.data[k] = 120 + 135 * lit;
        img.data[k + 1] = 88 + 156 * lit;
        img.data[k + 2] = 56 + 158 * lit;
        img.data[k + 3] = 255 * (0.28 + 0.7 * lit);
      }
    }
    g.putImageData(img, 0, 0);
    g.strokeStyle = 'rgba(72,31,14,0.8)';
    g.lineWidth = 5;
    g.beginPath(); g.arc(cx, cy, R + 2, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(219,147,68,0.8)';
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, R - 1, 0, Math.PI * 2); g.stroke();
    if (this.queen) {
      g.fillStyle = 'rgba(24,18,28,0.88)';
      g.beginPath();
      g.moveTo(cx, cy + 12);
      g.bezierCurveTo(cx - 8, cy - 16, cx - 34, cy - 22, cx - 30, cy + 5);
      g.bezierCurveTo(cx - 22, cy + 17, cx - 8, cy + 16, cx, cy + 9);
      g.bezierCurveTo(cx + 8, cy + 16, cx + 22, cy + 17, cx + 30, cy + 5);
      g.bezierCurveTo(cx + 34, cy - 22, cx + 8, cy - 16, cx, cy + 12);
      g.fill();
      g.beginPath(); g.ellipse(cx, cy + 8, 4, 13, 0, 0, Math.PI * 2); g.fill();
    }
    for (let star = 0; star < this.stars; star++) {
      const centreX = 43 + star * 21;
      g.fillStyle = '#6e482b';
      g.beginPath();
      for (let point = 0; point < 10; point++) {
        const angle = -Math.PI / 2 + point * Math.PI / 5;
        const radius = point % 2 === 0 ? 8 : 3.4;
        const x = centreX + Math.cos(angle) * radius;
        const y = 114 + Math.sin(angle) * radius;
        if (point === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    }
    this.texture.needsUpdate = true;
  }

  setStars(count: number): void {
    this.stars = Math.max(0, Math.min(3, Math.floor(count)));
    this.setPhase(this.phase);
  }
}

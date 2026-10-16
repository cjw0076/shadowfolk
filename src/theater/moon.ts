/**
 * Tonight's moon, cut into the corner of the paper: a small hole the lantern
 * shines through, shaped by the real lunar phase of the date. Every night of
 * play looks a little different, and a full moon brings its own line.
 */
import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';

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

  constructor(diameter = 0.075) {
    this.canvas.width = this.canvas.height = 128;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false });
    this.mesh = new Mesh(new PlaneGeometry(diameter * 1.6, diameter * 1.6), this.material);
    this.mesh.name = 'Moon';
    this.mesh.renderOrder = 0.5;
  }

  /** Paint the phase once (each night): lit part as light through the paper, the rest a faint scorched ring. */
  setPhase(p: number): void {
    const c = this.canvas, g = c.getContext('2d')!, N = c.width, R = N * 0.31, cx = N / 2, cy = N / 2;
    g.clearRect(0, 0, N, N);
    const glow = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, N / 2);
    glow.addColorStop(0, `rgba(255,236,190,${0.25 + 0.35 * (1 - Math.cos(p * Math.PI * 2)) / 2})`);
    glow.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, N, N);
    const img = g.getImageData(0, 0, N, N);
    const th = p * Math.PI * 2, sx = Math.sin(th), sz = -Math.cos(th);
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
        img.data[k] = 255; img.data[k + 1] = 244 - 20 * (1 - lit); img.data[k + 2] = 214 - 60 * (1 - lit);
        img.data[k + 3] = 255 * (0.12 + 0.86 * lit);
      }
    }
    g.putImageData(img, 0, 0);
    this.texture.needsUpdate = true;
  }
}

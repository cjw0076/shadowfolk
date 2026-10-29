/** The night receipt is made of fixed ink textures; its timeline only moves meshes. */
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';

function inkTexture(kind: 'star' | 'outline' | 'splash'): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.translate(64, 64);
  g.strokeStyle = '#3e291d';
  g.fillStyle = '#3e291d';
  if (kind === 'splash') {
    g.lineWidth = 4;
    g.beginPath(); g.arc(0, 0, 42, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 13; i++) {
      const a = i * 2.399, r = 46 + (i * 7 % 13);
      g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, i % 3 === 0 ? 2.5 : 1.4, 0, Math.PI * 2); g.fill();
    }
  } else {
    g.beginPath();
    for (let point = 0; point < 10; point++) {
      const a = -Math.PI / 2 + point * Math.PI / 5;
      const r = point % 2 === 0 ? 44 : 18;
      if (point === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
    if (kind === 'star') g.fill();
    else { g.lineWidth = 4; g.stroke(); }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export class NightCardView {
  readonly root = new Group();
  private readonly filled = inkTexture('star');
  private readonly outline = inkTexture('outline');
  private readonly splash = inkTexture('splash');
  private readonly stars: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private readonly rings: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private readonly arc: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  stamped = 0;

  constructor() {
    this.root.name = 'NightCard';
    for (let i = 0; i < 3; i++) {
      // The ink contour spans 88 of 128 texels, so this plane makes the mark 0.07 m wide.
      const star = new Mesh(new PlaneGeometry(0.102, 0.102), new MeshBasicMaterial({
        map: this.outline, transparent: true, depthWrite: false, toneMapped: false,
      }));
      star.position.set((i - 1) * 0.105, 0, 0.0032);
      star.renderOrder = 8;
      this.root.add(star);
      this.stars.push(star);
      const ring = new Mesh(new PlaneGeometry(0.15, 0.15), new MeshBasicMaterial({
        map: this.splash, transparent: true, depthWrite: false, toneMapped: false,
      }));
      ring.position.set(star.position.x, 0, 0.0033);
      ring.renderOrder = 9;
      this.root.add(ring);
      this.rings.push(ring);
    }
    for (let i = 0; i < 9; i++) {
      const spark = new Mesh(new PlaneGeometry(0.012, 0.012), new MeshBasicMaterial({
        map: this.filled, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
      }));
      spark.position.set(0.40 - 0.11 * Math.sin(i / 8 * Math.PI), -0.22 + i / 8 * 0.46, 0.0034);
      spark.renderOrder = 9;
      spark.visible = false;
      this.root.add(spark);
      this.arc.push(spark);
    }
    this.root.visible = false;
  }

  update(t: number, earned: number, onStamp: (index: number) => void): void {
    this.root.visible = t >= 1.2 && t < 8;
    if (!this.root.visible) return;
    for (let i = 0; i < 3; i++) {
      const age = t - 1.2 - i * 0.35;
      const filled = i < earned && age >= 0;
      if (filled && this.stamped < i + 1) {
        this.stamped = i + 1;
        onStamp(i);
      }
      const star = this.stars[i], ring = this.rings[i];
      star.material.map = filled ? this.filled : this.outline;
      star.material.opacity = filled ? 0.95 : 0.22;
      star.scale.setScalar(filled ? 1 + 0.4 * (1 - Math.min(1, age / 0.22)) : 1);
      const splash = filled && age < 0.42;
      ring.visible = splash;
      if (splash) {
        ring.material.opacity = 0.65 * (1 - age / 0.42);
        ring.scale.setScalar(0.72 + age * 1.6);
      }
    }
    const travel = (t - 3) / 2;
    for (let i = 0; i < this.arc.length; i++) {
      const age = travel - i / (this.arc.length - 1);
      const spark = this.arc[i];
      spark.visible = age >= 0 && age < 0.3;
      if (spark.visible) {
        spark.material.opacity = 0.7 * (1 - age / 0.3);
        spark.scale.setScalar(0.75 + age * 1.4);
      }
    }
  }

  reset(): void { this.stamped = 0; this.root.visible = false; }
}

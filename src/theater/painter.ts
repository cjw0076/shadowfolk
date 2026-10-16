/**
 * Paints the paper screen: washi paper lit by the lantern, the live hand
 * shadows (soft penumbra), the glowing cut-out of the creature to match, and
 * the woken creature's shadow animation. Only the quarter-size shadow canvas
 * changes every frame; the rest are cached textures or GPU transforms.
 */
import {
  AdditiveBlending, CanvasTexture, Color, DynamicDrawUsage, Group, InstancedMesh,
  LinearFilter, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, SRGBColorSpace, Vector2, Vector4,
} from '@iwsdk/core';
import { BONES, PALM } from '../shadow/hand-model.js';
import { FlatHand } from '../shadow/silhouette.js';
import { TARGETS } from '../shadow/targets.js';
import { runtimePerf as perf } from './perf.js';

export const SCREEN_W = 1.0; // metres
export const SCREEN_H = 0.66;
const CW = 1024;
const CH = Math.round((CW * SCREEN_H) / SCREEN_W);
const PX = CW / SCREEN_W; // canvas px per screen metre
const SOFT = 4; // shadow layer downscale (penumbra softness)

const INK = '#1c1316';
const INK_COLOR = new Color(INK);
const SPARK_COUNT = 18;
const CAPTION_H = 80;

function texture(source: HTMLCanvasElement): CanvasTexture {
  const result = new CanvasTexture(source);
  result.colorSpace = SRGBColorSpace;
  result.generateMipmaps = false;
  result.minFilter = LinearFilter;
  result.magFilter = LinearFilter;
  return result;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Trace palm polygon + finger capsules of a flat hand into the current path. */
function handPath(ctx: CanvasRenderingContext2D, f: FlatHand): void {
  ctx.beginPath();
  ctx.moveTo(f.x[PALM[0]], f.y[PALM[0]]);
  for (let k = 1; k < PALM.length; k++) ctx.lineTo(f.x[PALM[k]], f.y[PALM[k]]);
  ctx.closePath();
  ctx.fill();
  for (const [a, b] of BONES) {
    ctx.lineWidth = f.r[a] + f.r[b];
    ctx.beginPath();
    ctx.moveTo(f.x[a], f.y[a]);
    ctx.lineTo(f.x[b], f.y[b]);
    ctx.stroke();
  }
}

/** A creature silhouette pre-rendered as sprites (ink, cut-out, glow). */
export interface Stencil {
  ink: HTMLCanvasElement;
  cut: HTMLCanvasElement;
  glow: HTMLCanvasElement;
  inkOpen: CanvasTexture;
  inkBlink: CanvasTexture;
  cutTexture: CanvasTexture;
  glowTexture: CanvasTexture;
  /** Sprite size in screen metres; sprite centre in screen metres. */
  w: number;
  h: number;
  cx: number;
  cy: number;
  eyes: [number, number][]; // 0..1 inside the sprite, y down
}

/** Same path as handPath but every stroke widened by `grow` metres. */
function handPathGrown(ctx: CanvasRenderingContext2D, f: FlatHand, grow: number): void {
  ctx.lineWidth = grow * 2;
  ctx.beginPath();
  ctx.moveTo(f.x[PALM[0]], f.y[PALM[0]]);
  for (let k = 1; k < PALM.length; k++) ctx.lineTo(f.x[PALM[k]], f.y[PALM[k]]);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  for (const [a, b] of BONES) {
    ctx.lineWidth = f.r[a] + f.r[b] + grow * 2;
    ctx.beginPath();
    ctx.moveTo(f.x[a], f.y[a]);
    ctx.lineTo(f.x[b], f.y[b]);
    ctx.stroke();
  }
}

export function makeStencil(hands: FlatHand | FlatHand[], scale: number, eyes: readonly (readonly number[])[]): Stencil {
  const fs = Array.isArray(hands) ? hands : [hands];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of fs) {
    for (let j = 0; j < f.x.length; j++) {
      minX = Math.min(minX, f.x[j] - f.r[j]); maxX = Math.max(maxX, f.x[j] + f.r[j]);
      minY = Math.min(minY, f.y[j] - f.r[j]); maxY = Math.max(maxY, f.y[j] + f.r[j]);
    }
  }
  const pad = 0.03; // metres of room for the glow
  const wM = (maxX - minX) * scale + 2 * pad, hM = (maxY - minY) * scale + 2 * pad;
  const w = Math.ceil(wM * PX), h = Math.ceil(hM * PX);
  const [ink, ictx] = canvas(w, h);
  ictx.setTransform(PX * scale, 0, 0, -PX * scale, pad * PX - minX * PX * scale, h - pad * PX + minY * PX * scale);
  ictx.fillStyle = ictx.strokeStyle = INK;
  ictx.lineCap = 'round';
  ictx.lineJoin = 'round';
  for (const f of fs) handPath(ictx, f);
  // Cut-out: a hole in the paper with a thin scorched edge, lit from behind.
  const [cut, cctx] = canvas(w, h);
  cctx.setTransform(ictx.getTransform());
  cctx.lineCap = 'round';
  cctx.lineJoin = 'round';
  cctx.fillStyle = cctx.strokeStyle = 'rgba(92,58,34,0.85)';
  for (const f of fs) handPathGrown(cctx, f, 0.0045 / scale);
  cctx.fillStyle = cctx.strokeStyle = '#fff4dc';
  for (const f of fs) handPath(cctx, f);
  const [glow, gctx] = canvas(w, h);
  gctx.filter = 'blur(9px)';
  gctx.drawImage(ink, 0, 0);
  gctx.filter = 'none';
  gctx.globalCompositeOperation = 'source-in';
  gctx.fillStyle = '#ffc25e';
  gctx.fillRect(0, 0, w, h);
  const toSprite = (x: number, y: number): [number, number] => [
    (pad + (x - minX) * scale) / wM,
    1 - (pad + (y - minY) * scale) / hM,
  ];
  const eyePts = eyes.map(([a, b, t, hand = 0]) => {
    const f = fs[Math.min(hand, fs.length - 1)];
    return toSprite(f.x[a] + (f.x[b] - f.x[a]) * t, f.y[a] + (f.y[b] - f.y[a]) * t);
  });
  const eyeSprite = (blink: boolean): HTMLCanvasElement => {
    const [sprite, context] = canvas(w, h);
    context.drawImage(ink, 0, 0);
    context.fillStyle = '#fff6e0';
    for (const [u, v] of eyePts) {
      context.beginPath();
      if (blink) context.ellipse(u * w, v * h, 8, 1.6, 0, 0, Math.PI * 2);
      else context.arc(u * w, v * h, 7.5, 0, Math.PI * 2);
      context.fill();
    }
    return sprite;
  };
  return {
    ink, cut, glow, w: wM, h: hM,
    cx: ((minX + maxX) / 2) * scale, cy: ((minY + maxY) / 2) * scale,
    eyes: eyePts,
    inkOpen: texture(eyeSprite(false)), inkBlink: texture(eyeSprite(true)),
    cutTexture: texture(cut), glowTexture: texture(glow),
  };
}

interface CreatureLayer {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  clip: Vector4;
  turn: Vector2;
}

interface CaptionLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  text: string;
  y: number;
}

export class ScreenPainter {
  readonly root = new Group();
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly paperMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private ctx: CanvasRenderingContext2D;
  private soft: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private softTexture: CanvasTexture;
  private shadowMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private cutMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private glowMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private creatures: CreatureLayer[] = [];
  private creatureCount = 0;
  private captions: CaptionLayer[] = [];
  private perfCaption: CaptionLayer;
  private sparksMesh: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  private sparkTransform = new Object3D();
  private paperX = 0;
  private paperY = -0.2;
  private paperReady = false;
  private progressDone = -1;
  private progressTotal = -1;
  private progressCalled = false;
  private lastPerfText = 0;

  constructor() {
    [this.canvas, this.ctx] = canvas(CW, CH);
    [this.soft, this.sctx] = canvas(CW / SOFT, Math.round(CH / SOFT));
    this.texture = texture(this.canvas);
    this.softTexture = texture(this.soft);
    this.paperMesh = new Mesh(new PlaneGeometry(SCREEN_W, SCREEN_H),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    this.paperMesh.name = 'Paper';
    this.root.add(this.paperMesh);
    this.cutMesh = this.overlay(1, new PlaneGeometry(1, 1));
    this.glowMesh = this.overlay(2, new PlaneGeometry(1, 1), true);
    this.shadowMesh = this.overlay(3, new PlaneGeometry(SCREEN_W, SCREEN_H));
    this.shadowMesh.material.map = this.softTexture;
    this.shadowMesh.material.color.set(INK);
    for (let index = 0; index < TARGETS.length + 2; index++) {
      const mesh = this.overlay(4, new PlaneGeometry(1, 1));
      const clip = new Vector4();
      const turn = new Vector2(1, 0);
      mesh.material.onBeforeCompile = shader => {
        shader.uniforms.paperClip = { value: clip };
        shader.uniforms.paperTurn = { value: turn };
        shader.vertexShader = `uniform vec4 paperClip;\nuniform vec2 paperTurn;\nvarying vec2 vPaperPoint;\n${shader.vertexShader}`
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vec2 spritePoint = position.xy * paperClip.zw;
            vPaperPoint = paperClip.xy + vec2(spritePoint.x * paperTurn.x - spritePoint.y * paperTurn.y,
              spritePoint.x * paperTurn.y + spritePoint.y * paperTurn.x);`);
        shader.fragmentShader = `varying vec2 vPaperPoint;\n${shader.fragmentShader}`
          .replace('void main() {', `void main() {
            if (abs(vPaperPoint.x) > ${SCREEN_W / 2} || abs(vPaperPoint.y) > ${SCREEN_H / 2}) discard;`);
      };
      this.creatures.push({ mesh, clip, turn });
    }
    const [sparkCanvas, sparkContext] = canvas(32, 32);
    const sparkGradient = sparkContext.createRadialGradient(16, 16, 0, 16, 16, 16);
    sparkGradient.addColorStop(0, 'rgba(255,255,255,1)');
    sparkGradient.addColorStop(0.45, 'rgba(255,255,255,0.95)');
    sparkGradient.addColorStop(1, 'rgba(255,255,255,0)');
    sparkContext.fillStyle = sparkGradient;
    sparkContext.fillRect(0, 0, 32, 32);
    this.sparksMesh = new InstancedMesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      map: texture(sparkCanvas), transparent: true, depthWrite: false,
      blending: AdditiveBlending, toneMapped: false,
    }), SPARK_COUNT);
    this.sparksMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let index = 0; index < SPARK_COUNT; index++) {
      this.sparksMesh.setColorAt(index, new Color(`rgb(255, ${180 + ((index * 13) % 60)}, 90)`));
    }
    this.sparksMesh.position.z = 0.002;
    this.sparksMesh.renderOrder = 5;
    this.sparksMesh.frustumCulled = false;
    this.sparksMesh.visible = false;
    this.root.add(this.sparksMesh);
    for (let index = 0; index < 5; index++) this.captions.push(this.makeCaption(CW, CAPTION_H, 6));
    this.perfCaption = this.makeCaption(420, 48, 7);
    this.paintPaper(0, -0.2);
  }

  private overlay(order: number, geometry: PlaneGeometry, additive = false): Mesh<PlaneGeometry, MeshBasicMaterial> {
    const material = new MeshBasicMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      blending: additive ? AdditiveBlending : undefined,
    });
    const mesh = new Mesh(geometry, material);
    mesh.position.z = order * 0.0004;
    mesh.renderOrder = order;
    mesh.visible = false;
    this.root.add(mesh);
    return mesh;
  }

  private makeCaption(width: number, height: number, order: number): CaptionLayer {
    const [source, ctx] = canvas(width, height);
    const mesh = this.overlay(order, new PlaneGeometry(width / PX, height / PX));
    mesh.material.map = texture(source);
    return { canvas: source, ctx, mesh, text: '', y: NaN };
  }

  setTone(value: number): void {
    this.paperMesh.material.color.setScalar(value);
    this.cutMesh.material.color.setScalar(value);
    this.glowMesh.material.color.setScalar(value);
    this.shadowMesh.material.color.copy(INK_COLOR).multiplyScalar(value);
    for (let index = 0; index < this.creatures.length; index++) this.creatures[index].mesh.material.color.setScalar(value);
    for (let index = 0; index < this.captions.length; index++) this.captions[index].mesh.material.color.setScalar(value);
    this.perfCaption.mesh.material.color.setScalar(value);
    this.sparksMesh.material.color.setScalar(value);
  }

  /** Washi paper with fibres, warmly lit around the lantern's footprint. */
  paintPaper(lightX: number, lightY: number): HTMLCanvasElement {
    if (this.paperReady && lightX === this.paperX && lightY === this.paperY) return this.canvas;
    this.paperX = lightX;
    this.paperY = lightY;
    this.renderPaper();
    this.paperReady = true;
    return this.canvas;
  }

  private renderPaper(): void {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = '#eadbc0';
    g.fillRect(0, 0, CW, CH);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 900; k++) {
      const x = rnd() * CW, y = rnd() * CH, len = 6 + rnd() * 40, a = rnd() * Math.PI;
      g.strokeStyle = rnd() < 0.5 ? 'rgba(255,250,235,0.35)' : 'rgba(150,120,85,0.12)';
      g.lineWidth = 0.6 + rnd() * 1.2;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 8, y + Math.sin(a) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
    const cx = CW / 2 + this.paperX * PX, cy = CH / 2 - this.paperY * PX;
    const glow = g.createRadialGradient(cx, cy, 20, cx, cy, CW * 0.75);
    glow.addColorStop(0, 'rgba(255,214,140,0.55)');
    glow.addColorStop(0.45, 'rgba(255,190,110,0.18)');
    glow.addColorStop(1, 'rgba(70,40,25,0.55)');
    g.fillStyle = glow;
    g.fillRect(0, 0, CW, CH);
    for (let index = 0; index < this.progressTotal; index++) {
      g.fillStyle = index < this.progressDone ? 'rgba(60,40,30,0.85)' : 'rgba(60,40,30,0.18)';
      g.beginPath();
      g.arc(CW - 40 - (this.progressTotal - 1 - index) * 26, 36, 8, 0, Math.PI * 2);
      g.fill();
    }
    this.texture.needsUpdate = true;
  }

  begin(): void {
    const started = perf ? performance.now() : 0;
    this.cutMesh.visible = false;
    this.glowMesh.visible = false;
    this.shadowMesh.visible = false;
    for (let index = 0; index < this.creatureCount; index++) this.creatures[index].mesh.visible = false;
    this.creatureCount = 0;
    this.sparksMesh.visible = false;
    for (let index = 0; index < this.captions.length; index++) this.captions[index].mesh.visible = false;
    this.perfCaption.mesh.visible = false;
    this.progressCalled = false;
    const s = this.sctx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, this.soft.width, this.soft.height);
    perf?.endCall('begin', started);
  }

  /** Cut-out of the creature to match, glowing with closeness. */
  target(st: Stencil, cx: number, cy: number, glow: number, time: number): void {
    const started = perf ? performance.now() : 0;
    this.cutMesh.material.map = st.cutTexture;
    this.cutMesh.material.opacity = 0.8 + 0.12 * Math.sin(time * 1.7);
    this.cutMesh.position.set(cx + st.cx, cy + st.cy, 0.0004);
    this.cutMesh.scale.set(st.w, st.h, 1);
    this.cutMesh.visible = true;
    this.glowMesh.material.map = st.glowTexture;
    this.glowMesh.material.opacity = Math.min(1, 0.25 + glow * 0.9);
    this.glowMesh.position.set(cx + st.cx, cy + st.cy, 0.0008);
    this.glowMesh.scale.set(st.w, st.h, 1);
    this.glowMesh.visible = true;
    perf?.endCall('target', started);
  }

  /** Accumulate a live hand shadow (screen-metre coordinates). */
  shadow(f: FlatHand): void {
    if (!f.valid) return;
    const started = perf ? performance.now() : 0;
    const s = this.sctx, k = PX / SOFT;
    s.setTransform(k, 0, 0, -k, this.soft.width / 2, this.soft.height / 2);
    s.fillStyle = s.strokeStyle = '#fff';
    s.lineCap = 'round';
    s.lineJoin = 'round';
    handPath(s, f);
    perf?.endCall('shadow', started);
  }

  /** Upload just the quarter-size shadow layer for GPU bilinear upscaling. */
  flushShadows(alpha: number): void {
    const started = perf ? performance.now() : 0;
    this.shadowMesh.material.opacity = alpha;
    this.shadowMesh.visible = true;
    this.softTexture.needsUpdate = true;
    perf?.endCall('flushShadows', started);
  }

  /** A woken creature: ink silhouette with a blinking eye. */
  creature(st: Stencil, cx: number, cy: number, scale: number, rot: number, flipX: boolean, blink: boolean, alpha: number): void {
    const started = perf ? performance.now() : 0;
    if (this.creatureCount >= this.creatures.length) return;
    const layer = this.creatures[this.creatureCount++];
    const width = st.w * scale;
    const height = st.h * scale;
    const x = cx + st.cx * scale;
    const y = cy + st.cy * scale;
    const direction = flipX ? -1 : 1;
    layer.mesh.material.map = blink ? st.inkBlink : st.inkOpen;
    layer.mesh.material.opacity = alpha;
    layer.mesh.position.set(x, y, 0.0016);
    layer.mesh.scale.set(width * direction, height, 1);
    layer.mesh.rotation.z = -rot;
    layer.clip.set(x, y, width * direction, height);
    layer.turn.set(Math.cos(rot), -Math.sin(rot));
    layer.mesh.visible = alpha > 0;
    perf?.endCall('creature', started);
  }

  /** Little sparks of lantern light (wake moment). */
  sparks(cx: number, cy: number, t: number, alpha: number): void {
    const started = perf ? performance.now() : 0;
    const transform = this.sparkTransform;
    for (let k = 0; k < SPARK_COUNT; k++) {
      const a = k * 2.399 + t * 0.6, r = (40 + 260 * t) * (0.5 + ((k * 37) % 10) / 20);
      const diameter = (6 + 2 * (k % 3)) / PX;
      transform.position.set(cx + Math.cos(a) * r / PX, cy - Math.sin(a) * r / PX, 0);
      transform.scale.set(diameter, diameter, 1);
      transform.updateMatrix();
      this.sparksMesh.setMatrixAt(k, transform.matrix);
    }
    this.sparksMesh.instanceMatrix.needsUpdate = true;
    this.sparksMesh.material.opacity = alpha * (1 - t);
    this.sparksMesh.visible = this.sparksMesh.material.opacity > 0;
    perf?.endCall('sparks', started);
  }

  caption(text: string, alpha: number, y = -0.27): void {
    if (alpha <= 0 || !text) return;
    const started = perf ? performance.now() : 0;
    let selected: CaptionLayer | undefined;
    for (let index = 0; index < this.captions.length; index++) {
      if (this.captions[index].y === y) { selected = this.captions[index]; break; }
    }
    if (!selected) {
      for (let index = 0; index < this.captions.length; index++) {
        if (!this.captions[index].mesh.visible) { selected = this.captions[index]; break; }
      }
    }
    if (selected) this.drawCaption(selected, text, alpha, y, false);
    perf?.endCall('caption', started);
  }

  /** Small counter of woken creatures (top-right), drawn as dots. */
  progress(done: number, total: number): void {
    const started = perf ? performance.now() : 0;
    this.progressCalled = true;
    if (done !== this.progressDone || total !== this.progressTotal) {
      this.progressDone = done;
      this.progressTotal = total;
      this.renderPaper();
    }
    perf?.endCall('progress', started);
  }

  end(): void {
    const started = perf ? performance.now() : 0;
    if (!this.progressCalled && this.progressTotal > 0) {
      this.progressTotal = 0;
      this.renderPaper();
    }
    if (perf) {
      const now = performance.now();
      if (now - this.lastPerfText >= 500) {
        this.lastPerfText = now;
        const interval = perf.frameInterval.count
          ? perf.frameInterval.values[(perf.frameInterval.count - 1) % perf.capacity] : 0;
        const update = perf.update.count ? perf.update.values[(perf.update.count - 1) % perf.capacity] : 0;
        this.drawCaption(this.perfCaption, `${interval ? (1000 / interval).toFixed(0) : '0'} fps / ${update.toFixed(1)} ms`,
          0.8, SCREEN_H / 2 - 0.035, true);
      }
      this.perfCaption.mesh.visible = !!this.perfCaption.text;
    }
    perf?.endCall('end', started);
  }

  private drawCaption(layer: CaptionLayer, text: string, alpha: number, y: number, small: boolean): void {
    if (layer.text !== text) {
      const context = layer.ctx;
      context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      context.fillStyle = '#4a3626';
      context.font = small ? '22px Arial, sans-serif' : 'italic 34px Georgia, "Times New Roman", serif';
      context.textAlign = small ? 'left' : 'center';
      context.textBaseline = 'middle';
      context.fillText(text, small ? 12 : layer.canvas.width / 2, layer.canvas.height / 2);
      layer.mesh.material.map!.needsUpdate = true;
      layer.text = text;
    }
    layer.y = y;
    layer.mesh.position.x = small ? -SCREEN_W / 2 + layer.canvas.width / (2 * PX) + 0.012 : 0;
    layer.mesh.position.y = y;
    layer.mesh.material.opacity = alpha;
    layer.mesh.visible = true;
  }
}

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
import { playfairReady } from './visual-fonts.js';

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
const eyeGlint = new Image();
const pendingGlints: { canvas: HTMLCanvasElement; texture: CanvasTexture; eyes: [number, number][] }[] = [];
eyeGlint.onload = () => {
  for (const pending of pendingGlints) {
    const context = pending.canvas.getContext('2d')!;
    for (const [u, v] of pending.eyes) {
      const x = u * pending.canvas.width;
      const y = v * pending.canvas.height;
      context.drawImage(eyeGlint, x - 7, y - 9, 14, 14);
      context.fillStyle = '#fff';
      context.fillRect(x - 2, y - 2, 2, 2);
    }
    pending.texture.needsUpdate = true;
  }
  pendingGlints.length = 0;
};
eyeGlint.src = `${import.meta.env?.BASE_URL ?? './'}textures/eye-glint.png`;

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
  ictx.filter = 'blur(3px)';
  ictx.fillStyle = ictx.strokeStyle = 'rgba(42,47,58,0.85)';
  for (const f of fs) handPath(ictx, f);
  ictx.filter = 'none';
  ictx.globalAlpha = 0.82;
  ictx.fillStyle = ictx.strokeStyle = INK;
  for (const f of fs) handPath(ictx, f);
  ictx.globalAlpha = 1;
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.globalCompositeOperation = 'source-atop';
  let grainSeed = 0x6d2b79f5;
  for (let index = 0; index < Math.round(w * h / 90); index++) {
    grainSeed = (Math.imul(grainSeed, 1664525) + 1013904223) >>> 0;
    const x = (grainSeed / 0x100000000) * w;
    grainSeed = (Math.imul(grainSeed, 1664525) + 1013904223) >>> 0;
    const y = (grainSeed / 0x100000000) * h;
    ictx.fillStyle = index % 3 ? 'rgba(240,226,201,0.055)' : 'rgba(8,7,9,0.10)';
    ictx.fillRect(x, y, 1, 1);
  }
  ictx.globalCompositeOperation = 'source-over';
  const inkSource = ictx.getImageData(0, 0, w, h).data;
  for (let row = 18; row < h - 18; row += 4) {
    for (let column = 18; column < w - 18; column += 4) {
      const pixel = (row * w + column) * 4;
      const alpha = inkSource[pixel + 3];
      if (alpha < 45 || alpha > 205) continue;
      const flow = Math.sin(column * 0.31 + row * 0.17) * Math.sin(column * 0.07 - row * 0.23);
      if (flow < 0.35) continue;
      const gradientX = inkSource[pixel + 7] - inkSource[pixel - 1];
      const gradientY = inkSource[pixel + w * 4 + 3] - inkSource[pixel - w * 4 + 3];
      const length = Math.hypot(gradientX, gradientY);
      if (length < 18) continue;
      const reach = 8 + 8 * flow;
      const drift = 5 * Math.sin(column * 0.09 - row * 0.13);
      const endX = column - gradientX / length * reach - gradientY / length * drift;
      const endY = row - gradientY / length * reach + gradientX / length * drift;
      const wisp = ictx.createLinearGradient(column, row, endX, endY);
      wisp.addColorStop(0, 'rgba(28,19,22,0.36)');
      wisp.addColorStop(1, 'rgba(28,19,22,0)');
      ictx.strokeStyle = wisp;
      ictx.lineWidth = 0.7 + flow * 0.8;
      ictx.beginPath();
      ictx.moveTo(column, row);
      ictx.quadraticCurveTo((column + endX) / 2 + drift * 0.4, (row + endY) / 2, endX, endY);
      ictx.stroke();
    }
  }
  const [cut, cctx] = canvas(w, h);
  cctx.setTransform(PX * scale, 0, 0, -PX * scale, pad * PX - minX * PX * scale, h - pad * PX + minY * PX * scale);
  cctx.lineCap = 'round';
  cctx.lineJoin = 'round';
  cctx.fillStyle = cctx.strokeStyle = '#2e1408';
  for (const f of fs) handPathGrown(cctx, f, 0.005 / scale);
  cctx.fillStyle = cctx.strokeStyle = '#42220f';
  for (const f of fs) handPathGrown(cctx, f, 0.0046 / scale);
  cctx.fillStyle = cctx.strokeStyle = '#b2682a';
  for (const f of fs) handPathGrown(cctx, f, 0.0015 / scale);
  cctx.fillStyle = cctx.strokeStyle = '#fff2d1';
  for (const f of fs) handPath(cctx, f);
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  const charPixels = cctx.getImageData(0, 0, w, h);
  const edgeSource = charPixels.data.slice();
  for (let row = 2; row < h - 2; row++) {
    for (let column = 2; column < w - 2; column++) {
      const pixel = (row * w + column) * 4;
      if (edgeSource[pixel] > 90 || edgeSource[pixel + 3] < 160) continue;
      const neighbours = [pixel - 4, pixel + 4, pixel - w * 4, pixel + w * 4];
      const edge = neighbours.find(neighbour => edgeSource[neighbour + 3] < 8);
      if (edge === undefined) continue;
      const waviness = Math.sin(column * 0.173 + row * 0.117) * Math.sin(column * 0.041 - row * 0.087);
      if (waviness > 0.17) {
        charPixels.data[edge] = 66;
        charPixels.data[edge + 1] = 34;
        charPixels.data[edge + 2] = 15;
        charPixels.data[edge + 3] = 210;
      } else if (waviness < -0.57) {
        charPixels.data[pixel + 3] = 130;
      }
    }
  }
  cctx.putImageData(charPixels, 0, 0);
  const [glow, gctx] = canvas(w, h);
  gctx.filter = 'blur(16px)';
  gctx.drawImage(ink, 0, 0);
  gctx.filter = 'none';
  gctx.globalCompositeOperation = 'source-in';
  gctx.fillStyle = '#f7b25a';
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
    for (const [u, v] of eyePts) {
      const x = u * w;
      const y = v * h;
      const halo = context.createRadialGradient(x, y, 1, x, y, 14);
      halo.addColorStop(0, 'rgba(255,227,150,1)');
      halo.addColorStop(0.45, 'rgba(217,143,63,0.85)');
      halo.addColorStop(1, 'rgba(217,143,63,0)');
      context.fillStyle = halo;
      context.beginPath();
      if (blink) context.ellipse(x, y, 11, 2, 0, 0, Math.PI * 2);
      else context.arc(x, y, 17, 0, Math.PI * 2);
      context.fill();
      if (!blink) {
        context.fillStyle = '#ffd985';
        context.beginPath();
        context.arc(x, y, 5.2, 0, Math.PI * 2);
        context.fill();
        if (eyeGlint.complete && eyeGlint.naturalWidth) context.drawImage(eyeGlint, x - 7, y - 9, 14, 14);
        context.fillStyle = '#fff';
        context.beginPath();
        context.arc(x - 1.5, y - 1.8, 1.2, 0, Math.PI * 2);
        context.fill();
      }
    }
    return sprite;
  };
  const openEyes = eyeSprite(false);
  const openTexture = texture(openEyes);
  if (!eyeGlint.complete || !eyeGlint.naturalWidth) pendingGlints.push({ canvas: openEyes, texture: openTexture, eyes: eyePts });
  return {
    ink, cut, glow, w: wM, h: hM,
    cx: ((minX + maxX) / 2) * scale, cy: ((minY + maxY) / 2) * scale,
    eyes: eyePts,
    inkOpen: openTexture, inkBlink: texture(eyeSprite(true)),
    cutTexture: texture(cut), glowTexture: texture(glow),
  };
}

interface CreatureLayer {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  clip: Vector4;
  turn: Vector2;
  wake: { value: number };
  time: { value: number };
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
  private handCanvas: HTMLCanvasElement;
  private handContext: CanvasRenderingContext2D;
  private washi = new Image();
  private fontReady = false;
  private softTexture: CanvasTexture;
  private shadowMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private cutMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private glowMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private creatures: CreatureLayer[] = [];
  private creatureCount = 0;
  private captions: CaptionLayer[] = [];
  private perfCaption: CaptionLayer;
  private perfXrCaption: CaptionLayer;
  private sparksMesh: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  private sparkTransform = new Object3D();
  private paperX = 0;
  private paperY = -0.2;
  private paperReady = false;
  private progressDone = -1;
  private progressTotal = -1;
  private progressCalled = false;
  private lastPerfText = 0;

  constructor(private readonly xrStatusLine: () => string) {
    [this.canvas, this.ctx] = canvas(CW, CH);
    [this.soft, this.sctx] = canvas(CW / SOFT, Math.round(CH / SOFT));
    [this.handCanvas, this.handContext] = canvas(this.soft.width, this.soft.height);
    this.texture = texture(this.canvas);
    this.softTexture = texture(this.soft);
    this.paperMesh = new Mesh(new PlaneGeometry(SCREEN_W, SCREEN_H),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    this.paperMesh.name = 'Paper';
    this.root.add(this.paperMesh);
    // Back to front: the cut-out's glow and hole, then the live shadow over them (a hand that
    // covers the hole blocks the light through it, so a fitted shadow fills the shape), then creatures.
    this.glowMesh = this.overlay(1, new PlaneGeometry(1, 1), true);
    this.cutMesh = this.overlay(2, new PlaneGeometry(1, 1));
    this.shadowMesh = this.overlay(3, new PlaneGeometry(SCREEN_W, SCREEN_H));
    this.shadowMesh.material.map = this.softTexture;
    this.shadowMesh.material.color.set(INK);
    for (let index = 0; index < TARGETS.length + 2; index++) {
      const mesh = this.overlay(4, new PlaneGeometry(1, 1));
      const clip = new Vector4();
      const turn = new Vector2(1, 0);
      const wake = { value: 0 };
      const time = { value: 0 };
      mesh.material.onBeforeCompile = shader => {
        shader.uniforms.paperClip = { value: clip };
        shader.uniforms.paperTurn = { value: turn };
        shader.uniforms.inkWake = wake;
        shader.uniforms.inkTime = time;
        shader.vertexShader = `uniform vec4 paperClip;\nuniform vec2 paperTurn;\nvarying vec2 vPaperPoint;\nvarying vec2 vInkUv;\n${shader.vertexShader}`
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vInkUv = uv;
            vec2 spritePoint = position.xy * paperClip.zw;
            vPaperPoint = paperClip.xy + vec2(spritePoint.x * paperTurn.x - spritePoint.y * paperTurn.y,
              spritePoint.x * paperTurn.y + spritePoint.y * paperTurn.x);`);
        shader.fragmentShader = `varying vec2 vPaperPoint;\nvarying vec2 vInkUv;\nuniform float inkWake;\nuniform float inkTime;\n${shader.fragmentShader}`
          .replace('void main() {', `void main() {
            if (abs(vPaperPoint.x) > ${SCREEN_W / 2} || abs(vPaperPoint.y) > ${SCREEN_H / 2}) discard;`)
          .replace('#include <map_fragment>', `#include <map_fragment>
            float edgeBand = smoothstep(0.03, 0.45, diffuseColor.a) * (1.0 - smoothstep(0.55, 0.95, diffuseColor.a));
            float grain = fract(sin(dot(floor(vInkUv * vec2(220.0, 160.0)), vec2(127.1, 311.7))) * 43758.5453);
            float drift = 0.5 + 0.25 * sin(vInkUv.x * 149.0 + inkTime * 4.0)
              + 0.25 * sin(vInkUv.y * 233.0 - inkTime * 2.7);
            diffuseColor.a *= 1.0 - inkWake * edgeBand * smoothstep(0.36, 0.75, grain * 0.5 + drift * 0.5);`);
      };
      this.creatures.push({ mesh, clip, turn, wake, time });
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
    this.perfXrCaption = this.makeCaption(980, 42, 7);
    this.washi.onload = () => this.renderPaper();
    this.washi.src = `${import.meta.env?.BASE_URL ?? './'}textures/washi.jpg`;
    void playfairReady.then(ready => { this.fontReady = ready; });
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
    this.perfXrCaption.mesh.material.color.setScalar(value);
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
    g.fillStyle = '#f4e7d0';
    g.fillRect(0, 0, CW, CH);
    if (this.washi.complete && this.washi.naturalWidth) {
      g.drawImage(this.washi, 0, 0, CW, CH, 0, 0, CW, CH);
    }
    const cx = CW / 2 + this.paperX * PX, cy = CH / 2 - this.paperY * PX;
    const paper = g.getImageData(0, 0, CW, CH);
    const pixels = paper.data;
    const hasWashi = this.washi.complete && this.washi.naturalWidth > 0;
    for (let row = 0; row < CH; row++) {
      const vertical = (row - CH / 2) / (CH / 2);
      const lightY = (row - cy) / 220;
      for (let column = 0; column < CW; column++) {
        const offset = (row * CW + column) * 4;
        const horizontal = (column - CW / 2) / (CW / 2);
        const radius = Math.min(1, Math.hypot(horizontal, vertical) / (Math.SQRT2 * 0.87));
        const shade = Math.pow(radius, 2.3);
        const lightX = (column - cx) / 220;
        const hotspot = Math.exp(-0.5 * (lightX * lightX + lightY * lightY));
        const fibre = hasWashi
          ? (pixels[offset] * 0.3 + pixels[offset + 1] * 0.59 + pixels[offset + 2] * 0.11 - 208) : 0;
        pixels[offset] = 220 - 105 * shade + 42 * hotspot + fibre * 0.8;
        pixels[offset + 1] = 145 - 83 * shade + 37 * hotspot + fibre * 0.6;
        pixels[offset + 2] = 70 - 48 * shade + 23 * hotspot + fibre * 0.4;
      }
    }
    g.putImageData(paper, 0, 0);
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
    this.perfXrCaption.mesh.visible = false;
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
    this.cutMesh.position.set(cx + st.cx, cy + st.cy, 0.0012);
    this.cutMesh.scale.set(st.w, st.h, 1);
    this.cutMesh.visible = true;
    this.glowMesh.material.map = st.glowTexture;
    this.glowMesh.material.opacity = Math.min(1, (0.25 + glow * 0.9) * (0.94 + 0.06 * Math.sin(time * 3.2)));
    this.glowMesh.position.set(cx + st.cx, cy + st.cy, 0.0008);
    this.glowMesh.scale.set(st.w, st.h, 1);
    this.glowMesh.visible = true;
    perf?.endCall('target', started);
  }

  /** Accumulate a live hand shadow (screen-metre coordinates). */
  shadow(f: FlatHand, blurPixels = 1): void {
    if (!f.valid) return;
    const started = perf ? performance.now() : 0;
    const hand = this.handContext, shadow = this.sctx, quarterScale = PX / SOFT;
    hand.setTransform(1, 0, 0, 1, 0, 0);
    hand.clearRect(0, 0, this.handCanvas.width, this.handCanvas.height);
    hand.setTransform(quarterScale, 0, 0, -quarterScale, this.soft.width / 2, this.soft.height / 2);
    hand.fillStyle = hand.strokeStyle = '#fff';
    hand.lineCap = 'round';
    hand.lineJoin = 'round';
    handPath(hand, f);
    shadow.filter = `blur(${blurPixels.toFixed(1)}px)`;
    shadow.drawImage(this.handCanvas, 0, 0);
    shadow.filter = 'none';
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
  creature(st: Stencil, cx: number, cy: number, scale: number, rot: number, flipX: boolean, blink: boolean, alpha: number,
    wake = 0, time = 0): void {
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
    layer.wake.value = wake;
    layer.time.value = time;
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
        this.drawCaption(this.perfXrCaption, this.xrStatusLine(), 0.8, SCREEN_H / 2 - 0.074, true);
      }
      this.perfCaption.mesh.visible = !!this.perfCaption.text;
      this.perfXrCaption.mesh.visible = !!this.perfXrCaption.text;
    }
    perf?.endCall('end', started);
  }

  private drawCaption(layer: CaptionLayer, text: string, alpha: number, y: number, small: boolean): void {
    if (!small && !this.fontReady) return;
    if (layer.text !== text) {
      const context = layer.ctx;
      context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      const xrPerf = layer === this.perfXrCaption;
      if (xrPerf) {
        context.fillStyle = 'rgba(20,14,12,0.88)';
        context.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
      }
      context.fillStyle = xrPerf ? '#ffe8bd' : '#4a3020';
      context.font = xrPerf ? '27px Arial, sans-serif' : small ? '22px Arial, sans-serif' : 'italic 34px "Playfair Display", Georgia, serif';
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

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
import { FlatHand } from '../shadow/silhouette.js';
import { TARGETS } from '../shadow/targets.js';
import { runtimePerf as perf } from './perf.js';
import { handPath, INK, PIXELS_PER_METRE, rasterStencil, type RasterStencil } from './stencil-raster.js';
import { playfairReady } from './visual-fonts.js';

export const SCREEN_W = 1.0; // metres
export const SCREEN_H = 0.66;
const CW = PIXELS_PER_METRE;
const CH = Math.round((CW * SCREEN_H) / SCREEN_W);
const PX = CW / SCREEN_W; // canvas px per screen metre
const SOFT = 4; // shadow layer downscale (penumbra softness)
export const SHADOW_PX_PER_METRE = PX / SOFT;
const SHADOW_FILTERS = Array.from({ length: 121 }, (_, index) => `blur(${(index / 10).toFixed(1)}px)`);

const INK_COLOR = new Color(INK);
const JOURNEY_INK = new Color('#120c0f');
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

/**
 * Bake-once canvases are CPU-backed (`willReadFrequently`): their WebGL upload then comes from plain
 * memory instead of a GPU canvas-to-texture copy, which on a busy shared GPU sometimes produced
 * opaque white sprite rectangles. Canvases redrawn every frame pass `cpu = false`.
 */
function canvas(w: number, h: number, cpu = true): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: cpu })!];
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
  revealTexture: CanvasTexture;
  /** Sprite size in screen metres; sprite centre in screen metres. */
  w: number;
  h: number;
  cx: number;
  cy: number;
  eyes: [number, number][]; // 0..1 inside the sprite, y down
}

export function makeStencil(hands: FlatHand | FlatHand[], scale: number, eyes: readonly (readonly number[])[]): Stencil {
  return finishStencil(rasterStencil(hands, scale, eyes, canvas));
}

function finishStencil(raster: RasterStencil<HTMLCanvasElement>): Stencil {
  const { ink, cut, glow, reveal, wM, hM, cx, cy, eyePts } = raster;
  const w = ink.width, h = ink.height;
  const revealTexture = new CanvasTexture(reveal);
  revealTexture.generateMipmaps = false;
  revealTexture.minFilter = LinearFilter;
  revealTexture.magFilter = LinearFilter;
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
    cx, cy,
    eyes: eyePts,
    inkOpen: openTexture, inkBlink: texture(eyeSprite(true)),
    cutTexture: texture(cut), glowTexture: texture(glow), revealTexture,
  };
}

export interface StencilPixels {
  width: number;
  height: number;
  wM: number;
  hM: number;
  cx: number;
  cy: number;
  eyePts: [number, number][];
  layers: [ArrayBuffer, ArrayBuffer, ArrayBuffer, ArrayBuffer];
}

export function makeStencilFromPixels(pixels: StencilPixels): Stencil {
  const [ink, cut, glow, reveal] = pixels.layers.map((bytes) => {
    const [source, context] = canvas(pixels.width, pixels.height);
    context.putImageData(new ImageData(new Uint8ClampedArray(bytes), pixels.width, pixels.height), 0, 0);
    return source;
  });
  return finishStencil({ ink, cut, glow, reveal, wM: pixels.wM, hM: pixels.hM,
    cx: pixels.cx, cy: pixels.cy, eyePts: pixels.eyePts });
}

interface CreatureLayer {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  clip: Vector4;
  turn: Vector2;
  wake: { value: number };
  time: { value: number };
  fill: { value: number };
  field: { value: CanvasTexture | null };
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
  private shadowCount = 0;
  private shadowBlur = 0;
  private washi = new Image();
  private fontReady = false;
  private softTexture: CanvasTexture;
  private shadowMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private journeyEyeMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private tone = 1;
  private cutMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private glowMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private reveal = { value: 1 };
  private flare = { value: 0 };
  private revealMap: { value: CanvasTexture | null } = { value: null };
  private creatures: CreatureLayer[] = [];
  private creatureCount = 0;
  private captions: CaptionLayer[] = [];
  private perfCaption: CaptionLayer;
  private perfXrCaption: CaptionLayer;
  private journeyCaption: CaptionLayer;
  private formCaption: CaptionLayer;
  private sparksMesh: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  private sparkTransform = new Object3D();
  private paperX = 0;
  private paperY = -0.2;
  private paperReady = false;
  private progressDone = -1;
  private progressTotal = -1;
  private progressCalled = false;
  private lastPerfText = 0;
  private largeCaptions = false;

  constructor(private readonly xrStatusLine: () => string) {
    [this.canvas, this.ctx] = canvas(CW, CH);
    [this.soft, this.sctx] = canvas(CW / SOFT, Math.round(CH / SOFT), false);
    [this.handCanvas, this.handContext] = canvas(this.soft.width, this.soft.height, false);
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
    for (const mesh of [this.glowMesh, this.cutMesh]) {
      const glowing = mesh === this.glowMesh;
      mesh.material.onBeforeCompile = shader => {
        shader.uniforms.burnProgress = this.reveal;
        shader.uniforms.burnFlare = this.flare;
        shader.uniforms.burnField = this.revealMap;
        shader.vertexShader = `varying vec2 vBurnUv;\n${shader.vertexShader}`
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n            vBurnUv = uv;');
        shader.fragmentShader = `varying vec2 vBurnUv;\nuniform float burnProgress;\nuniform float burnFlare;\nuniform sampler2D burnField;\n${shader.fragmentShader}`
          .replace('#include <map_fragment>', `#include <map_fragment>
            float burnDistance = texture2D(burnField, vBurnUv).r;
            float burnGrain = fract(sin(dot(floor(vBurnUv * vec2(191.0, 137.0)), vec2(127.1, 311.7))) * 43758.5453);
            float burnFront = burnDistance + (burnGrain - 0.5) * 0.055;
            float burnVisible = burnProgress >= 0.999 ? 1.0 : 1.0 - smoothstep(burnProgress - 0.025, burnProgress + 0.025, burnFront);
            float burnEdge = burnProgress >= 0.999 ? 0.0 : 1.0 - smoothstep(0.0, 0.045, abs(burnFront - burnProgress));
            diffuseColor.a *= ${glowing ? 'max(burnVisible, burnEdge * 0.85)' : 'burnVisible'};
            diffuseColor.rgb += vec3(1.2, 0.55, 0.12) * (burnEdge * ${glowing ? '0.75' : '0.35'} + burnFlare * ${glowing ? '1.5' : '0.45'});`);
      };
    }
    this.shadowMesh = this.overlay(3, new PlaneGeometry(SCREEN_W, SCREEN_H));
    this.shadowMesh.material.map = this.softTexture;
    this.shadowMesh.material.color.set(INK);
    for (let index = 0; index < TARGETS.length + 2; index++) {
      const mesh = this.overlay(4, new PlaneGeometry(1, 1));
      const clip = new Vector4();
      const turn = new Vector2(1, 0);
      const wake = { value: 0 };
      const time = { value: 0 };
      const fill = { value: 1 };
      const field: { value: CanvasTexture | null } = { value: null };
      mesh.material.onBeforeCompile = shader => {
        shader.uniforms.paperClip = { value: clip };
        shader.uniforms.paperTurn = { value: turn };
        shader.uniforms.inkWake = wake;
        shader.uniforms.inkTime = time;
        shader.uniforms.inkFill = fill;
        shader.uniforms.inkField = field;
        shader.vertexShader = `uniform vec4 paperClip;\nuniform vec2 paperTurn;\nvarying vec2 vPaperPoint;\nvarying vec2 vInkUv;\n${shader.vertexShader}`
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vInkUv = uv;
            vec2 spritePoint = position.xy * paperClip.zw;
            vPaperPoint = paperClip.xy + vec2(spritePoint.x * paperTurn.x - spritePoint.y * paperTurn.y,
              spritePoint.x * paperTurn.y + spritePoint.y * paperTurn.x);`);
        shader.fragmentShader = `varying vec2 vPaperPoint;\nvarying vec2 vInkUv;\nuniform float inkWake;\nuniform float inkTime;\nuniform float inkFill;\nuniform sampler2D inkField;\n${shader.fragmentShader}`
          .replace('void main() {', `void main() {
            if (abs(vPaperPoint.x) > ${SCREEN_W / 2} || abs(vPaperPoint.y) > ${SCREEN_H / 2}) discard;`)
          .replace('#include <map_fragment>', `#include <map_fragment>
            float edgeBand = smoothstep(0.03, 0.45, diffuseColor.a) * (1.0 - smoothstep(0.55, 0.95, diffuseColor.a));
            float grain = fract(sin(dot(floor(vInkUv * vec2(220.0, 160.0)), vec2(127.1, 311.7))) * 43758.5453);
            float drift = 0.5 + 0.25 * sin(vInkUv.x * 149.0 + inkTime * 4.0)
              + 0.25 * sin(vInkUv.y * 233.0 - inkTime * 2.7);
            diffuseColor.a *= 1.0 - inkWake * edgeBand * smoothstep(0.36, 0.75, grain * 0.5 + drift * 0.5);
            if (inkFill < 0.999) {
              float fillDistance = texture2D(inkField, vInkUv).r;
              diffuseColor.a *= smoothstep(1.0 - inkFill - 0.035, 1.0 - inkFill + 0.035, fillDistance);
            }`);
      };
      this.creatures.push({ mesh, clip, turn, wake, time, fill, field });
    }
    const [sparkCanvas, sparkContext] = canvas(32, 32);
    const sparkGradient = sparkContext.createRadialGradient(16, 16, 0, 16, 16, 16);
    sparkGradient.addColorStop(0, 'rgba(255,255,255,1)');
    sparkGradient.addColorStop(0.45, 'rgba(255,255,255,0.95)');
    sparkGradient.addColorStop(1, 'rgba(255,255,255,0)');
    sparkContext.fillStyle = sparkGradient;
    sparkContext.fillRect(0, 0, 32, 32);
    const sparkTexture = texture(sparkCanvas);
    this.sparksMesh = new InstancedMesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      map: sparkTexture, transparent: true, depthWrite: false,
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
    this.journeyEyeMesh = this.overlay(10, new PlaneGeometry(1, 1), true);
    this.journeyEyeMesh.material.map = sparkTexture;
    this.journeyEyeMesh.material.color.set('#ffcc80');
    this.journeyEyeMesh.scale.setScalar(0.043);
    for (let index = 0; index < 5; index++) this.captions.push(this.makeCaption(CW, CAPTION_H, 6));
    this.perfCaption = this.makeCaption(420, 48, 7);
    this.perfXrCaption = this.makeCaption(980, 42, 7);
    this.journeyCaption = this.makeCaption(580, 44, 7);
    this.formCaption = this.makeCaption(220, 58, 10);
    this.washi.onload = () => this.renderPaper();
    this.washi.src = `${import.meta.env?.BASE_URL ?? './'}textures/washi.jpg`;
    void playfairReady.then(ready => { this.fontReady = ready; });
    this.paintPaper(0, -0.2);
  }

  private overlay(order: number, geometry: PlaneGeometry, additive = false): Mesh<PlaneGeometry, MeshBasicMaterial> {
    const material = new MeshBasicMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      ...(additive ? { blending: AdditiveBlending } : {}),
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
    this.tone = value;
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

  setLargeCaptions(value: boolean): void { this.largeCaptions = value; }

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

  begin(skipShadowClear = false): void {
    const started = perf ? performance.now() : 0;
    this.cutMesh.visible = false;
    this.glowMesh.visible = false;
    this.shadowMesh.visible = false;
    for (let index = 0; index < this.creatureCount; index++) this.creatures[index].mesh.visible = false;
    this.creatureCount = 0;
    this.sparksMesh.visible = false;
    this.journeyEyeMesh.visible = false;
    this.formCaption.mesh.visible = false;
    for (let index = 0; index < this.captions.length; index++) this.captions[index].mesh.visible = false;
    this.perfCaption.mesh.visible = false;
    this.perfXrCaption.mesh.visible = false;
    this.journeyCaption.mesh.visible = false;
    this.progressCalled = false;
    if (!skipShadowClear) {
      const s = this.sctx;
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.clearRect(0, 0, this.soft.width, this.soft.height);
      this.handContext.setTransform(1, 0, 0, 1, 0, 0);
      this.handContext.clearRect(0, 0, this.handCanvas.width, this.handCanvas.height);
    }
    this.shadowCount = 0;
    perf?.endCall('begin', started);
  }

  /** Cut-out of the creature to match, glowing with closeness. */
  target(st: Stencil, cx: number, cy: number, glow: number, time: number, reveal = 1, flare = 0): void {
    const started = perf ? performance.now() : 0;
    this.reveal.value = Math.max(0, Math.min(1, reveal));
    this.flare.value = Math.max(0, Math.min(1, flare));
    this.revealMap.value = st.revealTexture;
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
    const hand = this.handContext, quarterScale = SHADOW_PX_PER_METRE;
    if (this.shadowCount && Math.abs(blurPixels - this.shadowBlur) > 0.75) {
      this.paintShadowMask();
      hand.setTransform(1, 0, 0, 1, 0, 0);
      hand.clearRect(0, 0, this.handCanvas.width, this.handCanvas.height);
    }
    hand.setTransform(quarterScale, 0, 0, -quarterScale, this.soft.width / 2, this.soft.height / 2);
    hand.fillStyle = hand.strokeStyle = '#fff';
    hand.lineCap = 'round';
    hand.lineJoin = 'round';
    handPath(hand, f);
    this.shadowBlur = (this.shadowBlur * this.shadowCount + blurPixels) / (this.shadowCount + 1);
    this.shadowCount++;
    perf?.endCall('shadow', started);
  }

  private paintShadowMask(): void {
    if (!this.shadowCount) return;
    this.sctx.filter = SHADOW_FILTERS[Math.max(0, Math.min(120, Math.round(this.shadowBlur * 10)))];
    this.sctx.drawImage(this.handCanvas, 0, 0);
    this.sctx.filter = 'none';
    this.shadowCount = 0;
  }

  /** Upload just the quarter-size shadow layer for GPU bilinear upscaling. */
  flushShadows(alpha: number): void {
    const started = perf ? performance.now() : 0;
    this.paintShadowMask();
    this.shadowMesh.material.opacity = alpha;
    this.shadowMesh.visible = true;
    this.softTexture.needsUpdate = true;
    perf?.endCall('flushShadows', started);
  }

  possess(x: number, y: number, alpha: number): void {
    this.shadowMesh.material.color.copy(INK_COLOR).lerp(JOURNEY_INK, alpha).multiplyScalar(this.tone);
    this.journeyEyeMesh.position.set(x, y, 0.004);
    this.journeyEyeMesh.scale.y = 0.043 * Math.max(0.05, alpha);
    this.journeyEyeMesh.material.opacity = alpha * this.tone;
    this.journeyEyeMesh.visible = alpha > 0 && Math.abs(x) <= SCREEN_W / 2 && Math.abs(y) <= SCREEN_H / 2;
  }

  formName(text: string, x: number, y: number, alpha: number): void {
    if (alpha <= 0 || !this.fontReady) return;
    this.drawCaption(this.formCaption, text, alpha, y, false);
    this.formCaption.mesh.position.x = Math.max(-0.38, Math.min(0.38, x));
  }

  /** A woken creature: ink silhouette with a blinking eye. */
  creature(st: Stencil, cx: number, cy: number, scale: number, rot: number, flipX: boolean, blink: boolean, alpha: number,
    wake = 0, time = 0, stretchX = 1, stretchY = 1, fill = 1): void {
    const started = perf ? performance.now() : 0;
    if (this.creatureCount >= this.creatures.length) return;
    const layer = this.creatures[this.creatureCount++];
    const width = st.w * scale * stretchX;
    const height = st.h * scale * stretchY;
    const x = cx + st.cx * scale * stretchX;
    const y = cy + st.cy * scale * stretchY;
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
    layer.fill.value = fill;
    layer.field.value = st.revealTexture;
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

  journeyDebug(text: string): void {
    this.drawCaption(this.journeyCaption, text, 0.92, SCREEN_H / 2 - 0.115, true);
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
    const textKey = !small && this.largeCaptions ? `large:${text}` : text;
    if (layer.text !== textKey) {
      const context = layer.ctx;
      context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      const xrPerf = layer === this.perfXrCaption || layer === this.journeyCaption;
      if (xrPerf) {
        context.fillStyle = 'rgba(20,14,12,0.88)';
        context.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
      }
      context.fillStyle = xrPerf ? '#ffe8bd' : layer === this.formCaption ? '#23160f' : '#4a3020';
      context.font = xrPerf ? '27px Arial, sans-serif' : small ? '22px Arial, sans-serif'
        : layer === this.formCaption ? 'italic 29px "Playfair Display", Georgia, serif'
        : `italic ${this.largeCaptions ? 51 : 34}px "Playfair Display", Georgia, serif`;
      context.textAlign = small ? 'left' : 'center';
      context.textBaseline = 'middle';
      context.fillText(text, small ? 12 : layer.canvas.width / 2, layer.canvas.height / 2);
      layer.mesh.material.map!.needsUpdate = true;
      layer.text = textKey;
    }
    layer.y = y;
    layer.mesh.position.x = small ? -SCREEN_W / 2 + layer.canvas.width / (2 * PX) + 0.012 : 0;
    layer.mesh.position.y = y;
    layer.mesh.material.opacity = alpha;
    layer.mesh.visible = true;
  }
}

/**
 * The hand-shadow theater. A lantern sits between the player and a paper
 * screen; tracked hands cast live shadows. Each cut-out on the paper is a
 * creature waiting for the right shadow: hold your hands so the shadow fits
 * and it wakes, blinks and walks off into the night's story.
 */
import { Color, Matrix4, Quaternion, Vector3, VisibilityState, createSystem } from '@iwsdk/core';
import {
  HandPose, JOINT_COUNT, JOINT_NAMES, basePoses, mirror,
} from '../shadow/hand-model.js';
import {
  FlatHand, Mask, Matcher, STAGE, ScreenFrame, drawHand, projectFromLight,
} from '../shadow/silhouette.js';
import { BakedTarget, TARGETS, bakeTarget } from '../shadow/targets.js';
import { TheaterAudio } from './audio.js';
import { runtimePerf as perf } from './perf.js';
import { SCREEN_H, SCREEN_W, ScreenPainter, Stencil, makeStencil } from './painter.js';
import { GhostHand, Lantern, PaperScreen, buildLantern, buildScreen } from './stage.js';

const TARGET_CY = 0.02;
/** Lantern placement relative to the seated head: ahead and below the eyes. */
const LANTERN_AHEAD = 0.25;
const LANTERN_DROP = 0.25;
const HOLD_TO_WAKE = 0.55; // seconds the fit must hold
const WAKE_TIME = 3.6;
const REST_TIME = 0.9;
const FINALE_TIME = 9;
const HINT_AFTER = 7;
const NIGHT_LENGTH = TARGETS.length;
const FINALE_CAPTION = `${NIGHT_LENGTH} shadows woke tonight.`;
const STORE_KEY = 'shadow-theater.v1';

enum Phase { Seek, Wake, Rest, Finale }

interface LiveHand {
  joints: Float32Array;
  radii: Float32Array;
  flat: FlatHand;
  valid: boolean;
  lastSeen: number;
}

interface Saved { nights: number; woken: Record<string, number> }

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const candidate = value as Partial<Saved>;
        const nights = Number.isSafeInteger(candidate.nights) && candidate.nights! >= 0 ? candidate.nights! : 0;
        const woken: Record<string, number> = {};
        if (candidate.woken && typeof candidate.woken === 'object' && !Array.isArray(candidate.woken)) {
          for (const target of TARGETS) {
            const count = candidate.woken[target.id];
            if (Number.isSafeInteger(count) && count >= 0) woken[target.id] = count;
          }
        }
        return { nights, woken };
      }
    }
  } catch { /* private mode: play without memory */ }
  return { nights: 0, woken: {} };
}

function save(s: Saved): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class TheaterSystem extends createSystem({}) {
  private painter!: ScreenPainter;
  private audio = new TheaterAudio();
  private lantern!: Lantern;
  private screen!: PaperScreen;
  private ghost!: GhostHand;
  private puppeteer!: GhostHand; // visible demo hand in the browser preview
  private baked!: BakedTarget[];
  private stencils!: Stencil[];

  private frame: ScreenFrame = { ox: 0, oy: 0, oz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, nx: 0, ny: 0, nz: 1 };
  private lanternPos = new Vector3();
  private anchor = new Vector3(); // where a hand naturally casts a centred shadow
  private placed = false;
  private placeAt = 0;
  private placedHead = new Vector3();
  private drift = 0; // seconds the head has been far from where the stage was placed

  private hands: LiveHand[] = [];
  private allHands: LiveHand[] = [];
  private mirrored: HandPose[] = [];
  private demoHand!: LiveHand;
  private live = new Mask(170, 120, -0.68, -0.48, 0.008);
  private matcher = new Matcher();

  private phase = Phase.Seek;
  private phaseTime = 0;
  private order: number[] = [];
  private step = 0; // index into order
  private score = 0;
  private hold = 0;
  private stuck = 0;
  private handsSeenAt = -1;
  private saved: Saved = loadSaved();
  private demo = false;
  private immersive = false;
  private visible = true;
  private resumeFrame = false;
  private handMask = 0;
  private animationTime = 0;
  private night = new Color('#140e0c');

  // Scratch, allocated once.
  private v0 = new Vector3();
  private v1 = new Vector3();
  private v2 = new Vector3();
  private q0 = new Quaternion();
  private m0 = new Matrix4();
  private posePositions = new Float32Array(JOINT_COUNT * 3);
  private demoFrom!: HandPose;
  private ghostPose!: HandPose;

  init(): void {
    this.demo = new URLSearchParams(location.search).has('demo');
    this.painter = new ScreenPainter();
    this.lantern = buildLantern();
    this.screen = buildScreen(this.painter.texture);
    this.ghost = new GhostHand();
    this.puppeteer = new GhostHand('DemoHand', '#c99877', true);
    for (const o of [this.lantern.root, this.screen.root, this.ghost.root, this.puppeteer.root]) {
      this.world.createTransformEntity(o);
    }
    this.baked = TARGETS.map(bakeTarget);
    this.stencils = this.baked.map((b) =>
      makeStencil(b.flat, 1, b.def.eyes));
    const mk = (): LiveHand => ({
      joints: new Float32Array(JOINT_COUNT * 3), radii: new Float32Array(JOINT_COUNT),
      flat: new FlatHand(), valid: false, lastSeen: -1,
    });
    this.hands = [mk(), mk()];
    this.demoHand = mk();
    this.allHands = [...this.hands, this.demoHand];
    this.mirrored = this.baked.map((b) => mirror(b.pose));
    this.demoFrom = basePoses.relaxed();
    this.ghostPose = basePoses.relaxed();
    this.newNight();

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const wasImmersive = this.immersive;
        this.immersive = state !== VisibilityState.NonImmersive;
        // Night backdrop for the browser preview; passthrough shows the room in XR.
        this.scene.background = this.immersive ? null : this.night;
        if (this.immersive !== wasImmersive) {
          this.resetTracking();
          this.placed = false;
          // The next update establishes the deadline in the world's clock domain.
          this.placeAt = this.immersive ? -1 : 0;
          this.handsSeenAt = -1;
          this.resumeFrame = true;
        }
        this.syncVisibility();
      }),
    );
    const onVisibility = () => this.syncVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanupFuncs.push(() => document.removeEventListener('visibilitychange', onVisibility));
    const unlock = () => { if (this.visible) this.audio.start(); };
    window.addEventListener('pointerdown', unlock);
    this.cleanupFuncs.push(() => window.removeEventListener('pointerdown', unlock), () => this.audio.dispose());
  }

  /** System menus and background tabs pause the night without moving the rig. */
  private syncVisibility(): void {
    const state = this.world.visibilityState.peek();
    const visible = !document.hidden && (state === VisibilityState.NonImmersive || state === VisibilityState.Visible);
    if (visible === this.visible) {
      if (visible && this.immersive) this.audio.start();
      return;
    }
    this.visible = visible;
    this.resumeFrame = true;
    this.resetTracking();
    if (visible) this.audio.start(); else this.audio.pause();
  }

  private resetTracking(): void {
    this.hold = 0;
    this.score = 0;
    this.handMask = 0;
    this.drift = 0;
    for (const hand of this.allHands) { hand.valid = false; hand.flat.valid = false; }
    this.ghost.opacity = 0;
    this.puppeteer.opacity = 0;
    this.audio.setHold(0);
  }

  /** Seeded order for tonight; the very first night opens with the open hand. */
  private newNight(): void {
    const n = TARGETS.length;
    const idx = Array.from({ length: n }, (_, i) => i);
    let seed = (Math.floor(Date.now() / 86400000) * 7919 + this.saved.nights * 104729) % 2147483647 || 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    if (this.saved.nights === 0) {
      const open = TARGETS.findIndex((t) => t.id === 'peacock');
      idx.splice(idx.indexOf(open), 1);
      idx.unshift(open);
    }
    this.order = idx.slice(0, NIGHT_LENGTH);
    this.step = 0;
    this.enter(Phase.Seek);
  }

  private enter(p: Phase): void {
    this.phase = p;
    this.phaseTime = 0;
    this.hold = 0;
    this.stuck = 0;
    this.score = 0;
    if (p === Phase.Seek) this.audio.rustle();
  }

  /** Put the stage in front of the viewer: lantern near, screen beyond. */
  private place(): void {
    const cam = this.camera;
    cam.updateMatrixWorld(true);
    const head = cam.getWorldPosition(this.v0);
    const fwd = this.v1.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(this.q0));
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    if (!this.immersive) {
      // Browser preview: frame the whole theater from a seat slightly behind.
      head.set(0, 1.2, 0);
      fwd.set(0, 0, -1);
    }
    this.placedHead.copy(head);
    this.drift = 0;
    const up = this.v2.set(0, 1, 0);
    const right = new Vector3().crossVectors(fwd, up).normalize();
    const centre = head.clone().addScaledVector(fwd, LANTERN_AHEAD + STAGE.lightToScreen)
      .addScaledVector(up, -LANTERN_DROP + STAGE.lightDrop - TARGET_CY);
    this.lanternPos.copy(head).addScaledVector(fwd, LANTERN_AHEAD).addScaledVector(up, -LANTERN_DROP);
    this.lantern.root.position.copy(this.lanternPos);
    this.screen.root.position.copy(centre);
    this.screen.root.lookAt(centre.clone().sub(fwd));
    const f = this.frame;
    f.ox = centre.x; f.oy = centre.y; f.oz = centre.z;
    f.rx = right.x; f.ry = right.y; f.rz = right.z;
    f.ux = 0; f.uy = 1; f.uz = 0;
    f.nx = -fwd.x; f.ny = -fwd.y; f.nz = -fwd.z;
    // Natural hand spot: on the lantern-to-cut-out line, at the baked distance.
    const cut = centre.clone().addScaledVector(up, TARGET_CY);
    this.anchor.copy(this.lanternPos).lerp(cut, STAGE.lightToHand / STAGE.lightToScreen);
    const lx = (this.lanternPos.x - f.ox) * f.rx + (this.lanternPos.y - f.oy) * f.ry + (this.lanternPos.z - f.oz) * f.rz;
    const ly = (this.lanternPos.y - f.oy);
    this.painter.paintPaper(lx, ly);
    this.placed = true;
  }

  /** Copy tracked hand joints (world space) from the current XR frame. */
  private readHands(time: number): void {
    for (const h of this.hands) h.valid = false;
    const xr = this.renderer.xr;
    const frame = xr.getFrame?.() as XRFrame | undefined;
    const ref = xr.getReferenceSpace?.();
    if (!frame || !ref || !frame.getJointPose) return;
    this.player.updateMatrixWorld(true);
    const e = this.player.matrixWorld.elements;
    for (const src of frame.session.inputSources) {
      if (!src.hand || (src.handedness !== 'left' && src.handedness !== 'right')) continue;
      const h = this.hands[src.handedness === 'left' ? 0 : 1];
      let ok = true;
      try {
        for (let j = 0; j < JOINT_COUNT; j++) {
          const space = src.hand.get(JOINT_NAMES[j] as XRHandJoint);
          const pose = space ? frame.getJointPose(space, ref) : undefined;
          if (!pose) { ok = false; break; }
          const p = pose.transform.position;
          const radius = pose.radius ?? 0.01;
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z) || !Number.isFinite(radius) || radius <= 0) {
            ok = false; break;
          }
          h.joints[j * 3] = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
          h.joints[j * 3 + 1] = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
          h.joints[j * 3 + 2] = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
          h.radii[j] = radius;
        }
      } catch {
        // A source/reference space can become stale as a session ends.
        ok = false;
      }
      h.valid = ok;
      if (ok) h.lastSeen = time;
    }
  }

  /** Lay a hand-space pose out in the world around the anchor, facing the lantern. */
  private poseToWorld(p: HandPose, out: Float32Array, lift: number): void {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < JOINT_COUNT; j++) {
      cx += p.mats[j * 16 + 12]; cy += p.mats[j * 16 + 13]; cz += p.mats[j * 16 + 14];
    }
    cx /= JOINT_COUNT; cy /= JOINT_COUNT; cz /= JOINT_COUNT;
    const f = this.frame, a = this.anchor;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const x = p.mats[j * 16 + 12] - cx, y = p.mats[j * 16 + 13] - cy + lift, z = p.mats[j * 16 + 14] - cz;
      out[j * 3] = a.x + x * f.rx + y * f.ux + z * f.nx;
      out[j * 3 + 1] = a.y + x * f.ry + y * f.uy + z * f.ny;
      out[j * 3 + 2] = a.z + x * f.rz + y * f.uz + z * f.nz;
    }
  }

  /** Browser/demo hand: eases from a relaxed hand into tonight's shape. */
  private driveDemo(target: BakedTarget, t: number): void {
    const k = this.phase === Phase.Seek ? ease((this.phaseTime - 1.0) / 2.2) : 1;
    const drop = this.phase === Phase.Seek ? 0 : -ease(this.phaseTime / 0.8) * 0.25;
    const from = this.demoFrom.mats, to = target.pose.mats, pos = this.posePositions;
    // Interpolate joint positions only; the pose's own matrices stay untouched.
    const tmp = this.ghostPose;
    for (let i = 0; i < from.length; i++) tmp.mats[i] = from[i] + (to[i] - from[i]) * k;
    tmp.radii.set(target.pose.radii);
    this.poseToWorld(tmp, pos, drop + 0.012 * Math.sin(t * 1.3));
    // A touch of drift so the shadow breathes like a real hand.
    for (let j = 0; j < JOINT_COUNT; j++) pos[j * 3] += 0.006 * Math.sin(t * 0.9);
    this.demoHand.joints.set(pos);
    this.demoHand.radii.set(target.pose.radii);
    this.demoHand.valid = this.phase !== Phase.Finale;
  }

  update(delta: number, time: number): void {
    const started = perf?.beginFrame();
    try {
      this.updateFrame(delta, time);
    } finally {
      if (started !== undefined) perf!.endFrame(started, this.phase);
    }
  }

  private updateFrame(delta: number, time: number): void {
    if (!this.visible) return;
    const dt = this.resumeFrame ? 0 : Math.max(0, Math.min(delta, 0.05));
    this.resumeFrame = false;
    this.animationTime += dt;
    if (this.placeAt < 0) this.placeAt = time + 0.5;
    if (!this.placed && time >= this.placeAt) this.place();
    if (!this.placed) return;
    if (this.immersive) {
      // Seated play: if the player settles somewhere else, bring the stage along.
      const d = this.camera.getWorldPosition(this.v0).distanceTo(this.placedHead);
      this.drift = d > 0.3 ? this.drift + dt : 0;
      if (this.drift > 1.5) this.place();
    } else {
      // Browser preview keeps a fixed theater-seat view.
      this.camera.position.set(0.3, 1.34, 0.42);
      this.camera.lookAt(0.0, 1.06, -0.62);
    }

    this.readHands(time);
    const handMask = (this.hands[0].valid ? 1 : 0) | (this.hands[1].valid ? 2 : 0);
    if (this.handMask & ~handMask) {
      // Tracking loss breaks a continuous hold, including loss of just one hand.
      this.score = 0;
      this.hold = 0;
      this.audio.setHold(0);
    }
    this.handMask = handMask;
    const anyReal = handMask !== 0;
    if (anyReal) this.handsSeenAt = time;
    else if (this.handsSeenAt < 0) this.handsSeenAt = time;
    const useDemo = this.demo || (!this.immersive && !anyReal);
    this.phaseTime += dt;

    const target = this.baked[this.order[this.step % this.order.length]];
    const stencil = this.stencils[this.order[this.step % this.order.length]];
    if (useDemo) this.driveDemo(target, this.animationTime); else this.demoHand.valid = false;
    this.puppeteer.opacity = this.demoHand.valid ? 1 : 0;
    if (this.demoHand.valid) this.puppeteer.update(this.demoHand.joints, this.demoHand.radii);

    // Lantern flicker.
    const flick = 0.92 + 0.05 * Math.sin(this.animationTime * 7.3) + 0.03 * Math.sin(this.animationTime * 17.1);
    this.lantern.bodyMat.color.setRGB(1 * flick, 0.81 * flick, 0.54 * flick);
    this.lantern.halo.scale.setScalar(0.24 + 0.02 * flick);

    // Shadows: project every hand from the lantern onto the paper.
    const p = this.painter;
    p.begin();
    this.live.clear();
    let casting = false;
    const L = this.lanternPos;
    for (const h of this.allHands) {
      if (!h.valid) continue;
      projectFromLight(h.joints, h.radii, L.x, L.y, L.z, this.frame, h.flat);
      if (!h.flat.valid) continue;
      drawHand(this.live, h.flat);
      casting = true;
    }

    switch (this.phase) {
      case Phase.Seek: this.seek(target, stencil, casting, dt, this.animationTime); break;
      case Phase.Wake: this.wake(target, stencil, this.animationTime); break;
      case Phase.Rest:
        if (this.phaseTime >= REST_TIME) this.enter(Phase.Seek);
        break;
      case Phase.Finale: this.finale(this.animationTime); break;
    }

    for (const h of this.allHands) if (h.valid && h.flat.valid) p.shadow(h.flat);
    p.flushShadows(this.phase === Phase.Wake ? 0.35 : 0.9);
    if (this.phase !== Phase.Finale) p.progress(this.step, NIGHT_LENGTH);

    if (this.immersive && !anyReal && time - this.handsSeenAt > 2 && !this.demo) {
      p.caption('Set the controllers down. Just your hands.', 1, 0.27);
    }
    p.end();
  }

  private seek(target: BakedTarget, stencil: Stencil, casting: boolean, dt: number, time: number): void {
    const raw = casting ? this.matcher.score(this.live, target.template) : 0;
    this.score += (raw - this.score) * Math.min(1, dt * 10);
    const close = Math.max(0, Math.min(1, (this.score - 0.3) / (target.pass - 0.3)));
    if (!casting) { this.score = 0; this.hold = 0; }
    if (casting && this.score >= target.pass) this.hold += dt;
    else this.hold = Math.max(0, this.hold - dt * 1.5);
    this.audio.setHold(casting ? close * close : 0);

    const glow = close * close + (this.hold > 0 ? 0.4 * this.hold / HOLD_TO_WAKE : 0);
    this.painter.target(stencil, 0, TARGET_CY, glow, time);

    // First moment of the first night: one short invitation, no menus.
    if (this.saved.nights === 0 && this.step === 0) {
      this.painter.caption(casting ? 'Fit your shadow to the shape.' : 'Lift a hand into the lantern light.', 1);
    }

    // Stuck? Fade in the ghost hand that shows the shape.
    if (close < 0.85) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    const hint = ease((this.stuck - HINT_AFTER) / 1.5);
    if (hint > 0 && !this.demo) {
      const right = this.hands[1].valid || !this.hands[0].valid;
      const pose = right ? this.mirrored[this.baked.indexOf(target)] : target.pose;
      this.poseToWorld(pose, this.posePositions, 0.0);
      this.ghost.update(this.posePositions, pose.radii);
    }
    this.ghost.opacity = this.demo ? 0 : hint * (0.28 + 0.08 * Math.sin(time * 3));

    if (this.hold >= HOLD_TO_WAKE) {
      this.audio.setHold(0);
      this.audio.chime(this.step);
      this.saved.woken[target.def.id] = (this.saved.woken[target.def.id] ?? 0) + 1;
      save(this.saved);
      this.ghost.opacity = 0;
      this.enter(Phase.Wake);
    }
  }

  private wake(target: BakedTarget, stencil: Stencil, time: number): void {
    const t = this.phaseTime;
    let x = 0, y = TARGET_CY, rot = 0, sc = 1;
    switch (target.def.motion) {
      case 'hop': x = Math.max(0, t - 0.9) * 0.16; y += Math.abs(Math.sin(Math.max(0, t - 0.9) * Math.PI * 1.6)) * 0.07; break;
      case 'swim': x = Math.max(0, t - 0.8) * 0.2; y += Math.sin(t * 4) * 0.018; rot = Math.cos(t * 4) * 0.08; break;
      case 'crawl': x = Math.max(0, t - 0.8) * 0.07; sc = 1 + 0.025 * Math.sin(t * 7); break;
      case 'bob': x = Math.max(0, t - 0.8) * 0.06; y += Math.sin(t * 5) * 0.014; rot = Math.sin(t * 5) * 0.07; break;
      case 'fan': sc = 1 + 0.07 * Math.sin(t * 3); rot = Math.sin(t * 2) * 0.04; break;
    }
    const alpha = t < 2.8 ? 1 : 1 - ease((t - 2.8) / 0.8);
    const blink = (t > 1.3 && t < 1.42) || (t > 2.3 && t < 2.38);
    this.painter.creature(stencil, x, y, sc, rot, false, blink, alpha);
    if (t < 1.2) this.painter.sparks(0, TARGET_CY, t / 1.2, 1);
    const capA = Math.min(ease((t - 0.4) / 0.5), 1 - ease((t - 3.0) / 0.6));
    this.painter.caption(target.def.line, capA);
    if (t >= WAKE_TIME) {
      this.step++;
      if (this.step >= NIGHT_LENGTH) {
        this.saved.nights++;
        save(this.saved);
        this.enter(Phase.Finale);
      } else {
        this.enter(Phase.Rest);
      }
    }
    void time;
  }

  private finale(time: number): void {
    const t = this.phaseTime;
    const n = this.order.length;
    for (let k = 0; k < n; k++) {
      const st = this.stencils[this.order[k]];
      const x = -SCREEN_W / 2 - 0.1 + ((t * 0.18 + k * (SCREEN_W + 0.2) / n) % (SCREEN_W + 0.2));
      const y = -0.02 + Math.abs(Math.sin(t * 3 + k)) * 0.02;
      this.painter.creature(st, x, y, 0.42, 0, false, Math.sin(time * 2 + k * 1.7) > 0.97, 0.9);
    }
    const a = Math.min(ease(t / 0.8), 1 - ease((t - FINALE_TIME + 1) / 1));
    this.painter.caption(FINALE_CAPTION, a, 0.2);
    this.painter.caption('Come back after dark for new shapes.', a * 0.8, -0.24);
    if (t >= FINALE_TIME) this.newNight();
  }
}

void SCREEN_H;

/**
 * The hand-shadow theater. A lantern sits between the player and a paper
 * screen; tracked hands cast live shadows. Each cut-out on the paper is a
 * creature waiting for the right shadow: hold your hands so the shadow fits
 * and it wakes, blinks and walks off into the night's story.
 */
import {
  Box3, Color, Matrix4, MeshBasicMaterial, PointLight, Quaternion, Vector3, VisibilityState, XRMesh, XRPlane, createSystem,
} from '@iwsdk/core';
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
import { RigAnchor } from './anchor.js';
import { LANTERN_ON_TABLE, Surface, TableFit, WallFit, fitPinWall, fitTable, fitWall } from './room.js';
import { GhostHand, Lantern, PaperScreen, RoomDim, buildLantern, buildRoomDim, buildScreen } from './stage.js';
import { captureControl } from '../capture.js';
import { PreviewRoom } from './preview-room.js';
import { WallLayer } from './wall.js';

const TARGET_CY = 0.02;
/** Lantern placement relative to the seated head: ahead and below the eyes. */
const LANTERN_AHEAD = 0.25;
const LANTERN_DROP = 0.25;
const HOLD_TO_WAKE = 0.55; // seconds the fit must hold
const WAKE_TIME = 3.2;
/** Wake timeline: the creature comes alive in place, then walks off the paper. */
const WALK_AT = 1.5;
const WALK_TIME = 1.2;
const SETTLE_TIME = 0.9;
/** Seconds after entering XR during which the room may still reshape the stage. */
const FIT_WINDOW = 6;
/** Pinned paper hangs this far in front of the real wall. */
const PIN_STANDOFF = 0.015;
const LANTERN_STAND = LANTERN_ON_TABLE - 0.053;
type RigMode = 'float' | 'table' | 'pinned';
const REST_TIME = 0.9;
const FINALE_TIME = 9;
const HINT_AFTER = 7;
/** Shapes per night; a new creature joins each night until all are known. */
const NIGHT_LENGTH = Math.min(5, TARGETS.length);
const FIRST_NIGHT = NIGHT_LENGTH;
const FINALE_CAPTION = `${NIGHT_LENGTH} shadows woke tonight.`;
/** Lantern brightness before the first hand reaches its light. */
const EMBER = 0.18;
const STORE_KEY = 'shadow-theater.v1';

enum Phase { Seek, Wake, Rest, Finale }

interface LiveHand {
  joints: Float32Array;
  radii: Float32Array;
  flat: FlatHand;
  valid: boolean;
  lastSeen: number;
}

interface Saved { nights: number; woken: Record<string, number>; order?: string[] }

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

const ZERO3 = [0, 0, 0] as const;
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class TheaterSystem extends createSystem({
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private painter!: ScreenPainter;
  private audio = new TheaterAudio();
  private lantern!: Lantern;
  private screen!: PaperScreen;
  private ghost!: GhostHand;
  private ghost2!: GhostHand; // second hint hand for two-hand creatures
  private puppeteer!: GhostHand; // visible demo hand in the browser preview
  private puppeteer2!: GhostHand;
  private baked!: BakedTarget[];
  private stencils!: Stencil[];

  private frame: ScreenFrame = { ox: 0, oy: 0, oz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, nx: 0, ny: 0, nz: 1 };
  private lanternPos = new Vector3();
  private screenCentre = new Vector3();
  private fwd = new Vector3(0, 0, -1);
  private right = new Vector3(1, 0, 0);
  private anchor = new Vector3(); // where a hand naturally casts a centred shadow
  private placed = false;
  private placeAt = 0;
  private placedHead = new Vector3();
  private drift = 0; // seconds the head has been far from where the stage was placed
  private paperKey = NaN;

  // Room awareness: a table to stand on, a wall to live on, an anchor to return to.
  private wall = new WallLayer();
  private preview = new PreviewRoom(); // stand-in room for the browser preview
  private dim!: RoomDim; // theater lights down over the passthrough room
  /** The lantern really lights the props near it (stand, frame, preview table and wall). */
  private glowLight = new PointLight(new Color('#ffb46e'), 0, 4, 2);
  private rigAnchor = new RigAnchor();
  private table: TableFit | null = null;
  private mode: RigMode = 'float';
  private pinWall: WallFit | null = null;
  private defaultLantern = new Vector3();
  private settle: { from: Vector3; to: Vector3; fromFwd: Vector3; toFwd: Vector3; t0: number } | null = null;
  private fitUntil = 0;
  private nextFit = 0;
  private visibleAt = 0;
  private restore: 'idle' | 'pending' | 'ready' | 'none' = 'idle';
  private anchored = false;
  private leapt = false;
  private now = 0;
  private reported = new Set<string>();
  private lit = 1; // lantern brightness 0..1
  private litTarget = 1;
  private awaitingLight = false;
  private sessionAt = -1;
  private voiced = false;
  private oneHand = 0; // seconds a two-hand creature has seen only one shadow
  private fresh = -1; // index into TARGETS of tonight's newly joined creature
  private finaleX = new Float32Array(16);
  private aPos = new Vector3();
  private aQuat = new Quaternion();

  private hands: LiveHand[] = [];
  private allHands: LiveHand[] = [];
  private mirrored: HandPose[] = [];
  private demoHand!: LiveHand;
  private demoHand2!: LiveHand;
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
  private v3 = new Vector3();
  private q1v = new Vector3();
  private q0 = new Quaternion();
  private m0 = new Matrix4();
  private posePositions = new Float32Array(JOINT_COUNT * 3);
  private demoFrom!: HandPose;
  private demoFrom2!: HandPose;
  private ghostPose!: HandPose;
  private ghostPose2!: HandPose;
  private posePositions2 = new Float32Array(JOINT_COUNT * 3);

  init(): void {
    this.demo = new URLSearchParams(location.search).has('demo');
    this.painter = new ScreenPainter();
    this.lantern = buildLantern();
    this.dim = buildRoomDim();
    this.screen = buildScreen(this.painter);
    this.ghost = new GhostHand();
    this.ghost2 = new GhostHand('GhostHand2');
    this.puppeteer = new GhostHand('DemoHand', '#c99877', true);
    this.puppeteer2 = new GhostHand('DemoHand2', '#c99877', true);
    for (const o of [this.lantern.root, this.screen.root, this.ghost.root, this.ghost2.root,
      this.puppeteer.root, this.puppeteer2.root, this.wall.root, this.preview.root, this.dim.mesh, this.glowLight]) {
      this.world.createTransformEntity(o);
    }
    this.baked = TARGETS.map(bakeTarget);
    this.stencils = this.baked.map((b) =>
      makeStencil(b.flats, 1, b.def.eyes));
    const mk = (): LiveHand => ({
      joints: new Float32Array(JOINT_COUNT * 3), radii: new Float32Array(JOINT_COUNT),
      flat: new FlatHand(), valid: false, lastSeen: -1,
    });
    this.hands = [mk(), mk()];
    this.demoHand = mk();
    this.demoHand2 = mk();
    this.allHands = [...this.hands, this.demoHand, this.demoHand2];
    this.mirrored = this.baked.map((b) => mirror(b.pose));
    this.demoFrom = basePoses.relaxed();
    this.demoFrom2 = mirror(basePoses.relaxed());
    this.ghostPose = basePoses.relaxed();
    this.ghostPose2 = basePoses.relaxed();
    this.wall.onSettle = () => this.audio.settle();
    const cap = captureControl();
    if (cap) this.audio.onCue = (kind, arg) => cap.cues.push({ t: cap.time, kind, arg });
    this.newNight();
    if (import.meta.env?.DEV) (window as unknown as { __theater: unknown }).__theater = this;

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const wasImmersive = this.immersive;
        this.immersive = state !== VisibilityState.NonImmersive;
        // Night backdrop for the browser preview; passthrough shows the room in XR.
        this.scene.background = this.immersive ? null : this.night;
        this.preview.root.visible = !this.immersive;
        if (this.immersive !== wasImmersive) {
          this.resetTracking();
          this.handsSeenAt = -1;
          this.resumeFrame = true;
          if (this.immersive) {
            this.beginSession();
          } else {
            this.placed = false;
            this.placeAt = 0;
            this.endSession();
          }
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
    this.ghost.opacity = this.ghost2.opacity = 0;
    this.puppeteer.opacity = this.puppeteer2.opacity = 0;
    this.audio.setHold(0);
  }

  /**
   * Tonight's shapes. Creatures join in TARGETS order: the first night knows
   * five, and every later night brings one newcomer (saved for last) until
   * all are known. The rest of the order is seeded by date and night.
   */
  private newNight(): void {
    const nights = this.saved.nights;
    const known = Math.min(TARGETS.length, FIRST_NIGHT + nights);
    // `?day=N` pins the calendar seed (filming, testing); otherwise tonight's date.
    const dayParam = Number(new URLSearchParams(location.search).get('day'));
    const day = Number.isFinite(dayParam) && dayParam > 0 ? dayParam : Math.floor(Date.now() / 86400000);
    let seed = (day * 7919 + nights * 104729) % 2147483647 || 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const shuffle = (a: number[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const pool = Array.from({ length: known }, (_, i) => i);
    this.fresh = -1;
    if (nights === 0) {
      // First night: the open hand first, so the very first try already works.
      const rest = shuffle(pool.slice(1));
      this.order = [0, ...rest].slice(0, NIGHT_LENGTH);
    } else {
      const newcomer = FIRST_NIGHT + nights - 1 < TARGETS.length ? known - 1 : -1;
      const others = shuffle(pool.filter((i) => i !== newcomer));
      if (newcomer >= 0 && !(this.saved.woken[TARGETS[newcomer].id] > 0)) {
        this.fresh = newcomer;
        this.order = [...others.slice(0, NIGHT_LENGTH - 1), newcomer];
      } else {
        this.order = others.slice(0, NIGHT_LENGTH);
      }
    }
    this.step = 0;
    this.enter(Phase.Seek);
  }

  /** The creature that will join on the next night, if any. */
  private nextNewcomer(): number {
    const i = FIRST_NIGHT + this.saved.nights - 1;
    return i < TARGETS.length ? i : -1;
  }

  private enter(p: Phase): void {
    this.phase = p;
    this.leapt = this.voiced = false;
    this.phaseTime = 0;
    this.hold = 0;
    this.stuck = 0;
    this.score = 0;
    if (p === Phase.Seek) this.audio.rustle();
  }

  private beginSession(): void {
    // Deadlines are set by the next update, in the world's clock domain.
    this.placed = false;
    this.lit = this.litTarget = EMBER;
    this.awaitingLight = true;
    this.sessionAt = -1;
    this.placeAt = -1;
    this.visibleAt = -1;
    this.anchored = false;
    const session = this.renderer.xr.getSession?.();
    if (session && this.rigAnchor.hasSaved) {
      this.restore = 'pending';
      void this.rigAnchor.restore(session).then((ok) => {
        if (this.restore === 'pending') this.restore = ok ? 'ready' : 'none';
      });
    } else {
      this.restore = 'none';
    }
  }

  private endSession(): void {
    this.rigAnchor.endSession();
    this.restore = 'idle';
    this.anchored = false;
    this.table = null;
    this.mode = 'float';
    this.screen.setPinned(false);
    this.settle = null;
    this.fitUntil = 0;
    this.wall.layout(null, this.lanternPos, this.v0, [], this.v1, 1, 0);
  }

  /** Lay the rigid rig out from the lantern position and the facing direction. */
  private layout(lantern: Vector3, fwd: Vector3): void {
    this.fwd.copy(fwd);
    const up = this.v2.set(0, 1, 0);
    this.right.crossVectors(this.fwd, up).normalize();
    this.lanternPos.copy(lantern);
    const centre = this.screenCentre.copy(lantern).addScaledVector(this.fwd, STAGE.lightToScreen)
      .addScaledVector(up, STAGE.lightDrop - TARGET_CY);
    this.lantern.root.position.copy(lantern);
    this.screen.root.position.copy(centre);
    this.screen.root.lookAt(this.v1.copy(centre).sub(this.fwd));
    const f = this.frame, r = this.right;
    f.ox = centre.x; f.oy = centre.y; f.oz = centre.z;
    f.rx = r.x; f.ry = r.y; f.rz = r.z;
    f.ux = 0; f.uy = 1; f.uz = 0;
    f.nx = -this.fwd.x; f.ny = -this.fwd.y; f.nz = -this.fwd.z;
    // Natural hand spot: on the lantern-to-cut-out line, at the baked distance.
    const cut = this.v1.copy(centre).addScaledVector(up, TARGET_CY);
    this.anchor.copy(lantern).lerp(cut, STAGE.lightToHand / STAGE.lightToScreen);
    const lx = (lantern.x - f.ox) * f.rx + (lantern.y - f.oy) * f.ry + (lantern.z - f.oz) * f.rz;
    const ly = lantern.y - f.oy;
    const key = Math.round(lx * 1000) * 10000 + Math.round(ly * 1000);
    if (key !== this.paperKey) {
      this.paperKey = key;
      this.painter.paintPaper(lx, ly);
    }
  }

  /** Put the stage in front of the viewer: lantern near, screen beyond. */
  private place(time: number): void {
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
    this.defaultLantern.copy(head).addScaledVector(fwd, LANTERN_AHEAD);
    this.defaultLantern.y -= LANTERN_DROP;
    this.layout(this.defaultLantern, this.v3.copy(fwd));
    this.table = null;
    this.mode = 'float';
    this.pinWall = null;
    this.screen.setPinned(false);
    this.settle = null;
    this.anchored = false;
    this.lantern.setStand(0);
    this.wall.layout(null, this.lanternPos, head, [], this.v1, 1, 0);
    this.placed = true;
    this.fitUntil = this.immersive ? time + FIT_WINDOW : time;
    this.nextFit = time + 0.3;
    // The preview room is known at once: settle on its table straight away.
    if (!this.immersive) this.tryFit(time);
  }

  /** Planes and table meshes from the room model, as plain surfaces. */
  private surfaces(): Surface[] {
    if (!this.immersive) return this.preview.surfaces;
    const out: Surface[] = [];
    const q = this.queries as Partial<typeof this.queries> | undefined;
    for (const e of q?.planes?.entities ?? []) {
      const plane = e.getValue(XRPlane, '_plane') as XRPlane | undefined;
      const o = e.object3D;
      if (!plane || !o) continue;
      out.push({
        label: plane.semanticLabel ?? '', object: o, polygon: plane.polygon,
        orientation: plane.orientation === 'horizontal' ? 'horizontal' : plane.orientation === 'vertical' ? 'vertical' : 'unknown',
      });
    }
    for (const e of q?.meshes?.entities ?? []) {
      const o = e.object3D;
      if (!o || !e.getValue(XRMesh, 'isBounded3D')) continue;
      const label = (e.getValue(XRMesh, 'semanticLabel') as string) ?? '';
      if (label !== 'table') continue;
      out.push({ label, object: o, box: new Box3().setFromObject(o), orientation: 'horizontal' });
    }
    return out;
  }

  /**
   * Fit the rigid rig to the room. A wall straight ahead at the right
   * distance takes the paper itself; otherwise a table under the lantern
   * takes the whole theater; otherwise it floats where it was placed.
   */
  private tryFit(time: number): void {
    // Give a saved anchor a moment to come back before choosing a new spot.
    if (this.restore === 'pending' && time < this.visibleAt + 2.5) return;
    const final = time >= this.fitUntil - 0.01;
    const surfaces = this.surfaces();
    const head = this.placedHead, def = this.defaultLantern;
    const paperY = def.y + STAGE.lightDrop - TARGET_CY;
    const pin = fitPinWall(surfaces, head, this.fwd, paperY, STAGE.lightToScreen, 0.14, 0.5, PIN_STANDOFF);
    if (pin) {
      const fwd = pin.wall.normal.clone().negate();
      const to = head.clone().addScaledVector(fwd, pin.depth - PIN_STANDOFF - STAGE.lightToScreen);
      to.y = def.y;
      const right = new Vector3().crossVectors(fwd, this.v2.set(0, 1, 0)).normalize();
      this.table = fitTable(surfaces, to, fwd, right, SCREEN_W / 2 - 0.06, STAGE.lightToScreen, [0]);
      if (this.table) to.y = this.table.top + LANTERN_ON_TABLE;
      this.mode = 'pinned';
      this.pinWall = pin.wall;
      this.screen.setPinned(true);
      this.startSettle(to, fwd, time);
      return;
    }
    const fit = fitTable(surfaces, def, this.fwd, this.right, SCREEN_W / 2 - 0.06, STAGE.lightToScreen);
    if (fit) {
      this.table = fit;
      this.mode = 'table';
      const to = def.clone().addScaledVector(this.fwd, fit.shift);
      to.y = fit.top + LANTERN_ON_TABLE;
      this.startSettle(to, this.fwd.clone(), time);
    } else if (final) {
      this.fitUntil = 0;
      this.finishLayout(false);
    }
  }

  private startSettle(to: Vector3, toFwd: Vector3, time: number): void {
    this.fitUntil = 0;
    this.lantern.setStand(this.table ? LANTERN_STAND : 0);
    this.settle = { from: this.lanternPos.clone(), to, fromFwd: this.fwd.clone(), toFwd, t0: time };
  }

  /** Stage is final: lay out the wall, seat the residents, anchor a table rig. */
  private finishLayout(createAnchor: boolean): void {
    const head = this.camera.getWorldPosition(this.v0);
    let wall: WallFit | null = null;
    if (this.mode === 'pinned' && this.pinWall) {
      wall = { ...this.pinWall, point: this.screenCentre.clone().addScaledVector(this.fwd, PIN_STANDOFF), distance: PIN_STANDOFF };
    } else {
      wall = fitWall(this.surfaces(), this.lanternPos, this.screenCentre, this.fwd);
    }
    const c = this.screenCentre, r = this.right, hw = SCREEN_W / 2, hh = SCREEN_H / 2;
    const corners = [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].map(([x, y]) =>
      c.clone().addScaledVector(r, x).add(new Vector3(0, y, 0)));
    const exit = c.clone().addScaledVector(r, hw).add(new Vector3(0, TARGET_CY, 0));
    const cell = { w: Math.max(...this.stencils.map((st) => st.w)), h: Math.max(...this.stencils.map((st) => st.h)) };
    this.wall.layout(wall, this.lanternPos, head, corners, exit, 1, TARGETS.length, cell);
    this.wall.setResidents(this.firstWoken().map((id) => ({ id, st: this.stencilOf(id) })));
    if (createAnchor) {
      const frame = this.renderer.xr.getFrame?.() as XRFrame | undefined;
      const ref = this.renderer.xr.getReferenceSpace?.();
      if (frame && ref) {
        this.player.updateMatrixWorld(true);
        this.aQuat.setFromUnitVectors(this.v1.set(0, 0, -1), this.fwd);
        void this.rigAnchor.create(frame, ref, this.player.matrixWorld, this.lanternPos, this.aQuat)
          .then(() => { if (this.rigAnchor.ready) this.anchored = true; });
      }
    }
  }

  /** Bring the stage back to where the player left it last time. */
  private adoptAnchor(frame: XRFrame, ref: XRReferenceSpace): void {
    this.restore = 'none';
    this.player.updateMatrixWorld(true);
    if (!this.rigAnchor.pose(frame, ref, this.player.matrixWorld, this.aPos, this.aQuat)) return;
    const head = this.camera.getWorldPosition(this.v0);
    const dir = this.v1.subVectors(this.aPos, head);
    const drop = -dir.y;
    dir.y = 0;
    const dist = dir.length();
    const look = this.v2.set(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(this.q0));
    look.y = 0;
    look.normalize();
    // Only if the old spot is within reach and in front of the player's seat.
    if (dist < 0.12 || dist > 1.3 || drop < 0 || drop > 0.9 || dir.normalize().dot(look) < 0.3) {
      this.rigAnchor.release();
      return;
    }
    const fwd = this.v3.set(0, 0, -1).applyQuaternion(this.aQuat);
    fwd.y = 0;
    fwd.normalize();
    this.defaultLantern.copy(this.aPos);
    this.layout(this.aPos, fwd);
    const surfaces = this.surfaces();
    this.table = fitTable(surfaces, this.aPos, this.fwd, this.right, SCREEN_W / 2 - 0.06, STAGE.lightToScreen, [0]);
    const pinned = fitWall(surfaces, this.lanternPos, this.screenCentre, this.fwd, -0.05);
    this.pinWall = pinned && pinned.distance < 0.06 ? pinned : null;
    this.mode = this.pinWall ? 'pinned' : this.table ? 'table' : 'float';
    this.screen.setPinned(this.mode === 'pinned');
    this.lantern.setStand(this.table ? LANTERN_STAND : 0);
    this.settle = null;
    this.fitUntil = 0;
    this.anchored = true;
    this.finishLayout(false);
  }

  private firstWoken(): string[] {
    const order = this.saved.order ?? Object.keys(this.saved.woken);
    return order.filter((id) => (this.saved.woken[id] ?? 0) > 0 && TARGETS.some((t) => t.id === id));
  }

  private stencilOf(id: string): Stencil {
    return this.stencils[TARGETS.findIndex((t) => t.id === id)];
  }

  /** Ease the rig onto the surface it was fitted to; lay out the wall when it lands. */
  private tickSettle(time: number): void {
    if (!this.settle) return;
    const k = ease((time - this.settle.t0) / SETTLE_TIME);
    const f = this.v2.copy(this.settle.fromFwd).lerp(this.settle.toFwd, k).normalize();
    this.layout(this.v3.copy(this.settle.from).lerp(this.settle.to, k), this.q1v.copy(f));
    if (k >= 1) {
      this.settle = null;
      this.finishLayout(this.immersive);
    }
  }

  /** Per frame: follow the anchor, animate settling, keep fitting while the room loads. */
  private tendStage(dt: number, time: number): void {
    if (!this.immersive) return;
    const xr = this.renderer.xr;
    const frame = xr.getFrame?.() as XRFrame | undefined;
    const ref = xr.getReferenceSpace?.();
    if (this.restore === 'ready' && frame && ref) this.adoptAnchor(frame, ref);
    if (this.settle) {
      this.tickSettle(time);
    } else if (this.fitUntil > 0 && time >= this.nextFit) {
      this.nextFit = time + 0.5;
      this.tryFit(time);
    }
    if (this.anchored && !this.settle && frame && ref) {
      this.player.updateMatrixWorld(true);
      if (this.rigAnchor.pose(frame, ref, this.player.matrixWorld, this.aPos, this.aQuat)
        && this.aPos.distanceToSquared(this.lanternPos) > 1e-5) {
        this.layout(this.aPos, this.fwd);
      }
    }
    // Seated play: if the player settles somewhere else, bring the stage along.
    const head = this.camera.getWorldPosition(this.v0);
    if (this.mode !== 'float') {
      const far = head.distanceTo(this.lanternPos) > 1.4;
      this.drift = far ? this.drift + dt : 0;
      if (this.drift > 5) this.place(time);
    } else {
      const d = head.distanceTo(this.placedHead);
      this.drift = d > 0.3 ? this.drift + dt : 0;
      if (this.drift > 1.5 && !this.settle) this.place(time);
    }
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
  private poseToWorld(p: HandPose, out: Float32Array, lift: number, shift: readonly number[] = ZERO3): void {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < JOINT_COUNT; j++) {
      cx += p.mats[j * 16 + 12]; cy += p.mats[j * 16 + 13]; cz += p.mats[j * 16 + 14];
    }
    cx /= JOINT_COUNT; cy /= JOINT_COUNT; cz /= JOINT_COUNT;
    const f = this.frame, a = this.anchor;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const x = p.mats[j * 16 + 12] - cx + shift[0];
      const y = p.mats[j * 16 + 13] - cy + lift + shift[1];
      const z = p.mats[j * 16 + 14] - cz + shift[2];
      out[j * 3] = a.x + x * f.rx + y * f.ux + z * f.nx;
      out[j * 3 + 1] = a.y + x * f.ry + y * f.uy + z * f.ny;
      out[j * 3 + 2] = a.z + x * f.rz + y * f.uz + z * f.nz;
    }
  }

  /** Browser/demo hands: ease from relaxed hands into tonight's shape. */
  private driveDemo(target: BakedTarget, t: number): void {
    const k = this.phase === Phase.Seek ? ease((this.phaseTime - 1.0) / 2.2) : 1;
    const lift = (this.phase === Phase.Seek ? 0 : -ease(this.phaseTime / 0.8) * 0.25) + 0.012 * Math.sin(t * 1.3);
    const live = this.phase !== Phase.Finale;
    this.blendDemo(this.demoHand, this.ghostPose, this.demoFrom, target.pose, k, lift, target.shifts[0], this.posePositions, t);
    this.demoHand.valid = live;
    if (target.partner) {
      this.blendDemo(this.demoHand2, this.ghostPose2, this.demoFrom2, target.partner, k, lift, target.shifts[1], this.posePositions2, t);
      this.demoHand2.valid = live;
    } else {
      this.demoHand2.valid = false;
    }
  }

  private blendDemo(
    hand: LiveHand, tmp: HandPose, from: HandPose, to: HandPose, k: number, lift: number,
    shift: readonly number[], pos: Float32Array, t: number,
  ): void {
    // Interpolate joint positions only; the poses' own matrices stay untouched.
    for (let i = 0; i < from.mats.length; i++) tmp.mats[i] = from.mats[i] + (to.mats[i] - from.mats[i]) * k;
    tmp.radii.set(to.radii);
    this.poseToWorld(tmp, pos, lift, shift);
    // A touch of drift so the shadow breathes like a real hand.
    for (let j = 0; j < JOINT_COUNT; j++) pos[j * 3] += 0.006 * Math.sin(t * 0.9);
    hand.joints.set(pos);
    hand.radii.set(to.radii);
  }

  update(delta: number, time: number): void {
    const started = perf?.beginFrame();
    try {
      this.updateFrame(delta, time);
    } catch (e) {
      // Keep the night running: report each distinct failure once, then carry on next frame.
      const key = String(e);
      if (!this.reported.has(key)) { this.reported.add(key); console.error('[Shadowfolk] frame error', e); }
    } finally {
      if (started !== undefined) perf!.endFrame(started, this.phase);
    }
  }

  private updateFrame(delta: number, time: number): void {
    this.now = time;
    if (!this.visible) return;
    const dt = this.resumeFrame ? 0 : Math.max(0, Math.min(delta, 0.05));
    this.resumeFrame = false;
    this.animationTime += dt;
    if (this.placeAt < 0) this.placeAt = time + 0.5;
    if (this.visibleAt < 0) this.visibleAt = time;
    if (this.sessionAt < 0) this.sessionAt = this.animationTime;
    if (!this.placed && time >= this.placeAt) this.place(time);
    if (!this.placed) return;
    if (this.immersive) {
      this.tendStage(dt, time);
    } else {
      // Browser preview keeps a fixed theater-seat view: lantern, paper and the wall above it.
      this.tickSettle(time);
      // Filming: keep the 2D welcome panel out of the frame (its screen-space system re-shows it).
      if (captureControl()) {
        const panel = this.world.getSceneObject('welcome-panel');
        if (panel) panel.visible = false;
        // Screen-space UI is re-parented under the camera; hide that copy too.
        for (const c of this.camera.children) c.visible = false;
      }
      const cam = captureControl()?.camera;
      if (cam) {
        this.camera.position.set(...cam.pos);
        this.camera.lookAt(...cam.look);
        const pc = this.camera as unknown as { fov?: number; updateProjectionMatrix?: () => void };
        if (cam.fov && pc.fov !== cam.fov) { pc.fov = cam.fov; pc.updateProjectionMatrix?.(); }
      } else {
        this.camera.position.set(0.5, 1.48, 0.95);
        this.camera.lookAt(0.0, 1.2, -1.0);
      }
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
    if (useDemo) this.driveDemo(target, this.animationTime); else this.demoHand.valid = this.demoHand2.valid = false;
    this.puppeteer.opacity = this.demoHand.valid ? 1 : 0;
    if (this.demoHand.valid) this.puppeteer.update(this.demoHand.joints, this.demoHand.radii);
    this.puppeteer2.opacity = this.demoHand2.valid ? 1 : 0;
    if (this.demoHand2.valid) this.puppeteer2.update(this.demoHand2.joints, this.demoHand2.radii);

    // Lantern: a dim ember until a hand reaches its light, then a warm flicker.
    this.lit += (this.litTarget - this.lit) * Math.min(1, dt * 3.5);
    const flick = 0.92 + 0.05 * Math.sin(this.animationTime * 7.3) + 0.03 * Math.sin(this.animationTime * 17.1);
    const glow = (0.3 + 0.7 * this.lit) * flick;
    this.lantern.bodyMat.color.setRGB(glow, 0.81 * glow, 0.54 * glow);
    this.lantern.halo.scale.setScalar((0.14 + 0.16 * this.lit) * (0.96 + 0.04 * flick));
    this.lantern.halo.material.opacity = (0.38 + 0.18 * this.lit) * flick;
    (this.lantern.pool.material as MeshBasicMaterial).opacity = 0.32 * this.lit * flick;
    this.audio.tick(dt, this.lit);
    this.glowLight.position.copy(this.lanternPos);
    this.glowLight.intensity = (0.12 + 0.95 * this.lit) * flick;
    // The room dims as the lantern blooms (passthrough only; the preview room is already dark).
    // House lights go down first, then the lantern blooms.
    const houseDown = this.immersive ? ease((this.animationTime - Math.max(0, this.sessionAt)) / 2.5) : 0;
    this.dim.update(this.camera.getWorldPosition(this.v0), this.lanternPos, (0.38 + 0.1 * this.lit) * houseDown);
    const paperTone = 0.32 + 0.68 * this.lit;
    this.painter.setTone(paperTone);

    // Shadows: project every hand from the lantern onto the paper.
    const p = this.painter;
    p.begin();
    this.live.clear();
    let casters = 0;
    const L = this.lanternPos;
    for (const h of this.allHands) {
      if (!h.valid) continue;
      projectFromLight(h.joints, h.radii, L.x, L.y, L.z, this.frame, h.flat);
      if (!h.flat.valid) continue;
      drawHand(this.live, h.flat);
      casters++;
    }
    if (this.awaitingLight && casters > 0) {
      this.awaitingLight = false;
      this.litTarget = 1;
      this.audio.bloom();
    }

    switch (this.phase) {
      case Phase.Seek: this.seek(target, stencil, casters, dt, this.animationTime); break;
      case Phase.Wake: this.wake(target, stencil, this.animationTime); break;
      case Phase.Rest:
        if (this.phaseTime >= REST_TIME) this.enter(Phase.Seek);
        break;
      case Phase.Finale: this.finale(this.animationTime); break;
    }

    const screenDistance = this.screenCentre.distanceTo(L);
    for (const hand of this.allHands) {
      if (!hand.valid || !hand.flat.valid) continue;
      let distance = 0;
      for (let joint = 0; joint < JOINT_COUNT; joint++) {
        const offset = joint * 3;
        distance += Math.hypot(hand.joints[offset] - L.x, hand.joints[offset + 1] - L.y,
          hand.joints[offset + 2] - L.z);
      }
      distance = Math.max(0.15, distance / JOINT_COUNT);
      // Penumbra width W = flame radius * (paper - hand) / hand; Gaussian sigma ~ W/3.
      // A 2.4 cm effective flame keeps a mid-distance hand readable and still blooms near the lantern.
      const penumbraMetres = 0.024 * Math.max(0, screenDistance - distance) / distance;
      p.shadow(hand.flat, Math.min(12, Math.max(0.8, (penumbraMetres * 256) / 3)));
    }
    p.flushShadows(this.phase === Phase.Wake ? 0.35 : 0.9);
    if (this.phase !== Phase.Finale) p.progress(this.step, NIGHT_LENGTH);

    if (this.immersive && !anyReal && time - this.handsSeenAt > 2 && !this.demo) {
      p.caption('Set the controllers down. Just your hands.', 1, 0.27);
    }
    p.end();
    this.wall.update(this.animationTime);
  }

  private seek(target: BakedTarget, stencil: Stencil, casters: number, dt: number, time: number): void {
    const casting = casters > 0;
    // A two-hand creature only wakes for two shadows.
    const raw = casters >= (target.partner ? 2 : 1) ? this.matcher.score(this.live, target.template) : 0;
    this.score += (raw - this.score) * Math.min(1, dt * 10);
    const close = Math.max(0, Math.min(1, (this.score - 0.3) / (target.pass - 0.3)));
    if (!casting) { this.score = 0; this.hold = 0; }
    if (casting && this.score >= target.pass) this.hold += dt;
    else this.hold = Math.max(0, this.hold - dt * 1.5);
    this.audio.setHold(casting ? close * close : 0);

    const glow = close * close + (this.hold > 0 ? 0.4 * this.hold / HOLD_TO_WAKE : 0);
    this.painter.target(stencil, 0, TARGET_CY, glow, time);

    // First moment of the first night: light and shadow speak first; words only if nothing happens.
    if (this.saved.nights === 0 && this.step === 0) {
      const quiet = this.animationTime - Math.max(0, this.sessionAt);
      if (!casting && quiet > 5) this.painter.caption('Lift a hand into the lantern light.', ease((quiet - 5) / 0.8));
      else if (casting && this.phaseTime > 6 && close < 0.6) this.painter.caption('Fit your shadow to the shape.', 1);
    }
    // A two-hand creature: say so when only one shadow keeps trying.
    if (target.partner && casters === 1) this.oneHand += dt; else this.oneHand = Math.max(0, this.oneHand - dt);
    if (target.partner && this.oneHand > 2.5) this.painter.caption('This one takes both hands.', ease((this.oneHand - 2.5) / 0.6), -0.27);
    // A newcomer shimmers the first time it appears.
    if (this.baked.indexOf(target) === this.fresh) {
      this.painter.sparks(0, TARGET_CY, (time * 0.35) % 1, 0.5);
      if (this.phaseTime < 3.5) this.painter.caption('Someone new is waiting.', 1 - ease((this.phaseTime - 2.5) / 1), 0.27);
    }

    // Stuck? Fade in the ghost hand that shows the shape.
    if (close < 0.85) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    const hint = ease((this.stuck - HINT_AFTER) / 1.5);
    if (hint > 0 && !this.demo) {
      if (target.partner) {
        this.poseToWorld(target.pose, this.posePositions, 0.0, target.shifts[0]);
        this.ghost.update(this.posePositions, target.pose.radii);
        this.poseToWorld(target.partner, this.posePositions2, 0.0, target.shifts[1]);
        this.ghost2.update(this.posePositions2, target.partner.radii);
      } else {
        const right = this.hands[1].valid || !this.hands[0].valid;
        const pose = right ? this.mirrored[this.baked.indexOf(target)] : target.pose;
        this.poseToWorld(pose, this.posePositions, 0.0);
        this.ghost.update(this.posePositions, pose.radii);
      }
    }
    this.ghost.opacity = this.demo ? 0 : hint * (0.28 + 0.08 * Math.sin(time * 3));
    this.ghost2.opacity = target.partner ? this.ghost.opacity : 0;

    if (this.hold >= HOLD_TO_WAKE) {
      this.audio.setHold(0);
      this.audio.chime(this.step);
      const id = target.def.id;
      this.saved.woken[id] = (this.saved.woken[id] ?? 0) + 1;
      const order = this.saved.order ?? (this.saved.order = Object.keys(this.saved.woken).filter((k) => k !== id));
      if (!order.includes(id)) order.push(id);
      save(this.saved);
      this.ghost.opacity = this.ghost2.opacity = 0;
      this.enter(Phase.Wake);
    }
  }

  private wake(target: BakedTarget, stencil: Stencil, time: number): void {
    const t = this.phaseTime;
    if (!this.voiced && t >= 0.35) {
      this.voiced = true;
      this.audio.voice(target.def.motion);
    }
    // It comes alive in place, then walks off the paper's right edge (onto the wall, if there is one).
    const walk = ease((t - WALK_AT) / WALK_TIME);
    let x = walk * (SCREEN_W / 2 + stencil.w / 2 + 0.03), y = TARGET_CY, rot = 0, sc = 1;
    switch (target.def.motion) {
      case 'hop': y += Math.abs(Math.sin(Math.max(0, t - 0.4) * Math.PI * 1.6)) * 0.05; break;
      case 'swim': y += Math.sin(t * 4) * 0.018; rot = Math.cos(t * 4) * 0.08; break;
      case 'crawl': sc = 1 + 0.025 * Math.sin(t * 7); x *= 0.85; break;
      case 'bob': y += Math.sin(t * 5) * 0.014; rot = Math.sin(t * 5) * 0.07; break;
      case 'fan': sc = 1 + 0.07 * Math.sin(t * 3) * (1 - walk); rot = Math.sin(t * 2) * 0.04; break;
      case 'flap': y += 0.03 * Math.sin(t * 5) + walk * 0.12; sc = 1 + 0.06 * Math.sin(t * 10); rot = 0.06 * Math.sin(t * 5); break;
      case 'stalk': y += Math.abs(Math.sin(t * 2.2)) * 0.012; rot = -0.04 + 0.04 * Math.sin(t * 2.2); x *= 0.9; break;
      case 'scuttle': x += 0.012 * Math.sin(t * 22); y += 0.004 * Math.abs(Math.sin(t * 22)); break;
    }
    const onWall = this.wall.active;
    const alpha = onWall ? 1 : t < 2.3 ? 1 : 1 - ease((t - 2.3) / 0.5);
    const blink = (t > 0.9 && t < 1.02) || (t > 1.9 && t < 1.98);
    this.painter.creature(stencil, x, y, sc, rot, false, blink, alpha, Math.max(0, 1 - t / 1.5), time);
    if (!this.leapt && t >= WALK_AT + WALK_TIME * 0.82) {
      this.leapt = true;
      if (onWall) this.wall.leap(target.def.id, stencil, time);
    }
    if (t < 1.5) this.painter.sparks(0, TARGET_CY, t / 1.5, 1);
    const capA = Math.min(ease((t - 0.3) / 0.5), 1 - ease((t - 2.6) / 0.6));
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
  }

  private finale(time: number): void {
    const t = this.phaseTime;
    const n = this.order.length;
    for (let k = 0; k < n; k++) {
      const st = this.stencils[this.order[k]];
      const x = -SCREEN_W / 2 - 0.1 + ((t * 0.18 + k * (SCREEN_W + 0.2) / n) % (SCREEN_W + 0.2));
      const y = -0.02 + Math.abs(Math.sin(t * 3 + k)) * 0.02;
      this.painter.creature(st, x, y, 0.42, 0, false, Math.sin(time * 2 + k * 1.7) > 0.97, 0.9);
      // Each shadow sings one note as it crosses the middle of the paper.
      if (t > 0.05 && this.finaleX[k] < 0 && x >= 0) this.audio.note(k + this.step);
      this.finaleX[k] = x;
    }
    const a = Math.min(ease(t / 0.8), 1 - ease((t - FINALE_TIME + 1) / 1));
    this.wall.cheer(a);
    this.painter.caption(FINALE_CAPTION, a, 0.2);
    const next = this.nextNewcomer();
    if (next >= 0 && t > FINALE_TIME * 0.45) {
      // Tease the next night's newcomer: a dark shape with blinking eyes peeking in at the left edge.
      const st = this.stencils[next];
      const peek = ease((t - FINALE_TIME * 0.45) / 1.2) * (1 - ease((t - FINALE_TIME + 0.8) / 0.8));
      this.painter.creature(st, -SCREEN_W / 2 - st.w * 0.5 + st.w * 0.45 * peek, -0.05, 0.6, 0.1, false, Math.sin(time * 3) > 0.9, 0.85 * peek);
      this.painter.caption('Someone new waits for the next night.', a * 0.8, -0.24);
    } else {
      this.painter.caption(this.wall.active ? 'They will wait for you on the wall.' : 'Come back after dark for new shapes.', a * 0.8, -0.24);
    }
    if (t >= FINALE_TIME) {
      this.wall.cheer(0);
      this.finaleX.fill(0);
      this.newNight();
    }
  }

}

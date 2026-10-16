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
  HandPose, JOINT_COUNT, JOINT_NAMES, basePoses, mirror, orient, shape, spread,
} from '../shadow/hand-model.js';
import {
  FlatHand, Mask, Matcher, Moments, STAGE, ScreenFrame, drawHand, moments, projectFromLight,
} from '../shadow/silhouette.js';
import { BakedTarget, TARGETS, bakeTarget } from '../shadow/targets.js';
import { TheaterAudio } from './audio.js';
import { runtimePerf as perf } from './perf.js';
import { SCREEN_H, SCREEN_W, ScreenPainter, Stencil, makeStencil } from './painter.js';
import { RigAnchor } from './anchor.js';
import { LANTERN_ON_TABLE, Surface, TableFit, WallFit, fitPinWall, fitTable, fitWall } from './room.js';
import { GhostHand, Lantern, PaperScreen, RoomDim, buildLantern, buildRoomDim, buildScreen } from './stage.js';
import { captureControl } from '../capture.js';
import { Moon, isFullMoon, moonPhase } from './moon.js';
import { PreviewRoom } from './preview-room.js';
import { WallLayer } from './wall.js';
import { LightRays } from './rays.js';
import { xrRenderStatusLine } from './xr-render.js';

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
/** A name for each night, keyed by its newcomer; later nights are reunions. */
const NIGHT_NAMES: Record<string, string> = {
  first: 'The First Lantern', butterfly: 'Wings', heron: 'Long Legs', stag: 'Antlers', crab: 'The Tide',
  dog: 'The Barking Moon', elephant: 'Big Ears',
};
/** Lantern brightness before the first hand reaches its light. */
const EMBER = 0.18;
const STORE_KEY = 'shadow-theater.v1';

enum Phase { Seek, Wake, Rest, Finale, Invent }

const MAX_INVENTED = 8;
const INVENT_HOLD = 1.4; // seconds a free shape must stay still to be born
const INVENT_TIME = 14;
const SYLLABLES = ['mo', 'ri', 'ka', 'lu', 'shi', 'no', 'pa', 'te', 'yo', 'fu', 'ki', 'ra', 'so', 'mi', 'ha', 'to'];

function validInvented(v: unknown): v is Invented {
  const o = v as Invented;
  const arr = (a: unknown) => Array.isArray(a) && a.length === JOINT_COUNT && a.every((n) => Number.isFinite(n) && Math.abs(n) < 2);
  return !!o && typeof o.id === 'string' && typeof o.name === 'string' && Array.isArray(o.hands) && o.hands.length >= 1 && o.hands.length <= 2
    && o.hands.every((h) => h && arr(h.x) && arr(h.y) && arr(h.r)) && Array.isArray(o.eye) && o.eye.length === 4;
}

interface LiveHand {
  joints: Float32Array;
  radii: Float32Array;
  flat: FlatHand;
  valid: boolean;
  lastSeen: number;
}

/** A shadow the player invented: its hands' flat shapes on the paper (metres), an eye, a name. */
interface Invented { id: string; name: string; hands: { x: number[]; y: number[]; r: number[] }[]; eye: [number, number, number, number] }
interface Saved { nights: number; woken: Record<string, number>; order?: string[]; carried?: boolean; invented?: Invented[] }

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
        const ids = new Set(TARGETS.map((t) => t.id));
        const order = Array.isArray(candidate.order) ? candidate.order.filter((id): id is string => typeof id === 'string' && ids.has(id)) : undefined;
        const invented = Array.isArray(candidate.invented) ? candidate.invented.filter(validInvented).slice(-MAX_INVENTED) : undefined;
        return { nights, woken, order, carried: candidate.carried === true, invented };
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
  private emberShown = false;
  private demoDelay = Number(new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('demoDelay')) || 0;
  /** `?demoDepth` (filming): before forming a shape, the demo hand moves toward the lantern and back. */
  private demoDepth = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demoDepth');
  /** `?rays` (explainer): draw the lantern's light rays through each hand onto the paper. */
  private rays = typeof location !== 'undefined' && new URLSearchParams(location.search).has('rays') ? new LightRays() : null;
  private lit = 1; // lantern brightness 0..1
  private litTarget = 1;
  private paperDim = 0;
  private awaitingLight = false;
  private sessionAt = -1;
  private voiced = false;
  private oneHand = 0; // seconds a two-hand creature has seen only one shadow
  private fresh = -1; // index into TARGETS of tonight's newly joined creature
  private nightTitle = '';
  private moon = new Moon();
  private fullMoon = false;
  // Inventing a creature of your own after the finale.
  private inventStencils = new Map<string, Stencil>();
  private inventStable = 0;
  private inventPrev: Moments = { area: 0, cx: 0, cy: 0 };
  private inventMo: Moments = { area: 0, cx: 0, cy: 0 };
  private inventBorn = false;
  private inventBornAt = 0;
  private inventId = '';
  private inventName = '';
  private inventTarget: BakedTarget | null = null;
  // The woken creature follows the hand that made it, until it walks away.
  private wakeC0: { cx: number; cy: number } | null = null;
  private follow = { x: 0, y: 0, vx: 0 };
  private wakeMo: Moments = { area: 0, cx: 0, cy: 0 };
  // Carrying the theater: pinch the lantern to pick it up, open the pinch to set it down.
  private carry: LiveHand | null = null;
  private carryOffset = new Vector3();
  private carryNear = 0; // 0..1 hover glow when a pinch is close to the lantern
  private manual = false; // the player chose this spot by hand: never re-place on drift
  private nightTitleAt = -1;
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
    this.painter = new ScreenPainter(() => xrRenderStatusLine(this.world.renderer));
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
    if (this.rays) this.world.createTransformEntity(this.rays.root);
    this.baked = TARGETS.map(bakeTarget);
    this.stencils = this.baked.map((b) =>
      makeStencil(b.flats, 1, b.def.eyes));
    for (const v of this.saved.invented ?? []) this.inventStencils.set(v.id, this.inventedStencil(v));
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
    // Tonight's moon sits in the paper's top-left corner, under the shadows.
    this.moon.mesh.position.set(-SCREEN_W / 2 + 0.09, SCREEN_H / 2 - 0.085, 0.0002);
    this.painter.root.add(this.moon.mesh);
    const cap = captureControl();
    if (cap) this.audio.onCue = (kind, arg) => cap.cues.push({ t: cap.time, kind, arg });
    if (cap) {
      const names = ['seek', 'wake', 'rest', 'finale', 'invent'];
      cap.state = () => ({
        phase: names[this.phase], step: this.step, target: this.baked[this.order[this.step % this.order.length]]?.def.id,
        mode: this.mode, born: this.inventBorn, wall: this.wall.active,
      });
    }
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
    // `?first=crab,dog` (filming): these creatures open tonight, in that order.
    const first = (new URLSearchParams(location.search).get('first') ?? '').split(',')
      .map((id) => TARGETS.findIndex((t) => t.id === id)).filter((i) => i >= 0);
    if (first.length) this.order = [...first, ...this.order.filter((i) => !first.includes(i))].slice(0, Math.max(NIGHT_LENGTH, first.length));
    const key = nights === 0 ? 'first' : this.fresh >= 0 ? TARGETS[this.fresh].id : '';
    this.nightTitle = `Night ${nights + 1} \u00b7 ${NIGHT_NAMES[key] ?? 'Old Friends'}`;
    const phase = moonPhase();
    this.moon.setPhase(phase);
    this.fullMoon = isFullMoon(phase);
    this.nightTitleAt = -1;
    this.step = 0;
    this.enter(Phase.Seek);
  }

  /** True when some cast shadow's centre lies on the paper (a hand has entered the light). */
  private shadowOnPaper(): boolean {
    for (const h of this.allHands) {
      if (!h.valid || !h.flat.valid) continue;
      let x = 0, y = 0;
      for (let j = 0; j < JOINT_COUNT; j++) { x += h.flat.x[j]; y += h.flat.y[j]; }
      x /= JOINT_COUNT; y /= JOINT_COUNT;
      if (Math.abs(x) < SCREEN_W / 2 && Math.abs(y) < SCREEN_H / 2) return true;
    }
    return false;
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
    this.manual = false;
    this.carry = null;
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
    // `?ember`: the browser preview also starts with the lantern as an ember that blooms
    // when the (demo) hand enters its light, exactly as a headset session does.
    if (!this.immersive && !this.emberShown && new URLSearchParams(location.search).has('ember')) {
      this.emberShown = true;
      this.lit = this.litTarget = EMBER;
      this.awaitingLight = true;
    }
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
    this.wall.layout(wall, this.lanternPos, head, corners, exit, 1, TARGETS.length + MAX_INVENTED, cell);
    this.wall.setResidents(this.firstWoken().map((id) => ({ id, st: this.stencilOf(id) })));
    if (createAnchor || (this.manual && this.immersive)) {
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
    const known = order.filter((id) => (this.saved.woken[id] ?? 0) > 0 && TARGETS.some((t) => t.id === id));
    return [...known, ...(this.saved.invented ?? []).map((v) => v.id)];
  }

  private stencilOf(id: string): Stencil {
    const k = TARGETS.findIndex((t) => t.id === id);
    return k >= 0 ? this.stencils[k] : this.inventStencils.get(id)!;
  }

  /** Stencil for an invented shadow, from its saved flat hands. */
  private inventedStencil(v: Invented): Stencil {
    const flats = v.hands.map((h) => {
      const f = new FlatHand();
      f.x.set(h.x); f.y.set(h.y); f.r.set(h.r); f.valid = true;
      return f;
    });
    return makeStencil(flats, 1, [v.eye]);
  }

  /** A loose random hand for the demo puppet to invent with (seeded by the night). */
  private makeInventPose(): void {
    let seed = (this.saved.nights * 7349 + 17) % 2147483647 || 3;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const curls = { thumb: r() * 1.2 - 0.3, index: r() * 1.3 - 0.32, middle: r() * 1.3 - 0.32, ring: r() * 1.3 - 0.32, pinky: r() * 1.3 - 0.32 };
    const p = shape(basePoses.relaxed(), curls);
    spread(p, 'index', r() * 20 - 5); spread(p, 'pinky', -r() * 25);
    orient(p, [0, r() * 60, r() * 90 - 45]);
    this.inventTarget = { pose: p, shifts: [[0, 0, 0]], partner: undefined } as unknown as BakedTarget;
  }

  /**
   * After the finale, any shape the player holds still becomes a new creature of
   * their own: its shadow turns to ink, opens an eye, gets a name and joins the wall.
   */
  private invent(dt: number, time: number, casters: number): void {
    const t = this.phaseTime;
    if (!this.inventBorn) {
      const a = Math.min(ease(t / 0.8), 1 - ease((t - INVENT_TIME + 0.8) / 0.8));
      this.painter.caption('Make a shape of your own.', a, 0.27);
      if (t > 2.5) this.painter.caption('Hold it still.', a * 0.8, -0.27);
      if (casters > 0) {
        moments(this.live, this.inventMo);
        const still = this.inventPrev.area > 0
          && Math.hypot(this.inventMo.cx - this.inventPrev.cx, this.inventMo.cy - this.inventPrev.cy) < 0.004
          && Math.abs(this.inventMo.area - this.inventPrev.area) < 0.08 * this.inventPrev.area;
        this.inventStable = still && t > 1.5 ? this.inventStable + dt : Math.max(0, this.inventStable - dt * 2);
        this.inventPrev.area = this.inventMo.area; this.inventPrev.cx = this.inventMo.cx; this.inventPrev.cy = this.inventMo.cy;
      } else {
        this.inventStable = Math.max(0, this.inventStable - dt * 2);
        this.inventPrev.area = 0;
      }
      this.audio.setHold(casters > 0 ? Math.min(1, this.inventStable / INVENT_HOLD) : 0);
      if (this.inventStable >= INVENT_HOLD) this.bear(time);
      else if (t >= INVENT_TIME) { this.audio.setHold(0); this.newNight(); }
      return;
    }
    // Born: ink in place, an eye opens, then it walks off toward the wall like any creature.
    const b = t - this.inventBornAt;
    const st = this.inventStencils.get(this.inventId)!;
    const walk = ease((b - 1.6) / 1.2);
    const x = walk * (SCREEN_W / 2 + st.w / 2 + 0.03);
    const blink = b > 1.0 && b < 1.1;
    this.painter.creature(st, x, Math.abs(Math.sin(b * 5)) * 0.01 * walk, 1, 0, false, blink, 1);
    if (b < 1.2) this.painter.sparks(st.cx, st.cy, b / 1.2, 1);
    this.painter.caption(`A new shadow is born: ${this.inventName}.`, Math.min(ease(b / 0.5), 1 - ease((b - 2.8) / 0.6)), 0.27);
    if (!this.leapt && b >= 1.6 + 1.2 * 0.82) {
      this.leapt = true;
      if (this.wall.active) this.wall.leap(this.inventId, st, time);
    }
    if (b >= 3.4) this.newNight();
  }

  private bear(time: number): void {
    const flats: FlatHand[] = [];
    for (const h of this.allHands) {
      if (!h.valid || !h.flat.valid) continue;
      const f = new FlatHand();
      f.x.set(h.flat.x); f.y.set(h.flat.y); f.r.set(h.flat.r); f.valid = true;
      flats.push(f);
    }
    if (!flats.length) return;
    // The eye goes near the highest fingertip of the first hand: heads tend to be up.
    const tips = [4, 9, 14, 19, 24];
    const top = tips.reduce((best, j) => (flats[0].y[j] > flats[0].y[best] ? j : best), tips[0]);
    const eye: [number, number, number, number] = [top - 1, top, 0.25, 0];
    let seed = (Date.now() % 100000) + this.saved.nights * 31;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const syl = () => SYLLABLES[Math.floor(r() * SYLLABLES.length)];
    const raw = syl() + syl() + (r() < 0.4 ? syl() : '');
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    const id = `inv-${Date.now().toString(36)}`;
    const round = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 10000) / 10000);
    const v: Invented = { id, name, eye, hands: flats.map((f) => ({ x: round(f.x), y: round(f.y), r: round(f.r) })) };
    const list = (this.saved.invented ??= []);
    list.push(v);
    while (list.length > MAX_INVENTED) list.shift();
    save(this.saved);
    this.inventStencils.set(id, this.inventedStencil(v));
    this.inventId = id;
    this.inventName = name;
    this.inventBorn = true;
    this.inventBornAt = this.phaseTime;
    this.leapt = false;
    this.audio.setHold(0);
    this.audio.chime(this.step + 2);
    this.audio.voice('fan');
    void time;
  }

  /** Thumb-tip to index-tip pinch of a tracked hand; returns the pinch point in `out`, or -1. */
  private pinch(h: LiveHand, out: Vector3): number {
    const j = h.joints;
    const ax = j[4 * 3], ay = j[4 * 3 + 1], az = j[4 * 3 + 2];
    const bx = j[9 * 3], by = j[9 * 3 + 1], bz = j[9 * 3 + 2];
    out.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    return Math.hypot(ax - bx, ay - by, az - bz);
  }

  /**
   * Pinch the lantern to carry the whole theater; open the pinch to set it down.
   * On release the room is fitted again around the new spot and the anchor is renewed.
   */
  private handleCarry(time: number): void {
    const p = this.v1;
    if (this.carry) {
      const h = this.carry;
      const d = h.valid ? this.pinch(h, p) : 1;
      if (d > 0.035) {
        this.carry = null;
        this.audio.settle();
        this.setDown(time);
        return;
      }
      const head = this.camera.getWorldPosition(this.v0);
      const lantern = this.v3.copy(p).add(this.carryOffset);
      const fwd = this.v2.subVectors(lantern, head);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) return;
      fwd.normalize();
      this.layout(lantern, this.q1v.copy(fwd));
      return;
    }
    let near = 0;
    for (const h of this.hands) {
      if (!h.valid) continue;
      const d = this.pinch(h, p);
      const r = p.distanceTo(this.lanternPos);
      if (r < 0.14) near = Math.max(near, 1 - r / 0.14);
      if (d < 0.018 && r < 0.07 && this.phase !== Phase.Wake) {
        this.carry = h;
        this.carryOffset.subVectors(this.lanternPos, p);
        this.settle = null;
        this.fitUntil = 0;
        this.table = null;
        this.pinWall = null;
        this.mode = 'float';
        this.screen.setPinned(false);
        this.lantern.setStand(0);
        this.wall.layout(null, this.lanternPos, this.v0, [], this.v1, 1, 0);
        this.rigAnchor.release();
        this.anchored = false;
        this.audio.rustle();
        this.saved.carried = true;
        save(this.saved);
        return;
      }
    }
    this.carryNear += (near - this.carryNear) * 0.2;
  }

  /** Fit the room around where the player set the lantern down, then anchor it there. */
  private setDown(time: number): void {
    const head = this.camera.getWorldPosition(this.v0);
    this.placedHead.copy(head);
    this.defaultLantern.copy(this.lanternPos);
    this.manual = true;
    this.drift = 0;
    const surfaces = this.surfaces();
    const fit = fitTable(surfaces, this.lanternPos, this.fwd, this.right, SCREEN_W / 2 - 0.06, STAGE.lightToScreen, [0, -0.04, 0.04]);
    if (fit && Math.abs(fit.top + LANTERN_ON_TABLE - this.lanternPos.y) < 0.12) {
      this.table = fit;
      this.mode = 'table';
      const to = this.lanternPos.clone().addScaledVector(this.fwd, fit.shift);
      to.y = fit.top + LANTERN_ON_TABLE;
      this.startSettle(to, this.fwd.clone(), time);
    } else {
      this.finishLayout(true);
    }
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
    if (this.carry) return;
    if (this.mode !== 'float' || this.manual) {
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
    // `?demoDelay=N` (filming): the puppet hesitates N extra seconds, long enough for the ghost-hand hint.
    const seeking = this.phase === Phase.Seek || (this.phase === Phase.Invent && !this.inventBorn);
    const k = seeking ? ease((this.phaseTime - 1.0 - this.demoDelay) / 2.2) : 1;
    // While the lantern waits as an ember, the demo hand first rises into its light from below.
    const rise = this.awaitingLight ? -0.32 * (1 - ease((this.phaseTime - 0.6) / 1.6)) : 0;
    // After a wake the demo hand lingers, sways (the creature follows it), then lowers as it walks off.
    const dropFrom = this.phase === Phase.Invent ? this.phaseTime - this.inventBornAt
      : this.phase === Phase.Wake ? this.phaseTime - WALK_AT : this.phaseTime;
    const lift = (seeking ? rise : -ease(dropFrom / 0.8) * 0.25) + 0.012 * Math.sin(t * 1.3);
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
    if (this.demoDelay > 0 && !this.demoDepth && this.phase === Phase.Seek) {
      // A stuck player: the hand wanders beside the shape, so the ghost hand reads clearly, then moves into it.
      const f = this.frame, w = (1 - k) * Math.min(1, this.phaseTime / 1.5);
      const dx = w * (0.075 + 0.02 * Math.sin(this.phaseTime * 0.8)), dy = w * (-0.05 + 0.015 * Math.sin(this.phaseTime * 1.1));
      for (let j = 0; j < JOINT_COUNT; j++) {
        pos[j * 3] += dx * f.rx + dy * f.ux; pos[j * 3 + 1] += dx * f.ry + dy * f.uy; pos[j * 3 + 2] += dx * f.rz + dy * f.uz;
      }
    }
    if (this.demoDepth && this.phase === Phase.Seek) {
      // Slide along the lantern-to-paper line: the shadow swells near the light and sharpens near the paper.
      const f = this.frame, d = 0.13 * Math.sin(this.phaseTime * 1.6) * (1 - k);
      for (let j = 0; j < JOINT_COUNT; j++) { pos[j * 3] += d * f.nx; pos[j * 3 + 1] += d * f.ny; pos[j * 3 + 2] += d * f.nz; }
    }
    if (this.phase === Phase.Wake && this.phaseTime < WALK_AT) {
      // Sway sideways so the just-woken creature visibly follows the hand.
      const sw = 0.035 * Math.sin(this.phaseTime * 4.5), f = this.frame;
      for (let j = 0; j < JOINT_COUNT; j++) { pos[j * 3] += sw * f.rx; pos[j * 3 + 1] += sw * f.ry; pos[j * 3 + 2] += sw * f.rz; }
    }
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
    if (this.immersive) this.handleCarry(time);
    this.phaseTime += dt;

    const target = this.baked[this.order[this.step % this.order.length]];
    const stencil = this.stencils[this.order[this.step % this.order.length]];
    const demoTarget = this.phase === Phase.Invent && this.inventTarget ? this.inventTarget : target;
    if (useDemo) this.driveDemo(demoTarget, this.animationTime); else this.demoHand.valid = this.demoHand2.valid = false;
    // Filming in an emulator (`?capture` in XR): no passthrough shows the player's hands, so the wooden
    // stand-in follows the real tracked joints. On a headset, real hands are seen through passthrough.
    const shown = this.demoHand.valid ? this.demoHand : this.immersive && captureControl() && this.hands[0].valid ? this.hands[0] : null;
    const shown2 = this.demoHand2.valid ? this.demoHand2 : this.immersive && captureControl() && this.hands[1].valid ? this.hands[1] : null;
    this.puppeteer.opacity = shown ? 1 : 0;
    if (shown) this.puppeteer.update(shown.joints, shown.radii);
    this.puppeteer2.opacity = shown2 ? 1 : 0;
    if (shown2) this.puppeteer2.update(shown2.joints, shown2.radii);

    // Lantern: a dim ember until a hand reaches its light, then a warm flicker.
    this.lit += (this.litTarget - this.lit) * Math.min(1, dt * 3.5);
    const flick = 0.92 + 0.05 * Math.sin(this.animationTime * 7.3) + 0.03 * Math.sin(this.animationTime * 17.1);
    const glow = (0.3 + 0.7 * this.lit) * flick;
    this.lantern.bodyMat.color.setRGB(glow, 0.81 * glow, 0.54 * glow);
    // A pinch near the lantern swells its halo: it can be picked up.
    this.lantern.halo.scale.setScalar((0.14 + 0.16 * this.lit) * (0.96 + 0.04 * flick) * (1 + 0.35 * this.carryNear + (this.carry ? 0.3 : 0)));
    this.lantern.halo.material.opacity = (0.38 + 0.18 * this.lit) * flick;
    (this.lantern.pool.material as MeshBasicMaterial).opacity = 0.32 * this.lit * flick;
    this.audio.tick(dt, this.lit);
    // Spatial sound: the listener is the head; the flame sits in the lantern, creatures on the paper.
    this.camera.getWorldPosition(this.v1);
    this.camera.getWorldQuaternion(this.q0);
    this.v2.set(0, 0, -1).applyQuaternion(this.q0);
    this.v3.set(0, 1, 0).applyQuaternion(this.q0);
    this.audio.place(this.v1, this.v2, this.v3, this.lanternPos, this.screenCentre);
    this.glowLight.position.copy(this.lanternPos);
    this.glowLight.intensity = (0.12 + 0.95 * this.lit) * flick;
    this.wall.setLight(this.lit);
    // The room dims as the lantern blooms (passthrough only; the preview room is already dark).
    // House lights go down first, then the lantern blooms.
    const houseDown = this.immersive ? ease((this.animationTime - Math.max(0, this.sessionAt)) / 2.5) : 0;
    this.dim.update(this.camera.getWorldPosition(this.v0), this.lanternPos, (0.55 + 0.17 * this.lit) * houseDown);
    const finaleDim = this.phase === Phase.Finale
      ? ease((this.phaseTime - FINALE_TIME + 2.2) / 2.2) : this.phase === Phase.Invent ? 0.45 : 0;
    this.paperDim += (finaleDim - this.paperDim) * Math.min(1, dt * 2.5);
    const brightPaper = 0.32 + 0.68 * this.lit;
    const paperTone = brightPaper + (0.32 + 0.68 * EMBER - brightPaper) * this.paperDim;
    this.painter.setTone(paperTone);

    // Shadows: project every hand from the lantern onto the paper.
    const p = this.painter;
    p.begin();
    this.live.clear();
    let casters = 0;
    const L = this.lanternPos;
    this.rays?.begin();
    for (const h of this.allHands) {
      if (!h.valid) continue;
      projectFromLight(h.joints, h.radii, L.x, L.y, L.z, this.frame, h.flat);
      if (!h.flat.valid) continue;
      drawHand(this.live, h.flat);
      this.rays?.add(h.joints, L, this.frame, this.phase === Phase.Seek ? 1 : 0.35);
      casters++;
    }
    this.rays?.end();
    if (this.awaitingLight && casters > 0 && this.shadowOnPaper()) {
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
      case Phase.Invent: this.invent(dt, this.animationTime, casters); break;
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
    this.painter.target(stencil, 0, TARGET_CY, glow, time, ease(this.phaseTime / 0.9));

    // First moment of the first night: light and shadow speak first; words only if nothing happens.
    if (this.saved.nights === 0 && this.step === 0) {
      const quiet = this.animationTime - Math.max(0, this.sessionAt);
      if (!casting && quiet > 5) this.painter.caption('Lift a hand into the lantern light.', ease((quiet - 5) / 0.8));
      else if (casting && this.phaseTime > 6 && close < 0.6) this.painter.caption('Fit your shadow to the shape.', 1);
    }
    // Tonight's name, once the lantern is lit, for a few seconds at the top of the paper.
    if (this.step === 0 && this.lit > 0.7) {
      if (this.nightTitleAt < 0) this.nightTitleAt = time;
      const a = time - this.nightTitleAt;
      if (a < 4.2) this.painter.caption(this.nightTitle, Math.min(ease(a / 0.7), 1 - ease((a - 3.4) / 0.8)), 0.27);
      if (this.fullMoon && a > 1 && a < 5.5) this.painter.caption('A full moon tonight. Everyone is awake a little longer.', Math.min(ease((a - 1) / 0.6), 1 - ease((a - 4.7) / 0.8)), -0.27);
    }
    // Once, after the first creature of a session: the theater can be carried by hand.
    if (this.immersive && this.step === 1 && !this.saved.carried && this.phaseTime > 1 && this.phaseTime < 6) {
      this.painter.caption('Pinch the lantern to carry the theater.', Math.min(ease((this.phaseTime - 1) / 0.6), 1 - ease((this.phaseTime - 5.2) / 0.8)), -0.27);
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
    const hintsAllowed = !this.demo || this.demoDelay > 0;
    if (hint > 0 && hintsAllowed) {
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
    this.ghost.opacity = hintsAllowed ? hint * (0.28 + 0.08 * Math.sin(time * 3)) : 0;
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
      moments(this.live, this.wakeMo);
      this.wakeC0 = this.wakeMo.area > 4 ? { cx: this.wakeMo.cx, cy: this.wakeMo.cy } : null;
      this.follow.x = this.follow.y = this.follow.vx = 0;
      this.enter(Phase.Wake);
    }
  }

  private wake(target: BakedTarget, stencil: Stencil, time: number): void {
    const t = this.phaseTime;
    if (!this.voiced && t >= 0.35) {
      this.voiced = true;
      this.audio.voice(target.def.motion);
    }
    // It comes alive in place and, until it walks off, follows the hand that made it:
    // move the hand and the creature moves with it. Then it walks off the paper's right edge.
    if (this.wakeC0 && t < WALK_AT) {
      moments(this.live, this.wakeMo);
      if (this.wakeMo.area > 4) {
        const tx = Math.max(-0.18, Math.min(0.18, this.wakeMo.cx - this.wakeC0.cx));
        const ty = Math.max(-0.06, Math.min(0.12, this.wakeMo.cy - this.wakeC0.cy));
        const px = this.follow.x;
        this.follow.x += (tx - this.follow.x) * 0.25;
        this.follow.y += (ty - this.follow.y) * 0.25;
        this.follow.vx = this.follow.x - px;
      }
    }
    const walk = ease((t - WALK_AT) / WALK_TIME);
    const fill = ease((t - 0.25) / 0.65);
    if (t < 0.9) this.painter.target(stencil, 0, TARGET_CY, 1, time, 1 - fill, 1 - ease(t / 0.25));
    let x = this.follow.x + walk * (SCREEN_W / 2 + stencil.w / 2 + 0.03 - this.follow.x * 0.5);
    let y = TARGET_CY + this.follow.y * (1 - walk);
    let rot = Math.max(-0.25, Math.min(0.25, -this.follow.vx * 6));
    let stretchX = 1, stretchY = 1;
    switch (target.def.motion) {
      case 'hop': {
        const leap = Math.abs(Math.sin(Math.max(0, t - 0.4) * Math.PI * 1.6));
        const landing = (1 - leap) * (1 - leap) * Math.max(0, 1 - walk);
        y += leap * 0.05;
        stretchX = 1 - 0.07 * leap + 0.11 * landing;
        stretchY = 1 + 0.12 * leap - 0.14 * landing;
        break;
      }
      case 'swim': y += Math.sin(t * 4) * 0.018; rot += Math.cos(t * 4) * 0.08;
        stretchX = 1 + 0.045 * Math.sin(t * 6); stretchY = 1 - 0.025 * Math.sin(t * 6); break;
      case 'crawl': x = x * 0.85 + 0.012 * Math.sin(t * 3.5);
        stretchX = 1 + 0.055 * Math.sin(t * 3.5); stretchY = 1 - 0.045 * Math.sin(t * 3.5); break;
      case 'bob': y += Math.sin(t * 5) * 0.014; rot += Math.sin(t * 5) * 0.07; break;
      case 'fan': stretchX = 1 + 0.1 * Math.sin(t * 3) * (1 - walk); rot += Math.sin(t * 2) * 0.04; break;
      case 'flap': y += 0.03 * Math.sin(t * 5) + walk * 0.12;
        stretchX = 1 + 0.16 * Math.sin(t * 10); stretchY = 1 - 0.05 * Math.sin(t * 10);
        rot += 0.06 * Math.sin(t * 5); break;
      case 'stalk': y += Math.abs(Math.sin(t * 2.2)) * 0.018;
        rot += -0.04 + 0.06 * Math.sin(t * 2.2); x *= 0.9; break;
      case 'scuttle': x += 0.016 * Math.sin(t * 22); y += 0.004 * Math.abs(Math.sin(t * 22));
        rot += 0.045 * Math.sin(t * 22); break;
    }
    const onWall = this.wall.active;
    const alpha = onWall ? 1 : t < 2.3 ? 1 : 1 - ease((t - 2.3) / 0.5);
    const blink = t < 0.87 || (t > 1.35 && t < 1.44) || (t > 2.12 && t < 2.2);
    this.painter.creature(stencil, x, y, 1, rot, false, blink, alpha, Math.max(0, 1 - t / 1.5), time,
      stretchX, stretchY, fill);
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
    const eyePulse = ease((t - FINALE_TIME + 1.4) / 0.35) * (1 - ease((t - FINALE_TIME + 0.35) / 0.35));
    this.wall.cheer(a, eyePulse);
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
      this.inventBorn = false;
      this.inventStable = 0;
      this.inventPrev.area = 0;
      this.makeInventPose();
      this.enter(Phase.Invent);
    }
  }

}

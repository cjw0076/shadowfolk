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
  FlatHand, Mask, Matcher, Moments, NORM, STAGE, ScreenFrame, drawHand, moments, normalise, projectFromLight,
} from '../shadow/silhouette.js';
import { AsyncMatcher } from '../shadow/async-matcher.js';
import { BakedTarget, TARGETS, bakeTarget } from '../shadow/targets.js';
import { FormTracker, type FormState } from '../journey/forms.js';
import { GestureDetector, type GestureState } from '../journey/gestures.js';
import { abilityForForm, generateJourney, type Ability, type JourneyPlan, type ObstacleKind } from '../journey/generator.js';
import { JourneyRuntime, type JourneyInput } from '../journey/runtime.js';
import { JourneyView } from '../journey/view.js';
import { TheaterAudio } from './audio.js';
import { runtimePerf as perf } from './perf.js';
import { SCREEN_H, SCREEN_W, SHADOW_PX_PER_METRE, ScreenPainter, Stencil, StencilPixels,
  makeStencil, makeStencilFromPixels } from './painter.js';
import { RigAnchor } from './anchor.js';
import { LANTERN_ON_TABLE, Surface, TableFit, WallFit, fitPinWall, fitTable, fitWall } from './room.js';
import { GhostHand, Lantern, PaperScreen, RoomDim, buildLantern, buildRoomDim, buildScreen } from './stage.js';
import { SkinHand } from './skin-hand.js';
import { captureControl } from '../capture.js';
import { Moon, isFullMoon, moonPhase } from './moon.js';
import { PreviewRoom } from './preview-room.js';
import { WallLayer } from './wall.js';
import { LightRays } from './rays.js';
import { xrRenderStatusLine } from './xr-render.js';
import { InkField } from '../play/ink-field.js';
import { FolkWorld } from '../play/folk.js';
import { PlayView } from '../play/view.js';
import { arcNight, moonFill, validArcSave, type ArcSave } from '../play/arc.js';
import { CrossingRuntime } from '../play/crossing.js';
import { SummonTrigger } from '../play/summon-trigger.js';
import type { SummonKind } from '../play/summon-contract.js';
import type { HazardKind, LevelHazard } from '../play/levels.js';

const TARGET_CY = 0.02;
/** Lantern placement relative to the seated head: ahead and below the eyes. */
const LANTERN_AHEAD = 0.25;
const LANTERN_DROP = 0.25;
const HOLD_TO_WAKE = 0.55; // seconds the fit must hold
const WAKE_TIME = 3.2;
const LESSON_TIMEOUT = 10;
const LESSON_COPY: Record<Ability, string> = {
  bark: 'Close and open your thumb twice: bark.',
  peck: 'Pinch thumb and index: the beak snaps shut.',
  snip: 'Snap both claws together: the crab snips clean.',
  hop: 'Lift your hand quickly: the rabbit hops high.',
  fan: 'Spread and close your fingers: fan the tail.',
  fly: 'Flap both hands gently: the butterfly rises up.',
  giant: 'Move closer to the lantern: your shadow grows.',
  tiny: 'Move closer to the paper: your shadow shrinks.',
};
const SUMMON_COPY: Record<string, string> = {
  peacock: 'Make the peacock. Hold for its wind.',
  rabbit: 'Make the rabbit. Ferry Kindlings together.',
  snail: 'Make the snail. Hold for a bridge.',
  dog: 'Make the dog. Hold; crows remember teeth.',
  duck: 'Make the duck. Ferry Kindlings across.',
  fish: 'Make the fish. Hold for a bubble.',
  elephant: 'Make the elephant. Hold; rain will listen.',
  heron: 'Make the heron. Hold to catch a fall.',
  crab: 'Make the crab. Hold to cut thorns.',
  butterfly: 'Make the butterfly. Lift Kindlings together.',
  stag: 'Make the stag. Hold against the stone.',
};
const ABILITIES = Object.keys(LESSON_COPY) as Ability[];
/** Wake timeline: the creature comes alive in place, then walks off the paper. */
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
const JOURNEY_TARGET_INDEX = Object.fromEntries(TARGETS.map((target, index) => [target.id, index]));
const DOG_SNOUT_JOINTS = [9, 14, 19, 24] as const;
const FAN_TIP_JOINTS = [9, 14, 19, 24] as const;
const VINE_FORM_IDS = ['duck', 'crab'] as const;
/** Lantern brightness before the first hand reaches its light. */
const EMBER = 0.18;
const STORE_KEY = 'shadow-theater.v1';

enum Phase { Seek, Wake, Rest, Finale, Invent, Journey, Prologue, Crossing, Home, Lesson }

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
  /** Demo play hands are flattened onto one depth for an exact shadow; this restores each joint's
   * depth along its own light ray (metres, same ray, same shadow), only for drawing the stand-in. */
  relief: Float32Array;
  reliefOn: boolean;
  flat: FlatHand;
  valid: boolean;
  lastSeen: number;
}

/** A shadow the player invented: its hands' flat shapes on the paper (metres), an eye, a name. */
interface Invented { id: string; name: string; hands: { x: number[]; y: number[]; r: number[] }[]; eye: [number, number, number, number] }
interface Saved {
  nights: number; woken: Record<string, number>; order?: string[]; carried?: boolean; invented?: Invented[];
  oneHand?: boolean; oneHandAdaptations?: number; deferred?: string[];
  journeysCompleted?: number; abilityUses?: Record<string, number>;
  abilities?: Ability[]; lessonSkipped?: Ability[];
  v3?: ArcSave;
}

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
        const deferred = Array.isArray(candidate.deferred)
          ? [...new Set(candidate.deferred.filter((id): id is string => typeof id === 'string'
            && TARGETS.some((target) => target.id === id && !!target.partner)))] : undefined;
        const oneHandAdaptations = Number.isSafeInteger(candidate.oneHandAdaptations)
          && candidate.oneHandAdaptations! >= 0 ? Math.min(2, candidate.oneHandAdaptations!) : 0;
        const journeysCompleted = Number.isSafeInteger(candidate.journeysCompleted) && candidate.journeysCompleted! >= 0
          ? candidate.journeysCompleted! : 0;
        const abilityUses: Record<string, number> = {};
        for (const ability of ABILITIES) {
          const count = candidate.abilityUses?.[ability];
          if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) abilityUses[ability] = count;
        }
        const abilities = Array.isArray(candidate.abilities)
          ? ABILITIES.filter((ability) => candidate.abilities!.includes(ability))
          : ABILITIES.filter((ability) => TARGETS.some((target) => woken[target.id] > 0 && abilityForForm(target.id) === ability));
        const lessonSkipped = Array.isArray(candidate.lessonSkipped)
          ? ABILITIES.filter((ability) => candidate.lessonSkipped!.includes(ability)) : [];
        return { nights, woken, order, carried: candidate.carried === true, invented,
          oneHand: candidate.oneHand === true, oneHandAdaptations, deferred, journeysCompleted, abilityUses,
          abilities, lessonSkipped, v3: validArcSave(candidate.v3, nights) };
      }
    }
  } catch { /* private mode: play without memory */ }
  return { nights: 0, woken: {}, abilities: [], lessonSkipped: [], v3: validArcSave(null) };
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
  private puppeteer!: SkinHand; // visible demo hand in the browser preview
  private puppeteer2!: SkinHand;
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
  private demoOneHand = false;
  /** `?demoDepth` (filming): before forming a shape, the demo hand moves toward the lantern and back. */
  private demoDepth = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demoDepth');
  private idle = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf')
    && new URLSearchParams(location.search).has('idle');
  /** `?rays` (explainer): draw the lantern's light rays through each hand onto the paper. */
  private rays = typeof location !== 'undefined' && new URLSearchParams(location.search).has('rays') ? new LightRays() : null;
  private journeyDebug = typeof location !== 'undefined' && new URLSearchParams(location.search).has('journeyDebug');
  private journeyEnabled = typeof location === 'undefined' || !new URLSearchParams(location.search).has('noJourney');
  private journeyOnly = typeof location !== 'undefined' && new URLSearchParams(location.search).has('journeyOnly');
  private playSandbox = typeof location !== 'undefined' && new URLSearchParams(location.search).has('playSandbox');
  private classic = typeof location !== 'undefined' && new URLSearchParams(location.search).has('classic');
  private crossingOnly = typeof location !== 'undefined' && new URLSearchParams(location.search).has('crossingOnly');
  private summonFilm = typeof location !== 'undefined' && new URLSearchParams(location.search).has('summonFilm');
  private forcedNight = typeof location !== 'undefined' && new URLSearchParams(location.search).has('night')
    ? Number(new URLSearchParams(location.search).get('night')) : NaN;
  private crossingSeed = typeof location !== 'undefined' && new URLSearchParams(location.search).has('seed')
    ? Number(new URLSearchParams(location.search).get('seed')) : NaN;
  private playDebug = typeof location !== 'undefined' && new URLSearchParams(location.search).has('playDebug');
  private playCell = typeof location !== 'undefined' && new URLSearchParams(location.search).get('playCell') === '0.008' ? 0.008 : 0.010;
  private playField: InkField | null = null;
  private playFolk: FolkWorld | null = null;
  private playView: PlayView | null = null;
  private crossing: CrossingRuntime | null = null;
  private readonly summonTrigger = new SummonTrigger();
  private readonly summonCandidates: number[] = [];
  private readonly summonKnown: number[] = [];
  private readonly summonRequested = typeof location === 'undefined' ? ''
    : new URLSearchParams(location.search).get('summonTarget') ?? '';
  private summonProbeAt = -Infinity;
  private summonProbe = 0;
  private summonDemoScreen = -1;
  private summonDemoKind: SummonKind | null = null;
  private summonDemoX = -0.27;
  private crossingCaption = '';
  private crossingCaptionAt = -Infinity;
  private crossingHintAt = -Infinity;
  private crossingHintX = 0;
  private crossingHintY = -0.23;
  private crossingHomeAt = -Infinity;
  private lessonOrder: number[] = [];
  private lessonIndex = 0;
  private lessonSummonFired = false;
  private playDemoPose!: HandPose;
  private playDemoCup!: HandPose;
  private playDemoAt = 0;
  private playDemoAct = -1;
  private playDemoSpawned = 0;
  private crossingDemoScreen = -1;
  private crossingDemoAt = 0;
  private crossingDemoFromX = -0.17;
  private crossingDemoFromY = -0.23;
  private crossingDemoX = -0.17;
  private crossingDemoY = -0.23;
  private crossingDemoFlicked = [new Uint8Array(48), new Uint8Array(48)];
  private crossingDemoFlickAt = [-Infinity, -Infinity];
  private crossingDemoFlickSlot = [-1, -1];
  private crossingDemoCrowAt = [-Infinity, -Infinity];
  private crossingDemoCrowPose = new Float32Array(2);
  private crossingDemoBoulderPose = new Float32Array(2);
  private journey: JourneyRuntime | null = null;
  private journeyView: JourneyView | null = null;
  private journeyPlan: JourneyPlan | null = null;
  private journeyInput: JourneyInput = {
    form: { form: -1, score: 0, stable: false }, formId: '',
    gesture: { bark: false, peck: false, snip: false, hop: false, fan: false, fly: false,
      scale: 1, giant: false, tiny: false, jaw: 0, beak: 0, spread: 0, verticalVelocity: 0 },
    x: 0, y: 0, anchorX: 0, anchorY: 0,
  };
  private demoJourneyForm: FormState = { form: -1, score: 1, stable: true };
  private demoJourneyGesture: GestureState = { bark: false, peck: false, snip: false, hop: false, fan: false, fly: false,
    scale: 1, giant: false, tiny: false, jaw: 0, beak: 0, spread: 0, verticalVelocity: 0 };
  private demoJourneyX = -0.42;
  private demoJourneyIndex = -1;
  private demoJourneyAt = 0;
  private demoJourneyStartX = -0.42;
  private demoJourneyPriorForm = -1;
  private demoJourneyHop = 0;
  private demoJourneyZoneAt = -1;
  private demoJourneyPulse = -1;
  private journeyPossession = 0;
  private journeyEyeX = 0;
  private journeyEyeY = 0;
  private journeyGestureAt = -Infinity;
  private journeyMatcher: AsyncMatcher | null = null;
  private journeyForms: FormTracker | null = null;
  private summonMatcher: AsyncMatcher | null = null;
  private summonForms: FormTracker | null = null;
  private journeyGestures: GestureDetector | null = null;
  private journeyHands: LiveHand[] = [];
  private journeyCandidates = [0, 0, 0, 0];
  private journeyProbe = 0;
  private journeyProbeAt = 0;
  private journeyKnown: number[] = [];
  private journeyRecent: number[] = [];
  private journeyLastForm = -1;
  private journeyLastObstacleIndex = 0;
  private journeyShownForm = -1;
  private journeyNameAt = -Infinity;
  private journeyArrivedAt = -Infinity;
  private journeyBlurryFor = 0;
  private lessonAbility: Ability | null = null;
  private lessonResolvedAt = -1;
  private journeyFormState: FormState | null = null;
  private journeyGestureState: GestureState | null = null;
  private journeyLastEvent = '—';
  private journeyLine = '';
  private journeyLineAt = -Infinity;
  private lit = 1; // lantern brightness 0..1
  private litTarget = 1;
  private paperDim = 0;
  private awaitingLight = false;
  private sessionAt = -1;
  private voiced = false;
  private oneHand = 0; // seek seconds with at most one tracked shadow
  private oneHandSeen = false;
  private twoHandsSeen = false;
  private bothHandsTime = 0;
  private clearOneHandThisSession = false;
  private reform: { old: number; elapsed: number } | null = null;
  private fresh = -1; // index into TARGETS of tonight's newly joined creature
  private nightTitle = '';
  private moon = new Moon(0.11);
  private moonPreviewBest: number[] | null = null;
  private fullMoon = false;
  // Inventing a creature of your own after the finale.
  private inventStencils = new Map<string, Stencil>();
  private inventStable = 0;
  private inventPrev: Moments = { area: 0, cx: 0, cy: 0 };
  private inventMo: Moments = { area: 0, cx: 0, cy: 0 };
  private inventBorn = false;
  private inventPending = false;
  private inventWorker: Worker | null = null;
  private inventSerial = 0;
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
  private reliefJoints = [new Float32Array(JOINT_COUNT * 3), new Float32Array(JOINT_COUNT * 3)];
  private demoHand2!: LiveHand;
  private live = new Mask(170, 120, -0.68, -0.48, 0.008);
  private matcher = new Matcher();
  private asyncMatcher: AsyncMatcher | null = null;

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
  private demoShift: [number, number, number] = [0, 0, 0];
  private demoFrom!: HandPose;
  private demoFrom2!: HandPose;
  private ghostPose!: HandPose;
  private ghostPose2!: HandPose;
  private posePositions2 = new Float32Array(JOINT_COUNT * 3);

  init(): void {
    this.demo = new URLSearchParams(location.search).has('demo');
    this.demoOneHand = this.demo && new URLSearchParams(location.search).has('demoOneHand');
    this.painter = new ScreenPainter(() => xrRenderStatusLine(this.world.renderer));
    this.lantern = buildLantern();
    this.dim = buildRoomDim();
    this.screen = buildScreen(this.painter);
    this.ghost = new GhostHand();
    this.ghost2 = new GhostHand('GhostHand2');
    this.puppeteer = new SkinHand('DemoHand', 'left');
    this.puppeteer2 = new SkinHand('DemoHand2', 'right');
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
      relief: new Float32Array(JOINT_COUNT), reliefOn: false,
      flat: new FlatHand(), valid: false, lastSeen: -1,
    });
    this.hands = [mk(), mk()];
    this.demoHand = mk();
    this.demoHand2 = mk();
    this.allHands = [...this.hands, this.demoHand, this.demoHand2];
    this.journeyHands = [this.hands[0], this.hands[1]];
    if (!this.idle && !this.playSandbox) this.journeyGestures = new GestureDetector();
    if (!this.playSandbox && (this.journeyDebug || this.journeyEnabled || this.journeyOnly || !this.classic) && typeof Worker !== 'undefined') {
      this.journeyMatcher = new AsyncMatcher(this.baked.map((baked) => baked.template),
        this.journeyHands, this.baked.map((baked) => !!baked.partner));
      this.journeyForms = new FormTracker(this.baked, this.journeyMatcher);
    }
    if (!this.playSandbox && !this.classic && typeof Worker !== 'undefined') this.rebuildSummonMatcher();
    this.cleanupFuncs.push(() => {
      this.asyncMatcher?.dispose();
      this.journeyMatcher?.dispose();
      this.summonMatcher?.dispose();
      this.inventWorker?.terminate();
      this.journeyView?.dispose();
    });
    if (!this.idle && !this.playSandbox) {
      this.journeyView = new JourneyView();
      this.painter.root.add(this.journeyView.root);
    }
    if ((this.playSandbox || !this.classic && !this.journeyOnly) && !this.idle) {
      this.playField = new InkField(this.playCell);
      if (this.playSandbox) {
        this.playField.setStaticRect(-0.5, -0.212, -0.06, -0.196);
        this.playField.setStaticRect(0.06, -0.212, 0.30, -0.196);
        this.playField.setStaticRect(0.30, -0.212, 0.32, -0.096);
        this.playField.setStaticRect(0.32, -0.112, 0.5, -0.096);
      }
      this.playFolk = new FolkWorld(this.playField, 2026);
      if (this.playSandbox) {
        this.playFolk.configure({ waveCount: 5 });
        this.playFolk.onEvent = (kind) => this.audio.play(kind);
      }
      this.playView = new PlayView(this.playField, this.playDebug);
      this.painter.root.add(this.playView.root);
      this.playView.root.visible = this.playSandbox;
      this.playDemoPose = orient(basePoses.relaxed(), [-25, 0, 0]);
      this.playDemoCup = shape(basePoses.relaxed(), { index: 0.65, middle: 0.65, ring: 0.65, pinky: 0.65 });
      if (!this.playSandbox) {
        this.crossing = new CrossingRuntime(this.playField, this.playFolk, this.playView);
        for (let index = 0; index < TARGETS.length; index++)
          this.crossing.summons.setArt(TARGETS[index].id as SummonKind, this.stencils[index]);
        this.crossing.summons.onFire = (agent) => {
          this.audio.play('summon');
          this.wall.setSummonCooldown(agent.id, this.animationTime + 12);
          if (this.phase === Phase.Lesson) this.lessonSummonFired = true;
        };
        if (perf) this.crossing.onHazardTiming = (milliseconds) => perf!.playHazards.push(milliseconds);
        this.crossing.onEvent = (event) => {
          if (this.phase === Phase.Lesson) return;
          if (event.kind === 'home') {
            this.audio.play('home');
            this.audio.chime(event.home);
            this.moon.arrive(0.5 * Math.min(1, moonFill(this.moonPreviewBest ?? this.saved.v3!.best)
              + event.home / Math.max(1, event.total) / 8));
            if (this.phase === Phase.Prologue) {
              this.crossingCaption = 'One spark home. The moon remembers.';
              this.crossingCaptionAt = this.animationTime;
            }
          } else if (event.kind === 'ash') this.audio.play('ash');
          else if (event.kind === 'warning') {
            this.crossingCaption = 'The candle is nearly out.';
            this.crossingCaptionAt = this.animationTime;
            this.audio.play('hiss');
          }
        };
        this.crossing.hazards.onHint = (kind, layout) => {
          this.crossingHintAt = this.animationTime;
          this.crossingHintX = layout.x;
          this.crossingHintY = kind === 'rain' ? -0.055 : kind === 'crow' ? 0.04 : -0.23;
          const wick = this.playFolk?.agents[0];
          if (wick?.isWick && wick.state === 'walking') wick.heading = layout.x >= wick.x ? 1 : -1;
        };
        this.crossing.hazards.onEvent = (event) => {
          if (event.kind === 'crow-swat' || event.kind === 'crow-grab') this.audio.play('caw');
          else if (event.kind === 'rain-hit' || event.kind === 'river-douse') this.audio.play('hiss');
        };
      }
      this.cleanupFuncs.push(() => { this.crossing?.summons.dispose(); this.crossing?.hazards.dispose(); this.playView?.dispose(); });
    }
    this.mirrored = this.baked.map((b) => mirror(b.pose));
    this.demoFrom = basePoses.relaxed();
    this.demoFrom2 = mirror(basePoses.relaxed());
    this.ghostPose = basePoses.relaxed();
    this.ghostPose2 = basePoses.relaxed();
    this.wall.onSettle = () => this.audio.settle();
    this.wall.setFireflies(this.saved.v3?.fireflies ?? 0);
    // Tonight's moon sits in the paper's top-left corner, under the shadows.
    this.moon.mesh.position.set(SCREEN_W / 2 - 0.095, SCREEN_H / 2 - 0.09, 0.0002);
    this.painter.root.add(this.moon.mesh);
    const cap = captureControl();
    if (cap) this.audio.onCue = (kind, arg) => cap.cues.push({ t: cap.time, kind, arg });
    if (cap) {
      const names = ['seek', 'wake', 'rest', 'finale', 'invent', 'journey', 'prologue', 'crossing', 'home', 'lesson'];
      cap.state = () => ({
        phase: names[this.phase], step: this.step, target: this.baked[this.order[this.step % this.order.length]]?.def.id,
        mode: this.mode, born: this.inventBorn, wall: this.wall.active,
        journey: this.journey ? { index: this.journey.index, spark: this.journey.spark,
          carried: this.journey.carried, completed: this.journey.completed } : null,
        play: this.playFolk ? { count: this.playFolk.count, home: this.playFolk.homeCount,
          ash: this.playFolk.ashCount } : null,
        crossing: this.crossing ? { night: this.crossing.night, screen: this.crossing.screen,
          home: this.crossing.home, ash: this.crossing.ash, lost: this.crossing.lost,
          total: this.crossing.total, candle: this.crossing.candle, stars: this.crossing.stars,
          finished: this.crossing.finished, summons: this.crossing.summons.agents
            .filter((agent) => agent.age < 8.8).map((agent) => ({ kind: agent.kind, x: agent.x,
              y: agent.y, age: agent.age, uses: agent.uses })),
          summonFires: this.crossing.summons.fireCount,
          autoSummonFires: this.crossing.summons.autoFireCount } : null,
      });
    }
    this.newNight();
    if (this.journeyOnly && !this.playSandbox) this.beginJourney();
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
    this.journeyForms?.reset();
    this.summonForms?.reset();
    this.journeyGestures?.reset();
  }

  /**
   * Tonight's shapes. Creatures join in TARGETS order: the first night knows
   * five, and every later night brings one newcomer (saved for last) until
   * all are known. The rest of the order is seeded by date and night.
   */
  private newNight(): void {
    if (!this.classic && !this.playSandbox && !this.journeyOnly && !this.idle) {
      this.newArcNight();
      return;
    }
    this.inventWorker?.terminate();
    this.inventWorker = null;
    this.inventPending = false;
    this.inventSerial++;
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
    if ((!this.saved.oneHand || this.twoHandsSeen) && this.saved.deferred?.length) {
      const deferred = this.saved.deferred.map((id) => TARGETS.findIndex((target) => target.id === id))
        .find((index) => index >= 0 && index < known && !this.order.slice(0, NIGHT_LENGTH).includes(index));
      if (deferred !== undefined) this.order[Math.min(1, this.order.length - 1)] = deferred;
    }
    this.step = 0;
    if (this.saved.oneHand && !this.twoHandsSeen) this.suppressTwoHandTargets();
    const key = nights === 0 ? 'first' : this.fresh >= 0 ? TARGETS[this.fresh].id : '';
    this.nightTitle = `Night ${nights + 1} \u00b7 ${NIGHT_NAMES[key] ?? 'Old Friends'}`;
    const phase = moonPhase();
    this.moon.setPhase(phase);
    this.fullMoon = isFullMoon(phase);
    this.nightTitleAt = -1;
    this.enter(Phase.Seek);
  }

  private newArcNight(): void {
    const progress = this.saved.v3 ?? (this.saved.v3 = validArcSave(null, this.saved.nights));
    const night = Number.isSafeInteger(this.forcedNight) && this.forcedNight >= 0
      ? this.forcedNight : this.crossingOnly ? Math.max(1, progress.night) : progress.prologue ? 0 : progress.night;
    this.moonPreviewBest = null;
    if ((this.demo || captureControl()) && Number.isSafeInteger(this.forcedNight)
      && night > 1 && night <= 8 && progress.nightsPlayed === 0
      && progress.best.every((score) => score === 0)) {
      this.moonPreviewBest = progress.best.slice();
      for (let prior = 1; prior < night; prior++) this.moonPreviewBest[prior] = 0.85;
    }
    const plan = arcNight(night, this.arcSeed());
    this.nightTitle = plan.moon;
    this.step = 0;
    this.order = plan.wakes.filter((id) => !(this.saved.woken[id] > 0))
      .map((id) => TARGETS.findIndex((target) => target.id === id)).filter((index) => index >= 0);
    this.lessonOrder = plan.wakes.filter((id) => this.saved.woken[id] > 0)
      .map((id) => TARGETS.findIndex((target) => target.id === id)).filter((index) => index >= 0);
    this.lessonIndex = 0;
    this.fresh = this.order[0] ?? -1;
    this.moon.setPhase(night > 8 ? moonPhase() : 0.5 * moonFill(this.moonPreviewBest ?? progress.best));
    this.moon.setStars(0);
    this.fullMoon = night > 8 && isFullMoon(moonPhase());
    this.nightTitleAt = -1;
    if (night === 0 || this.crossingOnly) this.beginCrossing(night);
    else if (this.order.length === 0) this.beginKnownLessons();
    else this.enter(Phase.Seek);
  }

  private beginKnownLessons(): void {
    if (this.lessonIndex === 0 && this.fresh >= 0 && !this.lessonOrder.includes(this.fresh))
      this.lessonOrder.unshift(this.fresh);
    if (this.lessonIndex >= this.lessonOrder.length) { this.beginCrossing(); return; }
    this.enter(Phase.Lesson);
  }

  private rebuildSummonMatcher(): void {
    this.summonMatcher?.dispose();
    const targets = this.baked.slice();
    for (const invented of this.saved.invented ?? []) {
      const mask = new Mask(170, 120, -0.68, -0.48, 0.008);
      for (const source of invented.hands) {
        const hand = new FlatHand();
        hand.x.set(source.x);
        hand.y.set(source.y);
        hand.r.set(source.r);
        hand.valid = true;
        drawHand(mask, hand);
      }
      const template = new Uint8Array(NORM * NORM);
      normalise(mask, moments(mask, { area: 0, cx: 0, cy: 0 }), template);
      targets.push({ ...this.baked[0], def: { ...this.baked[0].def, id: invented.id, creature: invented.name },
        template, pass: 0.65, partner: invented.hands.length > 1 ? this.baked[5].partner : undefined });
    }
    this.summonMatcher = new AsyncMatcher(targets.map((target) => target.template), this.journeyHands,
      targets.map((target) => !!target.partner));
    this.summonForms = new FormTracker(targets, this.summonMatcher);
  }

  private startSummonLesson(): void {
    const index = this.lessonOrder[this.lessonIndex];
    const kind = TARGETS[index]?.id;
    if (!kind || !this.crossing || !this.playView) return;
    const trouble: HazardKind = kind === 'dog' ? 'crow' : kind === 'duck' || kind === 'fish' ? 'river'
      : kind === 'elephant' ? 'rain' : kind === 'heron' || kind === 'butterfly' ? 'highLedge'
        : kind === 'crab' ? 'thorns' : kind === 'stag' ? 'boulder' : 'gap';
    this.crossing.start(1, this.arcSeed() ^ index, [trouble], 5);
    this.playFolk?.configure({ spawnX: -0.37 });
    this.playView.root.visible = true;
    this.lessonSummonFired = false;
    this.summonTrigger.reset();
    this.summonForms?.reset();
    this.summonKnown.length = 0;
    this.summonKnown.push(index);
  }

  private arcSeed(): number {
    return Number.isSafeInteger(this.crossingSeed) ? this.crossingSeed : Math.floor(Date.now() / 86400000);
  }

  private beginCrossing(night = Number.isSafeInteger(this.forcedNight) && this.forcedNight >= 0
    ? this.forcedNight : this.saved.v3?.night ?? 1): void {
    if (!this.crossing) return;
    const params = new URLSearchParams(location.search);
    const hazards = this.crossingOnly ? (params.get('hazards') ?? '').split(',')
      .filter((kind): kind is HazardKind => ['gap', 'ledge', 'highLedge', 'river', 'crow', 'rain', 'thorns', 'gust', 'boulder'].includes(kind)) : undefined;
    const count = Number(params.get('kindlings'));
    this.crossing.start(night, this.arcSeed(), hazards,
      this.crossingOnly && Number.isSafeInteger(count) && count > 0 ? Math.min(40, count) : undefined);
    this.playFolk?.configure({ spawnX: -0.44 });
    this.summonTrigger.reset();
    this.summonForms?.reset();
    this.summonProbeAt = -Infinity;
    this.summonProbe = 0;
    this.summonDemoScreen = -1;
    this.summonDemoKind = null;
    this.summonKnown.length = 0;
    for (let index = 0; index < TARGETS.length; index++) {
      if (this.saved.woken[TARGETS[index].id] > 0 || this.crossingOnly)
        this.summonKnown.push(index);
    }
    for (let index = 0; index < (this.saved.invented?.length ?? 0); index++)
      this.summonKnown.push(TARGETS.length + index);
    const firstInvented = this.saved.invented?.[0];
    if (firstInvented) this.crossing.summons.setArt('invented', this.stencilOf(firstInvented.id));
    this.crossingDemoScreen = -1;
    this.crossingDemoFlicked[0].fill(0);
    this.crossingDemoFlicked[1].fill(0);
    this.crossingDemoFlickAt[0] = this.crossingDemoFlickAt[1] = -Infinity;
    this.crossingDemoFlickSlot[0] = this.crossingDemoFlickSlot[1] = -1;
    this.crossingDemoCrowAt[0] = this.crossingDemoCrowAt[1] = -Infinity;
    this.crossingHintAt = -Infinity;
    this.crossingCaption = night === 0 ? 'Every lantern in the shadow-world has gone out.'
      : `${arcNight(night, this.arcSeed()).moon} · Guide them home.`;
    this.crossingCaptionAt = this.animationTime;
    this.crossingHomeAt = -Infinity;
    this.playView!.root.visible = true;
    this.enter(night === 0 ? Phase.Prologue : Phase.Crossing);
  }

  private finishCrossing(): void {
    const crossing = this.crossing!;
    const progress = this.saved.v3!;
    this.playView!.root.visible = false;
    if (crossing.night === 0) {
      progress.prologue = false;
      progress.night = 1;
      if (this.forcedNight === 0) this.forcedNight = 1;
      save(this.saved);
      this.crossingCaption = 'Shadows sleep without light. Wake them.';
      this.crossingCaptionAt = this.animationTime;
      this.newArcNight();
      return;
    }
    const fraction = crossing.home / Math.max(1, crossing.total);
    if (crossing.night <= 8) progress.best[crossing.night] = Math.max(progress.best[crossing.night], fraction);
    if (this.moonPreviewBest && crossing.night <= 8)
      this.moonPreviewBest[crossing.night] = Math.max(this.moonPreviewBest[crossing.night], fraction);
    progress.fireflies += crossing.home;
    progress.nightsPlayed++;
    progress.night = crossing.night + 1;
    this.saved.nights++;
    save(this.saved);
    this.wall.setFireflies(progress.fireflies, this.animationTime);
    this.moon.setPhase(crossing.night > 8 ? moonPhase() : 0.5 * moonFill(this.moonPreviewBest ?? progress.best));
    this.moon.setStars(crossing.stars);
    this.crossingHomeAt = this.animationTime;
    this.enter(Phase.Home);
  }

  private replacement(slot: number): number {
    const known = Math.min(TARGETS.length, FIRST_NIGHT + this.saved.nights);
    const candidates = TARGETS.slice(0, known).map((target, index) => ({ target, index }))
      .filter(({ target }) => !target.partner);
    const available = candidates.filter(({ index }) => !this.order.slice(0, NIGHT_LENGTH).includes(index));
    const notYetPlayed = candidates.filter(({ index }) => !this.order.slice(0, slot).includes(index));
    const pool = available.length ? available : notYetPlayed.length ? notYetPlayed : candidates;
    pool.sort((a, b) => (this.saved.woken[a.target.id] ?? 0) - (this.saved.woken[b.target.id] ?? 0) || a.index - b.index);
    return pool[0].index;
  }

  private replaceTwoHand(slot: number, animate: boolean): void {
    const old = this.order[slot];
    if (!TARGETS[old].partner) return;
    this.order[slot] = this.replacement(slot);
    const deferred = this.saved.deferred ?? (this.saved.deferred = []);
    if (!deferred.includes(TARGETS[old].id)) deferred.push(TARGETS[old].id);
    if (this.fresh === old) this.fresh = -1;
    if (animate) {
      this.reform = { old, elapsed: 0 };
      this.score = this.hold = this.stuck = this.oneHand = 0;
      this.oneHandSeen = false;
      this.ghost.opacity = this.ghost2.opacity = 0;
      this.audio.setHold(0);
    }
  }

  private suppressTwoHandTargets(): void {
    for (let slot = this.step; slot < Math.min(NIGHT_LENGTH, this.order.length); slot++) {
      if (TARGETS[this.order[slot]].partner) this.replaceTwoHand(slot, false);
    }
    save(this.saved);
  }

  private adaptOneHand(): void {
    this.replaceTwoHand(this.step, true);
    this.saved.oneHandAdaptations = Math.min(2, (this.saved.oneHandAdaptations ?? 0) + 1);
    if (this.saved.oneHandAdaptations >= 2) {
      this.saved.oneHand = true;
      this.suppressTwoHandTargets();
    }
    save(this.saved);
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
    if (p !== Phase.Journey) this.journeyView?.hide();
    if (p === Phase.Wake) {
      this.lessonAbility = abilityForForm(this.baked[this.order[this.step]]?.def.id) ?? null;
      this.lessonResolvedAt = -1;
      this.journeyGestures?.reset();
    }
    if (p === Phase.Lesson) this.startSummonLesson();
    this.leapt = this.voiced = false;
    this.phaseTime = 0;
    this.hold = 0;
    this.stuck = 0;
    this.score = 0;
    this.oneHand = 0;
    this.oneHandSeen = false;
    this.reform = null;
    if (p === Phase.Seek) this.audio.rustle();
  }

  private beginJourney(): void {
    const params = new URLSearchParams(location.search);
    const fixedDay = Number(params.get('day'));
    const day = Number.isFinite(fixedDay) && fixedDay > 0 ? fixedDay : Math.floor(Date.now() / 86400000);
    const night = this.journeyOnly ? Math.max(1, Number(params.get('night')) || 1) : this.saved.nights;
    const learned = this.journeyOnly ? TARGETS.map((target) => target.id)
      : TARGETS.filter((target) => (this.saved.woken[target.id] ?? 0) > 0).map((target) => target.id);
    this.journeyKnown = learned.map((id) => JOURNEY_TARGET_INDEX[id]).filter((index) => index !== undefined);
    this.journeyProbe = 0;
    this.journeyProbeAt = 0;
    this.journeyLastForm = -1;
    this.journeyLastObstacleIndex = 0;
    this.journeyShownForm = -1;
    this.journeyArrivedAt = -Infinity;
    this.journeyBlurryFor = 0;
    this.journeyRecent.length = 0;
    const oneHand = this.saved.oneHand === true || this.demoOneHand;
    const newcomer = this.fresh >= 0 ? TARGETS[this.fresh].id : night === 1 ? TARGETS[0].id : null;
    const plan = generateJourney(day, night, learned, newcomer, oneHand);
    const specified = params.get('obstacles');
    if (this.journeyOnly && specified) {
      const kinds: ObstacleKind[] = specified.split(',').filter((value): value is ObstacleKind =>
        ['crow', 'vine', 'gap', 'fog', 'ledge', 'boulder', 'crack'].includes(value));
      const ability = { crow: 'bark', vine: 'peck', gap: 'hop', fog: 'fan', ledge: oneHand ? 'hop' : 'fly',
        boulder: 'giant', crack: 'tiny' } as const;
      if (kinds.length) plan.obstacles = kinds.map((kind, index) => ({ kind, ability: ability[kind],
        x: kinds.length === 1 ? 0 : -0.27 + index * 0.51 / (kinds.length - 1),
        combined: false, ramp: kind === 'ledge' && oneHand }));
    }
    this.journeyPlan = plan;
    this.journey = new JourneyRuntime(plan);
    this.journeyForms?.reset();
    this.journeyGestures?.reset();
    this.demoJourneyX = -0.42;
    this.demoJourneyStartX = -0.42;
    this.demoJourneyForm.form = -1;
    this.demoJourneyIndex = -1;
    this.demoJourneyPulse = -1;
    this.demoJourneyZoneAt = -1;
    this.journeyPossession = 0;
    this.journeyGestureAt = -Infinity;
    this.ghost.opacity = this.ghost2.opacity = 0;
    this.journeyView?.start(this.journey);
    this.enter(Phase.Journey);
  }

  private journeyFormFor(obstacle: ObstacleKind | undefined, ability?: Ability): number {
    const id = obstacle === 'crow' ? 'dog' : obstacle === 'vine' ? ability === 'snip' ? 'crab' : 'heron'
      : obstacle === 'gap' ? 'rabbit' : obstacle === 'fog' ? 'peacock'
      : obstacle === 'ledge' ? this.saved.oneHand || this.demoOneHand ? 'rabbit' : 'butterfly'
      : obstacle === 'boulder' ? this.journeyOnly || (this.saved.woken.dog ?? 0) > 0 ? 'dog' : 'peacock'
      : obstacle === 'crack' ? 'snail' : 'dog';
    return JOURNEY_TARGET_INDEX[id];
  }

  private driveJourneyDemo(dt: number): void {
    const journey = this.journey!;
    if (journey.index !== this.demoJourneyIndex) {
      this.demoJourneyPriorForm = this.demoJourneyForm.form;
      this.demoJourneyStartX = this.demoJourneyX;
      this.demoJourneyIndex = journey.index;
      this.demoJourneyAt = this.phaseTime;
      this.demoJourneyPulse = -1;
      this.demoJourneyZoneAt = -1;
    }
    const obstacle = journey.current;
    const motion = this.phaseTime - this.demoJourneyAt;
    const approachX = obstacle ? obstacle.x - 0.045 : 0.43;
    if (obstacle && motion < 1.5) {
      this.demoJourneyX = this.demoJourneyStartX + (approachX - this.demoJourneyStartX) * ease(motion / 1.5);
    } else if (obstacle && motion < 5.2) {
      this.demoJourneyX = approachX;
    } else {
      const targetX = obstacle ? obstacle.x + 0.085 : 0.43;
      const speed = Math.min(Math.abs(targetX - this.demoJourneyX), dt * 0.16);
      this.demoJourneyX += Math.sign(targetX - this.demoJourneyX) * speed;
    }
    if (obstacle && motion >= 1.5 && this.demoJourneyZoneAt < 0) {
      this.demoJourneyZoneAt = this.phaseTime;
    }
    const target = this.baked[this.journeyFormFor(obstacle?.kind, obstacle?.ability)];
    const formIndex = this.baked.indexOf(target);
    this.demoJourneyForm.form = motion < 2.5 && this.demoJourneyPriorForm >= 0
      ? this.demoJourneyPriorForm : formIndex;
    const prior = this.demoJourneyPriorForm >= 0 ? this.baked[this.demoJourneyPriorForm] : null;
    const morph = ease((motion - 1.5) / 1);
    const from = prior?.pose ?? this.demoFrom;
    for (let axis = 0; axis < this.ghostPose.mats.length; axis++) {
      this.ghostPose.mats[axis] = from.mats[axis] + (target.pose.mats[axis] - from.mats[axis]) * morph;
    }
    this.ghostPose.radii.set(target.pose.radii);
    this.poseToWorld(this.ghostPose, this.posePositions, 0, target.shifts[0]);
    const frame = this.frame;
    const gestureMotion = this.demoJourneyZoneAt < 0 ? 0 : this.phaseTime - this.demoJourneyZoneAt;
    const acting = motion >= 2.5 && motion < 4;
    const flap = acting && obstacle?.kind === 'ledge' ? 0.035 * Math.sin(gestureMotion * 15) : 0;
    const hop = acting && (obstacle?.kind === 'gap' || obstacle?.ramp)
      ? Math.max(0, Math.sin(gestureMotion * 9)) * 0.055 : 0;
    const depth = -0.10 + (acting && obstacle?.kind === 'boulder' ? 0.12 * ease((gestureMotion - 1) / 0.45)
      : acting && obstacle?.kind === 'crack' ? -0.13 * ease((gestureMotion - 1) / 0.45) : 0);
    const ratio = STAGE.lightToScreen / (STAGE.lightToHand - depth);
    const dx = this.demoJourneyX / ratio;
    this.demoJourneyHop = hop * ratio;
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      const offset = joint * 3;
      this.posePositions[offset] += dx * frame.rx + (flap + hop) * frame.ux + depth * frame.nx;
      this.posePositions[offset + 1] += dx * frame.ry + (flap + hop) * frame.uy + depth * frame.ny;
      this.posePositions[offset + 2] += dx * frame.rz + (flap + hop) * frame.uz + depth * frame.nz;
    }
    if (acting && (obstacle?.kind === 'crow' || obstacle?.kind === 'vine')) {
      const close = (1 - Math.cos(gestureMotion * 13)) * 0.27;
      for (let axis = 0; axis < 3; axis++) {
        this.posePositions[4 * 3 + axis] += (this.posePositions[9 * 3 + axis] - this.posePositions[4 * 3 + axis]) * close;
      }
    }
    if (acting && obstacle?.kind === 'fog') {
      const fan = 0.014 * Math.sin(gestureMotion * 13);
      for (let finger = 0; finger < 4; finger++) {
        const offset = FAN_TIP_JOINTS[finger] * 3;
        const spread = (finger - 1.5) * fan;
        this.posePositions[offset] += spread * frame.rx;
        this.posePositions[offset + 1] += spread * frame.ry;
        this.posePositions[offset + 2] += spread * frame.rz;
      }
    }
    this.demoHand.joints.set(this.posePositions);
    this.demoHand.radii.set(target.pose.radii);
    this.demoHand.valid = true;
    if (target.partner && !this.demoOneHand) {
      const partnerFrom = prior?.partner ?? this.demoFrom2;
      for (let axis = 0; axis < this.ghostPose2.mats.length; axis++) {
        this.ghostPose2.mats[axis] = partnerFrom.mats[axis] + (target.partner.mats[axis] - partnerFrom.mats[axis]) * morph;
      }
      this.ghostPose2.radii.set(target.partner.radii);
      this.poseToWorld(this.ghostPose2, this.posePositions2, 0, target.shifts[1]);
      for (let joint = 0; joint < JOINT_COUNT; joint++) {
        const offset = joint * 3;
        this.posePositions2[offset] += dx * frame.rx + flap * frame.ux + depth * frame.nx;
        this.posePositions2[offset + 1] += dx * frame.ry + flap * frame.uy + depth * frame.ny;
        this.posePositions2[offset + 2] += dx * frame.rz + flap * frame.uz + depth * frame.nz;
      }
      this.demoHand2.joints.set(this.posePositions2);
      this.demoHand2.radii.set(target.partner.radii);
      this.demoHand2.valid = true;
    } else this.demoHand2.valid = false;
    const light = this.lanternPos;
    projectFromLight(this.demoHand.joints, this.demoHand.radii, light.x, light.y, light.z, frame, this.demoHand.flat);
    if (this.demoHand2.valid) {
      projectFromLight(this.demoHand2.joints, this.demoHand2.radii, light.x, light.y, light.z, frame, this.demoHand2.flat);
    }
    let foot = Infinity;
    for (let side = 0; side < 2; side++) {
      const hand = side === 0 ? this.demoHand : this.demoHand2;
      if (!hand.valid || !hand.flat.valid) continue;
      for (let joint = 0; joint < JOINT_COUNT; joint++) foot = Math.min(foot, hand.flat.y[joint] - hand.flat.r[joint]);
    }
    if (Number.isFinite(foot)) {
      const lift = (-0.18 - foot) / ratio;
      for (let side = 0; side < 2; side++) {
        const hand = side === 0 ? this.demoHand : this.demoHand2;
        if (!hand.valid) continue;
        for (let joint = 0; joint < JOINT_COUNT; joint++) {
          const offset = joint * 3;
          hand.joints[offset] += lift * frame.ux;
          hand.joints[offset + 1] += lift * frame.uy;
          hand.joints[offset + 2] += lift * frame.uz;
        }
      }
    }
    const gesture = this.demoJourneyGesture;
    gesture.bark = gesture.peck = gesture.snip = gesture.hop = gesture.fan = gesture.fly = false;
    gesture.giant = gesture.tiny = false;
    if (obstacle && Math.abs(this.demoJourneyX - obstacle.x) <= 0.06 && motion >= 3.1 && motion < 4.1) {
      const pulse = motion < 3.85 ? 0 : 1;
      if (pulse !== this.demoJourneyPulse) {
        this.demoJourneyPulse = pulse;
        this.journeyView?.gesture(obstacle.ability, obstacle.x, this.animationTime);
        this.journeyGestureAt = this.animationTime;
        if (pulse === 1 || obstacle.kind === 'fog' || obstacle.ramp) gesture[obstacle.ability] = true;
      }
    }
  }

  private updateJourney(dt: number, useDemo: boolean): void {
    const journey = this.journey;
    if (!journey) return;
    const input = this.journeyInput;
    const form = useDemo ? this.demoJourneyForm : this.journeyFormState;
    const gesture = useDemo ? this.demoJourneyGesture : this.journeyGestureState;
    if (!form || !gesture) return;
    input.form = form;
    input.gesture = gesture;
    input.formId = form.form >= 0 ? this.baked[form.form].def.id : '';
    if (!form.stable && this.journeyPossession < 0.02) this.journeyShownForm = -1;
    if (form.form !== this.journeyShownForm && form.stable) {
      this.journeyShownForm = form.form;
      this.journeyNameAt = this.animationTime;
    }
    if (useDemo) {
      input.x = input.anchorX = this.demoJourneyX;
      input.y = -0.10;
      input.anchorY = -0.12 + this.demoJourneyHop;
    } else {
      const hand = this.journeyHands[0].valid ? this.journeyHands[0] : this.journeyHands[1];
      if (hand?.valid && hand.flat.valid) {
        let x = 0, y = 0;
        for (let joint = 0; joint < JOINT_COUNT; joint++) { x += hand.flat.x[joint]; y += hand.flat.y[joint]; }
        input.x = x / JOINT_COUNT;
        input.y = y / JOINT_COUNT;
        if (form.form >= 0 && this.baked[form.form].partner
          && this.journeyHands[0].valid && this.journeyHands[1].valid && this.journeyHands[1].flat.valid) {
          const partner = this.journeyHands[1].flat;
          let partnerX = 0, partnerY = 0;
          for (let joint = 0; joint < JOINT_COUNT; joint++) {
            partnerX += partner.x[joint];
            partnerY += partner.y[joint];
          }
          input.x = (input.x + partnerX / JOINT_COUNT) * 0.5;
          input.y = (input.y + partnerY / JOINT_COUNT) * 0.5;
        }
        input.anchorX = input.x;
        input.anchorY = input.y;
        if (input.formId === 'dog') {
          let snout: number = DOG_SNOUT_JOINTS[0];
          for (let index = 1; index < DOG_SNOUT_JOINTS.length; index++) {
            const joint = DOG_SNOUT_JOINTS[index];
            if (hand.flat.x[joint] > hand.flat.x[snout]) snout = joint;
          }
          input.anchorX = hand.flat.x[snout];
          input.anchorY = hand.flat.y[snout];
        } else if (input.formId === 'rabbit') {
          input.anchorX = (hand.flat.x[9] + hand.flat.x[14]) * 0.5;
          input.anchorY = (hand.flat.y[9] + hand.flat.y[14]) * 0.5;
        }
      } else input.x = input.y = input.anchorX = input.anchorY = 9;
    }
    const activeGesture = journey.current;
    if (!useDemo && activeGesture && Math.abs(input.x - activeGesture.x) <= 0.12
      && this.animationTime - this.journeyGestureAt >= 0.3) {
      const ability = activeGesture.kind === 'vine' && gesture.snip ? 'snip' : activeGesture.ability;
      if (gesture[ability]) {
        this.journeyView?.gesture(ability, activeGesture.x, this.animationTime);
        this.journeyGestureAt = this.animationTime;
      }
    }
    journey.update(dt, input);
    if (journey.index !== this.journeyLastObstacleIndex) {
      this.journeyGestures?.reset();
      this.journeyLastObstacleIndex = journey.index;
    }
    this.journeyView?.update(journey, this.animationTime);
    const event = journey.event;
    if (event?.kind === 'solve' && event.obstacle) {
      this.audio.journey(event.obstacle);
      if (event.ability) {
        const counts = this.saved.abilityUses ?? (this.saved.abilityUses = {});
        counts[event.ability] = (counts[event.ability] ?? 0) + 1;
      }
      save(this.saved);
    } else if (event?.kind === 'pickup' || event?.kind === 'arrival') {
      this.audio.journey(event.kind);
      if (event.kind === 'arrival') {
        this.journeyArrivedAt = this.animationTime;
        this.audio.chime(this.step + 2);
        this.saved.journeysCompleted = (this.saved.journeysCompleted ?? 0) + 1;
        save(this.saved);
      }
    }
    const active = journey.current;
    let giantNearby = active?.kind === 'boulder';
    if (!giantNearby) for (const obstacle of journey.plan.obstacles) {
      if (obstacle.kind === 'boulder' && Math.abs(obstacle.x - input.x) < 0.15) {
        giantNearby = true;
        break;
      }
    }
    this.journeyBlurryFor = !useDemo && gesture.scale > 1.3 && !giantNearby
      ? this.journeyBlurryFor + dt : 0;
    if (this.journeyBlurryFor >= 3)
      this.painter.caption('Move your hand toward the paper for a crisper shadow.',
        ease((this.journeyBlurryFor - 3) / 0.6), 0.24);
    if (active && journey.hint && !useDemo) {
      const hintTarget = this.baked[this.journeyFormFor(active.kind, active.ability)];
      const frame = this.frame;
      const cycle = journey.wait - 12;
      const gestureWave = Math.sin(cycle * 11);
      const jump = active.kind === 'gap' || active.ramp ? 0.035 * Math.max(0, gestureWave)
        : active.kind === 'ledge' ? 0.025 * gestureWave : 0;
      const depth = active.kind === 'boulder' ? 0.10 * (0.5 + 0.5 * gestureWave)
        : active.kind === 'crack' ? -0.12 * (0.5 + 0.5 * gestureWave) : 0;
      const dx = (active.x - 0.045) / (STAGE.lightToScreen / STAGE.lightToHand);
      this.poseToWorld(hintTarget.pose, this.posePositions, 0, hintTarget.shifts[0]);
      for (let joint = 0; joint < JOINT_COUNT; joint++) {
        const offset = joint * 3;
        this.posePositions[offset] += dx * frame.rx + jump * frame.ux + depth * frame.nx;
        this.posePositions[offset + 1] += dx * frame.ry + jump * frame.uy + depth * frame.ny;
        this.posePositions[offset + 2] += dx * frame.rz + jump * frame.uz + depth * frame.nz;
      }
      if (active.kind === 'crow' || active.kind === 'vine') {
        const close = (1 - Math.cos(cycle * 11)) * 0.35;
        for (let axis = 0; axis < 3; axis++) {
          this.posePositions[4 * 3 + axis] += (this.posePositions[9 * 3 + axis] - this.posePositions[4 * 3 + axis]) * close;
        }
      }
      if (active.kind === 'fog') {
        for (let finger = 0; finger < FAN_TIP_JOINTS.length; finger++) {
          const offset = FAN_TIP_JOINTS[finger] * 3;
          const spread = (finger - 1.5) * gestureWave * 0.014;
          this.posePositions[offset] += spread * frame.rx;
          this.posePositions[offset + 1] += spread * frame.ry;
          this.posePositions[offset + 2] += spread * frame.rz;
        }
      }
      this.ghost.update(this.posePositions, hintTarget.pose.radii);
      this.ghost.opacity = 0.28 + 0.08 * Math.sin(this.animationTime * 6);
      if (hintTarget.partner && !this.saved.oneHand) {
        this.poseToWorld(hintTarget.partner, this.posePositions2, 0, hintTarget.shifts[1]);
        for (let joint = 0; joint < JOINT_COUNT; joint++) {
          const offset = joint * 3;
          this.posePositions2[offset] += dx * frame.rx + jump * frame.ux;
          this.posePositions2[offset + 1] += dx * frame.ry + jump * frame.uy;
          this.posePositions2[offset + 2] += dx * frame.rz + jump * frame.uz;
        }
        if (active.kind === 'vine') {
          const close = (1 - Math.cos(cycle * 11)) * 0.35;
          for (let axis = 0; axis < 3; axis++) {
            this.posePositions2[4 * 3 + axis] += (this.posePositions2[9 * 3 + axis] - this.posePositions2[4 * 3 + axis]) * close;
          }
        }
        this.ghost2.update(this.posePositions2, hintTarget.partner.radii);
        this.ghost2.opacity = this.ghost.opacity;
      } else this.ghost2.opacity = 0;
    } else this.ghost.opacity = this.ghost2.opacity = 0;
    if (journey.completed) {
      this.painter.caption('The spark slips home into the quiet moon.', 1);
      if (this.animationTime - this.journeyArrivedAt >= 2) this.enter(Phase.Finale);
    } else if (!journey.carried && this.phaseTime < 3) {
      this.painter.caption('Hold a shape you know. Carry the light.', 1);
    } else if (active) this.painter.caption(journey.wait >= 25 ? 'Hold any form here to open the way.'
      : active.kind === 'crow' ? 'Bark the crow away.' : active.kind === 'vine' ? 'Peck or snip the vines.'
      : active.kind === 'gap' ? 'Hop across with the spark.' : active.kind === 'fog' ? 'Fan the mist twice.'
      : active.kind === 'ledge' ? active.ramp ? 'Hop twice up the ramp.' : 'Fly the spark up.'
      : active.kind === 'boulder' ? 'Grow giant near the flame.' : 'Shrink tiny near the paper.', 0.9);
    else this.painter.caption('Carry the spark to the moon.', 0.9);
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
    this.twoHandsSeen = false;
    this.bothHandsTime = 0;
    this.clearOneHandThisSession = this.saved.oneHand === true;
    if (this.playSandbox) {
      this.playFolk?.reset();
      this.playFolk?.configure({ waveCount: 5 });
      this.playDemoAt = 0;
      this.playDemoAct = -1;
      this.playDemoSpawned = 0;
    }
    if (this.crossing && (this.phase === Phase.Prologue || this.phase === Phase.Crossing))
      this.beginCrossing(this.crossing.night);
    if (this.saved.oneHand) this.suppressTwoHandTargets();
    const session = this.renderer.xr.getSession?.();
    if (session && !this.playSandbox && typeof Worker !== 'undefined') {
      try {
        this.asyncMatcher = new AsyncMatcher(this.baked.map((target) => target.template), this.allHands);
      } catch {
        this.asyncMatcher = null;
      }
    }
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
    this.asyncMatcher?.dispose();
    this.asyncMatcher = null;
    this.rigAnchor.endSession();
    this.restore = 'idle';
    this.anchored = false;
    this.twoHandsSeen = false;
    this.bothHandsTime = 0;
    this.clearOneHandThisSession = false;
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
      const box = new Box3().setFromObject(o);
      const size = box.getSize(new Vector3());
      if (size.x * size.y * size.z > 50) continue;
      out.push({ label, object: o, box, orientation: label === 'table' ? 'horizontal' : 'unknown' });
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
      if (this.inventPending) return;
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
    this.inventPending = true;
    const serial = ++this.inventSerial;
    this.audio.setHold(0);
    const finish = (stencil: Stencil) => {
      if (serial !== this.inventSerial || this.phase !== Phase.Invent) return;
      this.inventStencils.set(id, stencil);
      this.rebuildSummonMatcher();
      this.inventId = id;
      this.inventName = name;
      this.inventBorn = true;
      this.inventPending = false;
      this.inventBornAt = this.phaseTime;
      this.leapt = false;
      this.audio.chime(this.step + 2);
      this.audio.voice('fan');
    };
    if (this.immersive && this.renderer.xr.getSession?.() && typeof Worker !== 'undefined') {
      try {
        const worker = new Worker(new URL('./stencil-bake.worker.ts', import.meta.url), { type: 'module' });
        this.inventWorker = worker;
        const fallback = () => {
          worker.terminate();
          if (this.inventWorker === worker) this.inventWorker = null;
          if (serial === this.inventSerial) finish(this.inventedStencil(v));
        };
        worker.onmessage = ({ data }: MessageEvent<StencilPixels>) => {
          worker.terminate();
          if (this.inventWorker === worker) this.inventWorker = null;
          if (serial !== this.inventSerial) return;
          try { finish(makeStencilFromPixels(data)); } catch { finish(this.inventedStencil(v)); }
        };
        worker.onerror = fallback;
        worker.postMessage({ hands: v.hands, eyes: [v.eye] });
        return;
      } catch {
        this.inventWorker?.terminate();
        this.inventWorker = null;
      }
    }
    finish(this.inventedStencil(v));
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
    const waitingForPartner = this.demoOneHand && !!target.partner;
    const seekTime = this.demoOneHand && this.reform ? this.reform.elapsed : this.phaseTime;
    const k = waitingForPartner ? 0 : seeking ? ease((seekTime - 1.0 - this.demoDelay) / 2.2) : 1;
    // While the lantern waits as an ember, the demo hand first rises into its light from below.
    const rise = this.awaitingLight ? -0.32 * (1 - ease((this.phaseTime - 0.6) / 1.6)) : 0;
    // After a wake the demo hand lingers, sways (the creature follows it), then lowers as it walks off.
    const dropFrom = this.phase === Phase.Invent ? this.phaseTime - this.inventBornAt
      : this.phase === Phase.Wake ? this.phaseTime - this.wakeWalkAt() : this.phaseTime;
    const lift = (seeking ? rise : -ease(dropFrom / 0.8) * 0.25) + 0.012 * Math.sin(t * 1.3);
    const live = this.phase !== Phase.Finale;
    let shift = target.shifts[0];
    if (this.demoOneHand && this.reform) {
      const previous = this.baked[this.reform.old].shifts[0];
      for (let axis = 0; axis < 3; axis++) this.demoShift[axis] = previous[axis] + (shift[axis] - previous[axis]) * k;
      shift = this.demoShift;
    }
    this.blendDemo(this.demoHand, this.ghostPose, this.demoFrom, waitingForPartner ? this.demoFrom : target.pose,
      k, lift, shift, this.posePositions, t, this.demoDelay > 0 || waitingForPartner || (this.demoOneHand && !!this.reform));
    if (this.phase === Phase.Wake && this.lessonAbility && this.lessonResolvedAt < 0)
      this.lessonMotion(this.demoHand.joints, this.lessonAbility, this.phaseTime);
    this.demoHand.valid = live;
    if (target.partner && !this.demoOneHand) {
      this.blendDemo(this.demoHand2, this.ghostPose2, this.demoFrom2, target.partner, k, lift,
        target.shifts[1], this.posePositions2, t, this.demoDelay > 0);
      if (this.phase === Phase.Wake && this.lessonAbility && this.lessonResolvedAt < 0)
        this.lessonMotion(this.demoHand2.joints, this.lessonAbility, this.phaseTime);
      this.demoHand2.valid = live;
    } else {
      this.demoHand2.valid = false;
    }
  }

  private blendDemo(
    hand: LiveHand, tmp: HandPose, from: HandPose, to: HandPose, k: number, lift: number,
    shift: readonly number[], pos: Float32Array, t: number, wander: boolean,
  ): void {
    // Interpolate joint positions only; the poses' own matrices stay untouched.
    for (let i = 0; i < from.mats.length; i++) tmp.mats[i] = from.mats[i] + (to.mats[i] - from.mats[i]) * k;
    tmp.radii.set(to.radii);
    this.poseToWorld(tmp, pos, lift, shift);
    // A touch of drift so the shadow breathes like a real hand.
    for (let j = 0; j < JOINT_COUNT; j++) pos[j * 3] += 0.006 * Math.sin(t * 0.9);
    if (wander && !this.demoDepth && this.phase === Phase.Seek) {
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
    if (this.phase === Phase.Wake && this.phaseTime < this.wakeWalkAt()) {
      // Sway sideways so the just-woken creature visibly follows the hand.
      const sw = 0.035 * Math.sin(this.phaseTime * 4.5), f = this.frame;
      for (let j = 0; j < JOINT_COUNT; j++) { pos[j * 3] += sw * f.rx; pos[j * 3 + 1] += sw * f.ry; pos[j * 3 + 2] += sw * f.rz; }
    }
    hand.joints.set(pos);
    hand.radii.set(to.radii);
  }

  private wakeWalkAt(): number { return this.lessonResolvedAt < 0 ? Infinity : this.lessonResolvedAt + 0.35; }

  private lessonMotion(joints: Float32Array, ability: Ability, time: number): void {
    const elapsed = time - 1.3;
    if (elapsed < 0 || elapsed > 1.6) return;
    const cycle = (elapsed * 1.65) % 1;
    const amount = Math.sin(cycle * Math.PI) ** 2;
    const frame = this.frame;
    if (ability === 'bark' || ability === 'peck' || ability === 'snip') {
      const tip = ability === 'bark' ? 4 : 9;
      const toward = ability === 'bark' ? 9 : 4;
      for (let axis = 0; axis < 3; axis++) joints[tip * 3 + axis] +=
        (joints[toward * 3 + axis] - joints[tip * 3 + axis]) * amount * 0.9;
      if (ability === 'bark') for (let axis = 0; axis < 3; axis++) joints[14 * 3 + axis] +=
        (joints[4 * 3 + axis] - joints[14 * 3 + axis]) * amount * 0.4;
    } else if (ability === 'fan') {
      for (const joint of FAN_TIP_JOINTS) {
        const index = FAN_TIP_JOINTS.indexOf(joint);
        const offset = (index - 1.5) * amount * 0.016;
        joints[joint * 3] += offset * frame.rx;
        joints[joint * 3 + 1] += offset * frame.ry;
        joints[joint * 3 + 2] += offset * frame.rz;
      }
    } else {
      const displacement = ability === 'hop' || ability === 'fly' ? 0.07 * Math.sin(elapsed * Math.PI * 3.3)
        : ability === 'giant' ? 0.12 * amount : -0.12 * amount;
      for (let joint = 0; joint < JOINT_COUNT; joint++) {
        const offset = joint * 3;
        if (ability === 'hop' || ability === 'fly') joints[offset + 1] += displacement;
        else {
          joints[offset] += displacement * frame.nx;
          joints[offset + 1] += displacement * frame.ny;
          joints[offset + 2] += displacement * frame.nz;
        }
      }
    }
  }

  private drivePlayDemo(dt: number): void {
    if (!this.playFolk) return;
    if (this.playDemoAt === 0) this.playDemoAt = this.animationTime;
    const elapsed = this.animationTime - this.playDemoAt;
    const act = elapsed < 12 ? 0 : elapsed < 18 ? 1 : 2;
    if (act !== this.playDemoAct) {
      this.playDemoAct = act;
      this.playDemoSpawned = 0;
      this.playFolk.reset();
      this.playFolk.configure({ waveCount: act === 0 ? 5 : 0 });
      if (act === 2) this.playFolk.spawn(0.235, -0.183);
    }
    const sceneTime = act === 0 ? elapsed : act === 1 ? elapsed - 12 : elapsed - 18;
    if (act === 1) {
      while (this.playDemoSpawned < 5 && sceneTime >= this.playDemoSpawned * 0.7) {
        this.playFolk.spawn(-0.025, 0.08);
        this.playDemoSpawned++;
      }
    }
    const pose = act === 1 ? this.playDemoCup : this.playDemoPose;
    const x = act === 1 ? -0.025 : act === 2 ? 0.23 + Math.max(0, Math.min(0.05, (sceneTime - 1) * 0.5)) : 0;
    const y = act === 1 ? -0.23 : act === 2 ? -0.23 + Math.max(0, Math.min(0.12, (sceneTime - 1) * 1.2)) : -0.23;
    this.demoHand.radii.set(pose.radii);
    const light = this.lanternPos, frame = this.frame;
    let meanX = 0, meanY = 0;
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      meanX += pose.mats[joint * 16 + 12]; meanY += pose.mats[joint * 16 + 13];
    }
    meanX /= JOINT_COUNT; meanY /= JOINT_COUNT;
    const lightX = (light.x - frame.ox) * frame.rx + (light.y - frame.oy) * frame.ry + (light.z - frame.oz) * frame.rz;
    const lightY = (light.x - frame.ox) * frame.ux + (light.y - frame.oy) * frame.uy + (light.z - frame.oz) * frame.uz;
    const magnification = STAGE.lightToScreen / STAGE.lightToHand;
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      const offset = joint * 3;
      const screenX = x + (pose.mats[joint * 16 + 12] - meanX) * magnification;
      const screenY = y + (pose.mats[joint * 16 + 13] - meanY) * magnification;
      const handX = (screenX - lightX) / magnification;
      const handY = (screenY - lightY) / magnification;
      this.demoHand.joints[offset] = light.x + handX * frame.rx + handY * frame.ux - STAGE.lightToHand * frame.nx;
      this.demoHand.joints[offset + 1] = light.y + handX * frame.ry + handY * frame.uy - STAGE.lightToHand * frame.ny;
      this.demoHand.joints[offset + 2] = light.z + handX * frame.rz + handY * frame.uz - STAGE.lightToHand * frame.nz;
    }
    this.demoHand.valid = true;
    this.demoHand2.valid = false;
  }

  /** Joints for drawing the stand-in hand: a flattened demo hand regains its depth along each light ray. */
  private standInJoints(hand: LiveHand, slot: number): Float32Array {
    if (!hand.reliefOn) return hand.joints;
    const out = this.reliefJoints[slot], light = this.lanternPos, frame = this.frame;
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      const offset = joint * 3;
      const dx = hand.joints[offset] - light.x, dy = hand.joints[offset + 1] - light.y, dz = hand.joints[offset + 2] - light.z;
      const depth = -(dx * frame.nx + dy * frame.ny + dz * frame.nz);
      const k = depth > 1e-3 ? Math.max(0.5, (depth + hand.relief[joint]) / depth) : 1;
      out[offset] = light.x + dx * k; out[offset + 1] = light.y + dy * k; out[offset + 2] = light.z + dz * k;
    }
    return out;
  }

  private setProjectedPlayHand(hand: LiveHand, pose: HandPose, x: number, y: number, scale = 1): void {
    const light = this.lanternPos, frame = this.frame;
    const magnification = STAGE.lightToScreen / STAGE.lightToHand;
    const depth = STAGE.lightToHand / scale;
    let meanX = 0, meanY = 0, meanZ = 0;
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      meanX += pose.mats[joint * 16 + 12]; meanY += pose.mats[joint * 16 + 13]; meanZ += pose.mats[joint * 16 + 14];
    }
    meanX /= JOINT_COUNT; meanY /= JOINT_COUNT; meanZ /= JOINT_COUNT;
    for (let joint = 0; joint < JOINT_COUNT; joint++) hand.relief[joint] = pose.mats[joint * 16 + 14] - meanZ;
    hand.reliefOn = true;
    const lightX = (light.x - frame.ox) * frame.rx + (light.y - frame.oy) * frame.ry + (light.z - frame.oz) * frame.rz;
    const lightY = (light.x - frame.ox) * frame.ux + (light.y - frame.oy) * frame.uy + (light.z - frame.oz) * frame.uz;
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      const offset = joint * 3;
      const screenX = x + (pose.mats[joint * 16 + 12] - meanX) * magnification * scale;
      const screenY = y + (pose.mats[joint * 16 + 13] - meanY) * magnification * scale;
      const handX = (screenX - lightX) / (magnification * scale);
      const handY = (screenY - lightY) / (magnification * scale);
      hand.joints[offset] = light.x + handX * frame.rx + handY * frame.ux - depth * frame.nx;
      hand.joints[offset + 1] = light.y + handX * frame.ry + handY * frame.uy - depth * frame.ny;
      hand.joints[offset + 2] = light.z + handX * frame.rz + handY * frame.uz - depth * frame.nz;
    }
    hand.radii.set(pose.radii);
    hand.valid = true;
  }

  private driveCrossingDemo(): void {
    const crossing = this.crossing;
    if (!crossing || crossing.finished) { this.demoHand.valid = this.demoHand2.valid = false; return; }
    if (crossing.screen !== this.crossingDemoScreen) {
      this.crossingDemoScreen = crossing.screen;
      this.crossingDemoAt = this.animationTime;
      this.crossingDemoFromX = this.crossingDemoX;
      this.crossingDemoFromY = this.crossingDemoY;
      this.crossingDemoFlicked[0].fill(0);
      this.crossingDemoFlicked[1].fill(0);
      this.crossingDemoFlickAt[0] = this.crossingDemoFlickAt[1] = -Infinity;
      this.crossingDemoFlickSlot[0] = this.crossingDemoFlickSlot[1] = -1;
      this.crossingDemoCrowAt[0] = this.crossingDemoCrowAt[1] = -Infinity;
      const hazards = crossing.level.hazards;
      const preferred = arcNight(crossing.night, this.arcSeed()).wakes;
      const fit = (kind: string): boolean => hazards.some((hazard) => {
        if (hazard.kind === 'gap') return kind === 'rabbit' || kind === 'snail' || kind === 'peacock';
        if (hazard.kind === 'river') return kind === 'duck' || kind === 'fish' || kind === 'rabbit';
        if (hazard.kind === 'crow') return kind === 'dog' || kind === 'crab';
        if (hazard.kind === 'rain') return kind === 'elephant';
        if (hazard.kind === 'thorns') return kind === 'crab' || kind === 'heron' || kind === 'rabbit';
        if (hazard.kind === 'gust') return kind === 'peacock' || kind === 'stag';
        if (hazard.kind === 'boulder') return kind === 'stag';
        return kind === 'butterfly' || kind === 'heron' || kind === 'snail';
      });
      this.summonDemoKind = [this.summonRequested, ...preferred, ...this.firstWoken(), ...TARGETS.map((entry) => entry.id)]
        .find(fit) as SummonKind | undefined ?? null;
      const hazard = hazards.find((entry) => entry.kind === 'gap' || entry.kind === 'river'
        || entry.kind === 'crow' || entry.kind === 'rain' || entry.kind === 'thorns'
        || entry.kind === 'gust' || entry.kind === 'boulder' || entry.kind === 'ledge' || entry.kind === 'highLedge');
      this.summonDemoX = (hazard?.x ?? -0.17) - 0.10;
    }
    const hazards = crossing.level.hazards;
    const first = hazards[0];
    const second = hazards[1];
    const elapsed = this.animationTime - this.crossingDemoAt;
    const chargeAt = this.summonFilm ? 3.25 : 0.55;
    const fireAt = this.summonFilm ? 4.20 : 1.5;
    if (this.summonFilm && this.summonDemoKind && elapsed < chargeAt) {
      this.demoHand.valid = this.demoHand2.valid = false;
      crossing.summons.setCharge(null, 0, 0, 0);
      return;
    }
    if (this.phase === Phase.Crossing && elapsed >= fireAt && this.summonDemoScreen !== crossing.screen
      && this.summonDemoKind) {
      if (crossing.summons.spawn(this.summonDemoKind, this.summonDemoX, -0.18))
        this.summonDemoScreen = crossing.screen;
    }
    if (this.phase === Phase.Crossing && this.summonDemoKind && elapsed >= chargeAt && elapsed < fireAt) {
      const index = JOURNEY_TARGET_INDEX[this.summonDemoKind];
      const summonTarget = this.baked[index];
      if (summonTarget) {
        this.setProjectedPlayHand(this.demoHand, summonTarget.pose, this.summonDemoX, -0.055);
        if (summonTarget.partner) this.setProjectedPlayHand(this.demoHand2, summonTarget.partner, this.summonDemoX + 0.12, -0.055);
        else this.demoHand2.valid = false;
        crossing.summons.setCharge(this.summonDemoKind, this.summonDemoX, -0.055,
          Math.max(0, Math.min(1, (elapsed - chargeAt) / 0.8)));
        return;
      }
    }
    crossing.summons.setCharge(null, 0, 0, 0);
    const targetX = first?.x ?? -0.17;
    const targetY = first?.kind === 'rain' ? -0.055 : first?.kind === 'crow' ? 0.04
      : first?.kind === 'ledge' || first?.kind === 'highLedge' || first?.kind === 'thorns' ? -0.15 : -0.23;
    const travel = ease(elapsed / 1.4);
    const x = this.crossingDemoFromX + (targetX - this.crossingDemoFromX) * travel;
    const y = this.crossingDemoFromY + (targetY - this.crossingDemoFromY) * travel;
    this.crossingDemoX = x;
    this.crossingDemoY = y;
    const specialFirst = first && (this.driveCrossingFlick(first, this.demoHand, 0)
      || this.driveCrossingCrow(first, this.demoHand, 0) || this.driveCrossingBoulder(first, this.demoHand));
    if (!specialFirst) {
      if (crossing.night === 0 && elapsed < 0.8) this.demoHand.valid = false;
      else this.setProjectedPlayHand(this.demoHand, this.playDemoPose,
        x,
        first?.kind === 'ledge' || first?.kind === 'highLedge' ? y + 0.055 * Math.max(0, Math.sin(elapsed * 2.4)) : y,
        first?.kind === 'rain' ? 1.45 : 1);
    }
    const specialSecond = second && (this.driveCrossingFlick(second, this.demoHand2, 1)
      || this.driveCrossingCrow(second, this.demoHand2, 1) || this.driveCrossingBoulder(second, this.demoHand2));
    if (!specialSecond) {
      if (second) this.setProjectedPlayHand(this.demoHand2, this.playDemoPose, second.x,
        second.kind === 'rain' ? -0.055 : second.kind === 'crow' ? 0.04 : -0.23,
        second.kind === 'rain' ? 1.45 : 1);
      else this.demoHand2.valid = false;
    }
  }

  private updateSummonTrigger(dt: number, anyReal: boolean, useDemo: boolean): void {
    const crossing = this.crossing;
    const forms = this.summonForms;
    if (!crossing || !forms || useDemo || !anyReal
      || this.phase !== Phase.Crossing && this.phase !== Phase.Lesson || crossing.wiping) {
      this.summonTrigger.reset();
      crossing?.summons.setCharge(null, 0, 0, 0);
      return;
    }
    this.journeyHands[0] = this.hands[0];
    this.journeyHands[1] = this.hands[1];
    const candidates = this.summonCandidates;
    candidates.length = 0;
    if (this.animationTime - this.summonProbeAt >= 1.5) {
      this.summonProbeAt = this.animationTime;
      this.summonProbe++;
    }
    const known = this.summonKnown;
    const current = this.summonTrigger.form;
    if (current >= 0) candidates.push(current);
    if (this.summonRequested) {
      const index = JOURNEY_TARGET_INDEX[this.summonRequested];
      if (Number.isInteger(index) && !candidates.includes(index)) candidates.push(index);
    }
    for (let offset = 0; offset < known.length && candidates.length < 4; offset++) {
      const index = known[(offset + this.summonProbe) % known.length];
      if (Number.isInteger(index) && !candidates.includes(index)) candidates.push(index);
    }
    const match = forms.update(dt, this.journeyHands, candidates);
    const index = match.form;
    const invented = index >= TARGETS.length ? this.saved.invented?.[index - TARGETS.length] : null;
    const kind: SummonKind | null = invented ? 'invented'
      : index >= 0 ? TARGETS[index]?.id as SummonKind : null;
    const id = invented?.id ?? kind;
    const name = invented?.name ?? kind;
    const art = invented ? this.inventStencils.get(invented.id) : undefined;
    const hand = this.hands[0].valid ? this.hands[0] : this.hands[1];
    const x = hand.flat.x[0];
    const y = hand.flat.y[0];
    const canFire = !!kind && crossing.summons.activeCount() < 2
      && crossing.summons.cooldownRemaining(id!) === 0 && hand.flat.valid;
    if (this.summonTrigger.update(dt, match, canFire) && kind
      && crossing.summons.spawn(kind, x, y, name!, id!, art)) crossing.summons.autoFireCount++;
    crossing.summons.setCharge(kind, x, y, canFire ? this.summonTrigger.progress : 0, art);
  }

  private driveCrossingCrow(hazard: LevelHazard, hand: LiveHand, side: number): boolean {
    if (hazard.kind !== 'crow') return false;
    if (this.crossing?.hazards.crowPose(hazard.slot, this.crossingDemoCrowPose)) {
      if (!Number.isFinite(this.crossingDemoCrowAt[side])) this.crossingDemoCrowAt[side] = this.animationTime;
      const sweep = Math.max(0, Math.min(1, (this.animationTime - this.crossingDemoCrowAt[side]) / 0.18));
      this.setProjectedPlayHand(hand, this.playDemoPose,
        this.crossingDemoCrowPose[0] - 0.10 + 0.22 * sweep, this.crossingDemoCrowPose[1], 1.65);
    } else {
      this.crossingDemoCrowAt[side] = -Infinity;
      hand.valid = false;
    }
    return true;
  }

  private driveCrossingBoulder(hazard: LevelHazard, hand: LiveHand): boolean {
    if (hazard.kind !== 'boulder') return false;
    if (this.crossing?.hazards.boulderPose(hazard.slot, this.crossingDemoBoulderPose)) {
      this.setProjectedPlayHand(hand, this.playDemoPose,
        Math.min(0.40, this.crossingDemoBoulderPose[0] - 0.10), -0.16, 1);
    } else hand.valid = false;
    return true;
  }

  private driveCrossingFlick(hazard: LevelHazard, hand: LiveHand, side: number): boolean {
    if (hazard.kind !== 'ledge' && hazard.kind !== 'highLedge' && hazard.kind !== 'thorns') return false;
    if (this.crossingDemoFlickSlot[side] < 0) {
      const left = hazard.x - hazard.width * 0.5;
      for (let index = 0; index < (this.playFolk?.count ?? 0); index++) {
        const agent = this.playFolk!.agents[index];
        if (this.crossingDemoFlicked[side][index] || agent.state !== 'walking' || agent.heading < 0) continue;
        if (agent.x < left - 0.10 || agent.x > left + 0.02) continue;
        this.crossingDemoFlicked[side][index] = 1;
        this.crossingDemoFlickSlot[side] = index;
        this.crossingDemoFlickAt[side] = this.animationTime;
        break;
      }
    }
    if (this.crossingDemoFlickSlot[side] >= 0) {
      const since = this.animationTime - this.crossingDemoFlickAt[side];
      const high = hazard.kind === 'highLedge';
      if (since < (high ? 0.36 : 0.28)) {
        const progress = Math.min(1, since / (high ? 0.16 : 0.08));
        this.setProjectedPlayHand(hand, this.playDemoPose,
          hazard.x - hazard.width * 0.5 - 0.08 + (high ? 0.14 : 0.10) * progress,
          -0.20 + (high ? 0.16 : 0.12) * progress, 2.5);
        return true;
      }
      this.crossingDemoFlickSlot[side] = -1;
    }
    hand.valid = false;
    return true;
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
    this.moon.update(dt);
    if (this.placeAt < 0) this.placeAt = time + 0.5;
    if (this.visibleAt < 0) this.visibleAt = time;
    if (this.sessionAt < 0) this.sessionAt = this.animationTime;
    if (!this.placed && time >= this.placeAt) this.place(time);
    if (!this.placed) return;
    if (this.idle && !this.settle && this.fitUntil === 0) return;
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
    this.observeSessionHands(handMask, dt);
    const anyReal = handMask !== 0;
    if (anyReal) this.handsSeenAt = time;
    else if (this.handsSeenAt < 0) this.handsSeenAt = time;
    const useDemo = this.playSandbox ? this.demo : this.demo || (!this.immersive && !anyReal && !this.journeyOnly);
    if (this.immersive) this.handleCarry(time);
    this.phaseTime += dt;

    const target = this.baked[this.order[this.step % this.order.length] ?? 0];
    const stencil = this.stencils[this.order[this.step % this.order.length] ?? 0];
    const demoTarget = this.phase === Phase.Invent && this.inventTarget ? this.inventTarget : target;
    this.demoHand.reliefOn = this.demoHand2.reliefOn = false;
    if (useDemo) {
      if (this.playSandbox) this.drivePlayDemo(dt);
      else if (this.phase === Phase.Prologue || this.phase === Phase.Crossing) this.driveCrossingDemo();
      else if (this.phase === Phase.Lesson) {
        const lessonTarget = this.baked[this.lessonOrder[this.lessonIndex]];
        if (lessonTarget) {
          const lessonX = (this.crossing?.level.hazards[0]?.x ?? -0.17) - 0.10;
          this.setProjectedPlayHand(this.demoHand, lessonTarget.pose, lessonX, -0.055);
          if (lessonTarget.partner) this.setProjectedPlayHand(this.demoHand2, lessonTarget.partner, lessonX + 0.12, -0.055);
          else this.demoHand2.valid = false;
        } else this.demoHand.valid = this.demoHand2.valid = false;
      }
      else if (this.phase === Phase.Journey) this.driveJourneyDemo(dt);
      else this.driveDemo(demoTarget, this.animationTime);
    } else this.demoHand.valid = this.demoHand2.valid = false;
    // Filming in an emulator (`?capture` in XR): no passthrough shows the player's hands, so the wooden
    // stand-in follows the real tracked joints. On a headset, real hands are seen through passthrough.
    const shown = this.demoHand.valid ? this.demoHand : this.immersive && captureControl() && this.hands[0].valid ? this.hands[0] : null;
    const shown2 = this.demoHand2.valid ? this.demoHand2 : this.immersive && captureControl() && this.hands[1].valid ? this.hands[1] : null;
    this.puppeteer.opacity = shown ? 1 : 0;
    if (shown) this.puppeteer.update(this.standInJoints(shown, 0), shown.radii);
    this.puppeteer2.opacity = shown2 ? 1 : 0;
    if (shown2) this.puppeteer2.update(this.standInJoints(shown2, 1), shown2.radii);

    // Lantern: a dim ember until a hand reaches its light, then a warm flicker.
    this.lit += (this.litTarget - this.lit) * Math.min(1, dt * 3.5);
    const flick = 0.92 + 0.05 * Math.sin(this.animationTime * 7.3) + 0.03 * Math.sin(this.animationTime * 17.1);
    const glow = (0.3 + 0.7 * this.lit) * flick;
    this.lantern.bodyMat.color.setRGB(glow, 0.81 * glow, 0.54 * glow);
    const candle = this.crossing && (this.phase === Phase.Prologue || this.phase === Phase.Crossing)
      ? this.crossing.candle : 1;
    this.lantern.candle.scale.y = 0.35 + candle * 0.65;
    this.lantern.candle.position.y = -0.039 + 0.021 * this.lantern.candle.scale.y;
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
    this.glowLight.intensity = (0.12 + 0.95 * this.lit) * flick * (0.7 + 0.3 * candle);
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
    let playMs = 0;
    const playClearAt = this.playField && perf ? performance.now() : 0;
    const activePlay = this.playSandbox || this.phase === Phase.Prologue
      || this.phase === Phase.Crossing || this.phase === Phase.Lesson;
    if (activePlay) this.playField?.beginFrame();
    if (playClearAt) {
      const elapsed = performance.now() - playClearAt;
      playMs += elapsed;
      perf?.playClear.push(elapsed);
    }
    const needsMainMask = !this.playSandbox && ((this.phase === Phase.Seek && !this.asyncMatcher?.ready)
      || (this.phase === Phase.Wake && this.wakeC0 !== null && this.phaseTime < this.wakeWalkAt())
      || (this.phase === Phase.Invent && !this.inventBorn && !this.inventPending));
    if (needsMainMask) this.live.clear();
    let casters = 0;
    const L = this.lanternPos;
    this.rays?.begin();
    let playHandMask = 0;
    for (const h of this.allHands) {
      if (!h.valid) continue;
      projectFromLight(h.joints, h.radii, L.x, L.y, L.z, this.frame, h.flat);
      if (!h.flat.valid) continue;
      if (activePlay && this.playField && (useDemo ? h === this.demoHand || h === this.demoHand2 : h === this.hands[0] || h === this.hands[1])) {
        const side = h === this.hands[0] || h === this.demoHand ? 0 : 1;
        let depth = 0;
        for (let joint = 0; joint < JOINT_COUNT; joint++) {
          const offset = joint * 3;
          depth += (L.x - h.joints[offset]) * this.frame.nx + (L.y - h.joints[offset + 1]) * this.frame.ny
            + (L.z - h.joints[offset + 2]) * this.frame.nz;
        }
        const lightToScreen = (L.x - this.frame.ox) * this.frame.nx + (L.y - this.frame.oy) * this.frame.ny
          + (L.z - this.frame.oz) * this.frame.nz;
        const scale = lightToScreen / Math.max(0.03, depth / JOINT_COUNT) / (STAGE.lightToScreen / STAGE.lightToHand);
        const playInkAt = perf ? performance.now() : 0;
        this.playField.addHand(h.flat, scale, dt, side);
        if (playInkAt) {
          const elapsed = performance.now() - playInkAt;
          playMs += elapsed;
          perf?.playInk.push(elapsed);
        }
        playHandMask |= 1 << side;
      }
      if (needsMainMask) {
        const maskStarted = perf ? performance.now() : 0;
        drawHand(this.live, h.flat);
        perf?.recordMask(maskStarted);
      }
      this.rays?.add(h.joints, L, this.frame, this.phase === Phase.Seek ? 1 : 0.35);
      casters++;
    }
    if (activePlay && this.playField) {
      if (!(playHandMask & 1)) this.playField.clearHand(0);
      if (!(playHandMask & 2)) this.playField.clearHand(1);
    }
    if (this.journeyForms && this.journeyGestures && (this.phase === Phase.Journey || this.journeyDebug)) {
      this.journeyHands[0] = anyReal ? this.hands[0] : this.demoHand;
      this.journeyHands[1] = anyReal ? this.hands[1] : this.demoHand2;
      const candidates = this.journeyCandidates;
      const currentIndex = this.phase === Phase.Journey
        ? this.journeyFormFor(this.journey?.current?.kind, this.journey?.current?.ability) : this.order[this.step % this.order.length];
      candidates[0] = currentIndex;
      let count = 1;
      if (this.phase === Phase.Journey) {
        const active = this.journey?.current;
        if (active?.kind === 'vine') {
          for (const id of VINE_FORM_IDS) {
            const index = JOURNEY_TARGET_INDEX[id];
            if (index >= 0 && count < 4) candidates[count++] = index;
          }
        }
        const held = this.journeyFormState?.form ?? -1;
        let heldPresent = false;
        for (let prior = 0; prior < count; prior++) if (candidates[prior] === held) heldPresent = true;
        if (held >= 0 && !heldPresent && count < 4) candidates[count++] = held;
        for (let index = 0; index < this.journeyRecent.length && count < 4; index++) {
          const recent = this.journeyRecent[index];
          let present = false;
          for (let prior = 0; prior < count; prior++) if (candidates[prior] === recent) present = true;
          if (!present) candidates[count++] = recent;
        }
      }
      const probeOrder = this.phase === Phase.Journey ? this.journeyKnown : this.order;
      const probeLength = probeOrder.length;
      if (this.phase === Phase.Journey && this.animationTime - this.journeyProbeAt >= 2) {
        this.journeyProbe = (this.journeyProbe + 1) % Math.max(1, probeLength);
        this.journeyProbeAt = this.animationTime;
      }
      for (let index = 0; index < probeLength && count < 4; index++) {
        const candidate = probeOrder[(index + (this.phase === Phase.Journey ? this.journeyProbe : 0)) % probeLength];
        if (candidate < 0) continue;
        let found = false;
        for (let prior = 0; prior < count; prior++) if (candidates[prior] === candidate) found = true;
        if (!found) candidates[count++] = candidate;
      }
      candidates.length = count;
      this.journeyFormState = this.journeyForms.update(dt, this.journeyHands, candidates,
        this.phase === Phase.Journey ? currentIndex : -1);
      if (this.phase === Phase.Journey && this.journeyFormState.form !== this.journeyLastForm) {
        this.journeyGestures.reset();
        this.journeyLastForm = this.journeyFormState.form;
        if (this.journeyLastForm >= 0) {
          const position = this.journeyRecent.indexOf(this.journeyLastForm);
          if (position >= 0) this.journeyRecent.splice(position, 1);
          this.journeyRecent.unshift(this.journeyLastForm);
          this.journeyRecent.length = Math.min(this.journeyRecent.length, 3);
        }
      }
      this.journeyGestureState = this.journeyGestures.update(dt, this.journeyHands, L, this.frame);
      const gesture = this.journeyGestureState;
      if (gesture.bark) this.journeyLastEvent = 'bark';
      if (gesture.peck) this.journeyLastEvent = 'peck';
      if (gesture.snip) this.journeyLastEvent = 'snip';
      if (gesture.hop) this.journeyLastEvent = 'hop';
      if (gesture.fan) this.journeyLastEvent = 'fan';
      if (gesture.fly) this.journeyLastEvent = 'fly';
      if (this.journeyDebug && this.animationTime - this.journeyLineAt >= 0.15) {
        const form = this.journeyFormState;
        const name = form.form < 0 ? '—' : this.baked[form.form].def.creature;
        this.journeyLine = `${name} ${form.score.toFixed(2)} · ${gesture.scale.toFixed(2)}× · ${this.journeyLastEvent}`;
        this.journeyLineAt = this.animationTime;
      }
      if (this.journeyDebug) p.journeyDebug(this.journeyLine);
    }
    if (this.phase === Phase.Wake && this.journeyGestures && this.lessonResolvedAt < 0) {
      this.journeyHands[0] = anyReal ? this.hands[0] : this.demoHand;
      this.journeyHands[1] = anyReal ? this.hands[1] : this.demoHand2;
      this.journeyGestureState = this.journeyGestures.update(dt, this.journeyHands, L, this.frame);
    }
    this.rays?.end();
    if (this.awaitingLight && casters > 0 && this.shadowOnPaper()) {
      this.awaitingLight = false;
      this.litTarget = 1;
      this.audio.bloom();
    }

    if (this.playSandbox && this.playFolk && this.playField && this.playView) {
      const began = perf ? performance.now() : 0;
      this.litTarget = 1;
      if (this.demo || (!this.settle && this.fitUntil === 0)) this.playFolk.update(dt);
      if (perf) perf.playAgents.push(performance.now() - began);
      const viewAt = perf ? performance.now() : 0;
      this.playView.update(this.playFolk, this.playField, this.animationTime);
      if (perf) perf.playView.push(performance.now() - viewAt);
      perf?.play.push(playMs + performance.now() - began);
      p.caption(this.demo ? this.playDemoAct === 0 ? 'A bridge of shadow.'
        : this.playDemoAct === 1 ? 'A hand to catch them.' : 'A flick toward the moon.'
        : 'Guide the Kindlings with your living shadow.', 0.95, 0.26);
    } else if ((this.phase === Phase.Prologue || this.phase === Phase.Crossing) && this.crossing && this.playView && this.playField && this.playFolk) {
      const began = perf ? performance.now() : 0;
      this.updateSummonTrigger(dt, anyReal, useDemo);
      if (this.demo || !this.immersive || !this.settle && this.fitUntil === 0) this.crossing.update(dt);
      if (perf) perf.playAgents.push(performance.now() - began);
      const viewAt = perf ? performance.now() : 0;
      this.playView.update(this.playFolk, this.playField, this.animationTime);
      this.playView.setWash(this.crossing.wiping ? this.crossing.wash : 0);
      if (perf) perf.playView.push(performance.now() - viewAt);
      perf?.play.push(playMs + performance.now() - began);
      if (this.phase === Phase.Prologue) {
        if (this.phaseTime > 2 && !this.awaitingLight && this.crossing.home === 0
          && this.crossingCaption !== 'Yours is the last.') {
          this.crossingCaption = 'Yours is the last.';
          this.crossingCaptionAt = this.animationTime;
        }
        if (this.crossing.home === 0 && this.playFolk.count > 0) {
          this.poseToWorld(this.playDemoPose, this.posePositions, 0, [-0.17, -0.22, 0]);
          this.ghost.update(this.posePositions, this.playDemoPose.radii);
          this.ghost.opacity = 0.28 * ease(this.phaseTime / 0.6);
        } else this.ghost.opacity = 0;
      } else if (this.animationTime - this.crossingHintAt < 3) {
        this.poseToWorld(this.playDemoPose, this.posePositions, 0,
          [this.crossingHintX, this.crossingHintY, 0]);
        this.ghost.update(this.posePositions, this.playDemoPose.radii);
        this.ghost.opacity = 0.3 * Math.min(ease((this.animationTime - this.crossingHintAt) / 0.4),
          1 - ease((this.animationTime - this.crossingHintAt - 2.5) / 0.5));
      } else this.ghost.opacity = 0;
      if (this.animationTime - this.crossingCaptionAt < 4.5) p.caption(this.crossingCaption, 0.9, 0.25);
      if (this.crossing.finished) this.finishCrossing();
    } else switch (this.phase) {
      case Phase.Seek: this.seek(target, stencil, casters, dt, this.animationTime); break;
      case Phase.Wake: this.wake(target, stencil, this.animationTime); break;
      case Phase.Rest:
        if (this.phaseTime >= REST_TIME) this.enter(Phase.Seek);
        break;
      case Phase.Finale: this.finale(this.animationTime); break;
      case Phase.Invent: this.invent(dt, this.animationTime, casters); break;
      case Phase.Journey: this.updateJourney(dt, useDemo); break;
      case Phase.Lesson: {
        const lessonTarget = this.baked[this.lessonOrder[this.lessonIndex]];
        if (lessonTarget) {
          const kind = lessonTarget.def.id as SummonKind;
          const lesson = this.crossing;
          this.updateSummonTrigger(dt, anyReal, useDemo);
          if (lesson && (this.demo || !this.immersive || !this.settle && this.fitUntil === 0)) {
            if (useDemo && !this.lessonSummonFired && this.phaseTime >= 1.5)
              lesson.summons.spawn(kind, (lesson.level.hazards[0]?.x ?? -0.17) - 0.10, -0.18);
            lesson.update(dt);
            this.playView?.update(this.playFolk!, this.playField!, this.animationTime);
          }
          p.caption(SUMMON_COPY[kind] ?? 'Make this friend. Hold until it glows.', 1, 0.2);
          this.poseToWorld(lessonTarget.pose, this.posePositions, 0, lessonTarget.shifts[0]);
          this.ghost.update(this.posePositions, lessonTarget.pose.radii);
          this.ghost.opacity = 0.28 * Math.min(ease(this.phaseTime / 0.4), 1 - ease((this.phaseTime - 5.6) / 0.5));
        }
        if (this.phaseTime >= (this.lessonSummonFired ? 6 : 10)) { this.lessonIndex++; this.beginKnownLessons(); }
        break;
      }
      case Phase.Home:
        p.caption(`${this.crossing?.home ?? 0} Kindlings came home.`, 1, 0.2);
        if (this.phaseTime >= 8) this.enter(Phase.Finale);
        break;
    }

    if (this.phase === Phase.Journey) {
      const stable = this.journeyInput.form.stable && this.journeyInput.form.form >= 0;
      this.journeyPossession += ((stable ? 1 : 0) - this.journeyPossession) * Math.min(1, dt * 6);
      if (stable) {
        const eye = this.baked[this.journeyInput.form.form].def.eyes[0];
        const hand = this.journeyHands[eye[3] ?? 0];
        if (hand?.valid && hand.flat.valid) {
          this.journeyEyeX = hand.flat.x[eye[0]] + (hand.flat.x[eye[1]] - hand.flat.x[eye[0]]) * eye[2];
          this.journeyEyeY = hand.flat.y[eye[0]] + (hand.flat.y[eye[1]] - hand.flat.y[eye[0]]) * eye[2];
        }
      }
    }
    if (this.phase === Phase.Wake) this.journeyView?.updateLesson(this.animationTime);

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
      const blur = Math.min(12, Math.max(0.8, (penumbraMetres * SHADOW_PX_PER_METRE) / 3));
      p.shadow(hand.flat, this.phase === Phase.Journey ? blur * (1 - this.journeyPossession * 0.55) : blur);
    }
    p.flushShadows(this.phase === Phase.Wake ? 0.35 : 0.9);
    if (this.phase === Phase.Journey) {
      if (this.journeyPossession > 0.01) p.possess(this.journeyEyeX, this.journeyEyeY, this.journeyPossession);
      if (this.journeyShownForm >= 0) {
        p.formName(this.baked[this.journeyShownForm].def.creature, this.journeyEyeX + 0.06,
          Math.min(0.25, this.journeyEyeY + 0.105),
          this.journeyPossession * ease((this.animationTime - this.journeyNameAt) / 0.35));
      }
    }
    if (!this.playSandbox && this.classic && this.phase !== Phase.Finale && this.phase !== Phase.Journey) p.progress(this.step, NIGHT_LENGTH);

    if (this.immersive && !anyReal && time - this.handsSeenAt > 2 && !this.demo) {
      p.caption('Set the controllers down. Just your hands.', 1, 0.27);
    }
    p.end();
    this.wall.update(this.animationTime);
  }

  private observeSessionHands(mask: number, dt: number): void {
    if (!this.immersive) return;
    if (mask !== 3) { this.bothHandsTime = 0; return; }
    this.twoHandsSeen = true;
    this.bothHandsTime += dt;
    if (this.clearOneHandThisSession && this.bothHandsTime >= 3) {
      this.saved.oneHand = false;
      this.saved.oneHandAdaptations = 0;
      this.clearOneHandThisSession = false;
      save(this.saved);
    }
  }

  private seek(target: BakedTarget, stencil: Stencil, casters: number, dt: number, time: number): void {
    const casting = casters > 0;
    if (this.reform) this.reform.elapsed += dt;
    const reforming = !!this.reform && this.reform.elapsed < 1.4;
    // A two-hand creature only wakes for two shadows.
    const canMatch = !reforming && casters >= (target.partner ? 2 : 1);
    if (!canMatch) this.asyncMatcher?.reset();
    const raw = canMatch
      ? this.asyncMatcher?.ready ? this.asyncMatcher.score(this.baked.indexOf(target))
        : this.matcher.score(this.live, target.template)
      : 0;
    this.score += (raw - this.score) * Math.min(1, dt * 10);
    const close = Math.max(0, Math.min(1, (this.score - 0.3) / (target.pass - 0.3)));
    if (!casting) { this.score = 0; this.hold = 0; }
    if (casting && this.score >= target.pass) this.hold += dt;
    else this.hold = Math.max(0, this.hold - dt * 1.5);
    this.audio.setHold(casting ? close * close : 0);

    const glow = close * close + (this.hold > 0 ? 0.4 * this.hold / HOLD_TO_WAKE : 0);
    const oldCut = this.reform && this.reform.elapsed < 0.5;
    const shown = oldCut ? this.stencils[this.reform!.old] : stencil;
    const reveal = this.reform
      ? oldCut ? 1 - ease(this.reform.elapsed / 0.5) : ease((this.reform.elapsed - 0.5) / 0.9)
      : ease(this.phaseTime / 0.9);
    this.painter.target(shown, 0, TARGET_CY, glow, time, reveal, this.reform ? 0.25 : 0);
    if (this.reform) {
      this.painter.caption('One hand is enough tonight.', Math.min(ease(this.reform.elapsed / 0.5),
        1 - ease((this.reform.elapsed - 3.8) / 0.7)), 0.24);
      if (this.reform.elapsed >= 4.5) this.reform = null;
    }

    // First moment of the first night: light and shadow speak first; words only if nothing happens.
    if (!this.reform && this.saved.nights === 0 && this.step === 0) {
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
    if (!this.reform && this.immersive && this.step === 1 && !this.saved.carried && this.phaseTime > 1 && this.phaseTime < 6) {
      this.painter.caption('Pinch the lantern to carry the theater.', Math.min(ease((this.phaseTime - 1) / 0.6), 1 - ease((this.phaseTime - 5.2) / 0.8)), -0.27);
    }
    if (target.partner) {
      if (casters === 1) this.oneHandSeen = true;
      if (casters >= 2) { this.oneHand = 0; this.oneHandSeen = false; }
      else if (this.oneHandSeen) this.oneHand += dt;
    }
    // A newcomer shimmers the first time it appears.
    if (this.baked.indexOf(target) === this.fresh) {
      this.painter.sparks(0, TARGET_CY, (time * 0.35) % 1, 0.5);
      if (this.phaseTime < 3.5) this.painter.caption(
        this.crossingCaption === 'Shadows sleep without light. Wake them.'
          && this.animationTime - this.crossingCaptionAt < 4.5
          ? this.crossingCaption : 'Someone new is waiting.',
        1 - ease((this.phaseTime - 2.5) / 1), 0.27);
    }

    // Stuck? Fade in the ghost hand that shows the shape.
    if (close < 0.85) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    const hint = ease((this.stuck - HINT_AFTER) / 1.5);
    const hintsAllowed = !this.demo || this.demoDelay > 0 || this.demoOneHand;
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

    if (target.partner && this.oneHand >= 8 && hint > 0 && hintsAllowed) {
      this.adaptOneHand();
      return;
    }

    if (this.hold >= HOLD_TO_WAKE) {
      this.audio.setHold(0);
      this.audio.chime(this.step);
      const id = target.def.id;
      if (this.saved.deferred?.includes(id)) this.saved.deferred = this.saved.deferred.filter((value) => value !== id);
      this.saved.woken[id] = (this.saved.woken[id] ?? 0) + 1;
      const ability = abilityForForm(id);
      if (ability && !this.saved.abilities?.includes(ability)) (this.saved.abilities ??= []).push(ability);
      const order = this.saved.order ?? (this.saved.order = Object.keys(this.saved.woken).filter((k) => k !== id));
      if (!order.includes(id)) order.push(id);
      save(this.saved);
      this.ghost.opacity = this.ghost2.opacity = 0;
      if (this.asyncMatcher?.ready) {
        this.live.clear();
        for (const hand of this.allHands) if (hand.valid && hand.flat.valid) drawHand(this.live, hand.flat);
      }
      moments(this.live, this.wakeMo);
      this.wakeC0 = this.wakeMo.area > 4 ? { cx: this.wakeMo.cx, cy: this.wakeMo.cy } : null;
      this.follow.x = this.follow.y = this.follow.vx = 0;
      this.enter(Phase.Wake);
    }
  }

  private wake(target: BakedTarget, stencil: Stencil, time: number): void {
    const t = this.phaseTime;
    const ability = this.lessonAbility;
    if (ability && this.lessonResolvedAt < 0 && t >= 1.35) {
      const detected = this.journeyGestureState?.[ability] === true;
      if (detected || this.demo && t >= 2.9 || t >= LESSON_TIMEOUT) {
        this.lessonResolvedAt = t;
        if (detected || this.demo) {
          this.saved.lessonSkipped = this.saved.lessonSkipped?.filter((value) => value !== ability);
          this.journeyView?.showLessonGesture(ability, this.follow.x, time);
          this.audio.note(this.step + 5);
        } else if (!this.saved.lessonSkipped?.includes(ability)) (this.saved.lessonSkipped ??= []).push(ability);
        save(this.saved);
      }
    }
    const walkAt = this.wakeWalkAt();
    if (ability && this.lessonResolvedAt < 0 && t >= 0.9) {
      this.poseToWorld(target.pose, this.posePositions, 0, target.shifts[0]);
      this.lessonMotion(this.posePositions, ability, t);
      this.ghost.update(this.posePositions, target.pose.radii);
      this.ghost.opacity = 0.34 * ease((t - 0.9) / 0.25) * (1 - ease((t - 2.9) / 0.3));
      if (target.partner) {
        this.poseToWorld(target.partner, this.posePositions2, 0, target.shifts[1]);
        this.lessonMotion(this.posePositions2, ability, t);
        this.ghost2.update(this.posePositions2, target.partner.radii);
        this.ghost2.opacity = this.ghost.opacity;
      }
    } else this.ghost.opacity = this.ghost2.opacity = 0;
    if (!this.voiced && t >= 0.35) {
      this.voiced = true;
      this.audio.voice(target.def.motion);
    }
    // It comes alive in place and, until it walks off, follows the hand that made it:
    // move the hand and the creature moves with it. Then it walks off the paper's right edge.
    if (this.wakeC0 && t < walkAt) {
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
    const walk = ease((t - walkAt) / WALK_TIME);
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
    const alpha = onWall ? 1 : 1 - ease((t - walkAt - 0.8) / 0.5);
    const blink = t < 0.87 || (t > 1.35 && t < 1.44) || (t > 2.12 && t < 2.2);
    this.painter.creature(stencil, x, y, 1, rot, false, blink, alpha, Math.max(0, 1 - t / 1.5), time,
      stretchX, stretchY, fill);
    if (!this.leapt && t >= walkAt + WALK_TIME * 0.82) {
      this.leapt = true;
      if (onWall) this.wall.leap(target.def.id, stencil, time);
    }
    if (t < 1.5) this.painter.sparks(0, TARGET_CY, t / 1.5, 1);
    const capA = Math.min(ease((t - 0.3) / 0.5), 1 - ease((t - walkAt - 0.8) / 0.5));
    this.painter.caption(ability && t >= 0.9 && t < walkAt ? LESSON_COPY[ability] : target.def.line, capA);
    if (t >= Math.max(WAKE_TIME, walkAt + WALK_TIME + 0.35)) {
      this.step++;
      if (!this.classic && !this.journeyOnly && this.step >= this.order.length) {
        this.beginKnownLessons();
      } else if (this.step >= NIGHT_LENGTH) {
        this.saved.nights++;
        save(this.saved);
        if (this.journeyEnabled) this.beginJourney(); else this.enter(Phase.Finale);
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
    this.painter.caption(this.classic || this.journeyOnly ? FINALE_CAPTION
      : `${this.crossing?.home ?? 0} Kindlings found the moon.`, a, 0.2);
    const next = this.classic || this.journeyOnly ? this.nextNewcomer() : -1;
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

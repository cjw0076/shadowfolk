// Browser-only fault injection against the real runtime classes and canvases.
import { Group, PerspectiveCamera, Scene, VisibilityState } from '@iwsdk/core';
import { signal } from '@preact/signals-core';
import { TheaterSystem } from '../src/theater/theater-system';
import { TheaterAudio } from '../src/theater/audio';
import { JOINT_NAMES } from '../src/shadow/hand-model';

export async function run(): Promise<string[]> {
  const passed: string[] = [];
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
  const make = () => {
    let frame: any, ref: any = {};
    const state = signal(VisibilityState.NonImmersive);
    const world: any = {
      player: new Group(), scene: new Scene(), camera: new PerspectiveCamera(),
      renderer: { xr: { getFrame: () => frame, getReferenceSpace: () => ref } },
      visibilityState: state, createTransformEntity: () => ({}),
    };
    const system: any = new TheaterSystem(world, undefined as any, 0);
    return { system, world, state, frame: (value: any) => frame = value, ref: (value: any) => ref = value };
  };
  const originalSaved = localStorage.getItem('shadow-theater.v1');
  try {
    for (const raw of ['null', '{}', '[]', '"text"', '{', '{"nights":-1,"woken":null}', '{"nights":"8","woken":[]}']) {
      localStorage.setItem('shadow-theater.v1', raw);
      const { system } = make();
      check(system.saved.nights === 0 && typeof system.saved.woken === 'object', `bad save ${raw}`);
      system.destroy();
    }
    localStorage.setItem('shadow-theater.v1', '{"nights":2,"woken":{"rabbit":3,"peacock":-1,"duck":"2","heron":1e300}}');
    const { system: saved } = make();
    check(saved.saved.nights === 2 && saved.saved.woken.rabbit === 3 && Object.keys(saved.saved.woken).length === 1, 'valid counts preserved');
    saved.destroy();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    try { const { system } = make(); check(system.saved.nights === 0, 'blocked storage fallback'); system.destroy(); }
    finally { if (descriptor) Object.defineProperty(window, 'localStorage', descriptor); else delete (window as any).localStorage; }
    passed.push('PASS: malformed/null/partial saves, valid counts, and blocked localStorage');

    localStorage.removeItem('shadow-theater.v1');
    const { system: s, world, state, frame, ref } = make();
    let starts = 0, pauses = 0, disposed = 0;
    s.audio = { start() { starts++; }, pause() { pauses++; }, setHold() {}, rustle() {}, bloom() {},
      chime() {}, voice() {}, note() {}, settle() {}, dispose() { disposed++; } };
    s.init();
    s.demo = false;
    try {
      check(s.painter.canvas.width === 1024 && s.painter.canvas.height === 676
        && s.painter.soft.width === 256 && s.painter.soft.height === 169
        && s.screen.paper === s.painter.paperMesh && s.painter.root.children.length >= 4
        && !s.painter.texture.generateMipmaps, 'layered paper dimensions / no dynamic mip chain');
      s.update(1 / 60, 0);
      state.value = VisibilityState.Visible;
      s.update(1 / 60, 10);
      check(!s.placed && s.placeAt === 10.5, 'placement delay uses elapsed runtime clock');
      s.update(1 / 60, 10.6);
      check(s.placed, 'place after settling');
      const pos = s.screen.root.position.clone(), before = s.phaseTime;
      s.hold = .54; s.score = .9;
      state.value = VisibilityState.VisibleBlurred;
      for (let k = 0; k < 20; k++) s.update(.05, 11 + k);
      check(s.phaseTime === before && s.hold === 0 && s.score === 0 && pauses === 1, 'menu pauses night/hold/audio');
      state.value = VisibilityState.Visible;
      s.update(10, 40);
      check(s.phaseTime === before && s.placed && s.screen.root.position.equals(pos), 'resume suppresses backlog and retains placement');
      s.update(1 / 60, 40.02);
      check(s.phaseTime > before && starts >= 2, 'resume progresses and resumes audio');
      state.value = VisibilityState.Hidden;
      const hiddenPhase = s.phaseTime;
      s.update(.05, 41);
      check(s.phaseTime === hiddenPhase, 'hidden XR pauses');
      state.value = VisibilityState.NonImmersive;
      check(!s.placed && s.hold === 0 && !s.immersive, 'session end clears transient state');
      s.update(.05, 42);
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      const tabPhase = s.phaseTime;
      s.update(.05, 43);
      check(s.phaseTime === tabPhase, 'background tab pauses');
      delete (document as any).hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      s.update(20, 63);
      check(s.phaseTime === tabPhase, 'tab resume suppresses backlog');
      state.value = VisibilityState.Visible;
      s.update(.016, 64); s.update(.016, 64.6);
      check(s.placed && s.immersive, 'session can re-enter');
      passed.push('PASS: XR menu/hidden/tab pause, resume, end/re-entry, and elapsed-clock placement');

      const joints = new Float32Array(75);
      s.poseToWorld(s.baked[s.order[0]].pose, joints, 0);
      const hand = new Map(JOINT_NAMES.map((name, j) => [name, { j }]));
      let missing = -1, invalid = false, throws = false, radius = .01;
      const xrFrame = {
        session: { inputSources: [{ handedness: 'left', hand }, { handedness: 'right', hand }] },
        getJointPose(space: any) {
          if (throws) throw new DOMException('stale', 'InvalidStateError');
          if (space.j === missing) return null;
          const j = space.j;
          return { transform: { position: { x: invalid ? NaN : joints[j * 3], y: joints[j * 3 + 1], z: joints[j * 3 + 2] } }, radius };
        },
      };
      frame(xrFrame);
      s.readHands(65);
      check(s.hands.every((h: any) => h.valid), 'both tracked hands accepted');
      s.handMask = 3; s.hold = .54; s.score = 1;
      // A single missing joint invalidates the complete left hand, leaving right tracked.
      xrFrame.session.inputSources[0] = { handedness: 'left', hand: new Map([...hand].filter(([name]) => name !== JOINT_NAMES[24])) };
      s.update(.016, 65.1);
      check(!s.hands[0].valid && s.hands[1].valid && s.hold === 0 && s.phase === 0, 'one-hand loss cancels impending award');
      missing = 10; s.hold = .54; s.score = 1;
      s.update(.016, 65.2);
      check(s.hands.every((h: any) => !h.valid) && s.hold === 0 && s.phase === 0, 'all-hand loss cancels impending award');
      throws = true; s.readHands(65.3);
      check(s.hands.every((h: any) => !h.valid), 'stale joint spaces do not throw');
      throws = false; missing = -1; invalid = true; s.readHands(65.4);
      check(!s.hands[1].valid, 'nonfinite joint position rejected');
      invalid = false; radius = NaN; s.readHands(65.5);
      check(!s.hands[1].valid, 'nonfinite radius rejected');
      radius = 0; s.readHands(65.6);
      check(!s.hands[1].valid, 'invalid radius rejected');
      ref(undefined); s.readHands(65.7);
      check(!s.hands[1].valid, 'missing reference space accepted');
      ref({});
      xrFrame.session.inputSources = [{ handedness: 'right', gamepad: {} } as any];
      const captions: string[] = [];
      s.painter.caption = (text: string) => captions.push(text);
      s.handsSeenAt = 65; s.update(.016, 68);
      check(s.hands.every((h: any) => !h.valid) && captions.includes('Set the controllers down. Just your hands.'), 'controller-only session gives hand instruction');
      passed.push('PASS: missing joint, single/all hand loss near hold completion, stale spaces, bad pose/radius, no reference, controllers');

      // Quota denial on a successful hold must not stop the following frame.
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
      try {
        const target = s.baked[s.order[0]];
        s.matcher.score = () => 1; s.score = 1; s.hold = .54;
        s.seek(target, s.stencils[s.order[0]], true, .016, 70);
        check(s.phase === 1 && s.saved.woken[target.def.id] === 1, 'save denial does not block wake');
      } finally { Storage.prototype.setItem = setItem; }
      s.wake(s.baked[s.order[0]], s.stencils[s.order[0]], 70);
      passed.push('PASS: quota-denied successful wake continues playing');
      s.step = s.order.length - 1; s.phaseTime = 3.7;
      s.wake(s.baked[s.order[s.step]], s.stencils[s.order[s.step]], 71);
      check(s.phase === 3 && s.saved.nights === 1, 'last creature enters finale');
      s.phaseTime = 1; s.finale(72);
      s.phaseTime = 9.1; s.finale(82);
      check(s.phase === 0 && s.step === 0, 'finale returns to next night');
      passed.push('PASS: last wake, six-creature finale painting, and next night');
    } finally { delete (document as any).hidden; s.destroy(); }
    check(disposed === 1, 'audio teardown registered');

    const NativeAudio = window.AudioContext;
    try {
      (window as any).AudioContext = class { constructor() { throw new DOMException('unavailable', 'NotSupportedError'); } };
      const unavailable = new TheaterAudio(); unavailable.start(); unavailable.setHold(1); unavailable.chime(); unavailable.rustle(); unavailable.dispose();
    } finally { window.AudioContext = NativeAudio; }
    const a: any = new TheaterAudio();
    a.start();
    const ctx: AudioContext = a.ctx;
    await ctx.resume();
    a.setHold(1); a.pause();
    await ctx.suspend();
    check(ctx.state === 'suspended', 'audio pause');
    a.start(); await ctx.resume();
    check(String(ctx.state) === 'running', 'audio resume');
    await ctx.close(); a.start();
    check(a.ctx !== ctx, 'closed context recreated');
    const replacement: AudioContext = a.ctx;
    a.dispose(); await replacement.close().catch(() => {});
    a.ctx = { state: 'suspended', resume: () => Promise.reject(Error('resume denied')), suspend: () => Promise.reject(Error('suspend denied')), close: () => Promise.reject(Error('close denied')) };
    a.start(); a.pause(); a.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    passed.push('PASS: optional audio unavailable/rejected resume, real pause/resume, closed-context recovery, teardown');
    return passed;
  } finally {
    if (originalSaved === null) localStorage.removeItem('shadow-theater.v1');
    else localStorage.setItem('shadow-theater.v1', originalSaved);
  }
}

// Browser-only fault injection against the real runtime classes and canvases.
import { Group, PerspectiveCamera, Scene, VisibilityState } from '@iwsdk/core';
import { signal } from '@preact/signals-core';
import { TheaterSystem } from '../src/theater/theater-system';
import { TheaterAudio } from '../src/theater/audio';
import { JOINT_NAMES } from '../src/shadow/hand-model';
import { drawHand } from '../src/shadow/silhouette';

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
    localStorage.setItem('shadow-theater.v1', '{"nights":1,"woken":{},"oneHand":"yes","oneHandAdaptations":-1,"deferred":["butterfly","bogus","butterfly"]}');
    const { system: invalidAccess } = make();
    check(!invalidAccess.saved.oneHand && invalidAccess.saved.oneHandAdaptations === 0
      && JSON.stringify(invalidAccess.saved.deferred) === '["butterfly"]', 'one-hand save fields validated');
    invalidAccess.destroy();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    try { const { system } = make(); check(system.saved.nights === 0, 'blocked storage fallback'); system.destroy(); }
    finally { if (descriptor) Object.defineProperty(window, 'localStorage', descriptor); else delete (window as any).localStorage; }
    passed.push('PASS: malformed/null/partial saves, valid counts, and blocked localStorage');

    localStorage.removeItem('shadow-theater.v1');
    const { system: s, world, state, frame, ref } = make();
    let starts = 0, pauses = 0, disposed = 0;
    s.audio = { start() { starts++; }, pause() { pauses++; }, setHold() {}, rustle() {}, bloom() {},
      chime() {}, voice() {}, note() {}, settle() {}, tick() {}, crackle() {}, place() {}, dispose() { disposed++; } };
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
      check(s.phase === 4, 'finale opens the invent-your-own moment');
      s.phaseTime = 14.1; s.invent(0.016, 96, 0);
      check(s.phase === 0 && s.step === 0, 'invent with no hands times out into the next night');
      passed.push('PASS: last wake, six-creature finale painting, and next night');
    } finally { delete (document as any).hidden; s.destroy(); }
    check(disposed === 1, 'audio teardown registered');

    localStorage.removeItem('shadow-theater.v1');
    const { system: adapted } = make();
    adapted.init();
    adapted.demo = false;
    try {
      const butterfly = adapted.baked.findIndex((target: any) => target.def.id === 'butterfly');
      adapted.order = [butterfly, 0, 1, 2, 3];
      adapted.step = 0;
      adapted.enter(0);
      adapted.oneHandSeen = true;
      adapted.oneHand = 7.95;
      adapted.stuck = 7.95;
      adapted.seek(adapted.baked[butterfly], adapted.stencils[butterfly], 1, .06, 10);
      const replacement = adapted.order[0];
      check(replacement !== butterfly && !adapted.baked[replacement].partner
        && new Set(adapted.order).size === 5 && adapted.saved.deferred.includes('butterfly'), 'butterfly reforms into a unique one-hand target');
      const cuts: { id: number; reveal: number }[] = [];
      const captions: string[] = [];
      adapted.painter.target = (stencil: any, _x: number, _y: number, _glow: number, _time: number, reveal: number) => {
        cuts.push({ id: adapted.stencils.indexOf(stencil), reveal });
      };
      adapted.painter.caption = (caption: string) => captions.push(caption);
      adapted.seek(adapted.baked[replacement], adapted.stencils[replacement], 1, .2, 10.2);
      adapted.seek(adapted.baked[replacement], adapted.stencils[replacement], 1, .5, 10.7);
      check(cuts[0].id === butterfly && cuts[0].reveal < 1 && cuts[1].id === replacement
        && cuts[1].reveal > 0 && captions.includes('One hand is enough tonight.'), 'old cut-out burns away and new one burns in with caption');
      adapted.reform.elapsed = 1.5;
      adapted.matcher.score = () => 1;
      for (let slot = 0; slot < 5; slot++) {
        if (slot > 0) adapted.enter(0);
        const index = adapted.order[slot];
        adapted.score = 1; adapted.hold = .54;
        adapted.seek(adapted.baked[index], adapted.stencils[index], 1, .02, 20 + slot);
        check(adapted.phase === 1, `one-hand creature ${slot} wakes`);
        adapted.phaseTime = 3.3;
        adapted.wake(adapted.baked[index], adapted.stencils[index], 21 + slot);
      }
      check(adapted.phase === 3 && adapted.saved.nights === 1, 'one-hand night completes into finale');
      adapted.phaseTime = 9.1;
      adapted.finale(40);
      check(adapted.phase === 4, 'one-hand finale enters invent');
      adapted.live.clear();
      drawHand(adapted.live, adapted.baked[replacement].flat);
      adapted.hands[0].valid = true;
      adapted.hands[0].flat.x.set(adapted.baked[replacement].flat.x);
      adapted.hands[0].flat.y.set(adapted.baked[replacement].flat.y);
      adapted.hands[0].flat.r.set(adapted.baked[replacement].flat.r);
      adapted.hands[0].flat.valid = true;
      for (let frameIndex = 0; frameIndex < 40 && !adapted.inventBorn; frameIndex++) {
        adapted.phaseTime = 1.6 + frameIndex * .05;
        adapted.invent(.05, 41 + frameIndex * .05, 1);
      }
      check(adapted.inventBorn && adapted.saved.invented.length === 1
        && adapted.saved.invented[0].hands.length === 1, 'one hand invents a creature after the finale');
      adapted.newNight();
      check(adapted.order.includes(butterfly), 'skipped butterfly is offered on a later night');
      passed.push('PASS: butterfly adapts after eight seek seconds, burn-in/caption, one-hand night/finale/invent, skipped target returns');
    } finally { adapted.destroy(); }

    const priorUrl = location.href;
    try {
      history.replaceState(null, '', '?demo&demoOneHand&first=butterfly&day=20378');
      localStorage.removeItem('shadow-theater.v1');
      const { system: filmed } = make();
      filmed.init();
      try {
        const butterfly = filmed.baked.findIndex((target: any) => target.def.id === 'butterfly');
        check(filmed.demo && filmed.demoOneHand && filmed.order[0] === butterfly, 'one-hand demo opt-in and first target');
        let hintAt = -1, reformAt = -1, wakeAt = -1, handJump = Infinity;
        let priorPose: Float32Array | null = null;
        for (let frameIndex = 0; frameIndex < 480; frameIndex++) {
          const time = frameIndex * .05;
          filmed.update(.05, time);
          check(!filmed.demoHand2.valid, 'one-hand demo never casts a second puppet');
          if (filmed.ghost.material.opacity > 0 && hintAt < 0) hintAt = time;
          if (filmed.order[0] !== butterfly && reformAt < 0) {
            reformAt = time;
            priorPose = new Float32Array(filmed.demoHand.joints);
            check(filmed.reform?.old === butterfly, 'one-hand demo uses the real reform');
          } else if (priorPose && handJump === Infinity) {
            handJump = 0;
            for (let joint = 0; joint < priorPose.length; joint++) {
              handJump = Math.max(handJump, Math.abs(filmed.demoHand.joints[joint] - priorPose[joint]));
            }
          }
          if (filmed.phase === 1) { wakeAt = time; break; }
        }
        const replacement = filmed.baked[filmed.order[0]];
        check(hintAt >= 0 && reformAt > hintAt && wakeAt > reformAt
          && !replacement.partner && filmed.saved.woken[replacement.def.id] === 1
          && handJump < .025 && filmed.reported.size === 0,
        `filmed butterfly reforms and wakes without a puppet snap: ${JSON.stringify({ hintAt, reformAt, wakeAt, handJump })}`);
        passed.push('PASS: demoOneHand keeps one relaxed puppet, shows hint, reforms smoothly and wakes replacement');
      } finally { filmed.destroy(); }
    } finally { history.replaceState(null, '', priorUrl); }

    localStorage.removeItem('shadow-theater.v1');
    const { system: twoHands } = make();
    twoHands.init();
    twoHands.demo = false;
    try {
      const butterfly = twoHands.baked.findIndex((target: any) => target.def.id === 'butterfly');
      twoHands.order[0] = butterfly;
      twoHands.enter(0);
      twoHands.oneHandSeen = true; twoHands.oneHand = 7.99; twoHands.stuck = 8;
      twoHands.matcher.score = () => 0;
      twoHands.seek(twoHands.baked[butterfly], twoHands.stencils[butterfly], 2, .05, 10);
      check(twoHands.order[0] === butterfly && twoHands.oneHand === 0 && !twoHands.reform,
        'two tracked hands do not adapt');
      twoHands.stuck = 8;
      twoHands.seek(twoHands.baked[butterfly], twoHands.stencils[butterfly], 0, 8, 10.1);
      check(twoHands.order[0] === butterfly, 'empty room does not trigger one-hand adaptation');
      twoHands.order = [butterfly, 7, 0, 1, 2];
      for (const slot of [0, 1]) {
        twoHands.step = slot; twoHands.enter(0);
        twoHands.oneHandSeen = true; twoHands.oneHand = 7.99; twoHands.stuck = 8;
        const index = twoHands.order[slot];
        twoHands.seek(twoHands.baked[index], twoHands.stencils[index], 1, .05, 11 + slot);
      }
      check(twoHands.saved.oneHand && twoHands.saved.oneHandAdaptations === 2
        && twoHands.order.slice(1, 5).every((index: number) => !twoHands.baked[index].partner), 'second adaptation remembers one-hand preference and removes remaining two-hand targets');
      const stored = JSON.parse(localStorage.getItem('shadow-theater.v1')!);
      check(stored.oneHand === true && stored.oneHandAdaptations === 2, 'one-hand preference survives storage round-trip');
      const { system: reloaded } = make();
      reloaded.init();
      try {
        check(reloaded.saved.oneHand && reloaded.saved.oneHandAdaptations === 2, 'one-hand preference reloads');
        reloaded.order = [butterfly, 7, 0, 1, 2];
        reloaded.beginSession();
        check(reloaded.order.slice(0, 5).every((index: number) => !reloaded.baked[index].partner)
          && !reloaded.reform, 'remembered preference hides two-hand targets before they appear');
      } finally { reloaded.destroy(); }
      twoHands.immersive = true;
      twoHands.endSession(); twoHands.beginSession();
      twoHands.observeSessionHands(3, 2.9);
      check(twoHands.saved.oneHand && twoHands.twoHandsSeen, 'both hands permit targets but do not clear preference early');
      twoHands.observeSessionHands(3, .11);
      check(!twoHands.saved.oneHand && twoHands.saved.oneHandAdaptations === 0
        && JSON.parse(localStorage.getItem('shadow-theater.v1')!).oneHand === false, 'three seconds of both hands in later session clears preference');
      passed.push('PASS: two hands retain original target; second adaptation persists preference; later-session three-second clear');
    } finally { twoHands.destroy(); }

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

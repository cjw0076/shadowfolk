/**
 * Tiny WebAudio synth: a warm lantern drone, a rising hum while a shape is
 * held, a paper rustle when a new cut-out appears, a pentatonic chime when a
 * creature wakes, a small voice for each creature, and the lantern's bloom
 * when the first hand enters its light. No audio files, nothing to license.
 */
export type Voice = 'swim' | 'hop' | 'crawl' | 'bob' | 'fan' | 'flap' | 'stalk' | 'scuttle';
export type CueKind = 'bloom' | 'voice' | 'chime' | 'rustle' | 'note' | 'settle' | 'hold' | 'crackle' | 'journey' | 'play';
/** A sound cue at a time on the night's clock (recorded for offline rendering). */
export interface Cue { t: number; kind: CueKind; arg?: number | string }
export class TheaterAudio {
  /** Every cue is reported here (capture mode records them to render the soundtrack offline). */
  onCue?: (kind: CueKind, arg?: number | string) => void;
  private ctx?: BaseAudioContext;
  private offline = false;
  /** Absolute schedule time used while replaying cues offline. */
  private at: number | null = null;
  private lastHold = -1;
  private master?: GainNode;
  /** Send bus into a small synthetic room reverb (chimes, voices, notes). */
  private send?: GainNode;
  /** Spatial buses: the lantern (drone, hum, flame) and the stage (creatures, chimes). */
  private lanternOut?: GainNode;
  private stageOut?: GainNode;
  private mothOut?: GainNode;
  private lanternPan?: PannerNode;
  private stagePan?: PannerNode;
  private mothPan?: PannerNode;
  private bus: 'lantern' | 'stage' | 'moth' = 'stage';
  private crackleIn = 0.6;
  private hum?: { osc: OscillatorNode; gain: GainNode };
  private noise?: AudioBuffer;
  private paused = false;

  /** Must be called from a user gesture (XR session start, click). */
  start(): void {
    this.paused = false;
    if (this.ctx?.state === 'closed') this.ctx = undefined;
    if (this.ctx) {
      if (this.ctx.state !== 'running') void (this.ctx as AudioContext).resume().catch(() => {});
      return;
    }
    // Audio is optional: unsupported/denied contexts must not stop the night.
    try { this.initialize(); } catch { this.dispose(); }
  }

  private initialize(given?: BaseAudioContext): void {
    const ctx = given ?? new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    this.master = master;
    // Reverb: a generated stereo impulse (decaying noise), so nothing needs licensing.
    const verb = ctx.createConvolver();
    const irLen = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let seed = 4242 + ch * 77;
      for (let i = 0; i < irLen; i++) {
        seed = (seed * 16807) % 2147483647;
        const env = Math.pow(1 - i / irLen, 2.6) * (i < 120 ? i / 120 : 1);
        d[i] = ((seed / 2147483647) * 2 - 1) * env;
      }
    }
    verb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    verb.connect(wet).connect(master);
    const send = ctx.createGain();
    send.gain.value = 1;
    send.connect(verb);
    this.send = send;

    // Spatial buses. Live sessions place them in the room with HRTF panners; the offline
    // soundtrack (mono video audio) mixes them straight into the master.
    const busOut = (): [GainNode, PannerNode | undefined] => {
      const g = ctx.createGain();
      if (this.offline || typeof ctx.createPanner !== 'function') { g.connect(master); return [g, undefined]; }
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 0.6;
      pan.rolloffFactor = 0.7;
      g.connect(pan).connect(master);
      return [g, pan];
    };
    [this.lanternOut, this.lanternPan] = busOut();
    [this.stageOut, this.stagePan] = busOut();
    [this.mothOut, this.mothPan] = busOut();

    // Lantern drone: two soft detuned tones through a low-pass, slowly breathing.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const drone = ctx.createGain();
    drone.gain.value = 0.035;
    lp.connect(drone).connect(this.lanternOut!);
    for (const f of [110, 164.8, 220.5]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.09;
    lfoGain.gain.value = 0.015;
    lfo.connect(lfoGain).connect(drone.gain);
    lfo.start();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 330;
    gain.gain.value = 0;
    osc.connect(gain).connect(this.lanternOut!);
    osc.start();
    this.hum = { osc, gain };

    const len = ctx.sampleRate * 0.6;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    if (!given && ctx.state !== 'running') void (ctx as AudioContext).resume().catch(() => {});
  }

  private now(): number { return this.at ?? this.ctx!.currentTime; }

  private out(): AudioNode { return (this.bus === 'lantern' ? this.lanternOut
    : this.bus === 'moth' ? this.mothOut : this.stageOut) ?? this.master!; }

  /** Place the listener (head) and the two sound sources in world space; call every frame. */
  place(head: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number }, lantern: { x: number; y: number; z: number },
    stage: { x: number; y: number; z: number }): void {
    const ctx = this.ctx as AudioContext | undefined;
    if (!ctx || this.offline || !this.lanternPan || !this.stagePan) return;
    const l = ctx.listener;
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setTargetAtTime(head.x, t, 0.02); l.positionY.setTargetAtTime(head.y, t, 0.02); l.positionZ.setTargetAtTime(head.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02); l.forwardY.setTargetAtTime(fwd.y, t, 0.02); l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02); l.upY.setTargetAtTime(up.y, t, 0.02); l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      l.setPosition(head.x, head.y, head.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
    this.lanternPan.positionX.value = lantern.x; this.lanternPan.positionY.value = lantern.y; this.lanternPan.positionZ.value = lantern.z;
    this.stagePan.positionX.value = stage.x; this.stagePan.positionY.value = stage.y; this.stagePan.positionZ.value = stage.z;
  }

  placeMoth(point: { x: number; y: number; z: number }): void {
    if (!this.mothPan) return;
    this.mothPan.positionX.value = point.x;
    this.mothPan.positionY.value = point.y;
    this.mothPan.positionZ.value = point.z;
  }

  /** Render a recorded cue list with the same synth, for a video soundtrack. */
  static async renderOffline(cues: readonly Cue[], duration: number, sampleRate = 24000): Promise<AudioBuffer> {
    const ctx = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);
    const a = new TheaterAudio();
    a.offline = true;
    a.initialize(ctx);
    for (const c of cues) {
      if (c.t < 0 || c.t >= duration) continue;
      a.at = c.t;
      switch (c.kind) {
        case 'bloom': a.bloom(); break;
        case 'voice': a.voice(c.arg as Voice); break;
        case 'chime': a.chime(Number(c.arg ?? 0)); break;
        case 'rustle': a.rustle(); break;
        case 'note': a.note(Number(c.arg ?? 0)); break;
        case 'settle': a.settle(); break;
        case 'hold': a.setHold(Number(c.arg ?? 0)); break;
        case 'crackle': a.crackle(Number(c.arg ?? 0.5)); break;
        case 'journey': a.journey(String(c.arg ?? 'pickup')); break;
        case 'play': a.play(String(c.arg ?? 'walk')); break;
      }
    }
    a.at = null;
    return ctx.startRendering();
  }

  pause(): void {
    this.setHold(0);
    this.paused = true;
    if (this.ctx && this.ctx.state !== 'closed' && !this.offline) void (this.ctx as AudioContext).suspend().catch(() => {});
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.master = undefined;
    this.hum = undefined;
    this.noise = undefined;
    if (ctx && ctx.state !== 'closed' && !this.offline) void (ctx as AudioContext).close().catch(() => {});
  }

  /** 0..1 closeness of the shadow to the cut-out. */
  setHold(level: number): void {
    if (Math.abs(level - this.lastHold) > 0.02 || (level === 0) !== (this.lastHold === 0)) {
      this.lastHold = level;
      this.onCue?.('hold', +level.toFixed(3));
    }
    if (!this.live() || !this.hum) return;
    const t = this.now();
    this.hum.gain.gain.setTargetAtTime(level > 0 ? 0.015 + 0.05 * level : 0, t, 0.08);
    this.hum.osc.frequency.setTargetAtTime(262 + 260 * level, t, 0.1);
  }

  rustle(): void {
    this.onCue?.('rustle');
    const ctx = this.live();
    if (!ctx || !this.noise || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(bp).connect(g).connect(this.master);
    src.start(this.now());
  }

  private live(): BaseAudioContext | null {
    const ctx = this.ctx;
    return ctx && (this.offline || ctx.state === 'running') && !this.paused && this.master ? ctx : null;
  }

  /** One enveloped tone: sine/triangle, optional glide, starting `at` seconds from now. */
  private tone(f0: number, f1: number, at: number, dur: number, peak: number, type: OscillatorType = 'sine', wet = true): void {
    const ctx = this.live();
    if (!ctx) return;
    const t = this.now() + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.8);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(this.out());
    if (wet && this.send) g.connect(this.send);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** A short filtered noise burst (paper, wood, water). */
  private burst(freq: number, q: number, at: number, dur: number, peak: number, wet = true): void {
    const ctx = this.live();
    if (!ctx || !this.noise) return;
    const t = this.now() + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(bp).connect(g).connect(this.out());
    if (wet && this.send) g.connect(this.send);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** A tiny dry tick of the lantern's flame; `level` is the lantern brightness. */
  crackle(level: number): void {
    this.onCue?.('crackle', +level.toFixed(2));
    if (!this.live()) return; // no context yet (before the first gesture): nothing to schedule
    this.bus = 'lantern';
    this.burst(2800 + 2400 * ((this.now() * 7.31) % 1), 9, 0, 0.025, 0.035 * level, false);
    this.bus = 'stage';
  }

  /** Call every frame: the flame crackles now and then while the lantern burns. */
  tick(dt: number, level: number): void {
    if (level < 0.3) return;
    this.crackleIn -= dt;
    if (this.crackleIn > 0) return;
    this.crackleIn = 0.35 + ((this.crackleIn * 9301 + 49297) % 1 + 1) % 1 * 1.4;
    this.crackle(level);
  }

  /** The lantern blooms when the first hand enters its light. */
  bloom(): void {
    this.onCue?.('bloom');
    this.bus = 'lantern';
    for (const [k, f] of [196, 246.9, 293.7, 392].entries()) this.tone(f, f, k * 0.06, 2.6, 0.05);
    this.burst(900, 0.5, 0, 0.7, 0.05);
    this.bus = 'stage';
  }

  /** Each creature's small voice as it wakes. */
  voice(kind: Voice): void {
    this.onCue?.('voice', kind);
    switch (kind) {
      case 'hop': this.tone(140, 70, 0, 0.16, 0.16); this.tone(140, 70, 0.32, 0.16, 0.12); break;
      case 'fan': for (let k = 0; k < 6; k++) this.tone(1568 * Math.pow(2, (k % 3) / 12), 1568, k * 0.05, 0.5, 0.025); this.burst(5000, 0.8, 0, 0.35, 0.05); break;
      case 'crawl': this.tone(600, 900, 0, 0.7, 0.03); this.tone(750, 1120, 0.05, 0.7, 0.02); break;
      case 'swim': this.tone(380, 620, 0, 0.1, 0.12); this.tone(420, 700, 0.35, 0.09, 0.07); break;
      case 'bob': this.burst(950, 6, 0, 0.06, 0.25); this.burst(780, 6, 0.12, 0.06, 0.2); break;
      case 'flap': for (let k = 0; k < 3; k++) this.burst(1400, 1.2, k * 0.22, 0.15, 0.12); break;
      case 'stalk': this.tone(330, 290, 0, 1.2, 0.04, 'triangle'); this.burst(600, 2, 0.1, 0.4, 0.05); break;
      case 'scuttle': for (let k = 0; k < 5; k++) this.burst(2600, 4, k * 0.07, 0.03, 0.15); break;
    }
  }

  journey(kind: string): void {
    this.onCue?.('journey', kind);
    switch (kind) {
      case 'pickup': this.tone(587, 784, 0, 0.28, 0.07); break;
      case 'arrival': this.tone(784, 1175, 0, 1.1, 0.1); this.tone(1047, 1568, 0.18, 1.25, 0.08); break;
      case 'crow': this.burst(1400, 3, 0, 0.28, 0.18); this.tone(240, 470, 0, 0.19, 0.08); break;
      case 'vine': this.burst(2700, 5, 0, 0.16, 0.16); break;
      case 'gap': this.tone(220, 510, 0, 0.34, 0.11); break;
      case 'fog': this.burst(1100, 0.8, 0, 0.7, 0.1); break;
      case 'ledge': this.tone(310, 880, 0, 0.65, 0.07); break;
      case 'boulder': this.tone(90, 68, 0, 0.6, 0.13, 'triangle'); break;
      case 'crack': this.tone(1047, 1568, 0, 0.5, 0.065); break;
    }
  }

  play(kind: string): void {
    this.onCue?.('play', kind);
    if (kind === 'walk') this.burst(1350, 3, 0, 0.035, 0.018);
    else if (kind === 'ash') this.burst(730, 1.4, 0, 0.22, 0.08);
    else if (kind === 'home') this.tone(660, 990, 0, 0.32, 0.055);
    else if (kind === 'hiss') this.burst(2200, 2.8, 0, 0.45, 0.12);
    else if (kind === 'summon') {
      this.burst(1450, 2.2, 0, 0.34, 0.095);
      this.tone(290, 720, 0.05, 0.38, 0.042, 'triangle');
    }
    else if (kind === 'moth-flutter') {
      this.bus = 'moth';
      this.burst(3400, 5, 0, 0.11, 0.085);
      this.bus = 'stage';
    }
    else if (kind === 'moth-swat') {
      this.bus = 'moth';
      this.burst(1900, 3, 0, 0.28, 0.13);
      this.bus = 'stage';
    }
    else if (kind === 'queen-swell') {
      const ctx = this.live();
      if (ctx) {
        const t = this.now();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(110, t);
        oscillator.frequency.exponentialRampToValueAtTime(220, t + 3.1);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.065, t + 2.6);
        gain.gain.exponentialRampToValueAtTime(0.0005, t + 3.5);
        oscillator.connect(gain).connect(this.mothOut ?? this.master!);
        if (this.send) gain.connect(this.send);
        oscillator.start(t);
        oscillator.stop(t + 3.55);
      }
    }
    else if (kind === 'caw') {
      this.burst(1250, 1.6, 0, 0.21, 0.12);
      this.tone(420, 210, 0, 0.22, 0.08, 'sawtooth');
      this.tone(310, 175, 0.13, 0.19, 0.055, 'sawtooth');
    }
  }

  /** A single parade note (finale), from the same pentatonic scale as the chimes. */
  note(k: number): void {
    this.onCue?.('note', k);
    const scale = [0, 2, 4, 7, 9, 12, 14, 16];
    const f = 392 * Math.pow(2, scale[k % scale.length] / 12);
    this.tone(f, f, 0, 0.9, 0.06, 'triangle');
  }

  /** A shadow settling on the wall: soft paper tap. */
  settle(): void {
    this.onCue?.('settle');
    this.burst(1800, 1.5, 0, 0.12, 0.08);
    this.tone(880, 880, 0, 0.5, 0.025);
  }

  chime(step = 0): void {
    this.onCue?.('chime', step);
    const ctx = this.live();
    if (!ctx || !this.master) return;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16];
    const base = 523.25;
    const t0 = this.now();
    for (let k = 0; k < 4; k++) {
      const note = scale[(step + k * 2) % scale.length];
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = base * Math.pow(2, note / 12);
      const t = t0 + k * 0.11;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 1.6);
      o.connect(g).connect(this.master);
      if (this.send) g.connect(this.send);
      o.start(t);
      o.stop(t + 1.7);
    }
  }
}

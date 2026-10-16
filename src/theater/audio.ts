/**
 * Tiny WebAudio synth: a warm lantern drone, a rising hum while a shape is
 * held, a paper rustle when a new cut-out appears, and a pentatonic chime
 * when a creature wakes. No audio files, nothing to license.
 */
export class TheaterAudio {
  private ctx?: AudioContext;
  private master?: GainNode;
  private hum?: { osc: OscillatorNode; gain: GainNode };
  private noise?: AudioBuffer;
  private paused = false;

  /** Must be called from a user gesture (XR session start, click). */
  start(): void {
    this.paused = false;
    if (this.ctx?.state === 'closed') this.ctx = undefined;
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
      return;
    }
    // Audio is optional: unsupported/denied contexts must not stop the night.
    try { this.initialize(); } catch { this.dispose(); }
  }

  private initialize(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    this.master = master;

    // Lantern drone: two soft detuned tones through a low-pass, slowly breathing.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const drone = ctx.createGain();
    drone.gain.value = 0.035;
    lp.connect(drone).connect(master);
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
    osc.connect(gain).connect(master);
    osc.start();
    this.hum = { osc, gain };

    const len = ctx.sampleRate * 0.6;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  }

  pause(): void {
    this.setHold(0);
    this.paused = true;
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.suspend().catch(() => {});
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.master = undefined;
    this.hum = undefined;
    this.noise = undefined;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
  }

  /** 0..1 closeness of the shadow to the cut-out. */
  setHold(level: number): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.hum || this.paused) return;
    const t = this.ctx.currentTime;
    this.hum.gain.gain.setTargetAtTime(level > 0 ? 0.015 + 0.05 * level : 0, t, 0.08);
    this.hum.osc.frequency.setTargetAtTime(262 + 260 * level, t, 0.1);
  }

  rustle(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.paused || !this.noise || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
  }

  chime(step = 0): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.paused || !this.master) return;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16];
    const base = 523.25;
    const t0 = ctx.currentTime;
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
      o.start(t);
      o.stop(t + 1.7);
    }
  }
}

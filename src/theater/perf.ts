/** Opt-in, bounded CPU timings. Read ring buffers/counts from window.__perf. */
const CAPACITY = 4096;
export type PainterCall = 'begin' | 'target' | 'shadow' | 'flushShadows' | 'creature' | 'sparks' | 'caption' | 'progress' | 'end';

class Samples {
  readonly values = new Float64Array(CAPACITY);
  count = 0;
  push(ms: number): void { this.values[this.count++ % CAPACITY] = ms; }
}

class RuntimePerf {
  readonly capacity = CAPACITY;
  readonly update = new Samples();
  readonly painter = new Samples();
  readonly frameInterval = new Samples();
  readonly phase = new Uint8Array(CAPACITY);
  readonly calls: Record<PainterCall, Samples> = {
    begin: new Samples(), target: new Samples(), shadow: new Samples(),
    flushShadows: new Samples(), creature: new Samples(), sparks: new Samples(),
    caption: new Samples(), progress: new Samples(), end: new Samples(),
  };
  private painterMs = 0;
  private previous = 0;

  beginFrame(): number {
    const now = performance.now();
    if (this.previous) this.frameInterval.push(now - this.previous);
    this.previous = now;
    this.painterMs = 0;
    return now;
  }

  endCall(name: PainterCall, start: number): void {
    const ms = performance.now() - start;
    this.calls[name].push(ms);
    this.painterMs += ms;
  }

  endFrame(start: number, phase: number): void {
    this.phase[this.update.count % CAPACITY] = phase;
    this.update.push(performance.now() - start);
    this.painter.push(this.painterMs);
  }
}

declare global { interface Window { __perf?: RuntimePerf } }
export const runtimePerf = typeof window !== 'undefined' && new URLSearchParams(location.search).has('perf')
  ? (window.__perf = new RuntimePerf()) : undefined;

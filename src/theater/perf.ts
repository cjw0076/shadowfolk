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
  readonly mask = new Samples();
  readonly play = new Samples();
  readonly playClear = new Samples();
  readonly playInk = new Samples();
  readonly playAgents = new Samples();
  readonly playHazards = new Samples();
  readonly playView = new Samples();
  readonly frameInterval = new Samples();
  readonly uploadBytes = new Samples();
  readonly uploadSubmissions = new Samples();
  readonly phase = new Uint8Array(CAPACITY);
  readonly calls: Record<PainterCall, Samples> = {
    begin: new Samples(), target: new Samples(), shadow: new Samples(),
    flushShadows: new Samples(), creature: new Samples(), sparks: new Samples(),
    caption: new Samples(), progress: new Samples(), end: new Samples(),
  };
  private painterMs = 0;
  private maskMs = 0;
  private previous = 0;
  private pendingUploadBytes = 0;
  private pendingUploadSubmissions = 0;

  recordUpload(width: number, height: number): void {
    this.pendingUploadBytes += width * height * 4;
    this.pendingUploadSubmissions++;
  }

  recordMask(started: number): void {
    this.maskMs += performance.now() - started;
  }

  beginFrame(): number {
    const now = performance.now();
    this.uploadBytes.push(this.pendingUploadBytes);
    this.uploadSubmissions.push(this.pendingUploadSubmissions);
    this.pendingUploadBytes = 0;
    this.pendingUploadSubmissions = 0;
    if (this.previous) this.frameInterval.push(now - this.previous);
    this.previous = now;
    this.painterMs = 0;
    this.maskMs = 0;
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
    this.mask.push(this.maskMs);
  }
}

declare global { interface Window { __perf?: RuntimePerf } }
export const runtimePerf = typeof window !== 'undefined' && new URLSearchParams(location.search).has('perf')
  ? (window.__perf = new RuntimePerf()) : undefined;

if (runtimePerf) {
  const install = (prototype: WebGLRenderingContext | WebGL2RenderingContext) => {
    const original = prototype.texSubImage2D;
    prototype.texSubImage2D = function (this: WebGLRenderingContext) {
      const args = arguments;
      if (args.length >= 9) runtimePerf.recordUpload(Number(args[4]), Number(args[5]));
      else {
        const source = args[6] as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
        runtimePerf.recordUpload(source.videoWidth ?? source.width ?? 0, source.videoHeight ?? source.height ?? 0);
      }
      return Reflect.apply(original, this, args as unknown as unknown[]);
    } as typeof original;
  };
  install(WebGLRenderingContext.prototype);
  install(WebGL2RenderingContext.prototype);
}

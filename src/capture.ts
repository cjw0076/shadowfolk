/**
 * Capture mode (`?capture`): the world advances only when a recorder asks for
 * the next frame, by an exact time step, so a slow machine still films a
 * smooth, real-time-correct night. Sound cues are logged on the same clock
 * and rendered offline with the same synth. Nothing here runs without the flag.
 */
import type { World } from '@iwsdk/core';
import { Cue, TheaterAudio } from './theater/audio.js';

export interface CaptureControl {
  /** Advance the world by dt seconds and resolve once that frame has rendered. */
  step(dt?: number): Promise<number>;
  /** Optional camera for the browser preview: position, look-at target, vertical fov. */
  camera: { pos: [number, number, number]; look: [number, number, number]; fov?: number } | null;
  cues: Cue[];
  readonly time: number;
  /** Render the recorded cues to a mono 16-bit WAV (base64) of the given length. */
  renderAudio(duration: number): Promise<string>;
}

function wavBase64(buf: AudioBuffer): string {
  const data = buf.getChannelData(0), n = data.length, rate = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, v: string) => { for (let i = 0; i < v.length; i++) out.setUint8(o + i, v.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const capturing = typeof location !== 'undefined' && new URLSearchParams(location.search).has('capture');

export function captureControl(): CaptureControl | undefined {
  return (globalThis as unknown as { __capture?: CaptureControl }).__capture;
}

export function installCapture(world: World): void {
  const original = world.update.bind(world);
  let t = 0;
  let pending: { dt: number; resolve: (t: number) => void } | null = null;
  world.update = (_delta: number, _time: number) => {
    if (!pending) return;
    const p = pending;
    pending = null;
    t += p.dt;
    try {
      original(p.dt, t);
    } finally {
      // The renderer draws this state right after update; resolve on the next frame
      // (also after an error, so a recorder reports it instead of hanging).
      requestAnimationFrame(() => p.resolve(t));
    }
  };
  const control: CaptureControl = {
    step: (dt = 1 / 30) => new Promise((resolve) => { pending = { dt, resolve }; }),
    camera: null,
    cues: [],
    get time() { return t; },
    renderAudio: async (duration: number) => wavBase64(await TheaterAudio.renderOffline(control.cues, duration)),
  };
  (globalThis as unknown as { __capture: CaptureControl }).__capture = control;
  (globalThis as unknown as { __captureWorld: World }).__captureWorld = world; // inspection while filming
  // A clean frame: only the 3D canvas (`?capture=keepdom` keeps the page as is, e.g. for
  // the XR emulator, which composites its view outside the scene container).
  if (new URLSearchParams(location.search).get('capture') === 'keepdom') return;
  const style = document.createElement('style');
  style.textContent = 'body > *:not(#scene-container){display:none!important} #scene-container > *:not(canvas){display:none!important}';
  document.head.appendChild(style);
}

// Render the soundtrack for a filmed span of a capture-mode session (env XR_T0 capture time at the first
// filmed frame, XR_SECS duration, XR_WAV output path).
import { writeFileSync } from 'node:fs';
export default async function run({ page, frame }) {
  const target = frame ?? page;
  const t0 = Number(process.env.XR_T0), secs = Number(process.env.XR_SECS);
  const wav = await target.evaluate(async ([t0, secs]) => {
    const c = window.__capture;
    const all = c.cues;
    const span = all.filter((q) => q.t >= t0 && q.t < t0 + secs).map((q) => ({ ...q, t: q.t - t0 }));
    const before = all.filter((q) => q.t < t0 && q.kind === 'hold').pop();
    if (before) span.unshift({ ...before, t: 0 });
    c.cues = span;
    try { return await c.renderAudio(secs); } finally { c.cues = all; }
  }, [t0, secs]);
  writeFileSync(process.env.XR_WAV, Buffer.from(wav, 'base64'));
  return { ok: true, bytes: wav.length };
}

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [base = 'https://127.0.0.1:4179/', evidence = '../collab/codex/09-evidence'] = process.argv.slice(2);
const fps = 30;
const shots = [
  { id: 'reveal', start: 0, end: 1.1, phase: 'seek', target: 'peacock' },
  { id: 'wake-flare', start: 2.55, end: 3.7, phase: 'wake', target: 'peacock' },
  { id: 'walk-hop', start: 10.8, end: 12.9, phase: 'wake', target: 'rabbit' },
  { id: 'walk-crawl', start: 25.0, end: 27.1, phase: 'wake', target: 'snail' },
  { id: 'walk-swim', start: 32.15, end: 34.3, phase: 'wake', target: 'fish' },
  { id: 'finale-end', start: 41.2, end: 43.5, phase: 'finale', target: 'peacock' },
  { id: 'next-reveal', start: 49.55, end: 50.7, phase: 'seek', target: 'snail' },
].map((shot) => ({ ...shot, first: Math.round(shot.start * fps), last: Math.round(shot.end * fps) }));
const camera = { pos: [0.2, 1.42, 0.4], look: [0, 1.21, -1], fov: 40 };
const raw = '/tmp/shadowfolk-transition-frames';
mkdirSync(evidence, { recursive: true });
for (const shot of shots) mkdirSync(`${raw}/${shot.id}`, { recursive: true });
const browser = await chromium.launch({ args: [
  '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
  '--autoplay-policy=no-user-gesture-required',
] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.removeItem('shadow-theater.v1');
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
  });
  await page.goto(`${base}?capture&demo&day=20742`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture?.state, null, { timeout: 60000 });
  await page.evaluate((value) => { window.__capture.camera = value; }, camera);
  const canvas = page.locator('#scene-container canvas').first();
  await canvas.waitFor({ timeout: 60000 });
  const metadata = { base, day: 20742, fps, width: 1600, height: 900, shots: [], errors };
  const finalFrame = Math.max(...shots.map((shot) => shot.last));
  for (let frame = 0; frame < finalFrame; frame++) {
    const stepped = await Promise.race([
      page.evaluate((dt) => window.__capture.step(dt), 1 / fps),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000)),
    ]);
    if (stepped === 'timeout') throw new Error(`Frame ${frame} timed out`);
    for (const shot of shots) {
      if (frame < shot.first || frame >= shot.last) continue;
      const index = frame - shot.first;
      await canvas.screenshot({ path: `${raw}/${shot.id}/f${String(index).padStart(5, '0')}.png` });
      if (index === 0 || index === Math.floor((shot.last - shot.first) / 2) || frame === shot.last - 1) {
        const state = await page.evaluate(() => window.__capture.state());
        shot.states ??= [];
        shot.states.push({ second: +(frame / fps).toFixed(2), ...state });
      }
    }
    if (frame % 150 === 0) process.stdout.write(`frame ${frame}/${finalFrame}\n`);
  }
  for (const shot of shots) {
    if (!shot.states?.some((state) => state.phase === shot.phase && state.target === shot.target)) {
      throw new Error(`Unexpected ${shot.id} phase/target: ${JSON.stringify(shot.states)}`);
    }
    const frames = shot.last - shot.first;
    const duration = frames / fps;
    const audio = await page.evaluate(async ({ start, duration }) => {
      const control = window.__capture;
      const original = control.cues;
      const priorHold = original.filter((cue) => cue.kind === 'hold' && cue.t < start).at(-1);
      control.cues = original.filter((cue) => cue.t >= start && cue.t < start + duration)
        .map((cue) => ({ ...cue, t: cue.t - start }));
      if (priorHold) control.cues.unshift({ ...priorHold, t: 0 });
      try { return await control.renderAudio(duration); }
      finally { control.cues = original; }
    }, { start: shot.first / fps, duration });
    writeFileSync(`${raw}/${shot.id}/audio.wav`, Buffer.from(audio, 'base64'));
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', `${raw}/${shot.id}/f%05d.png`,
      '-i', `${raw}/${shot.id}/audio.wav`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', `${evidence}/${shot.id}.mp4`,
    ]);
    const picks = [0, Math.floor((frames - 1) / 3), Math.floor((frames - 1) * 2 / 3), frames - 1];
    const inputs = picks.flatMap((index) => ['-i', `${raw}/${shot.id}/f${String(index).padStart(5, '0')}.png`]);
    const filter = picks.map((_, index) => `[${index}:v]scale=400:225[s${index}]`).join(';')
      + ';[s0][s1][s2][s3]hstack=inputs=4[out]';
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter,
      '-map', '[out]', '-frames:v', '1', `${evidence}/${shot.id}-strip.png`]);
    metadata.shots.push({ id: shot.id, start: shot.first / fps, end: shot.last / fps, frames, states: shot.states });
    process.stdout.write(`${shot.id}: ${frames} frames, ${duration.toFixed(2)} s\n`);
  }
  writeFileSync(`${evidence}/metadata.json`, JSON.stringify(metadata, null, 2));
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
} finally {
  await browser.close();
}

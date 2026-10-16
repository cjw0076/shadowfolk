// Film one shot of the browser preview frame by frame (?demo&capture), plus its soundtrack.
// Usage: node tools/record/record.mjs shot.json outdir [baseUrl]
// shot.json: { "seconds": 12, "fps": 30, "width": 1600, "height": 900, "params": "demo",
//              "storage": { "shadow-theater.v1": {...} }, "warmup": 2,
//              "camera": [ { "t": 0, "pos": [x,y,z], "look": [x,y,z], "fov": 50 }, ... ] }
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [shotPath, outDir, base = 'https://127.0.0.1:4173/'] = process.argv.slice(2);
const shot = JSON.parse(readFileSync(shotPath, 'utf8'));
const fps = shot.fps ?? 30, seconds = shot.seconds, frames = Math.round(seconds * fps);
mkdirSync(`${outDir}/frames`, { recursive: true });

const lerp = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const smooth = (k) => k * k * (3 - 2 * k);
function cameraAt(t) {
  const keys = shot.camera;
  if (!keys?.length) return null;
  if (t <= keys[0].t) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t <= b.t) {
      const k = smooth((t - a.t) / (b.t - a.t));
      return { pos: lerp(a.pos, b.pos, k), look: lerp(a.look, b.look, k), fov: (a.fov ?? 50) + ((b.fov ?? 50) - (a.fov ?? 50)) * k };
    }
  }
  return keys[keys.length - 1];
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: shot.width ?? 1600, height: shot.height ?? 900 }, ignoreHTTPSErrors: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Seed saved progress before the app reads it.
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.evaluate((st) => { localStorage.clear(); for (const [k, v] of Object.entries(st ?? {})) localStorage.setItem(k, JSON.stringify(v)); }, shot.storage);
await page.goto(`${base}?capture&${shot.params ?? 'demo'}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__capture && window.__theater !== undefined || window.__capture, null, { timeout: 60000 });
const canvas = page.locator('#scene-container canvas').first();
await canvas.waitFor({ timeout: 60000 });
// Warm-up: let the stage place and settle without filming.
const warm = Math.round((shot.warmup ?? 1.5) * fps);
for (let i = 0; i < warm; i++) {
  await page.evaluate(([cam]) => { window.__capture.camera = cam; }, [cameraAt(0)]);
  await page.evaluate((dt) => window.__capture.step(dt), 1 / fps);
}
const t0 = await page.evaluate(() => window.__capture.time);
const startCue = await page.evaluate(() => window.__capture.cues.length);
const started = Date.now();
for (let f = 0; f < frames; f++) {
  const cam = cameraAt(f / fps);
  await page.evaluate((c) => { window.__capture.camera = c; }, cam);
  await page.evaluate((dt) => window.__capture.step(dt), 1 / fps);
  await canvas.screenshot({ path: `${outDir}/frames/f${String(f).padStart(5, '0')}.png` });
  if (f % 30 === 0) process.stdout.write(`frame ${f}/${frames} (${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
}
// Soundtrack: cues logged during the filmed span, shifted to start at 0.
const wav = await page.evaluate(async ([t0, startCue, secs]) => {
  const c = window.__capture;
  const all = c.cues;
  c.cues = all.slice(startCue).map((q) => ({ ...q, t: q.t - t0 }));
  // keep the hold level that was active when filming began
  const before = all.slice(0, startCue).filter((q) => q.kind === 'hold').pop();
  if (before) c.cues.unshift({ ...before, t: 0 });
  return c.renderAudio(secs);
}, [t0, startCue, seconds]);
writeFileSync(`${outDir}/audio.wav`, Buffer.from(wav, 'base64'));
writeFileSync(`${outDir}/errors.json`, JSON.stringify(errors, null, 1));
await browser.close();
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', `${outDir}/frames/f%05d.png`, '-i', `${outDir}/audio.wav`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-shortest', `${outDir}/shot.mp4`]);
console.log(`done: ${outDir}/shot.mp4 frames=${frames} errors=${errors.length}`);

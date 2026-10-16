// Pick which object draws a pixel at frame N of a shot (same flow as record.mjs).
// Usage: node tools/record/pick-shot.mjs shot.json frame px py
// Film one shot of the browser preview frame by frame (?demo&capture), plus its soundtrack.
// Usage: node tools/record/record.mjs shot.json outdir [baseUrl]
// shot.json: { "seconds": 12, "fps": 30, "width": 1600, "height": 900, "params": "demo",
//              "storage": { "shadow-theater.v1": {...} }, "warmup": 2,
//              "camera": [ { "t": 0, "pos": [x,y,z], "look": [x,y,z], "fov": 50 }, ... ] }
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [shotPath, frameArg, pxArg, pyArg, base = 'https://127.0.0.1:4173/'] = process.argv.slice(2);
const outDir = process.env.OUT ?? '/tmp/pick-shot';
const shot = JSON.parse(readFileSync(shotPath, 'utf8'));
const fps = shot.fps ?? 30, seconds = shot.seconds, frames = Math.round(seconds * fps);
mkdirSync(`${outDir}/frames`, { recursive: true });

const lerp = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
// One exact frame step, with a timeout so a broken page fails loudly instead of hanging.
async function step(page, dt) {
  const r = await Promise.race([page.evaluate((d) => window.__capture.step(d), dt), new Promise((res) => setTimeout(() => res('timeout'), 15000))]);
  if (r === 'timeout') throw new Error('frame step timed out (page error?)');
}
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
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
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
  await step(page, 1 / fps);
}
for (let f = 0; f <= +frameArg; f++) {
  await page.evaluate((c) => { window.__capture.camera = c; }, cameraAt(f / fps));
  await step(page, 1 / fps);
}
await canvas.screenshot({ path: `${outDir}/pick.png` });
const r = await page.evaluate(([x, y]) => {
  const w = window.__captureWorld, R = w.renderer, gl = R.getContext();
  const c = R.domElement, sx = Math.round(x * c.width / innerWidth), sy = c.height - 1 - Math.round(y * c.height / innerHeight);
  const read = () => { R.render(w.scene, w.camera); const b = new Uint8Array(4); gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return Array.from(b); };
  const base = read(), hits = [];
  const list = []; w.scene.traverse((o) => { if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.visible) list.push(o); });
  for (const o of list) {
    o.visible = false; const v = read(); o.visible = true;
    const d = Math.abs(v[0] - base[0]) + Math.abs(v[1] - base[1]) + Math.abs(v[2] - base[2]);
    if (d > 20) {
      const path = []; for (let q = o; q && path.length < 5; q = q.parent) path.push(q.name || q.type);
      const p = o.getWorldPosition(o.position.clone());
      hits.push({ path: path.join('<'), d, mat: o.material?.type, world: p.toArray().map((v) => +v.toFixed(3)), scale: o.scale.toArray().map((v) => +v.toFixed(3)), user: Object.keys(o.userData ?? {}), map: o.material?.map?.image?.width });
    }
  }
  return { base, n: list.length, hits };
}, [+pxArg, +pyArg]);
console.log(JSON.stringify(r));
await browser.close();

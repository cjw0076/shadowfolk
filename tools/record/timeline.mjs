// Print the night's phase timeline for a shot JSON (no screenshots): node tools/record/timeline.mjs shot.json [seconds]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [shotPath, secsArg = '90', base = 'https://127.0.0.1:4173/'] = process.argv.slice(2);
const shot = JSON.parse(readFileSync(shotPath, 'utf8'));
const fps = 30, secs = Number(secsArg);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, ignoreHTTPSErrors: true });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.evaluate((st) => { localStorage.clear(); for (const [k, v] of Object.entries(st ?? {})) localStorage.setItem(k, JSON.stringify(v)); }, shot.storage);
await page.goto(`${base}?capture&${shot.params ?? 'demo'}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__capture && window.__capture.state, null, { timeout: 60000 });
let last = '';
for (let f = 0; f < secs * fps; f++) {
  await page.evaluate((dt) => window.__capture.step(dt), 1 / fps);
  if (f % 3) continue;
  const s = await page.evaluate(() => window.__capture.state());
  if (!s) continue;
  const key = `${s.phase} step=${s.step} ${s.target}${s.born ? ' born' : ''} mode=${s.mode}`;
  if (key !== last) { console.log(`${(f / fps).toFixed(2).padStart(6)}s  ${key}`); last = key; }
}
await browser.close();

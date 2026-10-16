// Draw calls / triangles / textures of the preview after a night has started: node tools/record/render-stats.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
await page.goto('https://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.setItem('shadow-theater.v1', JSON.stringify({ nights: 4, woken: { peacock: 1, rabbit: 1, snail: 1, fish: 1, duck: 1, butterfly: 1, heron: 1, stag: 1 }, order: ['peacock','rabbit','snail','fish','duck','butterfly','heron','stag'] })); });
await page.goto('https://127.0.0.1:4173/?capture&demo&day=20378', { waitUntil: 'load' });
await page.waitForFunction(() => window.__captureWorld, null, { timeout: 60000 });
const out = [];
for (const until of [3, 6, 9]) {
  while (await page.evaluate(() => window.__capture.time) < until) await page.evaluate(() => window.__capture.step(1 / 30));
  out.push(await page.evaluate(() => { const i = window.__captureWorld.renderer.info; return { t: +window.__capture.time.toFixed(1), calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries, programs: i.programs?.length }; }));
}
console.log(JSON.stringify(out));
await browser.close();

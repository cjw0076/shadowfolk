// Inspect scene objects in capture mode (production build): node tools/record/probe.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
await page.goto('https://127.0.0.1:4173/?capture&demo', { waitUntil: 'load' });
await page.waitForFunction(() => window.__captureWorld, null, { timeout: 60000 });
for (let i = 0; i < 40; i++) await page.evaluate(() => window.__capture.step(1 / 30));
const r = await page.evaluate(() => {
  const w = window.__captureWorld;
  const p = w.getSceneObject?.('welcome-panel');
  const hits = [];
  w.scene.traverse((o) => { if (/panel|welcome/i.test(o.name)) hits.push([o.name, o.type, o.visible, o.parent?.name || o.parent?.type]); });
  const camKids = w.camera.children.map((c) => [c.name, c.type, c.visible]);
  return { found: !!p, name: p?.name, type: p?.type, visible: p?.visible, parent: p?.parent?.name || p?.parent?.type, hits: hits.slice(0, 10), camKids };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();

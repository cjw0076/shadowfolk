// Print world positions of the rig's main objects in capture mode: node tools/record/rig-probe.mjs [params]
import { chromium } from 'playwright';
const params = process.argv[2] ?? 'demo';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, ignoreHTTPSErrors: true });
await page.goto(`https://127.0.0.1:4173/?capture&${params}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__captureWorld, null, { timeout: 60000 });
for (let i = 0; i < 60; i++) await page.evaluate(() => window.__capture.step(1 / 30));
const r = await page.evaluate(() => {
  const out = {};
  window.__captureWorld.scene.traverse((o) => {
    if (!o.name || out[o.name]) return;
    const p = o.getWorldPosition(o.position.clone());
    out[o.name] = p.toArray().map((v) => +v.toFixed(3));
  });
  return out;
});
console.log(JSON.stringify(r));
await browser.close();

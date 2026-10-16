import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'https://127.0.0.1:4179/';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });

try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(baseUrl);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('shadow-theater.v1', JSON.stringify({
      nights: 1,
      woken: { peacock: 1, rabbit: 1, snail: 1, fish: 1, duck: 1 },
      order: ['peacock', 'rabbit', 'snail', 'fish', 'duck'],
    }));
  });
  await page.goto(`${baseUrl}?capture&demo&day=20378`);
  await page.waitForFunction(() => window.__capture && window.__captureWorld, null, { timeout: 60000 });
  for (let frame = 0; frame < 120; frame++) {
    await page.evaluate(() => window.__capture.step(1 / 30));
  }
  const backing = await page.evaluate(() => {
    const staticTextures = [];
    const shadowTextures = [];
    window.__captureWorld.scene.traverse(object => {
      const source = object.material?.map?.image;
      if (!(source instanceof HTMLCanvasElement)) return;
      const path = [];
      for (let parent = object; parent && path.length < 7; parent = parent.parent) {
        path.push(parent.name || parent.type);
      }
      const owner = path.find(name => ['PaperScreen', 'WallShadows', 'LanternPool', 'Moon', 'PreviewRoom'].includes(name));
      if (!owner) return;
      const entry = {
        owner,
        size: `${source.width}x${source.height}`,
        cpu: source.getContext('2d')?.getContextAttributes()?.willReadFrequently === true,
      };
      if (owner === 'PaperScreen' && object.renderOrder === 3) shadowTextures.push(entry);
      else staticTextures.push(entry);
    });
    return { staticTextures, shadowTextures };
  });
  assert.deepEqual(errors, [], 'page errors');
  assert.ok(backing.staticTextures.length >= 20, 'expected paper, wall sprites, and stage textures');
  assert.ok(backing.staticTextures.some(texture => texture.owner === 'WallShadows'), 'wall textures missing');
  assert.ok(backing.staticTextures.every(texture => texture.cpu), 'a static canvas uses the GPU 2D path');
  assert.equal(backing.shadowTextures.length, 1, 'expected one live shadow canvas');
  assert.equal(backing.shadowTextures[0].cpu, false, 'live shadow should keep its fast GPU 2D path');
  console.log(`PASS: ${backing.staticTextures.length} static canvas textures CPU-backed; live shadow GPU-backed`);
} finally {
  await browser.close();
}

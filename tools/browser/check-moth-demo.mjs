import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const url = new URL(base);
url.search = 'capture=keepdom&demo&crossingOnly&night=6&hazards=thorns&kindlings=6&seed=21021&moon=0.4';
const errors = [];
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, ignoreHTTPSErrors: true });
  page.on('pageerror', (error) => errors.push(String(error.stack ?? error)));
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture?.step && window.__theater?.moths);
  const result = await page.evaluate(async () => {
    const theater = window.__theater;
    let bridgeFrames = 0, swatFrames = 0, bothFrames = 0, firstReachAt = null, firstShooAt = null;
    for (let frame = 0; frame < 280; frame++) {
      await window.__capture.step(0.05);
      if (theater.demoHand.valid) bridgeFrames++;
      if (theater.demoHand2.valid) {
        swatFrames++;
        if (theater.demoHand.valid) bothFrames++;
        if (firstReachAt === null) firstReachAt = window.__capture.time;
      }
      if (theater.moths.shooed && firstShooAt === null) firstShooAt = window.__capture.time;
    }
    return { bridgeFrames, swatFrames, bothFrames, firstReachAt, firstShooAt,
      shooed: theater.moths.shooed, gutters: theater.moths.gutters,
      home: theater.crossing.home, total: theater.crossing.total,
      stars: theater.crossing.stars };
  });
  result.errors = errors;
  result.pass = errors.length === 0 && result.bridgeFrames > 50 && result.swatFrames >= 10
    && result.bothFrames >= 10 && result.shooed >= 1 && result.gutters === 0
    && result.firstReachAt < result.firstShooAt && result.home / result.total >= 0.75;
  writeFileSync('../collab/codex/23-moth-demo.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
  await page.close();
} finally {
  await browser.close();
}

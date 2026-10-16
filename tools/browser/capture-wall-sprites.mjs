import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'https://127.0.0.1:4179/?demo&perf';
const output = process.argv[3] ?? '../collab/codex/03-wall-sprites-evidence';
const label = process.argv[4] ?? 'after';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await page.addInitScript(() => {
    localStorage.setItem('shadow-theater.v1', JSON.stringify({
      nights: 1,
      woken: { peacock: 1, rabbit: 1, snail: 1, fish: 1, duck: 1 },
      order: ['peacock', 'rabbit', 'snail', 'fish', 'duck'],
    }));
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__theater?.wall?.active && window.__theater.wall.residents.length >= 5, { timeout: 30000 });
  await page.screenshot({ path: `${output}/${label}-wall.png` });
  await page.waitForFunction(() => window.__theater?.phase === 1 && window.__theater.phaseTime > 0.35 && window.__theater.phaseTime < 1.1, { timeout: 45000 });
  await page.screenshot({ path: `${output}/${label}-sparks.png` });
  await page.waitForFunction(() => window.__theater?.wall?.leaper && window.__theater.phaseTime > 2.15 && window.__theater.phaseTime < 2.8, { timeout: 20000 });
  await page.screenshot({ path: `${output}/${label}-leap.png` });
  console.log(JSON.stringify({ label, errors, residents: await page.evaluate(() => window.__theater.wall.residents.map(resident => resident.id)) }));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}

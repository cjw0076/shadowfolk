import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] ?? 'https://127.0.0.1:4179/?demo&perf';
const directory = process.argv[3];
const prefix = process.argv[4];
if (!directory || !prefix) throw new Error('usage: capture-layered-evidence.mjs URL DIR old|new');
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => localStorage.removeItem('shadow-theater.v1'));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.mouse.click(1100, 700);
  const targets = [
    { name: 'seek', phase: 0, seconds: 0.6 },
    { name: 'caption', phase: 1, seconds: 0.9 },
    { name: 'wake-edge', phase: 1, seconds: Number(process.argv[6] ?? 2.1) },
    { name: 'finale', phase: 3, seconds: 3.0 },
  ].filter(target => !process.argv[5] || process.argv[5] === target.name);
  const captured = new Set();
  const entered = new Map();
  const deadline = Date.now() + 160000;
  while (captured.size < targets.length && Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const perf = window.__perf;
      if (!perf?.update.count) return null;
      return { phase: perf.phase[(perf.update.count - 1) % perf.capacity], now: performance.now() };
    });
    if (state) {
      if (!entered.has(state.phase)) entered.set(state.phase, state.now);
      for (const target of targets) {
        if (captured.has(target.name) || state.phase !== target.phase) continue;
        if (state.now - entered.get(state.phase) < target.seconds * 1000) continue;
        await page.screenshot({ path: join(directory, `${prefix}-${target.name}.png`) });
        captured.add(target.name);
      }
      if (state.phase !== 0) entered.delete(0);
      if (state.phase !== 1) entered.delete(1);
    }
    await page.waitForTimeout(100);
  }
  const result = { captured: [...captured], errors };
  console.log(JSON.stringify(result));
  if (captured.size !== targets.length || errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}

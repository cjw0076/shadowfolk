// Run against built dist via a separately started, loopback-only Vite preview.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const url = process.argv[2] ?? 'https://127.0.0.1:4173/?demo&perf';
const output = process.argv[3] ?? '/tmp/codex-quest-runtime/browser.json';
const seconds = Number(process.argv[4] ?? 60);
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  const errors = [], warnings = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); if (msg.type() === 'warning') warnings.push(msg.text()); });
  await page.addInitScript(() => {
    // Observe actual renderer submissions separately from the CPU update timer.
    window.__gl = {};
    for (const name of ['texImage2D', 'texSubImage2D', 'generateMipmap']) {
      const original = WebGL2RenderingContext.prototype[name];
      window.__gl[name] = { count: 0, totalMs: 0 };
      WebGL2RenderingContext.prototype[name] = function (...args) {
        const started = performance.now();
        try { return original.apply(this, args); }
        finally { const sample = window.__gl[name]; sample.count++; sample.totalMs += performance.now() - started; }
      };
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__perf?.update.count > 60, { timeout: 60000 });
  await page.mouse.click(1100, 700); // user gesture unlocks audio
  await page.evaluate(() => {
    const p = window.__perf;
    for (const value of [p.update, p.painter, p.frameInterval, ...Object.values(p.calls)]) value.count = 0;
    for (const value of Object.values(window.__gl)) { value.count = 0; value.totalMs = 0; }
  });
  await page.waitForTimeout(seconds * 1000);
  const result = await page.evaluate(() => {
    const p = window.__perf;
    const stats = values => {
      values.sort((a, b) => a - b);
      return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, p95: values[Math.ceil(values.length * .95) - 1] ?? null, max: values.at(-1) ?? null };
    };
    const read = sample => Array.from(sample.values.slice(0, Math.min(sample.count, p.capacity)));
    const phases = {};
    for (let phase = 0; phase < 4; phase++) {
      const updates = [], painters = [];
      for (let i = 0; i < Math.min(p.update.count, p.capacity); i++) if (p.phase[i] === phase) { updates.push(p.update.values[i]); painters.push(p.painter.values[i]); }
      phases[phase] = { update: stats(updates), painter: stats(painters) };
    }
    return {
      url: location.href, title: document.title, canvasCount: document.querySelectorAll('canvas').length,
      overlay: !!document.querySelector('vite-error-overlay'), capacity: p.capacity, totalFrames: p.update.count,
      update: stats(read(p.update)), painter: stats(read(p.painter)), frameInterval: stats(read(p.frameInterval)), phases,
      calls: Object.fromEntries(Object.entries(p.calls).map(([name, sample]) => [name, stats(read(sample))])), gl: window.__gl,
    };
  });
  await page.screenshot({ path: output.replace(/\.json$/, '.png') });
  Object.assign(result, { cpuRate: 4, seconds, viewport: { width: 1280, height: 800 }, errors, warnings, screenshot: output.replace(/\.json$/, '.png') });
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length || result.overlay || !result.totalFrames || !result.canvasCount) process.exitCode = 1;
} finally { await browser.close(); }

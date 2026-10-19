import { build } from 'esbuild';
import { chromium } from 'playwright';
const bundle = await build({ entryPoints: ['tools/check-runtime.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'esnext', write: false, logLevel: 'warning' });
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/__check-runtime.bundle.mjs', route => route.fulfill({
    contentType: 'text/javascript', body: bundle.outputFiles[0].text,
  }));
  await page.goto(process.argv[2] ?? 'https://127.0.0.1:4173/?demo', { waitUntil: 'networkidle' });
  await page.mouse.click(1100, 700);
  const result = await page.evaluate(async () => {
    if (window.__perf !== undefined) throw new Error('timings should be absent without ?perf');
    return (await import('/__check-runtime.bundle.mjs')).run();
  });
  console.log(result.join('\n'));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: no page errors and no window.__perf without flag');
} finally { await browser.close(); }

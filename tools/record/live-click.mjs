// Open a page, click a point after a wait, and screenshot: node tools/record/live-click.mjs url out.png x y
import { chromium } from 'playwright';
const [url, out, x, y] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const logs = []; page.on('pageerror', (e) => logs.push('pageerror ' + e)); page.on('console', (m) => { if (m.type() !== 'debug') logs.push(m.type() + ' ' + m.text().slice(0, 160)); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(8000);
await page.mouse.click(+x, +y);
await page.waitForTimeout(3000);
await page.screenshot({ path: out });
console.log(logs.slice(-8).join('\n'));
await browser.close();

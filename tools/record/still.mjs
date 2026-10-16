// One still of a page state (no capture mode): node tools/record/still.mjs url out.png [waitMs]
import { chromium } from 'playwright';
const [url, out, wait = '6000'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push('pageerror ' + String(e).slice(0, 200)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
console.log(JSON.stringify(logs.filter((l) => /uikit|font|parse|style|error/i.test(l)).slice(0, 8), null, 1));
await browser.close();

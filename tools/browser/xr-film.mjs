// Managed browser, capture mode: step exact frames and screenshot the app frame.
// env: FILM_DIR, FILM_N, FILM_FPS (30), FILM_START (index offset), FILM_WARM (steps before filming)
// Stops before the 110 s lease and reports where to resume ({ warmLeft } or { stoppedAt }).
import { mkdirSync } from 'node:fs';
export default async function run({ page, frame }) {
  const target = frame ?? page;
  const dir = process.env.FILM_DIR, n = Number(process.env.FILM_N ?? 30), fps = Number(process.env.FILM_FPS ?? 30);
  const start = Number(process.env.FILM_START ?? 0);
  let warm = Number(process.env.FILM_WARM ?? 0);
  mkdirSync(dir, { recursive: true });
  const began = Date.now();
  const late = () => Date.now() - began > 90000;
  const step = () => Promise.race([target.evaluate((d) => window.__capture.step(d), 1 / fps), new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  // Film-clean view: emulator dev UI and the editor shell's switcher hidden.
  await target.evaluate(() => {
    for (const el of document.querySelectorAll('body > div > div')) {
      if (getComputedStyle(el).zIndex === '5') el.style.display = 'none';
    }
  });
  if (frame) await page.addStyleTag({ content: '.workspace-view-switcher{display:none!important}' }).catch(() => {});
  while (warm > 0) {
    if (late()) return { warmLeft: warm, done: start };
    await step();
    warm--;
  }
  const el = await target.frameElement().catch(() => null);
  const captureStart = await target.evaluate(() => window.__capture.time);
  for (let i = 0; i < n; i++) {
    if (late()) return { stoppedAt: start + i, done: start + i, warmLeft: 0, t0: captureStart };
    await step();
    const path = `${dir}/f${String(start + i).padStart(5, '0')}.png`;
    if (el) await el.screenshot({ path, scale: 'device' }); else await page.screenshot({ path, scale: 'device' });
  }
  return { done: start + n, warmLeft: 0, t0: captureStart, seconds: (Date.now() - began) / 1000 };
}

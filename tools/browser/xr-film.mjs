// Managed browser, capture mode: step exact frames and screenshot the app frame.
// env: FILM_DIR, FILM_N, FILM_FPS (30), FILM_START (index offset), FILM_WARM (steps before filming)
import { mkdirSync } from 'node:fs';
export default async function run({ page, frame }) {
  const target = frame ?? page;
  const dir = process.env.FILM_DIR, n = Number(process.env.FILM_N ?? 30), fps = Number(process.env.FILM_FPS ?? 30);
  const start = Number(process.env.FILM_START ?? 0), warm = Number(process.env.FILM_WARM ?? 0);
  mkdirSync(dir, { recursive: true });
  const step = () => Promise.race([target.evaluate((d) => window.__capture.step(d), 1 / fps), new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  for (let i = 0; i < warm; i++) await step();
  const el = await target.frameElement().catch(() => null);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    if (Date.now() - t0 > 95000) return { stoppedAt: start + i, reason: 'lease' };
    await step();
    const path = `${dir}/f${String(start + i).padStart(5, '0')}.png`;
    if (el) await el.screenshot({ path }); else await page.screenshot({ path });
  }
  return { done: start + n, seconds: (Date.now() - t0) / 1000, t: await target.evaluate(() => window.__capture.time) };
}

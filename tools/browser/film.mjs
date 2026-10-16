// Screenshot the managed page repeatedly (env FILM_DIR, FILM_N, FILM_DT ms) and log the theater phase per frame.
import { mkdirSync } from 'node:fs';
export default async function run({ page, frame }) {
  const dir = process.env.FILM_DIR ?? '/tmp/film';
  const n = Number(process.env.FILM_N ?? 20), dt = Number(process.env.FILM_DT ?? 1000);
  mkdirSync(dir, { recursive: true });
  const target = frame ?? page;
  const log = [];
  for (let i = 0; i < n; i++) {
    const st = await target.evaluate(() => { const th = window.__theater; return th && { ph: th.phase, t: +th.phaseTime.toFixed(2), step: th.step, wall: th.wall.residents?.map((r) => r.id).join(','), mode: th.mode, lit: +th.lit.toFixed(2) }; });
    await page.screenshot({ path: `${dir}/f${String(i).padStart(3, '0')}.png` });
    log.push({ i, ...st });
    await page.waitForTimeout(dt);
  }
  return log;
}

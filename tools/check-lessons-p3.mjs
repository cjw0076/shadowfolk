import { chromium } from 'playwright';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const browser = await chromium.launch({ args: ['--ignore-certificate-errors', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const url = new URL(base);
  url.search = '?capture&demo&first=dog&noJourney';
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater?.baked, null, { timeout: 60000 });
  const result = await page.evaluate(async () => {
    const theater = window.__theater;
    for (let frame = 0; frame < 30 && !theater.placed; frame++) await window.__capture.step(0.05);
    const lessons = [];
    for (const id of ['dog', 'heron', 'crab', 'rabbit', 'peacock', 'butterfly', 'stag', 'snail']) {
      const index = theater.baked.findIndex(target => target.def.id === id);
      theater.order[0] = index;
      theater.step = 0;
      theater.enter(1);
      let fired = false;
      for (let frame = 0; frame < 130 && theater.lessonResolvedAt < 0; frame++) {
        await window.__capture.step(0.05);
        fired ||= theater.journeyGestureState?.[theater.lessonAbility] === true;
      }
      lessons.push({ id, ability: theater.lessonAbility, resolvedAt: theater.lessonResolvedAt, fired });
    }
    const dog = theater.baked.findIndex(target => target.def.id === 'dog');
    theater.order[0] = dog;
    theater.step = 0;
    theater.demo = false;
    theater.enter(1);
    theater.phaseTime = 9.9;
    theater.journeyGestureState = null;
    theater.wake(theater.baked[dog], theater.stencils[dog], 20);
    const beforeTimeout = theater.lessonResolvedAt;
    theater.phaseTime = 10.05;
    theater.wake(theater.baked[dog], theater.stencils[dog], 20.15);
    const skipped = { at: theater.lessonResolvedAt, abilities: [...(theater.saved.lessonSkipped ?? [])] };
    theater.enter(1);
    theater.phaseTime = 1.6;
    theater.journeyGestureState = { bark: true };
    theater.wake(theater.baked[dog], theater.stencils[dog], 25);
    const reoffered = { at: theater.lessonResolvedAt, abilities: [...(theater.saved.lessonSkipped ?? [])] };
    return { lessons, beforeTimeout, skipped, reoffered, errors: [...theater.reported] };
  });
  if (errors.length || result.errors.length || result.lessons.length !== 8
    || result.lessons.some(lesson => lesson.resolvedAt < 1.35 || lesson.resolvedAt > 6 || !lesson.fired)
    || result.beforeTimeout >= 0 || result.skipped.at < 10 || !result.skipped.abilities.includes('bark')
    || result.reoffered.at < 0 || result.reoffered.abilities.includes('bark')) {
    throw new Error(`Lesson cases failed: ${JSON.stringify({ result, errors })}`);
  }
  console.log(`PASS: eight ability lessons ${result.lessons.map(lesson => `${lesson.ability}:${lesson.resolvedAt.toFixed(2)}s/${lesson.fired}`).join(' ')}; 10s skip persists and re-offer clears it`);
} finally { await browser.close(); }

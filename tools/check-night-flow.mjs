import { chromium } from 'playwright';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const nights = Number(process.env.NIGHT_FLOW_NIGHTS ?? 3);
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.text().startsWith('NIGHT')) console.log(message.text()); });
  const url = new URL(base);
  url.search = '?capture&demo&day=20378';
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater?.baked, null, { timeout: 60000 });
  const result = await page.evaluate(async count => {
    const theater = window.__theater;
    const transitions = [];
    const wakes = Array.from({ length: count }, () => []);
    const lessons = Array.from({ length: count }, () => []);
    const journeys = [];
    const finales = [];
    const invents = [];
    let previousPhase = theater.phase;
    let previousStep = theater.step;
    for (let frame = 0; frame < count * 2600 && invents.length < count; frame++) {
      await window.__capture.step(0.05);
      const night = theater.saved.nights;
      if (theater.phase !== previousPhase) {
        transitions.push({ frame, night, phase: theater.phase, step: theater.step });
        if (theater.phase === 1 && night < count) wakes[night].push(theater.baked[theater.order[theater.step]].def.id);
        if (theater.phase === 5) journeys.push({ frame, night, count: theater.journey?.plan.obstacles.length });
        if (theater.phase === 3) finales.push({ frame, night });
        if (theater.phase === 4) {
          invents.push({ frame, night });
          console.log(`NIGHT ${night} reached Invent at frame ${frame}`);
        }
      }
      if (theater.phase === 1 && theater.lessonResolvedAt >= 0 && night < count) {
        const step = theater.step;
        if (!lessons[night].some(value => value.step === step))
          lessons[night].push({ step, ability: theater.lessonAbility, at: theater.lessonResolvedAt });
      }
      previousPhase = theater.phase;
      previousStep = theater.step;
    }
    return { wakes, lessons, journeys, finales, invents, transitions,
      saved: { ...theater.saved }, phase: theater.phase, step: theater.step, previousStep,
      errors: [...theater.reported] };
  }, nights);
  if (errors.length || result.errors.length || result.invents.length !== nights
    || result.wakes.some(woken => woken.length !== 5)
    || result.lessons.some(learned => learned.length !== 5 || learned.some(value => value.at > 6))
    || result.journeys.length !== nights || result.finales.length !== nights
    || result.journeys.some((entry, index) => entry.night !== index + 1 || entry.count < 3)
    || result.finales.some((entry, index) => entry.night !== index + 1)
    || result.invents.some((entry, index) => entry.night !== index + 1)) {
    throw new Error(`Night flow stalled: ${JSON.stringify({ result, errors })}`);
  }
  for (let night = 0; night < nights; night++) {
    console.log(`PASS: night ${night + 1} ${result.wakes[night].join('→')} + ${result.lessons[night].length} lessons → ${result.journeys[night].count} obstacles → Finale → Invent`);
  }
} finally { await browser.close(); }

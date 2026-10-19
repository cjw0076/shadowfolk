import { chromium } from 'playwright';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const only = Number(process.env.JOURNEY_NIGHT ?? 0);
const nights = only ? [only] : [1, 2, 3, 4, 5, 6];
const oneHand = process.env.JOURNEY_ONE_HAND === '1';
const obstacles = process.env.JOURNEY_OBSTACLES ?? '';
const browser = await chromium.launch({ args: [
  '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
] });
try {
  for (const night of nights) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const url = new URL(base);
    url.search = `?capture&journeyOnly&journey&demo&day=20378&night=${night}`
      + (oneHand ? '&demoOneHand' : '') + (obstacles ? `&obstacles=${obstacles}` : '');
    await page.goto(url.toString(), { waitUntil: 'load' });
    await page.waitForFunction(() => window.__capture && window.__theater?.journey, null, { timeout: 60000 });
    const result = await page.evaluate(async () => {
      const theater = window.__theater;
      const journey = theater.journey;
      let frames = 0;
      const solves = [];
      for (; frames < 2400 && !journey.completed; frames++) {
        await window.__capture.step(1 / 20);
        if (journey.event?.kind === 'solve') solves.push({ index: journey.index,
          kind: journey.event.obstacle, wait: +journey.wait.toFixed(2), form: theater.journeyInput.formId,
          gesture: journey.plan.obstacles[journey.index]?.ability });
      }
      return { frames, seconds: +(frames / 20).toFixed(2), completed: journey.completed,
        states: [...journey.states], index: journey.index,
        solves,
        obstacles: journey.plan.obstacles.map((obstacle) => obstacle.kind), spark: { ...journey.spark },
        saved: JSON.parse(localStorage.getItem('shadow-theater.v1') ?? '{}'),
        errors: [...theater.reported], };
    });
    if (errors.length || result.errors.length || !result.completed || result.solves.some((solve) => solve.wait >= 12)) {
      throw new Error(`Night ${night} stalled: ${JSON.stringify({ result, errors })}`);
    }
    if (night === 1) {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__theater?.saved, null, { timeout: 60000 });
      const restored = await page.evaluate(() => ({ ...window.__theater.saved }));
      const counts = (value) => Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
      if (restored.journeysCompleted !== 1
        || JSON.stringify(counts(restored.abilityUses)) !== JSON.stringify(counts(result.saved.abilityUses))) {
        throw new Error(`Journey save did not round-trip: ${JSON.stringify({ restored, original: result.saved })}`);
      }
    }
    console.log(`PASS: night ${night} ${result.obstacles.join('→')} ${result.seconds}s, ${result.index}/${result.states.length} cleared ${JSON.stringify(result.solves)}`);
    await page.close();
  }
} finally { await browser.close(); }

import { chromium } from 'playwright';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const browser = await chromium.launch({ args: ['--ignore-certificate-errors', '--enable-unsafe-swiftshader'] });
try {
  for (const enabled of [false, true]) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const url = new URL(base);
    url.search = `?capture&demo&day=20378${enabled ? '&journey' : ''}`;
    await page.goto(url.toString(), { waitUntil: 'load' });
    await page.waitForFunction(() => window.__capture && window.__theater, null, { timeout: 60000 });
    const result = await page.evaluate(async () => {
      const theater = window.__theater;
      for (let frame = 0; frame < 20 && !theater.placed; frame++) await window.__capture.step(0.05);
      theater.step = 4;
      theater.enter(1);
      theater.phaseTime = 3.17;
      await window.__capture.step(0.05);
      return { phase: theater.phase, night: theater.saved.nights,
        count: theater.journey?.plan.obstacles.length ?? 0,
        abilities: theater.journey?.plan.obstacles.map((obstacle) => obstacle.ability) ?? [],
        errors: [...theater.reported] };
    });
    if (errors.length || result.errors.length || result.night !== 1
      || result.phase !== (enabled ? 5 : 3)
      || enabled && (result.count !== 3 || !result.abilities.includes('fan'))
      || !enabled && result.count !== 0) {
      throw new Error(`Journey gate handoff failed: ${JSON.stringify({ enabled, result, errors })}`);
    }
    console.log(`PASS: final wake → ${enabled ? 'Journey (3 obstacles, newcomer fan)' : 'Finale (default gate off)'}`);
    await page.close();
  }
} finally { await browser.close(); }

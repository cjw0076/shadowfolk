import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const STORE_KEY = 'shadow-theater.v1';
const SEED_MARKER = '__codex21_crossing_seeded';
const STEP_SECONDS = 0.05;
const CHUNK_FRAMES = 120;
const MAX_NIGHT_FRAMES = 6_000;
const NIGHT_COUNT = 8;
const SOLVER_STARS = 2;
const SOLVER_HOME_RATE = 0.75;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function urlFor(parameters) {
  const url = new URL(BASE);
  url.search = new URLSearchParams(parameters).toString();
  return url.toString();
}

function watchErrors(page, label, errors) {
  page.on('pageerror', (error) => errors.push(`${label} pageerror: ${error.stack ?? error}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${label} console.error: ${message.text()}`);
  });
}

function assertNoErrors(errors, where) {
  if (errors.length) throw new Error(`${where}: ${errors.slice(0, 12).join('\n')}`);
}

async function seededContext(browser, initialSave) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(({ key, marker, serializedSave }) => {
    if (sessionStorage.getItem(marker) === '1') return;
    localStorage.removeItem(key);
    if (serializedSave !== null) localStorage.setItem(key, serializedSave);
    sessionStorage.setItem(marker, '1');
  }, {
    key: STORE_KEY,
    marker: SEED_MARKER,
    serializedSave: initialSave === null ? null : JSON.stringify(initialSave),
  });
  return context;
}

async function openPage(context, parameters, label, errors) {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  watchErrors(page, label, errors);
  await page.goto(urlFor(parameters), { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__capture?.step === 'function'
    && typeof window.__capture?.state === 'function'
    && window.__theater?.crossing && window.__theater?.saved?.v3, null, { timeout: 60_000 });
  return page;
}

async function snapshot(page) {
  return page.evaluate(() => {
    let persisted = null;
    try {
      persisted = JSON.parse(localStorage.getItem('shadow-theater.v1') ?? 'null');
    } catch {}
    const theater = window.__theater;
    const state = window.__capture.state();
    const image = theater.moon?.mesh?.material?.map?.image ?? theater.moon?.canvas;
    const context = image?.getContext?.('2d');
    let moonSignature = null;
    if (context && image.width > 0 && image.height > 0) {
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index++) {
        hash ^= pixels[index];
        hash = Math.imul(hash, 16777619);
      }
      moonSignature = `${image.width}x${image.height}:${(hash >>> 0).toString(16)}`;
    }
    return {
      captureTime: window.__capture.time,
      phase: state.phase,
      placed: theater.placed,
      crossing: state.crossing ? { ...state.crossing } : null,
      memorySave: JSON.parse(JSON.stringify(theater.saved)),
      persisted,
      moonPhase: theater.moon?.phase ?? null,
      moonScale: theater.moon?.mesh?.scale?.x ?? null,
      moonQueen: theater.moon?.queen ?? null,
      moonSignature,
    };
  });
}

async function advance(page, frames) {
  await page.evaluate(async ({ frameCount, dt }) => {
    for (let frame = 0; frame < frameCount; frame++) await window.__capture.step(dt);
  }, { frameCount: frames, dt: STEP_SECONDS });
}

async function checkPrologue(browser, errors) {
  const context = await seededContext(browser, null);
  try {
    const page = await openPage(context, {
      capture: '', demo: '', seed: '21021',
    }, 'prologue', errors);
    const result = await page.evaluate(async ({ maxFrames, dt }) => {
      let prologueStart = null;
      let wickHomeSeconds = null;
      let progress = null;
      let state = null;
      let elapsedFrames = 0;
      for (; elapsedFrames < maxFrames; elapsedFrames++) {
        state = window.__capture.state();
        const theater = window.__theater;
        if (state.phase === 'prologue' && theater.placed && prologueStart === null) {
          prologueStart = window.__capture.time;
        }
        if (prologueStart !== null && wickHomeSeconds === null
          && state.crossing?.night === 0 && state.crossing.home >= 1) {
          wickHomeSeconds = window.__capture.time - prologueStart;
        }
        progress = theater.saved.v3;
        if (wickHomeSeconds !== null && progress.prologue === false && progress.night === 1) break;
        await window.__capture.step(dt);
      }
      return {
        frames: elapsedFrames,
        phase: state?.phase ?? null,
        crossing: state?.crossing ?? null,
        wickHomeSeconds,
        progress: progress ? JSON.parse(JSON.stringify(progress)) : null,
      };
    }, { maxFrames: 1_200, dt: STEP_SECONDS });

    assert(result.wickHomeSeconds !== null,
      `prologue Wick never reached home: ${JSON.stringify(result)}`);
    assert(result.wickHomeSeconds < 30,
      `prologue Wick home took ${result.wickHomeSeconds.toFixed(2)}s (target <30s)`);
    assert(result.progress?.prologue === false && result.progress?.night === 1,
      `prologue did not advance to night 1: ${JSON.stringify(result.progress)}`);
    assertNoErrors(errors, 'prologue');
    console.log(`PASS: prologue Wick home in ${result.wickHomeSeconds.toFixed(2)}s; save advances to night 1`);
  } finally {
    await context.close();
  }
}

function currentProgress(state) {
  return state.persisted?.v3 ?? state.memorySave?.v3 ?? null;
}

async function runNight(page, night, expectedPlayed, beforeFireflies, previousMoon, errors) {
  let frames = 0;
  let state = await snapshot(page);
  const startProgress = currentProgress(state);
  assert(startProgress?.night === night,
    `night ${night} started with v3.night=${startProgress?.night ?? 'missing'}`);
  assert(startProgress.prologue === false,
    `night ${night} unexpectedly returned to the prologue`);
  assert(state.moonSignature, `night ${night} could not inspect the paper moon texture`);
  if (previousMoon !== null) {
    assert(Math.abs(state.moonPhase - previousMoon) < 1e-9,
      `night ${night} did not restore the saved moon phase (${state.moonPhase} vs ${previousMoon})`);
  }

  while (frames < MAX_NIGHT_FRAMES) {
    const savedProgress = state.persisted?.v3;
    if (state.crossing?.night === night && state.crossing.finished
      && state.crossing.stars >= SOLVER_STARS
      && savedProgress?.night === night + 1
      && savedProgress.nightsPlayed === expectedPlayed + 1) break;
    const batch = Math.min(CHUNK_FRAMES, MAX_NIGHT_FRAMES - frames);
    await advance(page, batch);
    frames += batch;
    state = await snapshot(page);
    assertNoErrors(errors, `night ${night}`);
  }

  const progress = state.persisted?.v3;
  const crossing = state.crossing;
  assert(frames < MAX_NIGHT_FRAMES,
    `night ${night} did not complete within ${MAX_NIGHT_FRAMES * STEP_SECONDS}s: ${JSON.stringify(state)}`);
  assert(crossing?.night === night && crossing.finished,
    `night ${night} did not reach the Home beat: ${JSON.stringify(crossing)}`);
  assert(crossing.stars >= SOLVER_STARS,
    `night ${night} earned ${crossing.stars} stars; requires at least ${SOLVER_STARS}`);
  assert(crossing.total > 0 && crossing.home / crossing.total >= SOLVER_HOME_RATE,
    `night ${night} home rate ${crossing.home}/${crossing.total} is below ${SOLVER_HOME_RATE}`);
  assert(progress?.night === night + 1 && progress.nightsPlayed === expectedPlayed + 1,
    `night ${night} save did not advance: ${JSON.stringify(progress)}`);
  assert(Array.isArray(progress.best) && progress.best.length === 9
    && progress.best[night] >= SOLVER_HOME_RATE,
  `night ${night} best score was not persisted: ${JSON.stringify(progress?.best)}`);
  assert(progress.fireflies === beforeFireflies + crossing.home,
    `night ${night} fireflies mismatch: saved ${progress.fireflies}, expected ${beforeFireflies + crossing.home}`);
  assert(state.moonSignature && state.moonPhase > previousMoon,
    `night ${night} moon did not brighten after a saved best score`);
  assertNoErrors(errors, `night ${night}`);

  return {
    night,
    frames,
    simulatedSeconds: Number((frames * STEP_SECONDS).toFixed(2)),
    home: crossing.home,
    total: crossing.total,
    stars: crossing.stars,
    best: progress.best[night],
    fireflies: progress.fireflies,
    nextNight: progress.night,
    moonPhase: state.moonPhase,
    moonSignature: state.moonSignature,
  };
}

async function checkLegacyCampaign(browser, errors) {
  const legacySave = {
    nights: 2,
    woken: {},
    order: [],
  };
  const context = await seededContext(browser, legacySave);
  try {
    const page = await openPage(context, {
      capture: '', demo: '', seed: '21021',
    }, 'campaign night 1', errors);
    let state = await snapshot(page);
    const migrated = state.memorySave?.v3;
    assert(migrated?.night === 1 && migrated.prologue === false,
      `legacy save did not migrate to v3 night 1: ${JSON.stringify(migrated)}`);
    assert(Array.isArray(migrated.best) && migrated.best.length === 9,
      `legacy migration did not initialize nine best scores: ${JSON.stringify(migrated)}`);
    const initialMoon = state.moonPhase;
    assert(state.moonSignature, 'legacy campaign could not inspect the initial moon texture');
    console.log('PASS: legacy save migrates to v3 night 1 without replaying the prologue');

    const nights = [];
    let previousMoon = initialMoon;
    let expectedPlayed = migrated.nightsPlayed;
    let fireflies = migrated.fireflies;
    for (let night = 1; night <= NIGHT_COUNT; night++) {
      if (night > 1) {
        await page.goto(urlFor({
          capture: '', demo: '', night: String(night), seed: String(21_021 + night),
        }), { waitUntil: 'load' });
        await page.waitForFunction(() => typeof window.__capture?.step === 'function'
          && window.__theater?.crossing && window.__theater?.saved?.v3, null, { timeout: 60_000 });
        state = await snapshot(page);
      }

      const prior = currentProgress(state);
      assert(prior?.night === night,
        `campaign arrived at night ${night} with save night ${prior?.night ?? 'missing'}`);
      fireflies = prior.fireflies;
      const nightResult = await runNight(page, night, expectedPlayed, fireflies, previousMoon, errors);
      nights.push(nightResult);
      expectedPlayed++;
      fireflies = nightResult.fireflies;
      previousMoon = nightResult.moonPhase;
      console.log(`PASS: night ${night} ${nightResult.home}/${nightResult.total} home, ${nightResult.stars} stars, ${fireflies} fireflies`);
    }

    // Night 8 now has a 30 s Home/Finale beat. Let it persist completion before
    // checking the next daily night, whose moon returns to its normal corner form.
    await advance(page, 660);
    state = await snapshot(page);
    assert(state.persisted?.v3?.complete === true,
      `night 8 ending did not complete before reload: ${JSON.stringify(state)}`);
    await page.goto(urlFor({ capture: '', demo: '', night: '9', seed: '21030' }), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__capture?.state === 'function'
      && window.__theater?.saved?.v3, null, { timeout: 60_000 });
    state = await snapshot(page);
    const finalProgress = state.persisted?.v3;
    assert(finalProgress?.night === 9 && finalProgress.nightsPlayed === NIGHT_COUNT,
      `eight-night campaign did not persist night 9: ${JSON.stringify(finalProgress)}`);
    assert(finalProgress.fireflies === fireflies,
      `fireflies did not survive reload: ${finalProgress.fireflies} vs ${fireflies}`);
    assert(finalProgress.complete === true,
      `ending completion did not survive reload: ${JSON.stringify(finalProgress)}`);
    assert(state.moonScale === 1 && state.moonQueen === true
      && Number.isFinite(state.moonPhase) && state.moonPhase >= 0 && state.moonPhase <= 1,
    `daily moon did not return to its corner form with the Queen: ${JSON.stringify(state)}`);
    assertNoErrors(errors, 'legacy campaign and reload');
    return { nights, finalProgress, moonSignature: state.moonSignature };
  } finally {
    await context.close();
  }
}

async function main() {
  const errors = [];
  const browser = await chromium.launch({ args: [
    '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=vulkan',
    '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  try {
    await checkPrologue(browser, errors);
    const campaign = await checkLegacyCampaign(browser, errors);
    assertNoErrors(errors, 'crossing browser bench');
    const report = {
      benchmark: 'codex-21-crossing-browser',
      base: BASE,
      browser: 'private Playwright Chromium',
      prologueTargetSeconds: 30,
      starsRequired: SOLVER_STARS,
      homeRateRequired: SOLVER_HOME_RATE,
      migration: 'legacy nights>0 starts at v3 night 1 with prologue false',
      campaign,
      pageErrors: errors,
      pass: true,
    };
    const output = resolve(process.env.CROSSING_BROWSER_OUT ?? '../collab/codex/21-evidence/browser-bench.json');
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report: ${output}`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

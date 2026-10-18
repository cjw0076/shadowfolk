import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const [scenario = 'seek', rateArgument = '4', secondsArgument = '60'] = process.argv.slice(2);
const rate = Number(rateArgument);
const seconds = Number(secondsArgument);
const allowed = new Set(['idle', 'static', 'seek', 'wake', 'finale', 'invent', 'rays']);
if (!allowed.has(scenario) || ![1, 4, 6].includes(rate) || !Number.isFinite(seconds) || seconds <= 0) {
  throw new Error('Usage: node tools/browser/xr-budget.mjs <idle|static|seek|wake|finale|invent|rays> <1|4|6> <seconds>');
}
const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const output = process.env.XR_BUDGET_OUT ?? '../collab/codex/14-evidence/before';
mkdirSync(output, { recursive: true });
const name = `${scenario}-${rate}x`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
  ...(process.env.CHROME_EXTRA ?? '').split(' ').filter(Boolean)] });

const summarize = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, mean: null, p95: null, max: null };
  const round = (value) => +value.toFixed(3);
  return { count: sorted.length, mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), max: round(sorted.at(-1)) };
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((residentIds) => {
    localStorage.removeItem('shadow-theater.v1');
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
    localStorage.removeItem('@immersive-web-emulation-runtime/persistent-anchors');
    if (residentIds.length) localStorage.setItem('shadow-theater.v1', JSON.stringify({
      nights: 8, woken: Object.fromEntries(residentIds.map((id) => [id, 1])), order: residentIds,
    }));
  }, scenario === 'finale' ? ['peacock', 'rabbit', 'snail', 'fish', 'duck', 'butterfly', 'heron', 'stag'] : []);
  const url = new URL(base);
  url.search = `?perf&demo&day=20378${scenario === 'rays' ? '&rays' : ''}${scenario === 'idle' ? '&idle' : ''}`;
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__theater && window.__perf && window.IWER_DEVICE?.sessionOffered,
    null, { timeout: 60000 });
  await page.evaluate(async () => {
    const device = window.IWER_DEVICE;
    device.position.set(-0.9, 1.25, -1.19);
    const pitch = -8 * Math.PI / 180;
    const yaw = 90 * Math.PI / 180;
    device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2), Math.cos(pitch / 2) * Math.sin(yaw / 2),
      -Math.sin(pitch / 2) * Math.sin(yaw / 2), Math.cos(pitch / 2) * Math.cos(yaw / 2));
    device.primaryInputMode = 'hand';
    device.hands.left.connected = false;
    device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
  });
  try {
    await page.waitForFunction(() => {
      const theater = window.__theater;
      return theater.immersive && theater.mode === 'table' && theater.placed && !theater.settle && theater.fitUntil === 0;
    }, null, { timeout: 60000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const theater = window.__theater;
      return { immersive: theater.immersive, mode: theater.mode, placed: theater.placed,
        settling: !!theater.settle, fitUntil: theater.fitUntil,
        frame: theater.renderer.xr.getFrame?.() != null };
    }).catch(() => null);
    throw new Error('IWER table placement timed out: ' + JSON.stringify(state), { cause: error });
  }
  const setup = await page.evaluate((kind) => {
    const theater = window.__theater;
    const butterfly = theater.baked.findIndex((target) => target.def.id === 'butterfly');
    theater.order[0] = butterfly;
    theater.step = 0;
    if (kind === 'idle' || kind === 'static') {
      theater.demo = false;
      theater.demoHand.valid = false;
      theater.demoHand2.valid = false;
      theater.fresh = -1;
      theater.saved.nights = 1;
      theater.painter.caption = () => {};
    }
    if (kind === 'seek' || kind === 'rays') {
      const score = theater.matcher.score.bind(theater.matcher);
      theater.matcher.score = (mask, template) => {
        const began = performance.now();
        score(mask, template);
        if (window.__budget?.now) window.__budget.now.matcherMs += performance.now() - began;
        return 0;
      };
      if (theater.asyncMatcher) {
        const scoreAsync = theater.asyncMatcher.score.bind(theater.asyncMatcher);
        theater.asyncMatcher.score = (targetIndex) => {
          const began = performance.now();
          scoreAsync(targetIndex);
          if (window.__budget?.now) window.__budget.now.asyncDispatchMs += performance.now() - began;
          return 0;
        };
      }
    }
    if (kind === 'seek' || kind === 'rays' || kind === 'static') theater.enter(0);
    if (kind === 'wake') {
      theater.enter(1);
      const originalWake = theater.wake.bind(theater);
      theater.wake = (target, stencil, time) => {
        originalWake(target, stencil, time);
        if (theater.phase !== 1) { theater.step = 0; theater.enter(1); }
      };
    }
    if (kind === 'finale') {
      theater.enter(3);
      const originalFinale = theater.finale.bind(theater);
      theater.finale = (time) => {
        originalFinale(time);
        if (theater.phase !== 3) theater.enter(3);
      };
    }
    if (kind === 'invent') {
      theater.makeInventPose();
      theater.enter(4);
      const originalInvent = theater.invent.bind(theater);
      theater.invent = (dt, time, casters) => {
        originalInvent(dt, time, casters);
        if (theater.phase !== 4) {
          theater.inventBorn = false;
          theater.inventStable = 0;
          theater.inventPrev.area = 0;
          theater.makeInventPose();
          theater.enter(4);
        }
      };
    }
    const painter = theater.painter;
    const perf = window.__perf;
    const renderer = theater.renderer;
    const capacity = 12000;
    const frameFields = ['t', 'phase', 'updateMs', 'painterMs', 'maskMs', 'intervalMs', 'shadowMs', 'blurMs',
      'blurPasses', 'captionMs', 'wallMs', 'matcherMs', 'asyncDispatchMs',
      'driveDemoMs', 'tendStageMs', 'readHandsMs', 'demoHands'];
    const renderFields = ['t', 'renderMs', 'calls', 'triangles', 'uploadMs', 'uploads'];
    const data = {
      frames: Object.fromEntries(frameFields.map((field) => [field, new Float64Array(capacity)])),
      renders: Object.fromEntries(renderFields.map((field) => [field, new Float64Array(capacity)])),
      frameFields, renderFields, frameCount: 0, renderCount: 0, births: [],
      requestCount: 0,
      now: { shadowMs: 0, blurMs: 0, blurPasses: 0, captionMs: 0, wallMs: 0,
        matcherMs: 0, asyncDispatchMs: 0, driveDemoMs: 0, tendStageMs: 0, readHandsMs: 0 },
      uploadMs: 0, uploads: 0,
    };
    window.__budget = data;
    const worker = theater.asyncMatcher?.worker;
    if (worker) {
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        if (message.kind === 'score') data.requestCount++;
        return post(message, transfer);
      };
    }
    const beginFrame = perf.beginFrame.bind(perf);
    perf.beginFrame = () => {
      data.now.shadowMs = data.now.blurMs = data.now.blurPasses = data.now.captionMs = data.now.wallMs
        = data.now.matcherMs = data.now.asyncDispatchMs = data.now.driveDemoMs = data.now.tendStageMs
        = data.now.readHandsMs = 0;
      return beginFrame();
    };
    const endFrame = perf.endFrame.bind(perf);
    perf.endFrame = (started, phase) => {
      endFrame(started, phase);
      const index = (perf.update.count - 1) % perf.capacity;
      const slot = data.frameCount++;
      if (slot >= capacity) return;
      data.frames.t[slot] = performance.now();
      data.frames.phase[slot] = phase;
      data.frames.updateMs[slot] = perf.update.values[index];
      data.frames.painterMs[slot] = perf.painter.values[index];
      data.frames.maskMs[slot] = perf.mask.values[index];
      data.frames.intervalMs[slot] = perf.frameInterval.count
        ? perf.frameInterval.values[(perf.frameInterval.count - 1) % perf.capacity] : NaN;
      data.frames.shadowMs[slot] = data.now.shadowMs;
      data.frames.blurMs[slot] = data.now.blurMs;
      data.frames.blurPasses[slot] = data.now.blurPasses;
      data.frames.captionMs[slot] = data.now.captionMs;
      data.frames.wallMs[slot] = data.now.wallMs;
      data.frames.matcherMs[slot] = data.now.matcherMs;
      data.frames.asyncDispatchMs[slot] = data.now.asyncDispatchMs;
      data.frames.driveDemoMs[slot] = data.now.driveDemoMs;
      data.frames.tendStageMs[slot] = data.now.tendStageMs;
      data.frames.readHandsMs[slot] = data.now.readHandsMs;
      data.frames.demoHands[slot] = Number(theater.demoHand.valid) + Number(theater.demoHand2.valid);
      const pendingBirth = data.births.at(-1);
      if (pendingBirth && !pendingBirth.born && theater.inventBorn) {
        pendingBirth.born = true;
        pendingBirth.readyMs = performance.now() - pendingBirth.t;
      }
    };
    const shadow = painter.shadow.bind(painter);
    painter.shadow = (flat, blurPixels) => {
      const began = performance.now();
      const result = shadow(flat, blurPixels);
      if (data.now) data.now.shadowMs += performance.now() - began;
      return result;
    };
    const flushShadows = painter.flushShadows.bind(painter);
    painter.flushShadows = (alpha) => {
      const began = performance.now();
      const result = flushShadows(alpha);
      if (data.now) data.now.shadowMs += performance.now() - began;
      return result;
    };
    const blur = painter.sctx.drawImage.bind(painter.sctx);
    painter.sctx.drawImage = (image, x, y) => {
      const began = performance.now();
      const result = blur(image, x, y);
      if (data.now) {
        data.now.blurMs += performance.now() - began;
        data.now.blurPasses++;
      }
      return result;
    };
    const caption = painter.caption.bind(painter);
    painter.caption = (text, alpha, y) => {
      const began = performance.now();
      const result = caption(text, alpha, y);
      if (data.now) data.now.captionMs += performance.now() - began;
      return result;
    };
    const wall = theater.wall.update.bind(theater.wall);
    theater.wall.update = (time) => {
      const began = performance.now();
      const result = wall(time);
      if (data.now) data.now.wallMs += performance.now() - began;
      return result;
    };
    const driveDemo = theater.driveDemo.bind(theater);
    theater.driveDemo = (target, time) => {
      const began = performance.now();
      const result = driveDemo(target, time);
      data.now.driveDemoMs += performance.now() - began;
      return result;
    };
    const tendStage = theater.tendStage.bind(theater);
    theater.tendStage = (dt, time) => {
      const began = performance.now();
      const result = tendStage(dt, time);
      data.now.tendStageMs += performance.now() - began;
      return result;
    };
    const readHands = theater.readHands.bind(theater);
    theater.readHands = (time) => {
      const began = performance.now();
      const result = readHands(time);
      data.now.readHandsMs += performance.now() - began;
      return result;
    };
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
      const began = performance.now();
      const result = render(scene, camera);
      const slot = data.renderCount++;
      if (slot < capacity) {
        data.renders.t[slot] = performance.now();
        data.renders.renderMs[slot] = performance.now() - began;
        data.renders.calls[slot] = renderer.info.render.calls;
        data.renders.triangles[slot] = renderer.info.render.triangles;
        data.renders.uploadMs[slot] = data.uploadMs;
        data.renders.uploads[slot] = data.uploads;
      }
      data.uploadMs = 0;
      data.uploads = 0;
      return result;
    };
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const upload = prototype.texSubImage2D;
      prototype.texSubImage2D = function () {
        const began = performance.now();
        try { return Reflect.apply(upload, this, arguments); }
        finally { data.uploadMs += performance.now() - began; data.uploads++; }
      };
    }
    if (kind === 'invent') {
      const bear = theater.bear.bind(theater);
      theater.bear = (time) => {
        const began = performance.now();
        const result = bear(time);
        data.births.push({ t: performance.now(), ms: performance.now() - began, born: theater.inventBorn });
        return result;
      };
    }
    return { mode: theater.mode, xrFrameRate: renderer.xr.getSession()?.frameRate,
      residents: theater.wall.residents?.length ?? 0, demo: theater.demo, rays: !!theater.rays };
  }, scenario);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.waitForTimeout(1000);
  let tracing = true;
  let traceEvents = 0;
  const gcEvents = [];
  cdp.on('Tracing.dataCollected', ({ value }) => {
    for (const event of value) {
      traceEvents++;
      if (event.ph === 'X' && event.dur > 0 && (event.name === 'MinorGC' || event.name === 'MajorGC')) {
        gcEvents.push({ name: event.name, ms: event.dur / 1000 });
      }
    }
  });
  try {
    await cdp.send('Tracing.start', {
      categories: 'v8,disabled-by-default-v8.gc', transferMode: 'ReportEvents',
    });
  } catch {
    tracing = false;
  }
  const sampleHeap = process.env.XR_HEAP === '1';
  if (sampleHeap) {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512 });
  }
  const startedAt = await page.evaluate(() => {
    const data = window.__budget;
    data.frameCount = 0;
    data.renderCount = 0;
    data.births.length = 0;
    data.requestCount = 0;
    return performance.now();
  });
  await page.waitForTimeout(seconds * 1000);
  const endedAt = await page.evaluate(() => performance.now());
  let heapSites = [];
  if (sampleHeap) {
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const sites = new Map();
    const visit = (node) => {
      const { url, lineNumber, functionName } = node.callFrame;
      const key = `${url}:${lineNumber + 1}:${functionName}`;
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
      node.children.forEach(visit);
    };
    visit(profile.head);
    heapSites = [...sites].map(([site, bytes]) => ({ site, bytes, bytesPerSecond: Math.round(bytes / seconds) }))
      .sort((left, right) => right.bytes - left.bytes).slice(0, 30);
  }
  if (tracing) {
    const finished = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    await finished;
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const captured = await page.evaluate(() => {
    const data = window.__budget;
    const rows = (columns, fields, count) => Array.from({ length: Math.min(count, 12000) }, (_, index) =>
      Object.fromEntries(fields.map((field) => [field, columns[field][index]])));
    const theater = window.__theater;
    return { frames: rows(data.frames, data.frameFields, data.frameCount),
      renders: rows(data.renders, data.renderFields, data.renderCount), births: data.births,
      phase: theater.phase, mode: theater.mode,
      residents: theater.wall.residents?.length ?? 0, invented: theater.saved.invented?.length ?? 0,
      requestCount: data.requestCount };
  });
  const trim = (rows) => rows.filter((row) => row.t >= startedAt && row.t <= endedAt);
  const frames = trim(captured.frames);
  const renders = trim(captured.renders);
  const metrics = Object.fromEntries(['updateMs', 'painterMs', 'maskMs', 'intervalMs', 'shadowMs', 'blurMs', 'blurPasses',
    'captionMs', 'wallMs', 'matcherMs', 'asyncDispatchMs', 'driveDemoMs', 'tendStageMs', 'readHandsMs', 'demoHands']
    .map((key) => [key, summarize(frames.map((frame) => frame[key]))]));
  for (const key of ['renderMs', 'uploadMs', 'uploads', 'calls', 'triangles']) {
    metrics[key] = summarize(renders.map((render) => render[key]));
  }
  metrics.rasterMs = summarize(frames.map((frame) => Math.max(0, frame.shadowMs - frame.blurMs)));
  const result = { scenario, rate, requestedSeconds: seconds, elapsedSeconds: +(endedAt - startedAt).toFixed(3) / 1000,
    setup, metrics, longestFrames: [...frames].sort((a, b) => (b.intervalMs ?? 0) - (a.intervalMs ?? 0)).slice(0, 10),
    births: captured.births, matcherRequests: captured.requestCount,
    matcherRequestsPerSecond: +(captured.requestCount / seconds).toFixed(2),
    endState: { phase: captured.phase, mode: captured.mode,
      residents: captured.residents, invented: captured.invented },
    gc: { traceEvents, count: gcEvents.length, pausesMs: summarize(gcEvents.map((event) => event.ms)),
      longest: gcEvents.sort((a, b) => b.ms - a.ms).slice(0, 10) }, heapSites, errors };
  if (scenario === 'seek') {
    result.still = `${output}/${name}.png`;
    await page.screenshot({ path: result.still });
  }
  writeFileSync(`${output}/${name}.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${output}/${name}-frames.json.gz`, gzipSync(JSON.stringify({ frames, renders })));
  console.log(JSON.stringify({ file: `${output}/${name}.json`, result }, null, 2));
  if (setup.demo !== !['idle', 'static'].includes(scenario) || setup.mode !== 'table'
    || (scenario === 'rays') !== setup.rays || errors.length
    || frames.length < seconds * 10 || renders.length < seconds * 10 || (scenario === 'finale' && captured.residents < 8)
    || (['seek', 'wake', 'rays'].includes(scenario) && metrics.demoHands.mean < 1.8)
    || (scenario === 'invent' && !captured.births.some((birth) => birth.born))) {
    throw new Error(`Incomplete XR budget capture: ${JSON.stringify({ setup, frames: frames.length, renders: renders.length,
      births: captured.births.length, endState: result.endState, errors })}`);
  }
} finally {
  await browser.close();
}

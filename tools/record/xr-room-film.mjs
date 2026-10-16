import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { injectCase, injectLanternHand } from '../browser/xr-case.mjs';

const [selection = 'all', base = 'https://127.0.0.1:8081/', output = '../video/out/xr'] = process.argv.slice(2);
const fps = 30;
const width = 1920;
const height = 1080;
const seconds = { table: 10, pinned: 7, carry: 7, anchor: 6, wall: 6 };
const names = selection === 'all' ? Object.keys(seconds) : selection.split(',');
if (names.some((name) => !(name in seconds))) throw new Error(`Unknown shot: ${selection}`);

const tableHead = { position: [-0.9, 1.25, -1.19], yaw: 90, pitch: -8 };
const pinnedHead = { position: [-1.9, 1.25, 1.2], yaw: 90, pitch: -8 };
const savedResidents = ['peacock', 'rabbit', 'snail', 'fish', 'duck', 'butterfly', 'heron', 'stag', 'crab'];
const launchArgs = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan',
  '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_EXTRA ?? '').split(' ').filter(Boolean)];

async function setHead(page, head) {
  await page.evaluate(({ position, yaw, pitch }) => {
    const device = window.IWER_DEVICE;
    const yawRadians = yaw * Math.PI / 180;
    const pitchRadians = pitch * Math.PI / 180;
    device.position.set(...position);
    device.quaternion.set(
      Math.sin(pitchRadians / 2) * Math.cos(yawRadians / 2),
      Math.cos(pitchRadians / 2) * Math.sin(yawRadians / 2),
      -Math.sin(pitchRadians / 2) * Math.sin(yawRadians / 2),
      Math.cos(pitchRadians / 2) * Math.cos(yawRadians / 2),
    );
  }, head);
}

async function step(page) {
  let timer;
  try {
    const result = await Promise.race([
      page.evaluate((duration) => window.__capture.step(duration), 1 / fps),
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 15000); }),
    ]);
    if (result === 'timeout') throw new Error('XR capture step timed out');
  } finally {
    clearTimeout(timer);
  }
}

async function state(page) {
  return await page.evaluate(() => {
    const theater = window.__theater;
    const round = (value) => +value.toFixed(4);
    const vector = (value) => value.toArray().map(round);
    return {
      captureTime: round(window.__capture.time), immersive: theater.immersive,
      phase: theater.phase, target: theater.baked[theater.order[theater.step]]?.def.id,
      mode: theater.mode, anchored: theater.anchored, restore: theater.restore,
      lantern: vector(theater.lanternPos), screen: vector(theater.screenCentre),
      head: vector(theater.camera.getWorldPosition(new theater.anchor.constructor())),
      wallActive: theater.wall.active, residents: theater.wall.residents?.map((resident) => resident.id),
      carry: !!theater.carry, leftHandValid: theater.hands[0].valid,
      rightHandValid: theater.hands[1].valid, score: round(theater.score),
      woken: { ...theater.saved.woken },
      handSources: theater.renderer.xr.getSession()?.inputSources.filter((source) => source.hand)
        .map((source) => source.handedness) ?? [],
      scriptedHand: theater.demoHand.valid || theater.demoHand2.valid,
    };
  });
}

async function boot(page, name) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((residents) => {
    localStorage.clear();
    if (residents) localStorage.setItem('shadow-theater.v1', JSON.stringify({
      nights: 6, woken: Object.fromEntries(residents.map((id) => [id, 1])), order: residents,
    }));
  }, name === 'wall' ? savedResidents : null);
  const url = new URL(base);
  url.search = '?capture=keepdom&day=20378&first=peacock';
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater && window.IWER_DEVICE?.sessionOffered,
    null, { timeout: 60000 });
  await setHead(page, name === 'pinned' ? pinnedHead : tableHead);
  await page.evaluate(async () => {
    const device = window.IWER_DEVICE;
    device.primaryInputMode = 'hand';
    device.hands.left.connected = false;
    device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
  });
  await page.addStyleTag({ content: '[data-webxr_runtime] > div[style*="z-index: 5"]{display:none!important}' });
  let ready = false;
  for (let index = 0; index < 280; index++) {
    await step(page);
    ready = await page.evaluate((wanted) => {
      const theater = window.__theater;
      return theater.immersive && theater.mode === wanted && theater.placed && !theater.settle
        && theater.fitUntil === 0 && (wanted === 'pinned' || theater.anchored);
    }, name === 'pinned' ? 'pinned' : 'table');
    if (ready) break;
  }
  if (!ready) throw new Error(`${name} did not settle: ${JSON.stringify(await state(page))}`);
  const canvas = await page.evaluate(() => [...document.querySelectorAll('[data-webxr_runtime] canvas')]
    .map((element) => [element.width, element.height]));
  if (!canvas.length || canvas.some(([canvasWidth, canvasHeight]) => canvasWidth !== width || canvasHeight !== height)) {
    throw new Error(`H1 canvas mismatch: ${JSON.stringify(canvas)}`);
  }
  return { canvas, settled: await state(page) };
}

async function startEncoder(path) {
  const encoder = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps),
    '-c:v', 'png', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', String(fps), path], { stdio: ['pipe', 'ignore', 'pipe'] });
  let errorText = '';
  encoder.stderr.on('data', (chunk) => { errorText += chunk.toString(); });
  return {
    async frame(png) {
      if (!encoder.stdin.write(png)) await once(encoder.stdin, 'drain');
    },
    async finish() {
      encoder.stdin.end();
      const [code] = await once(encoder, 'close');
      if (code !== 0) throw new Error(`ffmpeg encoder failed: ${errorText}`);
    },
  };
}

async function soundtrack(page, start, duration, destination) {
  const wav = await page.evaluate(async ({ start, duration }) => {
    const control = window.__capture;
    const original = control.cues;
    const priorHold = original.filter((cue) => cue.kind === 'hold' && cue.t < start).at(-1);
    control.cues = original.filter((cue) => cue.t >= start && cue.t < start + duration)
      .map((cue) => ({ ...cue, t: cue.t - start }));
    if (priorHold) control.cues.unshift({ ...priorHold, t: 0 });
    try { return await control.renderAudio(duration); }
    finally { control.cues = original; }
  }, { start, duration });
  writeFileSync(destination, Buffer.from(wav, 'base64'));
}

async function film(name) {
  const directory = `${output}/${name}`;
  mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ args: launchArgs });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const metadata = { name, base, width, height, fps, seconds: seconds[name], frames: seconds[name] * fps,
    browser: 'own Playwright Chromium, ANGLE Vulkan', xr: 'IWER Meta Quest 3, living_room',
    joints: 'IWER XRHand joint registry, not scripted demo hands', events: [], samples: [], errors };
  const silentVideo = `${directory}/silent.mp4`;
  try {
    metadata.setup = await boot(page, name);
    const start = await page.evaluate(() => window.__capture.time);
    metadata.captureStart = start;
    const encoder = await startEncoder(silentVideo);
    let carryMove;
    let woke = false;
    let carried = false;
    let restored = false;
    for (let frame = 0; frame < metadata.frames; frame++) {
      const elapsed = frame / fps;
      const baseHead = name === 'pinned' ? pinnedHead : tableHead;
      const head = {
        position: [baseHead.position[0] + 0.003 * Math.sin(elapsed * 1.7), baseHead.position[1] + 0.002 * Math.sin(elapsed * 1.2), baseHead.position[2]],
        yaw: baseHead.yaw + 0.3 * Math.sin(elapsed * 1.1),
        pitch: baseHead.pitch + 0.25 * Math.sin(elapsed * 1.4),
      };
      if (name === 'wall') {
        const fraction = Math.min(1, elapsed / 5.2);
        const eased = fraction * fraction * (3 - 2 * fraction);
        head.yaw -= 12 * eased;
        head.pitch += 24 * eased;
      }
      if (name === 'anchor' && frame >= 90) {
        head.position = [-0.9 + 0.003 * Math.sin(elapsed), 1.25, -0.89];
        head.yaw = 110 + 0.3 * Math.sin(elapsed);
      }
      if (name === 'anchor' && frame === 90) {
        await page.evaluate(async () => {
          const device = window.IWER_DEVICE;
          device.hands.left.connected = false;
          device.hands.right.connected = false;
          await window.__theater.renderer.xr.getSession().end();
        });
        await setHead(page, head);
        await page.waitForFunction(() => window.IWER_DEVICE.sessionOffered, null, { timeout: 30000 });
        await page.evaluate(async () => await window.IWER_DEVICE.remote.dispatch('accept_session', {}));
        metadata.events.push({ frame, action: 'session ended; head moved 30 cm and yawed 20 degrees; new session accepted; picture cut' });
      }
      await setHead(page, head);
      if ((name === 'table' && frame === 39) || (name === 'pinned' && frame === 30)) {
        const pose = await injectCase(page, { targetId: 'peacock', kind: 'wake', side: 'left' });
        metadata.events.push({ frame, action: 'IWER left-hand peacock joint pose injected', pose });
      }
      if ((name === 'table' && frame === 135) || (name === 'pinned' && frame === 115)) {
        await page.evaluate(() => { window.IWER_DEVICE.hands.left.connected = false; });
        metadata.events.push({ frame, action: 'IWER hand released' });
      }
      if (name === 'carry') {
        if (frame === 30) {
          carryMove = await page.evaluate(async () => {
            const theater = window.__theater;
            const { fitTable } = await import('/src/theater/room.ts');
            const lantern = theater.lanternPos.clone();
            const candidates = [1, -1].map((sign) => lantern.clone().addScaledVector(theater.right, sign * 0.3));
            const destination = candidates.find((point) => fitTable(theater.surfaces(), point,
              theater.fwd, theater.right, 0.44, 0.75, [0, -0.04, 0.04]));
            if (!destination) throw new Error('No 30 cm lateral table destination');
            return { from: lantern.toArray(), to: destination.toArray() };
          });
          await injectLanternHand(page, { position: carryMove.from });
          metadata.events.push({ frame, action: 'real-joint pinch picked up lantern', move: carryMove });
        } else if (frame > 30 && frame <= 120) {
          const fraction = Math.min(1, (frame - 30) / 90);
          const eased = fraction * fraction * (3 - 2 * fraction);
          const position = carryMove.from.map((value, axis) => value + (carryMove.to[axis] - value) * eased);
          await injectLanternHand(page, { position });
        } else if (frame === 122) {
          await injectLanternHand(page, { position: carryMove.to, open: true });
          metadata.events.push({ frame, action: 'real-joint fingers opened; set-down begins' });
        } else if (frame === 175) {
          await page.evaluate(() => { window.IWER_DEVICE.hands.left.connected = false; });
        }
      }
      await step(page);
      const current = await state(page);
      if (current.scriptedHand) throw new Error(`Demo puppet active in XR frame ${frame}`);
      if (!current.immersive) throw new Error(`No active XR session at frame ${frame}`);
      if (current.phase === 1) woke = true;
      if (current.carry) carried = true;
      if (name === 'anchor' && frame >= 90 && current.anchored && current.restore === 'none') restored = true;
      if (frame % 30 === 0 || frame === metadata.frames - 1 || frame === 89 || frame === 90) {
        metadata.samples.push({ frame, ...current });
      }
      await encoder.frame(await page.screenshot({ type: 'png', timeout: 120000 }));
      if (frame % 30 === 0) process.stdout.write(`${name} ${frame}/${metadata.frames}\n`);
    }
    await encoder.finish();
    const final = await state(page);
    metadata.final = final;
    if (name === 'table' && (!woke || !final.woken.peacock || !final.wallActive)) {
      throw new Error(`Table peacock did not wake and reach wall: ${JSON.stringify(final)}`);
    }
    if (name === 'pinned' && (!woke || final.mode !== 'pinned' || !final.woken.peacock)) {
      throw new Error(`Pinned peacock did not wake: ${JSON.stringify(final)}`);
    }
    const displacement = Math.hypot(...final.lantern.map((value, axis) => value - metadata.setup.settled.lantern[axis]));
    if (name === 'carry' && (!carried || final.mode !== 'table' || !final.anchored || displacement < 0.24 || displacement > 0.36)) {
      throw new Error(`Carry did not re-anchor on table: ${JSON.stringify(final)}`);
    }
    if (name === 'carry') metadata.events.push({ frame: metadata.frames - 1, action: 'table anchor renewed', displacementMetres: +displacement.toFixed(3) });
    if (name === 'anchor' && (!restored || final.mode !== 'table')) {
      throw new Error(`Anchor was not restored: ${JSON.stringify(final)}`);
    }
    if (name === 'wall' && (!final.wallActive || (final.residents?.length ?? 0) < 8)) {
      throw new Error(`Wall collection was not visible: ${JSON.stringify(final)}`);
    }
    await soundtrack(page, start, seconds[name], `${directory}/audio.wav`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', silentVideo, '-i', `${directory}/audio.wav`,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', `${directory}/shot.mp4`]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', `${directory}/shot.mp4`,
      '-vf', `fps=${10 / seconds[name]},scale=384:216,tile=5x2:nb_frames=10`,
      '-frames:v', '1', `${directory}/strip.png`]);
    unlinkSync(silentVideo);
    writeFileSync(`${directory}/metadata.json`, JSON.stringify(metadata, null, 2));
    if (errors.length) throw new Error(`Browser errors in ${name}: ${errors.join(' | ')}`);
    process.stdout.write(`${name}: ${metadata.frames} real XR frames, ${width}x${height}, ${fps} fps\n`);
  } finally {
    await browser.close();
  }
}

for (const name of names) await film(name);

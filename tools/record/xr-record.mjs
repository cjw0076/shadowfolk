import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [shotPath, outDir, base = 'https://127.0.0.1:8081/'] = process.argv.slice(2);
if (!shotPath || !outDir) throw new Error('Usage: node tools/record/xr-record.mjs shot.json outdir [baseUrl]');
const shot = JSON.parse(readFileSync(shotPath, 'utf8'));
const fps = shot.fps ?? 30;
const seconds = shot.seconds;
const frames = Math.round(seconds * fps);
const audioOnly = process.env.XR_AUDIO_ONLY === '1';
const width = shot.width ?? 1920;
const height = shot.height ?? 1080;
if (!(fps >= 20 && seconds > 0 && frames > 0)) throw new Error('XR capture needs fps >= 20 and positive seconds');
mkdirSync(`${outDir}/frames`, { recursive: true });

const first = shot.camera?.[0] ?? { t: 0, pos: [0, 1.25, 0], look: [0, 1.25, -1] };
const tableSeat = [-0.9, 1.25, -1.19];
const sourceDirection = first.look.map((value, axis) => value - first.pos[axis]);
const sourceYaw = Math.atan2(-sourceDirection[0], -sourceDirection[2]);
const rotation = Math.PI / 2 - sourceYaw;
const sine = Math.sin(rotation);
const cosine = Math.cos(rotation);
let transformPoint = (point) => {
  const offset = point.map((value, axis) => value - first.pos[axis]);
  return [tableSeat[0] + offset[0] * cosine + offset[2] * sine,
    tableSeat[1] + offset[1], tableSeat[2] - offset[0] * sine + offset[2] * cosine];
};
// Shots are authored in the browser-preview rig frame (lantern light at PREVIEW_LANTERN, paper toward -z).
// After placement, `XR_FRAME=rig` (default) maps them rigidly onto the placed XR rig, so side views stay side views.
const PREVIEW_LANTERN = [0, 0.932, -0.25];
function rigTransform(lantern, paper) {
  const dx = paper[0] - lantern[0], dz = paper[2] - lantern[2];
  const theta = Math.atan2(-dx, -dz); // yaw taking preview forward (0,0,-1) onto the XR lantern->paper direction
  const s = Math.sin(theta), c = Math.cos(theta);
  return (point) => {
    const x = point[0] - PREVIEW_LANTERN[0], y = point[1] - PREVIEW_LANTERN[1], z = point[2] - PREVIEW_LANTERN[2];
    return [lantern[0] + x * c + z * s, lantern[1] + y, lantern[2] - x * s + z * c];
  };
}
const mix = (before, after, fraction) => before.map((value, axis) => value + (after[axis] - value) * fraction);
const smooth = (fraction) => fraction * fraction * (3 - 2 * fraction);
function cameraAt(time) {
  const keys = shot.camera ?? [first];
  if (time <= keys[0].t) return keys[0];
  for (let index = 0; index < keys.length - 1; index++) {
    const before = keys[index];
    const after = keys[index + 1];
    if (time > after.t) continue;
    const fraction = smooth((time - before.t) / (after.t - before.t));
    return { pos: mix(before.pos, after.pos, fraction), look: mix(before.look, after.look, fraction) };
  }
  return keys.at(-1);
}

async function setHead(page, camera) {
  const pose = { position: transformPoint(camera.pos), look: transformPoint(camera.look) };
  await page.evaluate(({ position, look }) => {
    const direction = look.map((value, axis) => value - position[axis]);
    const yaw = Math.atan2(-direction[0], -direction[2]);
    const pitch = Math.atan2(direction[1], Math.hypot(direction[0], direction[2]));
    const device = window.IWER_DEVICE;
    // Programmatic control: otherwise the IWER DevUI render loop writes its own stale camera-rig pose back.
    if (device.controlMode !== 'programmatic') device.controlMode = 'programmatic';
    device.position.set(...position);
    device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2),
      Math.cos(pitch / 2) * Math.sin(yaw / 2), -Math.sin(pitch / 2) * Math.sin(yaw / 2),
      Math.cos(pitch / 2) * Math.cos(yaw / 2));
    device.notifyStateChange?.();
  }, pose);
  return pose;
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

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
  '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_EXTRA ?? '').split(' ').filter(Boolean)] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((storage) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage ?? {})) localStorage.setItem(key, JSON.stringify(value));
  }, shot.storage);
  const url = new URL(base);
  url.search = `?capture=keepdom&${shot.params ?? 'demo'}`;
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__capture && window.__theater && window.IWER_DEVICE?.sessionOffered,
    null, { timeout: 60000 });
  await setHead(page, cameraAt(0));
  await page.evaluate(async () => {
    const device = window.IWER_DEVICE;
    device.primaryInputMode = 'hand';
    device.hands.left.connected = false;
    device.hands.right.connected = false;
    await device.remote.dispatch('accept_session', {});
  });
  await page.addStyleTag({ content: '[data-webxr_runtime] > div[style*="z-index: 5"]{display:none!important}' });
  let ready = false;
  let preRollFrames = 0;
  for (; preRollFrames < 280; preRollFrames++) {
    await step(page);
    ready = await page.evaluate(() => {
      const theater = window.__theater;
      return theater.immersive && theater.mode === 'table' && theater.placed && theater.anchored
        && !theater.settle && theater.fitUntil === 0;
    });
    if (ready) break;
  }
  if (!ready) {
    const state = await page.evaluate(() => {
      const theater = window.__theater;
      return { immersive: theater.immersive, mode: theater.mode, placed: theater.placed, anchored: theater.anchored,
        settle: theater.settle, fitUntil: theater.fitUntil, phase: theater.phase };
    });
    throw new Error(`IWER living-room table placement did not settle: ${JSON.stringify(state)}`);
  }
  for (let index = 0; index < Math.round((shot.warmup ?? 0) * fps); index++) await step(page);
  const rig = await page.evaluate(() => {
    const theater = window.__theater;
    const worldPosition = (object) => object.getWorldPosition(new theater.anchor.constructor()).toArray();
    return {
      mode: theater.mode, anchored: theater.anchored, lantern: theater.lanternPos.toArray(),
      paper: theater.screenCentre.toArray(), head: worldPosition(theater.camera),
      wallActive: theater.wall.active,
      wall: theater.wall.fit?.point?.toArray() ?? null,
      canvas: [...document.querySelectorAll('[data-webxr_runtime] canvas')]
        .map((element) => [element.width, element.height]),
      captureTime: window.__capture.time,
    };
  });
  if ((process.env.XR_FRAME ?? 'rig') === 'rig') transformPoint = rigTransform(rig.lantern, rig.paper);
  rig.cameraFrame = process.env.XR_FRAME ?? 'rig';
  rig.sourceShot = shotPath;
  rig.sourceFirstHead = first.pos;
  rig.worldSeat = tableSeat;
  rig.sourceToRoomYawDegrees = rotation * 180 / Math.PI;
  rig.preRollFrames = preRollFrames + 1;
  writeFileSync(`${outDir}/rig.json`, JSON.stringify(rig, null, 2));
  if (rig.canvas.length === 0 || rig.canvas.some(([canvasWidth, canvasHeight]) => canvasWidth !== width || canvasHeight !== height)) {
    throw new Error(`XR canvas did not fill ${width}x${height}: ${JSON.stringify(rig.canvas)}`);
  }
  console.log(`rig: lantern=${JSON.stringify(rig.lantern)} paper=${JSON.stringify(rig.paper)} head=${JSON.stringify(rig.head)}`);
  const startTime = await page.evaluate(() => window.__capture.time);
  const startCue = await page.evaluate(() => window.__capture.cues.length);
  const began = Date.now();
  for (let frame = 0; frame < frames; frame++) {
    await setHead(page, cameraAt(frame / fps));
    await step(page);
    if (!await page.evaluate(() => window.__theater.immersive && window.__theater.mode === 'table')) {
      throw new Error(`XR table mode lost at frame ${frame}`);
    }
    if (process.env.XR_DEBUG && frame % 15 === 0) {
      const d = await page.evaluate(() => {
        const t = window.__theater, dev = window.IWER_DEVICE, r = (v) => v.toArray().map((x) => +x.toFixed(3));
        const V = t.anchor.constructor; const cam = t.camera.getWorldPosition(new V()); const dir = t.camera.getWorldDirection(new V()); return { dev: [dev.position.x, dev.position.y, dev.position.z].map((x) => +x.toFixed(3)), cam: r(cam), dir: r(dir), lantern: r(t.lanternPos), player: t.player ? r(t.player.position) : null };
      });
      process.stdout.write(`dbg ${frame} ${JSON.stringify(d)}\n`);
    }
    if (!audioOnly) await page.screenshot({ path: `${outDir}/frames/f${String(frame).padStart(5, '0')}.png`, timeout: 120000 });
    if (frame % 30 === 0) process.stdout.write(`frame ${frame}/${frames}\n`);
  }
  const frameTimeMs = (Date.now() - began) / frames;
  const wav = await page.evaluate(async ({ startTime, startCue, seconds }) => {
    const control = window.__capture;
    const original = control.cues;
    control.cues = original.slice(startCue).map((cue) => ({ ...cue, t: cue.t - startTime }));
    // A long cue can begin during warmup and still sound at frame zero.
    const queenSwell = original.slice(0, startCue).filter((cue) => cue.kind === 'play'
      && cue.arg === 'queen-swell' && startTime - cue.t < 3.5).at(-1);
    if (queenSwell) control.cues.unshift({ ...queenSwell, t: 0 });
    const priorHold = original.slice(0, startCue).filter((cue) => cue.kind === 'hold').at(-1);
    if (priorHold) control.cues.unshift({ ...priorHold, t: 0 });
    try { return await control.renderAudio(seconds); }
    finally { control.cues = original; }
  }, { startTime, startCue, seconds });
  writeFileSync(`${outDir}/audio.wav`, Buffer.from(wav, 'base64'));
  writeFileSync(`${outDir}/errors.json`, JSON.stringify(errors, null, 2));
  rig.averageCaptureFrameMs = +frameTimeMs.toFixed(1);
  rig.filmedFrames = frames;
  writeFileSync(`${outDir}/rig.json`, JSON.stringify(rig, null, 2));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps),
    '-i', `${outDir}/frames/f%05d.png`, '-i', `${outDir}/audio.wav`, '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-shortest', `${outDir}/shot.mp4`]);
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
  console.log(`done: ${outDir}/shot.mp4 frames=${frames} averageCaptureFrameMs=${rig.averageCaptureFrameMs}`);
} finally {
  await browser.close();
}

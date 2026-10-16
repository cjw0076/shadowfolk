import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const output = process.env.XR_ROOMS_VIDEO ?? '../video/out/xr-rooms';
const seats = {
  living_room: { position: [-0.9, 1.25, -1.19], yaw: 90 },
  office_small: { position: [0.55, 1.2, -0.75], yaw: 180 },
  office_large: { position: [-0.66, 1.25, 0.9], yaw: 180 },
  music_room: { position: [1.4, 1.08, -0.97], yaw: 90 },
  meeting_room: { position: [0, 1.18, -0.35], yaw: 0 },
};
const expectedModes = { living_room: 'table', office_small: 'table', office_large: 'pinned',
  music_room: 'table', meeting_room: 'table' };
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(seats);
if (names.some((name) => !seats[name])) throw new Error(`Unknown room in ${names.join(', ')}`);
const fps = 30;
const frames = 120;
const width = 1920;
const height = 1080;

async function setHead(page, head, elapsed = 0) {
  await page.evaluate(({ head, elapsed }) => {
    const device = window.IWER_DEVICE;
    const yaw = (head.yaw + 0.35 * Math.sin(elapsed * 1.1)) * Math.PI / 180;
    const pitch = (-8 + 0.25 * Math.sin(elapsed * 1.3)) * Math.PI / 180;
    device.position.set(head.position[0] + 0.003 * Math.sin(elapsed * 1.5),
      head.position[1] + 0.002 * Math.sin(elapsed), head.position[2]);
    device.quaternion.set(Math.sin(pitch / 2) * Math.cos(yaw / 2),
      Math.cos(pitch / 2) * Math.sin(yaw / 2), -Math.sin(pitch / 2) * Math.sin(yaw / 2),
      Math.cos(pitch / 2) * Math.cos(yaw / 2));
  }, { head, elapsed });
}

async function capture(name) {
  const directory = `${output}/${name}`;
  mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=vulkan',
    '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu',
    '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_EXTRA ?? '').split(' ').filter(Boolean)] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    const url = new URL(base);
    url.search = '?capture=keepdom&demo&day=20378&first=peacock';
    await page.goto(url.toString(), { waitUntil: 'load' });
    await page.waitForFunction(() => window.__capture && window.__theater && window.IWER_DEVICE?.sessionOffered,
      null, { timeout: 60000 });
    await setHead(page, seats[name]);
    await page.evaluate(async (room) => {
      const device = window.IWER_DEVICE;
      device.sem.loadDefaultEnvironment(room);
      device.primaryInputMode = 'hand';
      device.hands.left.connected = false;
      device.hands.right.connected = false;
      await device.remote.dispatch('accept_session', {});
    }, name);
    await page.addStyleTag({ content: '[data-webxr_runtime] > div[style*="z-index: 5"]{display:none!important}' });
    let ready = false;
    for (let index = 0; index < 280; index++) {
      await page.evaluate(() => window.__capture.step(1 / 30));
      ready = await page.evaluate(() => {
        const theater = window.__theater;
        return theater.immersive && theater.placed && !theater.settle && theater.fitUntil === 0;
      });
      if (ready) break;
    }
    if (!ready) throw new Error(`${name} XR placement did not settle`);
    const placedMode = await page.evaluate(() => window.__theater.mode);
    if (placedMode !== expectedModes[name]) throw new Error(`${name} placed in ${placedMode}, expected ${expectedModes[name]}`);
    let visualReady = false;
    let sideBrightness = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      const png = await page.screenshot({ type: 'png', timeout: 120000 });
      const { data, info } = await sharp(png).resize(48, 27).raw().toBuffer({ resolveWithObject: true });
      let sum = 0;
      for (let row = 5; row < 22; row++) for (const column of [2, 3, 44, 45]) {
        const pixel = (row * 48 + column) * info.channels;
        sum += (data[pixel] + data[pixel + 1] + data[pixel + 2]) / 3;
      }
      sideBrightness = sum / (17 * 4);
      if (sideBrightness >= 40) { visualReady = true; break; }
      await page.waitForTimeout(500);
    }
    if (!visualReady) throw new Error(`${name} IWER room visuals did not load; side brightness ${sideBrightness.toFixed(1)}`);
    const canvas = await page.evaluate(() => [...document.querySelectorAll('[data-webxr_runtime] canvas')]
      .map((element) => [element.width, element.height]));
    if (!canvas.length || canvas.some(([canvasWidth, canvasHeight]) => canvasWidth !== width || canvasHeight !== height)) {
      throw new Error(`${name} XR canvas mismatch: ${JSON.stringify(canvas)}`);
    }
    const start = await page.evaluate(() => window.__capture.time);
    const metadata = { room: name, seat: seats[name], base, width, height, fps, frames,
      source: 'own Playwright Chromium; IWER Meta Quest 3; runtime synthetic room',
      query: url.search, start, canvas, sideBrightness: +sideBrightness.toFixed(1), samples: [], errors };
    const silent = `${directory}/silent.mp4`;
    const encoder = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps),
      '-c:v', 'png', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-r', String(fps), silent], { stdio: ['pipe', 'ignore', 'pipe'] });
    let encoderError = '';
    encoder.stderr.on('data', (chunk) => { encoderError += chunk.toString(); });
    for (let frame = 0; frame < frames; frame++) {
      await setHead(page, seats[name], frame / fps);
      await page.evaluate(() => window.__capture.step(1 / 30));
      if (frame % 30 === 0 || frame === frames - 1) {
        metadata.samples.push(await page.evaluate((frame) => {
          const theater = window.__theater;
          return { frame, mode: theater.mode, phase: theater.phase,
            demoHand: theater.demoHand.valid, dimAmount: theater.dim.mesh.material.uniforms.uAmount.value,
            wallActive: theater.wall.active, lantern: theater.lanternPos.toArray(),
            paper: theater.screenCentre.toArray() };
        }, frame));
      }
      const png = await page.screenshot({ type: 'png', timeout: 120000 });
      if (!encoder.stdin.write(png)) await once(encoder.stdin, 'drain');
      if (frame % 30 === 0) process.stdout.write(`${name} frame ${frame}/${frames}\n`);
    }
    encoder.stdin.end();
    const [exitCode] = await once(encoder, 'close');
    if (exitCode !== 0) throw new Error(`ffmpeg failed: ${encoderError}`);
    const wav = await page.evaluate(async ({ start }) => {
      const control = window.__capture;
      const original = control.cues;
      const priorHold = original.filter((cue) => cue.kind === 'hold' && cue.t < start).at(-1);
      control.cues = original.filter((cue) => cue.t >= start && cue.t < start + 4)
        .map((cue) => ({ ...cue, t: cue.t - start }));
      if (priorHold) control.cues.unshift({ ...priorHold, t: 0 });
      try { return await control.renderAudio(4); }
      finally { control.cues = original; }
    }, { start });
    writeFileSync(`${directory}/audio.wav`, Buffer.from(wav, 'base64'));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', silent, '-i', `${directory}/audio.wav`,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', `${directory}/shot.mp4`]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', `${directory}/shot.mp4`,
      '-vf', 'fps=2.5,scale=384:216,tile=5x2:nb_frames=10', '-frames:v', '1', `${directory}/strip.png`]);
    unlinkSync(silent);
    writeFileSync(`${directory}/metadata.json`, JSON.stringify(metadata, null, 2));
    if (!metadata.samples.some((sample) => sample.phase === 1 && sample.demoHand)
      || metadata.samples.at(-1).dimAmount - metadata.samples[0].dimAmount < 0.15) {
      throw new Error(`${name} did not show a demo wake and room dimming`);
    }
    if (errors.length) throw new Error(`${name} browser errors: ${errors.join(' | ')}`);
    console.log(`${name}: ${directory}/shot.mp4`);
  } finally {
    await browser.close();
  }
}

for (const name of names) await capture(name);

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'https://127.0.0.1:4179/?demo&perf';
const output = process.argv[3] ?? '/tmp/layered-uploads.json';
const seconds = Number(process.argv[4] ?? 60);
const seedNight = process.argv.includes('--seed-night');
const shadowBytes = 256 * 169 * 4;
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(({ seedNight }) => {
    if (seedNight) localStorage.setItem('shadow-theater.v1', JSON.stringify({
      nights: 1,
      woken: { peacock: 1, rabbit: 1, snail: 1, fish: 1, duck: 1 },
      order: ['peacock', 'rabbit', 'snail', 'fish', 'duck'],
    }));
    else localStorage.removeItem('shadow-theater.v1');
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
    const state = window.__uploadProbe = {
      frames: [], bytes: 0, sub: 0, imageBytes: 0,
      wallBytes: 0, wallUploads: 0, wallBackground: 0, wallSprite: 0,
    };
    const recordWall = (source, bytes) => {
      const kind = source?.dataset?.shadowfolkWallUpload;
      if (!kind) return;
      state.wallBytes += bytes;
      state.wallUploads++;
      if (kind === 'background') state.wallBackground++;
      if (kind === 'sprite') state.wallSprite++;
    };
    const dimensions = (args, image) => {
      if (args.length >= 9) return [Number(args[4]), Number(args[5])];
      return [image?.videoWidth ?? image?.width ?? 0, image?.videoHeight ?? image?.height ?? 0];
    };
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const sub = prototype.texSubImage2D;
      prototype.texSubImage2D = function (...args) {
        const source = args.length >= 9 ? args[8] : args[6];
        const [width, height] = dimensions(args, source);
        const bytes = width * height * 4;
        state.bytes += bytes;
        state.sub++;
        recordWall(source, bytes);
        return sub.apply(this, args);
      };
      const image = prototype.texImage2D;
      prototype.texImage2D = function (...args) {
        const source = args.length === 6 ? args[5] : args[8];
        const width = args.length === 6 ? (source?.videoWidth ?? source?.width ?? 0) : Number(args[3]);
        const height = args.length === 6 ? (source?.videoHeight ?? source?.height ?? 0) : Number(args[4]);
        const bytes = width * height * 4;
        state.imageBytes += bytes;
        recordWall(source, bytes);
        return image.apply(this, args);
      };
    }
    const tick = () => {
      state.frames.push({
        bytes: state.bytes, sub: state.sub, imageBytes: state.imageBytes,
        wallBytes: state.wallBytes, wallUploads: state.wallUploads,
        wallBackground: state.wallBackground, wallSprite: state.wallSprite,
      });
      state.bytes = state.sub = state.imageBytes = 0;
      state.wallBytes = state.wallUploads = state.wallBackground = state.wallSprite = 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { seedNight });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.mouse.click(1100, 700);
  await page.waitForFunction(() => window.__perf?.update.count > 30, { timeout: 60000 });
  const warmupWall = await page.evaluate(() => window.__uploadProbe.frames.filter(frame => frame.wallUploads > 0));
  await page.evaluate(() => { window.__uploadProbe.frames.length = 0; });
  await page.waitForTimeout(seconds * 1000);
  const measurements = await page.evaluate(() => ({
    frames: window.__uploadProbe.frames,
    updateFrames: window.__perf.update.count,
  }));
  const frames = measurements.frames;
  const totalBytes = frames.reduce((sum, frame) => sum + frame.bytes, 0);
  const totalImageBytes = frames.reduce((sum, frame) => sum + frame.imageBytes, 0);
  const frameSizes = new Map();
  for (const frame of frames) {
    const size = frame.bytes + frame.imageBytes;
    frameSizes.set(size, (frameSizes.get(size) ?? 0) + 1);
  }
  const result = {
    url, seconds, seedNight, shadowBytes, frames: frames.length, updateFrames: measurements.updateFrames,
    meanSubImageBytes: totalBytes / frames.length, totalSubImageBytes: totalBytes,
    meanAllTextureBytes: (totalBytes + totalImageBytes) / frames.length,
    largeFrames: frames.filter(frame => frame.bytes + frame.imageBytes > shadowBytes).length,
    subImageOnlyLargeFrames: frames.filter(frame => frame.bytes > shadowBytes).length,
    shadowSizedFrames: frames.filter(frame => frame.bytes === shadowBytes).length,
    noSubImageFrames: frames.filter(frame => frame.bytes === 0).length,
    maxFrameBytes: Math.max(...frames.map(frame => frame.bytes + frame.imageBytes)),
    commonFrameSizes: [...frameSizes].sort((left, right) => right[1] - left[1]).slice(0, 12),
    wallUploadFrames: frames.filter(frame => frame.wallUploads > 0).length,
    wallUploadBytes: frames.reduce((sum, frame) => sum + frame.wallBytes, 0),
    wallBackgroundUploads: frames.reduce((sum, frame) => sum + frame.wallBackground, 0),
    wallSpriteUploads: frames.reduce((sum, frame) => sum + frame.wallSprite, 0),
    warmupWallUploadFrames: warmupWall.length,
    warmupWallBackgroundUploads: warmupWall.reduce((sum, frame) => sum + frame.wallBackground, 0),
    warmupWallSpriteUploads: warmupWall.reduce((sum, frame) => sum + frame.wallSprite, 0),
    errors,
  };
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length || !frames.length) process.exitCode = 1;
} finally {
  await browser.close();
}

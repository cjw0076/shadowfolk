import { chromium } from 'playwright';

const base = process.env.XR_BASE ?? 'https://127.0.0.1:4178/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__theater?.baked?.length, null, { timeout: 60000 });
  const result = await page.evaluate(async () => {
    const { rasterStencil } = await import('/src/theater/stencil-raster.ts');
    const saved = window.__theater.baked[0].flats.map((flat) => {
      const round = (values) => Array.from(values, (value) => Math.round(value * 10000) / 10000);
      return { x: round(flat.x), y: round(flat.y), r: round(flat.r) };
    });
    const flats = saved.map((flat) => ({
      x: new Float32Array(flat.x), y: new Float32Array(flat.y), r: new Float32Array(flat.r), valid: true,
    }));
    const eyes = [[3, 4, 0.25, 0]];
    const main = rasterStencil(flats, 1, eyes, (width, height) => {
      const source = document.createElement('canvas');
      source.width = width;
      source.height = height;
      return [source, source.getContext('2d', { willReadFrequently: true })];
    });
    const worker = new Worker(new URL('/src/theater/stencil-bake.worker.ts', location.href), { type: 'module' });
    const pixels = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (error) => reject(new Error(error.message));
      worker.postMessage({ hands: saved, eyes });
    });
    worker.terminate();
    const names = ['ink', 'cut', 'glow', 'reveal'];
    const differences = names.map((name, index) => {
      const source = main[name];
      const expected = source.getContext('2d').getImageData(0, 0, source.width, source.height).data;
      const actual = new Uint8ClampedArray(pixels.layers[index]);
      let mismatched = 0, maxDelta = 0;
      for (let offset = 0; offset < expected.length; offset++) {
        const delta = Math.abs(expected[offset] - actual[offset]);
        if (delta) mismatched++;
        if (delta > maxDelta) maxDelta = delta;
      }
      return { name, width: source.width, height: source.height, mismatched, maxDelta };
    });
    return { differences, metadata: {
      width: pixels.width - main.ink.width, height: pixels.height - main.ink.height,
      wM: pixels.wM - main.wM, hM: pixels.hM - main.hM,
      cx: pixels.cx - main.cx, cy: pixels.cy - main.cy,
      eyes: JSON.stringify(pixels.eyePts) === JSON.stringify(main.eyePts),
    } };
  });
  console.log(JSON.stringify({ result, errors }, null, 2));
  if (errors.length || result.differences.some((layer) => layer.mismatched)
    || Object.entries(result.metadata).some(([key, value]) => key === 'eyes' ? !value : value !== 0)) {
    throw new Error('Worker stencil differs from main-thread canvas');
  }
} finally {
  await browser.close();
}

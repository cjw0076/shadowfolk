import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(__dirname, '..');
const outPng = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(worktreeRoot, '../collab/agy/16-journey-art.png');

const bundle = await build({
  entryPoints: [path.resolve(worktreeRoot, 'src/journey/props-art.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  write: false,
  logLevel: 'warning',
});

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1320 } });
  await page.setContent('<!doctype html><html><body style="margin:0;background:#140e0c;"></body></html>');

  const report = await page.evaluate(async (code) => {
    // Track every 2D context creation to verify CPU-backed (`willReadFrequently: true`) invariant
    const contextCalls = [];
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type === '2d') {
        contextCalls.push({
          w: this.width,
          h: this.height,
          willReadFrequently: Boolean(options && options.willReadFrequently),
        });
      }
      return origGetContext.call(this, type, options);
    };

    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    let mod;
    try {
      mod = await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const specs = [
      { label: 'crow(true)', sub: 'perched sentinel', make: () => mod.crow(true) },
      { label: 'crow(false)', sub: 'startled / cawing', make: () => mod.crow(false) },
      { label: 'crowFlying(0)', sub: 'frame 0 · upstroke', make: () => mod.crowFlying(0) },
      { label: 'crowFlying(1)', sub: 'frame 1 · glide', make: () => mod.crowFlying(1) },
      { label: 'crowFlying(2)', sub: 'frame 2 · downstroke', make: () => mod.crowFlying(2) },
      { label: 'crowFlying(3)', sub: 'frame 3 · recovery', make: () => mod.crowFlying(3) },
      { label: 'vineCurtain(null)', sub: 'intact curtain', make: () => mod.vineCurtain(null) },
      { label: 'vineCurtain(0.5)', sub: 'severed at y=0.5', make: () => mod.vineCurtain(0.5) },
      { label: 'fogBank(0.0)', sub: 'dense sumi mist', make: () => mod.fogBank(0.0) },
      { label: 'fogBank(0.5)', sub: 'parting mist', make: () => mod.fogBank(0.5) },
      { label: 'fogBank(0.88)', sub: 'dispersed wisps', make: () => mod.fogBank(0.88) },
      { label: 'boulder(0.0)', sub: 'at rest', make: () => mod.boulder(0.0) },
      { label: 'boulder(0.65)', sub: 'rolled by Giant', make: () => mod.boulder(0.65) },
      { label: 'crack(136)', sub: 'narrow crevice (Tiny)', make: () => mod.crack(136) },
      { label: 'ledge(220)', sub: 'high cliff (Fly / Hop)', make: () => mod.ledge(220) },
      { label: 'spark(0.2)', sub: 'resting ember', make: () => mod.spark(0.2) },
      { label: 'spark(1.0)', sub: 'carried bloom', make: () => mod.spark(1.0) },
      { label: 'moonHole()', sub: 'goal cut-out', make: () => mod.moonHole() },
      {
        label: 'groundLine(1024, [[220, 330], [640, 760]])',
        sub: '1.0 m path with two chasm gaps',
        make: () => mod.groundLine(1024, [[220, 330], [640, 760]]),
      },
    ];

    const summary = [];
    const rendered = new Map();

    for (const item of specs) {
      const c1 = item.make();
      const c2 = item.make();
      if (!(c1 instanceof HTMLCanvasElement) || c1.parentNode !== null) {
        throw new Error(`${item.label}: must return detached HTMLCanvasElement`);
      }
      const d1 = c1.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c1.width, c1.height).data;
      const d2 = c2.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c2.width, c2.height).data;
      if (d1.length !== d2.length) throw new Error(`${item.label}: size mismatch on repeat call`);
      let nonZeroAlpha = 0;
      for (let i = 0; i < d1.length; i++) {
        if (d1[i] !== d2[i]) throw new Error(`${item.label}: non-deterministic pixel at index ${i}`);
        if ((i & 3) === 3 && d1[i] > 10) nonZeroAlpha++;
      }
      if (nonZeroAlpha < 20) throw new Error(`${item.label}: canvas appears blank`);
      rendered.set(item.label, c1);
      summary.push({
        label: item.label,
        width: c1.width,
        height: c1.height,
        wM: +(c1.width / mod.PX).toFixed(3),
        hM: +(c1.height / mod.PX).toFixed(3),
        nonZeroAlpha,
      });
    }

    const nonCpu = contextCalls.filter((c) => !c.willReadFrequently);
    if (nonCpu.length > 0) {
      throw new Error(`Found ${nonCpu.length} canvas contexts without willReadFrequently: true`);
    }

    // Compose contact sheet on a warm dark-washi stage canvas (1680 x 1320)
    const W = 1680, H = 1320;
    const sheet = document.createElement('canvas');
    sheet.width = W;
    sheet.height = H;
    const ctx = sheet.getContext('2d', { willReadFrequently: true });

    // Outer dark theater frame
    ctx.fillStyle = '#140e0c';
    ctx.fillRect(0, 0, W, H);

    // Header title bar
    ctx.fillStyle = '#f2dec0';
    ctx.font = 'bold 26px Georgia, serif';
    ctx.fillText('Shadowfolk v2 · Journey Ink Props Contact Sheet (src/journey/props-art.ts)', 36, 44);
    ctx.fillStyle = '#b99b78';
    ctx.font = '16px monospace';
    ctx.fillText(`PX = ${mod.PX} px/m  |  All ${contextCalls.length} canvases CPU-backed (willReadFrequently: true)  |  100% deterministic`, 36, 70);

    // Helper to draw a warm lantern-lit washi card so sumi-ink (#23160f) & amber glints both read clearly
    function drawWashiCard(x, y, w, h, title, subtitle, canvas, scale = 1) {
      ctx.save();
      // Card background: warm twilight washi gradient matching painter.ts renderPaper()
      const grad = ctx.createRadialGradient(x + w * 0.5, y + h * 0.48, 8, x + w * 0.5, y + h * 0.48, Math.max(w, h) * 0.72);
      grad.addColorStop(0, '#d89a56');
      grad.addColorStop(0.55, '#b67638');
      grad.addColorStop(1, '#7a4920');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 10);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 224, 172, 0.22)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Draw centered prop sprite
      const dw = canvas.width * scale;
      const dh = canvas.height * scale;
      const dx = x + (w - dw) * 0.5;
      const dy = y + (h - 46 - dh) * 0.5 + 8;
      ctx.drawImage(canvas, dx, dy, dw, dh);

      // Footer label strip
      ctx.fillStyle = 'rgba(20, 14, 12, 0.82)';
      ctx.fillRect(x, y + h - 46, w, 46);
      ctx.fillStyle = '#ffe6bc';
      ctx.font = 'bold 14px monospace';
      ctx.fillText(title, x + 12, y + h - 25);
      ctx.fillStyle = '#c9ab88';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${subtitle}  ·  ${canvas.width}×${canvas.height}px`, x + 12, y + h - 8);
      ctx.restore();
    }

    // Row 1: Crow Perched, Startled, and Flying 0..3 (6 cards)
    const row1 = [
      specs[0], specs[1], specs[2], specs[3], specs[4], specs[5],
    ];
    for (let i = 0; i < row1.length; i++) {
      const s = row1[i];
      drawWashiCard(36 + i * 268, 92, 254, 210, s.label, s.sub, rendered.get(s.label), 1.0);
    }

    // Row 2: Vine Curtain (2) + Fog Bank (3) + Boulder (2) = 7 cards
    const row2 = [
      specs[6], specs[7], specs[8], specs[9], specs[10], specs[11], specs[12],
    ];
    for (let i = 0; i < row2.length; i++) {
      const s = row2[i];
      const c = rendered.get(s.label);
      const scale = c.height > 200 ? 0.68 : c.width > 220 ? 0.72 : 0.92;
      drawWashiCard(36 + i * 230, 320, 218, 256, s.label, s.sub, c, scale);
    }

    // Row 3: Crack, Ledge, Spark (0.2, 1.0), MoonHole + GroundLine card
    const row3 = [
      specs[13], specs[14], specs[15], specs[16], specs[17],
    ];
    for (let i = 0; i < row3.length; i++) {
      const s = row3[i];
      const c = rendered.get(s.label);
      const scale = c.height > 200 ? 0.74 : 1.05;
      drawWashiCard(36 + i * 230, 594, 218, 264, s.label, s.sub, c, scale);
    }

    // Right side of Row 3: groundLine standalone card
    const glSpec = specs[18];
    drawWashiCard(36 + 5 * 230, 594, 458, 264, glSpec.label, glSpec.sub, rendered.get(glSpec.label), 0.42);

    // Row 4: Full-width Composite Journey Stage Preview on Washi Screen (1608 x 396)
    const sx = 36, sy = 878, sw = 1608, sh = 406;
    ctx.save();
    const paperGrad = ctx.createRadialGradient(sx + sw * 0.5, sy + sh * 0.52, 20, sx + sw * 0.5, sy + sh * 0.52, sw * 0.6);
    paperGrad.addColorStop(0, '#e3a864');
    paperGrad.addColorStop(0.55, '#be7d3c');
    paperGrad.addColorStop(1, '#77461d');
    ctx.fillStyle = paperGrad;
    ctx.beginPath();
    ctx.roundRect(sx, sy, sw, sh, 12);
    ctx.fill();

    // Draw full ground line across the composite stage
    const gl = rendered.get(glSpec.label);
    ctx.drawImage(gl, sx + 40, sy + 245, sw - 80, 96);

    // Place props in journey order left -> right along the ground line
    ctx.drawImage(rendered.get('spark(1.0)'), sx + 85, sy + 178, 88, 88);
    ctx.drawImage(rendered.get('crow(true)'), sx + 260, sy + 150, 126, 118);
    ctx.drawImage(rendered.get('crowFlying(0)'), sx + 385, sy + 64, 132, 114);
    ctx.drawImage(rendered.get('vineCurtain(null)'), sx + 560, sy + 22, 132, 256);
    ctx.drawImage(rendered.get('fogBank(0.0)'), sx + 730, sy + 128, 250, 156);
    ctx.drawImage(rendered.get('boulder(0.0)'), sx + 1015, sy + 128, 162, 148);
    ctx.drawImage(rendered.get('crack(136)'), sx + 1195, sy + 32, 126, 240);
    ctx.drawImage(rendered.get('ledge(220)'), sx + 1325, sy + 68, 160, 196);
    ctx.drawImage(rendered.get('moonHole()'), sx + 1460, sy + 46, 124, 124);

    ctx.fillStyle = 'rgba(20, 14, 12, 0.85)';
    ctx.fillRect(sx, sy + sh - 44, sw, 44);
    ctx.fillStyle = '#ffe6bc';
    ctx.font = 'bold 15px monospace';
    ctx.fillText(
      'Assembled Journey Path Preview (Left → Right):  spark(1.0) → crow / crowFlying → vineCurtain → [gap] → fogBank → boulder → crack → ledge → moonHole()',
      sx + 16,
      sy + sh - 16,
    );
    ctx.restore();

    document.body.innerHTML = '';
    document.body.appendChild(sheet);
    return { contextCount: contextCalls.length, summary };
  }, bundle.outputFiles[0].text);

  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const canvasEl = page.locator('canvas');
  await canvasEl.screenshot({ path: outPng });
  console.log(`Saved contact sheet to ${outPng}`);
  console.log(`Verified ${report.contextCount} CPU-backed 2D contexts across ${report.summary.length} prop states.`);
  for (const row of report.summary) {
    console.log(`  - ${row.label.padEnd(42)} ${String(row.width).padStart(4)}×${String(row.height).padEnd(4)} px (${row.wM}×${row.hM} m)`);
  }
} finally {
  await browser.close();
}

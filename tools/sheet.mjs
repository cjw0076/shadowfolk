// Render masks to a PNG contact sheet via ffmpeg (PGM tiles -> grid). Usage from bundled tool scripts.
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
export function writeSheet(path, tiles, cols, labelsOut) {
  // tiles: [{w,h,data:Uint8Array (0/1 or 0..255), label}]
  const tw = Math.max(...tiles.map(t=>t.w)), th = Math.max(...tiles.map(t=>t.h));
  const rows = Math.ceil(tiles.length / cols), pad = 4;
  const W = cols * (tw + pad), H = rows * (th + pad);
  const img = new Uint8Array(W * H).fill(40);
  tiles.forEach((t, k) => {
    const ox = (k % cols) * (tw + pad), oy = Math.floor(k / cols) * (th + pad);
    for (let j = 0; j < t.h; j++) for (let i = 0; i < t.w; i++) {
      const v = t.data[j * t.w + i];
      // flip vertically: mask row 0 is the bottom
      img[(oy + (t.h - 1 - j)) * W + ox + i] = v > 1 ? v : (v ? 20 : 235);
    }
  });
  const pgm = path.replace(/\.png$/, '.pgm');
  writeFileSync(pgm, Buffer.concat([Buffer.from(`P5 ${W} ${H} 255\n`), Buffer.from(img)]));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', pgm, '-vf', 'scale=iw*3:ih*3:flags=neighbor', path]);
  if (labelsOut) writeFileSync(labelsOut, tiles.map((t, k) => `${k}: ${t.label}`).join('\n'));
}

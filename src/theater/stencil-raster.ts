import { BONES, PALM } from '../shadow/hand-model.js';
import { FlatHand } from '../shadow/silhouette.js';

export const PIXELS_PER_METRE = 1024;
export const INK = '#1c1316';

type RasterCanvas = HTMLCanvasElement | OffscreenCanvas;
type CanvasFactory<CanvasType extends RasterCanvas> =
  (width: number, height: number) => [CanvasType, CanvasRenderingContext2D];

export interface RasterStencil<CanvasType extends RasterCanvas> {
  ink: CanvasType;
  cut: CanvasType;
  glow: CanvasType;
  reveal: CanvasType;
  wM: number;
  hM: number;
  cx: number;
  cy: number;
  eyePts: [number, number][];
}

export function handPath(ctx: CanvasRenderingContext2D, hand: FlatHand): void {
  ctx.beginPath();
  ctx.moveTo(hand.x[PALM[0]], hand.y[PALM[0]]);
  for (let index = 1; index < PALM.length; index++) ctx.lineTo(hand.x[PALM[index]], hand.y[PALM[index]]);
  ctx.closePath();
  ctx.fill();
  for (const [from, to] of BONES) {
    ctx.lineWidth = hand.r[from] + hand.r[to];
    ctx.beginPath();
    ctx.moveTo(hand.x[from], hand.y[from]);
    ctx.lineTo(hand.x[to], hand.y[to]);
    ctx.stroke();
  }
}

function handPathGrown(ctx: CanvasRenderingContext2D, hand: FlatHand, grow: number): void {
  ctx.lineWidth = grow * 2;
  ctx.beginPath();
  ctx.moveTo(hand.x[PALM[0]], hand.y[PALM[0]]);
  for (let index = 1; index < PALM.length; index++) ctx.lineTo(hand.x[PALM[index]], hand.y[PALM[index]]);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  for (const [from, to] of BONES) {
    ctx.lineWidth = hand.r[from] + hand.r[to] + grow * 2;
    ctx.beginPath();
    ctx.moveTo(hand.x[from], hand.y[from]);
    ctx.lineTo(hand.x[to], hand.y[to]);
    ctx.stroke();
  }
}

export function rasterStencil<CanvasType extends RasterCanvas>(
  hands: FlatHand | FlatHand[], scale: number, eyes: readonly (readonly number[])[],
  makeCanvas: CanvasFactory<CanvasType>,
): RasterStencil<CanvasType> {
  const flats = Array.isArray(hands) ? hands : [hands];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const hand of flats) {
    for (let index = 0; index < hand.x.length; index++) {
      minX = Math.min(minX, hand.x[index] - hand.r[index]); maxX = Math.max(maxX, hand.x[index] + hand.r[index]);
      minY = Math.min(minY, hand.y[index] - hand.r[index]); maxY = Math.max(maxY, hand.y[index] + hand.r[index]);
    }
  }
  const pad = 0.03;
  const wM = (maxX - minX) * scale + 2 * pad, hM = (maxY - minY) * scale + 2 * pad;
  const width = Math.ceil(wM * PIXELS_PER_METRE), height = Math.ceil(hM * PIXELS_PER_METRE);
  const [ink, inkContext] = makeCanvas(width, height);
  inkContext.setTransform(PIXELS_PER_METRE * scale, 0, 0, -PIXELS_PER_METRE * scale,
    pad * PIXELS_PER_METRE - minX * PIXELS_PER_METRE * scale,
    height - pad * PIXELS_PER_METRE + minY * PIXELS_PER_METRE * scale);
  inkContext.fillStyle = inkContext.strokeStyle = INK;
  inkContext.lineCap = 'round';
  inkContext.lineJoin = 'round';
  inkContext.filter = 'blur(3px)';
  inkContext.fillStyle = inkContext.strokeStyle = 'rgba(42,47,58,0.85)';
  for (const hand of flats) handPath(inkContext, hand);
  inkContext.filter = 'none';
  inkContext.globalAlpha = 0.82;
  inkContext.fillStyle = inkContext.strokeStyle = INK;
  for (const hand of flats) handPath(inkContext, hand);
  inkContext.globalAlpha = 1;
  inkContext.setTransform(1, 0, 0, 1, 0, 0);
  inkContext.globalCompositeOperation = 'source-atop';
  let grainSeed = 0x6d2b79f5;
  for (let index = 0; index < Math.round(width * height / 90); index++) {
    grainSeed = (Math.imul(grainSeed, 1664525) + 1013904223) >>> 0;
    const x = (grainSeed / 0x100000000) * width;
    grainSeed = (Math.imul(grainSeed, 1664525) + 1013904223) >>> 0;
    const y = (grainSeed / 0x100000000) * height;
    inkContext.fillStyle = index % 3 ? 'rgba(240,226,201,0.055)' : 'rgba(8,7,9,0.10)';
    inkContext.fillRect(x, y, 1, 1);
  }
  inkContext.globalCompositeOperation = 'source-over';
  const inkSource = inkContext.getImageData(0, 0, width, height).data;
  for (let row = 18; row < height - 18; row += 4) {
    for (let column = 18; column < width - 18; column += 4) {
      const pixel = (row * width + column) * 4;
      const alpha = inkSource[pixel + 3];
      if (alpha < 45 || alpha > 205) continue;
      const flow = Math.sin(column * 0.31 + row * 0.17) * Math.sin(column * 0.07 - row * 0.23);
      if (flow < 0.35) continue;
      const gradientX = inkSource[pixel + 7] - inkSource[pixel - 1];
      const gradientY = inkSource[pixel + width * 4 + 3] - inkSource[pixel - width * 4 + 3];
      const length = Math.hypot(gradientX, gradientY);
      if (length < 18) continue;
      const reach = 8 + 8 * flow;
      const drift = 5 * Math.sin(column * 0.09 - row * 0.13);
      const endX = column - gradientX / length * reach - gradientY / length * drift;
      const endY = row - gradientY / length * reach + gradientX / length * drift;
      const wisp = inkContext.createLinearGradient(column, row, endX, endY);
      wisp.addColorStop(0, 'rgba(28,19,22,0.36)');
      wisp.addColorStop(1, 'rgba(28,19,22,0)');
      inkContext.strokeStyle = wisp;
      inkContext.lineWidth = 0.7 + flow * 0.8;
      inkContext.beginPath();
      inkContext.moveTo(column, row);
      inkContext.quadraticCurveTo((column + endX) / 2 + drift * 0.4, (row + endY) / 2, endX, endY);
      inkContext.stroke();
    }
  }
  const [cut, cutContext] = makeCanvas(width, height);
  cutContext.setTransform(PIXELS_PER_METRE * scale, 0, 0, -PIXELS_PER_METRE * scale,
    pad * PIXELS_PER_METRE - minX * PIXELS_PER_METRE * scale,
    height - pad * PIXELS_PER_METRE + minY * PIXELS_PER_METRE * scale);
  cutContext.lineCap = 'round';
  cutContext.lineJoin = 'round';
  cutContext.fillStyle = cutContext.strokeStyle = '#2e1408';
  for (const hand of flats) handPathGrown(cutContext, hand, 0.005 / scale);
  cutContext.fillStyle = cutContext.strokeStyle = '#42220f';
  for (const hand of flats) handPathGrown(cutContext, hand, 0.0046 / scale);
  cutContext.fillStyle = cutContext.strokeStyle = '#b2682a';
  for (const hand of flats) handPathGrown(cutContext, hand, 0.0015 / scale);
  cutContext.fillStyle = cutContext.strokeStyle = '#fff2d1';
  for (const hand of flats) handPath(cutContext, hand);
  cutContext.setTransform(1, 0, 0, 1, 0, 0);
  const charPixels = cutContext.getImageData(0, 0, width, height);
  const edgeSource = charPixels.data.slice();
  for (let row = 2; row < height - 2; row++) {
    for (let column = 2; column < width - 2; column++) {
      const pixel = (row * width + column) * 4;
      if (edgeSource[pixel] > 90 || edgeSource[pixel + 3] < 160) continue;
      const neighbours = [pixel - 4, pixel + 4, pixel - width * 4, pixel + width * 4];
      const edge = neighbours.find(neighbour => edgeSource[neighbour + 3] < 8);
      if (edge === undefined) continue;
      const waviness = Math.sin(column * 0.173 + row * 0.117) * Math.sin(column * 0.041 - row * 0.087);
      if (waviness > 0.17) {
        charPixels.data[edge] = 66;
        charPixels.data[edge + 1] = 34;
        charPixels.data[edge + 2] = 15;
        charPixels.data[edge + 3] = 210;
      } else if (waviness < -0.57) {
        charPixels.data[pixel + 3] = 130;
      }
    }
  }
  cutContext.putImageData(charPixels, 0, 0);
  const [reveal, revealContext] = makeCanvas(width, height);
  let weightedX = 0, weightedY = 0, weight = 0;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const alpha = charPixels.data[(row * width + column) * 4 + 3];
    if (alpha < 128) continue;
    weightedX += column * alpha;
    weightedY += row * alpha;
    weight += alpha;
  }
  const centreX = weight ? weightedX / weight : width / 2;
  const centreY = weight ? weightedY / weight : height / 2;
  let maxRadius = 1;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    if (charPixels.data[(row * width + column) * 4 + 3] < 128) continue;
    maxRadius = Math.max(maxRadius, Math.hypot(column - centreX, row - centreY));
  }
  const revealPixels = revealContext.createImageData(width, height);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const distance = Math.min(255, 255 * Math.hypot(column - centreX, row - centreY) / maxRadius);
    const pixel = (row * width + column) * 4;
    revealPixels.data[pixel] = revealPixels.data[pixel + 1] = revealPixels.data[pixel + 2] = distance;
    revealPixels.data[pixel + 3] = 255;
  }
  revealContext.putImageData(revealPixels, 0, 0);
  const [glow, glowContext] = makeCanvas(width, height);
  glowContext.filter = 'blur(16px)';
  glowContext.drawImage(ink, 0, 0);
  glowContext.filter = 'none';
  glowContext.globalCompositeOperation = 'source-in';
  glowContext.fillStyle = '#f7b25a';
  glowContext.fillRect(0, 0, width, height);
  const toSprite = (x: number, y: number): [number, number] => [
    (pad + (x - minX) * scale) / wM,
    1 - (pad + (y - minY) * scale) / hM,
  ];
  const eyePts = eyes.map(([from, to, blend, hand = 0]) => {
    const flat = flats[Math.min(hand, flats.length - 1)];
    return toSprite(flat.x[from] + (flat.x[to] - flat.x[from]) * blend,
      flat.y[from] + (flat.y[to] - flat.y[from]) * blend);
  });
  return { ink, cut, glow, reveal, wM, hM, cx: ((minX + maxX) / 2) * scale,
    cy: ((minY + maxY) / 2) * scale, eyePts };
}

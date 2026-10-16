import { FlatHand } from '../shadow/silhouette.js';
import { rasterStencil } from './stencil-raster.js';
import type { StencilPixels } from './painter.js';

interface SavedFlat {
  x: number[];
  y: number[];
  r: number[];
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ hands: SavedFlat[]; eyes: number[][] }>) => void) | null;
  postMessage: (message: StencilPixels, transfer: ArrayBuffer[]) => void;
};

scope.onmessage = ({ data }) => {
  const flats = data.hands.map((saved) => {
    const flat = new FlatHand();
    flat.x.set(saved.x);
    flat.y.set(saved.y);
    flat.r.set(saved.r);
    flat.valid = true;
    return flat;
  });
  const raster = rasterStencil(flats, 1, data.eyes, (width, height) => {
    const source = new OffscreenCanvas(width, height);
    return [source, source.getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D];
  });
  const sources = [raster.ink, raster.cut, raster.glow, raster.reveal];
  const layers = sources.map((source) =>
    source.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, source.width, source.height).data.buffer as ArrayBuffer);
  const pixels: StencilPixels = { width: raster.ink.width, height: raster.ink.height,
    wM: raster.wM, hM: raster.hM, cx: raster.cx, cy: raster.cy, eyePts: raster.eyePts,
    layers: layers as StencilPixels['layers'] };
  scope.postMessage(pixels, layers);
};

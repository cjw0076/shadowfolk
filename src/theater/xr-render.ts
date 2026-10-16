import type { WebGLRenderer } from '@iwsdk/core';

const FOVEATION = 0.65;
const FRAMEBUFFER_SCALE = 0.9;
const TARGET_FRAME_RATE = 72;

type FrameRateRequest = 'idle' | 'pending' | 'applied' | 'unsupported' | 'rejected';

export interface XrRenderSnapshot {
  presenting: boolean;
  foveationRequested: number;
  foveationLayer: number | null;
  framebufferScale: number;
  framebufferScaleApplied: boolean;
  multiview: boolean;
  frameRate: number | null;
  frameRateRequest: FrameRateRequest;
}

const rendererState = new WeakMap<WebGLRenderer, { scaleApplied: boolean; frameRateRequest: FrameRateRequest }>();

declare global { interface Window { __xrRender?: () => XrRenderSnapshot } }

export function configureXrRendering(renderer: WebGLRenderer): void {
  const xr = renderer.xr;
  const state: { scaleApplied: boolean; frameRateRequest: FrameRateRequest } = {
    scaleApplied: !xr.isPresenting, frameRateRequest: 'idle',
  };
  rendererState.set(renderer, state);

  // The XR layer, not the desktop pixel ratio, owns eye resolution; set this before session creation.
  if (state.scaleApplied) xr.setFramebufferScaleFactor(FRAMEBUFFER_SCALE);
  // Moderate fixed foveation spares peripheral pixels while preserving the paper at gaze centre.
  xr.setFoveation(FOVEATION);
  // IWSDK already requests multiviewStereo; Three enables it only when the XR layer and extension support it.
  const requestFrameRate = () => {
    const session = xr.getSession();
    if (!session) return;
    const rates = session.supportedFrameRates;
    if (typeof session.updateTargetFrameRate !== 'function' ||
      (rates && !rates.includes(TARGET_FRAME_RATE))) {
      state.frameRateRequest = 'unsupported';
      return;
    }
    // Request 72 Hz only when the session accepts it; a rejected request leaves the native rate intact.
    state.frameRateRequest = 'pending';
    void session.updateTargetFrameRate(TARGET_FRAME_RATE).then(() => {
      if (xr.getSession() === session) state.frameRateRequest = 'applied';
    }).catch(() => {
      if (xr.getSession() === session) state.frameRateRequest = 'rejected';
    });
  };
  xr.addEventListener('sessionstart', requestFrameRate);
  xr.addEventListener('sessionend', () => { state.frameRateRequest = 'idle'; });
  if (xr.isPresenting) requestFrameRate();
  if (new URLSearchParams(location.search).has('perf')) window.__xrRender = () => xrRenderSnapshot(renderer);
}

export function xrRenderSnapshot(renderer: WebGLRenderer): XrRenderSnapshot {
  const xr = renderer.xr;
  const state = rendererState.get(renderer);
  const session = xr.getSession();
  const layer = xr.getBaseLayer() as { fixedFoveation?: number } | null;
  return {
    presenting: !!session,
    foveationRequested: FOVEATION,
    foveationLayer: typeof layer?.fixedFoveation === 'number' ? layer.fixedFoveation : null,
    framebufferScale: FRAMEBUFFER_SCALE,
    framebufferScaleApplied: state?.scaleApplied ?? false,
    multiview: !!session && !!(xr as typeof xr & { isMultiview?: boolean }).isMultiview,
    frameRate: session?.frameRate ?? null,
    frameRateRequest: state?.frameRateRequest ?? 'idle',
  };
}

export function xrRenderStatusLine(renderer: WebGLRenderer): string {
  const status = xrRenderSnapshot(renderer);
  if (!status.presenting) return `XR standby | foveation ${FOVEATION} | scale ${FRAMEBUFFER_SCALE} | multiview -- | Hz --`;
  const layerFoveation = status.foveationLayer === null ? 'n/a' : status.foveationLayer.toFixed(2);
  const rate = status.frameRate === null ? '--' : String(status.frameRate);
  const scale = status.framebufferScaleApplied ? FRAMEBUFFER_SCALE.toFixed(2) : `${FRAMEBUFFER_SCALE} next`;
  return `XR foveation ${FOVEATION}/${layerFoveation} | scale ${scale} | multiview ${status.multiview ? 'on' : 'off'} | Hz ${rate} (${status.frameRateRequest})`;
}

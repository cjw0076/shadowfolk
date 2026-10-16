import { JOINT_COUNT } from './hand-model.js';
import type { FlatHand } from './silhouette.js';

interface HandSource {
  flat: FlatHand;
  valid: boolean;
}

export class AsyncMatcher {
  private worker: Worker;
  private request: { kind: 'score'; generation: number; targetIndex: number; payload: Float32Array };
  private targetIndex = -1;
  private generation = 0;
  private inFlight = false;
  private value = 0;
  ready = false;

  constructor(templates: Uint8Array[], private readonly hands: HandSource[]) {
    this.worker = new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' });
    this.request = { kind: 'score', generation: 0, targetIndex: 0,
      payload: new Float32Array(hands.length * (1 + JOINT_COUNT * 3)) };
    this.worker.onmessage = ({ data }: MessageEvent<
      { kind: 'ready' } | { kind: 'score'; generation: number; targetIndex: number;
        value: number; payload: Float32Array }
    >) => {
      if (data.kind === 'ready') {
        this.ready = true;
      } else {
        this.request.payload = data.payload;
        this.inFlight = false;
        if (data.generation === this.generation && data.targetIndex === this.targetIndex) this.value = data.value;
      }
    };
    this.worker.onerror = () => this.dispose();
    this.worker.postMessage({ kind: 'init', templates });
  }

  score(targetIndex: number): number {
    if (targetIndex !== this.targetIndex) {
      this.targetIndex = targetIndex;
      this.value = 0;
      this.generation++;
    }
    if (!this.inFlight) {
      const payload = this.request.payload;
      const stride = 1 + JOINT_COUNT * 3;
      for (let index = 0; index < this.hands.length; index++) {
        const hand = this.hands[index];
        const offset = index * stride;
        payload[offset] = hand.valid && hand.flat.valid ? 1 : 0;
        if (!payload[offset]) continue;
        payload.set(hand.flat.x, offset + 1);
        payload.set(hand.flat.y, offset + 1 + JOINT_COUNT);
        payload.set(hand.flat.r, offset + 1 + JOINT_COUNT * 2);
      }
      this.request.targetIndex = targetIndex;
      this.request.generation = this.generation;
      this.inFlight = true;
      this.worker.postMessage(this.request, [payload.buffer]);
    }
    return this.value;
  }

  reset(): void {
    this.targetIndex = -1;
    this.value = 0;
    this.generation++;
  }

  dispose(): void {
    this.worker.terminate();
    this.ready = false;
    this.inFlight = false;
  }
}

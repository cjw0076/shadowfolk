import { JOINT_COUNT } from './hand-model.js';
import type { FlatHand } from './silhouette.js';

export interface HandSource {
  flat: FlatHand;
  valid: boolean;
}

interface ManyRequest {
  kind: 'scoreMany';
  generation: number;
  count: number;
  indices: Int16Array;
  values: Float32Array;
  payload: Float32Array;
}

export class AsyncMatcher {
  private worker: Worker;
  private request: { kind: 'score'; generation: number; targetIndex: number; payload: Float32Array };
  private transfer: ArrayBuffer[];
  private targetIndex = -1;
  private generation = 0;
  private scoreFrame = 0;
  private lastRequestFrame = -2;
  private lastRequestAt = -Infinity;
  private inFlight = false;
  private value = 0;
  private manyRequest: ManyRequest;
  private manyTransfer: ArrayBuffer[];
  private manyValues = new Float32Array(4);
  private manyIndices = new Int16Array(4).fill(-1);
  private manyGeneration = 0;
  private manyFrame = 0;
  private lastManyFrame = -4;
  private lastManyAt = -Infinity;
  private manyInFlight = false;
  ready = false;

  constructor(templates: Uint8Array[], private readonly hands: HandSource[], paired?: boolean[]) {
    this.worker = new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' });
    this.request = { kind: 'score', generation: 0, targetIndex: 0,
      payload: new Float32Array(hands.length * (1 + JOINT_COUNT * 3)) };
    this.transfer = [this.request.payload.buffer as ArrayBuffer];
    this.manyRequest = { kind: 'scoreMany', generation: 0, count: 0,
      indices: new Int16Array(4), values: new Float32Array(4),
      payload: new Float32Array(hands.length * (1 + JOINT_COUNT * 3)) };
    this.manyTransfer = [this.manyRequest.payload.buffer as ArrayBuffer,
      this.manyRequest.indices.buffer as ArrayBuffer, this.manyRequest.values.buffer as ArrayBuffer];
    this.worker.onmessage = ({ data }: MessageEvent<
      { kind: 'ready' } | { kind: 'score'; generation: number; targetIndex: number;
        value: number; payload: Float32Array } | ManyRequest
    >) => {
      if (data.kind === 'ready') {
        this.ready = true;
      } else if (data.kind === 'score') {
        this.request.payload = data.payload;
        this.transfer[0] = data.payload.buffer as ArrayBuffer;
        this.inFlight = false;
        if (data.generation === this.generation && data.targetIndex === this.targetIndex) this.value = data.value;
      } else {
        this.manyRequest = data;
        this.manyTransfer[0] = data.payload.buffer as ArrayBuffer;
        this.manyTransfer[1] = data.indices.buffer as ArrayBuffer;
        this.manyTransfer[2] = data.values.buffer as ArrayBuffer;
        this.manyInFlight = false;
        if (data.generation === this.manyGeneration) this.manyValues.set(data.values);
      }
    };
    this.worker.onerror = () => this.dispose();
    this.worker.postMessage({ kind: 'init', templates, paired });
  }

  score(targetIndex: number): number {
    const frame = this.scoreFrame++;
    if (targetIndex !== this.targetIndex) {
      this.targetIndex = targetIndex;
      this.value = 0;
      this.generation++;
    }
    const now = performance.now();
    if (!this.inFlight && frame - this.lastRequestFrame >= 2 && now - this.lastRequestAt >= 1000 / 36) {
      this.copyHands(this.request.payload, this.hands);
      this.request.targetIndex = targetIndex;
      this.request.generation = this.generation;
      this.inFlight = true;
      this.lastRequestFrame = frame;
      this.lastRequestAt = now;
      this.worker.postMessage(this.request, this.transfer);
    }
    return this.value;
  }

  scoreCandidates(indices: readonly number[], hands: readonly HandSource[] = this.hands): Float32Array {
    const count = Math.min(4, indices.length);
    let changed = count !== this.manyRequest.count;
    for (let index = 0; index < 4; index++) {
      const candidate = index < count ? indices[index] : -1;
      if (this.manyIndices[index] !== candidate) changed = true;
      this.manyIndices[index] = candidate;
    }
    if (changed) {
      this.manyGeneration++;
      this.manyValues.fill(0);
    }
    const frame = this.manyFrame++;
    const now = performance.now();
    if (this.ready && !this.manyInFlight && frame - this.lastManyFrame >= 4 && now - this.lastManyAt >= 1000 / 15) {
      const request = this.manyRequest;
      request.count = count;
      request.indices.set(this.manyIndices);
      this.copyHands(request.payload, hands);
      request.generation = this.manyGeneration;
      this.manyInFlight = true;
      this.lastManyFrame = frame;
      this.lastManyAt = now;
      this.worker.postMessage(request, this.manyTransfer);
    }
    return this.manyValues;
  }

  private copyHands(payload: Float32Array, hands: readonly HandSource[]): void {
    const stride = 1 + JOINT_COUNT * 3;
    for (let index = 0; index < payload.length / stride; index++) {
      const hand = hands[index];
      const offset = index * stride;
      payload[offset] = hand?.valid && hand.flat.valid ? 1 : 0;
      if (!payload[offset]) continue;
      payload.set(hand.flat.x, offset + 1);
      payload.set(hand.flat.y, offset + 1 + JOINT_COUNT);
      payload.set(hand.flat.r, offset + 1 + JOINT_COUNT * 2);
    }
  }

  reset(): void {
    this.targetIndex = -1;
    this.value = 0;
    this.generation++;
    this.manyGeneration++;
    this.manyValues.fill(0);
  }

  dispose(): void {
    this.worker.terminate();
    this.ready = false;
    this.inFlight = false;
  }
}

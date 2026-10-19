import { drawHand, Mask, Matcher } from './silhouette.js';
import { FlatHand } from './silhouette.js';
import { JOINT_COUNT } from './hand-model.js';

interface ScoreRequest {
  kind: 'score';
  generation: number;
  targetIndex: number;
  payload: Float32Array;
}

interface ManyRequest {
  kind: 'scoreMany';
  generation: number;
  count: number;
  indices: Int16Array;
  values: Float32Array;
  payload: Float32Array;
}

interface InitRequest {
  kind: 'init';
  templates: Uint8Array[];
  paired?: boolean[];
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ScoreRequest | ManyRequest | InitRequest>) => void) | null;
  postMessage: (message: { kind: 'ready' } | { kind: 'score'; generation: number; targetIndex: number;
    value: number; payload: Float32Array } | ManyRequest, transfer?: ArrayBuffer[]) => void;
};
const mask = new Mask(170, 120, -0.68, -0.48, 0.008);
const individualMasks = Array.from({ length: 4 }, () => new Mask(170, 120, -0.68, -0.48, 0.008));
const matcher = new Matcher();
const hands = Array.from({ length: 4 }, () => new FlatHand());
let templates: Uint8Array[] = [];
let paired: boolean[] = [];
const reply: { kind: 'score'; generation: number; targetIndex: number; value: number; payload: Float32Array } =
  { kind: 'score', generation: 0, targetIndex: 0, value: 0, payload: new Float32Array(0) };
const transfer: ArrayBuffer[] = [reply.payload.buffer as ArrayBuffer];
const manyTransfer: ArrayBuffer[] = [new ArrayBuffer(0), new ArrayBuffer(0), new ArrayBuffer(0)];

scope.onmessage = ({ data }) => {
  if (data.kind === 'init') {
    templates = data.templates;
    paired = data.paired ?? [];
    scope.postMessage({ kind: 'ready' });
    return;
  }
  mask.clear();
  const stride = 1 + JOINT_COUNT * 3;
  for (let index = 0; index < hands.length; index++) {
    const offset = index * stride;
    const individual = individualMasks[index];
    if (data.kind === 'scoreMany') individual.clear();
    if (!data.payload[offset]) continue;
    const hand = hands[index];
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      hand.x[joint] = data.payload[offset + 1 + joint];
      hand.y[joint] = data.payload[offset + 1 + JOINT_COUNT + joint];
      hand.r[joint] = data.payload[offset + 1 + JOINT_COUNT * 2 + joint];
    }
    hand.valid = true;
    drawHand(mask, hand);
    if (data.kind === 'scoreMany') drawHand(individual, hand);
  }
  if (data.kind === 'scoreMany') {
    for (let index = 0; index < data.count; index++) {
      const targetIndex = data.indices[index];
      const template = templates[targetIndex];
      let value = 0;
      if (template && paired[targetIndex]) value = matcher.score(mask, template);
      else if (template) {
        for (let handIndex = 0; handIndex < hands.length; handIndex++) {
          if (data.payload[handIndex * stride]) {
            value = Math.max(value, matcher.score(individualMasks[handIndex], template));
          }
        }
      }
      data.values[index] = value;
    }
    for (let index = data.count; index < 4; index++) data.values[index] = 0;
    manyTransfer[0] = data.payload.buffer as ArrayBuffer;
    manyTransfer[1] = data.indices.buffer as ArrayBuffer;
    manyTransfer[2] = data.values.buffer as ArrayBuffer;
    scope.postMessage(data, manyTransfer);
  } else {
    reply.generation = data.generation;
    reply.targetIndex = data.targetIndex;
    reply.value = matcher.score(mask, templates[data.targetIndex]);
    reply.payload = data.payload;
    transfer[0] = data.payload.buffer as ArrayBuffer;
    scope.postMessage(reply, transfer);
  }
};

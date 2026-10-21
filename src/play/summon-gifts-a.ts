import type { SummonAgent, SummonContext } from './summon-contract.js';

const GIFT_LIFETIME = 8;
const FLOOR_TOP = -0.20;
const WALKER_FLOOR_Y = -0.185;
const SNAIL_SPEED = 0.05;
const BRIDGE_DURATION = 10;
const RABBIT_CARRYING = 1;
const SNAIL_APPROACHING = 1;
const SNAIL_LAYING = 2;
const SNAIL_DONE = 3;

function updatePeacock(agent: SummonAgent, context: SummonContext): void {
  if (agent.age >= GIFT_LIFETIME) return;

  const zoneEnd = agent.x + 0.30;
  for (let index = 0; index < context.folk.count; index++) {
    const walker = context.folk.agents[index];
    if ((walker.state !== 'walking' && walker.state !== 'falling')
      || walker.x < agent.x || walker.x > zoneEnd) continue;
    if (walker.state === 'falling' && walker.vy < -0.05) walker.vy = -0.05;
    const direction = walker.heading < 0 ? -1 : 1;
    if (walker.vx * direction < 0.15) walker.vx = direction * 0.15;
  }

  context.hazards.cancelGust(agent.x + 0.15, 0.15, Math.max(0.08, context.dt * 2));
}

function updateRabbit(agent: SummonAgent, context: SummonContext): void {
  if (agent.target) {
    if (context.advanceCarry(agent)) {
      agent.uses++;
      agent.target = null;
      agent.state = 0;
      agent.timer = 0.12;
    }
    return;
  }
  if (agent.age >= GIFT_LIFETIME || agent.uses >= 3) return;

  if (agent.timer > 0) {
    agent.timer = Math.max(0, agent.timer - context.dt);
    return;
  }

  let nearX = Infinity;
  let farX = 0;
  const gap = context.nearest('gap', agent.x);
  if (gap && gap.x + gap.width * 0.5 >= agent.x) {
    const edge = gap.x - gap.width * 0.5;
    if (edge < nearX) {
      nearX = edge;
      farX = gap.x + gap.width * 0.5 + 0.02;
    }
  }
  const river = context.nearest('river', agent.x);
  if (river && river.x + river.width * 0.5 + 0.06 >= agent.x) {
    const edge = river.x - river.width * 0.5 - 0.06;
    if (edge < nearX) {
      nearX = edge;
      farX = river.x + river.width * 0.5 + 0.08;
    }
  }
  const thorns = context.nearest('thorns', agent.x);
  if (thorns && thorns.x + thorns.width * 0.5 >= agent.x) {
    const edge = thorns.x - thorns.width * 0.5;
    if (edge < nearX) {
      nearX = edge;
      farX = thorns.x + thorns.width * 0.5 + 0.03;
    }
  }
  if (!Number.isFinite(nearX)) {
    agent.timer = 0.12;
    return;
  }

  const walker = context.walkerNear(nearX - 0.02, 0.10, nearX);
  if (!walker) {
    agent.timer = 0.12;
    return;
  }

  context.carry(agent, walker, farX, WALKER_FLOOR_Y, 1.2);
  agent.target = walker;
  agent.state = RABBIT_CARRYING;
}

function startSnailRoute(agent: SummonAgent, context: SummonContext): boolean {
  let routeStartX = Infinity;
  let routeEndX = 0;
  let routeStartY = FLOOR_TOP;
  let routeEndY = FLOOR_TOP;

  const gap = context.nearest('gap', agent.x);
  if (gap && gap.x + gap.width * 0.5 + 0.01 >= agent.x) {
    const startX = gap.x - gap.width * 0.5 - 0.01;
    if (startX < routeStartX) {
      routeStartX = startX;
      routeEndX = gap.x + gap.width * 0.5 + 0.01;
      routeStartY = FLOOR_TOP;
      routeEndY = FLOOR_TOP;
    }
  }

  const ledge = context.nearest('ledge', agent.x);
  if (ledge && ledge.x + ledge.width * 0.5 + 0.02 >= agent.x) {
    const startX = ledge.x - ledge.width * 0.5 - 0.08;
    if (startX < routeStartX) {
      routeStartX = startX;
      routeEndX = ledge.x + ledge.width * 0.5 + 0.02;
      routeStartY = FLOOR_TOP;
      routeEndY = FLOOR_TOP + 0.09;
    }
  }

  const highLedge = context.nearest('highLedge', agent.x);
  if (highLedge && highLedge.x + highLedge.width * 0.5 + 0.02 >= agent.x) {
    const startX = highLedge.x - highLedge.width * 0.5 - 0.08;
    if (startX < routeStartX) {
      routeStartX = startX;
      routeEndX = highLedge.x + highLedge.width * 0.5 + 0.02;
      routeStartY = FLOOR_TOP;
      routeEndY = FLOOR_TOP + 0.16;
    }
  }

  if (!Number.isFinite(routeStartX)) return false;
  agent.fromX = routeStartX;
  agent.fromY = routeStartY;
  agent.toX = routeEndX;
  agent.toY = routeEndY;
  agent.timer = 0;
  agent.y = routeStartY + 0.015;
  agent.state = agent.x < routeStartX ? SNAIL_APPROACHING : SNAIL_LAYING;
  return true;
}

function updateSnail(agent: SummonAgent, context: SummonContext): void {
  if (agent.age >= GIFT_LIFETIME || agent.state === SNAIL_DONE) return;

  if (agent.state === 0 && !startSnailRoute(agent, context)) return;

  if (agent.state === SNAIL_APPROACHING) {
    agent.x = Math.min(agent.fromX, agent.x + SNAIL_SPEED * context.dt);
    agent.y = agent.fromY + 0.015;
    if (agent.x >= agent.fromX) {
      agent.state = SNAIL_LAYING;
      agent.timer = 0;
    }
    return;
  }

  if (agent.state !== SNAIL_LAYING) return;
  agent.x = Math.min(agent.toX, agent.x + SNAIL_SPEED * context.dt);

  const routeLength = agent.toX - agent.fromX;
  const progress = Math.max(0, Math.min(routeLength, agent.x - agent.fromX));
  const cell = context.field.cell;
  if (progress - agent.timer >= cell || progress >= routeLength) {
    const left = agent.fromX + agent.timer;
    const right = Math.min(agent.toX, agent.fromX + progress + cell);
    const startHeight = agent.fromY + (agent.toY - agent.fromY) * (agent.timer / routeLength);
    const endProgress = Math.min(routeLength, progress + cell);
    const endHeight = agent.fromY + (agent.toY - agent.fromY) * (endProgress / routeLength);
    context.addBridge(left, right, Math.min(startHeight, endHeight) - 0.02,
      Math.max(startHeight, endHeight), BRIDGE_DURATION);
    agent.timer = progress;
  }

  const ratio = progress / routeLength;
  agent.y = agent.fromY + (agent.toY - agent.fromY) * ratio + 0.015;
  if (progress >= routeLength) {
    agent.uses++;
    agent.state = SNAIL_DONE;
  }
}

export function updateGiftA(agent: SummonAgent, context: SummonContext): void {
  switch (agent.kind) {
    case 'peacock':
      updatePeacock(agent, context);
      break;
    case 'rabbit':
      updateRabbit(agent, context);
      break;
    case 'snail':
      updateSnail(agent, context);
      break;
    default:
      break;
  }
}

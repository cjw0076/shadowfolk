import type { SummonAgent, SummonContext } from './summon-contract.js';

const GIFT_LIFETIME = 8;
const FLOOR_TOP = -0.20;
const WALKER_FLOOR_Y = -0.185;
const SNAIL_SPEED = 0.05;
const BRIDGE_DURATION = 10;
const RABBIT_CARRYING = 1;
const SNAIL_LAYING = 2;
const SNAIL_DONE = 3;

function updatePeacock(agent: SummonAgent, context: SummonContext): void {
  if (agent.age >= GIFT_LIFETIME) return;

  const zoneEnd = agent.x + 0.30;
  const gap = context.nearest('gap', agent.x + 0.15);
  for (let index = 0; index < context.folk.count; index++) {
    const walker = context.folk.agents[index];
    if ((walker.state !== 'walking' && walker.state !== 'falling')
      || walker.x < agent.x || walker.x > zoneEnd) continue;
    if (gap && walker.state === 'walking'
      && walker.x >= gap.x - gap.width * 0.5 - 0.03
      && walker.x < gap.x - gap.width * 0.5) {
      walker.state = 'falling';
      walker.y += 0.065;
      walker.fallStartY = walker.y;
      walker.vy = 0.035;
    }
    if (walker.state === 'falling' && walker.vy < -0.05) walker.vy = -0.05;
    const direction = walker.heading < 0 ? -1 : 1;
    if (walker.vx * direction < 0.20) walker.vx = direction * 0.20;
  }

  context.hazards.cancelGust(agent.x + 0.15, 0.15, Math.max(0.08, context.dt * 2));
}

function updateRabbit(agent: SummonAgent, context: SummonContext): void {
  if (agent.target) {
    if (context.advanceCarry(agent)) {
      agent.uses++;
      agent.state = 2;
      agent.timer = 0;
    }
    return;
  }
  if (agent.age >= GIFT_LIFETIME || agent.uses >= 3) return;

  if (agent.state === 2) {
    const hazard = context.nearest('gap', agent.x) ?? context.nearest('river', agent.x)
      ?? context.nearest('thorns', agent.x);
    if (hazard) {
      const nearX = hazard.x - hazard.width * 0.5 - (hazard.kind === 'river' ? 0.08 : 0.04);
      agent.x = Math.max(nearX, agent.x - 0.50 * context.dt);
      agent.y = WALKER_FLOOR_Y + Math.sin(Math.min(1, (agent.x - nearX) / 0.30) * Math.PI) * 0.055;
      if (agent.x <= nearX) { agent.state = 0; agent.timer = 0.08; }
    } else agent.state = 0;
    return;
  }

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
  const companion = context.walkerNear(walker.x - 0.035, 0.075, walker.x);
  if (companion) context.board(agent, companion);
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
    const startX = highLedge.x - highLedge.width * 0.5 - 0.18;
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
  agent.x = routeStartX;
  agent.y = routeStartY + 0.015;
  agent.state = SNAIL_LAYING;
  return true;
}

function updateSnail(agent: SummonAgent, context: SummonContext): void {
  if (agent.age >= GIFT_LIFETIME || agent.state === SNAIL_DONE) return;

  if (agent.state === 0 && !startSnailRoute(agent, context)) return;

  if (agent.state !== SNAIL_LAYING) return;
  agent.x = Math.min(agent.toX, agent.x + SNAIL_SPEED * context.dt);

  const routeLength = agent.toX - agent.fromX;
  const progress = Math.max(0, Math.min(routeLength, agent.x - agent.fromX));
  const cell = context.field.cell;
  if (progress - agent.timer >= cell || progress >= routeLength) {
    const left = agent.fromX + agent.timer;
    const right = Math.min(agent.toX, agent.fromX + progress);
    const ledge = context.nearest('highLedge', agent.x) ?? context.nearest('ledge', agent.x);
    const riseEndX = ledge ? ledge.x - ledge.width * 0.5 : agent.toX;
    const riseLength = Math.max(cell, riseEndX - agent.fromX);
    const startHeight = agent.fromY + (agent.toY - agent.fromY) * Math.min(1, agent.timer / riseLength);
    const endProgress = progress;
    const endHeight = agent.fromY + (agent.toY - agent.fromY) * Math.min(1, endProgress / riseLength);
    context.addBridge(left, right, Math.min(startHeight, endHeight) - 0.02,
      Math.max(startHeight, endHeight), BRIDGE_DURATION + (routeLength - progress) / SNAIL_SPEED);
    agent.timer = progress;
  }

  const ledge = context.nearest('highLedge', agent.x) ?? context.nearest('ledge', agent.x);
  const riseEndX = ledge ? ledge.x - ledge.width * 0.5 : agent.toX;
  const ratio = Math.min(1, progress / Math.max(cell, riseEndX - agent.fromX));
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

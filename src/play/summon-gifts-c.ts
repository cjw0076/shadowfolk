import type { Kindling } from './folk.js';
import type { SummonAgent, SummonContext } from './summon-contract.js';

const CRAB_THORNS_SNIPPED = 1 << 8;
const HERON_THORN_ZERO_DONE = 1 << 9;
const HERON_THORN_ONE_DONE = 1 << 10;
const HERON_PLUCK_RADIUS = 0.25;
const RETRY_DELAY = 0.15;
const WALK_SPEED = 0.12;
const WALKER_FLOOR_Y = -0.189;

function tickTimer(agent: SummonAgent, dt: number): void {
  agent.timer = Math.max(0, agent.timer - Math.max(0, dt));
}

function advanceCarry(agent: SummonAgent, context: SummonContext): boolean {
  if (agent.target === null) return false;
  if (context.advanceCarry(agent)) agent.uses++;
  tickTimer(agent, context.dt);
  return true;
}

function moveToward(agent: SummonAgent, targetX: number, speed: number, dt: number): boolean {
  const distance = targetX - agent.x;
  const step = speed * Math.max(0, dt);
  if (Math.abs(distance) <= step) {
    agent.x = targetX;
    return true;
  }
  agent.x += Math.sign(distance) * step;
  return false;
}

function nearestUnpeckedThorn(agent: SummonAgent, context: SummonContext): {
  x: number; width: number; slot: 0 | 1;
} | null {
  let nearest: { x: number; width: number; slot: 0 | 1 } | null = null;
  let distance = Infinity;
  for (let index = 0; index < context.level.hazards.length; index++) {
    const hazard = context.level.hazards[index];
    const doneBit = hazard.slot === 0 ? HERON_THORN_ZERO_DONE : HERON_THORN_ONE_DONE;
    if (hazard.kind !== 'thorns' || (agent.state & doneBit) !== 0) continue;
    const nextDistance = Math.abs(hazard.x - agent.x);
    if (nextDistance >= distance) continue;
    nearest = hazard;
    distance = nextDistance;
  }
  return nearest;
}

function farLedgeX(context: SummonContext, walker: Kindling): number {
  const direction = walker.heading < 0 ? -1 : 1;
  const gap = context.nearest('gap', walker.x);
  if (gap !== null && Math.abs(walker.x - gap.x) <= gap.width * 0.5 + 0.06) {
    return gap.x + direction * (gap.width * 0.5 + 0.02);
  }
  const river = context.nearest('river', walker.x);
  if (river !== null && Math.abs(walker.x - river.x) <= river.width * 0.5 + 0.08) {
    return river.x + direction * (river.width * 0.5 + 0.07);
  }
  return walker.x + direction * 0.2;
}

function updateHeron(agent: SummonAgent, context: SummonContext): void {
  if (advanceCarry(agent, context)) return;
  tickTimer(agent, context.dt);

  const walker = context.walkerNear(agent.x, HERON_PLUCK_RADIUS);
  if (walker !== null && walker.state === 'falling') {
      const dx = walker.x - agent.x;
      const dy = walker.y - agent.y;
    if (dx * dx + dy * dy <= HERON_PLUCK_RADIUS * HERON_PLUCK_RADIUS) {
      context.carry(agent, walker, farLedgeX(context, walker), WALKER_FLOOR_Y, 0.4);
      agent.timer = Math.max(agent.timer, RETRY_DELAY);
      return;
    }
  }

  const thorn = nearestUnpeckedThorn(agent, context);
  if (thorn !== null) {
    const closeEnough = Math.abs(thorn.x - agent.x) <= thorn.width * 0.5 + 0.1;
    if (closeEnough && agent.timer === 0) {
      const doneBit = thorn.slot === 0 ? HERON_THORN_ZERO_DONE : HERON_THORN_ONE_DONE;
      if (context.hazards.disableThorns(thorn.x, 0.001)) {
        agent.uses++;
        agent.timer = 2;
      } else {
        agent.timer = RETRY_DELAY;
      }
      agent.state |= doneBit;
      return;
    }
    moveToward(agent, thorn.x, WALK_SPEED, context.dt);
    return;
  }

  if (agent.timer === 0) agent.timer = RETRY_DELAY;
  const gap = context.nearest('gap', agent.x);
  const river = context.nearest('river', agent.x);
  let targetX = agent.x;
  let nearestDistance = Infinity;
  if (gap !== null && Math.abs(gap.x - agent.x) < nearestDistance) {
    targetX = gap.x;
    nearestDistance = Math.abs(gap.x - agent.x);
  }
  if (river !== null && Math.abs(river.x - agent.x) < nearestDistance) targetX = river.x;
  if (nearestDistance < Infinity) moveToward(agent, targetX, WALK_SPEED, context.dt);
  else agent.x = Math.min(0.62, agent.x + WALK_SPEED * context.dt);
}

function updateCrab(agent: SummonAgent, context: SummonContext): void {
  if (agent.target !== null) {
    context.advanceCarry(agent);
    tickTimer(agent, context.dt);
    return;
  }
  tickTimer(agent, context.dt);

  if ((agent.state & CRAB_THORNS_SNIPPED) === 0) {
    const thorn = context.nearest('thorns', agent.x);
    if (thorn === null) agent.state |= CRAB_THORNS_SNIPPED;
    else {
      const closeEnough = Math.abs(thorn.x - agent.x) <= thorn.width * 0.5 + 0.1;
      if (!closeEnough) {
        moveToward(agent, thorn.x, WALK_SPEED, context.dt);
        return;
      }
      if (agent.timer === 0) {
        if (context.hazards.disableThorns(thorn.x, 0.001)) agent.uses++;
        agent.state |= CRAB_THORNS_SNIPPED;
        agent.timer = RETRY_DELAY;
        return;
      }
    }
  }

  const crow = context.nearest('crow', agent.x);
  if (crow !== null) {
    const crowRange = crow.width * 0.5 + 0.14;
    if (Math.abs(crow.x - agent.x) > crowRange) {
      moveToward(agent, crow.x, WALK_SPEED, context.dt);
      return;
    }
    if (agent.timer === 0 && context.hazards.repelCrow(agent.x, crowRange, 1.5)) {
      agent.uses++;
      agent.timer = 1.5;
      return;
    }
  }

  if (agent.timer === 0) agent.timer = RETRY_DELAY;
  if (crow === null) agent.x = Math.min(0.62, agent.x + WALK_SPEED * context.dt);
}

function updateButterfly(agent: SummonAgent, context: SummonContext): void {
  if (advanceCarry(agent, context)) return;
  tickTimer(agent, context.dt);
  if (agent.uses >= 3) return;

  let ledge = context.nearest('ledge', agent.x);
  let distance = ledge === null ? Infinity : Math.abs(ledge.x - agent.x);
  const highLedge = context.nearest('highLedge', agent.x);
  const highDistance = highLedge === null ? Infinity : Math.abs(highLedge.x - agent.x);
  if (highDistance < distance) {
    ledge = highLedge;
    distance = highDistance;
  }
  if (ledge === null) {
    agent.timer = RETRY_DELAY;
    return;
  }
  if (distance > ledge.width * 0.5 + 0.12) {
    moveToward(agent, ledge.x, WALK_SPEED, context.dt);
    return;
  }
  if (agent.timer > 0) return;

  const walker = context.walkerNear(ledge.x, ledge.width * 0.5 + 0.1, ledge.x + 0.015);
  if (walker === null || walker.state !== 'walking' || walker.heading < 0 || walker.x > ledge.x + 0.015) {
    agent.timer = RETRY_DELAY;
    return;
  }

  const rise = ledge.kind === 'highLedge' ? 0.16 : 0.09;
  context.carry(agent, walker, ledge.x + ledge.width * 0.5 + 0.025, walker.y + rise, 0.4);
  agent.timer = 1.5;
}

function updateStag(agent: SummonAgent, context: SummonContext): void {
  tickTimer(agent, context.dt);
  if (context.hazards.shatterBoulder(agent.x, 0.06)) agent.uses++;
  const boulder = context.nearest('boulder', agent.x);
  const gust = context.nearest('gust', agent.x);
  let targetX = agent.x;
  let targetDistance = Infinity;
  if (boulder !== null) {
    targetX = boulder.x;
    targetDistance = Math.abs(boulder.x - agent.x);
  }
  if (gust !== null && Math.abs(gust.x - agent.x) < targetDistance) targetX = gust.x;
  if (gust !== null && agent.timer === 0
    && Math.abs(gust.x - agent.x) <= gust.width * 0.5 + 0.08
    && context.hazards.shieldGust(gust.x, gust.width * 0.5 + 0.03, 0.25)) {
    agent.uses++;
  }
  if (agent.timer === 0) agent.timer = 0.12;
  if (targetDistance < Infinity || gust !== null) moveToward(agent, targetX, WALK_SPEED, context.dt);
  else agent.x = Math.min(0.62, agent.x + WALK_SPEED * context.dt);
}

function updateInvented(agent: SummonAgent, context: SummonContext): void {
  if (advanceCarry(agent, context)) return;
  tickTimer(agent, context.dt);
  if (agent.uses >= 3) return;
  if (agent.timer > 0) {
    agent.x = Math.min(0.62, agent.x + 0.055 * context.dt);
    return;
  }

  const walker = context.walkerNear(agent.x, 0.16);
  if (walker === null || (walker.state !== 'walking' && walker.state !== 'falling')) {
    agent.x = Math.min(0.62, agent.x + 0.055 * context.dt);
    return;
  }

  const direction = walker.heading < 0 ? -1 : 1;
  context.carry(agent, walker, walker.x + direction * 0.3, walker.y, 0.45);
  agent.timer = 1.5;
}

export function updateGiftC(agent: SummonAgent, context: SummonContext): void {
  switch (agent.kind) {
    case 'heron':
      updateHeron(agent, context);
      break;
    case 'crab':
      updateCrab(agent, context);
      break;
    case 'butterfly':
      updateButterfly(agent, context);
      break;
    case 'stag':
      updateStag(agent, context);
      break;
    case 'invented':
      updateInvented(agent, context);
      break;
    default:
      break;
  }
}

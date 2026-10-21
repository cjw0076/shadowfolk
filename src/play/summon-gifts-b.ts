import type { GiftUpdate, SummonAgent, SummonContext } from './summon-contract.js';
import type { Kindling } from './folk.js';

const FLOOR_Y = -0.20;
const WALKER_Y = FLOOR_Y + 0.011;
const CREATURE_GROUND_Y = FLOOR_Y + 0.02;
const WATER_Y = FLOOR_Y - 0.033;
const DOG_RANGE = 0.30;
const DOG_SPEED = 0.15;
const RIVER_SPEED = 0.10;
const RAFT_RETURN_SPEED = 0.45;
const CARRY_COOLDOWN = 0.12;

function moveToward(agent: SummonAgent, targetX: number, speed: number, dt: number): boolean {
  const distance = targetX - agent.x;
  const step = speed * dt;
  if (Math.abs(distance) <= step) {
    agent.x = targetX;
    return true;
  }
  agent.x += Math.sign(distance) * step;
  return false;
}

function advanceCarry(agent: SummonAgent, context: SummonContext): boolean {
  if (agent.target !== null) {
    if (context.advanceCarry(agent)) {
      agent.uses++;
      agent.timer = CARRY_COOLDOWN;
    }
    return true;
  }
  agent.timer = Math.max(0, agent.timer - context.dt);
  return agent.timer > 0;
}

function updateDog(agent: SummonAgent, context: SummonContext): void {
  agent.y = CREATURE_GROUND_Y;
  if (agent.state !== 0) {
    const crow = context.nearest('crow', agent.x);
    const guardX = Math.max(-0.37, Math.min(0.37, (crow?.x ?? agent.x) + 0.08));
    moveToward(agent, guardX + 0.025 * Math.sin(agent.age * 3), DOG_SPEED * 0.35, context.dt);
    return;
  }
  const crow = context.nearest('crow', agent.x);
  if (!crow) {
    agent.x = Math.min(0.37, agent.x + DOG_SPEED * context.dt);
    return;
  }
  if (Math.abs(crow.x - agent.x) <= DOG_RANGE
    && context.hazards.repelCrow(agent.x, DOG_RANGE, 10)) {
    agent.uses++;
    agent.state = 1;
    return;
  }
  moveToward(agent, crow.x, DOG_SPEED, context.dt);
}

function updateDuck(agent: SummonAgent, context: SummonContext): void {
  if (advanceCarry(agent, context)) return;
  const river = context.nearest('river', agent.x);
  if (!river) return;

  const left = river.x - river.width * 0.5;
  const right = river.x + river.width * 0.5;
  const raftX = left + 0.01;
  if (agent.x < left || agent.x > right) {
    agent.y = CREATURE_GROUND_Y;
    moveToward(agent, raftX, RAFT_RETURN_SPEED, context.dt);
    return;
  }
  agent.y = WATER_Y;
  if (!moveToward(agent, raftX, RAFT_RETURN_SPEED, context.dt)) return;

  const walker = context.walkerNear(raftX, 0.035, left + 0.025);
  if (!walker || (walker.state !== 'walking' && walker.state !== 'falling')) return;
  context.carry(agent, walker, right + 0.06, WALKER_Y, 1.2);
  for (let index = 0; index < 2; index++) {
    const companion = context.walkerNear(walker.x - 0.04, 0.08, walker.x);
    if (!companion || !context.board(agent, companion)) break;
  }
}

function walkerInWaterNear(agent: SummonAgent, context: SummonContext, left: number, right: number,
  radius = 0.22): Kindling | null {
  let closest: Kindling | null = null;
  let distance = radius;
  for (let index = 0; index < context.folk.count; index++) {
    const walker = context.folk.agents[index];
    if ((walker.state !== 'falling' && walker.state !== 'walking') || walker.carried
      || walker.y >= FLOOR_Y - 0.005
      || walker.x < left - 0.04 || walker.x > right + 0.04) continue;
    const gap = Math.abs(walker.x - agent.x);
    if (gap < distance) {
      closest = walker;
      distance = gap;
    }
  }
  return closest;
}

function updateFish(agent: SummonAgent, context: SummonContext): void {
  const river = context.nearest('river', agent.x);
  if (!river) return;

  const left = river.x - river.width * 0.5;
  const right = river.x + river.width * 0.5;
  if (agent.target) {
    const passenger = walkerInWaterNear(agent, context, left, right, 0.40);
    if (passenger) context.board(agent, passenger);
    if (context.advanceCarry(agent)) agent.uses++;
    return;
  }
  const patrolLeft = left - 0.015;
  const patrolRight = right + 0.015;
  agent.y = WATER_Y;
  if (agent.x < patrolLeft) {
    agent.x = Math.min(patrolLeft, agent.x + RIVER_SPEED * context.dt);
    agent.state = 0;
  } else if (agent.x > patrolRight) {
    agent.x = Math.max(patrolRight, agent.x - RIVER_SPEED * context.dt);
    agent.state = 1;
  } else if (agent.state === 0) {
    agent.x = Math.min(patrolRight, agent.x + RIVER_SPEED * context.dt);
    if (agent.x >= patrolRight) agent.state = 1;
  } else {
    agent.x = Math.max(patrolLeft, agent.x - RIVER_SPEED * context.dt);
    if (agent.x <= patrolLeft) agent.state = 0;
  }

  const walker = walkerInWaterNear(agent, context, left, right);
  if (!walker) return;

  const destinationX = walker.x <= river.x ? right + 0.06 : left - 0.06;
  context.carry(agent, walker, destinationX, WALKER_Y, 1.0);
}

function addUmbrella(agent: SummonAgent, context: SummonContext): void {
  const field = context.field;
  const cell = field.cell;
  const left = Math.max(0, Math.floor((agent.x - 0.15 - field.x0) / cell));
  const right = Math.min(field.w - 1, Math.ceil((agent.x + 0.15 - field.x0) / cell) - 1);
  const row = Math.floor((agent.y + 0.065 - field.y0) / cell);
  if (row < 0 || row + 1 >= field.h) return;
  for (let column = left; column <= right; column++) {
    field.solid[row * field.w + column] = 1;
    field.solid[(row + 1) * field.w + column] = 1;
  }
}

function updateElephant(agent: SummonAgent, context: SummonContext): void {
  agent.y = CREATURE_GROUND_Y;
  if (agent.state === 0) {
    const rain = context.nearest('rain', agent.x);
    if (rain) {
      if (Math.abs(rain.x - agent.x) <= 0.15) {
        if (context.hazards.suspendRain(rain.x, 0.30, 8)) {
          agent.uses++;
          agent.state = 1;
        }
      } else {
        moveToward(agent, rain.x, RIVER_SPEED, context.dt);
      }
    }
  }
  addUmbrella(agent, context);
}

export const updateGiftB: GiftUpdate = (agent, context): void => {
  switch (agent.kind) {
    case 'dog':
      updateDog(agent, context);
      return;
    case 'duck':
      updateDuck(agent, context);
      return;
    case 'fish':
      updateFish(agent, context);
      return;
    case 'elephant':
      updateElephant(agent, context);
      return;
    default:
      return;
  }
};

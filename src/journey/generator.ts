export type ObstacleKind = 'crow' | 'vine' | 'gap' | 'fog' | 'ledge' | 'boulder' | 'crack';
export type Ability = 'bark' | 'peck' | 'snip' | 'hop' | 'fan' | 'fly' | 'giant' | 'tiny';

export interface JourneyObstacle {
  kind: ObstacleKind;
  ability: Ability;
  x: number;
  combined: boolean;
  ramp: boolean;
}

export interface JourneyPlan {
  day: number;
  night: number;
  obstacles: JourneyObstacle[];
}

const ABILITY_BY_FORM: Record<string, Ability> = {
  peacock: 'fan', rabbit: 'hop', snail: 'tiny', fish: 'tiny', duck: 'peck',
  butterfly: 'fly', heron: 'peck', stag: 'giant', crab: 'snip', dog: 'bark', elephant: 'giant',
};

const KIND_BY_ABILITY: Record<Ability, ObstacleKind> = {
  bark: 'crow', peck: 'vine', snip: 'vine', hop: 'gap', fan: 'fog', fly: 'ledge',
  giant: 'boulder', tiny: 'crack',
};

export function abilityForForm(id: string): Ability | undefined { return ABILITY_BY_FORM[id]; }

export function generateJourney(day: number, night: number, learned: readonly string[], newcomer: string | null,
  oneHand = false): JourneyPlan {
  const available: Ability[] = [];
  for (const id of learned) {
    const ability = abilityForForm(id);
    if (ability && !available.includes(ability)) available.push(ability);
  }
  if (available.length) {
    if (!available.includes('giant')) available.push('giant');
    if (!available.includes('tiny')) available.push('tiny');
  }
  if (!available.length) available.push('giant', 'tiny');
  const substitute = (ability: Ability): Ability => oneHand && ability === 'fly' ? 'hop'
    : oneHand && ability === 'snip' ? 'peck' : ability;
  const choices = available.slice();
  let seed = (Math.imul(day | 0, 7919) + Math.imul(night | 0, 104729)) >>> 0 || 1;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let index = choices.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [choices[index], choices[swap]] = [choices[swap], choices[index]];
  }
  const length = Math.min(5, 3 + Math.floor(Math.max(0, night - 1) / 2));
  const picked: Ability[] = [];
  const fresh = newcomer ? abilityForForm(newcomer) : undefined;
  if (fresh) picked.push(fresh);
  for (const ability of choices) if (picked.length < length && !picked.includes(ability)) picked.push(ability);
  while (picked.length < length) picked.push(choices[Math.floor(random() * choices.length)]);
  for (let index = picked.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [picked[index], picked[swap]] = [picked[swap], picked[index]];
  }
  if (night >= 4) {
    const rock = picked.indexOf('giant');
    const bird = picked.findIndex((ability) => ability === 'bark' || ability === 'peck' || ability === 'snip');
    if (rock >= 0 && bird >= 0 && Math.abs(rock - bird) > 1) {
      const beside = rock === 0 ? 1 : rock - 1;
      [picked[bird], picked[beside]] = [picked[beside], picked[bird]];
    }
  }
  const obstacles: JourneyObstacle[] = picked.map((original, index) => ({
    kind: KIND_BY_ABILITY[original], ability: substitute(original), x: -0.27 + index * 0.51 / (length - 1),
    combined: false, ramp: oneHand && original === 'fly',
  }));
  if (night >= 4 && obstacles.length >= 4) {
    const rock = obstacles.findIndex((obstacle) => obstacle.kind === 'boulder');
    const boulder = obstacles[rock];
    const other = obstacles.find((obstacle, index) => Math.abs(index - rock) === 1
      && (obstacle.kind === 'crow' || obstacle.kind === 'vine'));
    if (boulder && other && boulder !== other) {
      other.x = boulder.x;
      other.combined = true;
      boulder.combined = true;
    }
  }
  return { day, night, obstacles };
}

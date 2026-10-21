export type ArcTrouble = 'gap' | 'ledge' | 'highLedge' | 'river' | 'crow' | 'rain' | 'thorns' | 'gust' | 'boulder';

export interface ArcNight {
  number: number;
  moon: string;
  wakes: readonly string[];
  troubles: readonly ArcTrouble[];
  kindlings: readonly [number, number, number];
}

const NIGHTS: readonly ArcNight[] = [
  { number: 0, moon: 'Dark Moon', wakes: [], troubles: ['gap'], kindlings: [1, 0, 0] },
  { number: 1, moon: 'New Moon', wakes: ['peacock', 'rabbit'], troubles: ['gap'], kindlings: [4, 5, 6] },
  { number: 2, moon: 'Waxing Crescent', wakes: ['snail'], troubles: ['ledge', 'gap'], kindlings: [5, 6, 6] },
  { number: 3, moon: 'First Quarter', wakes: ['dog'], troubles: ['crow', 'ledge', 'gap'], kindlings: [5, 6, 7] },
  { number: 4, moon: 'Waxing Gibbous', wakes: ['duck', 'fish'], troubles: ['river', 'crow', 'ledge', 'gap'], kindlings: [6, 6, 7] },
  { number: 5, moon: 'Waxing Gibbous', wakes: ['elephant'], troubles: ['rain', 'river', 'crow', 'ledge', 'gap'], kindlings: [6, 7, 7] },
  { number: 6, moon: 'Waxing Gibbous', wakes: ['heron', 'crab'], troubles: ['thorns', 'rain', 'river', 'crow', 'ledge', 'gap'], kindlings: [6, 7, 8] },
  { number: 7, moon: 'Almost Full', wakes: ['butterfly', 'stag'], troubles: ['gust', 'boulder', 'highLedge', 'thorns', 'rain', 'river', 'crow', 'ledge', 'gap'], kindlings: [7, 7, 8] },
  { number: 8, moon: 'Full Moon', wakes: [], troubles: ['gust', 'boulder', 'highLedge', 'thorns', 'rain', 'river', 'crow', 'ledge', 'gap'], kindlings: [7, 8, 8] },
];

const OLD_FRIENDS = ['peacock', 'rabbit', 'snail', 'dog', 'duck', 'fish', 'elephant', 'heron', 'crab', 'butterfly', 'stag'];

export function arcNight(number: number, seed = 1): ArcNight {
  if (number <= 8) return NIGHTS[Math.max(0, Math.floor(number))];
  const mixed = (Math.imul(seed | 0, 1664525) + 1013904223) >>> 0;
  // Daily nights: three different troubles from the whole pool, in a date-seeded order.
  const pool = [...NIGHTS[8].troubles];
  let state = mixed || 1;
  for (let index = pool.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  const troubles: ArcTrouble[] = pool.slice(0, 3);
  return { number, moon: 'Lantern Night', wakes: [OLD_FRIENDS[(mixed >>> 8) % OLD_FRIENDS.length]], troubles, kindlings: [6, 7, 8] };
}

export interface ArcSave {
  night: number;
  prologue: boolean;
  complete: boolean;
  best: number[];
  fireflies: number;
  nightsPlayed: number;
}

export function validArcSave(value: unknown, oldNights = 0): ArcSave {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<ArcSave> : {};
  const best = Array.from({ length: 9 }, (_, index) => {
    const number = source.best?.[index];
    return typeof number === 'number' && Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
  });
  return {
    night: Number.isSafeInteger(source.night) && source.night! >= 0 ? source.night! : 1,
    prologue: typeof source.prologue === 'boolean' ? source.prologue : oldNights === 0,
    complete: source.complete === true,
    best,
    fireflies: Number.isSafeInteger(source.fireflies) && source.fireflies! >= 0 ? source.fireflies! : 0,
    nightsPlayed: Number.isSafeInteger(source.nightsPlayed) && source.nightsPlayed! >= 0 ? source.nightsPlayed! : 0,
  };
}

export function moonFill(best: readonly number[]): number {
  let total = 0;
  for (let night = 1; night <= 8; night++) total += Math.max(0, Math.min(1, best[night] ?? 0));
  return total / 8;
}

export function starsFor(home: number, total: number): number {
  const fraction = total > 0 ? home / total : 0;
  return fraction >= 1 ? 3 : fraction >= 0.75 ? 2 : fraction >= 0.5 ? 1 : 0;
}

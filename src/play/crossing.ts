import { starsFor } from './arc.js';
import { FolkWorld, type Kindling } from './folk.js';
import { HazardWorld } from './hazards.js';
import { InkField } from './ink-field.js';
import { applyLevel, generateScreens, type HazardKind, type ScreenLevel } from './levels.js';
import { PlayView } from './view.js';

export interface CrossingEvent {
  kind: 'home' | 'ash' | 'screen' | 'finished' | 'warning';
  agent?: Kindling;
  screen: number;
  home: number;
  total: number;
}

export class CrossingRuntime {
  readonly hazards: HazardWorld;
  readonly levels: ScreenLevel[] = [];
  night = 1;
  screen = 0;
  candle = 1;
  home = 0;
  ash = 0;
  lost = 0;
  total = 0;
  stars = 0;
  finished = false;
  wiping = false;
  wash = 0;
  onEvent?: (event: CrossingEvent) => void;
  private elapsed = 0;
  private screenElapsed = 0;
  private warned = false;

  constructor(readonly field: InkField, readonly folk: FolkWorld, readonly view: PlayView) {
    this.hazards = new HazardWorld(field, folk);
    this.view.root.add(this.hazards.view);
    this.folk.onEvent = (kind, agent) => {
      if (kind === 'home') { this.home++; this.onEvent?.({ kind: 'home', agent, screen: this.screen, home: this.home, total: this.total }); }
      else if (kind === 'ash') { this.ash++; this.onEvent?.({ kind: 'ash', agent, screen: this.screen, home: this.home, total: this.total }); }
    };
  }

  start(night: number, seed: number, hazardsOverride?: HazardKind[], kindlingsOverride?: number): void {
    this.night = night;
    this.levels.length = 0;
    this.levels.push(...generateScreens(night, seed, hazardsOverride, kindlingsOverride));
    this.total = this.levels.reduce((count, level) => count + level.kindlings, 0);
    this.screen = 0;
    this.home = this.ash = this.lost = this.elapsed = 0;
    this.candle = 1;
    this.stars = 0;
    this.finished = this.wiping = this.warned = false;
    this.wash = 0;
    this.startScreen();
  }

  get level(): ScreenLevel { return this.levels[this.screen]; }

  update(dt: number): void {
    if (this.finished) return;
    if (this.wiping) {
      this.wash = Math.min(1, this.wash + dt / 0.8);
      if (this.wash >= 1) { this.wiping = false; this.screen++; this.startScreen(); }
      return;
    }
    this.screenElapsed += dt;
    if (this.night !== 0) {
      this.elapsed += dt;
      this.candle = Math.max(0, 1 - this.elapsed / 150);
      if (!this.warned && this.screenElapsed >= 40) {
        this.warned = true;
        this.onEvent?.({ kind: 'warning', screen: this.screen, home: this.home, total: this.total });
      }
    }
    this.hazards.update(dt);
    this.folk.update(dt);
    const resolved = this.folk.count >= this.level.kindlings
      && this.folk.homeCount + this.folk.ashCount >= this.level.kindlings;
    if (resolved || this.night !== 0 && this.screenElapsed >= 50) this.endScreen();
  }

  private startScreen(): void {
    const level = this.level;
    this.screenElapsed = 0;
    this.warned = false;
    this.wash = 0;
    applyLevel(this.field, level);
    this.folk.reset();
    this.folk.configure({ waveCount: level.kindlings });
    this.hazards.start(level);
    this.view.setLevel(level);
    this.onEvent?.({ kind: 'screen', screen: this.screen, home: this.home, total: this.total });
  }

  private endScreen(): void {
    this.lost += Math.max(0, this.level.kindlings - this.folk.homeCount - this.folk.ashCount);
    if (this.screen + 1 < this.levels.length) {
      this.wiping = true;
      this.wash = 0;
    } else {
      this.finished = true;
      this.stars = starsFor(this.home, this.total);
      this.onEvent?.({ kind: 'finished', screen: this.screen, home: this.home, total: this.total });
    }
  }
}

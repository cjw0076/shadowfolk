import { CanvasTexture, Group, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';
import { boulder, crack, crow, crowFlying, fogBank, groundLine, ledge, moonHole, spark, vineCurtain } from './props-art.js';
import { gestureInk } from './gesture-art.js';
import type { JourneyRuntime } from './runtime.js';
import type { Ability, ObstacleKind } from './generator.js';

type Sprite = Mesh<PlaneGeometry, MeshBasicMaterial>;

function texture(canvas: HTMLCanvasElement): CanvasTexture {
  const result = new CanvasTexture(canvas);
  result.colorSpace = SRGBColorSpace;
  result.generateMipmaps = false;
  result.minFilter = result.magFilter = LinearFilter;
  return result;
}

const SIZES: Record<ObstacleKind, [number, number, number]> = {
  crow: [0.22, 0.21, -0.085], vine: [0.20, 0.32, -0.035], gap: [0.18, 0.09, -0.19],
  fog: [0.36, 0.22, -0.08], ledge: [0.23, 0.27, -0.055], boulder: [0.34, 0.31, -0.05],
  crack: [0.13, 0.28, -0.045],
};
const TEXTURE_KEYS: Record<ObstacleKind, readonly string[]> = {
  crow: ['crow:0', 'crow:1', 'crow:2', 'crow:3', 'crow:4', 'crow:5'],
  vine: ['vine:0', 'vine:1'], gap: [], fog: ['fog:0', 'fog:1', 'fog:2'],
  ledge: ['ledge:0'], boulder: ['boulder:0', 'boulder:1', 'boulder:2'], crack: ['crack:0'],
};

export class JourneyView {
  readonly root = new Group();
  private readonly textures = new Map<string, CanvasTexture>();
  private readonly ground: Sprite;
  private readonly moon: Sprite;
  private readonly ember: Sprite;
  private readonly feedback: Sprite;
  private readonly obstacles: Sprite[] = [];
  private readonly solvedAt: number[] = [];
  private feedbackAt = -Infinity;
  private arrivedAt = -1;

  constructor() {
    const map = (key: string, source: HTMLCanvasElement) => this.textures.set(key, texture(source));
    map('crow:0', crow(true)); map('crow:1', crow(false));
    for (let frame = 0; frame < 4; frame++) map(`crow:${frame + 2}`, crowFlying(frame));
    map('vine:0', vineCurtain()); map('vine:1', vineCurtain(0.5));
    map('fog:0', fogBank(0)); map('fog:1', fogBank(0.5)); map('fog:2', fogBank(1));
    map('boulder:0', boulder(0)); map('boulder:1', boulder(0.65)); map('boulder:2', boulder(1));
    map('ledge:0', ledge(220)); map('crack:0', crack(136));
    map('spark:0', spark(0.35)); map('spark:1', spark(1)); map('moon', moonHole());
    for (const ability of ['bark', 'peck', 'snip', 'hop', 'fan', 'fly', 'giant', 'tiny'] as Ability[]) {
      map(`gesture:${ability}`, gestureInk(ability));
    }
    this.ground = this.sprite('ground', 1, 0.096, 5);
    this.moon = this.sprite('moon', 0.19, 0.19, 6);
    this.ember = this.sprite('spark:0', 0.055, 0.055, 8);
    this.feedback = this.sprite('gesture:bark', 0.16, 0.095, 9);
    this.feedback.visible = false;
    this.moon.position.set(0.42, -0.115, 0.003);
    this.root.visible = false;
  }

  private sprite(key: string, width: number, height: number, order: number): Sprite {
    const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      map: this.textures.get(key), transparent: true, depthWrite: false, toneMapped: false,
    }));
    mesh.scale.set(width, height, 1);
    mesh.position.z = order * 0.0004;
    mesh.renderOrder = order;
    this.root.add(mesh);
    return mesh;
  }

  start(runtime: JourneyRuntime): void {
    const gaps = runtime.plan.obstacles.filter((obstacle) => obstacle.kind === 'gap')
      .map((obstacle) => [obstacle.x + 0.5 - 0.09, obstacle.x + 0.5 + 0.09] as const);
    const oldGround = this.textures.get('ground');
    if (oldGround) oldGround.dispose();
    this.textures.set('ground', texture(groundLine(1000, gaps)));
    this.ground.material.map = this.textures.get('ground')!;
    this.ground.material.needsUpdate = true;
    this.ground.position.set(0, -0.19, 0.002);
    while (this.obstacles.length < runtime.plan.obstacles.length) {
      this.obstacles.push(this.sprite('crow:0', 1, 1, 7));
    }
    this.solvedAt.length = runtime.plan.obstacles.length;
    this.solvedAt.fill(-1);
    this.feedbackAt = -Infinity;
    this.arrivedAt = -1;
    this.feedback.visible = false;
    this.root.visible = true;
    this.update(runtime, 0);
  }

  gesture(ability: Ability, x: number, time: number): void {
    this.feedback.material.map = this.textures.get(`gesture:${ability}`)!;
    this.feedback.position.set(x + (ability === 'bark' ? -0.015 : 0),
      ability === 'hop' || ability === 'fly' ? -0.06 : ability === 'snip' || ability === 'peck' ? -0.01 : -0.075,
      0.0036);
    this.feedback.scale.set(ability === 'fan' ? 0.23 : 0.16, ability === 'fan' ? 0.135 : 0.095, 1);
    this.feedbackAt = time;
    this.feedback.visible = true;
  }

  update(runtime: JourneyRuntime, time: number): void {
    if (runtime.completed && this.arrivedAt < 0) this.arrivedAt = time;
    const celebration = this.arrivedAt < 0 ? 0 : Math.max(0, 1 - (time - this.arrivedAt) / 2);
    const moonScale = 1 + celebration * (0.16 + 0.07 * Math.sin(time * 11));
    this.moon.scale.set(0.19 * moonScale, 0.19 * moonScale, 1);
    this.ember.position.set(runtime.spark.x, runtime.spark.y, 0.0032);
    this.ember.material.map = this.textures.get(runtime.carried ? 'spark:1' : 'spark:0')!;
    this.ember.material.opacity = this.arrivedAt < 0 ? 1 : Math.max(0, 1 - (time - this.arrivedAt) / 1.5);
    const feedbackAge = time - this.feedbackAt;
    this.feedback.visible = feedbackAge >= 0 && feedbackAge < 0.8;
    if (this.feedback.visible) {
      this.feedback.material.opacity = Math.min(1, feedbackAge * 6) * Math.min(1, (0.8 - feedbackAge) * 2.5);
    }
    for (let index = 0; index < this.obstacles.length; index++) {
      const mesh = this.obstacles[index];
      const obstacle = runtime.plan.obstacles[index];
      if (!obstacle) { mesh.visible = false; continue; }
      const state = runtime.states[index];
      const sizes = SIZES[obstacle.kind];
      if (state !== 'blocked' && this.solvedAt[index] < 0) this.solvedAt[index] = time;
      const progress = this.solvedAt[index] < 0 ? 0 : Math.min(1, (time - this.solvedAt[index]) / 1.2);
      if (obstacle.kind === 'gap') { mesh.visible = false; continue; }
      const textureIndex = obstacle.kind === 'crow' && progress > 0.15 ? 2 + Math.floor(time * 9) % 4
        : obstacle.kind === 'crow' || obstacle.kind === 'vine' ? progress > 0.5 ? 1 : 0
        : obstacle.kind === 'fog' || obstacle.kind === 'boulder' ? Math.min(2, Math.floor(progress * 3)) : 0;
      const key = TEXTURE_KEYS[obstacle.kind][textureIndex];
      mesh.material.map = this.textures.get(key)!;
      mesh.material.opacity = obstacle.kind === 'crow' ? 1 - progress
        : obstacle.kind === 'fog' || obstacle.kind === 'vine' ? 1 - progress * 0.7
          : obstacle.kind === 'boulder' ? 1 - progress * 0.35 : 1;
      mesh.scale.set(sizes[0], sizes[1], 1);
      mesh.position.set(obstacle.x + (obstacle.kind === 'boulder' ? 0.14 * progress : 0),
        sizes[2] + (obstacle.kind === 'crow' ? 0.16 * progress : obstacle.kind === 'vine' ? -0.10 * progress : 0), 0.0028);
      mesh.rotation.z = obstacle.kind === 'vine' ? -0.45 * progress : obstacle.kind === 'boulder' ? -0.65 * progress : 0;
      mesh.visible = true;
    }
  }

  hide(): void { this.root.visible = false; }

  dispose(): void {
    for (const value of this.textures.values()) value.dispose();
    this.root.traverse((object) => {
      if (object instanceof Mesh) { object.geometry.dispose(); object.material.dispose(); }
    });
  }
}

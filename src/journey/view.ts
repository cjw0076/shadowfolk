import { CanvasTexture, Group, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';
import { boulder, crack, crow, crowFlying, fogBank, groundLine, ledge, moonHole, spark, vineCurtain } from './props-art.js';
import type { JourneyRuntime } from './runtime.js';
import type { JourneyObstacle, ObstacleKind } from './generator.js';

type Sprite = Mesh<PlaneGeometry, MeshBasicMaterial>;

function texture(canvas: HTMLCanvasElement): CanvasTexture {
  const result = new CanvasTexture(canvas);
  result.colorSpace = SRGBColorSpace;
  result.generateMipmaps = false;
  result.minFilter = result.magFilter = LinearFilter;
  return result;
}

const SIZES: Record<ObstacleKind, [number, number, number]> = {
  crow: [0.105, 0.099, -0.106], vine: [0.105, 0.205, -0.08], gap: [0.075, 0.075, -0.19],
  fog: [0.19, 0.12, -0.105], ledge: [0.13, 0.18, -0.09], boulder: [0.125, 0.115, -0.12],
  crack: [0.095, 0.18, -0.10],
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
  private readonly obstacles: Sprite[] = [];

  constructor() {
    const map = (key: string, source: HTMLCanvasElement) => this.textures.set(key, texture(source));
    map('crow:0', crow(true)); map('crow:1', crow(false));
    for (let frame = 0; frame < 4; frame++) map(`crow:${frame + 2}`, crowFlying(frame));
    map('vine:0', vineCurtain()); map('vine:1', vineCurtain(0.5));
    map('fog:0', fogBank(0)); map('fog:1', fogBank(0.5)); map('fog:2', fogBank(1));
    map('boulder:0', boulder(0)); map('boulder:1', boulder(0.65)); map('boulder:2', boulder(1));
    map('ledge:0', ledge(220)); map('crack:0', crack(136));
    map('spark:0', spark(0.35)); map('spark:1', spark(1)); map('moon', moonHole());
    this.ground = this.sprite('ground', 1, 0.096, 5);
    this.moon = this.sprite('moon', 0.135, 0.135, 6);
    this.ember = this.sprite('spark:0', 0.07, 0.07, 8);
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
      .map((obstacle) => [obstacle.x + 0.5 - 0.034, obstacle.x + 0.5 + 0.034] as const);
    const oldGround = this.textures.get('ground');
    if (oldGround) oldGround.dispose();
    this.textures.set('ground', texture(groundLine(1000, gaps)));
    this.ground.material.map = this.textures.get('ground')!;
    this.ground.material.needsUpdate = true;
    this.ground.position.set(0, -0.19, 0.002);
    while (this.obstacles.length < runtime.plan.obstacles.length) {
      this.obstacles.push(this.sprite('crow:0', 1, 1, 7));
    }
    this.root.visible = true;
    this.update(runtime, 0);
  }

  update(runtime: JourneyRuntime, time: number): void {
    const moonScale = runtime.completed ? 1 + 0.07 * Math.sin(time * 10) : 1;
    this.moon.scale.set(0.135 * moonScale, 0.135 * moonScale, 1);
    this.ember.position.set(runtime.spark.x, runtime.spark.y, 0.0032);
    this.ember.material.map = this.textures.get(runtime.carried ? 'spark:1' : 'spark:0')!;
    this.ember.material.opacity = runtime.completed ? Math.max(0, 1 - (time % 1)) : 1;
    for (let index = 0; index < this.obstacles.length; index++) {
      const mesh = this.obstacles[index];
      const obstacle = runtime.plan.obstacles[index];
      if (!obstacle) { mesh.visible = false; continue; }
      const state = runtime.states[index];
      const sizes = SIZES[obstacle.kind];
      const progress = state === 'blocked' ? 0 : state === 'solved' ? 1 : 2;
      if (obstacle.kind === 'gap') { mesh.visible = false; continue; }
      const textureIndex = obstacle.kind === 'crow' && progress === 2 ? 2 + Math.floor(time * 9) % 4
        : obstacle.kind === 'crow' || obstacle.kind === 'vine' ? Math.min(1, progress)
        : obstacle.kind === 'fog' || obstacle.kind === 'boulder' ? progress : 0;
      const key = TEXTURE_KEYS[obstacle.kind][textureIndex];
      mesh.material.map = this.textures.get(key)!;
      mesh.material.opacity = progress === 2 ? (obstacle.kind === 'crow' ? 0 : 0.35) : 1;
      mesh.scale.set(sizes[0], sizes[1], 1);
      mesh.position.set(obstacle.x + (progress && obstacle.kind === 'boulder' ? 0.045 * progress : 0),
        sizes[2] + (progress && obstacle.kind === 'crow' ? 0.06 * progress : 0), 0.0028);
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

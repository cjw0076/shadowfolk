import { BONES, JOINT_COUNT, PALM } from '../shadow/hand-model.js';
import { FlatHand, Mask } from '../shadow/silhouette.js';

export class InkField {
  readonly w: number;
  readonly h: number;
  readonly x0 = -0.68;
  readonly y0 = -0.48;
  readonly solid: Uint8Array;
  readonly soft: Uint8Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly staticSolid: Uint8Array;
  private readonly palm: Mask;
  private readonly palmX = new Float32Array(PALM.length);
  private readonly palmY = new Float32Array(PALM.length);
  private readonly previousX = [new Float32Array(JOINT_COUNT), new Float32Array(JOINT_COUNT)];
  private readonly previousY = [new Float32Array(JOINT_COUNT), new Float32Array(JOINT_COUNT)];
  private readonly velocityX = [new Float32Array(JOINT_COUNT), new Float32Array(JOINT_COUNT)];
  private readonly velocityY = [new Float32Array(JOINT_COUNT), new Float32Array(JOINT_COUNT)];
  private readonly seen = [false, false];

  constructor(readonly cell = 0.010) {
    this.w = Math.ceil(1.36 / cell);
    this.h = Math.ceil(0.96 / cell);
    const length = this.w * this.h;
    this.solid = new Uint8Array(length);
    this.soft = new Uint8Array(length);
    this.vx = new Float32Array(length);
    this.vy = new Float32Array(length);
    this.staticSolid = new Uint8Array(length);
    this.palm = new Mask(this.w, this.h, this.x0, this.y0, cell);
  }

  beginFrame(): void {
    this.solid.fill(0);
    this.soft.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
  }

  clearHand(side: number): void {
    if (side < 0 || side > 1 || !this.seen[side]) return;
    this.seen[side] = false;
    this.velocityX[side].fill(0);
    this.velocityY[side].fill(0);
  }

  clearStatic(): void { this.staticSolid.fill(0); }

  setStaticRect(left: number, bottom: number, right: number, top: number): void {
    const firstX = Math.max(0, Math.floor((left - this.x0) / this.cell));
    const lastX = Math.min(this.w - 1, Math.ceil((right - this.x0) / this.cell) - 1);
    const firstY = Math.max(0, Math.floor((bottom - this.y0) / this.cell));
    const lastY = Math.min(this.h - 1, Math.ceil((top - this.y0) / this.cell) - 1);
    for (let row = firstY; row <= lastY; row++) {
      for (let column = firstX; column <= lastX; column++) this.staticSolid[row * this.w + column] = 1;
    }
  }

  index(x: number, y: number): number {
    const column = Math.floor((x - this.x0) / this.cell);
    const row = Math.floor((y - this.y0) / this.cell);
    return column >= 0 && column < this.w && row >= 0 && row < this.h ? row * this.w + column : -1;
  }

  sample(x: number, y: number): number {
    const index = this.index(x, y);
    return index < 0 ? 0 : this.staticSolid[index] ? 1 : this.solid[index] ? 1 : this.soft[index] ? 2 : 0;
  }

  addHand(flat: FlatHand, scale: number, dt: number, side: number): void {
    if (!flat.valid || side < 0 || side > 1) { this.clearHand(side); return; }
    const lastX = this.previousX[side], lastY = this.previousY[side];
    const jointVX = this.velocityX[side], jointVY = this.velocityY[side];
    const validDt = Math.max(1 / 240, dt);
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      const rawX = this.seen[side] ? (flat.x[joint] - lastX[joint]) / validDt : 0;
      const rawY = this.seen[side] ? (flat.y[joint] - lastY[joint]) / validDt : 0;
      jointVX[joint] = Math.max(-2.5, Math.min(2.5, (jointVX[joint] + rawX) * 0.5));
      jointVY[joint] = Math.max(-2.5, Math.min(2.5, (jointVY[joint] + rawY) * 0.5));
      lastX[joint] = flat.x[joint]; lastY[joint] = flat.y[joint];
    }
    this.seen[side] = true;
    const isSoft = scale >= 1.4;
    const band = isSoft ? 0.03 : Math.max(0, Math.min(0.03, (scale - 1.2) * 0.15));
    this.palm.clear();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let index = 0; index < PALM.length; index++) {
      const x = flat.x[PALM[index]], y = flat.y[PALM[index]];
      this.palmX[index] = x;
      this.palmY[index] = y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    this.palm.polygon(this.palmX, this.palmY, PALM.length);
    const palmFirstColumn = Math.max(0, Math.floor((minX - this.x0) / this.cell));
    const palmLastColumn = Math.min(this.w - 1, Math.ceil((maxX - this.x0) / this.cell));
    const palmFirstRow = Math.max(0, Math.floor((minY - this.y0) / this.cell));
    const palmLastRow = Math.min(this.h - 1, Math.ceil((maxY - this.y0) / this.cell));
    for (let row = palmFirstRow; row <= palmLastRow; row++) {
      for (let column = palmFirstColumn; column <= palmLastColumn; column++) {
        const index = row * this.w + column;
        if (!this.palm.data[index]) continue;
        if (isSoft) {
          this.soft[index] = 1;
          this.vx[index] = jointVX[0];
          this.vy[index] = jointVY[0];
        }
        else { this.solid[index] = 1; this.vx[index] = jointVX[0]; this.vy[index] = jointVY[0]; }
      }
    }
    for (let bone = 0; bone < BONES.length; bone++) {
      const first = BONES[bone][0], second = BONES[bone][1];
      const ax = flat.x[first], ay = flat.y[first], bx = flat.x[second], by = flat.y[second];
      const firstRadius = flat.r[first], secondRadius = flat.r[second];
      const reach = Math.max(firstRadius, secondRadius) + band;
      const firstColumn = Math.max(0, Math.floor((Math.min(ax, bx) - reach - this.x0) / this.cell));
      const lastColumn = Math.min(this.w - 1, Math.ceil((Math.max(ax, bx) + reach - this.x0) / this.cell));
      const firstRow = Math.max(0, Math.floor((Math.min(ay, by) - reach - this.y0) / this.cell));
      const lastRow = Math.min(this.h - 1, Math.ceil((Math.max(ay, by) + reach - this.y0) / this.cell));
      const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy || 1e-12;
      for (let row = firstRow; row <= lastRow; row++) {
        const y = this.y0 + (row + 0.5) * this.cell;
        for (let column = firstColumn; column <= lastColumn; column++) {
          const x = this.x0 + (column + 0.5) * this.cell;
          const projection = ((x - ax) * dx + (y - ay) * dy) / length2;
          const along = Math.max(0, Math.min(1, projection));
          const distanceX = x - ax - dx * along, distanceY = y - ay - dy * along;
          const radius = firstRadius + (secondRadius - firstRadius) * along;
          const distance2 = distanceX * distanceX + distanceY * distanceY;
          const index = row * this.w + column;
          if (distance2 <= radius * radius) {
            if (isSoft) {
              this.soft[index] = 1;
              this.vx[index] = jointVX[first] + (jointVX[second] - jointVX[first]) * along;
              this.vy[index] = jointVY[first] + (jointVY[second] - jointVY[first]) * along;
            }
            else {
              this.solid[index] = 1;
              this.vx[index] = jointVX[first] + (jointVX[second] - jointVX[first]) * along;
              this.vy[index] = jointVY[first] + (jointVY[second] - jointVY[first]) * along;
            }
          } else if (band > 0 && distance2 <= (radius + band) * (radius + band)) this.soft[index] = 1;
        }
      }
    }
    if (band > 0 && !isSoft) {
      const radiusCells = Math.ceil(band / this.cell);
      for (let row = Math.max(radiusCells, palmFirstRow); row <= Math.min(this.h - 1 - radiusCells, palmLastRow); row++) {
        for (let column = Math.max(radiusCells, palmFirstColumn); column <= Math.min(this.w - 1 - radiusCells, palmLastColumn); column++) {
          const index = row * this.w + column;
          if (!this.palm.data[index]) continue;
          for (let offsetY = -radiusCells; offsetY <= radiusCells; offsetY++) {
            for (let offsetX = -radiusCells; offsetX <= radiusCells; offsetX++) {
              if (offsetX * offsetX + offsetY * offsetY > radiusCells * radiusCells) continue;
              this.soft[index + offsetY * this.w + offsetX] = 1;
            }
          }
        }
      }
    }
  }
}

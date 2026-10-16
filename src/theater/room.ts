/**
 * Reading the real room: find a table under the lantern so the theater can
 * stand on it, and a wall beyond the screen where woken shadows can live.
 * Inputs are the planes and meshes the WebXR scene model reports (Quest
 * Space Setup); everything runs once per placement, never per frame.
 */
import { Box3, Matrix4, Object3D, Quaternion, Vector3 } from '@iwsdk/core';

export interface Surface {
  label: string;
  /** World pose of the plane (plane space: +Y is the normal). */
  object: Object3D;
  /** Plane-space outline (x, z), when the surface is a detected plane. */
  polygon?: readonly DOMPointReadOnly[];
  /** World bounds, when the surface is a detected mesh. */
  box?: Box3;
  orientation: 'horizontal' | 'vertical' | 'unknown';
}

/** Lantern centre sits this high above the table top when it stands on it. */
export const LANTERN_ON_TABLE = 0.132;
/** Distance of the screen plane's feet from its centre, downwards. */
export const SCREEN_FOOT_DROP = 0.372;

const inv = new Matrix4();
const local = new Vector3();
const nrm = new Vector3();
const q = new Quaternion();
const tmp = new Vector3();

function insidePolygon(poly: readonly DOMPointReadOnly[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (x, z) to the polygon edge; positive inside. */
function polygonClearance(poly: readonly DOMPointReadOnly[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x, az = poly[j].z, bx = poly[i].x, bz = poly[i].z;
    const ex = bx - ax, ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez + 1e-12)));
    const dx = ax + ex * t - x, dz = az + ez * t - z;
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return insidePolygon(poly, x, z) ? best : -best;
}

/** How far a world point sits inside the surface's footprint (metres, <0 outside). */
function clearance(s: Surface, p: Vector3): number {
  if (s.polygon && s.polygon.length >= 3) {
    s.object.updateMatrixWorld(true);
    local.copy(p).applyMatrix4(inv.copy(s.object.matrixWorld).invert());
    return polygonClearance(s.polygon, local.x, local.z);
  }
  if (s.box) {
    const b = s.box;
    return Math.min(p.x - b.min.x, b.max.x - p.x, p.z - b.min.z, b.max.z - p.z);
  }
  return -Infinity;
}

function normalOf(s: Surface, out: Vector3): Vector3 {
  s.object.getWorldQuaternion(q);
  return out.set(0, 1, 0).applyQuaternion(q);
}

function topOf(s: Surface): number {
  if (s.box) return s.box.max.y;
  return s.object.getWorldPosition(tmp).y;
}

export interface TableFit {
  top: number;
  /** Move the rig this far along the facing direction to stand on the table. */
  shift: number;
  /** Both screen feet rest on the table too. */
  screenOnTable: boolean;
  label: string;
}

/**
 * A table under the default lantern spot. The rig keeps its exact geometry
 * (templates are baked for it); only its height, and up to 20 cm of depth,
 * adapt so the lantern and the screen's feet rest on the surface.
 */
export function fitTable(
  surfaces: readonly Surface[], lantern: Vector3, fwd: Vector3, right: Vector3, halfFeet: number, lightToScreen: number,
  shifts: readonly number[] = [0, -0.05, 0.05, -0.1, 0.1, -0.15, -0.2],
): TableFit | null {
  let best: (TableFit & { rank: number }) | null = null;
  const p = new Vector3();
  for (const s of surfaces) {
    if (s.label === 'floor' || s.label === 'ceiling') continue;
    if (s.orientation === 'vertical') continue;
    if (!s.box && normalOf(s, nrm).y < 0.9) continue;
    const top = topOf(s);
    const dy = top + LANTERN_ON_TABLE - lantern.y;
    if (dy < -0.45 || dy > 0.12) continue;
    for (const sh of shifts) {
      p.copy(lantern).addScaledVector(fwd, sh);
      if (clearance(s, p) < 0.04) continue;
      let feet = 0;
      for (const side of [-1, 1]) {
        p.copy(lantern).addScaledVector(fwd, sh + lightToScreen).addScaledVector(right, side * halfFeet);
        if (clearance(s, p) > 0.02) feet++;
      }
      // Prefer labelled tables, then both feet supported, then the smallest move.
      const rank = (s.label === 'table' ? 100 : 0) + feet * 10 - Math.abs(sh) * 20 - Math.abs(dy) * 5;
      if (!best || rank > best.rank) best = { top, shift: sh, screenOnTable: feet === 2, label: s.label, rank };
    }
  }
  if (!best) return null;
  const { rank: _r, ...fit } = best;
  void _r;
  return fit;
}

export interface WallFit {
  /** Where the lantern's beam through the screen centre meets the wall. */
  point: Vector3;
  /** Wall basis: normal faces the player; right/up span the wall. */
  normal: Vector3;
  right: Vector3;
  up: Vector3;
  distance: number;
  label: string;
  surface: Surface;
}

/** The wall the lantern light falls on behind the screen, if the room has one. */
export function fitWall(surfaces: readonly Surface[], lantern: Vector3, screenCentre: Vector3, fwd: Vector3, minT = 0.08): WallFit | null {
  const dir = new Vector3().subVectors(screenCentre, lantern).normalize();
  let best: WallFit | null = null;
  const hit = new Vector3();
  for (const s of surfaces) {
    if (!s.polygon || s.orientation === 'horizontal') continue;
    const n = normalOf(s, new Vector3());
    if (Math.abs(n.y) > 0.3) continue;
    if (n.dot(fwd) > 0) n.negate(); // face the player
    if (n.dot(fwd) > -0.5) continue;
    const p0 = s.object.getWorldPosition(new Vector3());
    const denom = dir.dot(n);
    if (Math.abs(denom) < 1e-3) continue;
    const t = tmp.subVectors(p0, screenCentre).dot(n) / denom;
    if (t < minT || t > 4) continue;
    hit.copy(screenCentre).addScaledVector(dir, t);
    if (clearance(s, hit) < 0.05) continue;
    // A wall beats a window or picture hung on it (they are coplanar, but smaller).
    const penalty = s.label === 'wall' ? 0 : 0.25;
    if (best && t + penalty >= best.distance + (best.label === 'wall' ? 0 : 0.25)) continue;
    const up = new Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const right = new Vector3().crossVectors(up, n).normalize();
    best = { point: hit.clone(), normal: n, right, up, distance: t, label: s.label, surface: s };
  }
  return best;
}

/** Signed clearance of a wall-local point (metres along right/up from the hit point). */
export function wallClearance(w: WallFit, x: number, y: number): number {
  const p = new Vector3().copy(w.point).addScaledVector(w.right, x).addScaledVector(w.up, y);
  return clearance(w.surface, p);
}

const SKIP_PIN = new Set(['window', 'window frame', 'door frame', 'screen', 'wall art', 'other']);

export interface PinFit {
  wall: WallFit;
  /** Distance from the head to the paper plane along the new facing. */
  depth: number;
}

/**
 * A wall straight ahead, close enough that the paper can be pinned to it
 * while the lantern keeps its baked distance from the paper.
 */
export function fitPinWall(
  surfaces: readonly Surface[], head: Vector3, fwd: Vector3, paperY: number,
  lightToScreen: number, minAhead: number, maxAhead: number, standoff: number,
): PinFit | null {
  let best: PinFit | null = null;
  const origin = new Vector3(head.x, paperY, head.z);
  for (const s of surfaces) {
    if (!s.polygon || s.orientation === 'horizontal' || SKIP_PIN.has(s.label)) continue;
    const n = normalOf(s, new Vector3());
    if (Math.abs(n.y) > 0.2) continue;
    n.y = 0;
    n.normalize();
    if (n.dot(fwd) > 0) n.negate();
    if (n.dot(fwd) > -0.75) continue; // only walls we roughly face
    const p0 = s.object.getWorldPosition(new Vector3());
    const depth = tmp.subVectors(p0, origin).dot(n) * -1; // perpendicular distance to the wall
    const ahead = depth - standoff - lightToScreen;        // where the lantern would stand
    if (ahead < minAhead || ahead > maxAhead) continue;
    const face = new Vector3().copy(n).negate();
    const point = new Vector3().copy(origin).addScaledVector(face, depth);
    if (clearance(s, point) < 0.22) continue; // the paper must sit on the wall, not off its edge
    if (best && depth >= best.depth) continue;
    const up = new Vector3(0, 1, 0);
    const right = new Vector3().crossVectors(up, n).normalize();
    best = { wall: { point, normal: n, right, up, distance: 0, label: s.label, surface: s }, depth };
  }
  return best;
}

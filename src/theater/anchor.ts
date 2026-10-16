/**
 * Persistent spatial anchor for the theater. Once the lantern settles on a
 * real table it is anchored there; the next session restores the anchor and
 * the theater is waiting on the same table. Everything is optional: without
 * anchor support the theater simply places itself again.
 */
import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core';

const KEY = 'shadowfolk.rig-anchor.v1';

interface PersistentAnchor extends XRAnchor {
  requestPersistentHandle?: () => Promise<string>;
}
interface PersistentSession extends XRSession {
  restorePersistentAnchor?: (uuid: string) => Promise<XRAnchor>;
  deletePersistentAnchor?: (uuid: string) => Promise<void>;
}

function read(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function write(v: string | null): void {
  try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export class RigAnchor {
  private anchor: XRAnchor | null = null;
  private session: XRSession | null = null;
  private busy = false;
  private m = new Matrix4();
  private inv = new Matrix4();
  private s = new Vector3();

  get ready(): boolean { return this.anchor !== null; }
  get hasSaved(): boolean { return read() !== null; }

  /** Ask the runtime for the anchor saved by an earlier session. */
  async restore(session: XRSession): Promise<boolean> {
    this.session = session;
    const uuid = read();
    const ps = session as PersistentSession;
    if (!uuid || !ps.restorePersistentAnchor || this.busy) return false;
    this.busy = true;
    try {
      const a = await ps.restorePersistentAnchor(uuid);
      if (this.session !== session) { a?.delete?.(); return false; }
      this.anchor = a ?? null;
      return this.anchor !== null;
    } catch {
      write(null);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Anchor the rig at a world pose (world = player matrix x reference space). */
  async create(frame: XRFrame, ref: XRReferenceSpace, player: Matrix4, pos: Vector3, quat: Quaternion): Promise<void> {
    if (!frame.createAnchor || this.busy) return;
    const session = frame.session as PersistentSession;
    this.busy = true;
    try {
      // World pose -> reference-space pose.
      this.m.compose(pos, quat, this.s.set(1, 1, 1)).premultiply(this.inv.copy(player).invert());
      const p = new Vector3(), q = new Quaternion();
      this.m.decompose(p, q, this.s);
      const a = await frame.createAnchor(
        new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), ref,
      ) as PersistentAnchor;
      if (session !== this.session && this.session !== null) { a.delete?.(); return; }
      this.session = session;
      this.release();
      this.anchor = a;
      const old = read();
      if (a.requestPersistentHandle) {
        const uuid = await a.requestPersistentHandle();
        if (old && old !== uuid) await session.deletePersistentAnchor?.(old).catch(() => undefined);
        write(uuid);
      }
    } catch {
      /* anchors are a bonus; the theater works without them */
    } finally {
      this.busy = false;
    }
  }

  /** Current world pose of the anchor; false if it is not tracked this frame. */
  pose(frame: XRFrame, ref: XRReferenceSpace, player: Matrix4, outPos: Vector3, outQuat: Quaternion): boolean {
    if (!this.anchor) return false;
    let pose: XRPose | undefined;
    try { pose = frame.getPose(this.anchor.anchorSpace, ref) ?? undefined; } catch { pose = undefined; }
    if (!pose) return false;
    this.m.fromArray(pose.transform.matrix).premultiply(player);
    this.m.decompose(outPos, outQuat, this.s);
    return true;
  }

  /** Forget the live anchor (the saved one stays for the next session). */
  release(): void {
    try { this.anchor?.delete(); } catch { /* ignore */ }
    this.anchor = null;
  }

  endSession(): void {
    this.anchor = null;
    this.session = null;
    this.busy = false;
  }
}

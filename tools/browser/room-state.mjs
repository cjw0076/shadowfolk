// Dump what the theater learned about the emulated room: surfaces, table fit, wall fit, rig pose.
export default async function run({ page, frame }) {
  const target = frame ?? page;
  return await target.evaluate(() => {
    const th = window.__theater;
    if (!th) return { error: 'no __theater (not a dev build?)' };
    const r3 = (v) => v && [v.x, v.y, v.z].map((n) => +n.toFixed(3));
    const surfaces = th.surfaces().map((s) => {
      const p = s.object.getWorldPosition(new s.object.position.constructor());
      return { label: s.label, orient: s.orientation, pos: r3(p), poly: s.polygon?.length ?? 0, box: s.box ? [r3(s.box.min), r3(s.box.max)] : undefined };
    });
    return {
      immersive: th.immersive, placed: th.placed, restore: th.restore, anchored: th.anchored,
      head: r3(th.camera.getWorldPosition(new th.lanternPos.constructor())),
      lantern: r3(th.lanternPos), screen: r3(th.screenCentre), fwd: r3(th.fwd),
      table: th.table, mode: th.mode, settling: !!th.settle, wallActive: th.wall.active, wallPoint: r3(th.wall.fit?.point), wallDist: th.wall.fit?.distance,
      wallLabel: th.wall.fit?.label, slots: th.wall.slots, residents: th.wall.residents?.map((r) => r.id),
      fitUntil: th.fitUntil, now: th.now, surfaces,
    };
  });
}

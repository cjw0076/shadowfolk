export default async function run({ page, frame }) {
  const t = frame ?? page;
  return await t.evaluate(() => {
    const th = window.__theater;
    const m = th.dim.mesh;
    return { visible: m.visible, amount: m.material.uniforms.uAmount.value, parent: m.parent?.name || m.parent?.type, inScene: !!th.scene.getObjectById(m.id),
      sessionAt: th.sessionAt, anim: th.animationTime, lit: th.lit, immersive: th.immersive, pos: [m.position.x, m.position.y, m.position.z].map(v => +v.toFixed(2)) };
  });
}

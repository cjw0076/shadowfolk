export default async function run({ page, frame }) {
  const t = frame ?? page;
  return await t.evaluate(() => { const th = window.__theater; return { phase: th.phase, phaseTime: +th.phaseTime.toFixed(2), step: th.step, score: +th.score.toFixed(3), immersive: th.immersive, placed: th.placed, demo: th.demoHand.valid, lantern: [th.lanternPos.x, th.lanternPos.y, th.lanternPos.z].map(v=>+v.toFixed(3)) }; });
}

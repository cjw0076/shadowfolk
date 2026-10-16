// Count animation frames in the app frame over 3 seconds.
export default async function run({ page, frame }) {
  const t = frame ?? page;
  return await t.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res({ fps: +(n / 3).toFixed(1) }); };
    requestAnimationFrame(tick);
  }));
}

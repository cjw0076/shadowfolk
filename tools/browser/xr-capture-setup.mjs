// Managed browser: load the app frame in capture mode with demo hands and a pinned day (env XR_PARAMS), bigger viewport.
export default async function run({ page, frame }) {
  const target = frame ?? page;
  await page.setViewportSize({ width: Number(process.env.XR_W ?? 1600), height: Number(process.env.XR_H ?? 900) }).catch(() => {});
  const url = new URL(target.url());
  for (const k of [...url.searchParams.keys()]) url.searchParams.delete(k);
  for (const kv of (process.env.XR_PARAMS ?? 'capture&demo').split('&')) { const [k, v = ''] = kv.split('='); url.searchParams.set(k, v); }
  if (process.env.XR_STORAGE) await target.evaluate((s) => { localStorage.clear(); for (const [k, v] of Object.entries(JSON.parse(s))) localStorage.setItem(k, JSON.stringify(v)); }, process.env.XR_STORAGE);
  await target.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const vp = page.viewportSize();
  return { frame: target.url(), viewport: vp, capture: await target.evaluate(() => !!window.__capture) };
}

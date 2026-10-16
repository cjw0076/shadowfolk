// Managed browser: load the app frame in capture mode with demo hands and a pinned day (env XR_PARAMS), bigger viewport.
export default async function run({ page, frame, cdp }) {
  const target = frame ?? page;
  // The editor shell fixes the app frame's size; render it at a higher device pixel ratio instead.
  const dpr = Number(process.env.XR_DPR ?? 1);
  const vp = page.viewportSize() ?? { width: 780, height: 493 };
  if (cdp) await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: dpr, mobile: false }).catch(() => {});
  const url = new URL(target.url());
  for (const k of [...url.searchParams.keys()]) url.searchParams.delete(k);
  for (const kv of (process.env.XR_PARAMS ?? 'capture&demo').split('&')) { const [k, v = ''] = kv.split('='); url.searchParams.set(k, v); }
  if (process.env.XR_STORAGE) await target.evaluate((s) => { localStorage.clear(); for (const [k, v] of Object.entries(JSON.parse(s))) localStorage.setItem(k, JSON.stringify(v)); }, process.env.XR_STORAGE);
  await target.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  return { frame: target.url(), dpr: await target.evaluate(() => window.devicePixelRatio), capture: await target.evaluate(() => !!window.__capture) };
}

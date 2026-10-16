// Fresh player: clear saved progress and the rig anchor, then load the app frame with ?demo.
export default async function run({ page, frame }) {
  const target = frame ?? page;
  await target.evaluate(() => { localStorage.removeItem('shadow-theater.v1'); localStorage.removeItem('shadowfolk.rig-anchor.v1'); });
  const url = new URL(target.url());
  url.searchParams.set('demo', '1');
  await target.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  return { frame: target.url() };
}

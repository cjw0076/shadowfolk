// Load ?demo as a returning player who has finished FILM_NIGHTS nights (default 1), with no anchor.
export default async function run({ page, frame }) {
  const target = frame ?? page;
  const nights = Number(process.env.FILM_NIGHTS ?? 1);
  await target.evaluate((n) => {
    localStorage.setItem('shadow-theater.v1', JSON.stringify({ nights: n, woken: { peacock: 1, rabbit: 1, snail: 1, fish: 1, duck: 1 }, order: ['peacock', 'rabbit', 'snail', 'fish', 'duck'] }));
    localStorage.removeItem('shadowfolk.rig-anchor.v1');
  }, nights);
  const url = new URL(target.url());
  url.searchParams.set('demo', '1');
  await target.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const order = await target.evaluate(() => window.__theater.order.map((i) => window.__theater.baked[i].def.id));
  return { ok: true, order };
}

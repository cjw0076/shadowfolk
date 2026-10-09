// Point the managed app frame at ?demo (scripted puppet hand) and report URLs.
export default async function run({ page, frame }) {
  const target = frame ?? page;
  const url = new URL(target.url());
  url.searchParams.set('demo', '1');
  await target.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  return { page: page.url(), frame: target.url(), frames: page.frames().map((f) => f.url()) };
}

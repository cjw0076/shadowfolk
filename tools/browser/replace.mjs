// Re-run session placement as if XR had just started (after moving the emulated headset).
export default async function run({ page, frame }) {
  const target = frame ?? page;
  return await target.evaluate(() => {
    const th = window.__theater;
    th.endSession();
    th.beginSession();
    return { ok: true, restore: th.restore };
  });
}

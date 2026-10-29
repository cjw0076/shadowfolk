/** A wrist sample in seconds and metres along the paper's horizontal axis. */
export interface WaveSample { t: number; x: number; open: boolean }

/** An open palm making two deliberate lateral reversals in a 1.5 s window. */
export function detectWave(history: readonly WaveSample[]): boolean {
  if (history.length < 5) return false;
  const end = history[history.length - 1].t;
  let direction = 0, reversals = 0, run = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1], next = history[i];
    if (next.t < end - 1.5 || !prev.open || !next.open) {
      direction = 0; run = 0; reversals = 0;
      continue;
    }
    const dt = next.t - prev.t;
    if (dt <= 0 || dt > 0.25) { direction = 0; run = 0; reversals = 0; continue; }
    const dx = next.x - prev.x;
    if (Math.abs(dx / dt) <= 0.25) continue;
    const sign = Math.sign(dx);
    if (direction && sign !== direction) {
      if (run >= 0.035) reversals++;
      run = 0;
    }
    direction = sign;
    run += Math.abs(dx);
    if (reversals >= 2 && run >= 0.035) return true;
  }
  return false;
}

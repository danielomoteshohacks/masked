/** Helpers shared by the engine tests: synthetic signals and level meters. */

export function sine(hz: number, dbfs: number, sampleRate: number, seconds: number): Float32Array {
  const amplitude = Math.pow(10, dbfs / 20);
  const out = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

export function add(...signals: Float32Array[]): Float32Array {
  const out = new Float32Array(signals[0]?.length ?? 0);
  for (const s of signals) for (let i = 0; i < out.length; i++) out[i] += s[i];
  return out;
}

/**
 * Level of one frequency in dBFS (sine amplitude 1 = 0 dBFS), measured by
 * correlating with a sine and cosine under a Hann window over the middle half
 * of the signal. The long window gives ~1 Hz resolution, so a 1 kHz tone does
 * not leak into a measurement at 1.1 kHz, and skipping the edges ignores any
 * start-up effects.
 */
export function toneLevelDb(signal: Float32Array, hz: number, sampleRate: number): number {
  const start = Math.floor(signal.length / 4);
  const end = Math.floor((3 * signal.length) / 4);
  const n = end - start;
  let c = 0;
  let s = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const phase = (2 * Math.PI * hz * (start + i)) / sampleRate;
    c += signal[start + i] * w * Math.cos(phase);
    s += signal[start + i] * w * Math.sin(phase);
    wsum += w;
  }
  const amplitude = (2 * Math.hypot(c, s)) / wsum;
  return 20 * Math.log10(amplitude + 1e-20);
}

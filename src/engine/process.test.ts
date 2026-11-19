import { describe, expect, it } from 'vitest';
import { processChannels } from './process';
import { add, sine, toneLevelDb } from './test-signals';

const SR = 44100;

/** Error energy relative to signal energy, in dB. */
function errorDb(reference: Float32Array, test: Float32Array): number {
  let signal = 0;
  let error = 0;
  for (let i = 0; i < reference.length; i++) {
    signal += reference[i] * reference[i];
    error += (reference[i] - test[i]) ** 2;
  }
  return 10 * Math.log10(error / signal + 1e-30);
}

/** Deterministic pseudo-random noise so failures are reproducible. */
function noise(length: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = amplitude * (state / 2 ** 32 - 0.5) * 2;
  }
  return out;
}

describe('processChannels', () => {
  it('reconstructs the input when removal is disabled (error below -80 dB)', () => {
    // Broadband noise plus a tone, at an odd length that is not a multiple
    // of the hop, so the padded edges are exercised too.
    const x = add(noise(SR + 777, 0.3), sine(440, -12, SR, (SR + 777) / SR));
    const result = processChannels([x], SR, { offsetDb: 0, removal: false });
    expect(result.processed[0].length).toBe(x.length);
    expect(errorDb(x, result.processed[0])).toBeLessThan(-80);
  });

  it('removes a quiet tone hidden just above a loud one (1 kHz at -10 dBFS, 1.1 kHz at -50 dBFS)', () => {
    const x = add(sine(1000, -10, SR, 2), sine(1100, -50, SR, 2));
    const { processed } = processChannels([x], SR, { offsetDb: 0 });
    // The masker itself must survive essentially untouched...
    expect(toneLevelDb(processed[0], 1000, SR)).toBeCloseTo(-10, 1);
    // ...while the masked tone drops by at least 30 dB (measured: about 68 dB).
    expect(toneLevelDb(processed[0], 1100, SR)).toBeLessThan(-80);
  });

  it('keeps a quiet tone far from the masker (1 kHz at -10 dBFS, 4 kHz at -50 dBFS)', () => {
    const x = add(sine(1000, -10, SR, 2), sine(4000, -50, SR, 2));
    const { processed } = processChannels([x], SR, { offsetDb: 0 });
    // Nine Bark away, the 1 kHz tone's masking has fallen off by ~80 dB,
    // so the 4 kHz tone is well above threshold and must be kept.
    expect(toneLevelDb(processed[0], 4000, SR)).toBeCloseTo(-50, 1);
    expect(toneLevelDb(processed[0], 1000, SR)).toBeCloseTo(-10, 1);
  });

  it('turns silence into silence with no NaNs', () => {
    const x = new Float32Array(SR);
    const result = processChannels([x, x.slice()], SR, { offsetDb: 0 });
    for (const channel of [...result.processed, ...result.removed]) {
      expect(channel.every((v) => v === 0)).toBe(true);
    }
    expect(result.percentRemoved).toBe(0);
  });

  it('removes more energy as the offset increases', () => {
    const x = add(noise(SR, 0.05, 7), sine(1000, -10, SR, 1), sine(1100, -45, SR, 1));
    const gentle = processChannels([x], SR, { offsetDb: -10 }).percentRemoved;
    const standard = processChannels([x], SR, { offsetDb: 0 }).percentRemoved;
    const aggressive = processChannels([x], SR, { offsetDb: 10 }).percentRemoved;
    expect(gentle).toBeLessThan(standard);
    expect(standard).toBeLessThan(aggressive);
  });

  it('applies the same mono-derived mask to every channel', () => {
    // Identical channels must stay identical, and processed + removed must
    // add back up to the original on each channel.
    const left = add(sine(1000, -10, SR, 1), sine(1100, -50, SR, 1));
    const result = processChannels([left, left.slice()], SR, { offsetDb: 0 });
    expect(result.processed[1]).toEqual(result.processed[0]);
    for (let i = 0; i < left.length; i += 97) {
      expect(result.processed[0][i] + result.removed[0][i]).toBeCloseTo(left[i], 6);
    }
  });
});

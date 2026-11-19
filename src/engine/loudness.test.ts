import { describe, expect, it } from 'vitest';
import { applyGain, integratedLoudness, kWeightingFilters, matchLoudness, PEAK_CEILING, samplePeak } from './loudness';
import { processChannels } from './process';
import { add, sine } from './test-signals';

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

describe('kWeightingFilters', () => {
  it('reproduces the 48 kHz coefficients printed in BS.1770', () => {
    const [shelf, highPass] = kWeightingFilters(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 9);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 9);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 9);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 9);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 9);
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 9);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 9);
  });
});

describe('integratedLoudness', () => {
  it.each([48000, 44100])('reads a 0 dBFS 1 kHz sine as -3.01 LUFS at %i Hz', (sr) => {
    expect(integratedLoudness([sine(1000, 0, sr, 5)], sr)).toBeCloseTo(-3.01, 1);
  });

  it('follows level changes dB for dB', () => {
    const sr = 48000;
    expect(integratedLoudness([sine(1000, -20, sr, 3)], sr)).toBeCloseTo(-23.01, 1);
  });

  it('ignores silence through the absolute gate', () => {
    const sr = 48000;
    expect(integratedLoudness([new Float32Array(sr * 2)], sr)).toBe(-Infinity);
    // 3 s of tone then 3 s of silence: silent blocks are gated out, so the
    // result stays close to the tone alone (only the partial blocks at the
    // boundary pull it down slightly).
    const toneThenSilence = concat(sine(1000, 0, sr, 3), new Float32Array(sr * 3));
    expect(integratedLoudness([toneThenSilence], sr)).toBeGreaterThan(-3.4);
  });

  it('ignores a much quieter section through the relative gate', () => {
    const sr = 48000;
    const loudThenQuiet = concat(sine(1000, 0, sr, 3), sine(1000, -30, sr, 3));
    expect(integratedLoudness([loudThenQuiet], sr)).toBeGreaterThan(-3.4);
  });
});

describe('matchLoudness', () => {
  it('matches engine output to the original within 0.1 LU', () => {
    const sr = 44100;
    let seed = 3;
    const noise = new Float32Array(sr * 3).map(() => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return 0.1 * (seed / 2 ** 32 - 0.5);
    });
    const original = [add(noise, sine(220, -12, sr, 3), sine(3000, -30, sr, 3))];
    const processed = processChannels(original, sr, { offsetDb: 15 }).processed;

    const match = matchLoudness(original, processed, sr);
    applyGain(processed, match.gain);
    const matched = integratedLoudness(processed, sr);
    expect(Math.abs(matched - match.originalLufs)).toBeLessThan(0.1);
    expect(match.processedLufs).toBeLessThan(match.originalLufs);
  });

  it('never lets either version clip after gain matching', () => {
    // A near-full-scale original against a much quieter "processed" version:
    // matching needs about +12 dB of gain, which would push it far past 0 dBFS.
    const sr = 44100;
    const original = [sine(1000, -0.1, sr, 2)];
    const processed = [sine(1000, -12, sr, 2)];
    const match = matchLoudness(original, processed, sr);

    expect(match.gain).toBeGreaterThan(3);
    expect(match.headroom).toBeLessThan(1);
    const playedOriginal = samplePeak(original) * match.headroom;
    const playedProcessed = samplePeak(processed) * match.gain * match.headroom;
    expect(playedOriginal).toBeLessThanOrEqual(PEAK_CEILING + 1e-9);
    expect(playedProcessed).toBeLessThanOrEqual(PEAK_CEILING + 1e-9);
  });

  it('leaves silence alone instead of producing an infinite gain', () => {
    const silent = [new Float32Array(44100)];
    const match = matchLoudness(silent, [new Float32Array(44100)], 44100);
    expect(match.gain).toBe(1);
    expect(match.headroom).toBe(1);
  });
});

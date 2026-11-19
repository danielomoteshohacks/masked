import { describe, expect, it } from 'vitest';
import { FFT } from './fft';
import { absoluteThresholdSpl, hzToBark, powerToSpl, schroederSpreadingDb, splToPower } from './masking';
import { mixToMono } from './mono';
import { sqrtHannWindow } from './stft';

describe('FFT', () => {
  it('finds a cosine in the right bin and inverts back to the input', () => {
    const n = 64;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    const original = re.slice();

    fft.transform(re, im);
    // A unit cosine puts N/2 in bin 5 and its mirror, bin N-5.
    expect(re[5]).toBeCloseTo(n / 2, 9);
    expect(re[n - 5]).toBeCloseTo(n / 2, 9);
    expect(Math.abs(re[6])).toBeLessThan(1e-9);

    fft.transform(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(original[i], 12);
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => new FFT(1000)).toThrow();
  });
});

describe('sqrt-Hann window', () => {
  it('squares to a Hann window that sums to 1 at 50% overlap', () => {
    const n = 2048;
    const w = sqrtHannWindow(n);
    for (let i = 0; i < n / 2; i++) {
      expect(w[i] * w[i] + w[i + n / 2] * w[i + n / 2]).toBeCloseTo(1, 12);
    }
  });
});

describe('psychoacoustic formulas', () => {
  it('maps 1 kHz to about 8.5 Bark', () => {
    expect(hzToBark(1000)).toBeCloseTo(8.51, 1);
  });

  it('puts the threshold of hearing near 3.4 dB SPL at 1 kHz and lowest around 3-4 kHz', () => {
    expect(absoluteThresholdSpl(1000)).toBeCloseTo(3.37, 1);
    expect(absoluteThresholdSpl(3300)).toBeLessThan(absoluteThresholdSpl(1000));
    expect(absoluteThresholdSpl(100)).toBeGreaterThan(20);
    expect(Number.isFinite(absoluteThresholdSpl(0))).toBe(true);
  });

  it('spreads further upward than downward, peaking near 0 dB', () => {
    expect(schroederSpreadingDb(0)).toBeCloseTo(0, 1);
    expect(schroederSpreadingDb(2)).toBeGreaterThan(schroederSpreadingDb(-2));
  });

  it('maps a full-scale sine power (0.5) to 96 dB SPL and back', () => {
    expect(powerToSpl(0.5)).toBeCloseTo(96, 9);
    expect(splToPower(powerToSpl(0.123))).toBeCloseTo(0.123, 12);
  });
});

describe('mixToMono', () => {
  it('averages channels', () => {
    const mono = mixToMono([new Float32Array([1, 0.5]), new Float32Array([0, -0.5])]);
    expect(Array.from(mono)).toEqual([0.5, 0]);
  });
});

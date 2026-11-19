import { describe, expect, it } from 'vitest';
import { bestPassage, topMoments } from './highlights';

/** One value per 0.1 s, zero except for bumps at the given times. */
function series(seconds: number, bumps: [at: number, width: number, height: number][]): Float32Array {
  const v = new Float32Array(seconds * 10);
  for (const [at, width, height] of bumps) {
    for (let i = Math.round(at * 10); i < Math.round((at + width) * 10); i++) v[i] = height;
  }
  return v;
}

describe('bestPassage', () => {
  it('finds the window that covers the most removed energy', () => {
    const v = series(120, [[40, 8, 1], [90, 2, 1]]);
    const start = bestPassage(v, 0.1, 10, 120);
    // Any 10 s window covering 40-48 s holds all of the big bump.
    expect(start).toBeGreaterThanOrEqual(38 - 1e-9);
    expect(start).toBeLessThanOrEqual(40 + 1e-9);
  });

  it('never returns a start that would run past the end of the song', () => {
    const v = series(60, [[58, 2, 5]]);
    expect(bestPassage(v, 0.1, 10, 60)).toBeLessThanOrEqual(50);
  });

  it('uses the start when the song is no longer than the passage', () => {
    expect(bestPassage(series(5, [[2, 1, 1]]), 0.1, 10, 5)).toBe(0);
  });
});

describe('topMoments', () => {
  it('returns the three biggest, well-separated moments in time order', () => {
    const v = series(200, [[20, 3, 1], [21, 3, 0.9], [100, 3, 3], [150, 3, 2], [180, 3, 0.5]]);
    const moments = topMoments(v, 0.1);
    expect(moments.map((m) => Math.round(m.timeSeconds))).toEqual([20, 100, 150]);
    for (let i = 1; i < moments.length; i++) {
      expect(moments[i].timeSeconds - moments[i - 1].timeSeconds).toBeGreaterThanOrEqual(10);
    }
  });

  it('returns nothing for a song with no hidden detail', () => {
    expect(topMoments(new Float32Array(500), 0.1)).toEqual([]);
  });
});

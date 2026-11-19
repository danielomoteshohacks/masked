/**
 * Finding the interesting parts of a song from per-frame engine statistics.
 * Frame f is centred at f * frameSeconds (frames start one hop before the
 * signal, and a hop is half a frame).
 */

function prefixSums(values: ArrayLike<number>): Float64Array {
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  return prefix;
}

/**
 * Start time of the passage of the given length with the largest total of
 * `values` (e.g. removed energy). Used to auto-pick the test section: where
 * the model removes the most, a difference is most likely to be audible.
 */
export function bestPassage(
  values: ArrayLike<number>,
  frameSeconds: number,
  passageSeconds: number,
  durationSeconds: number,
): number {
  const maxStart = Math.max(0, durationSeconds - passageSeconds);
  const window = Math.max(1, Math.round(passageSeconds / frameSeconds));
  if (values.length <= window) return 0;
  const prefix = prefixSums(values);
  let bestFrame = 0;
  let bestSum = -Infinity;
  for (let f = 0; f + window <= values.length; f++) {
    // Only windows that fit inside the song count, so the chosen start never
    // has to be clamped away from where the detail actually is.
    if (f * frameSeconds > maxStart) break;
    const sum = prefix[f + window] - prefix[f];
    if (sum > bestSum) {
      bestSum = sum;
      bestFrame = f;
    }
  }
  return Math.min(maxStart, bestFrame * frameSeconds);
}

export interface Moment {
  /** Start of the window, in seconds. */
  timeSeconds: number;
  /** Sum of the values inside the window. */
  score: number;
}

/**
 * The `count` windows with the highest totals, at least `minGapSeconds`
 * apart, so the three "most hidden detail" moments are three different parts
 * of the song rather than the same chorus three times over.
 */
export function topMoments(
  values: ArrayLike<number>,
  frameSeconds: number,
  windowSeconds = 3,
  count = 3,
  minGapSeconds = 10,
): Moment[] {
  const window = Math.max(1, Math.round(windowSeconds / frameSeconds));
  if (values.length === 0) return [];
  const prefix = prefixSums(values);
  const candidates: Moment[] = [];
  const last = Math.max(0, values.length - window);
  for (let f = 0; f <= last; f++) {
    const end = Math.min(values.length, f + window);
    candidates.push({ timeSeconds: f * frameSeconds, score: prefix[end] - prefix[f] });
  }
  candidates.sort((a, b) => b.score - a.score);

  const picked: Moment[] = [];
  for (const c of candidates) {
    if (c.score <= 0 || picked.length >= count) break;
    if (picked.every((p) => Math.abs(p.timeSeconds - c.timeSeconds) >= minGapSeconds)) picked.push(c);
  }
  return picked.sort((a, b) => a.timeSeconds - b.timeSeconds);
}

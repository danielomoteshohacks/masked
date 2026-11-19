/**
 * The Ear Score: the threshold in dB turned into a friendly 0-100 number.
 *
 * Mapping: score = 50 - 2.5 * thresholdDb, rounded and clamped to 0-100.
 *  - 50 means "exactly as sharp as the average listener that MP3-style
 *    formulas are designed around" (threshold 0 dB).
 *  - Each dB below the standard is worth 2.5 points: -20 dB, the most
 *    sensitive level the test can reach, scores 100.
 *  - Each dB above costs 2.5 points: +20 dB scores 0 (the test goes up to
 *    +30, which also shows as 0).
 * It is linear so that equal steps in the score mean equal steps in hearing,
 * and symmetric around 50 so that "above 50" reads naturally as "beat MP3".
 */
export const SCORE_AT_STANDARD = 50;
export const POINTS_PER_DB = 2.5;

export function earScore(thresholdDb: number): number {
  const raw = SCORE_AT_STANDARD - POINTS_PER_DB * thresholdDb;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

export type Verdict = 'lossless' | 'edge' | 'standard';

/** Within 2 dB of the standard either way is too close to call: that is
 *  about the precision of a 2 dB-step staircase. */
export function verdict(score: number): Verdict {
  if (score > SCORE_AT_STANDARD + 5) return 'lossless';
  if (score >= SCORE_AT_STANDARD - 5) return 'edge';
  return 'standard';
}

/** One plain sentence on what the score means. */
export function scoreSentence(score: number): string {
  switch (verdict(score)) {
    case 'lossless':
      return 'You beat MP3. You can hear details that MP3-style files throw away.';
    case 'edge':
      return 'Too close to call. Your ears and MP3 are right at the edge of each other.';
    case 'standard':
      return 'MP3 wins this one. It keeps everything you can hear, with room to spare.';
  }
}

/** A practical takeaway for how to listen. */
export function takeaway(score: number): string {
  switch (verdict(score)) {
    case 'lossless':
      return 'Lossless streaming is probably worth it for you.';
    case 'edge':
      return 'Top-quality streaming suits you. Lossless is a nice extra, not a must.';
    case 'standard':
      return 'Standard streaming quality is fine for your ears.';
  }
}

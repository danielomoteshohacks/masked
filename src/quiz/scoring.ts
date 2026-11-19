/** Scoring for ABX answers: percent correct, chance probability, and d'. */

export interface QuizScore {
  total: number;
  correct: number;
  percentCorrect: number;
  /** One-sided chance of scoring at least this well by pure guessing. */
  pValue: number;
  /** Sensitivity estimate (d') for ABX under the differencing model. */
  dPrime: number;
}

/**
 * P(X >= correct) for X ~ Binomial(total, chance). Exact: the probabilities
 * are built up term by term, which stays accurate for the small trial counts
 * used here, with no factorials to overflow.
 */
export function binomialPValue(correct: number, total: number, chance = 0.5): number {
  if (total <= 0 || correct <= 0) return 1;
  let pmf = Math.pow(1 - chance, total); // P(X = 0)
  let tail = 0;
  for (let k = 0; k <= total; k++) {
    if (k >= correct) tail += pmf;
    pmf *= ((total - k) / (k + 1)) * (chance / (1 - chance));
  }
  return Math.min(1, tail);
}

/** Standard normal CDF via the Abramowitz and Stegun 7.1.26 erf approximation
 *  (error below 1.5e-7, far below anything that matters here). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Proportion correct in ABX for a given d', under the differencing model
 * (Macmillan and Creelman, Detection Theory, ch. 9). The listener is right if
 * they correctly judge both "is X different from A?" and "is X different from
 * B?", or get both judgements wrong.
 */
export function abxProportionCorrect(dPrime: number): number {
  const a = normalCdf(dPrime / Math.SQRT2);
  const b = normalCdf(dPrime / 2);
  return a * b + (1 - a) * (1 - b);
}

/**
 * Inverts abxProportionCorrect by bisection (it rises steadily, so bisection
 * always converges). A perfect score would give infinite d', so it is
 * replaced by 1 - 1/(2n), the usual correction for a finite number of trials.
 */
export function abxDPrime(correct: number, total: number): number {
  if (total <= 0) return 0;
  let pc = correct / total;
  if (pc >= 1) pc = 1 - 1 / (2 * total);
  // At or below chance there is no evidence of any sensitivity.
  if (pc <= 0.5) return 0;
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (abxProportionCorrect(mid) < pc) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function scoreTrials(trials: readonly { correct: boolean }[]): QuizScore {
  const total = trials.length;
  const correct = trials.filter((t) => t.correct).length;
  return {
    total,
    correct,
    percentCorrect: total > 0 ? (100 * correct) / total : 0,
    pValue: binomialPValue(correct, total),
    dPrime: abxDPrime(correct, total),
  };
}

/** Plain-language reading of the threshold, from the listener's point of view. */
export function interpretThreshold(thresholdDb: number): string {
  const t = Math.abs(thresholdDb).toFixed(1);
  if (thresholdDb < 0) {
    return `You hear detail the standard model says is inaudible, by ${t} dB.`;
  }
  return `The model is safe for your ears, with ${t} dB to spare.`;
}

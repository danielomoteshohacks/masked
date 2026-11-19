import { describe, expect, it } from 'vitest';
import { earScore, scoreSentence, takeaway, verdict } from './ear-score';
import {
  binomialPValue,
  interpretThreshold,
  normalCdf,
  ODDITY_CHANCE,
  oddityDPrime,
  oddityProportionCorrect,
  scoreTrials,
} from './scoring';
import { DEFAULT_STAIRCASE, Staircase } from './staircase';

describe('Staircase', () => {
  it('goes down after two correct, up after one wrong, and halves the step after the 2nd reversal', () => {
    const s = new Staircase();
    expect(s.currentOffset).toBe(15);
    s.record(true);
    expect(s.currentOffset).toBe(15); // one correct: stay
    s.record(true);
    expect(s.currentOffset).toBe(11); // two correct: down 4
    s.record(false);
    expect(s.currentOffset).toBe(15); // wrong: up 4, 1st reversal (at 11)
    expect(s.reversals).toEqual([11]);
    s.record(true);
    s.record(true);
    expect(s.currentOffset).toBe(13); // 2nd reversal (at 15) uses the 2 dB step
    expect(s.reversals).toEqual([11, 15]);
    s.record(true);
    s.record(true);
    expect(s.currentOffset).toBe(11); // still 2 dB, same direction: no reversal
    expect(s.reversals).toHaveLength(2);
  });

  it('a wrong answer resets the run of correct answers', () => {
    const s = new Staircase();
    s.record(true);
    s.record(false);
    expect(s.currentOffset).toBe(19);
    s.record(true);
    expect(s.currentOffset).toBe(19); // needs two fresh correct answers
  });

  it('peekNext predicts record without changing state', () => {
    const s = new Staircase();
    s.record(true);
    const ifCorrect = s.peekNext(true);
    const ifWrong = s.peekNext(false);
    expect([ifCorrect, ifWrong]).toEqual([11, 19]);
    expect(s.currentOffset).toBe(15);
    s.record(false);
    expect(s.currentOffset).toBe(ifWrong);
  });

  it('clamps to the allowed range', () => {
    const s = new Staircase();
    for (let i = 0; i < 10; i++) s.record(false);
    expect(s.currentOffset).toBe(DEFAULT_STAIRCASE.maxDb);
    const t = new Staircase({ ...DEFAULT_STAIRCASE, startDb: -18 });
    for (let i = 0; i < 6; i++) t.record(true);
    expect(t.currentOffset).toBe(DEFAULT_STAIRCASE.minDb);
  });

  it('stops at 8 reversals', () => {
    const s = new Staircase();
    // Alternate pairs of correct with a wrong answer: every move reverses.
    while (!s.isFinished) {
      s.record(true);
      if (s.isFinished) break;
      s.record(true);
      if (s.isFinished) break;
      s.record(false);
    }
    expect(s.reversals).toHaveLength(8);
    expect(s.trials.length).toBeLessThan(30);
    expect(() => s.record(true)).toThrow();
    const estimate = s.threshold();
    expect(estimate.reliable).toBe(true);
    expect(estimate.thresholdDb).toBeCloseTo(
      s.reversals.slice(-6).reduce((a, b) => a + b, 0) / 6,
      9,
    );
  });

  it('stops at 30 trials and flags a run with too few reversals', () => {
    const s = new Staircase();
    while (!s.isFinished) s.record(false);
    expect(s.trials).toHaveLength(30);
    const estimate = s.threshold();
    expect(estimate.reliable).toBe(false);
    expect(estimate.basis).toBe('recent-trials');
    expect(estimate.thresholdDb).toBe(30);
  });

  it('converges near the 70.7%-correct point of a simulated listener', () => {
    // Simulated odd-one-out listener: chance (1/3) at low offsets, near-perfect
    // at high ones. 2-down/1-up still settles where p(correct)^2 = 0.5,
    // i.e. 70.7% correct, whatever the guessing rate.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const slope = 3;
    const pCorrect = (offset: number) => 1 / 3 + (2 / 3) / (1 + Math.exp(-offset / slope));
    // Solve 1/3 + (2/3) * sigmoid(x / slope) = 0.7071 for x.
    const s = (0.7071 - 1 / 3) / (2 / 3);
    const target = slope * Math.log(s / (1 - s));

    const estimates: number[] = [];
    for (let run = 0; run < 300; run++) {
      const s = new Staircase();
      while (!s.isFinished) s.record(random() < pCorrect(s.currentOffset));
      estimates.push(s.threshold().thresholdDb);
    }
    const mean = estimates.reduce((a, b) => a + b, 0) / estimates.length;
    expect(Math.abs(mean - target)).toBeLessThan(2);
  });
});

describe('scoring', () => {
  it('computes exact one-sided binomial p-values', () => {
    expect(binomialPValue(8, 10)).toBeCloseTo(56 / 1024, 12);
    expect(binomialPValue(6, 6)).toBeCloseTo(1 / 64, 12);
    expect(binomialPValue(0, 10)).toBe(1);
    expect(binomialPValue(5, 10)).toBeCloseTo(638 / 1024, 12);
  });

  it('has a normal CDF accurate to 1e-6', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
  });

  it('uses the right guessing rate for odd-one-out p-values', () => {
    // P(X >= 2 | n = 2, p = 1/3) = 1/9.
    expect(binomialPValue(2, 2, ODDITY_CHANCE)).toBeCloseTo(1 / 9, 12);
    // P(X >= 1 | n = 3, p = 1/3) = 1 - (2/3)^3 = 19/27.
    expect(binomialPValue(1, 3, ODDITY_CHANCE)).toBeCloseTo(19 / 27, 12);
  });

  it('matches the triangle-test model: 1/3 at d-prime 0, about 0.418 at 1', () => {
    expect(oddityProportionCorrect(0)).toBeCloseTo(1 / 3, 6);
    // Published triangle-test tables (Ennis 1993) give Pc = 0.418 at d' = 1.
    expect(oddityProportionCorrect(1)).toBeCloseTo(0.418, 3);
    // The odd-one-out task is less efficient than a two-choice one: even
    // d' = 6 is only about 98.6% correct, but it keeps rising towards 1.
    expect(oddityProportionCorrect(6)).toBeGreaterThan(0.98);
    expect(oddityProportionCorrect(10)).toBeGreaterThan(oddityProportionCorrect(6));
  });

  it('maps d-prime to proportion correct and back', () => {
    for (const d of [0.5, 1, 2, 3]) {
      const pc = oddityProportionCorrect(d);
      // A huge "experiment" at exactly that proportion recovers d'.
      expect(oddityDPrime(Math.round(pc * 1e6), 1e6)).toBeCloseTo(d, 2);
    }
  });

  it('gives d-prime 0 at or below chance and a finite value for a perfect score', () => {
    expect(oddityDPrime(3, 9)).toBe(0);
    expect(oddityDPrime(2, 10)).toBe(0);
    const perfect = oddityDPrime(20, 20);
    expect(Number.isFinite(perfect)).toBe(true);
    expect(perfect).toBeGreaterThan(oddityDPrime(19, 20));
  });

  it('summarises a set of trials against a one-in-three guessing rate', () => {
    const trials = [true, true, true, false, true, true, true, true, false, true].map((correct) => ({ correct }));
    const score = scoreTrials(trials);
    expect(score.correct).toBe(8);
    expect(score.percentCorrect).toBe(80);
    expect(score.pValue).toBeCloseTo(binomialPValue(8, 10, 1 / 3), 12);
    expect(score.pValue).toBeLessThan(0.01);
    expect(score.dPrime).toBeGreaterThan(0);
  });

  it('phrases the threshold from the listener’s side', () => {
    expect(interpretThreshold(-3.5)).toBe('You hear detail the standard model says is inaudible, by 3.5 dB.');
    expect(interpretThreshold(6)).toBe('The model is safe for your ears, with 6.0 dB to spare.');
  });
});

describe('Ear Score', () => {
  it('puts the standard listener at 50 and moves 2.5 points per dB', () => {
    expect(earScore(0)).toBe(50);
    expect(earScore(-4)).toBe(60);
    expect(earScore(8)).toBe(30);
  });

  it('clamps to 0-100 across the whole staircase range', () => {
    expect(earScore(-20)).toBe(100);
    expect(earScore(-25)).toBe(100);
    expect(earScore(20)).toBe(0);
    expect(earScore(30)).toBe(0);
  });

  it('gives a verdict and plain advice for each band', () => {
    expect(verdict(earScore(-6))).toBe('lossless');
    expect(verdict(earScore(1))).toBe('edge');
    expect(verdict(earScore(10))).toBe('standard');
    expect(takeaway(80)).toBe('Lossless streaming is probably worth it for you.');
    expect(takeaway(20)).toBe('Standard streaming quality is fine for your ears.');
    for (const score of [0, 50, 100]) {
      // No technical words in the main flow.
      expect(`${scoreSentence(score)} ${takeaway(score)}`).not.toMatch(/model|LUFS|offset|mask|lossy|transparent/i);
    }
  });
});

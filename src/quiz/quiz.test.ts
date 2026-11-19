import { describe, expect, it } from 'vitest';
import {
  abxDPrime,
  abxProportionCorrect,
  binomialPValue,
  interpretThreshold,
  normalCdf,
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
    // Simulated ABX listener: chance at low offsets, near-perfect at high
    // ones, with p(correct) = 0.707 at about -1 dB.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const slope = 3;
    const pCorrect = (offset: number) => 0.5 + 0.5 / (1 + Math.exp(-offset / slope));
    const target = slope * Math.log(0.414 / 0.586);

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

  it('maps d-prime to ABX proportion correct and back', () => {
    expect(abxProportionCorrect(0)).toBeCloseTo(0.5, 9);
    for (const d of [0.5, 1, 2, 3]) {
      const pc = abxProportionCorrect(d);
      // A huge "experiment" at exactly that proportion recovers d'.
      expect(abxDPrime(Math.round(pc * 1e6), 1e6)).toBeCloseTo(d, 2);
    }
  });

  it('gives d-prime 0 at or below chance and a finite value for a perfect score', () => {
    expect(abxDPrime(5, 10)).toBe(0);
    expect(abxDPrime(3, 10)).toBe(0);
    const perfect = abxDPrime(20, 20);
    expect(Number.isFinite(perfect)).toBe(true);
    expect(perfect).toBeGreaterThan(abxDPrime(19, 20));
  });

  it('summarises a set of trials', () => {
    const trials = [true, true, true, false, true, true, true, true, false, true].map((correct) => ({ correct }));
    const score = scoreTrials(trials);
    expect(score.correct).toBe(8);
    expect(score.percentCorrect).toBe(80);
    expect(score.pValue).toBeCloseTo(56 / 1024, 12);
    expect(score.dPrime).toBeGreaterThan(0);
  });

  it('phrases the threshold from the listener’s side', () => {
    expect(interpretThreshold(-3.5)).toBe('You hear detail the standard model says is inaudible, by 3.5 dB.');
    expect(interpretThreshold(6)).toBe('The model is safe for your ears, with 6.0 dB to spare.');
  });
});

/**
 * Adaptive 2-down/1-up staircase on the removal offset (Levitt, 1971).
 *
 * After two correct answers in a row the task gets harder (lower offset, so
 * less is removed); after any wrong answer it gets easier. The level settles
 * where going down and going up are equally likely, which happens at
 * p(correct)^2 = 0.5, i.e. about 70.7% correct.
 */

export interface StaircaseConfig {
  startDb: number;
  largeStepDb: number;
  smallStepDb: number;
  /** Switch from the large to the small step once this many reversals have happened. */
  reversalsBeforeSmallStep: number;
  minDb: number;
  maxDb: number;
  maxReversals: number;
  maxTrials: number;
  /** The threshold is the mean offset over this many final reversals. */
  reversalsForThreshold: number;
}

export const DEFAULT_STAIRCASE: StaircaseConfig = {
  // +15 dB removes clearly audible material, so the first trials are easy and
  // the listener learns what to listen for before it gets hard.
  startDb: 15,
  largeStepDb: 4,
  smallStepDb: 2,
  reversalsBeforeSmallStep: 2,
  minDb: -20,
  maxDb: 30,
  maxReversals: 8,
  maxTrials: 30,
  reversalsForThreshold: 6,
};

export interface StaircaseTrial {
  offsetDb: number;
  correct: boolean;
  /** True if this answer reversed the staircase's direction. */
  reversal: boolean;
}

export interface ThresholdEstimate {
  thresholdDb: number;
  /** False if the run ended (trial limit) before enough reversals happened. */
  reliable: boolean;
  /** Which offsets the estimate averaged. */
  basis: 'reversals' | 'recent-trials';
  count: number;
}

type Direction = -1 | 0 | 1;

interface Transition {
  next: number;
  direction: Direction;
  reversal: boolean;
  correctRun: number;
}

export class Staircase {
  readonly config: StaircaseConfig;
  readonly trials: StaircaseTrial[] = [];
  /** Offsets at which reversals happened, in order. */
  readonly reversals: number[] = [];
  private offset: number;
  private correctRun = 0;
  private lastDirection: Direction = 0;

  constructor(config: StaircaseConfig = DEFAULT_STAIRCASE) {
    this.config = config;
    this.offset = config.startDb;
  }

  get currentOffset(): number {
    return this.offset;
  }

  get isFinished(): boolean {
    return this.reversals.length >= this.config.maxReversals || this.trials.length >= this.config.maxTrials;
  }

  /** The offset the next trial would use after this answer, without recording it.
   *  Used to precompute audio for both possible outcomes. */
  peekNext(correct: boolean): number {
    return this.transition(correct).next;
  }

  record(correct: boolean): void {
    if (this.isFinished) throw new Error('The staircase has already finished.');
    const t = this.transition(correct);
    this.trials.push({ offsetDb: this.offset, correct, reversal: t.reversal });
    // The reversal is logged at the level where the direction changed: the
    // offset of the trial that triggered it.
    if (t.reversal) this.reversals.push(this.offset);
    if (t.direction !== 0) this.lastDirection = t.direction;
    this.correctRun = t.correctRun;
    this.offset = t.next;
  }

  threshold(): ThresholdEstimate {
    const n = this.config.reversalsForThreshold;
    if (this.reversals.length >= n) {
      return { thresholdDb: average(this.reversals.slice(-n)), reliable: true, basis: 'reversals', count: n };
    }
    if (this.reversals.length >= 2) {
      // Too few reversals for the full rule, but a pair still brackets the
      // threshold. Reported as less reliable.
      return { thresholdDb: average(this.reversals), reliable: false, basis: 'reversals', count: this.reversals.length };
    }
    // Hardly any reversals means the staircase kept drifting one way (for
    // example, stuck at an edge). The recent levels are the best guess left.
    const recent = this.trials.slice(-10).map((t) => t.offsetDb);
    return {
      thresholdDb: recent.length > 0 ? average(recent) : this.offset,
      reliable: false,
      basis: 'recent-trials',
      count: recent.length,
    };
  }

  private transition(correct: boolean): Transition {
    const cfg = this.config;
    let correctRun = correct ? this.correctRun + 1 : 0;
    let direction: Direction = 0;
    if (!correct) direction = 1;
    else if (correctRun >= 2) {
      direction = -1;
      correctRun = 0;
    }
    if (direction === 0) return { next: this.offset, direction, reversal: false, correctRun };

    const reversal = this.lastDirection !== 0 && direction !== this.lastDirection;
    // Big steps first, to get near the threshold fast; small steps after the
    // second reversal, for precision. The step that makes the 2nd reversal is
    // already a small one.
    const reversalCount = this.reversals.length + (reversal ? 1 : 0);
    const step = reversalCount < cfg.reversalsBeforeSmallStep ? cfg.largeStepDb : cfg.smallStepDb;
    const next = Math.min(cfg.maxDb, Math.max(cfg.minDb, this.offset + direction * step));
    return { next, direction, reversal, correctRun };
  }
}

function average(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

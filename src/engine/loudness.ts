/**
 * ITU-R BS.1770-4 integrated loudness, plus gain matching between versions.
 *
 * Why this matters: in a listening test, louder almost always sounds "better"
 * or "more detailed". Removing energy makes the processed version slightly
 * quieter, which would give it away without the listener hearing any missing
 * detail. Matching loudness removes that clue.
 */

/** Blocks quieter than this are treated as silence and ignored. */
export const ABSOLUTE_GATE_LUFS = -70;
/** Blocks more than 10 LU below the (absolute-gated) average are ignored too,
 *  so quiet intros or pauses do not drag the measurement down. */
export const RELATIVE_GATE_LU = -10;
const BLOCK_SECONDS = 0.4;
/** 75% overlap between blocks, as the standard specifies. */
const STEP_SECONDS = 0.1;
/** BS.1770 constant that makes a 1 kHz full-scale sine read -3.01 LUFS. */
const LOUDNESS_OFFSET = -0.691;

/** Highest sample peak we allow after gain matching: -0.5 dBFS. The margin
 *  leaves room for peaks that fall between samples once the DAC
 *  reconstructs the waveform, which a sample peak does not see. */
export const PEAK_CEILING = Math.pow(10, -0.5 / 20);

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages, designed for any sample rate. The standard only
 * lists coefficients for 48 kHz; these analog-prototype parameters and the
 * bilinear-transform design (as in libebur128) reproduce that table exactly
 * and extend it to 44.1 kHz and other rates.
 *  - Stage 1, high shelf of about +4 dB above ~1.7 kHz: models the head
 *    acting as a solid sphere that boosts high frequencies.
 *  - Stage 2, high-pass at ~38 Hz: the "RLB" curve, de-emphasising deep bass
 *    that sounds less loud than its energy suggests.
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  const shelfHz = 1681.974450955533;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  let K = Math.tan((Math.PI * shelfHz) / sampleRate);
  const Vh = Math.pow(10, shelfGainDb / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / shelfQ + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / shelfQ + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / shelfQ + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / shelfQ + K * K) / a0,
  };

  const hpHz = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  K = Math.tan((Math.PI * hpHz) / sampleRate);
  a0 = 1 + K / hpQ + K * K;
  // The standard uses an unnormalised numerator of [1, -2, 1] for this stage.
  const highPass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / hpQ + K * K) / a0,
  };
  return [shelf, highPass];
}

function runBiquad(input: ArrayLike<number>, f: Biquad, out: Float64Array): void {
  // Transposed direct form II in float64: two state variables, and numerically
  // well behaved for a high-pass this close to 0 Hz.
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = f.b0 * x + z1;
    z1 = f.b1 * x - f.a1 * y + z2;
    z2 = f.b2 * x - f.a2 * y;
    out[i] = y;
  }
}

export function kWeight(signal: ArrayLike<number>, sampleRate: number): Float64Array {
  const [shelf, highPass] = kWeightingFilters(sampleRate);
  const stage1 = new Float64Array(signal.length);
  runBiquad(signal, shelf, stage1);
  const stage2 = new Float64Array(signal.length);
  runBiquad(stage1, highPass, stage2);
  return stage2;
}

function blockLoudness(power: number): number {
  return LOUDNESS_OFFSET + 10 * Math.log10(power);
}

/**
 * Integrated loudness in LUFS, or -Infinity if everything is gated out
 * (silence). `gain` scales the signal virtually, which lets gain matching
 * re-measure without copying audio.
 *
 * All channels get weight 1.0, which is correct for mono and stereo; the
 * standard's 1.41 surround weights are not needed here.
 */
export function integratedLoudness(channels: readonly Float32Array[], sampleRate: number, gain = 1): number {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return -Infinity;

  // Prefix sums of K-weighted squared samples (summed over channels) make the
  // mean square of any block a single subtraction, instead of re-summing 400 ms
  // of audio for each of the overlapping blocks.
  const prefix = new Float64Array(length + 1);
  const g2 = gain * gain;
  const squares = new Float64Array(length);
  for (const channel of channels) {
    const y = kWeight(channel, sampleRate);
    for (let i = 0; i < length; i++) squares[i] += y[i] * y[i] * g2;
  }
  for (let i = 0; i < length; i++) prefix[i + 1] = prefix[i] + squares[i];

  const blockLength = Math.round(BLOCK_SECONDS * sampleRate);
  const step = Math.round(STEP_SECONDS * sampleRate);
  const blockPowers: number[] = [];
  if (length < blockLength) {
    // Shorter than one block: the standard is undefined here, so the whole
    // signal is treated as a single block rather than returning nothing.
    blockPowers.push(prefix[length] / length);
  } else {
    for (let start = 0; start + blockLength <= length; start += step) {
      blockPowers.push((prefix[start + blockLength] - prefix[start]) / blockLength);
    }
  }

  const aboveAbsolute = blockPowers.filter((p) => p > 0 && blockLoudness(p) > ABSOLUTE_GATE_LUFS);
  if (aboveAbsolute.length === 0) return -Infinity;
  const relativeGate = blockLoudness(mean(aboveAbsolute)) + RELATIVE_GATE_LU;
  const gated = aboveAbsolute.filter((p) => blockLoudness(p) > relativeGate);
  return blockLoudness(mean(gated));
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function samplePeak(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const a = Math.abs(channel[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

export function applyGain(channels: readonly Float32Array[], gain: number): void {
  if (gain === 1) return;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
}

export interface LoudnessMatch {
  originalLufs: number;
  /** Loudness of the processed version before matching. */
  processedLufs: number;
  /** Linear gain to apply to the processed version. */
  gain: number;
  /** Measured loudness of processed * gain; within 0.1 LU of the original. */
  matchedLufs: number;
  /**
   * Linear gain (at most 1) to apply to BOTH versions at playback, so neither
   * exceeds PEAK_CEILING. Applying it to both keeps them matched.
   */
  headroom: number;
}

/** Below this residual mismatch, further correction is pointless. */
const MATCH_TOLERANCE_LU = 0.01;

export function matchLoudness(
  original: readonly Float32Array[],
  processed: readonly Float32Array[],
  sampleRate: number,
): LoudnessMatch {
  const originalLufs = integratedLoudness(original, sampleRate);
  const processedLufs = integratedLoudness(processed, sampleRate);
  let gain = 1;
  let matchedLufs = processedLufs;

  if (Number.isFinite(originalLufs) && Number.isFinite(processedLufs)) {
    // A gain changes every block's loudness by the same amount, so one step
    // is almost always exact. A few re-measurements cover the edge case where
    // a block crosses the -70 LUFS absolute gate and the gating changes.
    gain = Math.pow(10, (originalLufs - processedLufs) / 20);
    for (let i = 0; i < 3; i++) {
      matchedLufs = integratedLoudness(processed, sampleRate, gain);
      const error = originalLufs - matchedLufs;
      if (Math.abs(error) < MATCH_TOLERANCE_LU) break;
      gain *= Math.pow(10, error / 20);
    }
  }

  const peak = Math.max(samplePeak(original), samplePeak(processed) * gain);
  const headroom = peak > PEAK_CEILING ? PEAK_CEILING / peak : 1;
  return { originalLufs, processedLufs, gain, matchedLufs, headroom };
}

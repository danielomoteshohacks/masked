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
// Gating blocks are 400 ms long: four of the 100 ms steps below.
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

/**
 * K-weighted energy in consecutive 100 ms sub-blocks, summed over channels.
 *
 * Every 400 ms gating block is exactly four sub-blocks, so block energies
 * come from adding four numbers. This keeps memory to one number per 100 ms
 * instead of several song-length buffers, which matters for whole songs.
 */
interface SubBlocks {
  sums: Float64Array;
  /** Samples per sub-block (100 ms); a block is 4 of these. */
  step: number;
  length: number;
  total: number;
}

function measureSubBlocks(channels: readonly Float32Array[], sampleRate: number): SubBlocks {
  const length = channels[0]?.length ?? 0;
  const step = Math.max(1, Math.round(STEP_SECONDS * sampleRate));
  const sums = new Float64Array(Math.ceil(length / step));
  const [s, h] = kWeightingFilters(sampleRate);
  let total = 0;
  for (const channel of channels) {
    // Both biquads run inline (transposed direct form II, float64), with
    // no intermediate arrays. Two state variables per stage.
    let s1 = 0;
    let s2 = 0;
    let h1 = 0;
    let h2 = 0;
    for (let i = 0; i < length; i++) {
      const x = channel[i];
      const y = s.b0 * x + s1;
      s1 = s.b1 * x - s.a1 * y + s2;
      s2 = s.b2 * x - s.a2 * y;
      const z = h.b0 * y + h1;
      h1 = h.b1 * y - h.a1 * z + h2;
      h2 = h.b2 * y - h.a2 * z;
      const e = z * z;
      sums[Math.floor(i / step)] += e;
      total += e;
    }
  }
  return { sums, step, length, total };
}

function blockLoudness(power: number): number {
  return LOUDNESS_OFFSET + 10 * Math.log10(power);
}

/** Gated loudness from sub-block energies, for the signal scaled by `gain`. */
function gatedLoudness(m: SubBlocks, gain: number): number {
  if (m.length === 0) return -Infinity;
  const g2 = gain * gain;
  const blockLength = 4 * m.step;
  const blockPowers: number[] = [];
  if (m.length < blockLength) {
    // Shorter than one block: the standard is undefined here, so the whole
    // signal is treated as a single block rather than returning nothing.
    blockPowers.push((m.total * g2) / m.length);
  } else {
    // Blocks start every 100 ms (75% overlap) and must fit inside the signal.
    const blocks = Math.floor((m.length - blockLength) / m.step) + 1;
    for (let j = 0; j < blocks; j++) {
      const sum = m.sums[j] + m.sums[j + 1] + m.sums[j + 2] + m.sums[j + 3];
      blockPowers.push((sum * g2) / blockLength);
    }
  }

  const aboveAbsolute = blockPowers.filter((p) => p > 0 && blockLoudness(p) > ABSOLUTE_GATE_LUFS);
  if (aboveAbsolute.length === 0) return -Infinity;
  const relativeGate = blockLoudness(mean(aboveAbsolute)) + RELATIVE_GATE_LU;
  const gated = aboveAbsolute.filter((p) => blockLoudness(p) > relativeGate);
  return blockLoudness(mean(gated));
}

/**
 * Integrated loudness in LUFS, or -Infinity if everything is gated out
 * (silence). `gain` scales the signal virtually, without copying audio.
 *
 * All channels get weight 1.0, which is correct for mono and stereo; the
 * standard's 1.41 surround weights are not needed here.
 */
export function integratedLoudness(channels: readonly Float32Array[], sampleRate: number, gain = 1): number {
  return gatedLoudness(measureSubBlocks(channels, sampleRate), gain);
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
  // Each signal is filtered once; re-measuring at a new gain only re-runs the gating.
  const originalBlocks = measureSubBlocks(original, sampleRate);
  const processedBlocks = measureSubBlocks(processed, sampleRate);
  const originalLufs = gatedLoudness(originalBlocks, 1);
  const processedLufs = gatedLoudness(processedBlocks, 1);
  let gain = 1;
  let matchedLufs = processedLufs;

  if (Number.isFinite(originalLufs) && Number.isFinite(processedLufs)) {
    // A gain changes every block's loudness by the same amount, so one step
    // is almost always exact. A few re-measurements cover the edge case where
    // a block crosses the -70 LUFS absolute gate and the gating changes.
    gain = Math.pow(10, (originalLufs - processedLufs) / 20);
    for (let i = 0; i < 3; i++) {
      matchedLufs = gatedLoudness(processedBlocks, gain);
      const error = originalLufs - matchedLufs;
      if (Math.abs(error) < MATCH_TOLERANCE_LU) break;
      gain *= Math.pow(10, error / 20);
    }
  }

  const peak = Math.max(samplePeak(original), samplePeak(processed) * gain);
  const headroom = peak > PEAK_CEILING ? PEAK_CEILING / peak : 1;
  return { originalLufs, processedLufs, gain, matchedLufs, headroom };
}

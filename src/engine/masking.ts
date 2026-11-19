/**
 * Simplified psychoacoustic masking model, in the spirit of Johnston (1988)
 * and MPEG psychoacoustic model 1, but with fewer special cases.
 *
 * Units: "power" means mean-square amplitude of the signal in a bin, scaled
 * so a full-scale sine (amplitude 1.0, i.e. 0 dBFS) has power 0.5. That is
 * how a sine's energy naturally comes out, which makes the dB SPL mapping
 * below a single constant.
 */

/** Assumed playback calibration: a full-scale sine plays at 96 dB SPL.
 *  This is the classic 16-bit assumption (96 dB of dynamic range above the
 *  quietest representable level). We cannot know the listener's real volume,
 *  so everything that depends on absolute loudness (the threshold of hearing)
 *  is only as accurate as this guess. */
export const FULL_SCALE_SPL_DB = 96;
const FULL_SCALE_SINE_POWER = 0.5;

export function splToPower(db: number): number {
  return FULL_SCALE_SINE_POWER * Math.pow(10, (db - FULL_SCALE_SPL_DB) / 10);
}

export function powerToSpl(power: number): number {
  return FULL_SCALE_SPL_DB + 10 * Math.log10(power / FULL_SCALE_SINE_POWER);
}

/** Zwicker and Terhardt's Hz-to-Bark formula. The Bark scale stretches low
 *  frequencies and squeezes high ones so that one Bark is roughly one
 *  "critical band": the width over which the ear's filters overlap. */
export function hzToBark(hz: number): number {
  return 13 * Math.atan(0.00076 * hz) + 3.5 * Math.atan((hz / 7500) ** 2);
}

/** Zwicker's critical bandwidth in Hz: about 100 Hz below 500 Hz, then
 *  growing to roughly 20% of the centre frequency. */
export function criticalBandwidthHz(hz: number): number {
  return 25 + 75 * Math.pow(1 + 1.4 * (hz / 1000) ** 2, 0.69);
}

/**
 * Terhardt's absolute threshold of hearing in dB SPL: the quietest pure tone
 * an average young listener can hear in silence. Lowest (most sensitive)
 * around 3-4 kHz, rising steeply at the low and high ends.
 * Clamped at 20 Hz because the formula goes to infinity at 0 Hz.
 */
export function absoluteThresholdSpl(hz: number): number {
  const k = Math.max(hz, 20) / 1000;
  return 3.64 * Math.pow(k, -0.8) - 6.5 * Math.exp(-0.6 * (k - 3.3) ** 2) + 1e-3 * k ** 4;
}

/**
 * Schroeder et al. (1979) spreading function in dB. dz is the maskee's Bark
 * position minus the masker's. It is asymmetric: masking spreads much further
 * upward in frequency (positive dz) than downward, matching how a loud low
 * note hides quiet high detail but not the other way round. Peak is ~0 dB at dz = 0.
 */
export function schroederSpreadingDb(dz: number): number {
  const x = dz + 0.474;
  return 15.81 + 7.5 * x - 17.5 * Math.sqrt(1 + x * x);
}

/**
 * How far below the masker's level the masking threshold sits, in dB
 * (Johnston's values). A pure tone is a weak masker: noise just under it is
 * audible, so the threshold sits 14.5 + z dB below it. Noise is a strong
 * masker: the threshold sits only 5.5 dB below. tonality in [0, 1] blends them.
 */
export function maskerOffsetDb(tonality: number, bark: number): number {
  return tonality * (14.5 + bark) + (1 - tonality) * 5.5;
}

/** Spectral flatness (in dB) at or below which a band counts as fully tonal.
 *  Johnston uses -60 dB over a whole frame; a single band has only a handful
 *  of bins, so its flatness never gets that low and a smaller limit is used. */
const TONAL_FLATNESS_DB = -30;
/** Bands with less energy than this are treated as empty (about -300 dBFS). */
const ENERGY_FLOOR = 1e-30;
/** Added inside the logarithm so an exactly-zero bin does not produce -Infinity. */
const LOG_FLOOR = 1e-30;

// The spreading function is evaluated tens of millions of times per song, so it
// is tabulated once at 0.01 Bark resolution (far finer than the model's accuracy).
const SPREAD_RANGE_BARK = 25;
const SPREAD_STEP_BARK = 0.01;
const SPREAD_TABLE = (() => {
  const count = Math.round((2 * SPREAD_RANGE_BARK) / SPREAD_STEP_BARK) + 1;
  const table = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const dz = -SPREAD_RANGE_BARK + i * SPREAD_STEP_BARK;
    table[i] = Math.pow(10, schroederSpreadingDb(dz) / 10);
  }
  return table;
})();

function spreadLinear(dz: number): number {
  const i = Math.round((dz + SPREAD_RANGE_BARK) / SPREAD_STEP_BARK);
  return i < 0 || i >= SPREAD_TABLE.length ? 0 : SPREAD_TABLE[i];
}

/**
 * Precomputes everything that depends only on sample rate and FFT size, then
 * turns one frame's power spectrum into a per-bin masking threshold.
 */
export class MaskingModel {
  readonly binCount: number;
  readonly bandCount: number;
  /** Bark position of each FFT bin's centre frequency. */
  readonly binBark: Float64Array;
  /** First bin of each band (inclusive) and the bin after its last. */
  readonly bandStart: Int32Array;
  readonly bandEnd: Int32Array;
  /** How many FFT bins one critical band spans at each bin's frequency. */
  private readonly binsPerCriticalBand: Float64Array;
  /** Threshold of hearing for each bin, converted to power units. */
  readonly athPower: Float64Array;
  private readonly maskerPower: Float64Array;
  private readonly maskerBark: Float64Array;

  constructor(sampleRate: number, frameSize: number) {
    const binCount = frameSize / 2 + 1;
    const binHz = sampleRate / frameSize;
    this.binCount = binCount;
    this.binBark = new Float64Array(binCount);
    this.binsPerCriticalBand = new Float64Array(binCount);
    this.athPower = new Float64Array(binCount);

    for (let k = 0; k < binCount; k++) {
      const hz = k * binHz;
      this.binBark[k] = hzToBark(hz);
      // At least one bin, otherwise very low frequencies at low sample rates
      // would divide the threshold by less than 1 and inflate it.
      this.binsPerCriticalBand[k] = Math.max(1, criticalBandwidthHz(hz) / binHz);
      this.athPower[k] = splToPower(absoluteThresholdSpl(hz));
    }

    // Group bins into 1-Bark-wide bands: band b holds bins with Bark in [b, b+1).
    this.bandCount = Math.floor(this.binBark[binCount - 1]) + 1;
    this.bandStart = new Int32Array(this.bandCount).fill(binCount);
    this.bandEnd = new Int32Array(this.bandCount);
    for (let k = 0; k < binCount; k++) {
      const b = Math.floor(this.binBark[k]);
      if (k < this.bandStart[b]) this.bandStart[b] = k;
      this.bandEnd[b] = k + 1;
    }
    this.maskerPower = new Float64Array(this.bandCount);
    this.maskerBark = new Float64Array(this.bandCount);
  }

  /**
   * power: one frame's per-bin power (length binCount).
   * out: receives the per-bin masking threshold in the same units.
   */
  computeThreshold(power: Float64Array, out: Float64Array): void {
    const { bandCount, binCount, binBark, maskerPower, maskerBark } = this;

    // 1. Treat each Bark band as one masker. Its strength is the band's total
    //    energy; its position is the energy-weighted centre (so a single tone
    //    sits where the tone actually is, not in the middle of its band).
    for (let b = 0; b < bandCount; b++) {
      const lo = this.bandStart[b];
      const hi = this.bandEnd[b];
      let energy = 0;
      let barkSum = 0;
      let logSum = 0;
      for (let k = lo; k < hi; k++) {
        const p = power[k];
        energy += p;
        barkSum += p * binBark[k];
        logSum += Math.log(p + LOG_FLOOR);
      }
      if (hi <= lo || energy <= ENERGY_FLOOR) {
        maskerPower[b] = 0;
        continue;
      }

      // 2. Tonality from spectral flatness: geometric mean / arithmetic mean.
      //    Flat (noise-like) bands give ~0 dB; a band with one sharp peak gives
      //    a strongly negative value.
      const n = hi - lo;
      const geometric = Math.exp(logSum / n);
      const arithmetic = energy / n + LOG_FLOOR;
      const flatnessDb = 10 * Math.log10(geometric / arithmetic);
      const tonality = Math.min(1, Math.max(0, flatnessDb / TONAL_FLATNESS_DB));

      const bark = barkSum / energy;
      maskerBark[b] = bark;
      // 3. Lower each masker by its offset now, before spreading, so the
      //    tone/noise distinction follows the masker, not the masked bin.
      maskerPower[b] = energy * Math.pow(10, -maskerOffsetDb(tonality, bark) / 10);
    }

    // 4. Spread every masker across the Bark scale and add the contributions
    //    (power addition), evaluated at each bin's own Bark position so the
    //    threshold is smooth instead of a staircase at band edges.
    for (let k = 0; k < binCount; k++) {
      const z = binBark[k];
      let sum = 0;
      for (let b = 0; b < bandCount; b++) {
        const mp = maskerPower[b];
        if (mp > 0) sum += mp * spreadLinear(z - maskerBark[b]);
      }
      // 5. The spread value is a threshold for a whole critical band's worth of
      //    energy. Dividing by how many bins fit in a critical band gives the
      //    threshold for a single bin (Johnston's normalisation).
      const masked = sum / this.binsPerCriticalBand[k];
      // 6. Nothing quieter than the threshold of hearing is audible, even with
      //    no masker at all, so the final threshold is the larger of the two.
      out[k] = Math.max(masked, this.athPower[k]);
    }
  }
}

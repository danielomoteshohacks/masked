/**
 * Headphone screening test after Woods, Siegel, Traer and McDermott (2017),
 * "Headphone screening to facilitate web-based auditory experiments".
 *
 * Each trial plays three 200 Hz tones in random order:
 *  - "standard": the same signal in both ears;
 *  - "quiet": the same, 6 dB lower;
 *  - "antiphase": standard level, but the right ear's waveform is inverted.
 * The task is to pick the quietest. On headphones the antiphase tone sounds
 * as loud as the standard, so the 6 dB tone is clearly quietest. On
 * loudspeakers the two inverted channels partly cancel in the air, which
 * makes the antiphase tone sound quietest, and listeners pick it instead.
 */

export type ToneRole = 'standard' | 'quiet' | 'antiphase';

export const HEADPHONE_TRIALS = 6;
export const HEADPHONE_PASS_MARK = 5;
const TONE_HZ = 200;
const TONE_SECONDS = 1;
/** Woods et al. use 100 ms onset/offset ramps, so the tones start without clicks. */
const RAMP_SECONDS = 0.1;
const GAP_SECONDS = 0.5;
const LEAD_IN_SECONDS = 0.2;
/** Standard tone level. Moderate, because the user has just set their volume for music. */
const STANDARD_DBFS = -18;
const QUIET_DB = -6;

/** A random order of the three roles (Fisher-Yates shuffle). */
export function randomToneOrder(random: () => number = Math.random): ToneRole[] {
  const order: ToneRole[] = ['standard', 'quiet', 'antiphase'];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Index (0-2) of the tone a headphone listener should pick. */
export function correctToneIndex(order: readonly ToneRole[]): number {
  return order.indexOf('quiet');
}

/** Renders one trial as stereo [left, right]. */
export function renderHeadphoneTrial(order: readonly ToneRole[], sampleRate: number): [Float32Array, Float32Array] {
  const toneLength = Math.round(TONE_SECONDS * sampleRate);
  const gap = Math.round(GAP_SECONDS * sampleRate);
  const lead = Math.round(LEAD_IN_SECONDS * sampleRate);
  const ramp = Math.round(RAMP_SECONDS * sampleRate);
  const total = lead + order.length * toneLength + (order.length - 1) * gap + lead;
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const standard = Math.pow(10, STANDARD_DBFS / 20);

  order.forEach((role, index) => {
    const start = lead + index * (toneLength + gap);
    const amplitude = role === 'quiet' ? standard * Math.pow(10, QUIET_DB / 20) : standard;
    // Inverting the right channel is the whole trick: identical loudness in
    // each ear, but it cancels when two speakers' sound mixes in the room.
    const rightSign = role === 'antiphase' ? -1 : 1;
    for (let i = 0; i < toneLength; i++) {
      let envelope = 1;
      if (i < ramp) envelope = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
      else if (i >= toneLength - ramp) envelope = 0.5 - 0.5 * Math.cos((Math.PI * (toneLength - 1 - i)) / ramp);
      const v = amplitude * envelope * Math.sin((2 * Math.PI * TONE_HZ * i) / sampleRate);
      left[start + i] = v;
      right[start + i] = rightSign * v;
    }
  });
  return [left, right];
}

export function headphoneCheckPassed(correct: number): boolean {
  return correct >= HEADPHONE_PASS_MARK;
}

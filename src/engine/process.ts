import { MaskingModel } from './masking';
import { mixToMono } from './mono';
import { Stft, type Spectrogram } from './stft';

export interface ProcessOptions {
  /**
   * Added to the model's threshold, in dB, before deciding what to remove.
   * 0 = the standard "average listener" model. Positive values raise the
   * threshold (remove more); negative values lower it (remove less).
   */
  offsetDb: number;
  /** false keeps every bin. Used to check the STFT round trip on its own. */
  removal?: boolean;
}

export interface ProcessResult {
  /** The audible part, as judged by the model. One array per input channel. */
  processed: Float32Array[];
  /** What was taken out: original minus processed, per channel. */
  removed: Float32Array[];
  /** Energy of `removed` as a percentage of the original's energy. */
  percentRemoved: number;
}

/**
 * Decides, for every (frame, bin) of the mono analysis, whether it is above
 * the masking threshold. Returns 1 (keep) or 0 (remove) per cell.
 */
export function computeKeepMask(
  spec: Spectrogram,
  stft: Stft,
  model: MaskingModel,
  offsetDb: number,
): Float32Array {
  const { frameCount, binCount } = spec;
  const mask = new Float32Array(frameCount * binCount);
  const power = new Float64Array(binCount);
  const threshold = new Float64Array(binCount);

  // Scale |X|^2 so a sine's energy summed over its bins equals its mean-square
  // power (A^2 / 2). Factor 2: we only look at half the (mirrored) spectrum.
  // Dividing by N * sum(w^2) undoes the FFT's and the window's gain (Parseval).
  let windowEnergy = 0;
  for (const w of stft.window) windowEnergy += w * w;
  const powerScale = 2 / (stft.frameSize * windowEnergy);
  const offsetGain = Math.pow(10, offsetDb / 10);

  for (let f = 0; f < frameCount; f++) {
    const offset = f * binCount;
    for (let k = 0; k < binCount; k++) {
      const re = spec.re[offset + k];
      const im = spec.im[offset + k];
      power[k] = (re * re + im * im) * powerScale;
    }
    model.computeThreshold(power, threshold);
    for (let k = 0; k < binCount; k++) {
      mask[offset + k] = power[k] >= threshold[k] * offsetGain ? 1 : 0;
    }
  }
  return mask;
}

/**
 * Softens the keep/remove mask with a [1, 2, 1] / 4 kernel across neighbouring
 * bins, then across neighbouring frames.
 *
 * A hard on/off mask that flickers from frame to frame produces "musical
 * noise": isolated bins blinking on and off sound like random chirps. Blurring
 * the mask fills in isolated holes with partial gains and ramps the edges of
 * removed regions, at the cost of removing slightly less in total.
 */
export function smoothMask(mask: Float32Array, frameCount: number, binCount: number): Float32Array {
  const acrossBins = new Float32Array(mask.length);
  for (let f = 0; f < frameCount; f++) {
    const o = f * binCount;
    for (let k = 0; k < binCount; k++) {
      // At the edges the missing neighbour is replaced by the cell itself,
      // so a fully kept spectrum stays exactly 1 everywhere.
      const left = k > 0 ? mask[o + k - 1] : mask[o + k];
      const right = k < binCount - 1 ? mask[o + k + 1] : mask[o + k];
      acrossBins[o + k] = (left + 2 * mask[o + k] + right) / 4;
    }
  }

  const out = new Float32Array(mask.length);
  for (let f = 0; f < frameCount; f++) {
    const prev = (f > 0 ? f - 1 : f) * binCount;
    const cur = f * binCount;
    const next = (f < frameCount - 1 ? f + 1 : f) * binCount;
    for (let k = 0; k < binCount; k++) {
      const blurred = (acrossBins[prev + k] + 2 * acrossBins[cur + k] + acrossBins[next + k]) / 4;
      // The blur may only raise a gain, never lower one: bins the model judged
      // audible stay at exactly 1. Otherwise the edges of every loud peak get
      // pulled down too (measured: a 1 kHz tone lost 2.5 dB without this).
      // Removed cells next to kept ones become partial gains, which gives the
      // soft edges that suppress musical noise.
      out[cur + k] = Math.max(mask[cur + k], blurred);
    }
  }
  return out;
}

export function processChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: ProcessOptions,
): ProcessResult {
  const stft = new Stft();
  const removal = options.removal ?? true;

  // One mask, decided on the mono mix, shared by all channels.
  let gains: Float32Array | null = null;
  if (removal) {
    const monoSpec = stft.analyze(mixToMono(channels));
    const model = new MaskingModel(sampleRate, stft.frameSize);
    const mask = computeKeepMask(monoSpec, stft, model, options.offsetDb);
    gains = smoothMask(mask, monoSpec.frameCount, monoSpec.binCount);
  }

  const processed: Float32Array[] = [];
  const removed: Float32Array[] = [];
  let originalEnergy = 0;
  let removedEnergy = 0;

  for (const channel of channels) {
    const spec = stft.analyze(channel);
    if (gains) {
      // Multiplying real and imaginary parts by the same real gain scales the
      // magnitude but keeps the phase, so what stays is unchanged in timing.
      for (let i = 0; i < gains.length; i++) {
        spec.re[i] *= gains[i];
        spec.im[i] *= gains[i];
      }
    }
    const kept = stft.synthesize(spec);

    const out = new Float32Array(channel.length);
    const diff = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      out[i] = kept[i];
      // Computed in float64 before rounding, so processed + removed
      // reconstructs the original as closely as float32 allows.
      diff[i] = channel[i] - kept[i];
      originalEnergy += channel[i] * channel[i];
      removedEnergy += diff[i] * diff[i];
    }
    processed.push(out);
    removed.push(diff);
  }

  // Silence in means nothing to remove; avoid 0 / 0 = NaN.
  const percentRemoved = originalEnergy > 0 ? (100 * removedEnergy) / originalEnergy : 0;
  return { processed, removed, percentRemoved };
}

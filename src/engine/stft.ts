import { FFT } from './fft';

/** 2048 samples is about 46 ms at 44.1 kHz: long enough to resolve the ~20 Hz
 *  spacing needed to separate nearby tones, short enough that drum hits do not
 *  smear too far in time. */
export const FRAME_SIZE = 2048;
/** 50% overlap: every sample is covered by exactly two frames. */
export const HOP_SIZE = FRAME_SIZE / 2;

/**
 * Periodic sqrt-Hann window, which simplifies to |sin(pi*n/N)|.
 *
 * We window twice (once before the FFT, once after the inverse), so the
 * effective window is sqrt-Hann squared = Hann. A periodic Hann window at 50%
 * overlap sums to exactly 1, which is what makes reconstruction exact when no
 * bins are changed. Using the same window on both sides also means bins we
 * zero out fade smoothly at frame edges instead of producing clicks.
 */
export function sqrtHannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let n = 0; n < size; n++) w[n] = Math.sin((Math.PI * n) / size);
  return w;
}

/** One-sided spectra for every frame, stored flat (frame-major) to keep the
 *  memory in a few large typed arrays instead of hundreds of small ones. */
export interface Spectrogram {
  frameCount: number;
  /** FRAME_SIZE / 2 + 1: DC up to and including Nyquist. */
  binCount: number;
  /** Length of the original signal, so synthesis can crop the padding. */
  signalLength: number;
  re: Float64Array;
  im: Float64Array;
}

export class Stft {
  readonly frameSize: number;
  readonly hopSize: number;
  readonly binCount: number;
  readonly window: Float64Array;
  private readonly fft: FFT;
  // Scratch buffers reused for every frame to avoid allocating in the loop.
  private readonly bufRe: Float64Array;
  private readonly bufIm: Float64Array;

  constructor(frameSize = FRAME_SIZE, hopSize = HOP_SIZE) {
    this.frameSize = frameSize;
    this.hopSize = hopSize;
    this.binCount = frameSize / 2 + 1;
    this.window = sqrtHannWindow(frameSize);
    this.fft = new FFT(frameSize);
    this.bufRe = new Float64Array(frameSize);
    this.bufIm = new Float64Array(frameSize);
  }

  /**
   * Frames start one hop before the signal, so even the first and last samples
   * are covered by two overlapping frames. Without that padding the edges would
   * only get one half-window and come out attenuated.
   */
  frameCountFor(signalLength: number): number {
    if (signalLength === 0) return 0;
    return Math.floor((signalLength - 1 + this.hopSize) / this.hopSize) + 1;
  }

  private frameStart(frame: number): number {
    return frame * this.hopSize - this.hopSize;
  }

  analyze(signal: ArrayLike<number>): Spectrogram {
    const { frameSize, binCount, window, bufRe, bufIm } = this;
    const length = signal.length;
    const frameCount = this.frameCountFor(length);
    const re = new Float64Array(frameCount * binCount);
    const im = new Float64Array(frameCount * binCount);

    for (let f = 0; f < frameCount; f++) {
      const start = this.frameStart(f);
      for (let n = 0; n < frameSize; n++) {
        const i = start + n;
        // Outside the signal we read zeros: this is the padding described above.
        bufRe[n] = i >= 0 && i < length ? signal[i] * window[n] : 0;
        bufIm[n] = 0;
      }
      this.fft.transform(bufRe, bufIm);
      // A real signal's spectrum is mirror-symmetric, so only the first half
      // (plus Nyquist) carries information; the rest is rebuilt at synthesis.
      const offset = f * binCount;
      for (let k = 0; k < binCount; k++) {
        re[offset + k] = bufRe[k];
        im[offset + k] = bufIm[k];
      }
    }
    return { frameCount, binCount, signalLength: length, re, im };
  }

  /**
   * Weighted overlap-add. Each inverse-transformed frame is multiplied by the
   * synthesis window and summed; then each sample is divided by the total
   * window weight that landed on it. In the interior that weight is already 1,
   * but dividing explicitly keeps reconstruction exact for any window/hop pair.
   */
  synthesize(spec: Spectrogram): Float64Array {
    const { frameSize, binCount, window, bufRe, bufIm } = this;
    const length = spec.signalLength;
    const out = new Float64Array(length);
    const weight = new Float64Array(length);

    for (let f = 0; f < spec.frameCount; f++) {
      const offset = f * binCount;
      for (let k = 0; k < binCount; k++) {
        bufRe[k] = spec.re[offset + k];
        bufIm[k] = spec.im[offset + k];
      }
      // DC and Nyquist of a real signal have no imaginary part; forcing zero
      // guarantees the inverse comes out purely real.
      bufIm[0] = 0;
      bufIm[binCount - 1] = 0;
      // Rebuild the mirrored half: X[N-k] = conj(X[k]).
      for (let k = 1; k < binCount - 1; k++) {
        bufRe[frameSize - k] = bufRe[k];
        bufIm[frameSize - k] = -bufIm[k];
      }
      this.fft.transform(bufRe, bufIm, true);

      const start = this.frameStart(f);
      for (let n = 0; n < frameSize; n++) {
        const i = start + n;
        if (i < 0 || i >= length) continue;
        out[i] += bufRe[n] * window[n];
        weight[i] += window[n] * window[n];
      }
    }

    for (let i = 0; i < length; i++) {
      if (weight[i] > 1e-12) out[i] /= weight[i];
    }
    return out;
  }
}

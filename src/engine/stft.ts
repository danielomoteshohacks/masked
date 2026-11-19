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

/**
 * Short-time Fourier transform that works one frame at a time.
 *
 * Earlier versions kept the whole spectrogram in memory, which is fine for
 * 10 seconds but about 200 MB per channel for a five-minute song. Processing
 * frame by frame needs only the output signal and a few scratch buffers.
 */
export class Stft {
  readonly frameSize: number;
  readonly hopSize: number;
  readonly binCount: number;
  readonly window: Float64Array;
  private readonly fft: FFT;
  /**
   * Synthesis window with the weighted-overlap-add normalisation folded in:
   * w[n] / (w[n]^2 + w[n + hop]^2). Each output sample receives exactly two
   * contributions (from frames n and n +/- hop), and both see the same
   * denominator, so dividing up front equals dividing the finished sum. This
   * avoids keeping a second song-length buffer of window weights.
   */
  private readonly synthesisWindow: Float64Array;

  constructor(frameSize = FRAME_SIZE, hopSize = HOP_SIZE) {
    if (hopSize * 2 !== frameSize) throw new Error('This STFT assumes exactly 50% overlap.');
    this.frameSize = frameSize;
    this.hopSize = hopSize;
    this.binCount = frameSize / 2 + 1;
    this.window = sqrtHannWindow(frameSize);
    this.fft = new FFT(frameSize);
    this.synthesisWindow = new Float64Array(frameSize);
    for (let n = 0; n < frameSize; n++) {
      const w = this.window[n];
      const other = this.window[(n + hopSize) % frameSize];
      this.synthesisWindow[n] = w / (w * w + other * other);
    }
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

  frameStart(frame: number): number {
    return frame * this.hopSize - this.hopSize;
  }

  /**
   * Windowed FFT of one frame of the average of `channels` (pass a single
   * channel to transform just that one). re and im must have frameSize
   * entries and receive the full, mirror-symmetric spectrum.
   */
  forward(channels: readonly ArrayLike<number>[], frame: number, re: Float64Array, im: Float64Array): void {
    const { frameSize, window } = this;
    const start = this.frameStart(frame);
    const length = channels[0]?.length ?? 0;
    const scale = 1 / Math.max(1, channels.length);
    for (let n = 0; n < frameSize; n++) {
      const i = start + n;
      let v = 0;
      // Outside the signal we read zeros: this is the padding described above.
      if (i >= 0 && i < length) {
        for (const channel of channels) v += channel[i];
        v *= scale;
      }
      re[n] = v * window[n];
      im[n] = 0;
    }
    this.fft.transform(re, im);
  }

  /**
   * Inverse FFT of a full spectrum (destroying re/im), then overlap-add of the
   * result into `out` at the frame's position.
   */
  inverseAdd(re: Float64Array, im: Float64Array, frame: number, out: Float32Array): void {
    this.fft.transform(re, im, true);
    const start = this.frameStart(frame);
    const length = out.length;
    for (let n = 0; n < this.frameSize; n++) {
      const i = start + n;
      // The imaginary part is rounding noise (the spectrum is symmetric), so
      // only the real part is kept.
      if (i >= 0 && i < length) out[i] += re[n] * this.synthesisWindow[n];
    }
  }
}

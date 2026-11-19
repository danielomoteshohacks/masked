/**
 * Iterative radix-2 complex FFT.
 *
 * Written by hand rather than pulled from a library because it is small, has no
 * dependencies, and the engine only ever needs one fixed power-of-two size.
 * The sine/cosine and bit-reversal tables are built once per size, so each
 * transform only does the butterflies.
 */
export class FFT {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly bitReversed: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;

    // Twiddle factors e^(-2*pi*i*k/N) for k < N/2; every stage reads a strided
    // subset of this one table instead of calling Math.cos in the inner loop.
    const half = size >> 1;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const angle = (2 * Math.PI * k) / size;
      this.cosTable[k] = Math.cos(angle);
      this.sinTable[k] = Math.sin(angle);
    }

    // The iterative algorithm needs its input in bit-reversed order.
    const bits = Math.log2(size);
    this.bitReversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.bitReversed[i] = r;
    }
  }

  /**
   * In-place transform of (re, im). The inverse uses conjugate twiddles and
   * divides by N, so forward followed by inverse returns the original data.
   */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size;
    const rev = this.bitReversed;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      // Swap each pair only once (when j > i), otherwise it swaps back.
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    // A forward transform rotates by e^(-i*theta), the inverse by e^(+i*theta).
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let j = 0; j < half; j++) {
          const wr = this.cosTable[j * step];
          const wi = sign * this.sinTable[j * step];
          const a = start + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }

    if (inverse) {
      const scale = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= scale;
        im[i] *= scale;
      }
    }
  }
}

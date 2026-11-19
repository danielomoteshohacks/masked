import { MaskingModel, splToPower } from './masking';
import { Stft } from './stft';

export interface ProcessOptions {
  /**
   * Added to the model's threshold, in dB, before deciding what to remove.
   * 0 = the standard "average listener" model. Positive values raise the
   * threshold (remove more); negative values lower it (remove less).
   */
  offsetDb: number;
  /** false keeps every bin. Used to check the STFT round trip on its own. */
  removal?: boolean;
  /** Keep the removed signal as arrays. Off for whole songs, where the player
   *  rebuilds it as original minus processed instead (saves a song-length buffer). */
  keepRemoved?: boolean;
  /** Collect the downsampled time-frequency picture for the Masking Map. */
  collectMap?: boolean;
}

/** Downsampled spectrogram for display. Cells are stored column by column. */
export interface MaskingMapData {
  columns: number;
  rows: number;
  columnSeconds: number;
  minHz: number;
  maxHz: number;
  /** Mean power per cell in dBFS (sine-referenced). */
  levelDb: Float32Array;
  /** Share (0-1) of the cell's audible-level components that the model removes. */
  maskedShare: Float32Array;
}

/** Per-frame figures used to find the passages with the most hidden detail. */
export interface FrameStats {
  /** Time between frame centres, in seconds (one hop). */
  frameSeconds: number;
  /** Energy taken out of each frame (mono analysis, power units). */
  removedEnergy: Float32Array;
  /** Number of non-silent bins in each frame that the model removed. */
  maskedBins: Float32Array;
}

export interface ProcessResult {
  /** The audible part, as judged by the model. One array per input channel. */
  processed: Float32Array[];
  /** What was taken out: original minus processed, per channel. Empty if keepRemoved is false. */
  removed: Float32Array[];
  /** Energy of the removed signal as a percentage of the original's energy. */
  percentRemoved: number;
  /** Share of non-silent time-frequency components below the threshold, in percent. */
  maskedPercent: number;
  /** Largest absolute sample of the removed signal (for the boost limit). */
  removedPeak: number;
  frames: FrameStats;
  map: MaskingMapData | null;
}

/** Below about -120 dBFS a bin is digital silence, not sound that could be
 *  masked, so it is left out of the "how much is inaudible" figures. */
const SILENCE_POWER = splToPower(96 - 120);

const MAP_ROWS = 120;
const MAP_MIN_HZ = 30;
const MAP_MAX_HZ = 20000;
/** Enough columns for a sharp map on a wide screen, few enough to stay small. */
const MAP_TARGET_COLUMNS = 1600;

/**
 * The masking engine, run in chunks of frames so a whole song can be processed
 * with progress updates (and cancelled between chunks).
 *
 * For each frame: measure the mono power spectrum, compute the masking
 * threshold, mark each bin keep (1) or remove (0), soften that mask with its
 * neighbours in frequency and time, and apply it to every channel.
 */
export class ChunkedProcessor {
  readonly frameCount: number;
  private nextFrame = 0;
  private readonly channels: readonly Float32Array[];
  private readonly length: number;
  private readonly options: Required<ProcessOptions>;
  private readonly stft = new Stft();
  private readonly model: MaskingModel;
  private readonly powerScale: number;
  private readonly offsetGain: number;

  // Mask rows for three consecutive frames (f-1, f, f+1), the minimum the
  // time smoothing needs. Indexed by frame % 3.
  private readonly ringPower: Float64Array[];
  private readonly ringRaw: Float32Array[];
  private readonly ringFreq: Float32Array[];
  private decidedUpTo = -1;
  private readonly threshold: Float64Array;
  private readonly gains: Float32Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  private readonly processed: Float32Array[];
  private readonly removed: Float32Array[];
  private originalEnergy = 0;
  private removedEnergyTotal = 0;
  private removedPeak = 0;
  private componentCount = 0;
  private maskedCount = 0;
  private readonly frameRemoved: Float32Array;
  private readonly frameMasked: Float32Array;

  // Masking Map accumulators.
  private readonly framesPerColumn: number;
  private readonly mapColumns: number;
  private readonly rowBins: Int32Array[] = [];
  private readonly mapPower: Float64Array | null;
  private readonly mapBins: Float64Array | null;
  private readonly mapMasked: Float64Array | null;
  private readonly mapMaxHz: number;

  constructor(channels: readonly Float32Array[], sampleRate: number, options: ProcessOptions) {
    this.channels = channels;
    this.length = channels[0]?.length ?? 0;
    this.options = { removal: true, keepRemoved: true, collectMap: false, ...options };
    this.frameCount = this.stft.frameCountFor(this.length);
    const { frameSize, binCount, window } = this.stft;
    this.model = new MaskingModel(sampleRate, frameSize);

    // Scale |X|^2 so a sine's energy summed over its bins equals its mean-square
    // power (A^2 / 2). Factor 2: we only look at half the (mirrored) spectrum.
    // Dividing by N * sum(w^2) undoes the FFT's and the window's gain (Parseval).
    let windowEnergy = 0;
    for (const w of window) windowEnergy += w * w;
    this.powerScale = 2 / (frameSize * windowEnergy);
    this.offsetGain = Math.pow(10, options.offsetDb / 10);

    this.ringPower = [0, 1, 2].map(() => new Float64Array(binCount));
    this.ringRaw = [0, 1, 2].map(() => new Float32Array(binCount));
    this.ringFreq = [0, 1, 2].map(() => new Float32Array(binCount));
    this.threshold = new Float64Array(binCount);
    this.gains = new Float32Array(binCount);
    this.re = new Float64Array(frameSize);
    this.im = new Float64Array(frameSize);

    this.processed = channels.map((c) => new Float32Array(c.length));
    this.removed = this.options.keepRemoved ? channels.map((c) => new Float32Array(c.length)) : [];
    this.frameRemoved = new Float32Array(this.frameCount);
    this.frameMasked = new Float32Array(this.frameCount);

    this.framesPerColumn = Math.max(1, Math.ceil(this.frameCount / MAP_TARGET_COLUMNS));
    this.mapColumns = Math.ceil(this.frameCount / this.framesPerColumn);
    this.mapMaxHz = Math.min(MAP_MAX_HZ, sampleRate / 2);
    if (this.options.collectMap) {
      const cells = this.mapColumns * MAP_ROWS;
      this.mapPower = new Float64Array(cells);
      this.mapBins = new Float64Array(cells);
      this.mapMasked = new Float64Array(cells);
      // Rows are spaced logarithmically, like pitch. At the bottom a row can be
      // narrower than one FFT bin, so an empty row borrows its nearest bin.
      const binHz = sampleRate / frameSize;
      const ratio = this.mapMaxHz / MAP_MIN_HZ;
      for (let r = 0; r < MAP_ROWS; r++) {
        const lo = MAP_MIN_HZ * Math.pow(ratio, r / MAP_ROWS);
        const hi = MAP_MIN_HZ * Math.pow(ratio, (r + 1) / MAP_ROWS);
        const bins: number[] = [];
        for (let k = Math.ceil(lo / binHz); k < hi / binHz && k < binCount; k++) bins.push(k);
        if (bins.length === 0) bins.push(Math.min(binCount - 1, Math.round(Math.sqrt(lo * hi) / binHz)));
        this.rowBins.push(Int32Array.from(bins));
      }
    } else {
      this.mapPower = null;
      this.mapBins = null;
      this.mapMasked = null;
    }
  }

  get progress(): number {
    return this.frameCount === 0 ? 1 : this.nextFrame / this.frameCount;
  }

  get done(): boolean {
    return this.nextFrame >= this.frameCount;
  }

  /** Processes up to `maxFrames` more frames. */
  run(maxFrames: number): void {
    const end = Math.min(this.frameCount, this.nextFrame + maxFrames);
    for (let f = this.nextFrame; f < end; f++) this.processFrame(f);
    this.nextFrame = end;
  }

  /** Mono power, keep/remove decision and frequency-smoothed mask for one frame. */
  private decide(frame: number): void {
    const slot = frame % 3;
    const power = this.ringPower[slot];
    const raw = this.ringRaw[slot];
    const freq = this.ringFreq[slot];
    const { binCount } = this.stft;
    const { re, im } = this;

    // One mask for all channels, decided on the mono mix, so left and right
    // keep exactly the same bins and the stereo image does not wobble.
    this.stft.forward(this.channels, frame, re, im);
    for (let k = 0; k < binCount; k++) power[k] = (re[k] * re[k] + im[k] * im[k]) * this.powerScale;

    if (this.options.removal) {
      this.model.computeThreshold(power, this.threshold);
      for (let k = 0; k < binCount; k++) raw[k] = power[k] >= this.threshold[k] * this.offsetGain ? 1 : 0;
    } else {
      raw.fill(1);
    }

    // [1, 2, 1] / 4 across neighbouring bins. At the edges the missing
    // neighbour is replaced by the bin itself, so an all-kept row stays 1.
    for (let k = 0; k < binCount; k++) {
      const left = k > 0 ? raw[k - 1] : raw[k];
      const right = k < binCount - 1 ? raw[k + 1] : raw[k];
      freq[k] = (left + 2 * raw[k] + right) / 4;
    }
    this.decidedUpTo = frame;
  }

  private processFrame(f: number): void {
    const { binCount, frameSize, hopSize } = this.stft;
    // Time smoothing needs the next frame's decision before this frame can be output.
    while (this.decidedUpTo < Math.min(f + 1, this.frameCount - 1)) this.decide(this.decidedUpTo + 1);

    const cur = f % 3;
    const prev = f > 0 ? (f - 1) % 3 : cur;
    const next = f < this.frameCount - 1 ? (f + 1) % 3 : cur;
    const raw = this.ringRaw[cur];
    const power = this.ringPower[cur];
    const gains = this.gains;
    for (let k = 0; k < binCount; k++) {
      const blurred = (this.ringFreq[prev][k] + 2 * this.ringFreq[cur][k] + this.ringFreq[next][k]) / 4;
      // The blur may only raise a gain, never lower one: bins the model judged
      // audible stay at exactly 1. Otherwise the edges of every loud peak get
      // pulled down too (measured: a 1 kHz tone lost 2.5 dB without this).
      // Removed bins next to kept ones become partial gains, which gives the
      // soft edges that suppress "musical noise" (isolated bins blinking on
      // and off, heard as chirps).
      gains[k] = Math.max(raw[k], blurred);
    }

    this.collectStats(f, power, raw, gains);

    const { re, im } = this;
    for (let c = 0; c < this.channels.length; c++) {
      this.stft.forward([this.channels[c]], f, re, im);
      // A real gain scales magnitude but keeps phase, so what stays is unchanged
      // in timing. Applying it to bin k and its mirror N-k keeps the spectrum
      // symmetric, so the inverse comes out real.
      re[0] *= gains[0];
      im[0] *= gains[0];
      for (let k = 1; k < binCount; k++) {
        const g = gains[k];
        re[k] *= g;
        im[k] *= g;
        if (k < binCount - 1) {
          re[frameSize - k] *= g;
          im[frameSize - k] *= g;
        }
      }
      this.stft.inverseAdd(re, im, f, this.processed[c]);
    }

    // The first half of this frame now has both of its contributions (from
    // the previous frame and this one), so those samples are final.
    const start = Math.max(0, this.stft.frameStart(f));
    const end = Math.min(this.length, this.stft.frameStart(f) + hopSize);
    this.finalize(start, end);
  }

  private collectStats(f: number, power: Float64Array, raw: Float32Array, gains: Float32Array): void {
    const { binCount } = this.stft;
    let removedEnergy = 0;
    let masked = 0;
    let components = 0;
    for (let k = 0; k < binCount; k++) {
      const loss = 1 - gains[k];
      removedEnergy += power[k] * loss * loss;
      if (power[k] > SILENCE_POWER) {
        components++;
        if (raw[k] === 0) masked++;
      }
    }
    this.frameRemoved[f] = removedEnergy;
    this.frameMasked[f] = masked;
    this.componentCount += components;
    this.maskedCount += masked;

    if (this.mapPower && this.mapBins && this.mapMasked) {
      const col = Math.floor(f / this.framesPerColumn);
      for (let r = 0; r < MAP_ROWS; r++) {
        const cell = col * MAP_ROWS + r;
        for (const k of this.rowBins[r]) {
          this.mapPower[cell] += power[k];
          if (power[k] > SILENCE_POWER) {
            this.mapBins[cell] += 1;
            if (raw[k] === 0) this.mapMasked[cell] += 1;
          }
        }
      }
    }
  }

  private finalize(start: number, end: number): void {
    for (let c = 0; c < this.channels.length; c++) {
      const input = this.channels[c];
      const output = this.processed[c];
      const removed = this.removed[c];
      for (let i = start; i < end; i++) {
        const diff = input[i] - output[i];
        this.originalEnergy += input[i] * input[i];
        this.removedEnergyTotal += diff * diff;
        const a = Math.abs(diff);
        if (a > this.removedPeak) this.removedPeak = a;
        if (removed) removed[i] = diff;
      }
    }
  }

  result(): ProcessResult {
    if (!this.done) throw new Error('Processing has not finished.');
    let map: MaskingMapData | null = null;
    if (this.mapPower && this.mapBins && this.mapMasked) {
      const cells = this.mapColumns * MAP_ROWS;
      const levelDb = new Float32Array(cells);
      const maskedShare = new Float32Array(cells);
      for (let r = 0; r < MAP_ROWS; r++) {
        const binsInRow = this.rowBins[r].length;
        for (let col = 0; col < this.mapColumns; col++) {
          const cell = col * MAP_ROWS + r;
          const framesInColumn = Math.min(this.framesPerColumn, this.frameCount - col * this.framesPerColumn);
          const meanPower = this.mapPower[cell] / (binsInRow * framesInColumn);
          // dB relative to a full-scale sine's power (0.5), floored far below audibility.
          levelDb[cell] = 10 * Math.log10(meanPower / 0.5 + 1e-20);
          maskedShare[cell] = this.mapBins[cell] > 0 ? this.mapMasked[cell] / this.mapBins[cell] : 0;
        }
      }
      map = {
        columns: this.mapColumns,
        rows: MAP_ROWS,
        columnSeconds: (this.framesPerColumn * this.stft.hopSize) / this.sampleRateOf(),
        minHz: MAP_MIN_HZ,
        maxHz: this.mapMaxHz,
        levelDb,
        maskedShare,
      };
    }
    return {
      processed: this.processed,
      removed: this.removed,
      // Silence in means nothing to remove; avoid 0 / 0 = NaN.
      percentRemoved: this.originalEnergy > 0 ? (100 * this.removedEnergyTotal) / this.originalEnergy : 0,
      maskedPercent: this.componentCount > 0 ? (100 * this.maskedCount) / this.componentCount : 0,
      removedPeak: this.removedPeak,
      frames: {
        frameSeconds: this.stft.hopSize / this.sampleRateOf(),
        removedEnergy: this.frameRemoved,
        maskedBins: this.frameMasked,
      },
      map,
    };
  }

  private sampleRateOf(): number {
    return this.model.sampleRate;
  }
}

/** Processes everything in one go. Used for test sections and in the tests. */
export function processChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: ProcessOptions,
): ProcessResult {
  const processor = new ChunkedProcessor(channels, sampleRate, options);
  processor.run(Infinity);
  return processor.result();
}

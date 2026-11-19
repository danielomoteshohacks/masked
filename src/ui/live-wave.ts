/**
 * Animated waveform bars that react to whatever is playing.
 *
 * All waves share one analyser (on the app's output) and one animation
 * loop, so a page with several waves still reads the audio once per frame.
 * When nothing plays, or a wave is not "live", the bars breathe gently so
 * the page never looks frozen.
 */

const waves = new Set<LiveWave>();
let analyser: AnalyserNode | null = null;
let freq: Uint8Array<ArrayBuffer> = new Uint8Array(0);
let running = false;

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Connects every wave to the app's output analyser. */
export function setAnalyser(node: AnalyserNode): void {
  analyser = node;
  // Light smoothing: lively enough to follow the beat, not so twitchy it flickers.
  analyser.smoothingTimeConstant = 0.72;
  freq = new Uint8Array(analyser.frequencyBinCount);
}

export interface LiveWaveOptions {
  bars?: number;
  /** Height of the idle "breathing" motion, 0 to 1. */
  idle?: number;
}

export class LiveWave {
  live = true;
  private readonly bars: number;
  private readonly idle: number;
  private readonly levels: Float32Array;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: LiveWaveOptions = {},
  ) {
    this.bars = options.bars ?? 40;
    this.idle = options.idle ?? 0.12;
    this.levels = new Float32Array(this.bars);
    waves.add(this);
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }

  /** Draws one frame. `spectrum` is null when nothing is playing. */
  draw(time: number, spectrum: Uint8Array | null): void {
    // offsetParent is null when the canvas (or a parent) is hidden: skip it.
    if (this.canvas.offsetParent === null) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(this.canvas.clientWidth * dpr);
    const height = Math.round(this.canvas.clientHeight * dpr);
    if (width === 0 || height === 0) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const still = reducedMotion();
    const useAudio = this.live && spectrum !== null;
    for (let i = 0; i < this.bars; i++) {
      let target: number;
      if (useAudio && spectrum) {
        // Log-spaced bins, so bass, mids and treble each get a fair share of bars.
        const lo = Math.floor(Math.pow(spectrum.length * 0.6, i / this.bars));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(spectrum.length * 0.6, (i + 1) / this.bars)));
        let sum = 0;
        for (let k = lo; k < hi; k++) sum += spectrum[k] ?? 0;
        target = Math.pow(sum / (hi - lo) / 255, 1.3);
      } else {
        const wave = still ? 0.5 : 0.5 + 0.5 * Math.sin(time / 650 + i * 0.42);
        target = this.idle * (0.35 + 0.65 * wave);
      }
      // Rise fast, fall slowly: that is what makes bars feel musical.
      const prev = this.levels[i] ?? 0;
      this.levels[i] = target > prev ? target : prev * 0.9 + target * 0.1;
    }

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#8b5cf6');
    gradient.addColorStop(0.55, '#e05ccf');
    gradient.addColorStop(1, '#ff7a6b');
    ctx.fillStyle = gradient;
    const slot = width / this.bars;
    const barWidth = Math.max(2 * dpr, slot * 0.55);
    const mid = height / 2;
    for (let i = 0; i < this.bars; i++) {
      // Mirrored around the middle, with a minimum so silent bars stay visible dots.
      const h = Math.max(barWidth, (this.levels[i] ?? 0) * height * 0.95);
      const x = i * slot + (slot - barWidth) / 2;
      const r = barWidth / 2;
      ctx.beginPath();
      ctx.roundRect(x, mid - h / 2, barWidth, h, r);
      ctx.fill();
    }
  }
}

function tick(time: number): void {
  let spectrum: Uint8Array | null = null;
  if (analyser) {
    analyser.getByteFrequencyData(freq);
    // Treat near-silence as "nothing playing", so idle motion takes over.
    let energy = 0;
    for (let k = 0; k < freq.length; k += 8) energy += freq[k] ?? 0;
    if (energy > 40) spectrum = freq;
  }
  for (const wave of waves) wave.draw(time, spectrum);
  requestAnimationFrame(tick);
}

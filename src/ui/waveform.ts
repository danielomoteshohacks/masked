/** Default test length. Long enough to contain a musical phrase, short enough
 *  to remember while comparing versions in the ABX test. */
export const REGION_SECONDS = 10;
/** Arrow keys move the region by this much, for keyboard users. */
const KEY_STEP_SECONDS = 0.5;

/**
 * Canvas waveform with a draggable region of adjustable length.
 * Pointer events cover mouse, touch and pen with one code path.
 */
export class WaveformView {
  private mono: Float32Array | null = null;
  private duration = 0;
  private regionLength = 0;
  private start = 0;
  private playhead: number | null = null;
  // Min/max per pixel column, recomputed only when the width changes, so
  // dragging just redraws rectangles instead of rescanning millions of samples.
  private peakMin = new Float32Array(0);
  private peakMax = new Float32Array(0);
  private grab: { pointerId: number; offset: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onRegionChange: (startSeconds: number) => void,
  ) {
    canvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.handlePointerUp(e));
    canvas.addEventListener('keydown', (e) => this.handleKey(e));
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  get regionStart(): number {
    return this.start;
  }

  get regionDuration(): number {
    return this.regionLength;
  }

  setAudio(mono: Float32Array, sampleRate: number): void {
    this.mono = mono;
    this.duration = mono.length / sampleRate;
    // A song shorter than 10 s is used whole.
    this.regionLength = Math.min(REGION_SECONDS, this.duration);
    this.start = 0;
    this.playhead = null;
    this.resize();
  }

  /**
   * Places the region from code (for example the auto-picked passage).
   * Unlike a drag, this does not call onRegionChange: that callback means
   * "the user moved it".
   */
  setRegion(startSeconds: number, lengthSeconds: number): void {
    this.regionLength = Math.min(lengthSeconds, this.duration);
    this.start = Math.min(Math.max(0, startSeconds), this.duration - this.regionLength);
    this.draw();
  }

  /** Absolute time in the song to mark, or null to hide the marker. */
  setPlayhead(seconds: number | null): void {
    this.playhead = seconds;
    this.draw();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    // Back the canvas with device pixels so lines stay sharp on phone screens.
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.computePeaks();
    this.draw();
  }

  private computePeaks(): void {
    const columns = this.canvas.width;
    this.peakMin = new Float32Array(columns);
    this.peakMax = new Float32Array(columns);
    const mono = this.mono;
    if (!mono || mono.length === 0) return;
    const perColumn = mono.length / columns;
    for (let x = 0; x < columns; x++) {
      const from = Math.floor(x * perColumn);
      const to = Math.max(from + 1, Math.floor((x + 1) * perColumn));
      let lo = 0;
      let hi = 0;
      for (let i = from; i < to && i < mono.length; i++) {
        const v = mono[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      this.peakMin[x] = lo;
      this.peakMax[x] = hi;
    }
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.canvas;
    const styles = getComputedStyle(this.canvas);
    const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;

    ctx.clearRect(0, 0, width, height);
    if (!this.mono || this.duration === 0) return;

    const toX = (seconds: number) => (seconds / this.duration) * width;
    const regionX0 = toX(this.start);
    const regionX1 = toX(this.start + this.regionLength);

    ctx.fillStyle = color('--region', 'rgba(138, 180, 220, 0.18)');
    ctx.fillRect(regionX0, 0, regionX1 - regionX0, height);

    // Brighter inside the region so it is obvious which part will be tested.
    const mid = height / 2;
    const dim = color('--wave-dim', '#555');
    const bright = color('--wave', '#ddd');
    for (let x = 0; x < width; x++) {
      ctx.fillStyle = x >= regionX0 && x <= regionX1 ? bright : dim;
      const top = mid - this.peakMax[x] * mid;
      const bottom = mid - this.peakMin[x] * mid;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }

    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = color('--accent', '#8ab4dc');
    ctx.fillRect(regionX0, 0, 2 * dpr, height);
    ctx.fillRect(regionX1 - 2 * dpr, 0, 2 * dpr, height);

    if (this.playhead !== null) {
      ctx.fillStyle = color('--fg', '#fff');
      ctx.fillRect(toX(this.playhead), 0, 1.5 * dpr, height);
    }

    this.canvas.setAttribute('aria-valuenow', this.start.toFixed(1));
    this.canvas.setAttribute('aria-valuemax', (this.duration - this.regionLength).toFixed(1));
  }

  private timeAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * this.duration;
  }

  private setStart(seconds: number): void {
    const clamped = Math.min(Math.max(0, seconds), this.duration - this.regionLength);
    if (clamped === this.start) return;
    this.start = clamped;
    this.draw();
    this.onRegionChange(this.start);
  }

  private handlePointerDown(e: PointerEvent): void {
    if (!this.mono) return;
    const t = this.timeAt(e.clientX);
    if (t < this.start || t > this.start + this.regionLength) {
      // Tapping outside the region jumps it there, centred on the tap, which
      // is quicker on a phone than dragging across a whole song.
      this.setStart(t - this.regionLength / 2);
    }
    // Remember where inside the region it was grabbed, so it does not jump
    // to align its left edge with the finger.
    this.grab = { pointerId: e.pointerId, offset: t - this.start };
    // Capture keeps the drag going if the finger slides off the canvas.
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.grab || this.grab.pointerId !== e.pointerId) return;
    this.setStart(this.timeAt(e.clientX) - this.grab.offset);
  }

  private handlePointerUp(e: PointerEvent): void {
    if (this.grab?.pointerId === e.pointerId) this.grab = null;
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowLeft') this.setStart(this.start - KEY_STEP_SECONDS);
    else if (e.key === 'ArrowRight') this.setStart(this.start + KEY_STEP_SECONDS);
    else return;
    e.preventDefault();
  }
}

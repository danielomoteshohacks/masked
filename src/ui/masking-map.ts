import type { MaskingMapData } from '../engine/process';

/** Dynamic range shown on the map, below its loudest cell. Quieter is drawn black. */
const RANGE_DB = 75;
const AXIS_LEFT = 38;
const AXIS_BOTTOM = 20;

type Rgb = [number, number, number];

function parseHex(value: string, fallback: Rgb): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m || !m[1]) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/**
 * Full-song spectrogram: time left to right, frequency (log scale) bottom to
 * top. Brightness is level; colour shows what the model removes: lavender for
 * audible content, gold for masked content. Tapping seeks.
 */
export class MaskingMapView {
  private image: HTMLCanvasElement | null = null;
  private duration = 0;
  private playhead: number | null = null;
  private moments: number[] = [];
  private map: MaskingMapData | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSeek: (seconds: number) => void,
  ) {
    canvas.addEventListener('click', (e) => {
      const t = this.timeAt(e.clientX);
      if (t !== null) this.onSeek(t);
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setData(map: MaskingMapData, durationSeconds: number): void {
    this.map = map;
    this.duration = durationSeconds;
    this.image = this.renderImage(map);
    this.draw();
  }

  clear(): void {
    this.map = null;
    this.image = null;
    this.moments = [];
    this.playhead = null;
    this.draw();
  }

  setMoments(times: number[]): void {
    this.moments = times;
    this.draw();
  }

  setPlayhead(seconds: number | null): void {
    this.playhead = seconds;
    this.draw();
  }

  /** Renders one pixel per map cell; drawing scales it to the canvas. */
  private renderImage(map: MaskingMapData): HTMLCanvasElement {
    const styles = getComputedStyle(this.canvas);
    const kept = parseHex(styles.getPropertyValue('--map-kept'), [223, 228, 234]);
    const masked = parseHex(styles.getPropertyValue('--gold'), [255, 201, 77]);

    // Normalise to the loudest cell so every song uses the full brightness range.
    let maxDb = -Infinity;
    for (const v of map.levelDb) if (v > maxDb) maxDb = v;
    const floorDb = maxDb - RANGE_DB;

    const image = document.createElement('canvas');
    image.width = map.columns;
    image.height = map.rows;
    const ctx = image.getContext('2d');
    if (!ctx) return image;
    const data = ctx.createImageData(map.columns, map.rows);
    for (let col = 0; col < map.columns; col++) {
      for (let row = 0; row < map.rows; row++) {
        const cell = col * map.rows + row;
        // A gentle curve lifts quiet detail so it is visible, as on studio spectrum displays.
        const v = Math.pow(Math.min(1, Math.max(0, (map.levelDb[cell] - floorDb) / RANGE_DB)), 1.4);
        const share = map.maskedShare[cell];
        // Masked content is usually quiet, so its colour gets a minimum
        // brightness; otherwise the very thing the map is about would be invisible.
        const mv = share > 0 ? Math.max(v, 0.18 + 0.3 * share) * share : 0;
        const kv = v * (1 - share);
        // High frequencies at the top: flip the row.
        const p = ((map.rows - 1 - row) * map.columns + col) * 4;
        data.data[p] = Math.min(255, kept[0] * kv + masked[0] * mv);
        data.data[p + 1] = Math.min(255, kept[1] * kv + masked[1] * mv);
        data.data[p + 2] = Math.min(255, kept[2] * kv + masked[2] * mv);
        data.data[p + 3] = 255;
      }
    }
    ctx.putImageData(data, 0, 0);
    return image;
  }

  private plotRect(width: number, height: number, dpr: number) {
    return { x: AXIS_LEFT * dpr, y: 0, w: width - AXIS_LEFT * dpr, h: height - AXIS_BOTTOM * dpr };
  }

  private timeAt(clientX: number): number | null {
    if (!this.map || this.duration === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - AXIS_LEFT;
    const w = rect.width - AXIS_LEFT;
    if (x < 0 || x > w) return null;
    return (x / w) * this.duration;
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    // Only resize the backing store when needed; resizing clears and is slow.
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const map = this.map;
    if (!map || !this.image) return;

    const styles = getComputedStyle(this.canvas);
    const muted = styles.getPropertyValue('--faint').trim() || '#7d74ad';
    const accent = styles.getPropertyValue('--gold').trim() || '#ffc94d';
    const fg = styles.getPropertyValue('--fg').trim() || '#f7f4ff';
    const plot = this.plotRect(width, height, dpr);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, plot.x, plot.y, plot.w, plot.h);

    ctx.font = `${11 * dpr}px "JetBrains Mono Variable", ui-monospace, monospace`;
    ctx.fillStyle = muted;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const logRange = Math.log(map.maxHz / map.minHz);
    for (const [hz, label] of [[100, '100'], [1000, '1k'], [10000, '10k']] as const) {
      if (hz > map.maxHz) continue;
      const y = plot.y + plot.h * (1 - Math.log(hz / map.minHz) / logRange);
      ctx.fillText(label, plot.x - 8 * dpr, y);
      ctx.fillRect(plot.x, y, 4 * dpr, 1 * dpr);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = this.duration > 600 ? 120 : this.duration > 240 ? 60 : this.duration > 90 ? 30 : 10;
    for (let t = 0; t <= this.duration; t += step) {
      const x = plot.x + (t / this.duration) * plot.w;
      ctx.fillText(formatTime(t), Math.min(width - 16 * dpr, Math.max(plot.x + 14 * dpr, x)), plot.h + 5 * dpr);
    }

    // Numbered markers for the moments with the most hidden detail.
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${10 * dpr}px "Inter Variable", system-ui, sans-serif`;
    this.moments.forEach((t, i) => {
      const x = plot.x + (t / this.duration) * plot.w;
      ctx.fillStyle = accent;
      ctx.fillRect(x - 0.5 * dpr, plot.y, 1 * dpr, plot.h);
      ctx.beginPath();
      ctx.arc(x, plot.y + 10 * dpr, 8 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2a1d00';
      ctx.fillText(String(i + 1), x, plot.y + 10.5 * dpr);
    });

    if (this.playhead !== null) {
      const x = plot.x + (this.playhead / this.duration) * plot.w;
      ctx.fillStyle = fg;
      ctx.fillRect(x - dpr, plot.y, 2 * dpr, plot.h);
    }
  }
}

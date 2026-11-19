import type { ChartTrial } from './staircase-chart';

export interface ResultCardData {
  thresholdDb: number;
  reliable: boolean;
  interpretation: string;
  correct: number;
  total: number;
  pValueText: string;
  dPrime: number;
  headphonesPassed: boolean;
  passageSeconds: number;
  date: Date;
  trials: readonly ChartTrial[];
  minDb: number;
  maxDb: number;
}

const W = 1080;
const H = 1350;
const SANS = '"Inter Variable", system-ui, sans-serif';
const MONO = '"JetBrains Mono Variable", ui-monospace, monospace';
const BG = '#0b0c0e';
const FG = '#ecebe6';
const MUTED = '#8f959d';
const FAINT = '#353b43';
const ACCENT = '#ffb238';

/** Splits text into lines that fit `maxWidth` at the context's current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Draws the shareable result card (portrait, 1080 x 1350: the size social
 * apps show without cropping) and returns it as a PNG. Fonts are loaded
 * first: a canvas silently falls back to a default font if they are not ready.
 */
export async function renderResultCard(d: ResultCardData): Promise<Blob> {
  await Promise.all([
    document.fonts.load(`700 100px ${SANS}`),
    document.fonts.load(`600 100px ${MONO}`),
  ]).catch(() => undefined);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.7, -100, 0, W * 0.7, -100, 900);
  glow.addColorStop(0, 'rgba(255, 178, 56, 0.20)');
  glow.addColorStop(1, 'rgba(255, 178, 56, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = FAINT;
  ctx.lineWidth = 2;
  ctx.strokeRect(40, 40, W - 80, H - 80);

  const left = 96;
  // Wordmark: four meter bars, the tallest lit.
  [0.4, 0.75, 1, 0.55].forEach((h, i) => {
    ctx.fillStyle = i === 2 ? ACCENT : MUTED;
    ctx.fillRect(left + i * 12, 132 - 44 * h, 7, 44 * h);
  });
  ctx.fillStyle = FG;
  ctx.font = `700 40px ${SANS}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Masked', left + 62, 130);
  ctx.fillStyle = MUTED;
  ctx.font = `500 26px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(d.date.toISOString().slice(0, 10), W - left, 130);
  ctx.textAlign = 'left';

  ctx.fillStyle = ACCENT;
  ctx.font = `500 26px ${MONO}`;
  ctx.fillText('MY MASKING THRESHOLD', left, 260);
  const value = `${d.thresholdDb > 0 ? '+' : ''}${d.thresholdDb.toFixed(1)} dB`;
  ctx.font = `600 190px ${MONO}`;
  ctx.fillText(value, left - 8, 450);
  ctx.fillStyle = MUTED;
  ctx.font = `400 32px ${SANS}`;
  ctx.fillText('from the standard model of an average listener', left, 510);

  ctx.fillStyle = FG;
  ctx.font = `650 50px ${SANS}`;
  let y = 610;
  for (const line of wrap(ctx, d.interpretation, W - 2 * left)) {
    ctx.fillText(line, left, y);
    y += 64;
  }

  // Mini staircase: offset per trial, with the threshold and the model line.
  const chartTop = 780;
  const chartH = 260;
  const chartW = W - 2 * left;
  const n = Math.max(2, d.trials.length);
  const cx = (i: number) => left + (i / (n - 1)) * chartW;
  const cy = (db: number) => chartTop + ((d.maxDb - db) / (d.maxDb - d.minDb)) * chartH;
  ctx.strokeStyle = FAINT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left, cy(0));
  ctx.lineTo(left + chartW, cy(0));
  ctx.stroke();
  ctx.setLineDash([14, 10]);
  ctx.strokeStyle = ACCENT;
  ctx.beginPath();
  ctx.moveTo(left, cy(d.thresholdDb));
  ctx.lineTo(left + chartW, cy(d.thresholdDb));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = MUTED;
  ctx.lineWidth = 3;
  ctx.beginPath();
  d.trials.forEach((t, i) => (i === 0 ? ctx.moveTo(cx(i), cy(t.offsetDb)) : ctx.lineTo(cx(i), cy(t.offsetDb))));
  ctx.stroke();
  d.trials.forEach((t, i) => {
    ctx.beginPath();
    ctx.arc(cx(i), cy(t.offsetDb), 8, 0, Math.PI * 2);
    ctx.fillStyle = t.correct ? FG : BG;
    ctx.fill();
    ctx.strokeStyle = FG;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
  ctx.fillStyle = MUTED;
  ctx.font = `400 24px ${MONO}`;
  ctx.fillText('standard model', left, cy(0) - 14);

  // Stats row.
  const stats: [string, string][] = [
    ['CORRECT', `${d.correct}/${d.total}`],
    // The label already says what the number is, so "p = " is dropped.
    ['P-VALUE', d.pValueText.replace(/^p\s*=\s*/, '')],
    ["D'", d.dPrime.toFixed(2)],
    ['HEADPHONES', d.headphonesPassed ? 'checked' : 'unverified'],
  ];
  const colW = chartW / stats.length;
  stats.forEach(([label, v], i) => {
    const x = left + i * colW;
    ctx.fillStyle = MUTED;
    ctx.font = `500 22px ${MONO}`;
    ctx.fillText(label, x, 1130);
    ctx.fillStyle = FG;
    ctx.font = `600 34px ${MONO}`;
    ctx.fillText(v, x, 1176);
  });

  ctx.fillStyle = MUTED;
  ctx.font = `400 24px ${SANS}`;
  const note =
    `${d.passageSeconds} s passage, blind ABX staircase.` + (d.reliable ? '' : ' Low confidence.') +
    ' Not a medical hearing test.';
  ctx.fillText(note, left, 1250);

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))), 'image/png'),
  );
}

export interface ResultCardData {
  score: number;
  sentence: string;
  takeaway: string;
  date: Date;
}

const W = 1080;
const H = 1350;
const DISPLAY = '"Plus Jakarta Sans Variable", "Inter Variable", system-ui, sans-serif';
const SANS = '"Inter Variable", system-ui, sans-serif';

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
 * Draws the shareable score card (portrait 1080 x 1350, the size social
 * apps show without cropping) and returns it as a PNG. Fonts are loaded
 * first: a canvas silently falls back to a default font if they are not ready.
 */
export async function renderResultCard(d: ResultCardData): Promise<Blob> {
  await Promise.all([document.fonts.load(`800 100px ${DISPLAY}`), document.fonts.load(`500 40px ${SANS}`)]).catch(
    () => undefined,
  );

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');

  // Deep indigo base with two soft colour glows, like the app background.
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, '#1a1047');
  base.addColorStop(1, '#0b0820');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  for (const [x, y, r, color] of [
    [W * 0.15, H * 0.1, 700, 'rgba(139, 92, 246, 0.55)'],
    [W * 0.95, H * 0.55, 650, 'rgba(255, 122, 107, 0.40)'],
  ] as const) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  const accent = ctx.createLinearGradient(240, 0, 840, 0);
  accent.addColorStop(0, '#a78bfa');
  accent.addColorStop(0.5, '#e05ccf');
  accent.addColorStop(1, '#ff7a6b');

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.font = `600 34px ${SANS}`;
  ctx.fillText('MY EAR SCORE', W / 2, 170);

  // Score ring: a faint full circle with the score's share drawn in the gradient.
  // Fixed layout from the top: label, ring, sentence (up to 3 lines), takeaway
  // pill, then a footer pinned to the bottom, so nothing can overlap.
  const cx = W / 2;
  const cy = 420;
  const radius = 200;
  ctx.lineCap = 'round';
  ctx.lineWidth = 34;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.max(0.01, d.score)) / 100);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 210px ${DISPLAY}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(String(d.score), cx, cy + 6);
  ctx.font = `600 40px ${SANS}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.fillText('out of 100', cx, cy + 120);
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = '#ffffff';
  ctx.font = `750 52px ${DISPLAY}`;
  let y = 750;
  for (const line of wrap(ctx, d.sentence, W - 200).slice(0, 3)) {
    ctx.fillText(line, cx, y);
    y += 68;
  }

  // The takeaway in a pill.
  ctx.font = `600 36px ${SANS}`;
  const lines = wrap(ctx, d.takeaway, W - 280).slice(0, 2);
  const pillH = 50 * lines.length + 50;
  const pillY = y + 20;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.beginPath();
  ctx.roundRect(110, pillY, W - 220, pillH, 40);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => ctx.fillText(line, cx, pillY + 62 + i * 50));

  ctx.font = `800 44px ${DISPLAY}`;
  ctx.fillStyle = accent;
  ctx.fillText('Can your ears beat MP3?', cx, H - 120);
  ctx.font = `500 28px ${SANS}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.fillText(`Masked · ${d.date.toLocaleDateString()} · Just for fun, not a hearing test`, cx, H - 68);

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))), 'image/png'),
  );
}

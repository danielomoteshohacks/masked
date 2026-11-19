import { DEFAULT_STAIRCASE } from '../quiz/staircase';

export interface ChartTrial {
  offsetDb: number;
  correct: boolean;
  reversal: boolean;
}

/**
 * SVG chart of the offset used on each trial. Built as a string because it
 * only contains numbers we generate (no user text), and the viewBox lets it
 * scale to any width. Colors come from the page's CSS variables via style
 * attributes, since SVG presentation attributes cannot read var().
 */
export function renderStaircaseChart(trials: readonly ChartTrial[], thresholdDb: number): string {
  const width = 600;
  const height = 280;
  const m = { left: 44, right: 16, top: 16, bottom: 36 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const yMin = DEFAULT_STAIRCASE.minDb;
  const yMax = DEFAULT_STAIRCASE.maxDb;
  const n = Math.max(trials.length, 2);

  const x = (i: number) => m.left + (i / (n - 1)) * plotW;
  const y = (db: number) => m.top + ((yMax - db) / (yMax - yMin)) * plotH;
  const parts: string[] = [];

  for (let db = yMin; db <= yMax; db += 10) {
    parts.push(
      `<line x1="${m.left}" x2="${width - m.right}" y1="${y(db)}" y2="${y(db)}" style="stroke:var(--border)" />`,
      `<text x="${m.left - 8}" y="${y(db) + 4}" text-anchor="end" style="fill:var(--muted);font-size:16px">${db > 0 ? '+' : ''}${db}</text>`,
    );
  }
  // 0 dB is the standard model; drawing it makes "above or below the model" readable at a glance.
  parts.push(
    `<line x1="${m.left}" x2="${width - m.right}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--muted);stroke-width:1.5" />`,
    `<text x="${width - m.right}" y="${y(0) - 6}" text-anchor="end" style="fill:var(--muted);font-size:16px">standard model</text>`,
    `<line x1="${m.left}" x2="${width - m.right}" y1="${y(thresholdDb)}" y2="${y(thresholdDb)}" style="stroke:var(--ok);stroke-dasharray:6 4;stroke-width:1.5" />`,
    `<text x="${m.left + 6}" y="${y(thresholdDb) - 6}" style="fill:var(--ok);font-size:16px">your threshold</text>`,
  );

  const step = trials.length > 15 ? 5 : 1;
  trials.forEach((_, i) => {
    if ((i + 1) % step !== 0 && i !== 0) return;
    parts.push(
      `<text x="${x(i)}" y="${height - m.bottom + 18}" text-anchor="middle" style="fill:var(--muted);font-size:16px">${i + 1}</text>`,
    );
  });
  parts.push(
    `<text x="${m.left + plotW / 2}" y="${height - 4}" text-anchor="middle" style="fill:var(--muted);font-size:16px">trial</text>`,
  );

  if (trials.length > 1) {
    const points = trials.map((t, i) => `${x(i)},${y(t.offsetDb)}`).join(' ');
    parts.push(`<polyline points="${points}" style="fill:none;stroke:var(--accent);stroke-width:1.5" />`);
  }
  trials.forEach((t, i) => {
    // Filled = correct, hollow = wrong; a ring marks where the direction turned.
    const fill = t.correct ? 'var(--accent)' : 'var(--bg)';
    const stroke = t.correct ? 'var(--accent)' : 'var(--error)';
    parts.push(`<circle cx="${x(i)}" cy="${y(t.offsetDb)}" r="5" style="fill:${fill};stroke:${stroke};stroke-width:2" />`);
    if (t.reversal) {
      parts.push(`<circle cx="${x(i)}" cy="${y(t.offsetDb)}" r="9" style="fill:none;stroke:var(--fg);stroke-width:1" />`);
    }
  });

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>
<p class="hint">Filled dot: correct. Hollow red dot: wrong. Ringed: the staircase changed direction. Higher offsets remove more.</p>`;
}

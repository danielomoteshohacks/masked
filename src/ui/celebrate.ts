/** Small celebration effects for the score screen. Both respect the
 *  "reduce motion" setting: the final state is shown without animation. */

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Counts a number up to `value`, easing out, and calls `onFrame` with each value. */
export function countUp(value: number, durationMs: number, onFrame: (current: number) => void): void {
  if (reducedMotion()) {
    onFrame(value);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    // Cubic ease-out: fast at first, settling gently on the final number.
    onFrame(Math.round(value * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const COLORS = ['#8b5cf6', '#b67cff', '#e05ccf', '#ff7a6b', '#ffc46b', '#ffffff'];

/** A short confetti burst from the top of the screen, drawn on a temporary canvas. */
export function confetti(): void {
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }

  const pieces = Array.from({ length: 140 }, () => ({
    x: (0.2 + Math.random() * 0.6) * canvas.width,
    y: canvas.height * 0.28,
    vx: (Math.random() - 0.5) * 14 * dpr,
    vy: (-6 - Math.random() * 12) * dpr,
    size: (5 + Math.random() * 7) * dpr,
    spin: Math.random() * Math.PI,
    vspin: (Math.random() - 0.5) * 0.3,
    color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#ffffff',
  }));

  const start = performance.now();
  const frame = (now: number) => {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Fade out over the last 600 ms of a 2.6 s burst.
    ctx.globalAlpha = Math.max(0, Math.min(1, (2600 - elapsed) / 600));
    for (const p of pieces) {
      p.vy += 0.35 * dpr;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.spin += p.vspin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (elapsed < 2600) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

import { describe, expect, it } from 'vitest';
import { correctToneIndex, headphoneCheckPassed, randomToneOrder, renderHeadphoneTrial } from './headphones';

const SR = 8000;

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

describe('headphone check', () => {
  it('renders the quiet tone 6 dB down and the antiphase tone inverted on the right', () => {
    const [left, right] = renderHeadphoneTrial(['standard', 'quiet', 'antiphase'], SR);
    // Tones start after a 0.2 s lead-in, last 1 s and are 0.5 s apart.
    const tone = (i: number) => [Math.round((0.2 + i * 1.5 + 0.3) * SR), Math.round((0.2 + i * 1.5 + 0.7) * SR)] as const;
    const [s0, s1] = tone(0);
    const [q0, q1] = tone(1);
    const [a0, a1] = tone(2);
    expect(20 * Math.log10(rms(left, q0, q1) / rms(left, s0, s1))).toBeCloseTo(-6, 2);
    expect(rms(left, a0, a1)).toBeCloseTo(rms(left, s0, s1), 6);
    for (let i = s0; i < s1; i += 37) expect(right[i]).toBe(left[i]);
    for (let i = a0; i < a1; i += 37) expect(right[i]).toBe(-left[i]);
  });

  it('uses every role exactly once per trial and identifies the correct answer', () => {
    let seed = 0.1;
    const random = () => (seed = (seed * 9301 + 0.49297) % 1);
    for (let n = 0; n < 20; n++) {
      const order = randomToneOrder(random);
      expect([...order].sort()).toEqual(['antiphase', 'quiet', 'standard']);
      expect(order[correctToneIndex(order)]).toBe('quiet');
    }
  });

  it('passes at 5 of 6', () => {
    expect(headphoneCheckPassed(6)).toBe(true);
    expect(headphoneCheckPassed(5)).toBe(true);
    expect(headphoneCheckPassed(4)).toBe(false);
  });
});

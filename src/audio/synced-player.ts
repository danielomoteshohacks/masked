/** Crossfade length. Long enough to avoid a click, short enough that the
 *  switch feels instant and the listener compares the same moment of music. */
export const CROSSFADE_SECONDS = 0.015;
/** Points in the crossfade curve; plenty for a smooth 15 ms fade. */
const CURVE_POINTS = 64;
/** Sources are started slightly in the future so they all begin on exactly
 *  the same sample, even if creating them takes a few milliseconds. */
const START_DELAY_SECONDS = 0.03;

interface Fade {
  from: number;
  to: number;
  start: number;
}

interface Running {
  sources: AudioBufferSourceNode[];
  gains: Map<string, GainNode>;
  master: GainNode;
  startTime: number;
  duration: number;
}

/**
 * Plays several equal-length versions of the same audio on one looping
 * timeline. Every version runs all the time with its own gain; only the
 * active one is audible. Switching crossfades between gains, so the music
 * carries on from the same position instead of restarting, and the listener
 * compares the versions at the same moment.
 */
export class SyncedPlayer {
  private versions = new Map<string, AudioBuffer>();
  private levels = new Map<string, number>();
  private masterLevel = 1;
  private running: Running | null = null;
  private fades = new Map<string, Fade>();
  private activeKey: string | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly onChange: () => void = () => {},
  ) {}

  /**
   * Replaces the versions (stopping playback). masterLevel is applied to all
   * versions equally, e.g. the headroom that keeps them from clipping.
   * levels are per-version multipliers (default 1), e.g. the removed-audio boost.
   */
  load(versions: Record<string, AudioBuffer>, masterLevel = 1, levels: Record<string, number> = {}): void {
    this.stop();
    const buffers = Object.values(versions);
    const length = buffers[0]?.length;
    // Different lengths would loop at different points and drift apart.
    if (buffers.some((b) => b.length !== length)) throw new Error('All versions must have the same length.');
    this.versions = new Map(Object.entries(versions));
    this.levels = new Map(Object.entries(levels));
    this.masterLevel = masterLevel;
  }

  get active(): string | null {
    return this.activeKey;
  }

  /** Position within the loop in seconds, or null when stopped. */
  position(): number | null {
    const r = this.running;
    if (!r) return null;
    const t = this.context.currentTime - r.startTime;
    return t <= 0 ? 0 : t % r.duration;
  }

  play(key: string): void {
    if (!this.versions.has(key)) throw new Error(`Unknown version: ${key}`);
    if (!this.running) this.start(key);
    else if (key !== this.activeKey) this.crossfade(key);
    this.activeKey = key;
    this.onChange();
  }

  /** Changes one version's level, smoothly if it is the one playing. */
  setLevel(key: string, level: number): void {
    this.levels.set(key, level);
    const gain = this.running?.gains.get(key);
    if (!gain || key !== this.activeKey) return;
    const now = this.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(this.valueAt(key, now), now);
    gain.gain.linearRampToValueAtTime(level, now + CROSSFADE_SECONDS);
    this.fades.set(key, { from: level, to: level, start: -Infinity });
  }

  stop(): void {
    const r = this.running;
    if (!r) return;
    this.running = null;
    this.activeKey = null;
    const now = this.context.currentTime;
    // Fade the whole mix out instead of cutting it mid-waveform.
    r.master.gain.cancelScheduledValues(now);
    r.master.gain.setValueAtTime(r.master.gain.value, now);
    r.master.gain.linearRampToValueAtTime(0, now + CROSSFADE_SECONDS);
    for (const source of r.sources) {
      source.stop(now + CROSSFADE_SECONDS + 0.01);
      source.onended = () => source.disconnect();
    }
    setTimeout(() => r.master.disconnect(), (CROSSFADE_SECONDS + 0.1) * 1000);
    this.onChange();
  }

  private level(key: string): number {
    return this.levels.get(key) ?? 1;
  }

  private start(activeKey: string): void {
    // iOS unlocks audio only inside a user gesture, so resume() is called
    // synchronously here, in the click handler, without awaiting.
    void this.context.resume();
    const now = this.context.currentTime;
    const when = now + START_DELAY_SECONDS;

    const master = this.context.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.setValueAtTime(0, when);
    master.gain.linearRampToValueAtTime(this.masterLevel, when + CROSSFADE_SECONDS);
    master.connect(this.context.destination);

    const sources: AudioBufferSourceNode[] = [];
    const gains = new Map<string, GainNode>();
    this.fades.clear();
    let duration = 0;
    for (const [key, buffer] of this.versions) {
      const value = key === activeKey ? this.level(key) : 0;
      const gain = this.context.createGain();
      gain.gain.setValueAtTime(value, now);
      gain.connect(master);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      // The same start time for every source is what keeps them in sync:
      // they are all sample-locked to the audio clock from here on.
      source.start(when);
      sources.push(source);
      gains.set(key, gain);
      this.fades.set(key, { from: value, to: value, start: -Infinity });
      duration = buffer.duration;
    }
    this.running = { sources, gains, master, startTime: when, duration };
  }

  /** Current gain of a version, following any crossfade still in progress. */
  private valueAt(key: string, time: number): number {
    const fade = this.fades.get(key);
    if (!fade) return 0;
    const t = (time - fade.start) / CROSSFADE_SECONDS;
    if (t >= 1) return fade.to;
    return equalPower(fade.from, fade.to, Math.max(0, t));
  }

  private crossfade(toKey: string): void {
    const r = this.running;
    if (!r) return;
    const now = this.context.currentTime;
    for (const [key, gain] of r.gains) {
      const from = this.valueAt(key, now);
      const to = key === toKey ? this.level(key) : 0;
      if (Math.abs(from - to) < 1e-6) continue;
      const curve = new Float32Array(CURVE_POINTS);
      for (let i = 0; i < CURVE_POINTS; i++) curve[i] = equalPower(from, to, i / (CURVE_POINTS - 1));
      // Cancelling also removes a crossfade still in progress (a fast double
      // switch). The new curve starts from that fade's current value, so
      // there is no jump.
      gain.gain.cancelScheduledValues(now);
      try {
        gain.gain.setValueCurveAtTime(curve, now, CROSSFADE_SECONDS);
      } catch {
        // Some browsers refuse a curve that touches a cancelled one; an
        // instant change is the safe fallback.
        gain.gain.setValueAtTime(to, now);
      }
      this.fades.set(key, { from, to, start: now });
    }
  }
}

/**
 * Equal-power crossfade shape: the outgoing gain follows cos and the incoming
 * one follows sin over a quarter turn, so for uncorrelated material the total
 * power stays constant through the fade.
 */
function equalPower(from: number, to: number, t: number): number {
  return from * Math.cos((t * Math.PI) / 2) + to * Math.sin((t * Math.PI) / 2);
}

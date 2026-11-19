/** Crossfade length. Long enough to avoid a click, short enough that the
 *  switch feels instant and the listener compares the same moment of music. */
export const CROSSFADE_SECONDS = 0.015;
/** Sources are started slightly in the future so they all begin on exactly
 *  the same sample, even if creating them takes a few milliseconds. */
const START_DELAY_SECONDS = 0.03;

/** A version is a weighted mix of sources, e.g. { original: 1 }, or
 *  { original: 1, processed: -1 } for "what was removed". */
export type Mix = Readonly<Record<string, number>>;

interface Ramp {
  from: number;
  to: number;
  start: number;
}

interface Running {
  sources: AudioBufferSourceNode[];
  gains: Map<string, GainNode>;
  master: GainNode;
  startTime: number;
  startOffset: number;
}

/**
 * Plays equal-length sources on one looping timeline, each through its own
 * gain. A "version" sets those gains to a mix. Switching version ramps the
 * gains, so the music carries on from the same position instead of
 * restarting, and the listener compares versions at the same moment.
 *
 * Crossfades are linear (equal-gain). The versions are near-identical, highly
 * correlated signals: for those, linear gains sum to a constant level, while
 * an equal-power fade would bulge by up to +3 dB mid-switch. Linear ramps of
 * every gain also move smoothly between any two mixes, including the
 * original-minus-processed mix used for the removed audio.
 */
export class SyncedPlayer {
  private sources = new Map<string, AudioBuffer>();
  private versions = new Map<string, Mix>();
  private masterLevel = 1;
  private loopSeconds = 0;
  private running: Running | null = null;
  private ramps = new Map<string, Ramp>();
  private activeKey: string | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly onChange: () => void = () => {},
  ) {}

  /**
   * Replaces sources and versions (stopping playback). masterLevel applies to
   * everything equally, e.g. the headroom that keeps it all from clipping.
   */
  load(sources: Record<string, AudioBuffer>, versions: Record<string, Mix>, masterLevel = 1): void {
    this.stop();
    const buffers = Object.values(sources);
    const length = buffers[0]?.length;
    // Different lengths would loop at different points and drift apart.
    if (buffers.some((b) => b.length !== length)) throw new Error('All sources must have the same length.');
    this.sources = new Map(Object.entries(sources));
    this.versions = new Map(Object.entries(versions));
    this.masterLevel = masterLevel;
    this.loopSeconds = buffers[0]?.duration ?? 0;
  }

  get active(): string | null {
    return this.activeKey;
  }

  get duration(): number {
    return this.loopSeconds;
  }

  /** Position within the loop in seconds, or null when stopped. */
  position(): number | null {
    const r = this.running;
    if (!r || this.loopSeconds === 0) return null;
    const elapsed = Math.max(0, this.context.currentTime - r.startTime);
    return (r.startOffset + elapsed) % this.loopSeconds;
  }

  /** Starts (at `atSeconds`, default 0) or switches to a version. */
  play(version: string, atSeconds?: number): void {
    if (!this.versions.has(version)) throw new Error(`Unknown version: ${version}`);
    if (!this.running) this.start(version, atSeconds ?? 0);
    else if (atSeconds !== undefined) this.restartAt(version, atSeconds);
    else if (version !== this.activeKey) this.rampTo(version);
    this.activeKey = version;
    this.onChange();
  }

  /** Jumps to a position, keeping the current version. Starts `version` if stopped. */
  seek(seconds: number, versionIfStopped: string): void {
    this.play(this.activeKey ?? versionIfStopped, seconds);
  }

  /** Changes a version's mix, smoothly if it is the one playing (used for the boost). */
  setMix(version: string, mix: Mix): void {
    this.versions.set(version, mix);
    if (this.running && version === this.activeKey) this.rampTo(version);
  }

  stop(): void {
    const r = this.running;
    if (!r) return;
    this.running = null;
    this.activeKey = null;
    this.fadeOut(r);
    this.onChange();
  }

  private fadeOut(r: Running): void {
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
  }

  private target(version: string, source: string): number {
    return this.versions.get(version)?.[source] ?? 0;
  }

  private start(version: string, offsetSeconds: number): void {
    // iOS unlocks audio only inside a user gesture, so resume() is called
    // synchronously here, in the click handler, without awaiting.
    void this.context.resume();
    const now = this.context.currentTime;
    const when = now + START_DELAY_SECONDS;
    const offset = this.loopSeconds > 0 ? ((offsetSeconds % this.loopSeconds) + this.loopSeconds) % this.loopSeconds : 0;

    const master = this.context.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.setValueAtTime(0, when);
    master.gain.linearRampToValueAtTime(this.masterLevel, when + CROSSFADE_SECONDS);
    master.connect(this.context.destination);

    const sources: AudioBufferSourceNode[] = [];
    const gains = new Map<string, GainNode>();
    this.ramps.clear();
    for (const [key, buffer] of this.sources) {
      const value = this.target(version, key);
      const gain = this.context.createGain();
      gain.gain.setValueAtTime(value, now);
      gain.connect(master);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      // The same start time and offset for every source is what keeps them in
      // sync: they are all sample-locked to the audio clock from here on.
      source.start(when, offset);
      sources.push(source);
      gains.set(key, gain);
      this.ramps.set(key, { from: value, to: value, start: -Infinity });
    }
    this.running = { sources, gains, master, startTime: when, startOffset: offset };
  }

  /** A jump: the old graph fades out while a new one fades in at the new position. */
  private restartAt(version: string, seconds: number): void {
    const old = this.running;
    if (old) this.fadeOut(old);
    this.running = null;
    this.start(version, seconds);
  }

  /** Current gain of a source, following any ramp still in progress. */
  private valueAt(source: string, time: number): number {
    const ramp = this.ramps.get(source);
    if (!ramp) return 0;
    const t = (time - ramp.start) / CROSSFADE_SECONDS;
    if (t >= 1) return ramp.to;
    return ramp.from + (ramp.to - ramp.from) * Math.max(0, t);
  }

  private rampTo(version: string): void {
    const r = this.running;
    if (!r) return;
    const now = this.context.currentTime;
    for (const [key, gain] of r.gains) {
      const from = this.valueAt(key, now);
      const to = this.target(version, key);
      if (Math.abs(from - to) < 1e-9) continue;
      // Pin the current value, then ramp. Starting from the computed value
      // means even a switch during an unfinished crossfade has no jump.
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(from, now);
      gain.gain.linearRampToValueAtTime(to, now + CROSSFADE_SECONDS);
      this.ramps.set(key, { from, to, start: now });
    }
  }
}

/** Short fade at start and stop. Starting or cutting audio mid-waveform jumps
 *  instantly to a non-zero sample, which is heard as a click; 10 ms is too short
 *  to notice as a fade but long enough to remove the click. (Phase 4 replaces
 *  this with proper crossfaded switching between versions.) */
const FADE_SECONDS = 0.01;

/** Plays one AudioBuffer at a time and reports where playback is. */
export class RegionPlayer {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private startedAt = 0;
  private duration = 0;

  constructor(
    private readonly context: AudioContext,
    private readonly onEnded: () => void,
    /** Where the sound goes: the speakers, or an analyser in front of them. */
    private readonly output: AudioNode = context.destination,
  ) {}

  get isPlaying(): boolean {
    return this.source !== null;
  }

  /** Seconds since the current buffer started, or null when stopped. */
  position(): number | null {
    if (!this.source) return null;
    return Math.min(this.duration, Math.max(0, this.context.currentTime - this.startedAt));
  }

  play(buffer: AudioBuffer): void {
    this.stop();
    // iOS only unlocks audio inside a user gesture, so resume() is called here,
    // synchronously in the click handler, rather than after an await.
    void this.context.resume();

    const now = this.context.currentTime;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE_SECONDS);
    gain.connect(this.output);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => {
      gain.disconnect();
      // Ignore the end of a source that stop() already replaced.
      if (this.source === source) {
        this.source = null;
        this.gain = null;
        this.onEnded();
      }
    };
    source.start(now);

    this.source = source;
    this.gain = gain;
    this.startedAt = now;
    this.duration = buffer.duration;
  }

  stop(): void {
    const { source, gain } = this;
    if (!source || !gain) return;
    this.source = null;
    this.gain = null;

    const now = this.context.currentTime;
    // Ramp from wherever the gain currently is (it may still be fading in).
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
    source.stop(now + FADE_SECONDS + 0.005);
    this.onEnded();
  }
}

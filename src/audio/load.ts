/** Formats we advertise. Actual support is up to the browser's decoder:
 *  WAV and MP3 work everywhere; M4A/AAC is missing in some Linux Firefox builds. */
export const ACCEPTED_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'];

export function looksLikeAudio(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  // Some systems report an empty or generic MIME type (M4A often comes
  // through as "video/mp4" or ""), so fall back to the file extension.
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function createAudioContext(): AudioContext {
  const scope = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) throw new Error('This browser does not support the Web Audio API.');
  return new Ctor();
}

/**
 * Decodes a whole file into an AudioBuffer. The browser resamples to the
 * context's rate, so everything downstream (engine, playback) shares one
 * sample rate. All channels are kept: playback stays stereo, and the engine
 * makes its own mono mix for analysis.
 */
export async function decodeAudio(context: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  try {
    return await context.decodeAudioData(data);
  } catch {
    // The browser's own error is usually just "EncodingError" with no detail.
    throw new Error('This browser could not decode that file. Try a WAV or MP3.');
  }
}

/** Copies one stretch of every channel (copies, because the engine takes ownership of what it is sent). */
export function sliceChannels(buffer: AudioBuffer, startSample: number, length: number): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c).slice(startSample, startSample + length));
  }
  return channels;
}

/** Length of the fade at each end of the test region. */
export const EDGE_FADE_SECONDS = 0.02;

/**
 * Fades the region in and out (raised cosine), in place. The region loops,
 * and jumping from its last sample straight back to its first would click.
 * The fades are applied before processing, so every version gets the identical
 * dip at the loop point and it cannot give any version away.
 */
export function applyEdgeFades(channels: readonly Float32Array[], sampleRate: number): void {
  for (const channel of channels) {
    const n = Math.min(Math.round(EDGE_FADE_SECONDS * sampleRate), Math.floor(channel.length / 2));
    for (let i = 0; i < n; i++) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
      channel[i] *= g;
      channel[channel.length - 1 - i] *= g;
    }
  }
}

export function channelsToBuffer(context: AudioContext, channels: readonly Float32Array[], sampleRate: number): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  const buffer = context.createBuffer(Math.max(1, channels.length), Math.max(1, length), sampleRate);
  channels.forEach((data, c) => buffer.getChannelData(c).set(data));
  return buffer;
}

/**
 * Average all channels into one. The masking decision is made once on this
 * mono mix and then applied to every channel, so left and right keep exactly
 * the same bins and the stereo image does not wobble between frames.
 * Averaging (rather than summing) keeps the level comparable to one channel.
 */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first.slice();

  const length = first.length;
  const mono = new Float32Array(length);
  const scale = 1 / channels.length;
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i] * scale;
  }
  return mono;
}

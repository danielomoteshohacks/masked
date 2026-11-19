/**
 * Messages between the page and the engine worker.
 *
 * Every request carries an id that its response echoes, so the page can match
 * answers to questions even if several are in flight. Audio travels as
 * Float32Array channels whose buffers are transferred (moved, not copied),
 * which keeps sending 10 s of stereo audio essentially free.
 */

export interface ProcessRequest {
  type: 'process';
  id: number;
  sampleRate: number;
  offsetDb: number;
  channels: Float32Array[];
}

export type EngineRequest = ProcessRequest;

export interface ProcessResponse {
  type: 'processed';
  id: number;
  processed: Float32Array[];
  removed: Float32Array[];
  percentRemoved: number;
  /** Time spent inside the worker, for spotting performance problems on phones. */
  elapsedMs: number;
}

export interface ErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export type EngineResponse = ProcessResponse | ErrorResponse;

/** The underlying buffers of a set of channels, for the transfer list. */
export function transferablesOf(channels: readonly Float32Array[]): ArrayBuffer[] {
  return channels.map((c) => c.buffer as ArrayBuffer);
}

/**
 * Messages between the page and the engine worker.
 *
 * Every request carries an id that its response echoes, so the page can match
 * answers to questions even if several are in flight. Audio travels as
 * Float32Array channels whose buffers are transferred (moved, not copied),
 * which keeps sending audio essentially free.
 */
import type { FrameStats, MaskingMapData } from './process';

export interface ProcessRequest {
  type: 'process';
  id: number;
  sampleRate: number;
  offsetDb: number;
  channels: Float32Array[];
}

/** Whole-song analysis: processed audio plus the Masking Map and per-frame stats.
 *  Runs in chunks and reports progress; can be cancelled between chunks. */
export interface AnalyzeRequest {
  type: 'analyze';
  id: number;
  sampleRate: number;
  offsetDb: number;
  channels: Float32Array[];
}

export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export type EngineRequest = ProcessRequest | AnalyzeRequest | CancelRequest;

export interface LoudnessInfo {
  originalLufs: number;
  /** Processed loudness before matching. */
  processedLufs: number;
  /** Gain already applied to `processed`, in dB. */
  gainDb: number;
  /** Linear gain (at most 1) to apply to every version at playback so none clips. */
  headroom: number;
}

export interface ProcessResponse {
  type: 'processed';
  id: number;
  /** Already loudness-matched to the original. */
  processed: Float32Array[];
  /** Original minus processed, before loudness matching, so it is exactly what the model took out. */
  removed: Float32Array[];
  percentRemoved: number;
  loudness: LoudnessInfo;
  /** Time spent inside the worker, for spotting performance problems on phones. */
  elapsedMs: number;
}

export interface ProgressResponse {
  type: 'progress';
  id: number;
  /** 0 to 1. */
  fraction: number;
}

export interface AnalyzeResponse {
  type: 'analyzed';
  id: number;
  /** Already loudness-matched to the original. The removed signal is not sent:
   *  the player rebuilds it as original minus processed, saving a song-length buffer. */
  processed: Float32Array[];
  percentRemoved: number;
  maskedPercent: number;
  /** Peak of original minus processed (before matching), for the boost limit. */
  removedPeak: number;
  loudness: LoudnessInfo;
  map: MaskingMapData;
  frames: FrameStats;
  elapsedMs: number;
}

export interface CancelledResponse {
  type: 'cancelled';
  id: number;
}

export interface ErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export type EngineResponse = ProcessResponse | AnalyzeResponse | ProgressResponse | CancelledResponse | ErrorResponse;

/** The underlying buffers of a set of channels, for the transfer list. */
export function transferablesOf(channels: readonly Float32Array[]): ArrayBuffer[] {
  return channels.map((c) => c.buffer as ArrayBuffer);
}

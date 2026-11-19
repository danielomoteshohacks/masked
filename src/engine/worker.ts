/**
 * Engine worker. Processing takes long enough to freeze the page on a phone
 * (seconds for a whole song), so it runs on a separate thread and the UI
 * stays responsive.
 */
import { applyGain, matchLoudness } from './loudness';
import { ChunkedProcessor, processChannels } from './process';
import {
  transferablesOf,
  type AnalyzeRequest,
  type EngineRequest,
  type EngineResponse,
  type LoudnessInfo,
  type ProcessRequest,
} from './protocol';

/** Frames per chunk: about 1.5 s of audio, a few tens of milliseconds of work. */
const FRAMES_PER_CHUNK = 64;

// The project compiles against DOM types, where `self` is a Window. Its
// postMessage(message, { transfer }) has the same shape as a worker's, so we
// only need to describe the part we use.
const scope = self as unknown as {
  postMessage(message: EngineResponse, options: { transfer: Transferable[] }): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<EngineRequest>) => void): void;
};

const cancelled = new Set<number>();

function post(message: EngineResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, { transfer });
}

/** Loudness matching happens here, next to the processing, so every version
 *  the page receives is already fair to compare. */
function matchAndApply(original: Float32Array[], processed: Float32Array[], sampleRate: number): LoudnessInfo {
  const match = matchLoudness(original, processed, sampleRate);
  applyGain(processed, match.gain);
  return {
    originalLufs: match.originalLufs,
    processedLufs: match.processedLufs,
    gainDb: 20 * Math.log10(match.gain),
    headroom: match.headroom,
  };
}

function handleProcess(request: ProcessRequest): void {
  const started = performance.now();
  const result = processChannels(request.channels, request.sampleRate, { offsetDb: request.offsetDb });
  const loudness = matchAndApply(request.channels, result.processed, request.sampleRate);
  post(
    {
      type: 'processed',
      id: request.id,
      processed: result.processed,
      removed: result.removed,
      percentRemoved: result.percentRemoved,
      loudness,
      elapsedMs: performance.now() - started,
    },
    [...transferablesOf(result.processed), ...transferablesOf(result.removed)],
  );
}

async function handleAnalyze(request: AnalyzeRequest): Promise<void> {
  const started = performance.now();
  const processor = new ChunkedProcessor(request.channels, request.sampleRate, {
    offsetDb: request.offsetDb,
    keepRemoved: false,
    collectMap: true,
  });
  while (!processor.done) {
    processor.run(FRAMES_PER_CHUNK);
    post({ type: 'progress', id: request.id, fraction: processor.progress });
    // Yield to the worker's event loop, so a cancel message (or a short
    // test-section request) can be handled between chunks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (cancelled.has(request.id)) {
      cancelled.delete(request.id);
      post({ type: 'cancelled', id: request.id });
      return;
    }
  }
  const result = processor.result();
  const map = result.map;
  if (!map) throw new Error('The Masking Map was not collected.');
  const loudness = matchAndApply(request.channels, result.processed, request.sampleRate);
  post(
    {
      type: 'analyzed',
      id: request.id,
      processed: result.processed,
      percentRemoved: result.percentRemoved,
      maskedPercent: result.maskedPercent,
      removedPeak: result.removedPeak,
      loudness,
      map,
      frames: result.frames,
      elapsedMs: performance.now() - started,
    },
    [
      ...transferablesOf(result.processed),
      map.levelDb.buffer as ArrayBuffer,
      map.maskedShare.buffer as ArrayBuffer,
      result.frames.removedEnergy.buffer as ArrayBuffer,
      result.frames.maskedBins.buffer as ArrayBuffer,
    ],
  );
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  const fail = (error: unknown) =>
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  try {
    if (request.type === 'process') handleProcess(request);
    else handleAnalyze(request).catch(fail);
  } catch (error) {
    fail(error);
  }
});

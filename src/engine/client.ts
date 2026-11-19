import {
  transferablesOf,
  type AnalyzeResponse,
  type EngineRequest,
  type EngineResponse,
  type ProcessResponse,
} from './protocol';

type Pending = {
  resolve: (response: ProcessResponse | AnalyzeResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (fraction: number) => void;
};

/** Thrown when an analysis was cancelled, so callers can tell it apart from a failure. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledError';
  }
}

export interface AnalysisJob {
  result: Promise<AnalyzeResponse>;
  cancel(): void;
}

/** Promise-based wrapper around the engine worker. */
export class EngineClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    // This exact `new URL(..., import.meta.url)` form is what Vite recognises
    // to bundle the worker as its own file, in dev and in the production build.
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

    this.worker.addEventListener('message', (event: MessageEvent<EngineResponse>) => {
      const response = event.data;
      const waiter = this.pending.get(response.id);
      if (!waiter) return;
      if (response.type === 'progress') {
        waiter.onProgress?.(response.fraction);
        return;
      }
      this.pending.delete(response.id);
      if (response.type === 'error') waiter.reject(new Error(response.message));
      else if (response.type === 'cancelled') waiter.reject(new CancelledError());
      else waiter.resolve(response);
    });

    // A load or uncaught error leaves no id to match, so fail everything
    // in flight rather than leaving promises hanging forever.
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The audio engine failed to start.');
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  private send(request: EngineRequest, waiter: Pending, transfer: Transferable[]): void {
    this.pending.set(request.id, waiter);
    this.worker.postMessage(request, transfer);
  }

  /**
   * Processes a test section. The channel buffers are transferred to the
   * worker, which empties them on this side: pass copies if they are still needed.
   */
  process(channels: Float32Array[], sampleRate: number, offsetDb: number): Promise<ProcessResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.send(
        { type: 'process', id, sampleRate, offsetDb, channels },
        { resolve: (r) => resolve(r as ProcessResponse), reject },
        transferablesOf(channels),
      );
    });
  }

  /** Analyses a whole song (channels are transferred, as above). */
  analyze(
    channels: Float32Array[],
    sampleRate: number,
    offsetDb: number,
    onProgress: (fraction: number) => void,
  ): AnalysisJob {
    const id = this.nextId++;
    const result = new Promise<AnalyzeResponse>((resolve, reject) => {
      this.send(
        { type: 'analyze', id, sampleRate, offsetDb, channels },
        { resolve: (r) => resolve(r as AnalyzeResponse), reject, onProgress },
        transferablesOf(channels),
      );
    });
    return { result, cancel: () => this.worker.postMessage({ type: 'cancel', id } satisfies EngineRequest) };
  }
}

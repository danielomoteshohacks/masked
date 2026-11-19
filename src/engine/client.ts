import { transferablesOf, type EngineRequest, type EngineResponse, type ProcessResponse } from './protocol';

type Pending = { resolve: (response: ProcessResponse) => void; reject: (error: Error) => void };

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
      this.pending.delete(response.id);
      if (response.type === 'error') waiter.reject(new Error(response.message));
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

  /**
   * The channel buffers are transferred to the worker, which empties them on
   * this side. Pass copies if the caller still needs the data.
   */
  process(channels: Float32Array[], sampleRate: number, offsetDb: number): Promise<ProcessResponse> {
    const id = this.nextId++;
    const request: EngineRequest = { type: 'process', id, sampleRate, offsetDb, channels };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request, transferablesOf(channels));
    });
  }
}

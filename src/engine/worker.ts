/**
 * Engine worker. Processing 10 s of audio takes long enough to freeze the page
 * for a noticeable moment on a phone, so it runs on a separate thread and the
 * UI stays responsive.
 */
import { processChannels } from './process';
import { transferablesOf, type EngineRequest, type EngineResponse } from './protocol';

// The project compiles against DOM types, where `self` is a Window. Its
// postMessage(message, { transfer }) has the same shape as a worker's, so we
// only need to describe the part we use.
const scope = self as unknown as {
  postMessage(message: EngineResponse, options: { transfer: Transferable[] }): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<EngineRequest>) => void): void;
};

scope.addEventListener('message', (event) => {
  const request = event.data;
  try {
    const started = performance.now();
    const result = processChannels(request.channels, request.sampleRate, {
      offsetDb: request.offsetDb,
    });
    scope.postMessage(
      {
        type: 'processed',
        id: request.id,
        processed: result.processed,
        removed: result.removed,
        percentRemoved: result.percentRemoved,
        elapsedMs: performance.now() - started,
      },
      { transfer: [...transferablesOf(result.processed), ...transferablesOf(result.removed)] },
    );
  } catch (error) {
    scope.postMessage(
      { type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) },
      { transfer: [] },
    );
  }
});

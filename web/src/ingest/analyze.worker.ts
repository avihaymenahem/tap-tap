/**
 * The analysis worker: a thin shell around `runAnalysis`.
 *
 * All it does is move the heavy `@tap-tap/core` pipeline off the main thread so
 * the UI stays responsive while a song is ingested on device. Vite compiles
 * this from the `new Worker(new URL(...))` call in `analyzeInWorker`.
 *
 * Typed against a hand-written worker scope rather than the WebWorker lib: the
 * web program is compiled with the DOM lib (for React/three), and the two libs
 * cannot coexist in one `tsconfig` — the same reason `sw.ts` is split out. The
 * shell is small enough that a minimal cast is cheaper than a second program.
 */

import { runAnalysis, type AnalyzeRequest, type AnalyzeResponse } from './analyze.js';

interface DedicatedWorkerScope {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: AnalyzeResponse): void;
}

const ctx = self as unknown as DedicatedWorkerScope;

ctx.onmessage = (event: MessageEvent<AnalyzeRequest>): void => {
  const { pcm, sampleRate, songId } = event.data;
  try {
    ctx.postMessage({ ok: true, bundle: runAnalysis(pcm, sampleRate, songId) });
  } catch (error) {
    ctx.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

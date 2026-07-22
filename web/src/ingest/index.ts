/**
 * On-device ingest, browser side (PLAN.md §6h).
 *
 * `decodeAudioToMonoPcm` turns a downloaded audio file into analysis PCM;
 * `analyzeInWorker` runs the `@tap-tap/core` pipeline over it off the main
 * thread. The download step itself (the `youtubedl-android` plugin) and the
 * beatmap assembly land in MC1/MC2; this module is the portable middle.
 */

import type { AnalysisBundle, AnalyzeRequest, AnalyzeResponse } from './analyze.js';

export { decodeAudioToMonoPcm, downmixToMono, type AudioBufferLike } from './decodeAudio.js';
export { runAnalysis, type AnalysisBundle } from './analyze.js';

/**
 * Analyse PCM in a worker, resolving to the analysis + charts bundle.
 *
 * The PCM buffer is transferred (not copied), so the caller must not touch it
 * after this returns — it is detached. The worker is one-shot: created per call
 * and terminated on completion, which keeps a failed run from leaking a thread
 * and matches how rarely ingest happens.
 */
export function analyzeInWorker(
  pcm: Float32Array,
  sampleRate: number,
  songId: string,
): Promise<AnalysisBundle> {
  return new Promise<AnalysisBundle>((resolve, reject) => {
    const worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<AnalyzeResponse>): void => {
      worker.terminate();
      const data = event.data;
      if (data.ok) resolve(data.bundle);
      else reject(new Error(data.error));
    };
    worker.onerror = (event: ErrorEvent): void => {
      worker.terminate();
      reject(new Error(event.message || 'Analysis worker failed'));
    };

    const request: AnalyzeRequest = { pcm, sampleRate, songId };
    worker.postMessage(request, [pcm.buffer]);
  });
}

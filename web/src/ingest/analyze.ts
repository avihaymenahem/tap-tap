/**
 * The CPU-heavy half of on-device ingest: PCM in, analysis + charts out.
 *
 * This is deliberately a pure function so it can be unit-tested off the worker,
 * and so the worker itself (`analyze.worker.ts`) stays a thin message shell. It
 * composes the exact `@tap-tap/core` pipeline the server runs — same `analyze`,
 * same `generateAllCharts` — which is the property the tests pin: the worker
 * must not alter results, only move them off the main thread.
 *
 * Beatmap assembly (title, artist, urls, hand-edit preservation) is *not* here —
 * that is orchestration for the ingest layer (MC2). This stays the pure DSP step.
 */

import { analyze, computeWaveform, generateAllCharts } from '@tap-tap/core';

export interface AnalysisBundle {
  analysis: ReturnType<typeof analyze>;
  waveform: ReturnType<typeof computeWaveform>;
  charts: ReturnType<typeof generateAllCharts>;
}

/** Run the full analysis + chart generation over mono PCM. Deterministic for a given `songId`. */
export function runAnalysis(pcm: Float32Array, sampleRate: number, songId: string): AnalysisBundle {
  const analysis = analyze(pcm, sampleRate);
  const waveform = computeWaveform(pcm, sampleRate);
  const charts = generateAllCharts(analysis, songId, waveform);
  return { analysis, waveform, charts };
}

/** Worker message in. The PCM buffer is transferred, not copied. */
export interface AnalyzeRequest {
  pcm: Float32Array;
  sampleRate: number;
  songId: string;
}

/** Worker message out. Errors are stringified — a worker cannot transfer an Error. */
export type AnalyzeResponse =
  | { ok: true; bundle: AnalysisBundle }
  | { ok: false; error: string };

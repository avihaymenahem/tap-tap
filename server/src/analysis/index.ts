import type { AnalysisResult } from '@tap-tap/shared';
import { DEFAULT_ONSET_OPTIONS, detectOnsets, type OnsetOptions } from './onsets.js';
import { estimateTempo, gridAlignment } from './tempo.js';

export { DEFAULT_ONSET_OPTIONS, detectOnsets } from './onsets.js';
export type { OnsetOptions } from './onsets.js';
export { estimateTempo, gridAlignment } from './tempo.js';
export { FFT, hannWindow } from './fft.js';

/**
 * Bumped whenever the analysis itself improves — not when chart generation
 * does. `regenerateCharts` compares this against the version stamped into a
 * cached `analysis.json` and re-analyzes the audio when it is stale, so the
 * existing library picks up analysis fixes through the Regenerate button
 * instead of being stranded on old beat grids forever.
 *
 *   2  sub-hop tempo refinement + alignment-checked confidence. Grids from
 *      version 1 (or unstamped files, which predate the stamp) are quantized
 *      to whole ODF hops and can drift a beat or more over a song.
 */
export const ANALYSIS_VERSION = 2;

/** Full offline analysis of a decoded mono track. */
export function analyze(
  pcm: Float32Array,
  sampleRate: number,
  opts: OnsetOptions = DEFAULT_ONSET_OPTIONS,
): AnalysisResult {
  const duration = pcm.length / sampleRate;
  const { onsets, odf, odfHopSec, odfOriginSec } = detectOnsets(pcm, sampleRate, opts);
  const tempo = estimateTempo(odf, odfHopSec, duration, odfOriginSec);

  // Periodicity prominence scaled by measured grid agreement. Prominence alone
  // over-reports: a grid whose tempo is slightly wrong autocorrelates just as
  // strongly and then drifts off the music. Alignment can only *reduce*
  // confidence — the floor keeps a legitimately syncopated track from being
  // zeroed by a heuristic — so "high confidence" now means both "the song has a
  // beat" and "the grid we wrote down actually sits on it".
  const alignment = gridAlignment(onsets, tempo.beatGrid);
  const bpmConfidence = Number((tempo.confidence * (0.35 + 0.65 * alignment)).toFixed(3));

  return {
    analysisVersion: ANALYSIS_VERSION,
    duration,
    bpm: tempo.bpm,
    bpmConfidence,
    beatGrid: tempo.beatGrid,
    onsets,
  };
}

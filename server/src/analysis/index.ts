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

  // Two independent pieces of evidence: the tracker's own quality score ("the
  // beats collect real energy, steadily") and onset/grid agreement ("the
  // strong onsets sit on the grid, start to finish"). Alignment is weighted
  // heavier because it is the direct measure of what chart generation needs —
  // and it rescues a dense track whose beat contrast is diluted by constant
  // activity. With too few onsets to judge (null), the tracker's score stands
  // alone rather than borrowing a neutral value.
  //
  // Steadiness caps the blend rather than merely joining it: tracked beats
  // follow whatever hits exist, so on arrhythmic audio the onsets align with
  // the "grid" *by construction* and alignment would happily rescue a pulse
  // that does not exist. An unsteady pulse must stay condemned.
  const alignment = gridAlignment(onsets, tempo.beatGrid);
  const evidence =
    alignment === null ? tempo.confidence : 0.45 * tempo.confidence + 0.55 * alignment;
  const bpmConfidence = Number(
    Math.max(0, Math.min(1, Math.min(evidence, tempo.steadiness))).toFixed(3),
  );

  return {
    analysisVersion: ANALYSIS_VERSION,
    duration,
    bpm: tempo.bpm,
    bpmConfidence,
    beatGrid: tempo.beatGrid,
    onsets,
  };
}

import type { AnalysisResult } from '@tap-tap/shared';
import { DEFAULT_ONSET_OPTIONS, detectOnsets, type OnsetOptions } from './onsets.js';
import { estimateTempo } from './tempo.js';

export { DEFAULT_ONSET_OPTIONS, detectOnsets } from './onsets.js';
export type { OnsetOptions } from './onsets.js';
export { estimateTempo } from './tempo.js';
export { FFT, hannWindow } from './fft.js';

/** Full offline analysis of a decoded mono track. */
export function analyze(
  pcm: Float32Array,
  sampleRate: number,
  opts: OnsetOptions = DEFAULT_ONSET_OPTIONS,
): AnalysisResult {
  const duration = pcm.length / sampleRate;
  const { onsets, odf, odfHopSec, odfOriginSec } = detectOnsets(pcm, sampleRate, opts);
  const tempo = estimateTempo(odf, odfHopSec, duration, odfOriginSec);

  return {
    duration,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    beatGrid: tempo.beatGrid,
    onsets,
  };
}

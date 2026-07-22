/**
 * `@tap-tap/core` — the pure DSP and chart-generation pipeline.
 *
 * Everything here is plain TypeScript with no Node, DOM or three.js dependency
 * (it imports only `@tap-tap/shared` for the wire types). That is the whole
 * point of the package: the same `analyze` → `generateAllCharts` pipeline runs
 * on the server today and, fed a `Float32Array` from the browser's
 * `decodeAudioData`, inside a WebView worker on device — see PLAN.md §6h.
 *
 * The only thing that never crosses in is the *decode*: the server reaches for
 * ffmpeg, the browser for Web Audio. Both hand this package the same mono PCM.
 */

export {
  ANALYSIS_VERSION,
  analyze,
  detectOnsets,
  DEFAULT_ONSET_OPTIONS,
  estimateTempo,
  gridAlignment,
  FFT,
  hannWindow,
  type OnsetOptions,
} from './analysis/index.js';

export { computeWaveform } from './analysis/waveform.js';

export {
  generateAllCharts,
  generateChart,
  peakConcurrency,
  buildGrid,
  snapNear,
  snapToGrid,
} from './charts/generate.js';

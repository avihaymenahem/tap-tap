import { describe, expect, it } from 'vitest';
import { analyze, computeWaveform, generateAllCharts } from '@tap-tap/core';
import { downmixToMono, type AudioBufferLike } from './decodeAudio.js';
import { runAnalysis } from './analyze.js';

/**
 * The worker path cannot be exercised in Node (no Web Audio, no Worker), so the
 * two things that *can* be tested in isolation are: the channel downmix, and
 * that the worker core is a faithful composition of the `@tap-tap/core`
 * pipeline. The genuine "decodeAudioData produces PCM equivalent to ffmpeg" is
 * a device-integration property (MB1/MC2), not a unit test — both need a real
 * decoder.
 */

function fakeBuffer(channels: number[][]): AudioBufferLike {
  return {
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    getChannelData: (channel: number) => Float32Array.from(channels[channel]!),
  };
}

describe('downmixToMono', () => {
  it('copies a mono buffer through', () => {
    const mono = downmixToMono(fakeBuffer([[0.1, -0.2, 0.3]]));
    expect(Array.from(mono)).toEqual([
      Math.fround(0.1),
      Math.fround(-0.2),
      Math.fround(0.3),
    ]);
  });

  it('averages stereo into one channel', () => {
    const mono = downmixToMono(
      fakeBuffer([
        [1, 0, -1],
        [0, 0.5, -1],
      ]),
    );
    // (L + R) / 2 per sample.
    expect(Array.from(mono)).toEqual([0.5, 0.25, -1]);
  });

  it('detaches from the source (returns an owned copy)', () => {
    const source = [0.4];
    const mono = downmixToMono(fakeBuffer([source]));
    source[0] = 99;
    expect(mono[0]).toBe(Math.fround(0.4));
  });
});

describe('runAnalysis', () => {
  // A short synthetic click track: impulses on a steady grid, so analysis has
  // real onsets to find and the charts come out non-empty.
  const SAMPLE_RATE = 44100;
  function clickTrack(seconds: number, bpm: number): Float32Array {
    const pcm = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
    const period = Math.round((60 / bpm) * SAMPLE_RATE);
    for (let i = 0; i < pcm.length; i += period) {
      // A short decaying click rather than a single sample, so the onset
      // detector sees energy the way it would in real audio.
      for (let k = 0; k < 400 && i + k < pcm.length; k++) {
        pcm[i + k] = Math.sin((k / 30) * Math.PI * 2) * Math.exp(-k / 120);
      }
    }
    return pcm;
  }

  it('faithfully composes the @tap-tap/core pipeline (the worker must not alter results)', () => {
    const pcm = clickTrack(4, 120);
    const songId = 'unit-test-song';

    const analysis = analyze(pcm, SAMPLE_RATE);
    const waveform = computeWaveform(pcm, SAMPLE_RATE);
    const charts = generateAllCharts(analysis, songId, waveform);

    const bundle = runAnalysis(pcm, SAMPLE_RATE, songId);

    expect(bundle.analysis).toEqual(analysis);
    expect(bundle.waveform).toEqual(waveform);
    expect(bundle.charts).toEqual(charts);
  });

  it('produces playable charts for every difficulty', () => {
    const bundle = runAnalysis(clickTrack(4, 120), SAMPLE_RATE, 'unit-test-song');
    for (const difficulty of ['easy', 'medium', 'hard', 'extreme'] as const) {
      expect(bundle.charts[difficulty].notes.length, difficulty).toBeGreaterThan(0);
    }
  });
});

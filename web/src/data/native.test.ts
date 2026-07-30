/**
 * The on-device library's write half, against a fake Filesystem.
 *
 * `native.ts` is pure orchestration over four Capacitor calls, so faking them is
 * enough to pin the behaviour that actually matters and cannot be seen by eye:
 * that a regenerate preserves hand edits, stamps the chart version the self-heal
 * keys on, and — the part that was missing entirely — repairs a stale analysis,
 * a missing waveform and an unmeasured loudness the way the server's
 * `regenerateCharts` always has. Shaped after `server/src/ingest/regenerate.test.ts`.
 *
 * The worker and Web Audio are mocked: neither exists in Node, and neither is
 * what these tests are about. `analyze`/`generateAllCharts` themselves are
 * covered by the core corpus.
 */

import type { AnalysisResult, Beatmap, Waveform } from '@tap-tap/shared';
import { BEATMAP_VERSION, CHART_VERSION } from '@tap-tap/shared';
import { ANALYSIS_VERSION } from '@tap-tap/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SONG_ID = 'phone-song';

/** In-memory stand-in for the app's Data directory. Path → file contents. */
const fs = vi.hoisted(() => new Map<string, string>());
const mocks = vi.hoisted(() => ({
  decode: vi.fn(),
  analyzeInWorker: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    convertFileSrc: (uri: string) => uri,
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: async ({ path }: { path: string }) => {
      const data = fs.get(path);
      if (data === undefined) throw new Error(`ENOENT ${path}`);
      return { data };
    },
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      fs.set(path, data);
    },
    stat: async ({ path }: { path: string }) => {
      if (!fs.has(path)) throw new Error(`ENOENT ${path}`);
      return { type: 'file' };
    },
    getUri: async ({ path }: { path: string }) => ({ uri: `file:///data/${path}` }),
    readdir: async () => ({ files: [{ name: SONG_ID, type: 'directory' }] }),
    rmdir: async () => undefined,
    rename: async () => undefined,
  },
}));

vi.mock('../ingest/decodeAudio.js', () => ({
  decodeAudioToMonoPcm: mocks.decode,
}));

vi.mock('../ingest/index.js', () => ({
  analyzeInWorker: mocks.analyzeInWorker,
}));

const { regenerateCharts } = await import('./native.js');

/** Onsets on a steady 500ms grid, alternating band dominance so lanes have something to do. */
function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const onsets = Array.from({ length: 120 }, (_, i) => {
    const low = i % 2 === 0 ? 0.7 : 0.15;
    return { t: i * 0.5, strength: 0.6 + (i % 3) * 0.1, low, mid: 0.15, high: 0.85 - low };
  });
  return {
    analysisVersion: ANALYSIS_VERSION,
    duration: 60,
    bpm: 120,
    bpmConfidence: 0.9,
    beatGrid: Array.from({ length: 120 }, (_, i) => i * 0.5),
    onsets,
    ...overrides,
  };
}

function beatmap(overrides: Partial<Beatmap> = {}): Beatmap {
  return {
    version: BEATMAP_VERSION,
    songId: SONG_ID,
    title: 'Hand Typed Title',
    artist: 'Hand Typed Artist',
    duration: 60,
    audioUrl: `/media/${SONG_ID}/audio.m4a`,
    thumbnailUrl: null,
    bpm: 120,
    bpmConfidence: 0.9,
    beatGrid: [],
    charts: {
      easy: { laneCount: 4, notes: [] },
      medium: { laneCount: 4, notes: [] },
      hard: { laneCount: 4, notes: [] },
      extreme: { laneCount: 4, notes: [] },
    },
    ...overrides,
  };
}

function put(file: string, value: unknown): void {
  fs.set(`media/${SONG_ID}/${file}`, JSON.stringify(value));
}

function stored(): Beatmap {
  return JSON.parse(fs.get(`media/${SONG_ID}/beatmap.json`)!) as Beatmap;
}

/** A second of a 220Hz tone — enough for `integratedLoudness` to return a real number. */
function tonePcm(): Float32Array {
  const pcm = new Float32Array(44100);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / 44100);
  return pcm;
}

function waveform(): Waveform {
  return { secondsPerPeak: 0.02, peaks: Array.from({ length: 3000 }, () => 0.5) };
}

beforeEach(() => {
  fs.clear();
  mocks.decode.mockReset();
  mocks.analyzeInWorker.mockReset();
  // Audio has to exist for a decode to be attempted at all.
  fs.set(`media/${SONG_ID}/audio.m4a`, 'AAAA');
});

describe('regenerateCharts (shallow — what the CHART_VERSION self-heal runs)', () => {
  it('rebuilds charts and stamps the current chart version', async () => {
    put('analysis.json', analysis());
    put('beatmap.json', beatmap({ chartVersion: 1 }));

    const summary = await regenerateCharts(SONG_ID);

    expect(summary.noteCounts.hard).toBeGreaterThan(0);
    // The stamp is the whole mechanism: `getBeatmap` regenerates while this is
    // below CHART_VERSION, so failing to write it would re-regenerate forever.
    expect(stored().chartVersion).toBe(CHART_VERSION);
  });

  it('keeps hand-set fields', async () => {
    put('analysis.json', analysis());
    put('beatmap.json', beatmap({ themeId: 'toxic', customName: true, createdAt: 1234, gainDb: -3 }));

    await regenerateCharts(SONG_ID);

    const map = stored();
    expect(map.themeId).toBe('toxic');
    expect(map.customName).toBe(true);
    expect(map.title).toBe('Hand Typed Title');
    expect(map.createdAt).toBe(1234);
    expect(map.gainDb).toBe(-3);
  });

  it('never decodes audio', async () => {
    // This path runs behind a loading spinner while a player waits for a song to
    // open. A decode here is a frozen screen, so the absence is the assertion.
    put('analysis.json', analysis({ analysisVersion: 1 }));
    put('beatmap.json', beatmap());

    await regenerateCharts(SONG_ID);

    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.analyzeInWorker).not.toHaveBeenCalled();
  });

  it('leaves a song without a theme without one', async () => {
    put('analysis.json', analysis());
    put('beatmap.json', beatmap());

    await regenerateCharts(SONG_ID);

    expect(stored().themeId).toBeUndefined();
  });

  it('throws when there is no cached analysis to rebuild from', async () => {
    put('beatmap.json', beatmap());
    await expect(regenerateCharts(SONG_ID)).rejects.toThrow(/analysis/i);
  });
});

describe('regenerateCharts (deep — the admin button)', () => {
  it('re-analyses a song whose analysis predates the current analyser', async () => {
    put('analysis.json', analysis({ analysisVersion: ANALYSIS_VERSION - 1, bpm: 90 }));
    put('waveform.json', waveform());
    put('beatmap.json', beatmap({ gainDb: -5 }));
    mocks.decode.mockResolvedValue(tonePcm());
    mocks.analyzeInWorker.mockResolvedValue({
      analysis: analysis({ bpm: 128, bpmConfidence: 0.77 }),
      waveform: waveform(),
      charts: {
        easy: { laneCount: 4, notes: [{ t: 1, lane: 0, type: 'tap' }] },
        medium: { laneCount: 4, notes: [{ t: 1, lane: 0, type: 'tap' }] },
        hard: { laneCount: 4, notes: [{ t: 1, lane: 0, type: 'tap' }] },
        extreme: { laneCount: 4, notes: [{ t: 1, lane: 0, type: 'tap' }] },
      },
      gainDb: -7.5,
    });

    await regenerateCharts(SONG_ID, { deep: true });

    expect(mocks.analyzeInWorker).toHaveBeenCalledTimes(1);
    const map = stored();
    // The beatmap has to describe the charts beside it, not the analysis they
    // replaced — a stale bpm here would leave the grid disagreeing with the notes.
    expect(map.bpm).toBe(128);
    expect(map.bpmConfidence).toBe(0.77);
    expect(map.gainDb).toBe(-7.5);
    // Saved, so the next regenerate is cheap again.
    expect((JSON.parse(fs.get(`media/${SONG_ID}/analysis.json`)!) as AnalysisResult).bpm).toBe(128);
  });

  it('does not re-analyse when the cached analysis is current', async () => {
    put('analysis.json', analysis());
    put('waveform.json', waveform());
    put('beatmap.json', beatmap({ gainDb: -5 }));

    await regenerateCharts(SONG_ID, { deep: true });

    // Nothing is missing, so nothing is decoded — re-analysing a current song
    // would make a bulk run cost minutes for no change at all.
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.analyzeInWorker).not.toHaveBeenCalled();
  });

  it('rebuilds a missing waveform rather than silently dropping holds', async () => {
    put('analysis.json', analysis());
    put('beatmap.json', beatmap({ gainDb: -5 }));
    mocks.decode.mockResolvedValue(tonePcm());

    await regenerateCharts(SONG_ID, { deep: true });

    expect(mocks.decode).toHaveBeenCalledTimes(1);
    // A missing waveform is a repair, not a re-analysis: the onset pool is fine.
    expect(mocks.analyzeInWorker).not.toHaveBeenCalled();
    const wave = JSON.parse(fs.get(`media/${SONG_ID}/waveform.json`)!) as Waveform;
    expect(wave.peaks.length).toBeGreaterThan(0);
  });

  it('measures a missing gainDb', async () => {
    put('analysis.json', analysis());
    put('waveform.json', waveform());
    put('beatmap.json', beatmap()); // no gainDb — every phone-ingested song
    mocks.decode.mockResolvedValue(tonePcm());

    await regenerateCharts(SONG_ID, { deep: true });

    expect(typeof stored().gainDb).toBe('number');
  });

  it('still rebuilds charts when the analysis worker cannot run', async () => {
    // Same rule as a failed decode: a worker that will not start costs the song
    // its upgrade, never its charts.
    put('analysis.json', analysis({ analysisVersion: ANALYSIS_VERSION - 1, bpm: 90 }));
    put('waveform.json', waveform());
    put('beatmap.json', beatmap({ gainDb: -5 }));
    mocks.decode.mockResolvedValue(tonePcm());
    mocks.analyzeInWorker.mockRejectedValue(new Error('no Worker here'));

    const summary = await regenerateCharts(SONG_ID, { deep: true });

    expect(summary.noteCounts.hard).toBeGreaterThan(0);
    expect(stored().bpm).toBe(90); // the stale analysis, honestly reported
    expect(stored().chartVersion).toBe(CHART_VERSION);
  });

  it('repairs a missing waveform even when the re-analysis worker fails', async () => {
    // The case that fell between the two branches: a stale song is also the
    // likeliest one to be missing a waveform, and while the repairs were the
    // `else` of the re-analysis it could only ever reach one of them. A worker
    // that cannot start then regenerated the song hold-free with nothing saying
    // why — the silent failure the deep path exists to remove.
    put('analysis.json', analysis({ analysisVersion: ANALYSIS_VERSION - 1 }));
    put('beatmap.json', beatmap()); // no waveform.json, no gainDb
    mocks.decode.mockResolvedValue(tonePcm());
    mocks.analyzeInWorker.mockRejectedValue(new Error('no Worker here'));

    await regenerateCharts(SONG_ID, { deep: true });

    const wave = JSON.parse(fs.get(`media/${SONG_ID}/waveform.json`)!) as Waveform;
    expect(wave.peaks.length).toBeGreaterThan(0);
    expect(typeof stored().gainDb).toBe('number');
    // The upgrade is lost, the charts are not.
    expect(stored().chartVersion).toBe(CHART_VERSION);
  });

  it('decodes only once when the re-analysis succeeds', async () => {
    // The worker hands back the waveform and the loudness measured on the same
    // PCM, so the repair pass must find nothing left to do. A second decode here
    // would be minutes added to a 35-song bulk run for no new information.
    put('analysis.json', analysis({ analysisVersion: ANALYSIS_VERSION - 1 }));
    put('beatmap.json', beatmap());
    mocks.decode.mockResolvedValue(tonePcm());
    mocks.analyzeInWorker.mockResolvedValue({
      analysis: analysis(),
      waveform: waveform(),
      charts: {
        easy: { laneCount: 4, notes: [{ t: 1, lane: 0, type: 'tap' }] },
        medium: { laneCount: 4, notes: [{ t: 1, lane: 0, type: 'tap' }] },
        hard: { laneCount: 4, notes: [{ t: 1, lane: 0, type: 'tap' }] },
        extreme: { laneCount: 4, notes: [{ t: 1, lane: 0, type: 'tap' }] },
      },
      gainDb: -6,
    });

    await regenerateCharts(SONG_ID, { deep: true });

    expect(mocks.decode).toHaveBeenCalledTimes(1);
    expect(stored().gainDb).toBe(-6);
  });

  it('still rebuilds charts when the audio cannot be decoded', async () => {
    // The charts come from analysis.json, so an unreadable media file must
    // degrade the rebuild, never block it — the server's rule, and the case that
    // caught the unguarded decode there.
    put('analysis.json', analysis());
    put('beatmap.json', beatmap({ themeId: 'toxic' }));
    mocks.decode.mockRejectedValue(new Error('no decoder'));

    const summary = await regenerateCharts(SONG_ID, { deep: true });

    expect(summary.noteCounts.hard).toBeGreaterThan(0);
    expect(stored().themeId).toBe('toxic');
    expect(stored().chartVersion).toBe(CHART_VERSION);
    expect(stored().gainDb).toBeUndefined(); // absence means unity, not a wrong number
  });

  it('reports progress on the slow paths only', async () => {
    put('analysis.json', analysis());
    put('waveform.json', waveform());
    put('beatmap.json', beatmap({ gainDb: -5 }));
    const quiet = vi.fn();
    await regenerateCharts(SONG_ID, { deep: true, onProgress: quiet });
    expect(quiet).not.toHaveBeenCalled();

    put('beatmap.json', beatmap()); // gainDb missing → a decode, so a message
    mocks.decode.mockResolvedValue(tonePcm());
    const loud = vi.fn();
    await regenerateCharts(SONG_ID, { deep: true, onProgress: loud });
    expect(loud).toHaveBeenCalled();
  });
});

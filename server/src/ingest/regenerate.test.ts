import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AnalysisResult, Beatmap } from '@tap-tap/shared';
import { BEATMAP_VERSION } from '@tap-tap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `MEDIA_DIR` is read once at module load, so it has to be set before anything
 * pulls in `storage.js`. Hence the dynamic imports below rather than the usual
 * static ones.
 */
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tap-tap-regen-'));
process.env['MEDIA_DIR'] = root;

const { regenerateCharts } = await import('./pipeline.js');
const { loadBeatmap, saveBeatmap, saveAnalysis } = await import('../storage.js');

const SONG_ID = 'themed-song';

function analysis(): AnalysisResult {
  // Onsets on a steady 500ms grid, alternating low- and high-band dominance so
  // lane assignment has something to work with. The chart contents are not what
  // this file is testing — only that regenerating one keeps the hand-set fields.
  const onsets = Array.from({ length: 120 }, (_, i) => {
    const low = i % 2 === 0 ? 0.7 : 0.15;
    return { t: i * 0.5, strength: 0.6 + (i % 3) * 0.1, low, mid: 0.15, high: 0.85 - low };
  });

  return {
    duration: 60,
    bpm: 120,
    bpmConfidence: 0.9,
    beatGrid: Array.from({ length: 120 }, (_, i) => i * 0.5),
    onsets,
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
    charts: { easy: { laneCount: 3, notes: [] }, medium: { laneCount: 4, notes: [] }, hard: { laneCount: 5, notes: [] } },
    ...overrides,
  };
}

beforeAll(async () => {
  await fs.mkdir(path.join(root, SONG_ID), { recursive: true });
  await saveAnalysis(SONG_ID, analysis());
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('regenerateCharts', () => {
  it('keeps the hand-chosen theme', async () => {
    // Regenerate rebuilds charts from cached analysis. Nothing in the analysis
    // can reconstruct a theme, so losing it here would silently reset a song's
    // colours every time its difficulty parameters were retuned.
    await saveBeatmap(beatmap({ themeId: 'toxic', customName: true }));

    const regenerated = await regenerateCharts(SONG_ID);

    expect(regenerated.themeId).toBe('toxic');
    expect(regenerated.customName).toBe(true);
    expect(regenerated.title).toBe('Hand Typed Title');
  });

  it('actually rebuilt the charts, so the check above is not vacuous', async () => {
    await saveBeatmap(beatmap({ themeId: 'arctic' }));

    const regenerated = await regenerateCharts(SONG_ID);

    expect(regenerated.charts.hard.notes.length).toBeGreaterThan(0);
    expect(regenerated.themeId).toBe('arctic');
  });

  it('leaves a song without a theme without one', async () => {
    // Absence must stay absence rather than becoming an explicit default, so a
    // later change to DEFAULT_THEME still reaches songs that never chose.
    await saveBeatmap(beatmap());

    const regenerated = await regenerateCharts(SONG_ID);

    expect(regenerated.themeId).toBeUndefined();
  });

  it('still rebuilds charts when the audio cannot be decoded', async () => {
    // Regeneration now wants a waveform (for holds) and will decode one if it
    // is missing. That must stay best-effort: the charts come from
    // `analysis.json`, so an unreadable media file has no business blocking a
    // rebuild. This fixture has no audio at all, which is the harshest version
    // of that case — and it is what caught the regression when the decode was
    // not yet guarded.
    await saveBeatmap(beatmap({ themeId: 'toxic' }));

    const regenerated = await regenerateCharts(SONG_ID);

    expect(regenerated.charts.hard.notes.length).toBeGreaterThan(0);
    expect(regenerated.charts.hard.notes.every((note) => note.type === 'tap')).toBe(true);
    expect(regenerated.themeId).toBe('toxic');
  });

  it('persists what it returns', async () => {
    await saveBeatmap(beatmap({ themeId: 'inferno' }));
    await regenerateCharts(SONG_ID);

    const reloaded = await loadBeatmap(SONG_ID);
    expect(reloaded?.themeId).toBe('inferno');
  });
});

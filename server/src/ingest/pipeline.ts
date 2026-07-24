import type { Beatmap, JobStatus } from '@tap-tap/shared';
import { BEATMAP_VERSION, CHART_VERSION } from '@tap-tap/shared';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ANALYSIS_VERSION, analyze, computeWaveform, generateAllCharts } from '@tap-tap/core';
import {
  AUDIO_FILE,
  THUMB_FILE,
  ensureSongDir,
  loadAnalysis,
  loadBeatmap,
  loadWaveform,
  saveAnalysis,
  saveBeatmap,
  saveWaveform,
  songDir,
} from '../storage.js';
import { convertThumbnail, decodeToMonoPcm, encodeAac } from './transcode.js';
import { downloadAudio, extractVideoId, fetchMetadata } from './ytdlp.js';

const ANALYSIS_SAMPLE_RATE = 44100;

export type ProgressFn = (status: JobStatus, message: string) => void;

/**
 * URL in, beatmap out.
 *
 * The expensive steps are download and analysis, so both are cached: an
 * already-ingested song regenerates its charts from `analysis.json` without
 * touching the network or the decoder.
 */
export async function ingestSong(url: string, onProgress: ProgressFn = () => {}): Promise<Beatmap> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error(`Not a recognizable YouTube URL or video id: ${url}`);

  onProgress('downloading', 'Fetching metadata');
  const meta = await fetchMetadata(url);
  const songId = meta.id;
  const dir = await ensureSongDir(songId);

  const audioOut = path.join(dir, AUDIO_FILE);
  const cached = await loadAnalysis(songId);

  let analysis = cached;
  if (analysis) {
    onProgress('generating', 'Reusing cached analysis');
  } else {
    onProgress('downloading', `Downloading "${meta.title}"`);
    const { audioPath, thumbnailPath } = await downloadAudio(url, dir);

    onProgress('transcoding', 'Transcoding audio');
    await encodeAac(audioPath, audioOut);
    if (thumbnailPath) {
      await convertThumbnail(thumbnailPath, path.join(dir, THUMB_FILE));
    }

    onProgress('analyzing', 'Detecting beats and onsets');
    // Analyze the file the game actually plays, not the original download.
    //
    // AAC encoding introduces priming samples (~20-50ms of encoder delay) and
    // subtly different levels in quiet passages, so analyzing the source and
    // playing the transcode means every note is timed against audio nobody
    // hears. On a track with a soft intro the two disagreed by 20+ seconds
    // about where the first onset even was.
    const pcm = await decodeToMonoPcm(audioOut, ANALYSIS_SAMPLE_RATE);
    analysis = analyze(pcm, ANALYSIS_SAMPLE_RATE);
    await saveAnalysis(songId, analysis);
    // Cached here while the PCM is already in hand. The editor draws it, and
    // hold generation reads it to find sustains — which is why holds work on
    // the existing library without re-analysing anything.
    await saveWaveform(songId, computeWaveform(pcm, ANALYSIS_SAMPLE_RATE));

    // The original download is only needed for analysis; the m4a is what plays.
    await removeSourceFiles(dir);
  }

  onProgress('generating', 'Generating charts');
  const hasThumb = await exists(path.join(dir, THUMB_FILE));

  // A hand-edited name outranks whatever YouTube reports.
  const previous = await loadBeatmap(songId);
  const keepName = previous?.customName === true;
  // Same reasoning for the theme: it is chosen by hand in admin and nothing in
  // the download or the analysis can reconstruct it, so a re-ingest that built
  // a fresh beatmap without it would quietly reset every song to the default.
  const keepTheme = previous?.themeId;

  const beatmap: Beatmap = {
    version: BEATMAP_VERSION,
    chartVersion: CHART_VERSION,
    songId,
    title: keepName ? previous.title : meta.title,
    artist: keepName ? previous.artist : meta.artist,
    ...(keepName ? { customName: true } : {}),
    ...(keepTheme ? { themeId: keepTheme } : {}),
    // Preserve the original add time across re-ingest (regenerate spreads
    // `...existing`, so it inherits this for free).
    createdAt: previous?.createdAt ?? Date.now(),
    duration: analysis.duration || meta.duration,
    audioUrl: `/media/${songId}/${AUDIO_FILE}`,
    thumbnailUrl: hasThumb ? `/media/${songId}/${THUMB_FILE}` : null,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    beatGrid: analysis.beatGrid,
    charts: generateAllCharts(analysis, songId, await loadWaveform(songId)),
  };

  await saveBeatmap(beatmap);
  onProgress('done', `Ready — ${beatmap.bpm} BPM`);
  return beatmap;
}

/** Rebuild charts from cached analysis. Used after tuning difficulty parameters. */
export async function regenerateCharts(songId: string): Promise<Beatmap> {
  const [cachedAnalysis, existing, cachedWaveform] = await Promise.all([
    loadAnalysis(songId),
    loadBeatmap(songId),
    loadWaveform(songId),
  ]);
  if (!cachedAnalysis) throw new Error(`No cached analysis for ${songId}`);
  if (!existing) throw new Error(`No beatmap for ${songId}`);

  // Some regenerations want the PCM after all — a missing waveform, or a stale
  // analysis. Decode at most once, and best-effort throughout: the charts can
  // always be rebuilt from `analysis.json`, so an unreadable media file must
  // degrade the rebuild, never block it.
  let pcm: Float32Array | null | undefined;
  const decodeOnce = async (): Promise<Float32Array | null> => {
    if (pcm === undefined) {
      try {
        const audio = path.join(songDir(songId), AUDIO_FILE);
        pcm = await decodeToMonoPcm(audio, ANALYSIS_SAMPLE_RATE);
      } catch {
        pcm = null;
      }
    }
    return pcm;
  };

  // Re-analyze when the cached analysis predates the current analysis code, so
  // beat-grid and confidence improvements reach the existing library through
  // the Regenerate button instead of stranding every already-ingested song on
  // whatever the analyzer produced the day it was downloaded. One decode per
  // song per analysis version — the result is saved, so the next regenerate is
  // instant again. On decode failure the stale analysis is still a good onset
  // pool; charts rebuild from it as before.
  let analysis = cachedAnalysis;
  if (cachedAnalysis.analysisVersion !== ANALYSIS_VERSION) {
    const decoded = await decodeOnce();
    if (decoded) {
      analysis = analyze(decoded, ANALYSIS_SAMPLE_RATE);
      await saveAnalysis(songId, analysis);
    }
  }

  // Rebuild a missing waveform rather than skipping holds.
  //
  // Songs ingested before waveforms were cached have no envelope on disk, and
  // hold generation reads it — measured on this library, 11 of 28 songs. Left
  // alone they would regenerate to hold-free charts and look like the feature
  // had simply not worked for them.
  let waveform = cachedWaveform;
  if (!waveform) {
    const decoded = await decodeOnce();
    waveform = decoded ? computeWaveform(decoded, ANALYSIS_SAMPLE_RATE) : null;
    if (waveform) await saveWaveform(songId, waveform);
  }

  const beatmap: Beatmap = {
    ...existing,
    chartVersion: CHART_VERSION,
    // Re-analysis may have moved the grid; the beatmap must describe the charts
    // beside it, not the analysis they replaced.
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    beatGrid: analysis.beatGrid,
    charts: generateAllCharts(analysis, songId, waveform),
  };
  await saveBeatmap(beatmap);
  return beatmap;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function removeSourceFiles(dir: string): Promise<void> {
  const files = await fs.readdir(dir);
  await Promise.all(
    files
      .filter((f) => f.startsWith('source.'))
      .map((f) => fs.rm(path.join(dir, f), { force: true })),
  );
}

export { songDir };

/**
 * Filesystem storage.
 *
 * There is no database. Beatmaps are JSON blobs that nothing ever queries
 * inside — the game fetches a whole beatmap or none of it — so a directory per
 * song is the entire storage layer.
 *
 *   media/<songId>/
 *     audio.m4a      playback
 *     thumb.jpg      cover art (optional)
 *     beatmap.json   the wire payload
 *     analysis.json  cached onset pool, so charts regenerate without re-analysis
 */

import type {
  AnalysisResult,
  Beatmap,
  DifficultyName,
  SongSummary,
  Theme,
  Waveform,
} from '@tap-tap/shared';
import { DIFFICULTY_NAMES } from '@tap-tap/shared';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const MEDIA_DIR = process.env['MEDIA_DIR'] ?? path.resolve(here, '../media');

export const AUDIO_FILE = 'audio.m4a';
export const THUMB_FILE = 'thumb.jpg';

export function songDir(songId: string): string {
  return path.join(MEDIA_DIR, songId);
}

export async function ensureSongDir(songId: string): Promise<string> {
  const dir = songDir(songId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value), 'utf8');
}

// --- custom themes ---------------------------------------------------------

/**
 * One flat file for every custom theme, beside the song directories.
 *
 * Not a directory per theme: a theme is a couple of hundred bytes and the whole
 * catalogue is read on nearly every request, so a single file is one read
 * rather than a scandir plus N reads. Built-in themes are **not** in here — they
 * live in `shared/` and cannot be edited, so this file only ever holds the
 * additions.
 */
const THEMES_FILE = 'themes.json';

export function themesPath(): string {
  return path.join(MEDIA_DIR, THEMES_FILE);
}

/**
 * Custom themes, or an empty list.
 *
 * A missing or corrupt file resolves to `[]` rather than throwing: the built-in
 * themes still work, so the game stays playable and the failure is confined to
 * "your custom themes are gone" instead of taking down the song list with it.
 */
export async function loadCustomThemes(): Promise<Theme[]> {
  const themes = await readJson<Theme[]>(themesPath());
  return Array.isArray(themes) ? themes : [];
}

export async function saveCustomThemes(themes: readonly Theme[]): Promise<void> {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await writeJson(themesPath(), themes);
}

// --- beatmaps --------------------------------------------------------------

export function saveBeatmap(beatmap: Beatmap): Promise<void> {
  return writeJson(path.join(songDir(beatmap.songId), 'beatmap.json'), beatmap);
}

export function loadBeatmap(songId: string): Promise<Beatmap | null> {
  return readJson<Beatmap>(path.join(songDir(songId), 'beatmap.json'));
}

// --- cached analysis -------------------------------------------------------

export function saveAnalysis(songId: string, analysis: AnalysisResult): Promise<void> {
  return writeJson(path.join(songDir(songId), 'analysis.json'), analysis);
}

export function loadAnalysis(songId: string): Promise<AnalysisResult | null> {
  return readJson<AnalysisResult>(path.join(songDir(songId), 'analysis.json'));
}

// --- waveform --------------------------------------------------------------

export function saveWaveform(songId: string, waveform: Waveform): Promise<void> {
  return writeJson(path.join(songDir(songId), 'waveform.json'), waveform);
}

export function loadWaveform(songId: string): Promise<Waveform | null> {
  return readJson<Waveform>(path.join(songDir(songId), 'waveform.json'));
}

// --- listing ---------------------------------------------------------------

export async function listBeatmaps(): Promise<Beatmap[]> {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const entries = await fs.readdir(MEDIA_DIR, { withFileTypes: true });
  const maps = await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => loadBeatmap(e.name)),
  );
  return maps.filter((m): m is Beatmap => m !== null);
}

export async function deleteSong(songId: string): Promise<boolean> {
  // Guard against a crafted id escaping the media directory.
  const dir = path.resolve(songDir(songId));
  if (!dir.startsWith(path.resolve(MEDIA_DIR) + path.sep)) return false;
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function toSummary(beatmap: Beatmap): SongSummary {
  const noteCounts = Object.fromEntries(
    DIFFICULTY_NAMES.map((d) => [d, beatmap.charts[d]?.notes.length ?? 0]),
  ) as Record<DifficultyName, number>;

  return {
    songId: beatmap.songId,
    title: beatmap.title,
    artist: beatmap.artist,
    duration: beatmap.duration,
    bpm: beatmap.bpm,
    bpmConfidence: beatmap.bpmConfidence,
    thumbnailUrl: beatmap.thumbnailUrl,
    noteCounts,
    audioUrl: beatmap.audioUrl,
    // Spread conditionally rather than passing `undefined`: `exactOptionalPropertyTypes`
    // treats an explicit undefined as a different thing from an absent key.
    ...(beatmap.themeId ? { themeId: beatmap.themeId } : {}),
    ...(beatmap.createdAt !== undefined ? { createdAt: beatmap.createdAt } : {}),
  };
}

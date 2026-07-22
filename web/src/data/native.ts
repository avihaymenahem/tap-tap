/**
 * On-device library, backed by Capacitor Filesystem (PLAN.md §6h, MB2).
 *
 * This is the serverless replacement for the read half of `api/client.ts`. It
 * mirrors the server's `media/<songId>/` layout under the app's Data directory:
 *
 *   media/<songId>/  beatmap.json  analysis.json  waveform.json  audio.m4a  thumb.jpg
 *   media/themes.json
 *
 * The one subtlety is media URLs. A beatmap stores `audioUrl` / `thumbnailUrl`
 * as `/media/<id>/…`, which only resolves against a server. Here we rewrite them
 * to `convertFileSrc(<filesystem uri>)` **at the source**, so every downstream
 * consumer — `AudioClock.load`, `prefetchAudio`, `<img src>` — keeps working
 * unchanged; it just receives a WebView-loadable file URL instead of an HTTP one.
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type {
  AnalysisResult,
  Beatmap,
  DifficultyName,
  SongSummary,
  Theme,
  Waveform,
} from '@tap-tap/shared';
import { DIFFICULTY_NAMES } from '@tap-tap/shared';

const MEDIA = 'media';
const AUDIO_FILE = 'audio.m4a';
const THUMB_FILE = 'thumb.jpg';
const DIR = Directory.Data;

function songPath(songId: string, file: string): string {
  return `${MEDIA}/${songId}/${file}`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const { data } = await Filesystem.readFile({ directory: DIR, path, encoding: Encoding.UTF8 });
    return JSON.parse(data as string) as T;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ directory: DIR, path });
    return true;
  } catch {
    return false;
  }
}

/** A file URL the WebView can fetch / decode / show, or null when the file is absent. */
async function mediaUrl(songId: string, file: string): Promise<string | null> {
  if (!(await exists(songPath(songId, file)))) return null;
  const { uri } = await Filesystem.getUri({ directory: DIR, path: songPath(songId, file) });
  return Capacitor.convertFileSrc(uri);
}

/**
 * Rewrite a beatmap's media URLs to on-device file URLs.
 *
 * Returns a copy — the stored JSON keeps the portable `/media/…` form so the
 * same file still means the same thing if it is ever read by the server again.
 */
async function withResolvedUrls(beatmap: Beatmap): Promise<Beatmap> {
  const audioUrl = (await mediaUrl(beatmap.songId, AUDIO_FILE)) ?? beatmap.audioUrl;
  const thumbnailUrl = await mediaUrl(beatmap.songId, THUMB_FILE);
  return { ...beatmap, audioUrl, thumbnailUrl };
}

function toSummary(beatmap: Beatmap): SongSummary {
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
    ...(beatmap.themeId ? { themeId: beatmap.themeId } : {}),
  };
}

async function songIds(): Promise<string[]> {
  try {
    const { files } = await Filesystem.readdir({ directory: DIR, path: MEDIA });
    return files.filter((f) => f.type === 'directory').map((f) => f.name);
  } catch {
    return []; // No media dir yet — an empty library, not an error.
  }
}

export async function listSongs(): Promise<SongSummary[]> {
  const ids = await songIds();
  const maps = await Promise.all(
    ids.map(async (id) => {
      const map = await readJson<Beatmap>(songPath(id, 'beatmap.json'));
      return map ? toSummary(await withResolvedUrls(map)) : null;
    }),
  );
  return maps.filter((m): m is SongSummary => m !== null);
}

export async function getBeatmap(songId: string): Promise<Beatmap> {
  const map = await readJson<Beatmap>(songPath(songId, 'beatmap.json'));
  if (!map) throw new Error(`No beatmap for ${songId}`);
  return withResolvedUrls(map);
}

export async function getWaveform(songId: string): Promise<Waveform> {
  const wave = await readJson<Waveform>(songPath(songId, 'waveform.json'));
  if (!wave) throw new Error(`No waveform for ${songId}`);
  return wave;
}

export async function getAnalysis(songId: string): Promise<AnalysisResult> {
  const analysis = await readJson<AnalysisResult>(songPath(songId, 'analysis.json'));
  if (!analysis) throw new Error(`No analysis for ${songId}`);
  return analysis;
}

export async function listCustomThemes(): Promise<Theme[]> {
  const themes = await readJson<Theme[]>(`${MEDIA}/themes.json`);
  return Array.isArray(themes) ? themes : [];
}

/** Delete a song's whole directory — the on-device half of the delete cascade (ME2). */
export async function deleteSong(songId: string): Promise<{ removed: boolean }> {
  try {
    await Filesystem.rmdir({ directory: DIR, path: `${MEDIA}/${songId}`, recursive: true });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

/** No server on device, so nothing is ever read-only. */
export function getConfig(): Promise<{ readOnly: boolean }> {
  return Promise.resolve({ readOnly: false });
}

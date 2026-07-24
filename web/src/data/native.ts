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
import { generateAllCharts } from '@tap-tap/core';
import type {
  AnalysisResult,
  Beatmap,
  DifficultyName,
  Job,
  SongSummary,
  Theme,
  Waveform,
} from '@tap-tap/shared';
import {
  CHART_VERSION,
  DIFFICULTY_NAMES,
  isBuiltinTheme,
  isThemeId,
  themeCatalog,
  themeErrors,
  validateTheme,
} from '@tap-tap/shared';

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
    ...(beatmap.createdAt !== undefined ? { createdAt: beatmap.createdAt } : {}),
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

// --- writes: the admin operations, on-device (MC2 follow-up) ----------------

async function writeSongJson(songId: string, file: string, value: unknown): Promise<void> {
  await Filesystem.writeFile({
    directory: DIR,
    path: songPath(songId, file),
    data: JSON.stringify(value),
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

async function loadBeatmap(songId: string): Promise<Beatmap> {
  const map = await readJson<Beatmap>(songPath(songId, 'beatmap.json'));
  if (!map) throw new Error(`No beatmap for ${songId}`);
  return map;
}

export async function renameSong(
  songId: string,
  title: string,
  artist: string,
): Promise<SongSummary> {
  const map = await loadBeatmap(songId);
  // customName freezes the title against the next re-ingest — same rule the
  // server's PATCH route follows when a title/artist is actually sent.
  const updated: Beatmap = { ...map, title, artist, customName: true };
  await writeSongJson(songId, 'beatmap.json', updated);
  return toSummary(await withResolvedUrls(updated));
}

export async function setSongTheme(songId: string, themeId: string): Promise<SongSummary> {
  const map = await loadBeatmap(songId);
  const catalog = themeCatalog(await listCustomThemes());
  if (!isThemeId(catalog, themeId)) throw new Error(`Unknown theme: ${themeId}`);
  const updated: Beatmap = { ...map, themeId };
  await writeSongJson(songId, 'beatmap.json', updated);
  return toSummary(await withResolvedUrls(updated));
}

/** Rebuild charts from the cached analysis — no re-download, no re-decode. */
export async function regenerateCharts(songId: string): Promise<SongSummary> {
  const [analysis, existing, waveform] = await Promise.all([
    readJson<AnalysisResult>(songPath(songId, 'analysis.json')),
    loadBeatmap(songId),
    readJson<Waveform>(songPath(songId, 'waveform.json')),
  ]);
  if (!analysis) throw new Error(`No cached analysis for ${songId}`);
  const updated: Beatmap = {
    ...existing,
    chartVersion: CHART_VERSION,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    beatGrid: analysis.beatGrid,
    charts: generateAllCharts(analysis, songId, waveform),
  };
  await writeSongJson(songId, 'beatmap.json', updated);
  return toSummary(await withResolvedUrls(updated));
}

// --- custom themes ---------------------------------------------------------

async function saveCustomThemes(themes: readonly Theme[]): Promise<void> {
  await Filesystem.writeFile({
    directory: DIR,
    path: `${MEDIA}/themes.json`,
    data: JSON.stringify(themes),
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

export async function createTheme(theme: Theme): Promise<Theme> {
  const custom = await listCustomThemes();
  const problems = themeErrors(validateTheme(theme, themeCatalog(custom)));
  if (problems.length) throw new Error(problems[0]!.message);
  await saveCustomThemes([...custom, theme]);
  return theme;
}

export async function updateTheme(theme: Theme): Promise<Theme> {
  if (isBuiltinTheme(theme.id)) throw new Error(`“${theme.id}” is a built-in theme.`);
  const custom = await listCustomThemes();
  if (!custom.some((t) => t.id === theme.id)) throw new Error(`No theme with id “${theme.id}”.`);
  // Validate against the catalogue minus this theme, so its own id is not
  // flagged as "already exists".
  const others = custom.filter((t) => t.id !== theme.id);
  const problems = themeErrors(validateTheme(theme, themeCatalog(others)));
  if (problems.length) throw new Error(problems[0]!.message);
  await saveCustomThemes(custom.map((t) => (t.id === theme.id ? theme : t)));
  return theme;
}

export async function deleteTheme(
  themeId: string,
): Promise<{ removed: boolean; songsAffected: number }> {
  if (isBuiltinTheme(themeId)) {
    throw new Error(`“${themeId}” is a built-in theme and cannot be deleted.`);
  }
  const custom = await listCustomThemes();
  await saveCustomThemes(custom.filter((t) => t.id !== themeId));
  // Songs keep the dead id and fall back to the default — not a cascade. Report
  // how many so the UI can say so.
  let songsAffected = 0;
  for (const id of await songIds()) {
    const map = await readJson<Beatmap>(songPath(id, 'beatmap.json'));
    if (map?.themeId === themeId) songsAffected++;
  }
  return { removed: true, songsAffected };
}

// --- jobs: no async job queue on device; ingest is synchronous (the FAB) ----

export function listJobs(): Promise<Job[]> {
  return Promise.resolve([]);
}

export function clearFinishedJobs(): Promise<{ removed: number }> {
  return Promise.resolve({ removed: 0 });
}

export function startIngest(_url: string): Promise<Job> {
  // Never reached on device — the admin ingest form is hidden there in favour
  // of the synchronous FAB flow — but the signature matches the HTTP client so
  // the data dispatch stays callable.
  return Promise.reject(new Error('Use the + button to add a song on device.'));
}

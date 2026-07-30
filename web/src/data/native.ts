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
import {
  ANALYSIS_VERSION,
  computeWaveform,
  generateAllCharts,
  integratedLoudness,
  replayGainDb,
} from '@tap-tap/core';
import type {
  AnalysisResult,
  Beatmap,
  Chart,
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
import { decodeAudioToMonoPcm } from '../ingest/decodeAudio.js';
import { analyzeInWorker } from '../ingest/index.js';
import { base64ToArrayBuffer } from './base64.js';

const MEDIA = 'media';
const AUDIO_FILE = 'audio.m4a';
const THUMB_FILE = 'thumb.jpg';
const DIR = Directory.Data;
/** Must match the rate ingest analysed at, or the cached analysis and a fresh one disagree. */
const ANALYSIS_SAMPLE_RATE = 44100;

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

/**
 * Decode this song's `audio.m4a` to analysis PCM, or null if that is impossible.
 *
 * Best-effort throughout, exactly like the server's `decodeOnce`: charts can
 * always be rebuilt from `analysis.json`, so an unreadable or undecodable media
 * file must degrade a regenerate, never block it.
 */
async function decodeSongPcm(songId: string): Promise<Float32Array | null> {
  try {
    const { data } = await Filesystem.readFile({ directory: DIR, path: songPath(songId, AUDIO_FILE) });
    return await decodeAudioToMonoPcm(base64ToArrayBuffer(data as string), ANALYSIS_SAMPLE_RATE);
  } catch {
    return null;
  }
}

export interface RegenerateOptions {
  /**
   * Repair the *inputs* to generation as well as rebuilding the charts, which
   * costs one audio decode. Off by default.
   *
   * Without this, regenerate is what the `CHART_VERSION` self-heal needs: a read
   * of `analysis.json` and ~0.4ms of chart prep, cheap enough to run while a
   * player is opening a song. With it, a song whose cached analysis predates
   * `ANALYSIS_VERSION` is re-analysed, a missing waveform is rebuilt rather than
   * silently producing hold-free charts, and a missing `gainDb` is measured —
   * the three repairs the server has always done and the device never did, which
   * left a phone-ingested song stranded on whatever analyser downloaded it.
   *
   * Deliberately opt-in, and admin is the only caller: re-analysis is seconds
   * per song on a phone, and paying that inside `getBeatmap` would turn opening
   * a song into a frozen loading screen. Each repair is saved, so the cost is
   * paid once per song.
   */
  deep?: boolean;
  /** Human-readable stage, for the admin progress line. Only fires on the slow paths. */
  onProgress?: (message: string) => void;
}

/**
 * Rebuild a song's charts from its cached analysis — no re-download.
 *
 * Spreads the existing beatmap so `customName`, `themeId`, `createdAt` and
 * anything else set by hand survive; only the generated fields are replaced.
 */
export async function regenerateCharts(
  songId: string,
  options: RegenerateOptions = {},
): Promise<SongSummary> {
  const { deep = false, onProgress = () => {} } = options;
  const [cachedAnalysis, existing, cachedWaveform] = await Promise.all([
    readJson<AnalysisResult>(songPath(songId, 'analysis.json')),
    loadBeatmap(songId),
    readJson<Waveform>(songPath(songId, 'waveform.json')),
  ]);
  if (!cachedAnalysis) throw new Error(`No cached analysis for ${songId}`);

  let analysis = cachedAnalysis;
  let waveform = cachedWaveform;
  let gainDb = existing.gainDb;
  let charts: Record<DifficultyName, Chart> | null = null;

  // Absence means "old" — an `analysis.json` from before the stamp existed is
  // stale by definition, which is the same reading `AnalysisResult` documents.
  const staleAnalysis = cachedAnalysis.analysisVersion !== ANALYSIS_VERSION;
  if (deep && staleAnalysis) {
    onProgress('Decoding audio…');
    const pcm = await decodeSongPcm(songId);
    if (pcm) {
      // The worker, not the main thread: a full re-analysis is seconds of solid
      // JS, and running it inline freezes the WebView — the button would look
      // exactly as dead as the one this whole change exists to fix. It hands
      // back the waveform and the loudness measured on the same PCM, so the
      // other two repairs come free with it. (`pcm` is detached by the transfer;
      // nothing may touch it after this call.)
      onProgress('Re-analysing audio…');
      try {
        const bundle = await analyzeInWorker(pcm, ANALYSIS_SAMPLE_RATE, songId);
        analysis = bundle.analysis;
        waveform = bundle.waveform;
        gainDb = bundle.gainDb;
        charts = bundle.charts;
        await writeSongJson(songId, 'analysis.json', analysis);
        await writeSongJson(songId, 'waveform.json', waveform);
      } catch {
        // Guarded for the same reason the decode is: the stale analysis is still
        // a perfectly good onset pool, so a worker that cannot start must cost
        // the song its *upgrade*, not its charts.
      }
    }
  }

  // The cheap per-sample repairs, checked *after* the re-analysis rather than as
  // its `else`: a stale song is also the likeliest one to be missing a waveform,
  // and when the worker cannot run it would otherwise fall between the two
  // branches and regenerate hold-free with nothing saying why — the exact silent
  // failure this whole path exists to remove. Both are a couple of linear passes,
  // so they stay on this thread rather than paying for a worker round-trip and a
  // redundant re-analysis. The second decode only ever happens when the transfer
  // above consumed the first buffer *and* the upgrade failed; a successful
  // re-analysis has already supplied both, so the common paths decode once.
  if (deep && (!waveform || gainDb === undefined)) {
    onProgress('Decoding audio…');
    const pcm = await decodeSongPcm(songId);
    if (pcm) {
      if (!waveform) {
        onProgress('Rebuilding waveform…');
        waveform = computeWaveform(pcm, ANALYSIS_SAMPLE_RATE);
        await writeSongJson(songId, 'waveform.json', waveform);
      }
      if (gainDb === undefined) {
        onProgress('Measuring loudness…');
        gainDb = replayGainDb(integratedLoudness(pcm, ANALYSIS_SAMPLE_RATE));
      }
    }
  }

  const updated: Beatmap = {
    ...existing,
    chartVersion: CHART_VERSION,
    // Re-analysis may have moved the grid; the beatmap must describe the charts
    // beside it, not the analysis they replaced.
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    beatGrid: analysis.beatGrid,
    ...(gainDb !== undefined ? { gainDb } : {}),
    charts: charts ?? generateAllCharts(analysis, songId, waveform),
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

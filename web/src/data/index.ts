/**
 * The app's data source — one seam that hides *where* the library lives.
 *
 * In the browser (dev, and the desktop build) it is the ingest server over HTTP.
 * In the Capacitor Android app there is no server, so it is the on-device
 * Filesystem library (`native.ts`). Screens import the read surface from here and
 * never branch on platform themselves; the media URLs a beatmap carries are
 * already resolved to whatever the current platform can load.
 *
 * Only the read + resolve surface is dispatched. Admin writes (ingest, rename,
 * theme edits) stay on `api/client` for now — native ingest is MC2.
 */

import { Capacitor } from '@capacitor/core';
import { CHART_VERSION, type Beatmap } from '@tap-tap/shared';
import * as http from '../api/client.js';
import * as native from './native.js';

export { seedIfEmpty } from './seed.js';

/** True inside the Capacitor native shell, false in a plain browser. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

const source = isNativePlatform() ? native : http;

// Reads
export const getConfig = source.getConfig;
export const listSongs = source.listSongs;

/**
 * Read a beatmap, upgrading it in place if its charts predate the current
 * generation rules.
 *
 * This is the self-heal for stale charts: a code update that changes note
 * placement raises `CHART_VERSION`, and any already-ingested song still on the
 * old rules regenerates from its cached analysis the first time it is opened —
 * no re-download, no re-analysis, and no manual "regenerate every song" chore
 * after an update. Regeneration also persists, so it happens once per song, then
 * the fast path (a single read) resumes. On any failure the existing map is
 * returned unchanged: a stale chart still plays, so healing must never break
 * opening a song.
 */
export async function getBeatmap(songId: string): Promise<Beatmap> {
  const map = await source.getBeatmap(songId);
  if ((map.chartVersion ?? 0) >= CHART_VERSION) return map;
  try {
    await source.regenerateCharts(songId);
    return await source.getBeatmap(songId);
  } catch {
    return map;
  }
}

export const getAnalysis = source.getAnalysis;
export const getWaveform = source.getWaveform;
export const listCustomThemes = source.listCustomThemes;

// Library management (admin). On device these write the Filesystem; in the
// browser they hit the dev server.
export const renameSong = source.renameSong;
export const setSongTheme = source.setSongTheme;
export const deleteSong = source.deleteSong;
export const regenerateCharts = source.regenerateCharts;
export const createTheme = source.createTheme;
export const updateTheme = source.updateTheme;
export const deleteTheme = source.deleteTheme;

// Ingest jobs — a no-op queue on device (ingest is the synchronous FAB flow).
export const listJobs = source.listJobs;
export const clearFinishedJobs = source.clearFinishedJobs;
export const startIngest = source.startIngest;

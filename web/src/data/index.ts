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
import * as http from '../api/client.js';
import * as native from './native.js';

export { seedIfEmpty } from './seed.js';

/** True inside the Capacitor native shell, false in a plain browser. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

const source = isNativePlatform() ? native : http;

export const getConfig = source.getConfig;
export const listSongs = source.listSongs;
export const getBeatmap = source.getBeatmap;
export const getAnalysis = source.getAnalysis;
export const getWaveform = source.getWaveform;
export const listCustomThemes = source.listCustomThemes;

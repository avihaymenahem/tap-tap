/**
 * First-run seeding of the on-device library from bundled assets (PLAN.md §6h).
 *
 * A freshly installed APK has an empty Filesystem, so without this the menu is
 * blank until the user ingests something. Any songs placed under `web/public/seed/`
 * (a `manifest.json` listing ids, plus `seed/<id>/<files>`) are copied into the
 * Data directory the first time the app runs with an empty library.
 *
 * Absent seed assets are not an error — `fetch` 404s and seeding is skipped — so
 * the mechanism can ship before (or without) any bundled demo content.
 */

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { arrayBufferToBase64 } from './base64.js';

const MEDIA = 'media';
const DIR = Directory.Data;

/** Files a seeded song directory may contain. Missing ones are skipped. */
const SONG_FILES = ['beatmap.json', 'analysis.json', 'waveform.json', 'audio.m4a', 'thumb.jpg'];

interface SeedManifest {
  songs: string[];
}

async function hasAnySong(): Promise<boolean> {
  try {
    const { files } = await Filesystem.readdir({ directory: DIR, path: MEDIA });
    return files.some((f) => f.type === 'directory');
  } catch {
    return false;
  }
}

async function copyBundledFile(songId: string, file: string): Promise<void> {
  const response = await fetch(`seed/${songId}/${file}`);
  if (!response.ok) return; // Optional file (e.g. thumb.jpg) simply absent.
  const isText = file.endsWith('.json');
  const path = `${MEDIA}/${songId}/${file}`;
  if (isText) {
    // JSON is written as UTF-8 text. Without an explicit encoding, writeFile
    // treats `data` as base64 and mangles it to empty — which read back as a
    // song with no beatmap, i.e. an empty menu.
    await Filesystem.writeFile({
      directory: DIR,
      path,
      data: await response.text(),
      encoding: Encoding.UTF8,
      recursive: true,
    });
  } else {
    // Binary (audio, thumbnail) has no encoding — writeFile's default is base64.
    const base64 = arrayBufferToBase64(await response.arrayBuffer());
    await Filesystem.writeFile({ directory: DIR, path, data: base64, recursive: true });
  }
}

/**
 * Copy bundled seed songs into the library the first time it is empty.
 *
 * Best-effort and idempotent: it runs only when the library has no songs, so a
 * user who deletes the demo is not force-fed it again on the next launch.
 */
export async function seedIfEmpty(): Promise<void> {
  if (await hasAnySong()) return;
  let manifest: SeedManifest;
  try {
    const response = await fetch('seed/manifest.json');
    if (!response.ok) return;
    manifest = (await response.json()) as SeedManifest;
  } catch {
    return; // No bundled seed — nothing to do.
  }
  for (const songId of manifest.songs ?? []) {
    for (const file of SONG_FILES) {
      try {
        await copyBundledFile(songId, file);
      } catch {
        // One bad file must not abort the whole seed.
      }
    }
  }
}

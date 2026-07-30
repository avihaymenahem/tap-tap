/**
 * On-device ingest orchestration (PLAN.md §6h, MC2) — the serverless port of the
 * server's `ingestSong`.
 *
 * URL in, beatmap on the Filesystem out. The native `YoutubeDl` plugin (MC1)
 * downloads and transcodes to m4a; the file is decoded with Web Audio and run
 * through the exact `@tap-tap/core` pipeline in a worker (MA2); the result is
 * written into the same `media/<songId>/` layout the read layer expects (MB2).
 *
 * The one behaviour carried over verbatim from the server is preservation: a
 * re-ingest keeps a hand-set `customName`/`themeId` rather than resetting it.
 */

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { Beatmap } from '@tap-tap/shared';
import { BEATMAP_VERSION, BUILTIN_THEMES, CHART_VERSION } from '@tap-tap/shared';
import { analyzeInWorker, decodeAudioToMonoPcm } from '../ingest/index.js';
import { YoutubeDl } from '../plugins/youtubedl.js';
import { base64ToArrayBuffer } from './base64.js';
import { cleanTrackMeta } from './clean-title.js';
import { dominantColor, nearestThemeByColor, randomThemeId, type Rgb } from './theme-pick.js';

const DIR = Directory.Data;
const ANALYSIS_SAMPLE_RATE = 44100;
const AUDIO_FILE = 'audio.m4a';
const THUMB_FILE = 'thumb.jpg';

/**
 * Progress callback: a human message and a 0..1 fraction for a bar. The fraction
 * is stage-based, not a true download percentage — the native download has no
 * per-line callback (its arity drifts between library versions), so the long
 * download stage holds at a fraction while the bar shimmers to show it is alive.
 */
export type IngestProgress = (message: string, fraction: number) => void;

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

async function readBeatmap(songId: string): Promise<Beatmap | null> {
  try {
    const { data } = await Filesystem.readFile({
      directory: DIR,
      path: `media/${songId}/beatmap.json`,
      encoding: Encoding.UTF8,
    });
    return JSON.parse(data as string) as Beatmap;
  } catch {
    return null;
  }
}

/**
 * Sample the stored cover's dominant colour, for auto-theming. Decodes the JPEG
 * onto a tiny canvas and hands the pixels to the pure `dominantColor`. Wholly
 * best-effort: any failure (missing file, decode error, no canvas) returns null
 * and the caller falls back to a random theme.
 */
async function coverDominantColor(songId: string): Promise<Rgb | null> {
  try {
    const { data } = await Filesystem.readFile({ directory: DIR, path: `media/${songId}/${THUMB_FILE}` });
    return await new Promise<Rgb | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const size = 24; // enough to average colour; cheap to decode
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, size, size);
          resolve(dominantColor(ctx.getImageData(0, 0, size, size).data));
        } catch {
          resolve(null); // a tainted or undecodable cover just skips matching
        }
      };
      img.onerror = () => resolve(null);
      // A data URI is same-origin, so the canvas stays untainted and readable.
      img.src = `data:image/jpeg;base64,${data as string}`;
    });
  } catch {
    return null;
  }
}

/**
 * Choose a theme for a newly ingested song. A re-ingest keeps whatever theme was
 * set before; a brand-new song (or one that never had a theme) is auto-assigned
 * — matched to the cover's dominant colour when there is one, random otherwise —
 * so the library isn't a wall of the default palette.
 */
async function chooseTheme(songId: string, keepTheme: string | undefined, hasThumb: boolean): Promise<string> {
  if (keepTheme) return keepTheme;
  const cover = hasThumb ? await coverDominantColor(songId) : null;
  return cover ? nearestThemeByColor(BUILTIN_THEMES, cover) : randomThemeId(BUILTIN_THEMES);
}

async function writeJson(songId: string, file: string, value: unknown): Promise<void> {
  await Filesystem.writeFile({
    directory: DIR,
    path: `media/${songId}/${file}`,
    data: JSON.stringify(value),
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

/**
 * Download, analyse and store one song from a YouTube URL. Returns its songId.
 *
 * Only works in the native app — the `YoutubeDl` plugin is unimplemented on web.
 */
export async function ingestFromUrl(url: string, onProgress: IngestProgress = () => {}): Promise<string> {
  onProgress('Fetching details…', 0.08);
  const meta = await YoutubeDl.fetchMetadata({ url });
  const songId = meta.id;

  // The plugin writes into the song's own directory under the app data dir.
  const { uri } = await Filesystem.getUri({ directory: DIR, path: `media/${songId}` });
  const destDir = uri.replace(/^file:\/\//, '');

  onProgress(`Downloading “${meta.title}”…`, 0.2);
  const listener = await YoutubeDl.addListener('progress', ({ progress }) => {
    // Only emitted if the native plugin gains a progress callback; harmless now.
    if (progress > 0) onProgress(`Downloading… ${Math.round(progress)}%`, 0.2 + (progress / 100) * 0.4);
  });
  let download;
  try {
    download = await YoutubeDl.download({ url, destDir });
  } finally {
    await listener.remove();
  }

  onProgress('Decoding audio…', 0.65);
  const audioName = basename(download.audioPath);
  const { data } = await Filesystem.readFile({ directory: DIR, path: `media/${songId}/${audioName}` });
  const pcm = await decodeAudioToMonoPcm(base64ToArrayBuffer(data as string), ANALYSIS_SAMPLE_RATE);

  onProgress('Detecting beats and building charts…', 0.82);
  const bundle = await analyzeInWorker(pcm, ANALYSIS_SAMPLE_RATE, songId);

  // Move the downloaded files into their canonical names, so the read layer and
  // the portable `/media/...` URLs find them.
  await Filesystem.rename({
    directory: DIR,
    from: `media/${songId}/${audioName}`,
    to: `media/${songId}/${AUDIO_FILE}`,
  });
  let hasThumb = false;
  if (download.thumbnailPath) {
    const thumbName = basename(download.thumbnailPath);
    const ext = thumbName.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTS.has(ext)) {
      try {
        await Filesystem.rename({
          directory: DIR,
          from: `media/${songId}/${thumbName}`,
          to: `media/${songId}/${THUMB_FILE}`,
        });
        hasThumb = true;
      } catch {
        // A missing thumbnail is cosmetic; the song still plays.
      }
    }
  }

  // Preservation: re-ingesting a song keeps hand edits.
  const previous = await readBeatmap(songId);
  const keepName = previous?.customName === true;
  const keepTheme = previous?.themeId;

  // Auto-assign a theme so new tracks don't all land on the default palette.
  const themeId = await chooseTheme(songId, keepTheme, hasThumb);

  // YouTube titles come laden with "(Official Music Video)" / "[HD]" / VEVO
  // noise; tidy them into a song title + artist (a hand-set name is preserved).
  const cleaned = cleanTrackMeta(meta.title, meta.artist);

  const beatmap: Beatmap = {
    version: BEATMAP_VERSION,
    chartVersion: CHART_VERSION,
    songId,
    title: keepName ? previous.title : cleaned.title,
    artist: keepName ? previous.artist : cleaned.artist,
    ...(keepName ? { customName: true } : {}),
    themeId,
    // Keep the original add time across re-ingest so "recently added" means
    // when the song first arrived, not when it was last rebuilt.
    createdAt: previous?.createdAt ?? Date.now(),
    duration: bundle.analysis.duration || meta.duration,
    audioUrl: `/media/${songId}/${AUDIO_FILE}`,
    thumbnailUrl: hasThumb ? `/media/${songId}/${THUMB_FILE}` : null,
    bpm: bundle.analysis.bpm,
    bpmConfidence: bundle.analysis.bpmConfidence,
    beatGrid: bundle.analysis.beatGrid,
    // Measured on the decode the analysis ran over, and stored — the worker has
    // returned this since it was written, and dropping it here is why every
    // song ingested on the phone played unlevelled while the desktop library
    // was normalised. Absence means unity, so the omission was silent.
    gainDb: bundle.gainDb,
    charts: bundle.charts,
  };

  await writeJson(songId, 'analysis.json', bundle.analysis);
  await writeJson(songId, 'waveform.json', bundle.waveform);
  await writeJson(songId, 'beatmap.json', beatmap);

  onProgress('Done', 1);
  return songId;
}

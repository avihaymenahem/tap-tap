import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import youtubeDl from 'youtube-dl-exec';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

export interface VideoMeta {
  id: string;
  title: string;
  artist: string;
  duration: number;
}

export interface DownloadResult {
  audioPath: string;
  thumbnailPath: string | null;
}

/** Accepts full URLs (watch, youtu.be, shorts, embed) or a bare 11-character id. */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export async function fetchMetadata(url: string): Promise<VideoMeta> {
  const raw: unknown = await youtubeDl(url, {
    dumpSingleJson: true,
    skipDownload: true,
    noPlaylist: true,
    noWarnings: true,
  });

  const info = asRecord(raw);
  const id = asString(info['id']) || extractVideoId(url);
  if (!id) throw new Error(`Could not determine a video id for ${url}`);

  return {
    id,
    title: asString(info['title'], 'Unknown title'),
    // Music uploads carry a real `artist`; everything else falls back to the channel.
    artist: asString(info['artist']) || asString(info['uploader']) || asString(info['channel'], ''),
    duration: typeof info['duration'] === 'number' ? info['duration'] : 0,
  };
}

/** Download best-available audio plus cover art into `destDir`. */
export async function downloadAudio(url: string, destDir: string): Promise<DownloadResult> {
  await youtubeDl(url, {
    format: 'bestaudio/best',
    output: path.join(destDir, 'source.%(ext)s'),
    noPlaylist: true,
    noWarnings: true,
    writeThumbnail: true,
    ...(ffmpegStatic ? { ffmpegLocation: ffmpegStatic } : {}),
  });

  const files = await fs.readdir(destDir);
  let audioPath: string | null = null;
  let thumbnailPath: string | null = null;

  for (const file of files) {
    if (!file.startsWith('source.')) continue;
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTENSIONS.has(ext)) thumbnailPath = path.join(destDir, file);
    else audioPath = path.join(destDir, file);
  }

  if (!audioPath) throw new Error('yt-dlp produced no audio file');
  return { audioPath, thumbnailPath };
}

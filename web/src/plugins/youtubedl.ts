import { registerPlugin } from '@capacitor/core';

/**
 * Bridge to the native `YoutubeDl` plugin (MC1) — the on-device yt-dlp.
 *
 * Only meaningful in the Capacitor Android app; in a browser these methods
 * reject (the plugin is unimplemented on web), which is why native ingest is
 * gated behind `isNativePlatform()`.
 */
export interface YoutubeDlMetadata {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
}

export interface YoutubeDlDownload {
  audioPath: string;
  thumbnailPath?: string;
}

export interface YoutubeDlPlugin {
  fetchMetadata(options: { url: string }): Promise<YoutubeDlMetadata>;
  download(options: { url: string; destDir: string }): Promise<YoutubeDlDownload>;
  /** Fires with `{ progress: number }` (0–100) during a download. */
  addListener(
    event: 'progress',
    handler: (data: { progress: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const YoutubeDl = registerPlugin<YoutubeDlPlugin>('YoutubeDl');

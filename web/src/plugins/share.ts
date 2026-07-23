import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Bridge to the native `Share` plugin — a YouTube link shared into the app via
 * Android's `ACTION_SEND` (the share sheet). MainActivity parks the shared text;
 * `getSharedUrl` returns it (empty when there is none) and clears it, so the same
 * call covers a cold start (the share launched the app) and a warm one (already
 * open). Unimplemented on web, so callers go through `takeSharedUrl`.
 */
interface SharePlugin {
  getSharedUrl(): Promise<{ url: string }>;
}

const Share = registerPlugin<SharePlugin>('Share');

/**
 * The YouTube URL shared into the app, or null. Safe everywhere: a no-op in a
 * plain browser (no native plugin), and the shared text is reduced to its first
 * URL — YouTube shares a title plus the link, e.g. "Song title https://youtu.be/…".
 */
export async function takeSharedUrl(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const { url } = await Share.getSharedUrl();
    return firstUrl(url);
  } catch {
    return null;
  }
}

function firstUrl(text: string): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s]+/);
  const url = (match ? match[0] : text).trim();
  return url.length > 0 ? url : null;
}

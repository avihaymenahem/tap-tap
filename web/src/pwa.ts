/**
 * Service worker registration and offline-cache queries.
 *
 * The worker itself is `sw.ts`; this is the page's side of the conversation.
 */

/**
 * Must match `MEDIA_CACHE` in `sw.ts`.
 *
 * Duplicated rather than shared because the worker is compiled as a separate
 * program with its own libs and cannot import from the app's module graph.
 * `pwa.test.ts` asserts the two stay equal, since a silent drift here would not
 * throw — it would just report every song as unavailable offline.
 */
export const MEDIA_CACHE = 'tap-tap-media';

/**
 * Whether this context can run a service worker at all.
 *
 * **Service workers require a secure context**, which means HTTPS or localhost.
 * Reaching the dev server over a plain-HTTP LAN or tailnet address
 * (`http://100.82.104.20:5173`) leaves `navigator.serviceWorker` undefined —
 * verified, not assumed. Everything here degrades to "no offline support"
 * rather than throwing, so the game still works on that origin.
 */
export function canUseServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;
}

export function canUseCaches(): boolean {
  return typeof caches !== 'undefined';
}

/**
 * Registers the worker. Safe to call anywhere; it no-ops when unsupported.
 *
 * **Production builds only.** Vite dev serves hundreds of unbundled ES modules
 * and rewrites them on every edit; a cache-first worker in front of that graph
 * serves stale modules and produces exactly the "my change did nothing"
 * confusion that HMR already causes here. The worker is also only emitted by
 * the production build, so in dev there is nothing to register.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !canUseServiceWorker()) return;

  // After load: registration competes with the first paint and the initial
  // beatmap fetch otherwise, and nothing on screen depends on it.
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      // A failed registration costs offline support, nothing else. Logged
      // rather than surfaced: there is no action a player could take.
      console.warn('Service worker registration failed', error);
    });
  });
}

/**
 * The set of audio URLs already in the offline cache.
 *
 * Used to tell the player which songs are actually playable without a network.
 * Returns an empty set wherever the Cache API is unavailable, so callers can
 * treat "nothing cached" and "caching impossible" the same way.
 */
export async function cachedAudioUrls(): Promise<Set<string>> {
  if (!canUseCaches()) return new Set();

  try {
    const cache = await caches.open(MEDIA_CACHE);
    const requests = await cache.keys();
    // Stored as absolute URLs; compare on pathname so callers can pass the
    // relative `audioUrl` straight from a SongSummary.
    return new Set(requests.map((request) => new URL(request.url).pathname));
  } catch {
    return new Set();
  }
}

/**
 * Evicts one song's cached media so a delete leaves nothing behind on-device.
 *
 * The song directory is gone server-side, but its `audio.m4a` (and thumbnail)
 * may still sit in the offline cache under `/media/<songId>/…` — a dead file the
 * player has no way to clear. Matches on the path segment rather than a full URL
 * because entries are stored absolute. No-ops without the Cache API.
 */
export async function evictSongMedia(songId: string): Promise<void> {
  if (!canUseCaches()) return;
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const prefix = `/media/${songId}/`;
    const requests = await cache.keys();
    await Promise.all(
      requests
        .filter((request) => new URL(request.url).pathname.startsWith(prefix))
        .map((request) => cache.delete(request)),
    );
  } catch {
    // Best-effort: a failed eviction is a stale cached file, not a broken app.
  }
}

/** Drops every cached track. Returns false when there is no worker to ask. */
export async function clearOfflineTracks(): Promise<boolean> {
  if (!canUseCaches()) return false;
  try {
    await caches.delete(MEDIA_CACHE);
    return true;
  } catch {
    return false;
  }
}

/** Rough bytes held by the offline caches, or null when unknown. */
export async function offlineUsageBytes(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.usage ?? null;
  } catch {
    return null;
  }
}

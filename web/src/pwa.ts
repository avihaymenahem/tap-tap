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

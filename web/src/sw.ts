/// <reference lib="webworker" />

/**
 * Service worker: offline play for songs the player has already loaded.
 *
 * Hand-rolled rather than Workbox, for the same reason the DSP and the router
 * are: the whole policy is four rules and a cleanup pass, and a generated
 * config would be harder to reason about than the thing it generates.
 *
 * **Everything is cached on use, nothing is precached but the shell.** That is
 * not a shortcut — it is the requested behaviour ("tracks I've loaded before"),
 * and it is also the only sane option when the library is ~25 tracks of ~5MB.
 * Precaching would mean a 125MB download on first visit.
 *
 * Registered in production builds only; see `pwa.ts` for why.
 */

/**
 * `self` is typed as the generic `WorkerGlobalScope`, which has none of the
 * service-worker surface (`skipWaiting`, `clients`, `ExtendableEvent`). Aliasing
 * is the fix; redeclaring `self` collides with the lib's own declaration.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * Bumping this invalidates the shell and API caches. **It deliberately does not
 * touch the media cache** — an app update must not cost the player a re-download
 * of every song they have offline.
 */
const VERSION = 'v1';

const SHELL_CACHE = `tap-tap-shell-${VERSION}`;
const API_CACHE = `tap-tap-api-${VERSION}`;
/**
 * Unversioned on purpose: this holds the audio, which is immutable per song id
 * and expensive to fetch. It survives every app update and is only ever cleared
 * deliberately or by the browser reclaiming storage.
 */
const MEDIA_CACHE = 'tap-tap-media';

const KEEP = new Set([SHELL_CACHE, API_CACHE, MEDIA_CACHE]);

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await sw.caches.open(SHELL_CACHE);
      // The document itself, so a cold offline launch has something to render.
      // Hashed assets arrive through the normal cache-first path on first load.
      await cache.add('/');
      // Taking over immediately is safe here because the bundle is a single
      // chunk: there are no lazily-loaded pieces that could go missing when the
      // old shell cache is dropped mid-session.
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await sw.caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('tap-tap-') && !KEEP.has(name))
          .map((name) => sw.caches.delete(name)),
      );
      await sw.clients.claim();
    })(),
  );
});

/** Only 200s are worth storing. A 206 cannot be `put` at all and would throw. */
function isCacheable(response: Response): boolean {
  return response.status === 200 && response.type === 'basic';
}

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await sw.caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (isCacheable(response)) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await sw.caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

sw.addEventListener('fetch', (event) => {
  const { request } = event;

  // Writes are never intercepted. Ingest, rename, delete and theme edits must
  // fail honestly when offline rather than appear to succeed from a cache.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  // A ranged request yields a 206, which cannot be stored. Nothing here issues
  // one today — audio is fetched whole so `decodeAudioData` gets a full buffer —
  // but a media element added later would, and silently poisoning this path
  // would be hard to trace.
  if (request.headers.has('range')) return;

  // Navigations: network first so a running server always wins, falling back to
  // the cached document. Without this, every deep link (/play/:id/:difficulty)
  // is a hard 404 offline, because only '/' was ever cached.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await sw.caches.open(SHELL_CACHE);
          const shell = await cache.match('/');
          if (shell) return shell;
          throw new Error('offline and no cached shell');
        }
      })(),
    );
    return;
  }

  // Audio and artwork. Cache-first because they are immutable for a given song
  // id and large: re-validating a 5MB track on every play would defeat the point.
  if (url.pathname.startsWith('/media/')) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE));
    return;
  }

  // Beatmaps, the song list, themes, server config. Network-first so edits show
  // up immediately when online, with the last good response kept for offline.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // Build output is content-hashed, so a given URL never changes meaning.
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

/**
 * Lets the page drop every offline track without clearing site data by hand.
 * Kept in the worker because the media cache name is defined here.
 */
sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'CLEAR_MEDIA') {
    event.waitUntil(sw.caches.delete(MEDIA_CACHE));
  }
});

import { useEffect, useState } from 'react';
import { cachedAudioUrls } from '../pwa.js';

/**
 * Whether the browser thinks it is offline.
 *
 * `navigator.onLine` is famously weak — it reports the *link*, not whether
 * anything is reachable, so it stays true on a captive portal or when only this
 * server is down. It is used here for presentation only (a banner, a dimmed
 * row); nothing decides whether a fetch is *allowed* based on it, so a wrong
 * answer costs a misleading label rather than a broken game.
 */
export function useOffline(): boolean {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);

  useEffect(() => {
    const update = (): void => setOffline(!navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return offline;
}

/**
 * Audio paths currently in the offline cache.
 *
 * Genuine external state — the cache is written by the service worker, in
 * another thread, as a side effect of playing songs — so this is one of the
 * few places an effect is the right tool rather than derived state.
 *
 * Re-read whenever `signal` changes, which callers use to refresh after a song
 * has been played.
 */
export function useCachedAudio(signal: unknown = null): Set<string> {
  const [cached, setCached] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    void cachedAudioUrls().then((urls) => {
      if (!cancelled) setCached(urls);
    });
    return () => {
      cancelled = true;
    };
  }, [signal]);

  return cached;
}

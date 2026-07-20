import { DIFFICULTY_NAMES, type DifficultyName } from '@tap-tap/shared';
import { useCallback, useEffect, useState } from 'react';
import { isReadOnly } from './api/serverConfig.js';

/**
 * Tiny typed router over the History API.
 *
 * Deliberately hand-rolled rather than pulling in react-router: there are five
 * flat routes with no nesting, no loaders and no data layer, and doing it here
 * keeps the `Route` union as the single source of truth. Parsing a URL becomes
 * a total function returning that union, so the screen switch stays exhaustive
 * and a typo in a path cannot produce a route the app does not understand.
 */

export type Route =
  | { name: 'menu' }
  | { name: 'play'; songId: string; difficulty: DifficultyName }
  | { name: 'results'; songId: string; difficulty: DifficultyName }
  | { name: 'edit'; songId: string; difficulty: DifficultyName }
  | { name: 'calibrate' }
  | { name: 'admin' }
  | { name: 'themes' };

function isDifficulty(value: string): value is DifficultyName {
  return (DIFFICULTY_NAMES as readonly string[]).includes(value);
}

export interface ParseOptions {
  /**
   * When false, `/admin` and `/edit/...` resolve to the menu.
   *
   * Gating here rather than in `App` means the existing canonicalizing effect
   * rewrites the address bar for free, so a shared link to an authoring screen
   * lands on the song list instead of a dead route.
   */
  authoring?: boolean;
}

/** Total: anything unrecognized falls back to the menu. */
export function parseRoute(pathname: string, options?: ParseOptions): Route {
  const [head, songId, difficulty] = pathname.split('/').filter(Boolean);
  const authoring = options?.authoring ?? true;

  switch (head) {
    case undefined:
      return { name: 'menu' };
    case 'admin':
      if (!authoring) return { name: 'menu' };
      // `/admin/themes` rather than a top-level `/themes`: it is an authoring
      // screen, and nesting it under admin means the read-only gate above
      // covers it without a second rule to keep in sync.
      return songId === 'themes' ? { name: 'themes' } : { name: 'admin' };
    case 'calibrate':
      return { name: 'calibrate' };
    case 'play':
    case 'results':
    case 'edit': {
      if (head === 'edit' && !authoring) return { name: 'menu' };
      if (!songId || !difficulty || !isDifficulty(difficulty)) return { name: 'menu' };
      return { name: head, songId: decodeURIComponent(songId), difficulty };
    }
    default:
      return { name: 'menu' };
  }
}

export function routeToPath(route: Route): string {
  switch (route.name) {
    case 'menu':
      return '/';
    case 'admin':
      return '/admin';
    case 'themes':
      return '/admin/themes';
    case 'calibrate':
      return '/calibrate';
    case 'play':
      return `/play/${encodeURIComponent(route.songId)}/${route.difficulty}`;
    case 'results':
      return `/results/${encodeURIComponent(route.songId)}/${route.difficulty}`;
    case 'edit':
      return `/edit/${encodeURIComponent(route.songId)}/${route.difficulty}`;
  }
}

export interface Router {
  route: Route;
  /** `replace` avoids pushing a history entry — use it for redirects. */
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}

export function useRouter(): Router {
  // Constant for the lifetime of the page: it describes the server, which
  // cannot change while the app is open.
  const authoring = !isReadOnly();
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, { authoring }),
  );

  // Browser back/forward is the whole point of using real URLs.
  useEffect(() => {
    const onPopState = (): void =>
      setRoute(parseRoute(window.location.pathname, { authoring }));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [authoring]);

  // Keep the address bar honest. An unrecognized URL resolves to the menu, and
  // without this the bar would keep showing e.g. /play/abc/impossible while the
  // menu is on screen — and reloading would look like it had done nothing.
  useEffect(() => {
    const canonical = routeToPath(route);
    if (canonical !== window.location.pathname) {
      window.history.replaceState(null, '', canonical);
    }
  }, [route]);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }): void => {
    const path = routeToPath(next);
    if (options?.replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setRoute(next);
  }, []);

  return { route, navigate };
}

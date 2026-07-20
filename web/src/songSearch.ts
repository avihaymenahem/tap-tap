import type { SongSummary } from '@tap-tap/shared';

/**
 * Search and sort shared by the player menu and the admin library.
 *
 * Pure, so it can be tested without a DOM — and shared, so the two screens
 * cannot end up with subtly different ideas of what a search matches.
 */

/**
 * Every whitespace-separated term must match somewhere, so "eminem lose" finds
 * the track regardless of which field holds which word. Substring rather than
 * prefix matching: half-remembered titles are the normal case here.
 */
export function filterSongs(songs: readonly SongSummary[], query: string): SongSummary[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...songs];

  return songs.filter((song) => {
    const haystack = `${song.title} ${song.artist}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Keeps only starred songs. Identity when nothing is starred, so an empty
 *  favourites list never hides the whole library. */
export function filterFavorites(
  songs: readonly SongSummary[],
  favorites: ReadonlySet<string>,
  only: boolean,
): SongSummary[] {
  if (!only || favorites.size === 0) return [...songs];
  return songs.filter((song) => favorites.has(song.songId));
}

export type SongSort = 'favorite' | 'title' | 'artist' | 'bpm' | 'confidence' | 'notes';

export const SONG_SORT_LABELS: Record<SongSort, string> = {
  favorite: 'Favorites first',
  title: 'Title A–Z',
  artist: 'Artist A–Z',
  bpm: 'BPM (slowest first)',
  confidence: 'Confidence (worst first)',
  notes: 'Notes (most first)',
};

export const SONG_SORTS = Object.keys(SONG_SORT_LABELS) as SongSort[];

/**
 * Sorts the player menu offers. Confidence is an authoring diagnostic — "find
 * the badly detected tempos and regenerate them" — and means nothing to someone
 * choosing a song, so it stays on the admin screen.
 */
export const MENU_SORTS: SongSort[] = ['favorite', 'title', 'artist', 'bpm'];

/** Case- and accent-aware, so "Ä" sorts next to "A" rather than after "Z". */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const COMPARATORS: Record<SongSort, (a: SongSummary, b: SongSummary) => number> = {
  // Replaced in `sortSongs`, which is the only place that knows what is
  // starred. Present so the record stays exhaustive over `SongSort`.
  favorite: (a, b) => collator.compare(a.title, b.title),
  title: (a, b) => collator.compare(a.title, b.title),
  artist: (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title),
  bpm: (a, b) => a.bpm - b.bpm,
  /**
   * Ascending on purpose. The admin page already flags low-confidence tempo
   * detection, and the actual workflow is "find the broken ones and regenerate
   * them" — so the worst offenders belong at the top, not buried at the bottom.
   */
  confidence: (a, b) => a.bpmConfidence - b.bpmConfidence,
  notes: (a, b) => totalNotes(b) - totalNotes(a),
};

function totalNotes(song: SongSummary): number {
  return Object.values(song.noteCounts).reduce((sum, n) => sum + n, 0);
}

export interface Page<T> {
  items: T[];
  /** 1-based and always valid, whatever was asked for. */
  page: number;
  /** At least 1, so "Page 1 of 1" reads sensibly on an empty list. */
  pageCount: number;
  /** 1-based position of the first and last item shown; 0 when empty. */
  from: number;
  to: number;
}

/**
 * Slice a list into a page, clamping the requested page into range.
 *
 * Clamping here rather than syncing page state in an effect is what keeps the
 * list correct when the collection shrinks underneath it: deleting the last
 * song on the last page, or narrowing a search, would otherwise leave the view
 * on a page that no longer exists, showing nothing and looking broken.
 */
export function paginate<T>(items: readonly T[], page: number, perPage: number): Page<T> {
  const size = Math.max(1, Math.floor(perPage));
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);

  const start = (safePage - 1) * size;
  const slice = items.slice(start, start + size);

  return {
    items: slice,
    page: safePage,
    pageCount,
    from: slice.length === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}

/** Returns a new array; never mutates the caller's list. */
export function sortSongs(
  songs: readonly SongSummary[],
  sort: SongSort,
  /**
   * Which songs are starred. Passed in rather than read from storage so this
   * stays pure and testable, the same reason `laneColor` takes a theme.
   */
  favorites: ReadonlySet<string> = new Set(),
): SongSummary[] {
  const compare =
    sort === 'favorite'
      ? // Starred first, then alphabetical *within* each group — so the list
        // stays predictable rather than favourites landing in arbitrary order.
        (a: SongSummary, b: SongSummary): number =>
          Number(favorites.has(b.songId)) - Number(favorites.has(a.songId))
      : COMPARATORS[sort];

  // Title is the tiebreaker everywhere so equal keys keep a stable, predictable
  // order rather than shuffling between renders.
  return [...songs].sort((a, b) => compare(a, b) || collator.compare(a.title, b.title));
}

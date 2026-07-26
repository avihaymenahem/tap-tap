import type { DifficultyName, SongSummary, Theme } from '@tap-tap/shared';
import { DEFAULT_ACCENT, DIFFICULTY_NAMES, themeCatalog, themeFor } from '@tap-tap/shared';
import { ChevronDown, Download, Star, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { isNativePlatform, listCustomThemes, listSongs } from '../data/index.js';
import { NativeIngest } from '../components/NativeIngest.js';
import { SongHero } from '../components/SongHero.js';
import { playUiSound } from '../uisfx.js';
import { prefetchAudio } from '../api/prefetch.js';
import { isReadOnly } from '../api/serverConfig.js';
import { useCachedAudio, useOffline } from '../hooks/useOffline.js';
import { previewStartSec, useSongPreview } from '../hooks/useSongPreview.js';
import {
  MENU_SORTS,
  SONG_SORT_LABELS,
  type SongSort,
  filterFavorites,
  filterSongs,
  sortSongs,
} from '../songSearch.js';
import {
  bestScoreKey,
  getBestScore,
  getBestScores,
  getFavorites,
  getLastSong,
  getPreviewEnabled,
  getStoredSort,
  setLastSong,
  setStoredSort,
  toggleFavorite,
} from '../storage.js';
import { LAMP_LABELS, type Lamp, lampFor } from '../game/lamps.js';

interface MenuScreenProps {
  onPlay: (songId: string, difficulty: DifficultyName) => void;
  /**
   * Two players, one phone, same chart. Takes the same difficulty as `onPlay`
   * rather than a pair: both sides play the identical chart at the same instant
   * off one shared clock, which is what makes the match fair and is the reason
   * Versus needs no second picker.
   */
  onVersus: (songId: string, difficulty: DifficultyName) => void;
  onAdmin: () => void;
  onSettings: () => void;
  onAchievements: () => void;
  onHowToPlay: () => void;
  /** A YouTube link shared into the app; opens the Add-a-song dialog prefilled. */
  sharedUrl?: string | null;
  onShareConsumed?: () => void;
}

/**
 * The player's difficulty preference resolved against what a song actually has.
 *
 * Returns the preference itself when the song offers it, otherwise the closest
 * available rung by position in the difficulty ladder — so a preference for
 * Extreme lands on Hard for a song that has not been regenerated, rather than
 * on nothing. `undefined` only when the song has no playable chart at all.
 */
function nearestAvailable(
  preferred: DifficultyName,
  available: readonly DifficultyName[],
): DifficultyName | undefined {
  if (available.length === 0) return undefined;
  if (available.includes(preferred)) return preferred;

  const preferredIndex = DIFFICULTY_NAMES.indexOf(preferred);
  return available.reduce((best, name) =>
    Math.abs(DIFFICULTY_NAMES.indexOf(name) - preferredIndex) <
    Math.abs(DIFFICULTY_NAMES.indexOf(best) - preferredIndex)
      ? name
      : best,
  );
}

export function MenuScreen({
  onPlay,
  onVersus,
  onAdmin,
  onSettings,
  onAchievements,
  onHowToPlay,
  sharedUrl,
  onShareConsumed,
}: MenuScreenProps): JSX.Element {
  const [songs, setSongs] = useState<SongSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a native ingest to re-list the library.
  const [reloadKey, setReloadKey] = useState(0);
  const [ingestOpen, setIngestOpen] = useState(false);
  /** URL to prefill the Add-a-song dialog with (a shared YouTube link). */
  const [ingestUrl, setIngestUrl] = useState<string | null>(null);
  const native = isNativePlatform();
  // On device there is no server, so "add songs" runs the native ingest instead
  // of opening the server-only admin screen (whose HTTP calls just return the
  // app shell — the "<!doctype … is not valid JSON" error).
  const openAdd = native ? () => setIngestOpen(true) : onAdmin;
  // Medium, not easy: easy is 3 lanes at ~1.2 notes/sec, which reads as a demo
  // rather than a game to anyone who has played one before. Easy stays one
  // click away for players who want it.
  const [difficulty, setDifficulty] = useState<DifficultyName>('medium');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  /** Menu song previews: a short clip when you select a track. */
  const preview = useSongPreview();
  /**
   * Read once on mount, and read-only here — the switch itself lives on the
   * settings screen. Navigating back remounts this screen (App keys it by
   * route), so a change made over there is in force by the time the list can
   * play anything.
   */
  const [previewsOn] = useState(getPreviewEnabled);

  const [favorites, setFavorites] = useState<ReadonlySet<string>>(getFavorites);
  // Restore the last chosen sort, so it survives leaving and coming back.
  const [sort, setSort] = useState<SongSort>(() => {
    const stored = getStoredSort();
    return MENU_SORTS.includes(stored as SongSort) ? (stored as SongSort) : 'favorite';
  });
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  /**
   * The full-screen focused hero — the big disc + living aura + colour wash a
   * song blows up into when tapped. The list is home; this is the detail view,
   * opened over it and dismissed back to browsing.
   */
  const [heroOpen, setHeroOpen] = useState(false);
  /** Sort picker dropdown — a styled menu, not a native select. */
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  /**
   * Custom themes, fetched once so the detail panel can recolour to the
   * selected song's accent — the palette continuity that carries through
   * ready, play and results starts here. Best-effort: without them, built-in
   * themes still resolve and custom ones fall back to the default accent.
   */
  const [customThemes, setCustomThemes] = useState<readonly Theme[]>([]);

  const offline = useOffline();
  // Re-read the cache when connectivity flips: coming back online and playing
  // something should not leave the badges describing an older state.
  const cachedAudio = useCachedAudio(offline);

  // Dismissing an open menu is genuinely document-level: a click anywhere else,
  // or Escape, has to close it.
  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // The sort menu dismisses like the hamburger: any outside click, or Escape.
  useEffect(() => {
    if (!sortOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!sortRef.current?.contains(event.target as Node)) setSortOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSortOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [sortOpen]);

  useEffect(() => {
    let cancelled = false;
    listCustomThemes()
      .then((themes) => {
        if (!cancelled) setCustomThemes(themes);
      })
      .catch(() => {
        // Best-effort — built-in themes still resolve without the fetch.
      });
    listSongs()
      .then((list) => {
        if (cancelled) return;
        setSongs(list);
        // Restore the last-played song (highlighted on return), falling back to
        // the top of the list if it is gone or nothing was played yet.
        setSelected((current) => {
          if (current) return current;
          const last = getLastSong();
          if (last && list.some((s) => s.songId === last)) return last;
          return list[0]?.songId ?? null;
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // A YouTube link shared into the app (delivered via props from App) opens the
  // Add-a-song dialog prefilled — so the whole flow is: share → tap Add.
  useEffect(() => {
    if (!sharedUrl) return;
    setIngestUrl(sharedUrl);
    setIngestOpen(true);
    onShareConsumed?.();
    // Only react to a fresh shared URL; the consume callback nulls it out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedUrl]);

  // Bring the restored (last-played) song into view once the list is up — it
  // may be far down, where the highlight alone would be off-screen.
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!songs || scrolledRef.current) return;
    scrolledRef.current = true;
    document.querySelector('.song-card--active')?.scrollIntoView({ block: 'nearest' });
  }, [songs]);

  // After adding a track, scroll it into view once the reloaded list contains
  // it. Held in a ref so a re-render cannot re-fire the jump; cleared once done.
  const pendingScrollRef = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id || !songs || !songs.some((s) => s.songId === id)) return;
    pendingScrollRef.current = null;
    // Next frame, so the new row has been laid out before we scroll to it.
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-song-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [songs]);

  // All derived, not stored: no effect needed to keep any of it in sync.

  // Search, then the favourites filter, then sort. All derived during render —
  // a stored copy is exactly how a filtered list goes stale.
  const filtered = sortSongs(
    filterFavorites(filterSongs(songs ?? [], query), favorites, favoritesOnly),
    sort,
    favorites,
  );

  // Falling back to the first result keeps the detail panel from showing a song
  // that the current search has filtered out of the list.
  const selectedSong = filtered.find((s) => s.songId === selected) ?? filtered[0] ?? null;

  // Only difficulties this song actually has a chart for. Older songs ingested
  // before Extreme existed carry no extreme chart until they are regenerated —
  // showing a difficulty that cannot be played (the button would just disable
  // itself) is worse than not offering it.
  const available = selectedSong
    ? DIFFICULTY_NAMES.filter((name) => (selectedSong.noteCounts[name] ?? 0) > 0)
    : [];

  // The picker only renders available difficulties, so a stored preference for
  // one this song lacks (e.g. Extreme, on an un-regenerated song) would be
  // invisible yet still drive Play. Resolve it to the nearest available rung so
  // the highlighted button, the best score and Play always agree.
  const effectiveDifficulty = nearestAvailable(difficulty, available);
  const best =
    selectedSong && effectiveDifficulty ? getBestScore(selectedSong.songId, effectiveDifficulty) : null;

  // The selected song's theme accent, painting the detail panel so the palette
  // already matches before the ready screen ever shows.
  const catalog = useMemo(() => themeCatalog(customThemes), [customThemes]);
  // Contained to the detail panel on purpose — the shared backdrop stays gold.
  // Tinting the whole menu to the current selection made the glow lurch between
  // colours as you browse and mixed badly with the warm stage.
  const selectedAccent = selectedSong
    ? (themeFor(catalog, selectedSong.themeId).accent ?? DEFAULT_ACCENT)
    : DEFAULT_ACCENT;

  // Grade badges for the list. Memoised because the stored score map is one
  // blob — reading it per song per difficulty would re-parse it thirty-plus
  // times on every keystroke of search. Read once here and look up in memory.
  // Scores only change on the results screen, so songs + difficulty are the only
  // real inputs.
  const gradeBySong = useMemo(() => {
    const scores = getBestScores();
    const grades = new Map<string, string>();
    for (const song of songs ?? []) {
      const has = DIFFICULTY_NAMES.filter((name) => (song.noteCounts[name] ?? 0) > 0);
      const resolved = nearestAvailable(difficulty, has);
      const grade = resolved
        ? scores[bestScoreKey(song.songId, resolved)]?.grade
        : undefined;
      if (grade) grades.set(song.songId, grade);
    }
    return grades;
  }, [songs, difficulty]);

  /**
   * Clear lamps per song: one per difficulty, so a row reads as a completion map
   * rather than a single verdict at whichever difficulty happens to be selected.
   *
   * Independent of `difficulty` on purpose — the whole point is seeing what is
   * left on the *other* rungs — so this only recomputes when the library does.
   */
  const lampsBySong = useMemo(() => {
    const scores = getBestScores();
    const map = new Map<string, { difficulty: DifficultyName; lamp: Lamp; assisted: boolean }[]>();
    for (const song of songs ?? []) {
      const row = DIFFICULTY_NAMES.filter((name) => (song.noteCounts[name] ?? 0) > 0).map(
        (name) => {
          const best = scores[bestScoreKey(song.songId, name)];
          return {
            difficulty: name,
            lamp: lampFor(best, song.noteCounts[name] ?? 0),
            assisted: best?.assisted === true,
          };
        },
      );
      // Nothing to show for a song with no cleared chart at all — an all-empty
      // strip is noise on every untouched row, which is most of a fresh library.
      if (row.some((entry) => entry.lamp !== 'none')) map.set(song.songId, row);
    }
    return map;
  }, [songs]);

  // Move the focused selection through the currently filtered list (the hero's
  // prev/next and the desktop arrow keys). Wraps around, and carries the same
  // preview + prefetch that tapping a card does.
  const stepSong = (delta: number): void => {
    if (filtered.length === 0 || !selectedSong) return;
    const idx = filtered.findIndex((s) => s.songId === selectedSong.songId);
    const next = filtered[(idx + delta + filtered.length) % filtered.length];
    if (!next) return;
    playUiSound('tick');
    setSelected(next.songId);
    setLastSong(next.songId);
    if (previewsOn) preview.play(next.audioUrl, previewStartSec(next.duration));
    else preview.stop();
    prefetchAudio(next.audioUrl);
  };

  return (
    <div className="menu">
      {native && (
        <>
          {/* No FAB — "Add songs" in the menu dropdown opens this same ingest
              dialog, so a floating button was a redundant second entry point. */}
          <NativeIngest
            open={ingestOpen}
            initialUrl={ingestUrl}
            onClose={() => {
              setIngestOpen(false);
              setIngestUrl(null);
            }}
            onDone={(newSongId) => {
              setIngestOpen(false);
              setIngestUrl(null);
              // Clear any filter so the new track is guaranteed to be in the
              // list, select it, then scroll to it once the reload renders.
              setQuery('');
              setFavoritesOnly(false);
              setSelected(newSongId);
              setLastSong(newSongId);
              pendingScrollRef.current = newSongId;
              setReloadKey((k) => k + 1);
            }}
          />
        </>
      )}
      <header className="menu__header">
        {/* Search lives in the header beside the menu button — no wordmark up
            here. The screen is the library; a persistent brand lockup earned
            its keep less than giving that row to searching does. Only shown
            once there is a library to search. */}
        {songs && songs.length > 0 && (
          <div className="search">
            <input
              type="search"
              className="search__input"
              placeholder="Search songs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
            />
            {query && (
              <button
                type="button"
                className="search__clear"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="menu__actions" ref={menuRef}>
          <button
            type="button"
            className="icon-btn"
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ☰
          </button>

          {/* Navigation only. Every device setting lives on /settings — this
              dropdown had grown to fourteen entries, at which point the actions
              worth reaching quickly were buried among toggles nobody changes
              twice. */}
          {menuOpen && (
            <div className="dropdown" role="menu">
              <button
                type="button"
                role="menuitem"
                className="dropdown__item"
                onClick={() => {
                  setMenuOpen(false);
                  onSettings();
                }}
              >
                <span>⚙ Settings</span>
              </button>

              <button
                type="button"
                role="menuitem"
                className="dropdown__item"
                onClick={() => {
                  setMenuOpen(false);
                  onAchievements();
                }}
              >
                <span>🏆 Achievements</span>
              </button>

              <button
                type="button"
                role="menuitem"
                className="dropdown__item"
                onClick={() => {
                  setMenuOpen(false);
                  onHowToPlay();
                }}
              >
                <span>How to play</span>
              </button>

              {!isReadOnly() && (
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown__item"
                  onClick={() => {
                    setMenuOpen(false);
                    openAdd();
                  }}
                >
                  <span>Add songs</span>
                </button>
              )}

              {/* On device, "Add songs" opens the quick ingest; library
                  management (rename, theme, delete, regenerate, themes editor)
                  is its own entry into the now-native-capable admin screen. On
                  the web it is already reachable via "Add songs" → admin. */}
              {native && (
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown__item"
                  onClick={() => {
                    setMenuOpen(false);
                    onAdmin();
                  }}
                >
                  <span>Manage library</span>
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {offline && songs !== null && (
        <p className="menu__offline">
          <WifiOff size={14} aria-hidden />
          Offline — only songs you have already played are available.
        </p>
      )}

      {/* A raw fetch message ("Failed to fetch") is meaningless to a player, and
          offline is much the likeliest cause of one here. */}
      {error && (
        <p className="error-text">
          {offline
            ? 'Offline, and the song list has not been loaded on this device yet. Connect once and it will be kept for next time.'
            : error}
        </p>
      )}

      {songs === null && !error && (
        <div className="menu__empty">
          <div className="spinner" />
        </div>
      )}

      {songs?.length === 0 && (
        <div className="menu__empty">
          <h2>No songs yet</h2>
          {isReadOnly() ? (
            <p className="muted">This server has no charts loaded.</p>
          ) : (
            <>
              <p className="muted">Add a YouTube link and it will be analyzed into a chart.</p>
              <button type="button" className="btn btn--primary" onClick={openAdd}>
                Add your first song
              </button>
            </>
          )}
        </div>
      )}

      {songs && songs.length > 0 && (
        <div className="menu__body">
          <div className="song-column">
            <div className="song-tools">
              {/* A styled menu, not a native <select> — the one control the OS
                  would otherwise draw in its own widget style, which reads as
                  "web form" in the middle of a game UI. Same dismiss rules as
                  the hamburger: outside click or Escape. */}
              <div className="song-tools__sort" ref={sortRef}>
                <button
                  type="button"
                  className="song-tools__sortbtn"
                  aria-haspopup="menu"
                  aria-expanded={sortOpen}
                  onClick={() => setSortOpen((open) => !open)}
                >
                  <span className="muted small">Sort</span>
                  {SONG_SORT_LABELS[sort]}
                  <ChevronDown size={14} aria-hidden />
                </button>
                {sortOpen && (
                  <div className="dropdown dropdown--sort" role="menu">
                    {MENU_SORTS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="menuitemradio"
                        aria-checked={option === sort}
                        className={`dropdown__item ${option === sort ? 'dropdown__item--active' : ''}`}
                        onClick={() => {
                          setSort(option);
                          setStoredSort(option);
                          setSortOpen(false);
                          playUiSound('tick');
                        }}
                      >
                        <span>{SONG_SORT_LABELS[option]}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Hidden until something is starred — a filter that can only
                  ever empty the list is worse than no filter. */}
              {favorites.size > 0 && (
                <button
                  type="button"
                  className={`song-tools__only ${favoritesOnly ? 'song-tools__only--on' : ''}`}
                  aria-pressed={favoritesOnly}
                  onClick={() => setFavoritesOnly((on) => !on)}
                >
                  <Star size={14} aria-hidden />
                  Favorites ({favorites.size})
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <p className="muted search__empty">
                {favoritesOnly && query.trim() === ''
                  ? 'No favorites yet — tap a star to add one.'
                  : `Nothing matches “${query.trim()}”.`}
              </p>
            ) : (
              <ul className="song-list">
                {filtered.map((song, index) => (
                  // `position: relative` so the star can sit over the card.
                  // It cannot go *inside* the card: that is a <button>, and a
                  // button inside a button is invalid and breaks activation.
                  // The stagger index is capped: past the fold the entrance
                  // should be done, not still trickling in.
                  <li
                    key={song.songId}
                    className="song-row rise"
                    style={{ '--i': Math.min(index, 10) } as CSSProperties}
                  >
                    <button
                      type="button"
                      className={`song-row__star ${
                        favorites.has(song.songId) ? 'song-row__star--on' : ''
                      }`}
                      aria-pressed={favorites.has(song.songId)}
                      aria-label={
                        favorites.has(song.songId)
                          ? `Remove ${song.title} from favorites`
                          : `Add ${song.title} to favorites`
                      }
                      onClick={() => {
                        toggleFavorite(song.songId);
                        // Re-read rather than mutating the set in place, so the
                        // new object identity actually triggers a re-render.
                        const next = getFavorites();
                        setFavorites(next);
                        // A rising tick on adding, a falling one on removing.
                        playUiSound(next.has(song.songId) ? 'confirm' : 'back');
                      }}
                    >
                      <Star size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
                      data-song-id={song.songId}
                      className={[
                        'song-card',
                        selectedSong?.songId === song.songId ? 'song-card--active' : '',
                        // Dimmed, not disabled. `navigator.onLine` is not
                        // trustworthy enough to refuse a tap on its say-so —
                        // if it is wrong, the song plays fine and the only harm
                        // was a faded row.
                        offline && !cachedAudio.has(song.audioUrl) ? 'song-card--unavailable' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => {
                        playUiSound('tick');
                        setSelected(song.songId);
                        setLastSong(song.songId);
                        // A tap is a user gesture, so a preview clip may autoplay
                        // here (unlike the cold-load last-song restore). Off ⇒
                        // silence, and the cache warm below still runs.
                        if (previewsOn) preview.play(song.audioUrl, previewStartSec(song.duration));
                        else preview.stop();
                        // Tapping a track blows it up into the full-screen hero.
                        setHeroOpen(true);
                        // The seconds spent choosing a difficulty are free
                        // download time; on a slow link this is most of the
                        // wait the play screen would otherwise show.
                        prefetchAudio(song.audioUrl);
                      }}
                      // Desktop players hover before they click. Mobile fires
                      // this alongside the tap, so it costs nothing there.
                      onPointerEnter={() => prefetchAudio(song.audioUrl)}
                    >
                      {song.thumbnailUrl ? (
                        <img className="song-card__art" src={song.thumbnailUrl} alt="" />
                      ) : (
                        <div className="song-card__art song-card__art--blank" />
                      )}
                      <div className="song-card__text">
                        <div className="song-card__title">
                          {song.title}
                          {/* Shown only offline. Online it is noise — every song
                              is playable — but offline it is the difference
                              between a song that works and one that cannot. */}
                          {offline && cachedAudio.has(song.audioUrl) && (
                            <span className="song-card__offline" title="Available offline">
                              <Download size={12} aria-hidden />
                            </span>
                          )}
                        </div>
                        <div className="song-card__meta">
                          <span>
                            {song.artist || 'Unknown'} · {formatDuration(song.duration)} ·{' '}
                            {Math.round(song.bpm)} BPM
                          </span>
                          {/* Best grade at the current difficulty — cleared
                              songs read as conquered territory at a glance. */}
                          {gradeBySong.has(song.songId) && (
                            <span
                              className={`song-card__grade grade--${gradeBySong.get(song.songId)}`}
                            >
                              {gradeBySong.get(song.songId)}
                            </span>
                          )}
                          {/* One pip per difficulty: what is still unclaimed on
                              this song, without changing difficulty to find out.
                              Titled per pip so the state is never colour-only. */}
                          {lampsBySong.has(song.songId) && (
                            <span
                              className="song-card__lamps"
                              role="img"
                              // The pips carry information available nowhere else
                              // on the row, so the group gets a real accessible
                              // name rather than being hidden as decoration. The
                              // individual pips are then decorative within it —
                              // `title` on a span is not reliably announced.
                              aria-label={lampsBySong
                                .get(song.songId)!
                                .map((e) => `${e.difficulty} ${LAMP_LABELS[e.lamp].toLowerCase()}`)
                                .join(', ')}
                            >
                              {lampsBySong.get(song.songId)!.map((entry) => (
                                <span
                                  key={entry.difficulty}
                                  aria-hidden="true"
                                  className={`lamp lamp--${entry.lamp}${
                                    entry.assisted ? ' lamp--assisted' : ''
                                  }`}
                                  title={`${entry.difficulty}: ${LAMP_LABELS[entry.lamp]}${
                                    entry.assisted ? ' (assisted)' : ''
                                  }`}
                                />
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

        </div>
      )}

      {/* The full-screen focused hero, opened when a track is tapped. */}
      {heroOpen && selectedSong && (
        <SongHero
          song={selectedSong}
          accent={selectedAccent}
          available={available}
          difficulty={effectiveDifficulty}
          onSelectDifficulty={(name) => {
            playUiSound('tick');
            setDifficulty(name);
          }}
          best={best}
          onPlay={() => {
            if (!effectiveDifficulty) return;
            playUiSound('confirm');
            preview.stop(); // never let a preview bleed into the run
            onPlay(selectedSong.songId, effectiveDifficulty);
          }}
          onVersus={() => {
            if (!effectiveDifficulty) return;
            playUiSound('confirm');
            preview.stop();
            onVersus(selectedSong.songId, effectiveDifficulty);
          }}
          onClose={() => {
            playUiSound('back');
            preview.stop();
            setHeroOpen(false);
          }}
          onPrev={() => stepSong(-1)}
          onNext={() => stepSong(1)}
        />
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

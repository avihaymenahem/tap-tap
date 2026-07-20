import type { DifficultyName, SongSummary } from '@tap-tap/shared';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '@tap-tap/shared';
import { ChevronDown, Download, Star, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import { listSongs } from '../api/client.js';
import { prefetchAudio } from '../api/prefetch.js';
import { isReadOnly } from '../api/serverConfig.js';
import { HapticToggle } from '../components/HapticToggle.js';
import { useCachedAudio, useOffline } from '../hooks/useOffline.js';
import { clearOfflineTracks, offlineUsageBytes } from '../pwa.js';
import {
  MENU_SORTS,
  SONG_SORT_LABELS,
  type SongSort,
  filterFavorites,
  filterSongs,
  sortSongs,
} from '../songSearch.js';
import { getBestScore, getFavorites, toggleFavorite } from '../storage.js';

interface MenuScreenProps {
  onPlay: (songId: string, difficulty: DifficultyName) => void;
  onAdmin: () => void;
  onCalibrate: () => void;
}

export function MenuScreen({ onPlay, onAdmin, onCalibrate }: MenuScreenProps): JSX.Element {
  const [songs, setSongs] = useState<SongSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Medium, not easy: easy is 3 lanes at ~1.2 notes/sec, which reads as a demo
  // rather than a game to anyone who has played one before. Easy stays one
  // click away for players who want it.
  const [difficulty, setDifficulty] = useState<DifficultyName>('medium');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [favorites, setFavorites] = useState<ReadonlySet<string>>(getFavorites);
  const [sort, setSort] = useState<SongSort>('favorite');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  /**
   * Mobile only: the detail panel is a fixed bottom sheet there, permanently
   * covering a chunk of the list. Dismissing it gives the whole screen back to
   * browsing; picking any track brings it straight back, so there is no need
   * for a separate way to reopen it.
   *
   * Ignored entirely on desktop, where the panel is a column beside the list.
   */
  const [sheetOpen, setSheetOpen] = useState(true);

  const offline = useOffline();
  /** Storage the origin is using. Read when the menu opens, so it stays current. */
  const [offlineBytes, setOfflineBytes] = useState<number | null>(null);
  // Re-read the cache when connectivity flips: coming back online and playing
  // something should not leave the badges describing an older state.
  const cachedAudio = useCachedAudio(offline);

  // Dismissing an open menu is genuinely document-level: a click anywhere else,
  // or Escape, has to close it.
  useEffect(() => {
    if (!menuOpen) return;

    // Genuinely external state, and cheap enough to re-read each time the menu
    // opens rather than trying to keep a copy in sync with the cache.
    void offlineUsageBytes().then(setOfflineBytes);

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

  useEffect(() => {
    let cancelled = false;
    listSongs()
      .then((list) => {
        if (cancelled) return;
        setSongs(list);
        setSelected((current) => current ?? list[0]?.songId ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const best = selectedSong ? getBestScore(selectedSong.songId, difficulty) : null;
  const noteCount = selectedSong?.noteCounts[difficulty] ?? 0;

  return (
    <div className="menu">
      <header className="menu__header">
        <h1 className="logo">
          <span className="logo__tap">tap</span>
          <span className="logo__dot">·</span>
          <span className="logo__tap logo__tap--alt">tap</span>
        </h1>
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

          {menuOpen && (
            <div className="dropdown" role="menu">
              <HapticToggle className="dropdown__item" />

              <button
                type="button"
                role="menuitem"
                className="dropdown__item"
                onClick={() => {
                  setMenuOpen(false);
                  onCalibrate();
                }}
              >
                <span>Calibrate</span>
              </button>

              {!isReadOnly() && (
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown__item"
                  onClick={() => {
                    setMenuOpen(false);
                    onAdmin();
                  }}
                >
                  <span>Add songs</span>
                </button>
              )}

              {/* Offline tracks accumulate silently — a full library is well
                  over 100MB — so there has to be a way to see and drop them
                  that is not "clear site data" in browser settings. Hidden
                  entirely when nothing is stored, rather than offering to
                  delete nothing. */}
              {offlineBytes !== null && offlineBytes > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown__item"
                  onClick={() => {
                    void clearOfflineTracks().then((cleared) => {
                      if (cleared) setOfflineBytes(0);
                      setMenuOpen(false);
                    });
                  }}
                >
                  <span>Clear offline songs</span>
                  <span className="dropdown__state">{formatBytes(offlineBytes)}</span>
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
              <button type="button" className="btn btn--primary" onClick={onAdmin}>
                Add your first song
              </button>
            </>
          )}
        </div>
      )}

      {songs && songs.length > 0 && (
        <div className="menu__body">
          <div className="song-column">
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

            <div className="song-tools">
              <label className="song-tools__sort">
                <span className="muted small">Sort</span>
                <select
                  className="admin__select"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SongSort)}
                >
                  {MENU_SORTS.map((option) => (
                    <option key={option} value={option}>
                      {SONG_SORT_LABELS[option]}
                    </option>
                  ))}
                </select>
              </label>

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
                {filtered.map((song) => (
                  // `position: relative` so the star can sit over the card.
                  // It cannot go *inside* the card: that is a <button>, and a
                  // button inside a button is invalid and breaks activation.
                  <li key={song.songId} className="song-row">
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
                        setFavorites(getFavorites());
                      }}
                    >
                      <Star size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
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
                        setSelected(song.songId);
                        // Picking a track is the way back to a dismissed sheet
                        // on mobile — the only one, deliberately, since it is
                        // also the reason you would want it back.
                        setSheetOpen(true);
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
                          {song.artist || 'Unknown'} · {formatDuration(song.duration)} ·{' '}
                          {song.bpm} BPM
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <aside className={`menu__detail ${sheetOpen ? '' : 'menu__detail--hidden'}`}>
            {selectedSong && (
              <>
                {/* Mobile only — on desktop this is a column, not a sheet, and
                    there is nothing to dismiss. Hidden by CSS above 860px
                    rather than conditionally rendered, so the markup does not
                    depend on a width the component would have to measure. */}
                <button
                  type="button"
                  className="menu__detail-close"
                  aria-label="Hide song details"
                  onClick={() => setSheetOpen(false)}
                >
                  <ChevronDown size={20} aria-hidden />
                </button>

                <h2>{selectedSong.title}</h2>
                <p className="muted">{selectedSong.artist || 'Unknown artist'}</p>

                {selectedSong.bpmConfidence < 0.5 && (
                  <p className="warning">
                    Low tempo confidence ({selectedSong.bpmConfidence.toFixed(2)}) — the beat grid
                    may be off for this track.
                  </p>
                )}

                <div className="difficulty-picker">
                  {DIFFICULTY_NAMES.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`difficulty ${difficulty === name ? 'difficulty--active' : ''} difficulty--${name}`}
                      onClick={() => setDifficulty(name)}
                    >
                      <span className="difficulty__name">{name}</span>
                      <span className="difficulty__lanes">{DIFFICULTIES[name].laneCount} lanes</span>
                      <span className="difficulty__notes">
                        {selectedSong.noteCounts[name] ?? 0} notes
                      </span>
                    </button>
                  ))}
                </div>

                {best && (
                  <div className="best-score">
                    <span className={`grade grade--${best.grade}`}>{best.grade}</span>
                    <div>
                      <div className="best-score__value">{best.score.toLocaleString()}</div>
                      <div className="muted small">
                        {(best.accuracy * 100).toFixed(1)}% · {best.maxCombo}x combo
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  className="btn btn--primary btn--large"
                  disabled={noteCount === 0}
                  onClick={() => onPlay(selectedSong.songId, difficulty)}
                >
                  {noteCount === 0 ? 'No chart for this difficulty' : 'Play'}
                </button>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/** MB is the only unit that matters here — a single track is already ~5MB. */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

import type { Job, SongSummary, Theme } from '@tap-tap/shared';
import {
  BUILTIN_THEMES,
  CHART_VERSION,
  DIFFICULTY_NAMES,
  isJobFinished,
  themeCatalog,
} from '@tap-tap/shared';
import {
  ArrowLeft,
  Check,
  Eraser,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Palette,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import {
  deleteSong as apiDeleteSong,
  clearFinishedJobs,
  listJobs,
  listCustomThemes,
  listSongs,
  regenerateCharts,
  renameSong,
  setSongTheme,
  startIngest,
} from '../data/index.js';
import { isNativePlatform } from '../data/index.js';
import { SongActions } from '../components/SongActions.js';
import { ThemePicker } from '../components/ThemePicker.js';
import {
  SONG_SORTS,
  SONG_SORT_LABELS,
  type SongSort,
  filterSongs,
  paginate,
  sortSongs,
} from '../songSearch.js';
import { evictSongMedia } from '../pwa.js';
import { forgetSong } from '../storage.js';

interface Draft {
  songId: string;
  title: string;
  artist: string;
}

/** Total notes across every difficulty — the one number a rebuild has to move. */
function totalNotes(song: SongSummary): number {
  return DIFFICULTY_NAMES.reduce((sum, d) => sum + (song.noteCounts[d] ?? 0), 0);
}

interface RegenRow {
  songId: string;
  title: string;
  before: number;
  after: number;
}

/**
 * What a regenerate actually did, kept on screen until dismissed.
 *
 * The button used to say nothing at all on success: the progress chip vanished
 * and that was the entire confirmation. Regeneration reads cached analysis and
 * is ~0.4ms of chart prep per song, so a whole library can flash past in under a
 * second and look exactly like a no-op — which is what was reported. A toast
 * reading "Done" would not have answered the real doubt ("did the beatmaps
 * change?"), so this reports evidence instead: note counts before and after,
 * per song, which cannot both be shown and be false.
 */
interface RegenReport {
  at: number;
  total: number;
  before: number;
  after: number;
  changed: RegenRow[];
  failed: string[];
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

interface AdminScreenProps {
  onBack: () => void;
  onEdit: (songId: string) => void;
  onThemes: () => void;
}

const SONGS_PER_PAGE = 10;


export function AdminScreen({ onBack, onEdit, onThemes }: AdminScreenProps): JSX.Element {
  const [url, setUrl] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [catalog, setCatalog] = useState<readonly Theme[]>(BUILTIN_THEMES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SongSort>('title');
  const [page, setPage] = useState(1);
  /**
   * Bulk-regenerate progress, or null when idle. Snapshotted from `songs` when
   * it starts, so the concurrent poll cannot change the set mid-run.
   */
  const [regen, setRegen] = useState<{
    done: number;
    total: number;
    failed: string[];
    message: string;
  } | null>(null);
  const [report, setReport] = useState<RegenReport | null>(null);

  // Derived during render rather than mirrored into state — keeping a second
  // copy in sync with songs/query/sort is exactly how filtered lists go stale.
  const visible = sortSongs(filterSongs(songs, query), sort);
  // `paginate` clamps, so a page that stops existing — because a song was
  // deleted, or the poll returned a shorter list — corrects itself on the next
  // render instead of stranding the view on an empty page.
  const shown = paginate(visible, page, SONGS_PER_PAGE);

  // Derived from the shared "finished" rule rather than a local list of active
  // statuses: a new in-progress status is then active by default, instead of
  // silently falling through and stopping the fast poll.
  const hasActive = jobs.some((job) => !isJobFinished(job.status));
  const finishedCount = jobs.filter((job) => isJobFinished(job.status)).length;
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  refreshRef.current = async (): Promise<void> => {
    // Themes come along on every refresh so a palette created on the themes
    // page shows up in these dropdowns without a reload.
    const [nextJobs, nextSongs, nextThemes] = await Promise.all([
      listJobs(),
      listSongs(),
      listCustomThemes().catch(() => []),
    ]);
    setJobs(nextJobs);
    setSongs(nextSongs);
    setCatalog(themeCatalog(nextThemes));
  };

  // Initial load, plus polling only while something is actually running.
  useEffect(() => {
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        if (!cancelled) await refreshRef.current();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), hasActive ? 1200 : 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasActive]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!url.trim() || busy) return;

    setBusy(true);
    setError(null);
    try {
      const job = await startIngest(url.trim());
      setJobs((current) => [job, ...current]);
      setUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async (): Promise<void> => {
    if (!draft || draft.title.trim().length === 0) return;
    try {
      await renameSong(draft.songId, draft.title.trim(), draft.artist.trim());
      setDraft(null);
      await refreshRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Rebuild every song's charts, one at a time.
   *
   * A client-side loop over the existing per-song endpoint rather than a new
   * bulk route: it reuses code that is already tested, and — more usefully — it
   * can report live progress and keep going when a single song fails, instead
   * of one bad `analysis.json` aborting the whole run. Sequential on purpose;
   * regeneration can decode audio to rebuild a missing waveform, and firing 29
   * of those at once would swamp the machine for no gain locally.
   */
  const regenerateAll = async (): Promise<void> => {
    if (regen) return; // already running
    // Snapshot now: the background poll rewrites `songs`, and the run must
    // operate on a stable set. It is also the "before" side of the report —
    // taken from what was on screen when the button was pressed.
    const batch = [...songs];
    if (batch.length === 0) return;
    if (
      !window.confirm(
        `Regenerate charts for all ${batch.length} songs? This rebuilds every chart, re-analyses ` +
          `any song whose analysis predates the current analyser (seconds each, once), and makes ` +
          `existing high scores no longer comparable. Hand edits are preserved.`,
      )
    ) {
      return;
    }

    setError(null);
    setReport(null);
    const failed: string[] = [];
    const changed: RegenRow[] = [];
    let before = 0;
    let after = 0;
    setRegen({ done: 0, total: batch.length, failed, message: '' });

    for (let i = 0; i < batch.length; i++) {
      const song = batch[i]!;
      try {
        // `deep` here and not in the self-heal: this is where a repair that
        // costs a decode is visible, interruptible by the user's own eyes, and
        // reported. Progress comes back per stage so a song that really is
        // re-analysing does not look like a hung button.
        const updated = await regenerateCharts(song.songId, {
          deep: true,
          onProgress: (message) =>
            setRegen((current) => (current ? { ...current, message } : current)),
        });
        const wasNotes = totalNotes(song);
        const nowNotes = totalNotes(updated);
        before += wasNotes;
        after += nowNotes;
        if (wasNotes !== nowNotes) {
          changed.push({ songId: song.songId, title: song.title, before: wasNotes, after: nowNotes });
        }
      } catch {
        failed.push(song.title);
      }
      setRegen({ done: i + 1, total: batch.length, failed: [...failed], message: '' });
    }

    await refreshRef.current();
    setRegen(null);
    setReport({ at: Date.now(), total: batch.length - failed.length, before, after, changed, failed });
  };

  /** One song, same reporting — a silent success is the defect either way. */
  const regenerateOne = async (song: SongSummary): Promise<void> => {
    if (regen) return; // a bulk run owns the progress chip
    setError(null);
    setReport(null);
    // Shares the bulk run's chip rather than inventing a second busy state. A
    // deep single regenerate can decode and re-analyse for seconds, and doing
    // that behind a row menu with no indicator at all is the same "it says it
    // did something and shows nothing" this change exists to fix.
    setRegen({ done: 0, total: 1, failed: [], message: '' });
    try {
      const updated = await regenerateCharts(song.songId, {
        deep: true,
        onProgress: (message) =>
          setRegen((current) => (current ? { ...current, message } : current)),
      });
      const wasNotes = totalNotes(song);
      const nowNotes = totalNotes(updated);
      setReport({
        at: Date.now(),
        total: 1,
        before: wasNotes,
        after: nowNotes,
        changed:
          wasNotes === nowNotes
            ? []
            : [{ songId: song.songId, title: song.title, before: wasNotes, after: nowNotes }],
        failed: [],
      });
      await refreshRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegen(null);
    }
  };

  return (
    <div className="admin">
      <header className="admin__header">
        <h1>Song library</h1>
        <div className="admin__header-actions">
          <button type="button" className="btn btn--ghost" onClick={onThemes}>
            <Palette size={16} aria-hidden />
            Themes
          </button>
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden />
            Back
          </button>
        </div>
      </header>

      {/* On device, ingest is the synchronous + button on the menu (the native
          plugin, not a server job queue), so the URL form is hidden here and
          this screen is purely library management. */}
      {!isNativePlatform() && (
        <form className="admin__form" onSubmit={(e) => void submit(e)}>
          <input
            className="admin__input"
            type="text"
            placeholder="Paste a YouTube link…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" className="btn btn--primary" disabled={busy || !url.trim()}>
            {busy ? (
              <Loader2 size={16} className="spin" aria-hidden />
            ) : (
              <Download size={16} aria-hidden />
            )}
            {busy ? 'Starting…' : 'Analyze'}
          </button>
        </form>
      )}

      {error && <p className="error-text">{error}</p>}

      {report && (
        <section className="admin__section">
          <div className="admin__section-head">
            <h2>
              Rebuilt {report.total} song{report.total === 1 ? '' : 's'}
            </h2>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setReport(null)}
            >
              <X size={15} aria-hidden />
              Dismiss
            </button>
          </div>
          <p className="muted small">
            {report.before.toLocaleString()} → {report.after.toLocaleString()} notes (
            {signed(report.after - report.before)}) · chart rules v{CHART_VERSION} ·{' '}
            {new Date(report.at).toLocaleTimeString()}
          </p>
          {report.changed.length > 0 ? (
            <ul className="job-list">
              {report.changed.slice(0, 12).map((row) => (
                <li key={row.songId} className="job job--done">
                  <span className="job__status">{signed(row.after - row.before)}</span>
                  <span className="job__message">{row.title}</span>
                  <span className="job__url">
                    {row.before} → {row.after} notes
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            /* Not a failure, and saying so matters: rebuilding a chart the
               generator already agrees with is a no-op by construction. */
            <p className="muted small">
              Every chart rebuilt to the same note count — the generator already agreed with what
              was stored.
            </p>
          )}
          {report.changed.length > 12 && (
            <p className="muted small">…and {report.changed.length - 12} more changed.</p>
          )}
          <p className="warning small">
            <TriangleAlert size={14} aria-hidden />
            Stored best scores were earned on the previous charts and are no longer comparable.
          </p>
          {report.failed.length > 0 && (
            <p className="error-text">
              {report.failed.length} failed: {report.failed.join(', ')}.
            </p>
          )}
        </section>
      )}

      {jobs.length > 0 && (
        <section className="admin__section">
          <div className="admin__section-head">
            <h2>Jobs</h2>
            {finishedCount > 0 && (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  void clearFinishedJobs()
                    .then(() => refreshRef.current())
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err.message : String(err)),
                    );
                }}
              >
                <Eraser size={15} aria-hidden />
                Clear finished ({finishedCount})
              </button>
            )}
          </div>
          <ul className="job-list">
            {jobs.slice(0, 8).map((job) => (
              <li key={job.id} className={`job job--${job.status}`}>
                <span className="job__status">{job.status}</span>
                <span className="job__message">{job.error ?? job.message}</span>
                <span className="job__url">{job.url}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="admin__section">
        <div className="admin__section-head">
          {/* Shows both numbers while filtering, so a short list reads as "the
              search is narrow" rather than "songs went missing". */}
          <h2>
            Songs ({query.trim() ? `${visible.length} of ${songs.length}` : songs.length})
          </h2>

          {songs.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={regen !== null}
              onClick={() => void regenerateAll()}
            >
              {regen ? (
                <>
                  <Loader2 size={15} className="spin" aria-hidden />
                  {regen.message
                    ? `${regen.message} (${regen.done}/${regen.total})`
                    : `Regenerating ${regen.done}/${regen.total}…`}
                </>
              ) : (
                <>
                  <RefreshCw size={15} aria-hidden />
                  Regenerate all
                </>
              )}
            </button>
          )}
        </div>

        {songs.length > 0 && (
          <div className="admin__tools">
            <div className="search search--with-icon">
              <Search size={16} className="search__icon" aria-hidden />
              <input
                type="search"
                className="search__input"
                placeholder="Search songs…"
                value={query}
                // Reset to page 1 here rather than in an effect. Clamping alone
                // is not enough: narrowing from page 3 to a two-page result
                // would land on page 2, which is not where anyone expects a
                // fresh search to start.
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('');
                    setPage(1);
                  }
                }}
              />
            </div>
            <label className="admin__sort">
              <span className="muted small">Sort</span>
              <select
                className="admin__select"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as SongSort);
                  setPage(1);
                }}
              >
                {SONG_SORTS.map((option) => (
                  <option key={option} value={option}>
                    {SONG_SORT_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {songs.length === 0 && <p className="muted">Nothing ingested yet.</p>}
        {songs.length > 0 && visible.length === 0 && (
          <p className="muted">No songs match “{query.trim()}”.</p>
        )}
        <ul className="admin-song-list">
          {shown.items.map((song) => {
            const editing = draft && draft.songId === song.songId ? draft : null;

            if (editing) {
              return (
                <li key={song.songId} className="admin-song">
                  <form
                    className="admin-song__edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveRename();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setDraft(null);
                    }}
                  >
                    <input
                      className="admin__input admin__input--small"
                      value={editing.title}
                      placeholder="Title"
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      onChange={(e) => setDraft({ ...editing, title: e.target.value })}
                    />
                    <input
                      className="admin__input admin__input--small"
                      value={editing.artist}
                      placeholder="Artist"
                      onChange={(e) => setDraft({ ...editing, artist: e.target.value })}
                    />
                    <div className="admin-song__actions">
                      <button
                        type="submit"
                        className="btn btn--primary btn--small"
                        disabled={editing.title.trim().length === 0}
                      >
                        <Check size={15} aria-hidden />
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => setDraft(null)}
                      >
                        <X size={15} aria-hidden />
                        Cancel
                      </button>
                    </div>
                  </form>
                </li>
              );
            }

            return (
              <li key={song.songId} className="admin-song">
                <div className="admin-song__main">
                  <div className="admin-song__title">{song.title}</div>
                  <div className="muted small">
                    {song.artist || 'Unknown'} · {Math.round(song.bpm)} BPM · confidence{' '}
                    {song.bpmConfidence.toFixed(2)} ·{' '}
                    {DIFFICULTY_NAMES.map((d) => `${d} ${song.noteCounts[d] ?? 0}`).join(' · ')}
                  </div>
                  {song.bpmConfidence < 0.5 && (
                    <div className="warning small">
                      <TriangleAlert size={14} aria-hidden />
                      Low confidence — the detected tempo is probably wrong.
                    </div>
                  )}
                  <ThemePicker
                    value={song.themeId}
                    catalog={catalog}
                    onChange={(themeId) => {
                      void setSongTheme(song.songId, themeId)
                        .then(() => refreshRef.current())
                        .catch((err: unknown) =>
                          setError(err instanceof Error ? err.message : String(err)),
                        );
                    }}
                  />
                </div>
                <SongActions
                  title={song.title}
                  onEdit={() => onEdit(song.songId)}
                  onRename={() =>
                    setDraft({
                      songId: song.songId,
                      title: song.title,
                      artist: song.artist,
                    })
                  }
                  onRegenerate={() => void regenerateOne(song)}
                  onDelete={() => {
                    void apiDeleteSong(song.songId)
                      .then(() => {
                        // Server removed the files; clear this device's residue
                        // too — scores/favorite/last-selected, and the cached
                        // audio — so nothing survives the song it belonged to.
                        forgetSong(song.songId);
                        void evictSongMedia(song.songId);
                        refreshRef.current();
                      })
                      .catch((err: unknown) =>
                        setError(err instanceof Error ? err.message : String(err)),
                      );
                  }}
                />
              </li>
            );
          })}
        </ul>

        {/* Hidden when everything fits — controls that can only ever say
            "Page 1 of 1" are noise. */}
        {shown.pageCount > 1 && (
          <nav className="pager" aria-label="Song list pages">
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setPage(shown.page - 1)}
              disabled={shown.page === 1}
            >
              <ChevronLeft size={15} aria-hidden />
              Previous
            </button>

            <span className="muted small" aria-live="polite">
              {shown.from}–{shown.to} of {visible.length}
            </span>

            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setPage(shown.page + 1)}
              disabled={shown.page === shown.pageCount}
            >
              Next
              <ChevronRight size={15} aria-hidden />
            </button>
          </nav>
        )}
      </section>
    </div>
  );
}

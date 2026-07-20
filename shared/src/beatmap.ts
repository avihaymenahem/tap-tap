/**
 * The wire contract between the ingest server and the game.
 *
 * This file is the single source of truth. Both workspaces import it, so the
 * server cannot emit a shape the game does not expect.
 */

export const BEATMAP_VERSION = 1;

export type DifficultyName = 'easy' | 'medium' | 'hard';

export const DIFFICULTY_NAMES: readonly DifficultyName[] = ['easy', 'medium', 'hard'];

export type NoteType = 'tap' | 'hold';

export interface Note {
  /** Seconds from the start of the audio. */
  t: number;
  /** 0-indexed, left to right. */
  lane: number;
  type: NoteType;
  /**
   * Seconds. Present only on holds; the note ends at `t + duration`.
   *
   * Optional rather than a separate note type or a parallel array, so every
   * beatmap written before holds existed stays valid unchanged and
   * `BEATMAP_VERSION` does not move. A chart without holds is simply one where
   * no note carries a duration, and a library part-way through regeneration is
   * not a broken one.
   */
  duration?: number;
}

/** True for a hold with a usable length. Guards against `duration: 0` or a stray flag. */
export function isHold(note: Note): boolean {
  return note.type === 'hold' && typeof note.duration === 'number' && note.duration > 0;
}

/** When the note stops mattering: its tail for a hold, its own time for a tap. */
export function noteEnd(note: Note): number {
  return isHold(note) ? note.t + (note.duration as number) : note.t;
}

export interface Chart {
  laneCount: number;
  /** Sorted ascending by `t`. The judge relies on this ordering. */
  notes: Note[];
}

export interface Beatmap {
  version: number;
  songId: string;
  title: string;
  artist: string;
  /** Seconds. */
  duration: number;
  audioUrl: string;
  thumbnailUrl: string | null;

  /**
   * Set once the title or artist has been edited by hand. Re-ingesting or
   * re-analyzing a song refetches its YouTube metadata, which would otherwise
   * silently revert a rename.
   */
  customName?: boolean;

  /**
   * Id into `THEMES`. Absent on everything ingested before themes existed, and
   * absence is not an error — `themeFor` resolves it to `DEFAULT_THEME`, which
   * is the palette those songs already render with.
   */
  themeId?: string;

  bpm: number;
  /** 0..1. Below ~0.5 the beat grid is probably wrong — the admin UI warns. */
  bpmConfidence: number;
  /** Seconds. One entry per detected beat. */
  beatGrid: number[];

  charts: Record<DifficultyName, Chart>;
}

/** Listing payload: everything except the (large) note arrays. */
export interface SongSummary {
  songId: string;
  title: string;
  artist: string;
  duration: number;
  bpm: number;
  bpmConfidence: number;
  thumbnailUrl: string | null;
  noteCounts: Record<DifficultyName, number>;
  /** Carried so admin can show the current theme without fetching each beatmap. */
  themeId?: string;
  /**
   * Carried on the summary so the menu can start warming the audio into the
   * HTTP cache the moment a song is selected, rather than waiting for the play
   * screen to fetch the full beatmap first.
   */
  audioUrl: string;
}

// --- analysis intermediate -------------------------------------------------

/**
 * One detected onset. Cached to disk so charts can be regenerated with new
 * difficulty parameters without re-downloading or re-analyzing the audio.
 */
export interface Onset {
  /** Seconds. */
  t: number;
  /** 0..1, normalized across the song. Used to rank which notes survive. */
  strength: number;
  /**
   * Relative band prominence at the onset. Sums to 1. Drives lane assignment.
   *
   * These are each band's energy divided by that band's typical level across
   * the track — "how unusually loud is this band right now", not "how loud".
   * Raw shares would just describe the mix, and a bright or bass-heavy master
   * would push every note into a single lane.
   */
  low: number;
  mid: number;
  high: number;
}

export interface AnalysisResult {
  duration: number;
  bpm: number;
  bpmConfidence: number;
  beatGrid: number[];
  onsets: Onset[];
}

/**
 * Downsampled amplitude envelope for the editor timeline.
 *
 * Computed once at ingest and cached: decoding a four-minute track client-side
 * just to draw a waveform would stall the editor every time it opened.
 */
export interface Waveform {
  /** Seconds each peak covers. */
  secondsPerPeak: number;
  /** Peak absolute amplitude per bucket, 0..1. */
  peaks: number[];
}

// --- ingest jobs -----------------------------------------------------------

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'transcoding'
  | 'analyzing'
  | 'generating'
  | 'done'
  | 'error';

/**
 * Terminal states — the job is over, one way or the other.
 *
 * Defined here rather than on either side because both need it and they must
 * agree: the server refuses to clear anything still running, and the admin UI
 * decides from the same rule whether clearing is even offered. Expressing
 * "finished" once also means a new in-progress status is automatically treated
 * as active everywhere, instead of silently falling through as inert.
 */
export const FINISHED_JOB_STATUSES: readonly JobStatus[] = ['done', 'error'];

export function isJobFinished(status: JobStatus): boolean {
  return FINISHED_JOB_STATUSES.includes(status);
}

export interface Job {
  id: string;
  url: string;
  songId: string | null;
  status: JobStatus;
  /** Human-readable progress line for the admin UI. */
  message: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

import type { CSSProperties, JSX } from 'react';
import { accentVars } from '../accent.js';

/**
 * The one stage behind every non-gameplay screen: a near-black field, a sparse
 * starfield, an accent-tinted pool overhead, drifting embers and a soft
 * vignette — the DOM twin of the play screen's own backdrop, so the song list,
 * the hero and the scorecard all sit in the same room as the run between them.
 *
 * Pure CSS and no assets. It is one fixed layer shared by every screen rather
 * than a per-screen background, so nothing jumps as the player moves between the
 * menu, the results card and calibration.
 *
 * The play screen does NOT use this: it renders its own stage in three.js.
 *
 * **The neon city skyline was removed** — see the note in styles.css where its
 * rule used to be. It rendered on exactly one player-facing screen and put a
 * skyline under a scorecard whose run had just happened on a near-black
 * highway; AAA-REF §9 asks for the opposite.
 *
 * (Kept the `RetroBackdrop` name and `.retro-bg` classes to avoid churning every
 * screen that references them.)
 */
interface RetroBackdropProps {
  /**
   * Pulls the scene back so it stops competing with dense content — the admin
   * library is rows of small text and icon buttons stacked edge to edge.
   */
  dim?: boolean;
  /**
   * Recolour the glow to a song's theme accent. The results screen passes the
   * finished run's accent so the light behind the card matches the card — the
   * same palette continuity the card itself already keeps. Omitted elsewhere,
   * where the default electric pink is right.
   */
  accent?: number;
}

export function RetroBackdrop({ dim = false, accent }: RetroBackdropProps): JSX.Element {
  const style = accent !== undefined ? (accentVars(accent) as CSSProperties) : undefined;
  const cls = ['retro-bg', dim ? 'retro-bg--dim' : '', accent !== undefined ? 'retro-bg--accent' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} aria-hidden="true" style={style}>
      <div className="retro-bg__glow" />
      <div className="retro-bg__sparks" />
      <div className="retro-bg__scrim" />
    </div>
  );
}

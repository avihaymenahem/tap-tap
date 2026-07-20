import type { JSX } from 'react';

/**
 * The 80s sunset that sits behind every non-gameplay screen: striped sun,
 * star field, scrolling perspective grid.
 *
 * Pure CSS and no assets. It is one fixed layer shared by every screen rather
 * than a per-screen background so the sun does not jump when the player moves
 * between the menu, the results card and calibration — the whole app reads as
 * one continuous place.
 *
 * The play screen does NOT use this: it renders its own sunset in three.js on
 * the highway's backdrop plane, and two suns at different scales would fight.
 */
interface RetroBackdropProps {
  /**
   * Pulls the scene back so it stops competing with dense content. The admin
   * library is rows of small text and icon buttons stacked edge to edge; at
   * full strength the sun lands in the middle of the toolbar and reads as a
   * blob rather than as scenery.
   */
  dim?: boolean;
}

export function RetroBackdrop({ dim = false }: RetroBackdropProps): JSX.Element {
  return (
    <div className={`retro-bg ${dim ? 'retro-bg--dim' : ''}`} aria-hidden="true">
      <div className="retro-bg__stars" />
      <div className="retro-bg__sun" />
      <div className="retro-bg__horizon" />
      <div className="retro-bg__grid" />
      <div className="retro-bg__scrim" />
    </div>
  );
}

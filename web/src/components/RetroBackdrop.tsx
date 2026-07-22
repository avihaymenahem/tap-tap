import type { CSSProperties, JSX } from 'react';
import { accentVars } from '../accent.js';

/**
 * The dark "stage" backdrop behind every non-gameplay screen: a warm gold glow
 * pooled overhead, drifting ember sparks, and a soft vignette — the same vibe as
 * the in-game highway (dark scene, gold light, firework), so the whole app reads
 * as one continuous place.
 *
 * Pure CSS and no assets. It is one fixed layer shared by every screen rather
 * than a per-screen background, so nothing jumps as the player moves between the
 * menu, the results card and calibration.
 *
 * The play screen does NOT use this: it renders its own stage in three.js.
 *
 * (Kept the `RetroBackdrop` name and `.retro-bg` classes to avoid churning every
 * screen that references them; the look is the stage redesign.)
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
   * where the default gold is right.
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

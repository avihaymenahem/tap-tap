import type { CSSProperties } from 'react';

/**
 * CSS variable overrides that repaint a screen in a theme's accent colour.
 *
 * The shell is gold by default; spreading these on the ready and results roots
 * recolours everything that keys off the accent (`rgba(var(--accent-rgb) …)`
 * glows plus the `--gold` / `--pink` / `--violet` family) to the playing song's
 * theme, so the palette carries continuously from the track through the run and
 * into the scorecard.
 */
export function accentVars(accent: number): CSSProperties {
  const r = (accent >> 16) & 0xff;
  const g = (accent >> 8) & 0xff;
  const b = accent & 0xff;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const mix = (t: number): string =>
    `#${hex(Math.round(r + (255 - r) * t))}${hex(Math.round(g + (255 - g) * t))}${hex(Math.round(b + (255 - b) * t))}`;
  const shade = (t: number): string =>
    `#${hex(Math.round(r * t))}${hex(Math.round(g * t))}${hex(Math.round(b * t))}`;

  const base = `#${hex(r)}${hex(g)}${hex(b)}`;
  return {
    '--accent-rgb': `${r}, ${g}, ${b}`,
    '--gold': base,
    '--gold-bright': mix(0.4),
    '--pink': base,
    '--violet': shade(0.62),
    '--amber': shade(0.7),
  } as CSSProperties;
}

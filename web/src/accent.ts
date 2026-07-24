import type { CSSProperties } from 'react';

/**
 * CSS variable overrides that repaint a screen in a theme's accent colour.
 *
 * Spreading these on the ready and results roots recolours everything that keys
 * off the accent (`rgba(var(--accent-rgb) …)` glows plus the `--pink` /
 * `--violet` / `--amber` family) to the playing song's theme, so the palette
 * carries continuously from the track through the run and into the scorecard.
 *
 * `--gold` is deliberately NOT overridden: in the neon-arcade design gold is
 * fixed metallic trim (bezels, frames), not the accent — the frames must stay
 * gold on a pink or cyan song, or the chrome reads as recoloured plastic. Only
 * the glow family follows the song.
 */
export function accentVars(accent: number): CSSProperties {
  const r = (accent >> 16) & 0xff;
  const g = (accent >> 8) & 0xff;
  const b = accent & 0xff;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const shade = (t: number): string =>
    `#${hex(Math.round(r * t))}${hex(Math.round(g * t))}${hex(Math.round(b * t))}`;

  const base = `#${hex(r)}${hex(g)}${hex(b)}`;
  return {
    '--accent-rgb': `${r}, ${g}, ${b}`,
    '--pink': base,
    '--violet': shade(0.62),
    '--amber': shade(0.7),
  } as CSSProperties;
}

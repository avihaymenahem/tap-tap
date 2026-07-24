import type { JSX } from 'react';

/**
 * A flicker of electric arcs, overlaid on a neon element (the selected
 * difficulty chip, the PLAY button, a primary action). Pure SVG + CSS: a few
 * pre-drawn jagged bolts whose visibility is stepped by a keyframe, so the
 * flicker costs no JS and no per-frame work. Kept to ≤3 instances on screen at
 * once — the `drop-shadow` glow is the only expensive part.
 *
 * It is decoration and `aria-hidden`; the parent must be `position: relative`
 * and the arcs are `pointer-events: none` so they never eat a tap. The stroke
 * is `rgb(var(--accent-rgb))`, so it follows the screen's accent for free, and
 * the whole thing is disabled under `prefers-reduced-motion` (see styles.css).
 */
export function ElectricArcs(): JSX.Element {
  return (
    <svg
      className="arcs"
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline className="arcs__bolt arcs__bolt--a" points="2,20 18,12 30,26 46,10 60,24 76,14 98,22" />
      <polyline className="arcs__bolt arcs__bolt--b" points="2,22 16,30 32,16 48,30 62,14 80,28 98,18" />
      <polyline className="arcs__bolt arcs__bolt--c" points="4,18 20,24 34,10 50,22 66,30 82,16 96,26" />
    </svg>
  );
}

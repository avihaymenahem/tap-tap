/**
 * Auto-assign a theme to a freshly ingested song.
 *
 * Before this, every new track kept the default theme unless someone opened
 * admin and picked one by hand — so in practice the whole library rendered in
 * one palette. Ingest now assigns a theme automatically: it samples the album
 * cover's dominant colour and picks the built-in theme whose accent is the
 * closest match, so a red cover gets Inferno and a green one gets Toxic. With
 * no cover (or a colourless one) it falls back to a random theme, which is
 * still far better than everything landing on the default.
 *
 * The colour maths lives here, pure and unit-tested; the DOM-bound cover decode
 * (canvas) stays in `ingest.ts`.
 */

import type { Theme } from '@tap-tap/shared';
import { DEFAULT_ACCENT } from '@tap-tap/shared';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsv {
  /** Hue in degrees, [0, 360). Undefined-ish (0) for greys. */
  h: number;
  /** Saturation, [0, 1]. */
  s: number;
  /** Value, [0, 1]. */
  v: number;
}

/** Below this saturation a colour reads as neutral grey, with no meaningful hue. */
const NEUTRAL_SAT = 0.16;

function accentRgb(theme: Theme): Rgb {
  const hex = theme.accent ?? DEFAULT_ACCENT;
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** Shortest distance between two hues on the colour wheel, in degrees [0, 180]. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The dominant colour of an image, as a saturation-weighted average of its
 * pixels. A plain average of a whole cover muddies to grey/brown; weighting by
 * saturation lets the few vivid pixels (the artwork's real accent) dominate, so
 * the result actually carries the cover's identity. `pixels` is RGBA, as from
 * `CanvasRenderingContext2D.getImageData().data`.
 */
export function dominantColor(pixels: Uint8ClampedArray | number[]): Rgb {
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let wsum = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 8) continue; // skip transparent pixels
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const { s, v } = rgbToHsv({ r, g, b });
    // Weight by saturation × value: vivid, bright pixels carry the palette;
    // a small +0.05 floor keeps a fully greyscale cover from summing to zero.
    const w = s * v + 0.05;
    wr += r * w;
    wg += g * w;
    wb += b * w;
    wsum += w;
  }
  if (wsum === 0) return { r: 128, g: 128, b: 128 };
  return { r: wr / wsum, g: wg / wsum, b: wb / wsum };
}

/**
 * Pick the theme whose accent best matches a target colour.
 *
 * Vivid targets match by hue (the accents are all vivid, so hue is what tells
 * them apart; a dark-red cover should still find red Inferno even though its
 * value is far lower). A near-grey target instead picks the least-saturated
 * accent — the greyscale theme — rather than snapping to a random hue.
 */
export function nearestThemeByColor(themes: readonly Theme[], target: Rgb): string {
  if (themes.length === 0) throw new Error('nearestThemeByColor: no themes');
  const t = rgbToHsv(target);
  let best = themes[0];
  let bestScore = Infinity;
  for (const theme of themes) {
    const a = rgbToHsv(accentRgb(theme));
    let score: number;
    if (t.s < NEUTRAL_SAT) {
      // Neutral cover → prefer the greyest accent (the mono theme).
      score = a.s;
    } else {
      // Vivid cover → match by hue. A grey accent (mono) has hue 0, which would
      // spuriously "match" a red cover; push near-grey accents out of contention
      // so a coloured cover never resolves to the greyscale theme.
      score = hueDistance(t.h, a.h) + (a.s < NEUTRAL_SAT ? 1000 : 0);
    }
    if (score < bestScore) {
      bestScore = score;
      best = theme;
    }
  }
  return best.id;
}

/** A random theme id, used when there is no cover to match against. */
export function randomThemeId(themes: readonly Theme[], rand: () => number = Math.random): string {
  if (themes.length === 0) throw new Error('randomThemeId: no themes');
  const i = Math.min(themes.length - 1, Math.floor(rand() * themes.length));
  return themes[i].id;
}

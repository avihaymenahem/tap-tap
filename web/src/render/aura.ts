/**
 * The song aura — a reactive, recolouring particle halo that hugs the album
 * disc on the menu hero and the results ceremony (the Beatstar "alive" look).
 *
 * This module is the *pure* half: turning a song's accent colour into an RGB
 * triple, a hue, and a chosen visual style. The canvas animation that consumes
 * it lives in `components/SongAura.tsx` — kept separate so the colour/variant
 * decisions are unit-testable with no canvas, the same split `eqRing.ts` uses.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Split a 0xRRGGBB accent into its channels. */
export function rgbFromAccent(accent: number): Rgb {
  return { r: (accent >> 16) & 0xff, g: (accent >> 8) & 0xff, b: accent & 0xff };
}

/**
 * Hue in degrees [0, 360). Saturation-independent, so a near-grey accent still
 * returns a defined angle (0) rather than NaN — the caller decides what a washed
 * colour should do, this never hands back a hole.
 */
export function hueOf({ r, g, b }: Rgb): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return 0;

  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;

  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * The three aura styles. One code path in the component drives all three from
 * the preset table below; they differ in feel, not machinery:
 *  - `ember`  warm sparks that rise and flicker off the rim (fire songs)
 *  - `burst`  bright light-rays shooting straight outward (the APT starburst)
 *  - `glow`   a smooth pulsing halo with a few drifting shards (cool songs)
 */
export type AuraVariant = 'ember' | 'burst' | 'glow';

/**
 * Pick a style from the accent hue. Warm hues (reds → gold) burn as embers;
 * magenta/pink explodes as a starburst; everything cool (green → violet) gets
 * the smooth glow. Tuned against the reference set: orange→ember, pink→burst,
 * blue→glow, and our default neon pink (#ff3fa4, hue ≈ 329) lands on burst.
 */
export function pickAuraVariant(accent: number): AuraVariant {
  const h = hueOf(rgbFromAccent(accent));
  if (h >= 288 && h < 350) return 'burst'; // magenta / hot pink
  if (h >= 350 || h < 60) return 'ember'; // red → orange → gold
  return 'glow'; // yellow-green → cyan → blue → violet
}

/**
 * Per-variant tuning the canvas reads. Rates are particles/second; speeds,
 * lengths and sizes are in canvas-half-radius units (so the look is
 * resolution-independent). Kept as data so the numbers can be eyeballed and
 * adjusted in one place; the component reads them and draws pre-tinted sprites
 * with a two-pass bloom.
 */
export interface AuraPreset {
  /** Primary particles emitted per second at intensity 1 (rays / embers / motes). */
  spawnRate: number;
  /** Outward radial speed range, in half-radius units per second. */
  speed: [number, number];
  /** Streak length range along travel, in half-radius units (rays are long). */
  length: [number, number];
  /** Base particle width/size, in half-radius units. */
  size: number;
  /** Upward drift (negative y), in half-radius units per second — fire rises. */
  rise: number;
  /** Tangential swirl, in radians per second. */
  swirl: number;
  /** Per-second velocity retained (0.6 = loses 40%/s) — how fast motion damps. */
  drag: number;
  /** Crisp 4-point sparkle stars emitted per second. */
  sparkleRate: number;
  /** Core-ring glow extent behind the disc, as a fraction of half-size. */
  halo: number;
  /** How hard the core breathes: 0 = steady, 1 = strong pulse. */
  pulse: number;
  /** Bloom blur radius (in half-res buffer px) — the neon light-bleed. */
  bloom: number;
}

export const AURA_PRESETS: Record<AuraVariant, AuraPreset> = {
  // Fire: a dense wall of sparks that rise off the rim, flicker, and curl.
  ember: {
    spawnRate: 360,
    speed: [0.05, 0.32],
    length: [0.05, 0.14],
    size: 0.06,
    rise: 0.7,
    swirl: 0.95,
    drag: 0.55,
    sparkleRate: 16,
    halo: 0.55,
    pulse: 0.6,
    bloom: 13,
  },
  // Starburst: long, thin, white-headed light-rays firing clear to the screen
  // edges, plus a storm of sparkle diamonds — the APT look, cranked.
  burst: {
    spawnRate: 250,
    speed: [1.0, 2.6],
    length: [0.6, 1.5],
    size: 0.02,
    rise: 0,
    swirl: 0,
    drag: 0.8,
    sparkleRate: 40,
    halo: 0.46,
    pulse: 0.75,
    bloom: 11,
  },
  // Energy field: a huge breathing halo with bright motes drifting through it
  // and a heavy scatter of twinkles.
  glow: {
    spawnRate: 150,
    speed: [0.05, 0.24],
    length: [0.05, 0.12],
    size: 0.09,
    rise: 0.05,
    swirl: 1.25,
    drag: 0.5,
    sparkleRate: 30,
    halo: 0.95,
    pulse: 1,
    bloom: 17,
  },
};

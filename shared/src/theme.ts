/**
 * Per-song colour palettes.
 *
 * A beatmap stores `themeId`, never the colours themselves. That indirection is
 * the whole point: resolved colours on each beatmap would freeze every song
 * against whatever the palette looked like the day it was ingested, so retuning
 * a theme would mean rewriting every beatmap that used it and a bad theme could
 * never be fixed centrally. An id keeps the palette editable in one place and
 * makes a song's theme a two-word diff.
 *
 * This lives in `shared/` because the id crosses the wire — the server persists
 * and validates it, admin lists the options, the game resolves it to colours.
 */

/**
 * Colours are plain sRGB hex, the numbers a colour picker gives you.
 *
 * The highway shader works in *linear* space and converts on the way in. Do not
 * pre-linearize values here: linear 0.001 does not survive 8 bits per channel,
 * and hand-tuning a palette against tone-mapped linear numbers is how the first
 * ground grid came out near-white.
 */
export interface SkyPalette {
  /** Top of frame. Only ~0.045 of the backdrop's uv is sky, so this is a sliver. */
  top: number;
  /** At the horizon line, behind the sun. */
  horizon: number;
  /** Second horizon stop; treble crossfades between this and `horizon`. */
  horizonAlt: number;
  /** Below eye level, where sky only peeks past the edges of the track. */
  below: number;
  /** The sun at the waterline. */
  sun: number;
  /** The sun's crown. Lighter and less saturated than `sun`. */
  sunCrown: number;
  /**
   * Atmosphere near the horizon: the bloom around the disc and the band where
   * sky meets track. Additive, so it reads as the colour of the air.
   */
  haze: number;
  /**
   * The nebula and the swell at the vanishing point, which pulses with the bass.
   * Usually cooler and deeper than `haze` — it is the far distance, not the sun.
   */
  glow: number;
}

/**
 * Which way the renderer draws the scene.
 *
 * `classic` (the default when unset) is the synthwave highway: a striped sun on
 * the horizon, a neon grid floor, brightly coloured lanes. `stage` is the
 * Beatstar-style look: a near-black stage lit only by a warm glow behind the
 * vanishing point, glowing rails down the track's edges, a dark colourless
 * track where the lane colour shows only on a hit, and the song's cover art
 * ringed at the horizon.
 *
 * It lives on the theme rather than being a global switch because the two looks
 * are meant to coexist — a library can have synthwave songs and stage songs.
 * The renderer branches on it; everything else (persistence, admin, resolution)
 * treats it as an ordinary field.
 */
export type ThemeStyle = 'classic' | 'stage';

export interface Theme {
  id: string;
  /** Shown in admin. */
  name: string;
  /**
   * How the renderer draws the scene. **Absent means `stage`** — the dark,
   * spotlit look every theme now uses. `classic` (the old synthwave sun +
   * neon grid) is kept only as an explicit opt-in; nothing ships with it.
   */
  style?: ThemeStyle;
  /**
   * The theme's bright accent, in stage rendering: the metal note tint, the
   * glowing rails, and the cover-art firework. Unlike the sky palette this is
   * *meant* to be bright and bloom, so it is deliberately NOT held under
   * `MAX_SKY_LINEAR`. Absent falls back to a warm gold.
   */
  accent?: number;
  /**
   * Lane colours, left to right. **At least 5 is a hard requirement**, not a
   * convention: hard difficulty uses five lanes and indexes straight into this.
   * A four-colour theme wraps and gives two lanes the same colour, which is
   * unplayable rather than merely ugly. `assertThemes` enforces it.
   *
   * In stage rendering the track is colourless and the lane hue shows only in
   * the hit-flash, but the five-distinct rule still holds: any lane can be
   * struck, and two lanes that flash alike are as confusing as two painted alike.
   */
  lanes: readonly number[];
  /** The bar across the receptors. Additively blended, so this reads as a tint. */
  hitLine: number;
  sky: SkyPalette;
}

/** Fallback accent when a theme (e.g. a custom one) doesn't set one — electric pink. */
export const DEFAULT_ACCENT = 0xff3fa4;

export const MIN_THEME_LANES = 5;

/**
 * Lane hues are laid out on ONE geometry, rotated per theme.
 *
 * "Five distinct colours" turned out not to be a strong enough rule. Distinctness
 * was measured by `colorDistance`, which is a distance in linear RGB — so a pair
 * that differs mostly in *lightness* clears it while being, on a converging
 * four-lane board at speed, the same lane twice. Scored properly (pairwise hue
 * separation, with saturation and value held equal), only one shipped palette
 * passed: every other one had at least one pair inside 45 degrees, and several
 * had three warm lanes inside 45 of each other.
 *
 * So the hues are no longer chosen per theme. Each palette is one of two fixed
 * offset sets rotated to a base hue that carries the theme's identity, at a
 * single saturation and value:
 *
 *   SET_A  [0, 55, 155, 210, 290]   minimum pair 55 deg
 *   SET_B  [0, 78, 165, 212, 293]   minimum pair 47 deg, and puts a gold at
 *                                   lane 1 when the base is a pink
 *
 * Both put the outermost pair of a FOUR-lane chart (lanes 0 and 3 — every shipped
 * difficulty is four) 148-150 degrees apart, which is what makes the two lanes a
 * player mixes up most often the two furthest apart on the wheel.
 *
 * Equal saturation and value matter as much as the hues: a lane that is merely
 * paler than its neighbour reads as the same lane dimmed, not as a different
 * lane. It is also what lets the renderer normalise every tile's lit rim to one
 * peak channel, which is what keeps all five tone-mapping identically.
 *
 * A theme's identity therefore lives in its sky, its accent, and where on the
 * wheel its lanes start — not in five independently-chosen colours. `mono` is the
 * deliberate exception: it is a luminance-only scheme, where hue is meaningless.
 */
export const LANE_HUE_OFFSETS_A: readonly number[] = [0, 55, 155, 210, 290];
export const LANE_HUE_OFFSETS_B: readonly number[] = [0, 78, 165, 212, 293];

/*
 * ---------------------------------------------------------------------------
 * What a theme IS, since the playfield rebuild: ONE accent hue per song, and
 * lanes separated by VALUE.
 * ---------------------------------------------------------------------------
 *
 * Everything above this block describes the *previous* answer — five contrasting
 * hues laid out on a shared wheel geometry — and it is still the contract
 * `lanes` carries and `validateTheme` polices. It is no longer what the highway
 * paints. Measured off the owner's reference frames, all four lanes carry the
 * **same** hue: three notes in three different lanes in the
 * cyan frame measure hue 193 to within a degree of each other, at HSL saturation
 * 42% and lightness 68-72%. Lane identity comes from position, and the accent is
 * the only colour in the frame — it is on the notes, the trails, the rails, the
 * receptor glow and the background vignette at once, which is what makes a frame
 * read as one composition rather than as four coloured ribbons.
 *
 * So a lane colour is now derived, not chosen: `laneTones` walks a fixed
 * lightness ramp with the accent's hue and saturation held. That satisfies the
 * "five distinguishable lanes" requirement `laneColor` depends on — five stops
 * nine points of lightness apart are told apart by value, which is the axis a
 * greyscale palette has always had to rely on (see `mono`) — while reading as one
 * colour family at speed.
 *
 * **`theme.lanes` is deliberately left alone.** It is the wire contract, it is
 * what the theme editor edits and `validateTheme` checks, and `theme.test.ts`
 * pins the default palette's five values as a migration guard. Rewriting it would
 * be a data migration on top of a rendering change; deriving the ramp from
 * `accent` gets the reference look for every theme — built-in *and* custom, and
 * without a second array to keep in sync. `lanes[0]` is the fallback hue source
 * for a theme that never set an accent.
 */

/*
 * ---------------------------------------------------------------------------
 * THE RAMP IS AUTHORED SO THE *RENDERED* LANES HOLD ONE SATURATION.
 * ---------------------------------------------------------------------------
 *
 * Both stop tables below are solved, not chosen, and they have to be read as one
 * table of (saturation, lightness) pairs — index i of each is lane i.
 *
 * The previous shape was one saturation for the whole ramp plus a lightness
 * ramp, and it did not survive contact with the renderer. What the player sees is
 * not the authored colour: it is `sRGB -> linear -> x the tile's face exposure ->
 * Khronos PBR Neutral tone map -> sRGB`, and the tone mapper subtracts a fixed
 * 0.04 black offset in LINEAR space. A fixed subtraction is a much larger
 * fraction of a dark lane than of a bright one, so a flat authored saturation
 * comes out as a chroma *ramp*: measured on the shipped frame at S 0.48, the five
 * lanes rendered chroma 124 / 105 / 84 / 67 / 51 — a 2.4x spread, and a mean HSL
 * saturation of 30.6% against the reference's 41.9%. That mean is the number the
 * owner called washed out, and no single saturation could fix it, because the
 * bright end of the ramp is where the chroma was being lost.
 *
 * The reference does the opposite and is very consistent about it: its four
 * visible notes measure HSL S 40.7 / 42.0 / 42.0 / 42.8 while their lightness
 * ranges 47 to 76. **Saturation constant, value varying** — so the stops here are
 * solved for exactly that, one pair per lane, targeting rendered S 43% with the
 * rendered peak channel stepping 146 -> 186 in even tens.
 *
 * Two properties worth knowing before touching these:
 *
 *  - **They are hue-independent.** The tone mapper treats channels symmetrically
 *    and rendered value/chroma depend only on the authored max and min channels,
 *    so one solved table serves every theme — gold and cyan produce identical
 *    stops. That is what lets a single ramp be the answer for built-in and custom
 *    themes alike.
 *  - **They are solved against the tile's mid-face exposure (0.60 in
 *    `buildNotes`).** Change that exposure and this table is stale; the two are
 *    one calibration in two files. `scratchpad`-style guesswork is not needed to
 *    re-solve it — the chain above is closed-form.
 *
 * `peakLinear` still ascends across the stops, which is what `laneTones.test.ts`
 * checks and what keeps five lanes told apart by value.
 */

/** Lightness stop per lane, darkest first. Pairs with `LANE_TONE_SATURATION`. */
export const LANE_TONE_LIGHTNESS: readonly number[] = [0.586, 0.614, 0.644, 0.674, 0.718];

/**
 * Saturation stop per lane, pairing index-for-index with `LANE_TONE_LIGHTNESS`.
 *
 * It RISES with lightness, which looks wrong and is the whole point: the extra
 * authored saturation is what pays back the chroma the fixed linear black offset
 * takes out of a brighter lane. Rendered, all five land within half a point of
 * S 43%.
 */
export const LANE_TONE_SATURATION: readonly number[] = [0.432, 0.502, 0.59, 0.694, 0.81];

/** sRGB hex from HSL, all inputs 0..1 except `hue` in degrees. */
export function hslHex(hue: number, sat: number, light: number): number {
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = light - c / 2;
  const rgb: [number, number, number] =
    h < 1 ? [c, x, 0]
    : h < 2 ? [x, c, 0]
    : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c]
    : h < 5 ? [x, 0, c]
    : [c, 0, x];
  return rgb
    .map((v) => Math.max(0, Math.min(255, Math.round((v + m) * 255))))
    .reduce((acc, v) => (acc << 8) | v, 0);
}

/**
 * The hue a theme's whole frame is painted in.
 *
 * `accent` is the field that already threads through the shell (`accentVars`:
 * menu detail panel -> ready -> play -> results), so keying the lanes off it is
 * what makes the 3D frame and the 2D chrome agree without a new field to set.
 * Falling back to `lanes[0]` keeps a hand-written custom theme that never set an
 * accent from collapsing to the default pink.
 */
export function accentOf(theme: Theme): number {
  return theme.accent ?? theme.lanes[0] ?? DEFAULT_ACCENT;
}

/**
 * The lane ramp: `count` colours in the theme's accent hue, ascending in value.
 *
 * Pure and total. `count` above the number of stops wraps the ramp rather than
 * running off the end — the same defence `laneColor`'s modulo is, since a lane
 * with no colour at all is a black note on a black track.
 */
export function laneTones(theme: Theme, count: number = MIN_THEME_LANES): number[] {
  const { hue, sat } = hueOf(accentOf(theme));
  // A near-grey accent (`mono`) has no meaningful hue, and forcing one on it
  // would turn a deliberate luminance-only palette into a tinted one. Its ramp
  // is the same ramp with the chroma taken out — so the solved saturation table
  // is replaced by the accent's own (near-zero) saturation, flat.
  const chromatic = sat >= HUE_MEANINGFUL_SAT;
  const stops = LANE_TONE_LIGHTNESS;
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const stop = i % stops.length;
    const saturation = chromatic ? (LANE_TONE_SATURATION[stop] as number) : sat;
    return hslHex(hue, saturation, stops[stop] as number);
  });
}

/**
 * Peak linear channel a sky colour may reach.
 *
 * Matches the UnrealBloomPass threshold in `highway.ts`. Past it the backdrop
 * starts glowing in competition with the notes, which are supposed to be the
 * brightest things on screen. `0xe8` in any channel linearizes to 0.807 and
 * trips this — two built-in themes originally shipped that way and read as
 * merely "bright" rather than wrong, which is why it is enforced rather than
 * left to judgement.
 */
export const MAX_SKY_LINEAR = 0.8;

/**
 * Floor for a lane colour's peak linear channel.
 *
 * Lane hues also tint the floor and the receptor rings, both drawn dim. Below
 * this a lane's ring disappears against the track even though its notes still
 * look fine — a failure that only shows up while playing.
 */
export const MIN_LANE_LINEAR = 0.1;

/**
 * The themes that ship with the game. **Read-only at runtime.**
 *
 * Custom themes are persisted server-side and layered on top of these; these
 * cannot be edited or deleted from admin. Two reasons. `DEFAULT_THEME` is the
 * fallback that `themeFor` guarantees never fails, so it has to exist
 * unconditionally — resolving a theme is not allowed to depend on the contents
 * of a JSON file. And `synthwave` is tuned to reproduce the pre-theme renderer
 * exactly, colour for colour; that is not something anyone would reconstruct
 * after overwriting it. Admin offers Duplicate instead.
 */
export const BUILTIN_THEMES: readonly Theme[] = [
  {
    id: 'neon',
    name: 'Neon Arcade',
    // The flagship of the redesign and the new default: a deep navy starfield
    // over a neon city, electric pink for the gems and the hit bar. Gold in the
    // shell is fixed metallic trim (see accent.ts) — the accent here is the
    // pink that the whole flow follows.
    accent: 0xff3fa4,
    // SET_B from hue 328 — the same five jewel families as before (pink, gold,
    // green, cyan, violet) re-spaced onto the shared geometry.
    //
    // The old set was [pink 328, cyan 189, gold 46, violet 259, mint 150]: cyan
    // and mint sat 39 degrees apart, the violet was the only lane under the 0.65
    // saturation floor, and lanes 0 and 3 — the outermost pair of every shipped
    // four-lane chart — were 70 degrees apart where they want to be past 120.
    lanes: [0xff33a0, 0xffcf33, 0x33ff5f, 0x33ffff, 0x7a33ff],
    hitLine: 0xe8f4ff,
    // Navy night behind a neon skyline. `sun`/`sunCrown` are the city glow and
    // the lit windows; `horizon`/`horizonAlt` are the building silhouettes;
    // `glow` is the vanishing-point swell. Every channel ≤ 0xE0 so nothing
    // crosses the bloom threshold and competes with the gems.
    sky: {
      top: 0x0a0a1e,
      horizon: 0x2a1a5e,
      horizonAlt: 0x3a1450,
      below: 0x08081a,
      sun: 0xc03a8e,
      sunCrown: 0xd88ab8,
      haze: 0x6a3a9a,
      glow: 0x4a3ac0,
    },
    style: 'stage',
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    accent: 0xff4fa0,
    // SET_B from hue 334. The sky below is the part that reproduces the pre-theme
    // renderer colour for colour; the lanes never did, and the old set had a
    // 29-degree cyan/mint pair and a violet at saturation 0.65 and value 0.87.
    lanes: [0xff338b, 0xffe433, 0x33ff74, 0x33ebff, 0x8f33ff],
    hitLine: 0xffffff,
    // These six are the exact sRGB equivalents of the literals the backdrop
    // shader used before it took a theme, so every song ingested before themes
    // existed still renders pixel-for-pixel as it did.
    sky: {
      top: 0x120330,
      horizon: 0x6c1d55,
      horizonAlt: 0x5f1f5d,
      below: 0x270730,
      sun: 0xd43f7e,
      sunCrown: 0xda9eb8,
      haze: 0x95456f,
      glow: 0x9545bc,
    },
  },
  {
    id: 'inferno',
    name: 'Inferno',
    accent: 0xff7a2e,
    // SET_A from hue 8. The old set was three fire tones inside 44 degrees of each
    // other (9 / 39 / 53) — the exact failure the `stage` palette's comment was
    // written about, in the theme where it is most tempting.
    lanes: [0xff4e33, 0xf5ff33, 0x33ffc5, 0x337eff, 0xf833ff],
    hitLine: 0xfff0d8,
    sky: {
      top: 0x2a0608,
      horizon: 0x7a2a12,
      horizonAlt: 0x6e2420,
      below: 0x2e0a08,
      sun: 0xdc6a22,
      sunCrown: 0xe0b070,
      haze: 0xa85a2a,
      glow: 0x8c3a52,
    },
  },
  {
    id: 'arctic',
    name: 'Arctic',
    accent: 0x3fd0f0,
    // SET_A from hue 195 — icy cyan at lane 0, then right round the wheel.
    //
    // A cold palette is the hardest to keep readable, because every hue that
    // suits the name sits between cyan and violet, and this one kept losing that
    // argument: the previous set still had three pairs inside 45 degrees and two
    // lanes under the 0.65 saturation floor. Only lane 0 can carry the name; the
    // other four carry the chart.
    lanes: [0x33ccff, 0x5533ff, 0xff3355, 0xffcc33, 0x33ff44],
    hitLine: 0xeaf6ff,
    sky: {
      top: 0x050f2e,
      horizon: 0x14497a,
      horizonAlt: 0x1d3f6e,
      below: 0x081228,
      sun: 0x4fb8d4,
      // Was 0xa8dfe8, whose blue channel linearizes to 0.807 — just over the
      // bloom threshold, so the crown glowed and the sun read as blown out.
      // Caught by the test, not by eye: it looked merely "bright".
      sunCrown: 0xa8d8e0,
      haze: 0x4585a8,
      glow: 0x4560bc,
    },
  },
  {
    id: 'toxic',
    name: 'Toxic',
    accent: 0x7dff3a,
    // SET_A from hue 88 — acid green at lane 0.
    lanes: [0xa0ff33, 0x33ff81, 0x3d33ff, 0xf833ff, 0xff7033],
    hitLine: 0xf2ffe0,
    sky: {
      top: 0x04210f,
      horizon: 0x1d6b2a,
      horizonAlt: 0x2a5f1f,
      below: 0x082a12,
      sun: 0x6ad43f,
      // 0xe8 in any channel linearizes to 0.807 and crosses the bloom
      // threshold; both this and arctic's crown were originally written that
      // way. 0xe0 is the practical ceiling for a sky colour.
      sunCrown: 0xb8e09e,
      haze: 0x5f9545,
      glow: 0x458c7a,
    },
  },
  {
    id: 'mono',
    name: 'Black & White',
    accent: 0xeaeaea,
    /**
     * Greyscale is the hardest possible case for the readability rule above,
     * because lightness is the *only* axis left to separate five lanes on.
     *
     * These deliberately alternate bright/dim rather than running a smooth
     * ramp. A monotonic ramp looks tidier and plays worse: it puts the two
     * closest greys next to each other everywhere, and adjacent lanes are
     * exactly the pairs a player has to tell apart under pressure. Alternating
     * maximises the contrast that matters and spends it where confusing two
     * lanes costs least — 0 with 2, or 1 with 3, which are far enough apart on
     * screen that position disambiguates them.
     *
     * None of them go below ~0.4 lightness. The near-field is fine at any
     * value, since notes brighten as they approach, but a dark lane's tint on
     * the floor and its receptor ring both vanish against the track.
     */
    lanes: [0xffffff, 0x8a8a8a, 0xe0e0e0, 0x6a6a6a, 0xc0c0c0],
    hitLine: 0xffffff,
    sky: {
      top: 0x0a0a0c,
      horizon: 0x4a4a4e,
      horizonAlt: 0x3e3e46,
      below: 0x141418,
      sun: 0xc8c8c8,
      // Held at 0.72 linear, under the 0.8 bloom threshold. A white sun is the
      // one colour in this palette that would happily cross it and start
      // glowing in competition with the notes.
      sunCrown: 0xdcdcdc,
      haze: 0x8a8a8a,
      glow: 0x6e6e78,
    },
  },
  {
    id: 'stage',
    name: 'Stage',
    accent: 0xf5d152,
    /*
     * Five hues at 350 / 45 / 145 / 200 / 280 degrees, all at S 0.80 V 1.0.
     *
     * "Five distinct" is not a strong enough rule and this palette is why it had
     * to be tightened. Lane 0 was orange (hue 24) and lane 1 was gold (hue 47):
     * 23 degrees apart, *adjacent on the board*, and comfortably past the
     * validator's distance floor — a pair no player can separate at speed. These
     * are laid out so every pair is at least 45 degrees apart, no pair is inside
     * 30, and the outermost pair of a four-lane chart (0 and 3) is 150 apart.
     *
     * Equal saturation and value matter as much as the hues: a lane that is
     * merely paler than its neighbour reads as the same lane dimmed.
     */
    lanes: [0xff3355, 0xffcc33, 0x33ff88, 0x33bbff, 0xbb33ff],
    hitLine: 0xffffff,
    // Warm gold. In `stage` style the sky is not a sun but a single lamp behind
    // the horizon, so `sun`/`sunCrown` are the pooled glow and its hot core and
    // `glow`/`haze` are the air around it. Every channel stays at or below 0xE0
    // (0.745 linear) so the lamp bloom does not swamp the notes.
    sky: {
      top: 0x1a0f04,
      horizon: 0x5a3410,
      horizonAlt: 0x4a2a0e,
      below: 0x120a03,
      sun: 0xd08a2a,
      sunCrown: 0xe0b060,
      haze: 0xb0702a,
      glow: 0xc07f2e,
    },
    style: 'stage',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    accent: 0x4fffb0,
    // SET_A from hue 153 — the northern-lights green at lane 0.
    lanes: [0x33ffa3, 0x33a0ff, 0xff33e4, 0xff3d33, 0xb1ff33],
    hitLine: 0xe6fff4,
    sky: {
      top: 0x04121a,
      horizon: 0x0e5a4a,
      horizonAlt: 0x134e5e,
      below: 0x061a1a,
      sun: 0x2ea87a,
      sunCrown: 0x8fe0c0,
      haze: 0x2e8f7a,
      glow: 0x2e6f8c,
    },
    style: 'stage',
  },
  {
    id: 'vapor',
    name: 'Vapor',
    accent: 0xff7ad9,
    // SET_A from hue 313 — vaporwave magenta at lane 0.
    lanes: [0xff33d3, 0xff4e33, 0x5cff33, 0x33ffc5, 0x3d33ff],
    hitLine: 0xffe6f6,
    sky: {
      top: 0x180a2e,
      horizon: 0x5a2a6e,
      horizonAlt: 0x4e2a6a,
      below: 0x140826,
      sun: 0xc84f9a,
      sunCrown: 0xe0a0c8,
      haze: 0xa04f8a,
      glow: 0x8f5abc,
    },
    style: 'stage',
  },
  {
    id: 'abyss',
    name: 'Deep Sea',
    accent: 0x2ee0ff,
    // SET_A from hue 222 — abyssal blue at lane 0, then round the wheel. The two
    // warm lanes are what keep this from being an unreadable wall of blue, the
    // mistake the Arctic palette warns about.
    lanes: [0x3370ff, 0xb133ff, 0xff6d33, 0xd6ff33, 0x33ffa0],
    hitLine: 0xe6f6ff,
    sky: {
      top: 0x02101e,
      horizon: 0x0e3a6e,
      horizonAlt: 0x123a5e,
      below: 0x04121e,
      sun: 0x2e7ab0,
      sunCrown: 0x7ab8d8,
      haze: 0x2e6a9a,
      glow: 0x2e5abc,
    },
    style: 'stage',
  },
  {
    id: 'royal',
    name: 'Royal',
    accent: 0xc89bff,
    // SET_A from hue 263 — regal violet at lane 0, gold in the middle.
    lanes: [0x8133ff, 0xff33c2, 0xfff833, 0x4bff33, 0x33d3ff],
    hitLine: 0xf2e6ff,
    sky: {
      top: 0x10062e,
      horizon: 0x3e1d6e,
      horizonAlt: 0x36206a,
      below: 0x0e0526,
      sun: 0x7a3ec0,
      sunCrown: 0xb890e0,
      haze: 0x6a3ea0,
      glow: 0x5a3ebc,
    },
    style: 'stage',
  },
  {
    id: 'molten',
    name: 'Molten',
    accent: 0xff8a3c,
    // SET_A from hue 2 — forge crimson at lane 0. Five shades of fire would be
    // five lanes nobody can tell apart, so the cool lanes are the readability,
    // not a mood break; the theme's heat lives in its sky and its accent.
    lanes: [0xff3a33, 0xfff533, 0x33ffb1, 0x3392ff, 0xe433ff],
    hitLine: 0xffece0,
    sky: {
      top: 0x230604,
      horizon: 0x6e2a10,
      horizonAlt: 0x5e240e,
      below: 0x1e0804,
      sun: 0xcc5a22,
      sunCrown: 0xe0a060,
      haze: 0xa8502a,
      glow: 0x8c3a2e,
    },
    style: 'stage',
  },
];

export const DEFAULT_THEME_ID = 'neon';

export const DEFAULT_THEME: Theme =
  BUILTIN_THEMES.find((theme) => theme.id === DEFAULT_THEME_ID) ?? (BUILTIN_THEMES[0] as Theme);

/**
 * Every theme available: built-ins first, then custom ones.
 *
 * Built-ins win on an id collision. The server refuses to create a custom theme
 * that shadows a built-in, so this should never fire — but if a hand-edited
 * `themes.json` ever did shadow one, losing the guaranteed fallback is a worse
 * outcome than ignoring the custom entry.
 */
export function themeCatalog(custom: readonly Theme[]): readonly Theme[] {
  const builtinIds = new Set(BUILTIN_THEMES.map((theme) => theme.id));
  return [...BUILTIN_THEMES, ...custom.filter((theme) => !builtinIds.has(theme.id))];
}

export function isBuiltinTheme(id: string): boolean {
  return BUILTIN_THEMES.some((theme) => theme.id === id);
}

/**
 * Resolution is **total** on purpose.
 *
 * Every beatmap ingested before themes existed lacks `themeId`, and a typo — or
 * a custom theme that admin has since deleted — must not take the renderer
 * down. A song that could not resolve a palette would fail at `new Highway`,
 * i.e. a black screen rather than a wrong colour. Falling back keeps a stale id
 * cosmetic, which is what makes deleting a theme a safe operation.
 *
 * The catalogue is a parameter rather than module state. Custom themes arrive
 * over the wire, so a module-level cache would make this impure and load-order
 * dependent, and the play screen and the editor could disagree about what a
 * theme is — the same reasoning that keeps `laneColor` taking a theme.
 */
export function themeFor(catalog: readonly Theme[], id: string | undefined | null): Theme {
  if (!id) return DEFAULT_THEME;
  return catalog.find((theme) => theme.id === id) ?? DEFAULT_THEME;
}

/**
 * Whether `id` names a theme in `catalog`.
 *
 * The server validates a song's `themeId` with this rather than storing
 * whatever it is sent: an unrecognised id that gets persisted becomes a song
 * that silently renders default forever, with nothing in the UI to explain it.
 */
export function isThemeId(catalog: readonly Theme[], id: unknown): id is string {
  return typeof id === 'string' && catalog.some((theme) => theme.id === id);
}

// --- validation ------------------------------------------------------------

/**
 * sRGB hex channel to linear — the conversion `THREE.Color` applies on the way
 * into a shader uniform.
 *
 * Reimplemented here rather than imported because `shared/` deliberately has no
 * three.js dependency, and because the brightness rules below are properties of
 * the *palette*, not of the renderer that happens to consume it.
 */
export function linearChannels(hex: number): [number, number, number] {
  const channel = (shift: number): number => {
    const c = ((hex >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [channel(16), channel(8), channel(0)];
}

export function peakLinear(hex: number): number {
  return Math.max(...linearChannels(hex));
}

/** Perceptual-ish distance between two colours, 0..~1.7. Used to flag lanes that look alike. */
export function colorDistance(a: number, b: number): number {
  const [ar, ag, ab] = linearChannels(a);
  const [br, bg, bb] = linearChannels(b);
  // Weighted toward green, which dominates perceived brightness. Crude next to
  // a real CIELAB delta-E, but this only needs to answer "would a player
  // confuse these mid-song", and it avoids a colour-science dependency.
  return Math.sqrt(2 * (ar - br) ** 2 + 4 * (ag - bg) ** 2 + (ab - bb) ** 2);
}

/** Below this, two lane colours are too similar to tell apart at speed. */
export const MIN_LANE_DISTANCE = 0.22;

/**
 * Hue of an sRGB hex, in degrees, plus its saturation.
 *
 * `colorDistance` above cannot see this: it is a distance in linear RGB, so a
 * pair that differs mostly in lightness passes it comfortably while reading as
 * one lane dimmed. Hue is the channel a player actually parses at speed, and the
 * pairs that lose charts are the ones close in hue.
 */
export function hueOf(hex: number): { hue: number; sat: number } {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = 60 * ((((g - b) / d) % 6) + 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  return { hue: hue % 360, sat: max === 0 ? 0 : d / max };
}

/** Shortest distance between two hues, in degrees (0..180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Minimum hue separation between two lanes that can be on the board together.
 *
 * A warning, not an error, for the same reason the similarity check is: it is a
 * judgement call about a specific chart and a specific player, and a palette can
 * be deliberately monochrome (see `mono`). But it is the rule the built-in
 * palettes are now laid out against, and it is the one `colorDistance` misses.
 */
export const MIN_LANE_HUE_DEGREES = 45;
/** Below this saturation a colour has no meaningful hue, so the rule above is skipped. */
const HUE_MEANINGFUL_SAT = 0.15;

export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

export interface ThemeProblem {
  /** Dot path into the theme, e.g. `lanes.2` or `sky.sunCrown`. */
  field: string;
  message: string;
  /**
   * Errors block saving; warnings do not.
   *
   * The split matters. Brightness rules are hard limits with a specific
   * failure — a sky over the bloom threshold visibly breaks the game's
   * hierarchy. "These two lanes look similar" is a judgement call that depends
   * on the chart and the player, so it is surfaced and left to a human.
   */
  severity: 'error' | 'warning';
}

const SKY_KEYS: readonly (keyof SkyPalette)[] = [
  'top',
  'horizon',
  'horizonAlt',
  'below',
  'sun',
  'sunCrown',
  'haze',
  'glow',
];

function isHex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff;
}

/**
 * Check a theme against every rule the renderer relies on.
 *
 * This exists because themes stopped being source code. All of these were
 * previously guaranteed by `theme.test.ts`, which is no protection at all
 * against a palette typed into admin at runtime — so the same rules run
 * server-side before a write is accepted, and in the editor for live feedback.
 * Both call this; neither reimplements it.
 */
export function validateTheme(theme: Theme, catalog: readonly Theme[] = []): ThemeProblem[] {
  const problems: ThemeProblem[] = [];
  const error = (field: string, message: string): void => {
    problems.push({ field, message, severity: 'error' });
  };

  if (!THEME_ID_PATTERN.test(theme.id)) {
    error('id', 'Use 2–31 characters: lowercase letters, numbers and dashes, starting with a letter or number.');
  }
  if (isBuiltinTheme(theme.id)) {
    error('id', `“${theme.id}” is a built-in theme. Duplicate it instead of replacing it.`);
  }
  if (catalog.some((other) => other.id === theme.id)) {
    error('id', `A theme with the id “${theme.id}” already exists.`);
  }
  if (theme.name.trim().length === 0) {
    error('name', 'Give the theme a name.');
  }

  if (theme.lanes.length < MIN_THEME_LANES) {
    error(
      'lanes',
      `Needs at least ${MIN_THEME_LANES} lane colours — hard difficulty uses five, and a short palette wraps so two lanes share a colour.`,
    );
  }

  theme.lanes.forEach((hex, i) => {
    if (!isHex(hex)) {
      error(`lanes.${i}`, 'Not a valid colour.');
      return;
    }
    if (peakLinear(hex) < MIN_LANE_LINEAR) {
      error(
        `lanes.${i}`,
        'Too dark — this lane’s receptor ring and floor tint would disappear against the track.',
      );
    }
  });

  // Only the lanes that can actually be on screen together. Comparing beyond
  // MIN_THEME_LANES would flag colours no chart ever shows side by side.
  const playable = theme.lanes.slice(0, MIN_THEME_LANES);
  for (let i = 0; i < playable.length; i++) {
    for (let j = i + 1; j < playable.length; j++) {
      const a = playable[i] as number;
      const b = playable[j] as number;
      if (!isHex(a) || !isHex(b)) continue;
      if (a === b) {
        error(`lanes.${j}`, `Identical to lane ${i + 1}.`);
        continue;
      }
      if (colorDistance(a, b) < MIN_LANE_DISTANCE) {
        problems.push({
          field: `lanes.${j}`,
          message: `Very similar to lane ${i + 1} — hard to tell apart mid-song${
            j === i + 1 ? ', and they are next to each other' : ''
          }.`,
          severity: 'warning',
        });
        continue;
      }
      // Skipped for near-greys, where hue carries no information at all and a
      // luminance-only palette is a legitimate design (see `mono`).
      const ha = hueOf(a);
      const hb = hueOf(b);
      if (ha.sat < HUE_MEANINGFUL_SAT || hb.sat < HUE_MEANINGFUL_SAT) continue;
      const apart = hueDistance(ha.hue, hb.hue);
      if (apart < MIN_LANE_HUE_DEGREES) {
        problems.push({
          field: `lanes.${j}`,
          message: `Only ${Math.round(apart)}° of hue from lane ${
            i + 1
          } — they read as the same colour on a converging board. Aim for ${MIN_LANE_HUE_DEGREES}° or more.`,
          severity: 'warning',
        });
      }
    }
  }

  if (!isHex(theme.hitLine)) error('hitLine', 'Not a valid colour.');

  for (const key of SKY_KEYS) {
    const hex = theme.sky[key];
    if (!isHex(hex)) {
      error(`sky.${key}`, 'Not a valid colour.');
      continue;
    }
    if (peakLinear(hex) >= MAX_SKY_LINEAR) {
      error(
        `sky.${key}`,
        'Too bright — this crosses the bloom threshold and would glow in competition with the notes. Keep every channel at or below 0xE0.',
      );
    }
  }

  return problems;
}

export function themeErrors(problems: readonly ThemeProblem[]): ThemeProblem[] {
  return problems.filter((problem) => problem.severity === 'error');
}

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

/** Fallback accent when a theme (e.g. a custom one) doesn't set one — a warm gold. */
export const DEFAULT_ACCENT = 0xf5d152;

export const MIN_THEME_LANES = 5;

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
    id: 'synthwave',
    name: 'Synthwave',
    accent: 0xff4fa0,
    lanes: [0xff2e88, 0x00e5ff, 0xffd60a, 0x9d4edd, 0x00ff9d],
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
    lanes: [0xff4d2e, 0xffb020, 0xffe94a, 0x2ee5ff, 0xff2e9f],
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
    // A cold palette is the hardest to keep readable, because every hue that
    // suits the name sits between cyan and violet. The first pass used
    // 0x7c9dff for lane 1 and 0xa8f0d0 for lane 2, and on the receptors they
    // were near-indistinguishable from the cyan beside them. These are pushed
    // apart deliberately: distinct beats tasteful.
    lanes: [0x4fe3ff, 0x4f6bff, 0x8cffc4, 0xc48cff, 0xffd166],
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
    lanes: [0x9dff2e, 0x00ffcc, 0xffe600, 0xff2ecc, 0xff7a1f],
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
    // The dark, spotlit look. The track itself is drawn near-black in this
    // style, so these lane colours are seen almost only as the *hit flash* that
    // fires up a lane when it is struck — the burst of colour the reference gets
    // from its green perfect-flash. They still have to satisfy the five-distinct
    // rule: a chart can strike any lane, and two lanes that flash the same
    // colour are as confusing here as two that are painted the same.
    lanes: [0xff8a3c, 0xffd23c, 0x3cff7a, 0x3cc4ff, 0xff4fb0],
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
    // Northern lights: a green→cyan→violet sweep with a warm pin to keep the
    // outer lanes readable. Green and cyan are the danger pair (adjacent hues),
    // so they are pushed a full step apart rather than left as neighbours.
    lanes: [0x2effa0, 0x24d6ff, 0x7a5cff, 0xff4fb0, 0xffe14a],
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
    // Vaporwave dusk — magenta and peach over a violet horizon. The cyan is the
    // one cool lane that stops the warm half from blurring together.
    lanes: [0xff4fd8, 0xff7a5c, 0xffd06b, 0x4fe0ff, 0x8f6bff],
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
    // Abyssal: blue and cyan up top, then lime and coral for the bioluminescence
    // — the two warm lanes are what keep this from being an unreadable wall of
    // blue, the mistake the Arctic palette warns about.
    lanes: [0x3a6bff, 0x2ee0ff, 0xa6ff3c, 0xff6a4a, 0xff4fb0],
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
    // Violet and magenta with gold — the regal pairing. Rose is pulled toward
    // coral so it does not read as a second magenta, and cyan grounds the cool
    // end so five jewel tones stay five.
    lanes: [0x9a5cff, 0xe04fd0, 0xff6a6a, 0xffcf4a, 0x4fd0e0],
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
    // Forge colours: crimson, orange, gold. A cyan lane is deliberately dropped
    // into the middle — five shades of fire would be five lanes nobody can tell
    // apart, so the contrast lane is the readability, not a mood break.
    lanes: [0xff3a3a, 0xff8a2e, 0xffd23c, 0x2ee0ff, 0xff4fb0],
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

export const DEFAULT_THEME_ID = 'synthwave';

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
      } else if (colorDistance(a, b) < MIN_LANE_DISTANCE) {
        problems.push({
          field: `lanes.${j}`,
          message: `Very similar to lane ${i + 1} — hard to tell apart mid-song${
            j === i + 1 ? ', and they are next to each other' : ''
          }.`,
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

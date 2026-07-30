import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEMES,
  LANE_TONE_LIGHTNESS,
  MIN_LANE_LINEAR,
  MIN_THEME_LANES,
  accentOf,
  hslHex,
  hueDistance,
  hueOf,
  laneTones,
  peakLinear,
  type Theme,
} from './theme.js';

/**
 * The lane ramp is what the highway actually paints, so it needs the guarantees
 * `theme.test.ts` gives `theme.lanes` — five entries, all distinct, none too dark
 * to show a receptor. It has one more of its own: **all five must be the same
 * hue.** A multi-hue set of lanes is the exact thing the reference frames rule
 * out (see the block comment on `laneTones`), and a ramp that drifted in hue as
 * it brightened would reintroduce it a step at a time.
 */
const chromatic = BUILTIN_THEMES.filter((t) => hueOf(accentOf(t)).sat >= 0.15);

describe('laneTones', () => {
  it('gives every built-in theme enough lanes for hard difficulty', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(laneTones(theme).length, theme.id).toBe(MIN_THEME_LANES);
    }
  });

  it('paints every lane in the theme accent, one hue', () => {
    for (const theme of chromatic) {
      const accentHue = hueOf(accentOf(theme)).hue;
      for (const [i, tone] of laneTones(theme).entries()) {
        expect(hueDistance(hueOf(tone).hue, accentHue), `${theme.id} lane ${i}`).toBeLessThan(2);
      }
    }
  });

  it('separates lanes by value, ascending and distinct', () => {
    for (const theme of BUILTIN_THEMES) {
      const tones = laneTones(theme);
      expect(new Set(tones).size, `${theme.id} has duplicate lanes`).toBe(tones.length);
      for (let i = 1; i < tones.length; i++) {
        expect(peakLinear(tones[i] as number), `${theme.id} lane ${i}`).toBeGreaterThan(
          peakLinear(tones[i - 1] as number),
        );
      }
    }
  });

  it('keeps every lane above the floor where its receptor would vanish', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const [i, tone] of laneTones(theme).entries()) {
        expect(peakLinear(tone), `${theme.id} lane ${i}`).toBeGreaterThan(MIN_LANE_LINEAR);
      }
    }
  });

  it('leaves a luminance-only palette without a hue', () => {
    // `mono` is the case the ramp must NOT tint: hue is meaningless there and
    // inventing one would turn a deliberate greyscale scheme into a coloured one.
    const mono = BUILTIN_THEMES.find((t) => t.id === 'mono') as Theme;
    for (const tone of laneTones(mono)) {
      expect(hueOf(tone).sat).toBeLessThan(0.05);
    }
  });

  it('wraps rather than running off the end of the ramp', () => {
    // Defence, not design: a lane with no colour is a black note on a black
    // track, which is the failure mode `laneColor`'s modulo has always guarded.
    const theme = BUILTIN_THEMES[0] as Theme;
    const wide = laneTones(theme, LANE_TONE_LIGHTNESS.length + 2);
    expect(wide.length).toBe(LANE_TONE_LIGHTNESS.length + 2);
    expect(wide[LANE_TONE_LIGHTNESS.length]).toBe(wide[0]);
  });

  it('falls back to lane 0 for a theme with no accent', () => {
    const noAccent: Theme = { ...(BUILTIN_THEMES[0] as Theme), accent: undefined };
    expect(accentOf(noAccent)).toBe(noAccent.lanes[0]);
  });
});

describe('hslHex', () => {
  it('round-trips a hue', () => {
    for (const hue of [0, 45, 120, 193, 280, 359]) {
      expect(hueDistance(hueOf(hslHex(hue, 0.66, 0.6)).hue, hue)).toBeLessThan(2);
    }
  });

  it('clamps to the byte range at both ends', () => {
    expect(hslHex(200, 1, 0)).toBe(0x000000);
    expect(hslHex(200, 1, 1)).toBe(0xffffff);
  });
});

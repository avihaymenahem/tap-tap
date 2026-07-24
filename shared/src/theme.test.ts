import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  DEFAULT_THEME_ID,
  MAX_SKY_LINEAR,
  MIN_LANE_LINEAR,
  MIN_THEME_LANES,
  type Theme,
  isBuiltinTheme,
  isThemeId,
  peakLinear,
  themeCatalog,
  themeFor,
  themeErrors,
  validateTheme,
} from './theme.js';

/** A valid custom theme, used as the base for the "one thing wrong" cases below. */
function custom(overrides: Partial<Theme> = {}): Theme {
  return {
    id: 'my-theme',
    name: 'My Theme',
    lanes: [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0x00ffff],
    hitLine: 0xffffff,
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
    ...overrides,
  };
}

describe('BUILTIN_THEMES', () => {
  it('satisfies its own validator', () => {
    // The rules that used to live only in this file now run against user input
    // at runtime, so the shipped themes have to pass the same gate rather than
    // being grandfathered past it.
    for (const theme of BUILTIN_THEMES) {
      // Built-ins fail the id checks by construction (they *are* built-ins and
      // they are in the catalogue), so only the colour rules apply here.
      const problems = validateTheme(theme).filter((p) => !p.field.startsWith('id'));
      expect(themeErrors(problems), `${theme.id}: ${problems.map((p) => p.message).join('; ')}`)
        .toEqual([]);
    }
  });

  it('gives every theme enough lanes for hard difficulty', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(theme.lanes.length, `${theme.id} lane count`).toBeGreaterThanOrEqual(MIN_THEME_LANES);
    }
  });

  it('has unique ids', () => {
    const ids = BUILTIN_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships the five expansion palettes', () => {
    // Guards against a rebase silently dropping one. The colour rules are
    // enforced by the validator loop above; this just pins their presence.
    const ids = new Set(BUILTIN_THEMES.map((theme) => theme.id));
    for (const id of ['aurora', 'vapor', 'abyss', 'royal', 'molten']) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe('themeCatalog', () => {
  it('puts built-ins first, then custom themes', () => {
    const catalog = themeCatalog([custom()]);
    expect(catalog.length).toBe(BUILTIN_THEMES.length + 1);
    expect(catalog[catalog.length - 1]?.id).toBe('my-theme');
  });

  it('refuses to let a custom theme shadow a built-in', () => {
    // A hand-edited themes.json cannot displace a shipped theme — resolving the
    // id still returns the genuine built-in, not the impostor.
    const real = BUILTIN_THEMES.find((t) => t.id === 'synthwave') as Theme;
    const impostor = custom({ id: 'synthwave', name: 'Not The Real One' });
    const catalog = themeCatalog([impostor]);

    expect(catalog.filter((t) => t.id === 'synthwave')).toHaveLength(1);
    expect(themeFor(catalog, 'synthwave')).toBe(real);
  });

  it('is empty-safe', () => {
    expect(themeCatalog([])).toEqual(BUILTIN_THEMES);
  });
});

describe('themeFor', () => {
  const catalog = themeCatalog([custom()]);

  it('resolves a built-in and a custom theme', () => {
    expect(themeFor(catalog, 'toxic').id).toBe('toxic');
    expect(themeFor(catalog, 'my-theme').id).toBe('my-theme');
  });

  it('falls back for an unknown id', () => {
    // Total resolution matters: an unresolvable theme would fail at
    // `new Highway`, i.e. a black screen instead of merely the wrong colours.
    expect(themeFor(catalog, 'does-not-exist')).toBe(DEFAULT_THEME);
  });

  it('falls back for a song whose custom theme was deleted', () => {
    // This is what makes deleting a theme safe rather than destructive: songs
    // still pointing at it quietly render the default.
    expect(themeFor(themeCatalog([]), 'my-theme')).toBe(DEFAULT_THEME);
  });

  it('falls back for a song ingested before themes existed', () => {
    expect(themeFor(catalog, undefined)).toBe(DEFAULT_THEME);
    expect(themeFor(catalog, null)).toBe(DEFAULT_THEME);
    expect(themeFor(catalog, '')).toBe(DEFAULT_THEME);
  });
});

describe('isThemeId', () => {
  const catalog = themeCatalog([custom()]);

  it('accepts ids in the catalogue and rejects everything else', () => {
    expect(isThemeId(catalog, DEFAULT_THEME_ID)).toBe(true);
    expect(isThemeId(catalog, 'my-theme')).toBe(true);
    expect(isThemeId(catalog, 'nope')).toBe(false);
    expect(isThemeId(catalog, undefined)).toBe(false);
    expect(isThemeId(catalog, 7)).toBe(false);
    expect(isThemeId(catalog, { id: 'synthwave' })).toBe(false);
  });

  it('does not accept a custom id absent from the given catalogue', () => {
    expect(isThemeId(themeCatalog([]), 'my-theme')).toBe(false);
  });
});

describe('isBuiltinTheme', () => {
  it('identifies the protected themes', () => {
    expect(isBuiltinTheme('synthwave')).toBe(true);
    expect(isBuiltinTheme('mono')).toBe(true);
    expect(isBuiltinTheme('my-theme')).toBe(false);
  });
});

describe('validateTheme', () => {
  it('accepts a well-formed custom theme', () => {
    expect(validateTheme(custom())).toEqual([]);
  });

  it('rejects a sky colour past the bloom threshold', () => {
    // 0xe8 linearizes to 0.807. Two built-in themes shipped with exactly this
    // and looked merely "bright" — which is why it is a rule, not a judgement.
    const problems = validateTheme(custom({ sky: { ...custom().sky, sunCrown: 0xe8e8e8 } }));
    expect(problems.some((p) => p.field === 'sky.sunCrown' && p.severity === 'error')).toBe(true);
    expect(peakLinear(0xe8e8e8)).toBeGreaterThan(MAX_SKY_LINEAR);
  });

  it('accepts the practical ceiling of 0xe0', () => {
    expect(peakLinear(0xe0e0e0)).toBeLessThan(MAX_SKY_LINEAR);
    expect(validateTheme(custom({ sky: { ...custom().sky, sunCrown: 0xe0e0e0 } }))).toEqual([]);
  });

  it('rejects a lane too dark to show its receptor ring', () => {
    const problems = validateTheme(custom({ lanes: [0x0a0a0a, 0x00ff00, 0x0000ff, 0xffff00, 0x00ffff] }));
    expect(problems.some((p) => p.field === 'lanes.0' && p.severity === 'error')).toBe(true);
    expect(peakLinear(0x0a0a0a)).toBeLessThan(MIN_LANE_LINEAR);
  });

  it('rejects duplicate lane colours outright', () => {
    const problems = validateTheme(custom({ lanes: [0xff0000, 0xff0000, 0x0000ff, 0xffff00, 0x00ffff] }));
    expect(problems.some((p) => p.field === 'lanes.1' && p.severity === 'error')).toBe(true);
  });

  it('warns — but does not block — on lanes that merely look similar', () => {
    // A judgement call that depends on the chart and the player, so it is
    // surfaced and left to a human rather than made un-saveable.
    const problems = validateTheme(custom({ lanes: [0xff0000, 0xfa0505, 0x0000ff, 0xffff00, 0x00ffff] }));
    const similar = problems.find((p) => p.field === 'lanes.1');
    expect(similar?.severity).toBe('warning');
    expect(themeErrors(problems)).toEqual([]);
  });

  it('refuses too few lanes', () => {
    const problems = validateTheme(custom({ lanes: [0xff0000, 0x00ff00, 0x0000ff] }));
    expect(problems.some((p) => p.field === 'lanes' && p.severity === 'error')).toBe(true);
  });

  it('refuses to overwrite a built-in', () => {
    const problems = validateTheme(custom({ id: 'synthwave' }));
    expect(problems.some((p) => p.field === 'id' && /built-in/.test(p.message))).toBe(true);
  });

  it('refuses an id that already exists in the catalogue', () => {
    const problems = validateTheme(custom(), [custom()]);
    expect(problems.some((p) => p.field === 'id' && /already exists/.test(p.message))).toBe(true);
  });

  it('refuses malformed ids and empty names', () => {
    expect(validateTheme(custom({ id: 'Has Spaces' })).some((p) => p.field === 'id')).toBe(true);
    expect(validateTheme(custom({ id: 'x' })).some((p) => p.field === 'id')).toBe(true);
    expect(validateTheme(custom({ name: '   ' })).some((p) => p.field === 'name')).toBe(true);
  });

  it('rejects values that are not colours', () => {
    const problems = validateTheme(custom({ hitLine: 0x1000000 }));
    expect(problems.some((p) => p.field === 'hitLine')).toBe(true);
  });
});

describe('DEFAULT_THEME', () => {
  it('is the neon-arcade palette every un-themed song renders with', () => {
    // The neon-arcade redesign made `neon` the default, deliberately recolouring
    // every song that never chose a theme from the old synthwave palette to this
    // one. Changing these values again is a migration, not a tweak — add a new
    // theme instead.
    expect(DEFAULT_THEME.id).toBe('neon');
    expect(DEFAULT_THEME.accent).toBe(0xff3fa4);
    expect(DEFAULT_THEME.lanes).toEqual([0xff2e9c, 0x2ee0ff, 0xffd23c, 0x8f5cff, 0x3cff9d]);
  });
});

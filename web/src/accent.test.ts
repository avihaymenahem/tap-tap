import { describe, expect, it } from 'vitest';
import { accentVars } from './accent.js';

/** accentVars returns a typed CSSProperties; the CSS-var keys need a cast to index. */
const vars = (accent: number): Record<string, string> =>
  accentVars(accent) as unknown as Record<string, string>;

describe('accentVars', () => {
  it('emits the accent as an "r, g, b" triple for rgba()', () => {
    expect(vars(0xff3fa4)['--accent-rgb']).toBe('255, 63, 164');
    expect(vars(0x000000)['--accent-rgb']).toBe('0, 0, 0');
  });

  it('recolours the glow family to the accent', () => {
    const v = vars(0xff3fa4);
    expect(v['--pink']).toBe('#ff3fa4');
    // --violet / --amber are darkened shades of the accent, not the base.
    expect(v['--violet']).toMatch(/^#[0-9a-f]{6}$/);
    expect(v['--amber']).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('never overrides --gold — trim is fixed brand chrome, not the accent', () => {
    // The neon-arcade redesign split accent (follows the song) from trim (always
    // gold). If accentVars started writing --gold again, every frame and bezel
    // would recolour to the song and read as painted plastic. Guard against the
    // regression the old implementation had.
    const v = vars(0xff3fa4);
    expect(v['--gold']).toBeUndefined();
    expect(v['--gold-bright']).toBeUndefined();
  });
});

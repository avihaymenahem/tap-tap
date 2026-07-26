import { describe, expect, it } from 'vitest';
import { LAMP_LABELS, type Lamp, type LampInput, lampFor, lampRank } from './lamps.js';

const best = (over: Partial<LampInput> = {}): LampInput => ({
  accuracy: 0.85,
  maxCombo: 50,
  ...over,
});

describe('lampFor', () => {
  it('is none with no stored best', () => {
    expect(lampFor(null, 100)).toBe('none');
    expect(lampFor(undefined, 100)).toBe('none');
  });

  it('is cleared for any stored best, because only survived runs are recorded', () => {
    // A failed run never reaches `recordScore`, so the existence of a record is
    // itself the clear. There is no "played" rung to test — a failed attempt
    // leaves no trace, so it is indistinguishable from never having played.
    expect(lampFor(best({ accuracy: 0.61, maxCombo: 3, misses: 40 }), 100)).toBe('cleared');
  });

  it('is fullCombo when the run had no misses', () => {
    expect(lampFor(best({ misses: 0 }), 100)).toBe('fullCombo');
    expect(lampFor(best({ misses: 1 }), 100)).toBe('cleared');
  });

  it('is perfect only when accuracy is a full 1 as well', () => {
    expect(lampFor(best({ accuracy: 1, misses: 0 }), 100)).toBe('perfect');
    // A hair under 1 means at least one note was not `perfect` tier.
    expect(lampFor(best({ accuracy: 0.999, misses: 0 }), 100)).toBe('fullCombo');
  });

  it('does not award perfect for a flawless-looking run that still missed', () => {
    // Defensive: accuracy 1 already implies no misses today, but a future tier
    // whose score ties with perfect would break that implication silently.
    expect(lampFor(best({ accuracy: 1, misses: 2 }), 100)).toBe('cleared');
  });

  describe('legacy records without a miss count', () => {
    it('reads a whole-chart combo as a full combo', () => {
      expect(lampFor({ accuracy: 0.9, maxCombo: 100 }, 100)).toBe('fullCombo');
      expect(lampFor({ accuracy: 1, maxCombo: 100 }, 100)).toBe('perfect');
    });

    it('under-reports rather than over-reports when the played chart was shorter', () => {
      // The intro-skip case: a genuine full combo on a song whose first 30s are
      // beatless ends with `maxCombo` far below the stored chart's note count.
      // Showing `cleared` is the wrong answer but the safe one; claiming a full
      // combo the player did not earn would be worse.
      expect(lampFor({ accuracy: 0.97, maxCombo: 80 }, 100)).toBe('cleared');
    });

    it('prefers the miss count when both are available', () => {
      // `misses` is exact; `maxCombo` is a proxy. A record carrying both must not
      // be downgraded by the proxy disagreeing.
      expect(lampFor({ accuracy: 0.97, maxCombo: 80, misses: 0 }, 100)).toBe('fullCombo');
    });
  });

  it('never calls an empty chart perfect', () => {
    // `accuracyOf` returns 1 when it judged nothing, so a chart with no notes
    // would otherwise come back flawless.
    expect(lampFor(best({ accuracy: 1, misses: 0 }), 0)).toBe('cleared');
  });
});

describe('lampRank', () => {
  it('orders the ladder', () => {
    const ladder: Lamp[] = ['none', 'cleared', 'fullCombo', 'perfect'];
    for (let i = 1; i < ladder.length; i++) {
      expect(lampRank(ladder[i]!)).toBeGreaterThan(lampRank(ladder[i - 1]!));
    }
  });
});

describe('LAMP_LABELS', () => {
  it('names every lamp, so the badge is never colour-only', () => {
    for (const lamp of ['none', 'cleared', 'fullCombo', 'perfect'] as Lamp[]) {
      expect(LAMP_LABELS[lamp]).toBeTruthy();
    }
  });
});

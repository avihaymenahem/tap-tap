import type { Note } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { EXACT_BONUS, SCORE_VALUES, baseScore, comboMultiplier } from './judge.js';
import { MAX_SCORE, idealScore, normalizeScore, rescaleLegacyScore } from './score.js';

const tap = (t: number, lane = 0): Note => ({ t, lane, type: 'tap' });
const hold = (t: number, duration: number, lane = 0): Note => ({
  t,
  lane,
  type: 'hold',
  duration,
});

const taps = (n: number): Note[] => Array.from({ length: n }, (_, i) => tap(i * 0.5, i % 4));

describe('idealScore', () => {
  it('matches the engine accumulation for a short tap-only chart', () => {
    // Hand-computed the way the engine does it: combo is incremented *before* the
    // multiplier is read, so hit i is worth `perfect+exact × comboMultiplier(i)`.
    // Getting that off by one would put the whole scale slightly wrong and nothing
    // else would notice.
    let expected = 0;
    for (let i = 1; i <= 5; i++) expected += baseScore('perfect', 'exact') * comboMultiplier(i);
    expect(idealScore(taps(5))).toBe(expected);
  });

  it('is zero for an empty chart', () => {
    expect(idealScore([])).toBe(0);
  });

  it('grows with note count — the very thing normalising exists to hide', () => {
    expect(idealScore(taps(500))).toBeGreaterThan(idealScore(taps(100)));
  });

  it('rewards the combo multiplier, so it is not merely linear in notes', () => {
    // 200 notes is worth more than twice 100, because the later notes are
    // multiplied harder. A linear model would normalise every chart wrongly.
    expect(idealScore(taps(200))).toBeGreaterThan(2 * idealScore(taps(100)));
  });

  it('counts a hold for more than the tap it replaces', () => {
    const withTap: Note[] = [tap(0), tap(1)];
    const withHold: Note[] = [tap(0), hold(1, 2)];
    expect(idealScore(withHold)).toBeGreaterThan(idealScore(withTap));
  });

  it('counts a longer hold for more than a shorter one', () => {
    expect(idealScore([hold(0, 3)])).toBeGreaterThan(idealScore([hold(0, 0.5)]));
  });

  it('treats a hold with no duration as a tap', () => {
    // `duration` is optional on the wire; a malformed hold must not add score for
    // a sustain it never had.
    const bare: Note = { t: 0, lane: 0, type: 'hold' };
    expect(idealScore([bare])).toBe(idealScore([tap(0)]));
  });
});

describe('normalizeScore', () => {
  it('puts a flawless run exactly on the ceiling', () => {
    const notes = taps(300);
    expect(normalizeScore(idealScore(notes), idealScore(notes))).toBe(MAX_SCORE);
  });

  it('makes the same performance read the same on charts of different length', () => {
    // This is the whole point. Half of a flawless run on a short chart and half on
    // a long one must produce the same number.
    const short = idealScore(taps(120));
    const long = idealScore(taps(900));
    expect(normalizeScore(short / 2, short)).toBeCloseTo(normalizeScore(long / 2, long), -1);
  });

  it('clamps above the ceiling rather than reporting past it', () => {
    // `idealScore` models interleaved hold ticks approximately, so a genuinely
    // flawless run can compute a hair over. 1,000,240 would read as a bug.
    expect(normalizeScore(2_000_000, 1_000_000)).toBe(MAX_SCORE);
  });

  it('never goes negative', () => {
    expect(normalizeScore(-500, 1000)).toBe(0);
  });

  it('returns zero rather than Infinity or NaN for a degenerate ideal', () => {
    // An empty chart has a zero ideal; dividing by it would put NaN into a stored
    // record, and NaN comparisons in `recordScore` silently fail every direction.
    for (const ideal of [0, -1, Number.NaN]) {
      expect(normalizeScore(1000, ideal), `ideal ${ideal}`).toBe(0);
    }
    expect(normalizeScore(Number.NaN, 1000)).toBe(0);
  });

  it('is monotonic, so a better raw run always reads higher', () => {
    const ideal = idealScore(taps(400));
    let previous = -1;
    for (const raw of [0, ideal * 0.25, ideal * 0.5, ideal * 0.75, ideal]) {
      const value = normalizeScore(raw, ideal);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});

describe('rescaleLegacyScore', () => {
  it('brings a raw record onto the normalised scale', () => {
    const notes = taps(962);
    const flawlessRaw = idealScore(notes);
    // The migration's whole job: a raw score that exceeded the new ceiling must
    // land on it, not above it, or the chart's record becomes unbeatable forever.
    expect(flawlessRaw).toBeGreaterThan(MAX_SCORE);
    expect(rescaleLegacyScore(flawlessRaw, notes)).toBe(MAX_SCORE);
  });

  it('preserves ranking within a chart', () => {
    // Monotonic, so migrating cannot reorder a player's own history.
    const notes = taps(500);
    const a = rescaleLegacyScore(200_000, notes);
    const b = rescaleLegacyScore(400_000, notes);
    expect(b).toBeGreaterThan(a);
  });

  it('leaves a legacy score on a chart with no notes at zero rather than NaN', () => {
    expect(rescaleLegacyScore(50_000, [])).toBe(0);
  });
});

describe('the scale itself', () => {
  it('is a round ceiling', () => {
    expect(MAX_SCORE).toBe(1_000_000);
  });

  it('rests on the tier values it claims to', () => {
    // If `SCORE_VALUES` or `EXACT_BONUS` are retuned, the ideal moves with them —
    // which is correct — but this pins the assumption that `perfect` + `exact` is
    // the top of the scale, so a future tier worth more would fail here rather
    // than silently making the ceiling unreachable.
    const top = Math.max(...Object.values(SCORE_VALUES));
    expect(top).toBe(SCORE_VALUES.perfect);
    expect(EXACT_BONUS).toBeGreaterThan(1);
  });
});

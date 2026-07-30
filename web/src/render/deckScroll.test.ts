import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '@tap-tap/shared';
import {
  DECK_RUNG_PERIOD,
  GROUND_SCROLL_FRACTION,
  deckScrollPhase,
  groundScrollWorld,
  noteWorldSpeed,
} from './highway';

/**
 * The scenery has to travel at the notes' speed, in the notes' direction.
 *
 * The reported defect — "i can see the note bars moving, but dont feel 'in
 * motion' inside game" — was three surfaces disagreeing about how fast the
 * world is going past: the deck rungs at 3.6 world units/sec *away* from the
 * player, the ground grid at 3.2 *toward*, and the notes at 19.2 toward. These
 * tests pin the agreement rather than the constants, so retuning
 * `HIGHWAY_LENGTH` or a difficulty's `approachSec` cannot silently break it
 * again.
 */
describe('deck and ground scroll', () => {
  /** Every shipped difficulty, at the default scroll speed. */
  const approaches = Object.values(DIFFICULTIES).map((d) => d.approachSec);

  it('moves the deck toward the camera, not away from it', () => {
    // The shader samples fract(v * N + phase) and v grows AWAY from the camera
    // (`toward` in the fragment shader is written against exactly that), so a
    // crest sits at v = (c - phase)/N. The phase must therefore RISE for the
    // crest to travel toward the player. The shipped code used -songTime * 1.6.
    for (const approachSec of approaches) {
      expect(deckScrollPhase(1, approachSec)).toBeGreaterThan(deckScrollPhase(0, approachSec));
    }
  });

  it('moves the ground the same way as the deck', () => {
    // The ground samples world distance directly and the two used to carry
    // opposite signs, so the only two scrolling surfaces in the scene slid
    // apart under the notes.
    for (const approachSec of approaches) {
      const deck = deckScrollPhase(1, approachSec) - deckScrollPhase(0, approachSec);
      const ground = groundScrollWorld(1, approachSec) - groundScrollWorld(0, approachSec);
      expect(Math.sign(deck)).toBe(Math.sign(ground));
    }
  });

  it('scrolls the deck at exactly a note\'s speed', () => {
    for (const approachSec of approaches) {
      // One second of song moves the pattern by one second of note travel.
      const periods = deckScrollPhase(1, approachSec) - deckScrollPhase(0, approachSec);
      expect(periods * DECK_RUNG_PERIOD).toBeCloseTo(noteWorldSpeed(approachSec), 6);
    }
  });

  it('runs the ground at the documented fraction of the deck', () => {
    for (const approachSec of approaches) {
      const deckWorld = deckScrollPhase(1, approachSec) * DECK_RUNG_PERIOD;
      expect(groundScrollWorld(1, approachSec)).toBeCloseTo(deckWorld * GROUND_SCROLL_FRACTION, 6);
    }
  });

  it('follows the player\'s scroll-speed setting for free', () => {
    // `approachSecFor` divides by the multiplier, so a 2x scroll speed halves
    // the approach — and the scenery has to keep up without its own knob.
    const base = 1.3;
    expect(deckScrollPhase(1, base / 2)).toBeCloseTo(deckScrollPhase(1, base) * 2, 6);
  });

  it('is monotonic and zero at the song\'s origin', () => {
    for (const approachSec of approaches) {
      expect(deckScrollPhase(0, approachSec)).toBe(0);
      expect(groundScrollWorld(0, approachSec)).toBe(0);
      // The lead-in runs negative song time; the pattern must simply run the
      // other way rather than jump when the song crosses zero.
      expect(deckScrollPhase(-1, approachSec)).toBeLessThan(0);
    }
  });

  it('escalates with difficulty, because the notes do', () => {
    const speeds = approaches.map(noteWorldSpeed);
    expect(Math.max(...speeds)).toBeGreaterThan(Math.min(...speeds));
    for (const approachSec of approaches) {
      expect(deckScrollPhase(1, approachSec)).toBeGreaterThan(0);
    }
  });

  /**
   * The shape guard. The rung crest is a raised cosine specifically so it
   * cannot alias at these speeds: at the old 12%-duty crest, extreme's 26.3
   * units/sec put the whole band through in ~10ms — under two frames at 120Hz.
   */
  it('would transit a narrow crest in under two frames at 120Hz', () => {
    const fastest = Math.max(...approaches.map(noteWorldSpeed));
    const narrowCrestSec = (DECK_RUNG_PERIOD * 0.12) / fastest;
    expect(narrowCrestSec).toBeLessThan(2 / 120);
  });
});

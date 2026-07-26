import type { Note } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { GRADES, capGrade } from './judge.js';
import {
  DEFAULT_MODIFIERS,
  type Modifiers,
  gradeCeiling,
  isAssisted,
  isDefaultModifiers,
  mirrorNotes,
  scoreMultiplierFor,
} from './modifiers.js';

describe('DEFAULT_MODIFIERS', () => {
  it('is a plain, unmodified run', () => {
    expect(isDefaultModifiers(DEFAULT_MODIFIERS)).toBe(true);
    expect(DEFAULT_MODIFIERS.speed).toBe(1);
    expect(DEFAULT_MODIFIERS.fail).toBe(false);
  });
});

describe('isDefaultModifiers', () => {
  it('is false the moment any single modifier changes', () => {
    expect(isDefaultModifiers({ ...DEFAULT_MODIFIERS, fail: true })).toBe(false);
    expect(isDefaultModifiers({ ...DEFAULT_MODIFIERS, mirror: true })).toBe(false);
    expect(isDefaultModifiers({ ...DEFAULT_MODIFIERS, visibility: 'hidden' })).toBe(false);
    expect(isDefaultModifiers({ ...DEFAULT_MODIFIERS, speed: 1.25 })).toBe(false);
    // Holds are on by default, so turning them *off* is the change.
    expect(isDefaultModifiers({ ...DEFAULT_MODIFIERS, holds: false })).toBe(false);
  });
});

/**
 * Assist is not the inverse of default — most modifiers make the game *harder*,
 * and a record set under one of those deserves to stand. Getting this backwards
 * would either lock real bests out of the board or let easy runs eat them.
 */
describe('isAssisted', () => {
  it('is false for a plain run', () => {
    expect(isAssisted(DEFAULT_MODIFIERS)).toBe(false);
  });

  it('is true only for the two easings: slower, and holds demoted to taps', () => {
    expect(isAssisted({ ...DEFAULT_MODIFIERS, speed: 0.75 })).toBe(true);
    expect(isAssisted({ ...DEFAULT_MODIFIERS, holds: false })).toBe(true);
  });

  it('is false for modifiers that make the run harder or leave it level', () => {
    expect(isAssisted({ ...DEFAULT_MODIFIERS, speed: 1.5 })).toBe(false);
    expect(isAssisted({ ...DEFAULT_MODIFIERS, fail: true })).toBe(false);
    expect(isAssisted({ ...DEFAULT_MODIFIERS, visibility: 'hidden' })).toBe(false);
    expect(isAssisted({ ...DEFAULT_MODIFIERS, visibility: 'fadeout' })).toBe(false);
    // Mirror moves which hand plays which note, not how hard any of it is.
    expect(isAssisted({ ...DEFAULT_MODIFIERS, mirror: true })).toBe(false);
  });

  it('is not merely the inverse of isDefaultModifiers', () => {
    const harder = { ...DEFAULT_MODIFIERS, visibility: 'hidden' as const };
    expect(isDefaultModifiers(harder)).toBe(false);
    expect(isAssisted(harder)).toBe(false);
  });
});

describe('mirrorNotes', () => {
  const notes: Note[] = [
    { t: 0, lane: 0, type: 'tap' },
    { t: 1, lane: 3, type: 'tap' },
    { t: 2, lane: 1, type: 'hold', duration: 0.5 },
  ];

  it('flips every lane across the board', () => {
    const mirrored = mirrorNotes(notes, 4);
    expect(mirrored.map((n) => n.lane)).toEqual([3, 0, 2]);
  });

  it('is an involution — mirroring twice is the original', () => {
    const twice = mirrorNotes(mirrorNotes(notes, 4), 4);
    expect(twice.map((n) => n.lane)).toEqual(notes.map((n) => n.lane));
  });

  it('preserves time, type and duration', () => {
    const mirrored = mirrorNotes(notes, 4);
    expect(mirrored[2]).toMatchObject({ t: 2, type: 'hold', duration: 0.5 });
  });

  it('does not mutate the input notes', () => {
    const before = notes.map((n) => n.lane);
    mirrorNotes(notes, 4);
    expect(notes.map((n) => n.lane)).toEqual(before);
  });
});

describe('scoreMultiplierFor', () => {
  it('is 1 for every setting in v1', () => {
    expect(scoreMultiplierFor(DEFAULT_MODIFIERS)).toBe(1);
    expect(scoreMultiplierFor({ ...DEFAULT_MODIFIERS, speed: 1.5, fail: true })).toBe(1);
  });
});

/**
 * The grade ceiling (deliverable 23).
 *
 * The invariant that matters is not the ceiling value — it is that the ceiling and
 * the personal-best slot rule share ONE definition of "assisted". If they ever
 * diverge, a run can hold a clean record while showing a grade it could not have
 * earned, or the reverse.
 */
describe('gradeCeiling', () => {
  it('allows S on a clean run', () => {
    expect(gradeCeiling(DEFAULT_MODIFIERS)).toBe('S');
  });

  it('caps an assisted run below the top grade', () => {
    expect(gradeCeiling({ ...DEFAULT_MODIFIERS, speed: 0.75 })).toBe('A');
    expect(gradeCeiling({ ...DEFAULT_MODIFIERS, holds: false })).toBe('A');
  });

  it('leaves the harder modifiers at the full ceiling', () => {
    // These make a run harder, so a record set under them is worth at least as
    // much as a clean one — the same reasoning `isAssisted` encodes.
    for (const mods of [
      { ...DEFAULT_MODIFIERS, fail: true },
      { ...DEFAULT_MODIFIERS, mirror: true },
      { ...DEFAULT_MODIFIERS, visibility: 'hidden' as const },
      { ...DEFAULT_MODIFIERS, speed: 1.5 },
    ]) {
      expect(gradeCeiling(mods)).toBe('S');
    }
  });

  it('agrees with isAssisted for every single-modifier set', () => {
    // One definition, checked rather than assumed.
    const sets: Modifiers[] = [
      DEFAULT_MODIFIERS,
      { ...DEFAULT_MODIFIERS, fail: true },
      { ...DEFAULT_MODIFIERS, mirror: true },
      { ...DEFAULT_MODIFIERS, visibility: 'hidden' },
      { ...DEFAULT_MODIFIERS, visibility: 'fadeout' },
      { ...DEFAULT_MODIFIERS, speed: 0.75 },
      { ...DEFAULT_MODIFIERS, speed: 1.25 },
      { ...DEFAULT_MODIFIERS, speed: 1.5 },
      { ...DEFAULT_MODIFIERS, holds: false },
    ];
    for (const mods of sets) {
      expect(gradeCeiling(mods) === 'A', JSON.stringify(mods)).toBe(isAssisted(mods));
    }
  });
});

describe('capGrade', () => {
  it('leaves a grade at or under the ceiling alone', () => {
    expect(capGrade('A', 'S')).toBe('A');
    expect(capGrade('S', 'S')).toBe('S');
    expect(capGrade('F', 'A')).toBe('F');
    expect(capGrade('A', 'A')).toBe('A');
  });

  it('clamps a grade above the ceiling down to it', () => {
    expect(capGrade('S', 'A')).toBe('A');
  });

  it('never promotes a bad run', () => {
    // A ceiling is a maximum, not a target — every grade under it must survive.
    for (const earned of GRADES) {
      const capped = capGrade(earned, 'A');
      expect(GRADES.indexOf(capped)).toBeLessThanOrEqual(GRADES.indexOf(earned));
    }
  });
});

import type { Note } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODIFIERS,
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

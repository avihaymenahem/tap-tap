import type { Note } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { TICK_LOOKAHEAD_SEC, cursorAt, ticksInWindow } from './tickSchedule.js';

const tap = (t: number, lane = 0): Note => ({ t, lane, type: 'tap' });

/** Quarter notes at 120 BPM. */
const notes: Note[] = [0, 0.5, 1, 1.5, 2, 2.5, 3].map((t) => tap(t));

describe('ticksInWindow', () => {
  it('returns the times inside the window and advances the cursor past them', () => {
    const { times, cursor } = ticksInWindow(notes, 0, -1, 1);
    expect(times).toEqual([0, 0.5, 1]);
    expect(cursor).toBe(3);
  });

  it('hands out each time exactly once across overlapping calls', () => {
    // The render loop calls this every frame with windows that overlap heavily. A
    // time scheduled twice is two oscillators at one instant — an audible flam.
    let cursor = 0;
    const all: number[] = [];
    for (let songTime = 0; songTime < 3.5; songTime += 1 / 60) {
      const w = ticksInWindow(notes, cursor, songTime, songTime + TICK_LOOKAHEAD_SEC);
      all.push(...w.times);
      cursor = w.cursor;
    }
    expect(all).toEqual([...new Set(all)]);
    // Every note past the first window's lower bound is covered. The note at t=0
    // is behind the very first window (`from` is exclusive), which the intro
    // cursor handles in practice.
    expect(all).toEqual([0.5, 1, 1.5, 2, 2.5, 3]);
  });

  it('is exclusive at the lower bound and inclusive at the upper', () => {
    // Exclusive below, or a note exactly on the playhead would be re-issued every
    // frame it sat there.
    expect(ticksInWindow(notes, 0, 0.5, 1).times).toEqual([1]);
  });

  it('de-duplicates chord voices sharing a timestamp', () => {
    const chorded: Note[] = [tap(0.5, 0), tap(0.5, 2), tap(1, 1)];
    expect(ticksInWindow(chorded, 0, 0, 1).times).toEqual([0.5, 1]);
  });

  it('drops notes skipped over by a stall rather than firing them in a burst', () => {
    // A long frame leaves several notes behind the window. Firing them all at once
    // is a cluster of clicks at one instant, which is worse than the silence.
    const { times, cursor } = ticksInWindow(notes, 0, 2, 2.5);
    expect(times).toEqual([2.5]);
    expect(cursor).toBe(6);
  });

  it('returns nothing once past the end, without running off the array', () => {
    const { times, cursor } = ticksInWindow(notes, 0, 10, 20);
    expect(times).toEqual([]);
    expect(cursor).toBe(notes.length);
  });

  it('handles an empty chart', () => {
    expect(ticksInWindow([], 0, 0, 1)).toEqual({ times: [], cursor: 0 });
  });

  it('tolerates a cursor already past the window', () => {
    // Resuming can hand back a cursor ahead of the playhead; it must not re-issue
    // earlier notes.
    expect(ticksInWindow(notes, 5, 0, 3).times).toEqual([2.5, 3]);
  });
});

describe('cursorAt', () => {
  it('points past every note at or before the given time', () => {
    expect(cursorAt(notes, -1)).toBe(0);
    expect(cursorAt(notes, 0)).toBe(1);
    expect(cursorAt(notes, 1.2)).toBe(3);
    expect(cursorAt(notes, 99)).toBe(notes.length);
  });

  it('lines up with what ticksInWindow would already have consumed', () => {
    // The two must agree, or resuming from a pause either repeats a tick or drops
    // one at the seam.
    for (const at of [0, 0.5, 0.75, 1, 2.5, 3]) {
      const viaWindow = ticksInWindow(notes, 0, -1, at).cursor;
      expect(cursorAt(notes, at), `at ${at}`).toBe(viaWindow);
    }
  });

  it('handles an empty chart', () => {
    expect(cursorAt([], 5)).toBe(0);
  });
});

describe('TICK_LOOKAHEAD_SEC', () => {
  it('is longer than a frame at 60fps, with room for a hitch', () => {
    // A window shorter than the frame interval would drop ticks continuously; one
    // barely longer would drop them on any stutter.
    expect(TICK_LOOKAHEAD_SEC).toBeGreaterThan((1 / 60) * 4);
    // And short enough that a pause leaves only a handful pending.
    expect(TICK_LOOKAHEAD_SEC).toBeLessThan(1);
  });
});

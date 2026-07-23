import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RESULTS_GAIN_BOOST,
  RESULTS_SOUNDS,
  UI_SOUNDS,
  UI_SFX_MASTER_GAIN,
  type UiSoundName,
} from './uisfx.js';

/**
 * The sound palette is data, so its design rules are testable without an
 * AudioContext — the same philosophy as testing DSP against synthetic audio.
 */

const NAMES = Object.keys(UI_SOUNDS) as UiSoundName[];

describe('UI_SOUNDS palette', () => {
  it('keeps every note well-formed', () => {
    for (const name of NAMES) {
      for (const note of UI_SOUNDS[name]) {
        expect(note.freq, `${name} freq`).toBeGreaterThan(20);
        expect(note.freq, `${name} freq`).toBeLessThan(20000);
        expect(note.dur, `${name} dur`).toBeGreaterThan(0);
        expect(note.at, `${name} at`).toBeGreaterThanOrEqual(0);
        expect(note.gain, `${name} gain`).toBeGreaterThan(0);
        // Headroom rule: these sounds layer over music and the metronome, so
        // no single note may approach full scale even before the master gain.
        expect(note.gain, `${name} gain`).toBeLessThanOrEqual(0.2);
        if (note.slideTo !== undefined) {
          expect(note.slideTo, `${name} slideTo`).toBeGreaterThan(20);
        }
      }
    }
    expect(UI_SFX_MASTER_GAIN).toBeGreaterThan(0);
    expect(UI_SFX_MASTER_GAIN).toBeLessThanOrEqual(1);
  });

  it('keeps every sound short — UI feedback, not music', () => {
    for (const name of NAMES) {
      const end = Math.max(...UI_SOUNDS[name].map((n) => n.at + n.dur));
      expect(end, name).toBeLessThanOrEqual(0.6);
    }
  });

  it('makes positive cues rise and negative cues fall', () => {
    const pitchDirection = (name: UiSoundName): number => {
      const notes = UI_SOUNDS[name];
      const first = notes[0]!;
      const last = notes[notes.length - 1]!;
      return (last.slideTo ?? last.freq) - first.freq;
    };
    // Commit/celebrate sounds go up; dismiss/lose sounds go down. This is the
    // one piece of audio language players already know, and swapping it would
    // make the whole layer feel subtly wrong.
    expect(pitchDirection('confirm')).toBeGreaterThan(0);
    expect(pitchDirection('milestone')).toBeGreaterThan(0);
    expect(pitchDirection('newBest')).toBeGreaterThan(0);
    expect(pitchDirection('back')).toBeLessThan(0);
    expect(pitchDirection('comboBreak')).toBeLessThan(0);
    expect(pitchDirection('fail')).toBeLessThan(0);
  });

  it('keeps the tally tick nearly silent relative to the sounds around it', () => {
    // The tick fires many times in under a second during the score count-up;
    // at ordinary gain it would be a machine gun over the fanfare.
    const tick = UI_SOUNDS.tallyTick[0]!;
    const end = UI_SOUNDS.tallyEnd[0]!;
    expect(tick.gain).toBeLessThan(end.gain / 2);
    expect(tick.dur).toBeLessThan(0.05);
  });

  it('distinguishes GO from the count beeps by both pitch and length', () => {
    const count = UI_SOUNDS.count[0]!;
    const go = UI_SOUNDS.go[0]!;
    expect(go.freq).toBeGreaterThan(count.freq);
    expect(go.dur).toBeGreaterThan(count.dur);
  });
});

describe('results cues (boost + reverb)', () => {
  it('boosts and wets exactly the post-song cues', () => {
    // These play after the song ends, so nothing competes and they can be loud
    // and reverbed. The tap cues sit under music and must stay dry and quiet.
    expect([...RESULTS_SOUNDS].sort()).toEqual(['fail', 'fanfare', 'newBest', 'tallyEnd']);
    for (const dry of ['tick', 'confirm', 'back', 'count', 'go', 'tallyTick'] as UiSoundName[]) {
      expect(RESULTS_SOUNDS.has(dry), dry).toBe(false);
    }
  });

  it('actually makes them louder', () => {
    expect(RESULTS_GAIN_BOOST).toBeGreaterThan(1);
  });

  it('keeps the boosted peak under full scale', () => {
    // The boost lives at playback, not in the data, so the base headroom rule
    // still passes — but the boosted result must not clip either.
    for (const name of RESULTS_SOUNDS) {
      for (const note of UI_SOUNDS[name]) {
        expect(note.gain * UI_SFX_MASTER_GAIN * RESULTS_GAIN_BOOST, name).toBeLessThan(1);
      }
    }
  });
});

describe('mute toggle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Fresh module copy so the cached flag from other tests cannot leak in. */
  async function freshSfx(stored?: string) {
    vi.resetModules();
    const store = new Map<string, string>();
    if (stored !== undefined) store.set('tap-tap.uiSound', stored);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    return { mod: await import('./uisfx.js'), store };
  }

  it('defaults to on', async () => {
    const { mod } = await freshSfx();
    expect(mod.uiSoundEnabled()).toBe(true);
  });

  it('honours a stored off', async () => {
    const { mod } = await freshSfx('off');
    expect(mod.uiSoundEnabled()).toBe(false);
  });

  it('persists and caches a change', async () => {
    const { mod, store } = await freshSfx();
    mod.setUiSoundEnabled(false);
    expect(store.get('tap-tap.uiSound')).toBe('off');
    expect(mod.uiSoundEnabled()).toBe(false);
    mod.setUiSoundEnabled(true);
    expect(store.get('tap-tap.uiSound')).toBe('on');
    expect(mod.uiSoundEnabled()).toBe(true);
  });

  it('playUiSound never throws without WebAudio', async () => {
    const { mod } = await freshSfx();
    // Node has no AudioContext global at all — the call must swallow that.
    expect(() => mod.playUiSound('tick')).not.toThrow();
  });
});

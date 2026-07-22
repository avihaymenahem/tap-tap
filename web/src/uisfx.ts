/**
 * UI sound effects, synthesized in WebAudio — no audio files.
 *
 * Menus that are silent are the loudest tell that this is a web page and not a
 * game. Everything here follows the crowd-cheer precedent in `game/clock.ts`:
 * hand-rolled oscillators instead of shipped samples, so there is nothing to
 * license, cache, or load.
 *
 * Design rules:
 * - Every sound is data first (`UI_SOUNDS`) and playback second, so the sound
 *   design is unit-testable without an AudioContext.
 * - One lazily-created context, resumed on use. The first play always happens
 *   inside a user gesture (these are UI sounds), so autoplay policy is
 *   satisfied by construction.
 * - The enabled flag is cached exactly like `haptics.ts` caches its mode:
 *   `play` is called from latency-sensitive paths and a localStorage read is a
 *   synchronous disk hit.
 * - Quiet on purpose. UI sounds sit under music on the results screen and
 *   under the metronome in calibration; they must never compete.
 */

export type UiSoundName =
  | 'tick' // hovering/selecting a song or difficulty
  | 'confirm' // PLAY / start — committing to something
  | 'back' // dismiss, cancel, resume-from-pause
  | 'count' // countdown digit
  | 'go' // countdown GO
  | 'milestone' // combo milestone reached
  | 'comboBreak' // combo lost
  | 'fanfare' // results reveal
  | 'tallyTick' // score count-up tick
  | 'tallyEnd' // score count-up lands
  | 'newBest'; // new best sting

/** One scheduled oscillator note inside a sound. Times are in seconds. */
export interface UiNote {
  /** Oscillator frequency in Hz. */
  freq: number;
  /** Optional glide target — the note slides from `freq` to this over `dur`. */
  slideTo?: number;
  /** Offset from the sound's start. */
  at: number;
  /** Length of the note's envelope. */
  dur: number;
  /** Peak gain, pre master. Kept well under 1 — these layer over music. */
  gain: number;
  type: OscillatorType;
}

/**
 * The entire sound palette as data.
 *
 * Tuning notes: everything lives loosely in A/E major around the 500-1600Hz
 * band — high enough to cut through a mix without any bass to muddy the song,
 * related enough that two sounds heard together do not clash. "Positive"
 * sounds rise, "negative" ones fall; that mapping is the one piece of audio
 * language players already know.
 */
export const UI_SOUNDS: Record<UiSoundName, readonly UiNote[]> = {
  tick: [{ freq: 1320, at: 0, dur: 0.045, gain: 0.1, type: 'triangle' }],

  confirm: [
    { freq: 660, at: 0, dur: 0.08, gain: 0.16, type: 'triangle' },
    { freq: 880, at: 0.07, dur: 0.12, gain: 0.18, type: 'triangle' },
  ],

  back: [
    { freq: 587, at: 0, dur: 0.07, gain: 0.12, type: 'triangle' },
    { freq: 440, at: 0.06, dur: 0.09, gain: 0.1, type: 'triangle' },
  ],

  count: [{ freq: 880, at: 0, dur: 0.09, gain: 0.16, type: 'square' }],

  // A fifth up from the count beep and twice as long — the classic "last one
  // is different" cue every rhythm game uses.
  go: [
    { freq: 1320, at: 0, dur: 0.22, gain: 0.18, type: 'square' },
    { freq: 1760, at: 0.02, dur: 0.2, gain: 0.08, type: 'triangle' },
  ],

  milestone: [
    { freq: 659, at: 0, dur: 0.07, gain: 0.14, type: 'triangle' },
    { freq: 880, at: 0.055, dur: 0.07, gain: 0.15, type: 'triangle' },
    { freq: 1318, at: 0.11, dur: 0.16, gain: 0.16, type: 'triangle' },
  ],

  // Low, soft, brief. Losing a combo already stings; the sound acknowledges
  // it without rubbing it in — and it must never resemble the miss buzz.
  comboBreak: [{ freq: 220, slideTo: 150, at: 0, dur: 0.16, gain: 0.1, type: 'sine' }],

  // A major chord rolled fast, then its octave on top: short enough not to
  // delay the score tally that follows it.
  fanfare: [
    { freq: 523, at: 0, dur: 0.4, gain: 0.12, type: 'triangle' },
    { freq: 659, at: 0.05, dur: 0.38, gain: 0.12, type: 'triangle' },
    { freq: 784, at: 0.1, dur: 0.36, gain: 0.12, type: 'triangle' },
    { freq: 1046, at: 0.16, dur: 0.42, gain: 0.14, type: 'triangle' },
  ],

  tallyTick: [{ freq: 1980, at: 0, dur: 0.02, gain: 0.05, type: 'square' }],

  tallyEnd: [
    { freq: 880, at: 0, dur: 0.22, gain: 0.16, type: 'triangle' },
    { freq: 1108, at: 0, dur: 0.22, gain: 0.12, type: 'triangle' },
    { freq: 440, at: 0, dur: 0.26, gain: 0.1, type: 'sine' },
  ],

  // An upward sparkle reserved for one moment. Deliberately the only sound
  // that reaches above 2kHz, so a new best is audibly "brighter" than
  // anything else in the app.
  newBest: [
    { freq: 1046, at: 0, dur: 0.09, gain: 0.12, type: 'triangle' },
    { freq: 1318, at: 0.08, dur: 0.09, gain: 0.13, type: 'triangle' },
    { freq: 1568, at: 0.16, dur: 0.1, gain: 0.14, type: 'triangle' },
    { freq: 2093, at: 0.24, dur: 0.28, gain: 0.15, type: 'triangle' },
  ],
};

/** Master level for all UI sounds. One knob so the whole layer mixes at once. */
export const UI_SFX_MASTER_GAIN = 0.6;

const STORAGE_KEY = 'tap-tap.uiSound';

/*
 * Cached for the same reason `haptics.ts` caches its mode: `play` runs on
 * taps, and a localStorage read there is a synchronous disk-backed stall.
 */
let cachedEnabled: boolean | null = null;

export function uiSoundEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    cachedEnabled = localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    cachedEnabled = true;
  }
  return cachedEnabled;
}

export function setUiSoundEnabled(enabled: boolean): void {
  cachedEnabled = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Private mode — the setting just will not persist.
  }
}

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    return null; // No WebAudio — sounds silently do not exist.
  }
  return ctx;
}

/**
 * Play one named sound now.
 *
 * Safe to call from anywhere: it no-ops when muted, when WebAudio is missing,
 * and when the context cannot resume. Never throws — a missing click sound
 * must not break the click.
 */
export function playUiSound(name: UiSoundName): void {
  if (!uiSoundEnabled()) return;
  const audio = context();
  if (!audio) return;

  try {
    // Resumed, not awaited: if the context is suspended the browser resumes it
    // within this same gesture and the sound starts a frame late at worst.
    if (audio.state === 'suspended') void audio.resume();

    const now = audio.currentTime;
    for (const note of UI_SOUNDS[name]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const at = now + note.at;

      osc.type = note.type;
      osc.frequency.setValueAtTime(note.freq, at);
      if (note.slideTo !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(note.slideTo, at + note.dur);
      }

      // 3ms attack: fast enough to feel instant, slow enough not to click.
      const peak = note.gain * UI_SFX_MASTER_GAIN;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), at + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);

      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(at);
      osc.stop(at + note.dur + 0.02);
    }
  } catch {
    // A failed sound is not an error worth surfacing.
  }
}

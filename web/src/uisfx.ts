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
 *   under the metronome in calibration; they must never compete. The one
 *   exception is the game-end trio (`fanfare`/`tallyEnd`/`newBest`): they play
 *   on the results screen *after* the song has stopped, so nothing competes
 *   with them. Those get boosted (`RESULTS_GAIN_BOOST`) and routed through a
 *   synthesized reverb (`RESULTS_SOUNDS`), which is why they land as a moment
 *   rather than a polite blip.
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
  | 'newBest' // new best sting
  | 'fail'; // run failed — game over

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

  // Game over: a slow descending minor cadence with a sub-bass drop under it.
  // The opposite shape of the fanfare — where that rolls a major chord *up*,
  // this falls and sinks. It plays after the song has stopped, so it is boosted
  // and reverbed (RESULTS_SOUNDS) to land as a moment rather than a blip.
  fail: [
    { freq: 415, at: 0, dur: 0.2, gain: 0.16, type: 'triangle' },
    { freq: 311, at: 0.16, dur: 0.22, gain: 0.16, type: 'triangle' },
    { freq: 208, at: 0.32, dur: 0.27, gain: 0.17, type: 'sine' },
    { freq: 155, slideTo: 104, at: 0.32, dur: 0.27, gain: 0.14, type: 'sine' },
  ],
};

/** Master level for all UI sounds. One knob so the whole layer mixes at once. */
export const UI_SFX_MASTER_GAIN = 0.6;

/**
 * The game-end cues. They fire on the results screen after the song has ended,
 * so unlike every other sound here they have nothing to sit under — they are
 * boosted and reverbed to feel like a celebration rather than another UI blip.
 *
 * Kept as data (a name set + a scalar) rather than baked into `UI_SOUNDS` so the
 * headroom rule in `uisfx.test.ts` still holds for the base palette: the boost
 * lives at playback, not in the note gains.
 */
export const RESULTS_SOUNDS: ReadonlySet<UiSoundName> = new Set<UiSoundName>([
  'fanfare',
  'tallyEnd',
  'newBest',
  // The fail sting plays after the song stops too, so it gets the same boost and
  // reverb — a game-over should feel weighty, not like a dismissed dialog.
  'fail',
]);

/** How much louder the results trio plays than its authored gain. */
export const RESULTS_GAIN_BOOST = 1.7;

/** Synthesized reverb, shared by the results cues. Seconds, decay curve, wet mix. */
const REVERB_SECONDS = 1.7;
const REVERB_DECAY = 3.4;
const REVERB_WET = 0.55;

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
 * A short hall as a decaying-noise impulse — hand-rolled, no asset.
 *
 * Two independent channels give the tail a little stereo width. The exponential
 * `(1 - i/length) ** decay` envelope is the whole character: higher `decay`
 * means a tighter room, lower means a longer wash.
 */
function makeImpulse(audio: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.max(1, Math.floor(seconds * audio.sampleRate));
  const impulse = audio.createBuffer(2, length, audio.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
    }
  }
  return impulse;
}

let reverbInput: GainNode | null = null;

/**
 * The wet send for the results cues, built once.
 *
 * Returns the node to connect a source's gain into; the convolver and wet-level
 * gain behind it are shared, so the reverb tail rings on past the note that fed
 * it. Built lazily like the context, and null-safe: a failure here must not stop
 * the dry sound from playing.
 */
function reverbBus(audio: AudioContext): GainNode | null {
  if (reverbInput) return reverbInput;
  try {
    const convolver = audio.createConvolver();
    convolver.buffer = makeImpulse(audio, REVERB_SECONDS, REVERB_DECAY);
    const wet = audio.createGain();
    wet.gain.value = REVERB_WET;
    const input = audio.createGain();
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(audio.destination);
    reverbInput = input;
  } catch {
    return null;
  }
  return reverbInput;
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

    // The results trio is louder and wet; everything else is dry at base level.
    const isResults = RESULTS_SOUNDS.has(name);
    const boost = isResults ? RESULTS_GAIN_BOOST : 1;
    const wetSend = isResults ? reverbBus(audio) : null;

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
      const peak = note.gain * UI_SFX_MASTER_GAIN * boost;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), at + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);

      osc.connect(gain);
      gain.connect(audio.destination);
      // Feed the shared reverb in parallel with the dry path; its tail rings on
      // past the note. Only the results cues send, so taps and ticks stay dry.
      if (wetSend) gain.connect(wetSend);
      osc.start(at);
      osc.stop(at + note.dur + 0.02);
    }
  } catch {
    // A failed sound is not an error worth surfacing.
  }
}

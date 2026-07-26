/**
 * Mixer levels — music and effects, per device.
 *
 * Gameplay audio now runs through a real bus structure inside `AudioClock`
 * (music → duck → outro filter → analyser → musicVol → master), so there is
 * finally somewhere for a level to live. These are the persisted settings behind
 * the two menu switches.
 *
 * **UI sounds are deliberately not on this mixer.** `uisfx.ts` owns its own
 * `AudioContext`, created lazily the first time a menu makes a noise and alive
 * whether or not a song is loaded — while `AudioClock`'s context exists only for
 * the duration of a run. Routing menu clicks through a context that comes and goes
 * with the play screen would be worse than leaving them alone, and they already
 * have their own mute. "One audio graph" means one graph for the *game's* audio.
 *
 * Cycling levels rather than sliders, matching every other device switch in the
 * menu — and the phone's own volume keys already cover fine-grained control. What
 * a mixer adds that hardware volume cannot is the *balance* between the two.
 */

/** Music levels, loudest first so the default is the head of the cycle. */
export const MUSIC_LEVELS: readonly number[] = [1, 0.7, 0.45];

/** Effect levels — ticks and the crowd cheer. Includes a full off. */
export const SFX_LEVELS: readonly number[] = [1, 0.65, 0.35, 0];

const MUSIC_KEY = 'tap-tap.musicLevel';
const SFX_KEY = 'tap-tap.sfxLevel';

const EPSILON = 1e-6;

/** Cached for the same reason every other audio setting here is: read on a hot path. */
let cachedMusic: number | null = null;
let cachedSfx: number | null = null;

function readLevel(key: string, offered: readonly number[]): number {
  try {
    const stored = Number.parseFloat(localStorage.getItem(key) ?? '');
    // A level no longer offered falls back to the default rather than snapping to
    // a neighbour nobody chose — the same rule `scrollSpeed.ts` follows.
    const match = offered.find((v) => Math.abs(v - stored) < EPSILON);
    return match ?? offered[0]!;
  } catch {
    return offered[0]!;
  }
}

export function musicLevel(): number {
  if (cachedMusic === null) cachedMusic = readLevel(MUSIC_KEY, MUSIC_LEVELS);
  return cachedMusic;
}

export function sfxLevel(): number {
  if (cachedSfx === null) cachedSfx = readLevel(SFX_KEY, SFX_LEVELS);
  return cachedSfx;
}

function store(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private mode — the choice just will not persist.
  }
}

export function setMusicLevel(level: number): void {
  cachedMusic = MUSIC_LEVELS.includes(level) ? level : MUSIC_LEVELS[0]!;
  store(MUSIC_KEY, cachedMusic);
}

export function setSfxLevel(level: number): void {
  cachedSfx = SFX_LEVELS.includes(level) ? level : SFX_LEVELS[0]!;
  store(SFX_KEY, cachedSfx);
}

/** Next level in the cycle, wrapping. */
export function nextLevel(level: number, offered: readonly number[]): number {
  const i = offered.findIndex((v) => Math.abs(v - level) < EPSILON);
  return offered[(i + 1) % offered.length] ?? offered[0]!;
}

/** `100%`, `70%`, `Off`. */
export function levelLabel(level: number): string {
  return level <= EPSILON ? 'Off' : `${Math.round(level * 100)}%`;
}

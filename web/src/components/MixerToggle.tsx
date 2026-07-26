import { useState, type JSX } from 'react';
import {
  MUSIC_LEVELS,
  SFX_LEVELS,
  levelLabel,
  musicLevel,
  nextLevel,
  setMusicLevel,
  setSfxLevel,
  sfxLevel,
} from '../mixer.js';
import { playUiSound } from '../uisfx.js';

/**
 * Cycles one of the two mixer levels.
 *
 * What this offers that the phone's own volume keys cannot is the *balance*
 * between the music and the game's effects — hardware volume moves both together.
 * Effects can go fully off; the music cannot, because a rhythm game with no music
 * is not a quieter game, it is a broken one.
 *
 * Applied live: the play screen pushes the levels onto the clock every frame it
 * matters, so a change made in the pause menu is audible immediately. That is the
 * difference from Graphics and Scroll speed, which are baked into the `Highway` at
 * construction and so have to wait for the next song.
 *
 * Reads stored state on mount rather than as a prop, like every device toggle here.
 */
export function MixerToggle({
  kind,
  className,
}: {
  kind: 'music' | 'sfx';
  className: string;
}): JSX.Element {
  const levels = kind === 'music' ? MUSIC_LEVELS : SFX_LEVELS;
  const read = kind === 'music' ? musicLevel : sfxLevel;
  const write = kind === 'music' ? setMusicLevel : setSfxLevel;

  const [level, setLevel] = useState(read);

  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      onClick={() => {
        // Cycle from the *stored* value, not from `level`: batched taps would all
        // read the same stale render value and advance a single step.
        const next = nextLevel(read(), levels);
        write(next);
        setLevel(next);
        playUiSound('tick');
      }}
    >
      <span>{kind === 'music' ? 'Music' : 'Effects'}</span>
      <span className={`dropdown__state ${level !== levels[0] ? 'dropdown__state--on' : ''}`}>
        {levelLabel(level)}
      </span>
    </button>
  );
}

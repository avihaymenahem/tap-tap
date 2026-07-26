import { useState, type JSX } from 'react';
import { noteTicksEnabled, setNoteTicks } from '../noteTicks.js';
import { playUiSound } from '../uisfx.js';

/**
 * Turns the per-note click on.
 *
 * The copy says "Note ticks" and nothing about hits, deliberately: the tick sounds
 * whether or not the note was hit, because a sound that lands on the beat has to be
 * scheduled before the beat, when the hit is unknowable (`game/tickSchedule.ts`).
 * Calling it "hit sound" would promise feedback it cannot give, and a player would
 * reasonably read a tick on a note they missed as a scoring bug.
 *
 * Sits in the menu next to the other audio switches. It takes effect on the next
 * song rather than mid-run — the scheduler is wired up when the play screen builds
 * its clock — which is also why there is no pause-overlay copy.
 *
 * Reads the stored value on mount rather than taking a prop, like every other
 * device toggle here.
 */
export function NoteTickToggle({ className }: { className: string }): JSX.Element {
  const [enabled, setEnabled] = useState(noteTicksEnabled);

  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      onClick={() => {
        // Flip the *stored* value, not `enabled` — batched taps would otherwise
        // all read the same stale render value.
        const next = !noteTicksEnabled();
        setNoteTicks(next);
        setEnabled(next);
        playUiSound('tick');
      }}
    >
      <span>Note ticks</span>
      <span className={`dropdown__state ${enabled ? 'dropdown__state--on' : ''}`}>
        {enabled ? 'On' : 'Off'}
      </span>
    </button>
  );
}

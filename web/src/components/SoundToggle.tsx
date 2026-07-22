import { useState, type JSX } from 'react';
import { playUiSound, setUiSoundEnabled, uiSoundEnabled } from '../uisfx.js';

/**
 * On/off switch for the UI sound layer.
 *
 * Shared by the main menu and the pause overlay, mirroring `HapticToggle` for
 * the same reason: sound is a setting players change because of where they are
 * (a quiet room, a bus), and it has to be reachable from inside a run.
 *
 * Reads the stored flag on mount rather than taking it as a prop, so the two
 * copies cannot disagree after one of them changes it.
 */
export function SoundToggle({ className }: { className: string }): JSX.Element {
  const [enabled, setEnabled] = useState(uiSoundEnabled);

  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      // Does not dismiss its container, matching HapticToggle: the point is to
      // see (and hear) the state change.
      onClick={() => {
        // Toggle from the *stored* flag, not from `enabled`, so the menu and
        // pause copies of this button cannot drift apart.
        const next = !uiSoundEnabled();
        setUiSoundEnabled(next);
        setEnabled(next);
        // Confirm the new state with the thing being changed — only audible
        // when turning on, which is exactly right.
        if (next) playUiSound('confirm');
      }}
    >
      <span>UI sound</span>
      <span className={`dropdown__state ${enabled ? 'dropdown__state--on' : ''}`}>
        {enabled ? 'On' : 'Off'}
      </span>
    </button>
  );
}

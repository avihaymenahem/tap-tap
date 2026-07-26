import { useState, type JSX } from 'react';
import { flashEffectsEnabled, setFlashEffects } from '../render/flash.js';

/**
 * Turns the beat flare on the backdrop off.
 *
 * Sits beside the vibration and sound toggles in both the main menu and the
 * pause overlay — the pause copy matters most here, because the flashing is
 * something a player discovers is a problem *during* a song, and making them
 * quit the run to reach the setting means they simply stop playing instead.
 *
 * The label says what it does and promises nothing. Copy like "epilepsy safe"
 * is out of the question: no software can make that claim, the flare is not the
 * only bright thing on screen, and a person who trusted it and was wrong is
 * exactly the person this control exists for.
 *
 * Reads the stored value on mount rather than taking a prop, so the two copies
 * cannot disagree after either one changes it.
 */
export function FlashToggle({ className }: { className: string }): JSX.Element {
  const [enabled, setEnabled] = useState(flashEffectsEnabled);

  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      onClick={() => {
        // Flip the *stored* value, not `enabled` — the menu and pause copies
        // would otherwise drift apart once either one changed it.
        const next = !flashEffectsEnabled();
        setFlashEffects(next);
        setEnabled(next);
      }}
    >
      <span>Screen flash</span>
      <span className={`dropdown__state ${enabled ? 'dropdown__state--on' : ''}`}>
        {enabled ? 'On' : 'Off'}
      </span>
    </button>
  );
}

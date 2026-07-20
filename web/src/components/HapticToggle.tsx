import { useState, type JSX } from 'react';
import {
  HAPTIC_MODE_LABELS,
  getHapticMode,
  hapticsSupported,
  nextHapticMode,
  setHapticMode,
  vibratePreview,
} from '../haptics.js';

/**
 * Cycles vibration off → hits → misses.
 *
 * Shared by the main menu and the pause overlay. The pause menu matters more
 * than it looks: vibration is the one setting a player wants to change *because
 * of* what just happened to them, and making them quit a run to reach it means
 * they simply never change it.
 *
 * Reads the stored mode on mount rather than taking it as a prop, so the two
 * copies cannot disagree after one of them changes it.
 */
export function HapticToggle({ className }: { className: string }): JSX.Element | null {
  const [mode, setMode] = useState(getHapticMode);

  // Hidden entirely where the device cannot vibrate — an inert toggle is worse
  // than no toggle.
  if (!hapticsSupported()) return null;

  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      // Does not dismiss its container on purpose: the point is to see the
      // state change, and to cycle through modes to find one that feels right.
      onClick={() => {
        // Cycle from the *stored* mode, not from `mode`. Two reasons: taps
        // close enough together to batch would otherwise all read the same
        // stale render value and advance a single step, and the menu and pause
        // copies of this button would drift apart once either one changed it.
        const next = nextHapticMode(getHapticMode());
        setHapticMode(next);
        setMode(next);
        // Confirm the new state with the thing being changed.
        if (next !== 'off') vibratePreview();
      }}
    >
      <span>Vibration</span>
      <span className={`dropdown__state ${mode !== 'off' ? 'dropdown__state--on' : ''}`}>
        {HAPTIC_MODE_LABELS[mode]}
      </span>
    </button>
  );
}

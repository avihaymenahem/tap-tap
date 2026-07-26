import { useState, type JSX } from 'react';
import {
  DEFAULT_SCROLL_SPEED,
  getScrollSpeed,
  nextScrollSpeed,
  scrollSpeedLabel,
  setScrollSpeed,
} from '../scrollSpeed.js';
import { playUiSound } from '../uisfx.js';

/**
 * Cycles how fast notes travel the highway: 0.75x → 1x → 1.25x → 1.5x → 2x.
 *
 * Reading speed is a personal trait rather than a difficulty level, which is why
 * this is a device setting and not a run modifier — see `scrollSpeed.ts` for why
 * it is deliberately *not* an assist.
 *
 * Takes effect on the **next song**, like Graphics and for the same reason: the
 * approach time is handed to the `Highway` at construction, so a live screen keeps
 * the value it was built with. The menu is where that is true anyway.
 *
 * Reads the stored value on mount rather than taking a prop, so this and any other
 * copy cannot disagree after either one changes it — the pattern every device
 * toggle here follows.
 */
export function ScrollSpeedToggle({ className }: { className: string }): JSX.Element {
  const [speed, setSpeed] = useState(getScrollSpeed);

  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      onClick={() => {
        // Cycle from the *stored* value, not from `speed`: batched taps would
        // otherwise all read the same stale render value and advance one step.
        const next = nextScrollSpeed(getScrollSpeed());
        setScrollSpeed(next);
        setSpeed(next);
        playUiSound('tick');
      }}
    >
      <span>Scroll speed</span>
      <span
        className={`dropdown__state ${speed !== DEFAULT_SCROLL_SPEED ? 'dropdown__state--on' : ''}`}
      >
        {scrollSpeedLabel(speed)}
      </span>
    </button>
  );
}

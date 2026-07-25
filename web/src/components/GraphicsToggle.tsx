import { useState, type JSX } from 'react';
import {
  QUALITY_SETTING_LABELS,
  getQualitySetting,
  nextQualitySetting,
  setQualitySetting,
} from '../render/quality.js';
import { playUiSound } from '../uisfx.js';

/**
 * Cycles rendering quality: Auto → High → Low.
 *
 * `Auto` lets the renderer pick and downgrade on a weak GPU by itself; `Low`
 * pins the stripped-down pipeline (no bloom, lower resolution) for a device that
 * cannot hold 60fps — the reason this exists is a budget phone (a Xiaomi Redmi)
 * running the full look at a crawl. `High` forces the full look back on.
 *
 * Takes effect on the **next song**, not the current frame: the quality tier is
 * baked into the `Highway` at construction (bloom on/off changes the whole
 * render pipeline), so a live screen keeps its tier until it is rebuilt. The
 * menu is exactly where that is true anyway.
 *
 * Reads the stored setting on mount rather than as a prop, so the menu and pause
 * copies cannot disagree after one changes it — the same pattern as the haptics
 * and sound toggles.
 */
export function GraphicsToggle({ className }: { className: string }): JSX.Element {
  const [setting, setSetting] = useState(getQualitySetting);

  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      // Stays open like the other device toggles: the point is to see the state
      // cycle and land on the one you want.
      onClick={() => {
        // Cycle from the *stored* value, not from `setting`: batched taps would
        // otherwise all read the same stale render value and advance one step.
        const next = nextQualitySetting(getQualitySetting());
        setQualitySetting(next);
        setSetting(next);
        playUiSound('tick');
      }}
    >
      <span>Graphics</span>
      <span className={`dropdown__state ${setting !== 'auto' ? 'dropdown__state--on' : ''}`}>
        {QUALITY_SETTING_LABELS[setting]}
      </span>
    </button>
  );
}

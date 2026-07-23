import type { CSSProperties, JSX } from 'react';
import type { Modifiers } from '../game/modifiers.js';
import { playUiSound } from '../uisfx.js';

/**
 * The per-run modifier controls, shown on the ready screen.
 *
 * A row of toggle chips styled in the shared toggle vocabulary. It is a
 * controlled component — `mods` in, `onChange` out — so `PlayScreen` owns the
 * state and can persist it and rebuild the engine on start. Kept deliberately
 * small: it grows one control at a time as each modifier lands (Fail here;
 * Mirror / Hidden / Speed follow), so no dead switch ever ships.
 */
export function ModifierPanel({
  mods,
  onChange,
  style,
}: {
  mods: Modifiers;
  onChange: (next: Modifiers) => void;
  style?: CSSProperties;
}): JSX.Element {
  const toggle = (patch: Partial<Modifiers>, on: boolean): void => {
    // Positive cues rise, negative fall — matches the rest of the UI SFX.
    playUiSound(on ? 'confirm' : 'back');
    onChange({ ...mods, ...patch });
  };

  return (
    <div className="mod-panel rise" style={style}>
      <span className="mod-panel__label">Modifiers</span>
      <div className="mod-panel__chips">
        <button
          type="button"
          className={`mod-chip ${mods.fail ? 'mod-chip--on' : ''}`}
          aria-pressed={mods.fail}
          onClick={() => toggle({ fail: !mods.fail }, !mods.fail)}
        >
          {/* A heart when survival is on, a shield-off when you cannot die. */}
          <span aria-hidden>{mods.fail ? '💔' : '🛡'}</span>
          <span>Fail {mods.fail ? 'On' : 'Off'}</span>
        </button>
      </div>
    </div>
  );
}

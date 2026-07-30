import { Eye, EyeOff, FlipHorizontal2, Gauge, Heart, Music2, Shield } from 'lucide-react';
import type { CSSProperties, JSX } from 'react';
import { SPEED_CHOICES, type Modifiers, type Visibility } from '../game/modifiers.js';
import { playUiSound } from '../uisfx.js';

/** The visibility cycle and how each state reads on its chip. */
const VISIBILITY_ORDER: Visibility[] = ['normal', 'hidden', 'fadeout'];
const VISIBILITY_LABEL: Record<Visibility, string> = {
  normal: 'Full',
  hidden: 'Hidden',
  fadeout: 'Fade-out',
};

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

  // Visibility is a three-way cycle rather than a boolean, so one chip steps
  // Full -> Hidden -> Fade-out and back.
  const cycleVisibility = (): void => {
    const next =
      VISIBILITY_ORDER[
        (VISIBILITY_ORDER.indexOf(mods.visibility) + 1) % VISIBILITY_ORDER.length
      ]!;
    toggle({ visibility: next }, next !== 'normal');
  };

  // Speed steps through the fixed choices; the cue rises when speeding up.
  const cycleSpeed = (): void => {
    const i = SPEED_CHOICES.indexOf(mods.speed);
    const next = SPEED_CHOICES[(i + 1) % SPEED_CHOICES.length]!;
    toggle({ speed: next }, next >= mods.speed);
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
          {/*
            * Line icons, not colour emoji.
            *
            * These were six multi-hue emoji glyphs on the one screen whose job is
            * to introduce a song's single accent colour, and the only place in the
            * player flow where the palette was not under the app's control at all
            * (a platform emoji font picks its own hues). Lucide strokes inherit
            * `currentColor`, so a chip's icon is now the chip's colour: muted when
            * off, the accent when on.
            */}
          {mods.fail ? <Heart size={15} aria-hidden /> : <Shield size={15} aria-hidden />}
          <span>Fail {mods.fail ? 'On' : 'Off'}</span>
        </button>

        <button
          type="button"
          className={`mod-chip ${mods.holds ? 'mod-chip--on' : ''}`}
          aria-pressed={mods.holds}
          onClick={() => toggle({ holds: !mods.holds }, !mods.holds)}
        >
          <Music2 size={15} aria-hidden />
          <span>Holds {mods.holds ? 'On' : 'Off'}</span>
        </button>

        <button
          type="button"
          className={`mod-chip ${mods.mirror ? 'mod-chip--on' : ''}`}
          aria-pressed={mods.mirror}
          onClick={() => toggle({ mirror: !mods.mirror }, !mods.mirror)}
        >
          <FlipHorizontal2 size={15} aria-hidden />
          <span>Mirror {mods.mirror ? 'On' : 'Off'}</span>
        </button>

        <button
          type="button"
          className={`mod-chip ${mods.visibility !== 'normal' ? 'mod-chip--on' : ''}`}
          onClick={cycleVisibility}
        >
          {mods.visibility === 'normal' ? (
            <Eye size={15} aria-hidden />
          ) : (
            <EyeOff size={15} aria-hidden />
          )}
          <span>{VISIBILITY_LABEL[mods.visibility]}</span>
        </button>

        <button
          type="button"
          className={`mod-chip ${mods.speed !== 1 ? 'mod-chip--on' : ''}`}
          onClick={cycleSpeed}
        >
          <Gauge size={15} aria-hidden />
          <span>{mods.speed.toFixed(2).replace(/0$/, '')}×</span>
        </button>
      </div>
    </div>
  );
}

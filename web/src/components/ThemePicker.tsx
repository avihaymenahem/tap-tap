import { type Theme, themeFor } from '@tap-tap/shared';
import type { JSX } from 'react';

interface ThemePickerProps {
  /** Undefined for a song ingested before themes existed. */
  value: string | undefined;
  /** Built-ins plus custom themes. Pass the result of `themeCatalog`. */
  catalog: readonly Theme[];
  onChange: (themeId: string) => void;
  disabled?: boolean;
}

/**
 * Per-song palette picker.
 *
 * Swatches rather than names alone: nobody recognises a colour scheme by the
 * word "Arctic", and the whole point of the setting is what it looks like. A
 * native `<select>` cannot paint its options, so the strip sits beside it and
 * previews whatever is currently chosen.
 */
export function ThemePicker({
  value,
  catalog,
  onChange,
  disabled = false,
}: ThemePickerProps): JSX.Element {
  // Resolved rather than used raw, so a song with no theme — or one pointing at
  // a theme that has since been deleted — shows the palette it actually renders
  // with instead of an empty strip.
  const theme = themeFor(catalog, value);

  return (
    <label className="theme-picker">
      <span className="muted small">Theme</span>
      <span className="theme-picker__swatches" aria-hidden>
        {theme.lanes.slice(0, 5).map((colour, i) => (
          <span
            // Index is a safe key here: the list is a fixed-length palette in a
            // fixed order, not a reorderable collection.
            key={i}
            className="theme-picker__swatch"
            style={{ background: `#${colour.toString(16).padStart(6, '0')}` }}
          />
        ))}
      </span>
      <select
        className="admin__select"
        value={theme.id}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {catalog.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

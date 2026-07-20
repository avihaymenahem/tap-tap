import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  type SkyPalette,
  type Theme,
  type ThemeProblem,
  isBuiltinTheme,
  themeErrors,
  validateTheme,
} from '@tap-tap/shared';
import { ArrowLeft, Copy, Lock, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import { createTheme, deleteTheme, listCustomThemes, updateTheme } from '../api/client.js';
import { ThemePreview } from '../components/ThemePreview.js';

interface ThemesScreenProps {
  onBack: () => void;
}

const SKY_FIELDS: { key: keyof SkyPalette; label: string; hint: string }[] = [
  { key: 'top', label: 'Sky top', hint: 'Top of frame. Only a sliver of the view is sky.' },
  { key: 'horizon', label: 'Horizon', hint: 'At the horizon line, behind the sun.' },
  { key: 'horizonAlt', label: 'Horizon shimmer', hint: 'Treble crossfades toward this.' },
  { key: 'below', label: 'Below horizon', hint: 'Peeks past the edges of the track.' },
  { key: 'sun', label: 'Sun', hint: 'The disc at the waterline.' },
  { key: 'sunCrown', label: 'Sun crown', hint: 'Top of the disc. Lighter than the sun.' },
  { key: 'haze', label: 'Haze', hint: 'Air near the horizon and around the sun.' },
  { key: 'glow', label: 'Distance glow', hint: 'Nebula and the vanishing point; pulses on bass.' },
];

function toHexInput(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function fromHexInput(value: string): number {
  return Number.parseInt(value.replace('#', ''), 16);
}

/** `My Cool Theme` -> `my-cool-theme`, the shape `THEME_ID_PATTERN` wants. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
}

/** A new theme starts as a copy of the default rather than as black. */
function draftFrom(source: Theme, id: string, name: string): Theme {
  return { ...source, id, name, lanes: [...source.lanes], sky: { ...source.sky } };
}

export function ThemesScreen({ onBack }: ThemesScreenProps): JSX.Element {
  /** Server state. A freshly duplicated theme is *not* in here until saved. */
  const [custom, setCustom] = useState<Theme[]>([]);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_THEME.id);
  const [draft, setDraft] = useState<Theme | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async (): Promise<void> => {
    setCustom(await listCustomThemes());
  };

  useEffect(() => {
    void refreshRef.current().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  const editing = draft?.id === selectedId ? draft : null;
  /** Whether the draft is a theme the server has never seen. Drives create vs update. */
  const isNew = editing !== null && !custom.some((theme) => theme.id === editing.id);

  // An unsaved duplicate has to appear in the list, or it would vanish the
  // moment anything re-rendered and there would be nothing to select.
  const all: readonly Theme[] = [
    ...BUILTIN_THEMES,
    ...custom,
    ...(isNew && editing ? [editing] : []),
  ];
  const selected = all.find((theme) => theme.id === selectedId) ?? DEFAULT_THEME;
  /** What the preview shows: unsaved edits if any, otherwise the stored theme. */
  const shown = editing ?? selected;
  const locked = isBuiltinTheme(selected.id);

  // Validated live rather than only on save, so a colour that will be rejected
  // says so while it is being picked. `others` excludes the theme being edited,
  // or its own id would read as a collision with itself.
  const others = custom.filter((theme) => theme.id !== shown.id);
  const problems: ThemeProblem[] = editing ? validateTheme(editing, others) : [];
  // Id problems are noise for a theme that already exists — the id is fixed, so
  // there is nothing the user could do about them.
  const relevant = problems.filter((problem) => problem.field !== 'id' || isNew);
  const blocking = themeErrors(relevant);

  /**
   * The draft to edit from.
   *
   * Starting one lazily from the selected theme is what lets the first colour
   * change on a *saved* theme work — without it every edit would need an
   * explicit "edit" click first, and a change would silently do nothing.
   */
  const base = (): Theme => editing ?? draftFrom(selected, selected.id, selected.name);

  const patch = (changes: Partial<Theme>): void => {
    if (locked) return;
    setDraft({ ...base(), ...changes });
  };

  const patchSky = (key: keyof SkyPalette, value: number): void => {
    if (locked || Number.isNaN(value)) return;
    const current = base();
    setDraft({ ...current, sky: { ...current.sky, [key]: value } });
  };

  const patchLane = (index: number, value: number): void => {
    if (locked || Number.isNaN(value)) return;
    const current = base();
    const lanes = [...current.lanes];
    lanes[index] = value;
    setDraft({ ...current, lanes });
  };

  const duplicate = (): void => {
    const name = `${selected.name} copy`;
    let id = slugify(name);
    // Suffix until free, so duplicating twice in a row does not fail validation.
    for (let n = 2; all.some((theme) => theme.id === id); n++) id = `${slugify(name)}-${n}`;

    const copy = draftFrom(selected, id, name);
    setSelectedId(copy.id);
    setDraft(copy);
  };

  const save = async (): Promise<void> => {
    if (!editing || blocking.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      await (isNew ? createTheme(editing) : updateTheme(editing));
      setDraft(null);
      await refreshRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (isBuiltinTheme(selectedId)) return;
    setError(null);
    try {
      const { songsAffected } = await deleteTheme(selectedId);
      if (songsAffected > 0) {
        // Not an error — songs fall back to the default palette by design. But
        // silently recolouring someone's library would be a nasty surprise.
        setError(
          `Deleted. ${songsAffected} song${songsAffected === 1 ? '' : 's'} used it and now render the default theme.`,
        );
      }
      setDraft(null);
      setSelectedId(DEFAULT_THEME.id);
      await refreshRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="themes">
      <header className="admin__header">
        <h1>Themes</h1>
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden />
          Back to library
        </button>
      </header>

      {error && <p className="error-text">{error}</p>}

      <div className="themes__body">
        <aside className="themes__list">
          <ul>
            {all.map((theme) => (
              <li key={theme.id}>
                <button
                  type="button"
                  className={`themes__item ${theme.id === selectedId ? 'themes__item--active' : ''}`}
                  onClick={() => {
                    setSelectedId(theme.id);
                    setDraft(null);
                  }}
                >
                  <span className="themes__item-name">
                    {theme.name}
                    {isBuiltinTheme(theme.id) && <Lock size={12} aria-label="Built-in" />}
                  </span>
                  <span className="theme-picker__swatches">
                    {theme.lanes.slice(0, 5).map((colour, i) => (
                      <span
                        key={i}
                        className="theme-picker__swatch"
                        style={{ background: toHexInput(colour) }}
                      />
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <button type="button" className="btn btn--ghost btn--small" onClick={duplicate}>
            <Plus size={15} aria-hidden />
            New from “{selected.name}”
          </button>
        </aside>

        <section className="themes__detail">
          <ThemePreview theme={shown} />

          {locked && (
            <p className="muted small themes__locked">
              <Lock size={13} aria-hidden /> Built-in themes are read-only, so the palettes the
              game ships with can always be got back. Use <strong>New from</strong> to start an
              editable copy.
            </p>
          )}

          <div className="themes__fields" aria-disabled={locked}>
            <label className="themes__field themes__field--wide">
              <span className="muted small">Name</span>
              <input
                className="admin__input admin__input--small"
                value={shown.name}
                disabled={locked}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>

            <fieldset className="themes__group">
              <legend>Lanes</legend>
              <p className="muted small">
                Left to right. These have to stay tellable apart at speed — that is a playability
                constraint, not a taste one.
              </p>
              <div className="themes__swatch-row">
                {shown.lanes.slice(0, 5).map((colour, i) => (
                  <label key={i} className="themes__colour">
                    <input
                      type="color"
                      value={toHexInput(colour)}
                      disabled={locked}
                      onChange={(e) => patchLane(i, fromHexInput(e.target.value))}
                    />
                    <span className="muted small">{i + 1}</span>
                  </label>
                ))}
                <label className="themes__colour">
                  <input
                    type="color"
                    value={toHexInput(shown.hitLine)}
                    disabled={locked}
                    onChange={(e) => patch({ hitLine: fromHexInput(e.target.value) })}
                  />
                  <span className="muted small">Hit line</span>
                </label>
              </div>
            </fieldset>

            <fieldset className="themes__group">
              <legend>Sky</legend>
              <p className="muted small">
                Keep these dark. They are tone-mapped and lifted hard on screen, and anything past
                roughly <code>#E0E0E0</code> crosses the bloom threshold and starts glowing in
                competition with the notes.
              </p>
              <div className="themes__sky-grid">
                {SKY_FIELDS.map(({ key, label, hint }) => (
                  <label key={key} className="themes__colour themes__colour--labelled" title={hint}>
                    <input
                      type="color"
                      value={toHexInput(shown.sky[key])}
                      disabled={locked}
                      onChange={(e) => patchSky(key, fromHexInput(e.target.value))}
                    />
                    <span className="muted small">{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          {relevant.length > 0 && (
            <ul className="themes__problems">
              {relevant.map((problem) => (
                <li
                  key={`${problem.field}:${problem.message}`}
                  className={problem.severity === 'error' ? 'error-text' : 'warning'}
                >
                  <TriangleAlert size={14} aria-hidden />
                  {problem.message}
                </li>
              ))}
            </ul>
          )}

          {!locked && (
            <div className="themes__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!editing || blocking.length > 0 || saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save theme'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!editing}
                onClick={() => setDraft(null)}
              >
                Discard changes
              </button>
              <button type="button" className="btn btn--ghost" onClick={duplicate}>
                <Copy size={15} aria-hidden />
                Duplicate
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--danger"
                onClick={() => void remove()}
              >
                <Trash2 size={15} aria-hidden />
                Delete
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}


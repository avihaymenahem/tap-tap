import { AudioWaveform, EllipsisVertical, PencilLine, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';

interface SongActionsProps {
  title: string;
  onEdit: () => void;
  onRename: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}

/**
 * Per-song actions for the admin library.
 *
 * Split deliberately rather than putting all four behind one menu, or all four
 * in a row:
 *
 *   Edit chart and Rename are frequent and harmless, so they stay one click
 *   away as icon buttons.
 *
 *   Regenerate and Delete live in the overflow menu and keep their text
 *   labels. Both destroy work — Regenerate discards hand edits and invalidates
 *   every stored score, Delete removes the audio — and an unlabelled icon for
 *   either, sitting next to the ones you press all the time, is how someone
 *   wipes a song they meant to rename.
 *
 * Delete then asks again, inline. The whole row is one mis-tap wide on a phone.
 */
export function SongActions({
  title,
  onEdit,
  onRename,
  onRegenerate,
  onDelete,
}: SongActionsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismissing an open menu is genuinely document-level: a click anywhere else,
  // or Escape, has to close it. Matches the main menu's dropdown.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Reopening must never land on a primed Delete confirmation.
  const close = (): void => {
    setOpen(false);
    setConfirming(false);
  };

  return (
    <div className="song-actions" ref={menuRef}>
      <button
        type="button"
        className="icon-btn icon-btn--small"
        aria-label={`Edit chart for ${title}`}
        title="Edit chart"
        onClick={onEdit}
      >
        <AudioWaveform size={18} aria-hidden />
      </button>

      <button
        type="button"
        className="icon-btn icon-btn--small"
        aria-label={`Rename ${title}`}
        title="Rename"
        onClick={onRename}
      >
        <PencilLine size={18} aria-hidden />
      </button>

      <button
        type="button"
        className="icon-btn icon-btn--small"
        aria-label={`More actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <EllipsisVertical size={18} aria-hidden />
      </button>

      {open && (
        <div className="dropdown dropdown--row" role="menu">
          {!confirming && (
            <>
              <button
                type="button"
                role="menuitem"
                className="dropdown__item"
                onClick={() => {
                  close();
                  onRegenerate();
                }}
              >
                <RefreshCw size={16} aria-hidden />
                <span>Regenerate charts</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="dropdown__item dropdown__item--danger"
                onClick={() => setConfirming(true)}
              >
                <Trash2 size={16} aria-hidden />
                <span>Delete song</span>
              </button>
            </>
          )}

          {confirming && (
            <div className="dropdown__confirm">
              <p className="small">
                Delete <strong>{title}</strong>? The audio and charts go with it.
              </p>
              <div className="dropdown__confirm-actions">
                <button
                  type="button"
                  className="btn btn--danger btn--small"
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                >
                  Delete
                </button>
                <button type="button" className="btn btn--ghost btn--small" onClick={close}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

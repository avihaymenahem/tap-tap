import { useState, type JSX } from 'react';
import { ingestFromUrl } from '../data/ingest.js';
import { playUiSound } from '../uisfx.js';

/**
 * The on-device "add a song" modal (MC2) — a URL prompt that runs the native
 * ingest with live status. Controlled by the menu, which opens it from the FAB,
 * the empty-state button and the hamburger. Rendered only in the Capacitor app,
 * where the `YoutubeDl` plugin exists; it replaces the server's admin ingest,
 * which cannot work without a server (its HTTP calls return the app shell).
 */
interface NativeIngestProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function NativeIngest({ open, onClose, onDone }: NativeIngestProps): JSX.Element | null {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = (): void => {
    setUrl('');
    setStatus(null);
    setError(null);
  };

  const start = (): void => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    ingestFromUrl(trimmed, setStatus)
      .then(() => {
        setBusy(false);
        reset();
        playUiSound('newBest');
        onDone();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="ingest-overlay" role="dialog" aria-modal="true">
      <div className="ingest-modal rise">
        <h2>Add a song</h2>
        <p className="muted small">
          Paste a YouTube link — it downloads and is analysed into a chart right on your phone.
        </p>
        <input
          className="ingest-input"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="https://youtu.be/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        {status && <p className="ingest-status">{status}</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="ingest-actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              if (busy) return;
              reset();
              onClose();
            }}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={start}
            disabled={busy || !url.trim()}
          >
            {busy ? 'Working…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

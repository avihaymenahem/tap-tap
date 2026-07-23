import { useEffect, useState, type JSX } from 'react';
import { ingestFromUrl } from '../data/ingest.js';
import { playUiSound } from '../uisfx.js';

/**
 * The on-device "add a song" modal (MC2) — a URL prompt that runs the native
 * ingest with a live progress bar. Controlled by the menu, which opens it from
 * the FAB, the empty-state button, the hamburger, and a shared YouTube link (the
 * URL arrives prefilled via `initialUrl`). Rendered only in the Capacitor app,
 * where the `YoutubeDl` plugin exists; it replaces the server's admin ingest,
 * which cannot work without a server (its HTTP calls return the app shell).
 */
interface NativeIngestProps {
  open: boolean;
  /** Prefill the field — e.g. a YouTube link shared into the app. */
  initialUrl?: string | null;
  onClose: () => void;
  onDone: () => void;
}

interface Progress {
  message: string;
  fraction: number;
}

export function NativeIngest({ open, initialUrl, onClose, onDone }: NativeIngestProps): JSX.Element | null {
  const [url, setUrl] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A shared link arrives asynchronously (from the OS share sheet), so prefill
  // whenever one lands rather than only on the first render.
  useEffect(() => {
    if (initialUrl) setUrl(initialUrl);
  }, [initialUrl]);

  if (!open) return null;

  const reset = (): void => {
    setUrl('');
    setProgress(null);
    setError(null);
  };

  const start = (): void => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setProgress({ message: 'Starting…', fraction: 0.02 });
    ingestFromUrl(trimmed, (message, fraction) => setProgress({ message, fraction }))
      .then(() => {
        setBusy(false);
        reset();
        playUiSound('newBest');
        onDone();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="ingest-overlay" role="dialog" aria-modal="true">
      <div className="ingest-modal rise">
        <h2>Add a song</h2>
        <p className="muted small">
          Paste a YouTube link — or share one straight from YouTube. It downloads and is analysed
          into a chart right on your phone.
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

        {progress && (
          <div className="ingest-progress" aria-label="Progress">
            <div className="ingest-progress__track">
              <div
                className={`ingest-progress__fill ${busy ? 'ingest-progress__fill--busy' : ''}`}
                style={{ width: `${Math.round(Math.max(0, Math.min(1, progress.fraction)) * 100)}%` }}
              />
            </div>
            <p className="ingest-status">{progress.message}</p>
          </div>
        )}

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

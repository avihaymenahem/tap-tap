import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { FlashToggle } from '../components/FlashToggle.js';
import { GraphicsToggle } from '../components/GraphicsToggle.js';
import { HapticToggle } from '../components/HapticToggle.js';
import { MixerToggle } from '../components/MixerToggle.js';
import { NoteTickToggle } from '../components/NoteTickToggle.js';
import { ScrollSpeedToggle } from '../components/ScrollSpeedToggle.js';
import { SoundToggle } from '../components/SoundToggle.js';
import { clearOfflineTracks, offlineUsageBytes } from '../pwa.js';
import { getPreviewEnabled, setPreviewEnabled } from '../storage.js';
import { playUiSound } from '../uisfx.js';

/**
 * Every device setting, on its own route.
 *
 * These all used to hang off the menu's hamburger, which had grown to fourteen
 * entries — a scrolling column of unlabelled rows where the frequent actions
 * (add a song, manage the library) were buried among settings nobody changes
 * twice. Splitting them apart lets each side group and label itself: the
 * hamburger is navigation, this is configuration.
 *
 * The toggles themselves are unchanged and unmoved — they are the same
 * components the pause overlay uses, taking the row class as a prop. Each reads
 * its stored value on mount rather than through props, which is what lets three
 * copies of the same control exist without a shared store: navigating here
 * remounts the screen, so it always opens on current values.
 */
export function SettingsScreen({
  onBack,
  onCalibrate,
}: {
  onBack: () => void;
  onCalibrate: () => void;
}): JSX.Element {
  const [previewsOn, setPreviewsOn] = useState(getPreviewEnabled);

  /**
   * Bytes of audio the service worker is holding. Genuinely external state read
   * from the Cache API, so an effect is the right tool — and `null` until it
   * answers, which is how the row below stays hidden rather than flashing "0 MB".
   */
  const [offlineBytes, setOfflineBytes] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void offlineUsageBytes().then((bytes) => {
      if (live) setOfflineBytes(bytes);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="settings">
      <div className="settings__card">
        <button
          type="button"
          className="settings__back"
          onClick={() => {
            playUiSound('back');
            onBack();
          }}
        >
          ‹ Back
        </button>

        <h1>Settings</h1>

        <section className="settings__group rise" style={{ '--i': 0 } as CSSProperties}>
          <h2 className="settings__heading">Audio</h2>
          <div className="settings__rows">
            <MixerToggle kind="music" className="setting-row" />
            <MixerToggle kind="sfx" className="setting-row" />
            <NoteTickToggle className="setting-row" />
            <SoundToggle className="setting-row" />
          </div>
        </section>

        <section className="settings__group rise" style={{ '--i': 1 } as CSSProperties}>
          <h2 className="settings__heading">Gameplay</h2>
          <div className="settings__rows">
            <ScrollSpeedToggle className="setting-row" />
            {/* Renders nothing where the device cannot vibrate, which is why it
                shares a section rather than heading one — a lone hidden row
                would leave a bare heading behind. */}
            <HapticToggle className="setting-row" />
            <button type="button" className="setting-row" onClick={onCalibrate}>
              <span>Calibrate timing</span>
              <span className="setting-row__chev" aria-hidden>
                ›
              </span>
            </button>
          </div>
          <p className="settings__hint muted small">
            Scroll speed applies from the next song — it is baked in when the highway is built.
          </p>
        </section>

        <section className="settings__group rise" style={{ '--i': 2 } as CSSProperties}>
          <h2 className="settings__heading">Visuals</h2>
          <div className="settings__rows">
            <GraphicsToggle className="setting-row" />
            <FlashToggle className="setting-row" />
          </div>
          <p className="settings__hint muted small">
            Graphics applies from the next song. Screen flash stops the backdrop pulsing on the
            beat.
          </p>
        </section>

        <section className="settings__group rise" style={{ '--i': 3 } as CSSProperties}>
          <h2 className="settings__heading">Library</h2>
          <div className="settings__rows">
            <button
              type="button"
              aria-pressed={previewsOn}
              className="setting-row"
              onClick={() => {
                const next = !previewsOn;
                setPreviewsOn(next);
                setPreviewEnabled(next);
                if (next) playUiSound('tick');
              }}
            >
              <span>Song previews</span>
              <span className={`dropdown__state ${previewsOn ? 'dropdown__state--on' : ''}`}>
                {previewsOn ? 'On' : 'Off'}
              </span>
            </button>

            {/* Offline tracks accumulate silently — a full library is well over
                100MB — so there has to be a way to see and drop them that is not
                "clear site data" in browser settings. Hidden entirely when
                nothing is stored, rather than offering to delete nothing. */}
            {offlineBytes !== null && offlineBytes > 0 && (
              <button
                type="button"
                className="setting-row"
                onClick={() => {
                  void clearOfflineTracks().then((cleared) => {
                    if (cleared) setOfflineBytes(0);
                  });
                }}
              >
                <span>Clear offline songs</span>
                <span className="dropdown__state">{formatBytes(offlineBytes)}</span>
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** MB is the only unit that matters here — a single track is already ~5MB. */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

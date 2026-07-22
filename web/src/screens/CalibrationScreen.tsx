import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import { MIN_STORED_SEC, foldTapDelta } from '../game/calibration.js';
import { getStoredCalibration, setCalibration } from '../storage.js';

/**
 * Deliberately slow.
 *
 * The measurable range is one beat minus the lead allowance (see
 * `foldTapDelta`), so the period has to comfortably clear the worst latency
 * being measured. At 120 BPM that ceiling was 380ms, close enough to Bluetooth
 * that readings wrapped and came out negative. At 90 BPM it is ~547ms.
 */
const BPM = 90;
const BEAT_SEC = 60 / BPM;
const TAPS_NEEDED = 12;

interface CalibrationScreenProps {
  onDone: () => void;
}

/**
 * Measures the player's input latency.
 *
 * A steady metronome plays; the player taps along. The median signed error is
 * the offset the engine subtracts from input times. Bluetooth headphones can
 * add 150-300ms, which is the difference between a chart feeling tight and
 * feeling broken.
 */
export function CalibrationScreen({ onDone }: CalibrationScreenProps): JSX.Element {
  const [running, setRunning] = useState(false);
  const [taps, setTaps] = useState<number[]>([]);
  const [saved, setSaved] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const nextBeatRef = useRef(0);
  const beatsRef = useRef<number[]>([]);
  /**
   * Held in a ref so the tap pad can call it without the effect depending on
   * anything that changes per tap — re-running the effect would tear down the
   * AudioContext and restart the metronome mid-measurement.
   */
  const recordTapRef = useRef<(() => void) | null>(null);

  /**
   * `null` means this device has never been calibrated, which is not the same
   * as being calibrated to zero — the engine falls back to the audio hardware's
   * reported output latency in that case. Showing a flat "0 ms" for both would
   * be a lie on any phone, where the fallback is often 150ms or more.
   */
  // Held in state rather than re-read during render, so saving or resetting
  // repaints the readout instead of leaving a stale number on screen.
  const [stored, setStored] = useState<number | null>(getStoredCalibration);
  const offset = taps.length > 0 ? median(taps) : null;

  useEffect(() => {
    if (!running) return;

    const ctx = new AudioContext();
    // iOS hands back a suspended context even from inside a gesture, and a
    // suspended context's currentTime does not advance — every tap would be
    // measured against a frozen clock.
    void ctx.resume();
    ctxRef.current = ctx;
    nextBeatRef.current = ctx.currentTime + 0.4;
    beatsRef.current = [];

    // Lookahead scheduler: queue clicks slightly ahead of time so playback is
    // driven by the audio clock rather than by timer jitter.
    const schedule = (): void => {
      while (nextBeatRef.current < ctx.currentTime + 0.25) {
        const at = nextBeatRef.current;
        click(ctx, at);
        beatsRef.current.push(at);
        if (beatsRef.current.length > 64) beatsRef.current.shift();
        nextBeatRef.current += BEAT_SEC;
      }
    };

    schedule();
    const timer = window.setInterval(schedule, 25);

    const recordTap = (): void => {
      const now = ctx.currentTime;
      const nearest = beatsRef.current.reduce(
        (best, beat) => (Math.abs(beat - now) < Math.abs(best - now) ? beat : best),
        beatsRef.current[0] ?? now,
      );

      // Folded rather than taken raw. The nearest click is the wrong answer
      // once latency passes half a beat — the tap is then closer to the *next*
      // click and reads as early, which is how this screen offered to store
      // -200ms for a player on Bluetooth headphones.
      setTaps((current) => [...current, foldTapDelta(now - nearest, BEAT_SEC)]);
    };
    recordTapRef.current = recordTap;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) return;
      event.preventDefault();
      recordTap();
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKeyDown);
      recordTapRef.current = null;
      void ctx.close();
      ctxRef.current = null;
    };
  }, [running]);

  const done = taps.length >= TAPS_NEEDED;

  return (
    <div className="calibration">
      <div className="calibration__card">
        <h1>Calibration</h1>
        <p className="muted small">
          Tap on every click — {TAPS_NEEDED} is enough. Use the headphones or
          speaker you play with.
        </p>

        <div className="calibration__meter">
          <div className="calibration__count">
            {Math.min(taps.length, TAPS_NEEDED)} / {TAPS_NEEDED}
          </div>
          {offset !== null && (
            <div className="calibration__offset">
              {offset >= 0 ? '+' : ''}
              {(offset * 1000).toFixed(0)} ms
            </div>
          )}
        </div>

        {!running && (
          <button type="button" className="btn btn--primary" onClick={() => setRunning(true)}>
            Start metronome
          </button>
        )}

        {running && !done && (
          <button
            type="button"
            className="calibration__pad"
            // pointerdown, not click: click only fires after the finger lifts,
            // and that gap is tens of milliseconds of pure error in the one
            // measurement whose entire purpose is measuring milliseconds.
            //
            // It also avoids double-counting. A focused <button> fires `click`
            // when SPACE is pressed, so a click handler would record the same
            // keypress twice — once here and once in the global keydown.
            onPointerDown={(event) => {
              event.preventDefault();
              recordTapRef.current?.();
            }}
          >
            TAP
          </button>
        )}

        {done && offset !== null && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setCalibration(offset);
              setStored(offset);
              setSaved(true);
              setRunning(false);
            }}
          >
            Save {(offset * 1000).toFixed(0)} ms offset
          </button>
        )}

        {saved && <p className="calibration__saved">Saved.</p>}

        <p className="muted small">
          {stored === null ? (
            <>Current offset: auto, from this device&rsquo;s audio latency</>
          ) : (
            <>
              Current offset: {stored >= 0 ? '+' : ''}
              {(stored * 1000).toFixed(0)} ms
            </>
          )}
        </p>

        {/* A saved offset this negative predates the metronome aliasing fix. It
            is floored before the engine sees it, so the game is playable — but
            the player has no other way to learn that the number on this screen
            is not the one being used, or why every tap felt like a miss. */}
        {stored !== null && stored < MIN_STORED_SEC && (
          <p className="warning small">
            That saved offset is too far negative to be real — it came from a
            measurement bug and is being limited to {(MIN_STORED_SEC * 1000).toFixed(0)} ms.
            Please calibrate again, or reset to 0.
          </p>
        )}

        <div className="calibration__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setTaps([]);
              setSaved(false);
            }}
          >
            Reset taps
          </button>
          {/* Stores a deliberate zero rather than clearing the setting. Clearing
              would hand control back to the device's reported latency, which is
              not "no offset" on anything with Bluetooth headphones. */}
          <button
            type="button"
            className="btn btn--ghost"
            disabled={stored === 0}
            onClick={() => {
              setCalibration(0);
              setStored(0);
              setTaps([]);
              setSaved(false);
            }}
          >
            <RotateCcw size={15} aria-hidden />
            Reset to 0
          </button>
          <button type="button" className="btn" onClick={onDone}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

/** Short percussive blip at a precise context time. */
function click(ctx: AudioContext, at: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 1400;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.5, at + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.08);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

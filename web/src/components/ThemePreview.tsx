import type { Chart, Note, Theme } from '@tap-tap/shared';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { GameEngine } from '../game/engine.js';
import { Highway } from '../render/highway.js';

const LANE_COUNT = 5;
const APPROACH_SEC = 1.6;
/** Loop length. Long enough to watch notes travel, short enough to judge quickly. */
const LOOP_SEC = 4;
const BPM = 120;

/**
 * Wait this long after the last edit before rebuilding the scene.
 *
 * A colour input fires continuously while dragging, and a theme change means a
 * whole new `Highway` — shader materials are compiled in its constructor, so
 * there is no way to update one in place. Rebuilding per pointer-move would
 * drop frames and churn WebGL contexts.
 */
const REBUILD_DEBOUNCE_MS = 140;

function previewChart(): Chart {
  // One note per lane per beat, cycling, so every lane colour appears and each
  // receptor lights in turn.
  const notes: Note[] = [];
  for (let beat = 0; beat * (60 / BPM) < LOOP_SEC; beat++) {
    notes.push({ t: beat * (60 / BPM), lane: beat % LANE_COUNT, type: 'tap' });
  }
  return { laneCount: LANE_COUNT, notes };
}

/**
 * A real, running highway rendering a dummy chart.
 *
 * **This uses the actual renderer on purpose.** A theme's colours are sRGB hex,
 * but they are linearized, ACES tone-mapped and bloom-thresholded before anyone
 * sees them, so a swatch is not a preview — it is a different number. Two of the
 * built-in themes shipped with suns over the bloom threshold that read as merely
 * "bright" as hex and blew out on screen. Anything short of the real pipeline
 * would reproduce exactly that class of mistake.
 *
 * There is no audio: `Highway.render` takes song time as a parameter, so a
 * synthetic clock drives it and the band levels come from a sine.
 */
export function ThemePreview({ theme }: { theme: Theme }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  // Identity of `theme` changes on every parent render even when nothing about
  // it did. Keying the rebuild on the *colours* instead is what stops a
  // keystroke elsewhere on the page from tearing down the WebGL context.
  const signature = useMemo(
    () => JSON.stringify([theme.lanes, theme.hitLine, theme.sky]),
    [theme],
  );

  const themeRef = useRef(theme);
  themeRef.current = theme;

  const [applied, setApplied] = useState(theme);
  useEffect(() => {
    const timer = window.setTimeout(() => setApplied(themeRef.current), REBUILD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [signature]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const chart = previewChart();
    let highway: Highway;
    try {
      highway = new Highway({
        canvas,
        laneCount: LANE_COUNT,
        approachSec: APPROACH_SEC,
        theme: applied,
        beatGrid: chart.notes.map((note) => note.t),
      });
    } catch {
      // WebGL can genuinely be unavailable — too many live contexts, a lost
      // device, software rendering off. The editor still works from the colour
      // inputs alone, so a dead preview must not take the page down with it.
      setFailed(true);
      return;
    }
    setFailed(false);

    const resize = (): void => highway.resize(canvas.clientWidth, canvas.clientHeight);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let engine = new GameEngine(chart);
    let previous = 0;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const songTime = (now / 1000) % LOOP_SEC;
      // A fresh engine on each wrap, or the notes stay retired and the preview
      // empties out after one pass.
      if (songTime < previous) engine = new GameEngine(chart);
      previous = songTime;

      // Fake band energy, so the bass- and treble-reactive parts of the scene
      // (ground grid, vanishing-point glow, sky shimmer) visibly move.
      const phase = (songTime / LOOP_SEC) * Math.PI * 2;
      const bass = 0.35 + 0.35 * Math.sin(phase);
      const treble = 0.3 + 0.3 * Math.sin(phase * 2);

      highway.render(songTime, engine.visibleNotes(songTime, APPROACH_SEC), dt, bass, treble);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      // Disposal is not optional. Each Highway holds a WebGL context, browsers
      // cap how many can be live, and this rebuilds on every theme edit —
      // leaking one per edit would wedge the page.
      highway.dispose();
    };
  }, [applied]);

  return (
    <div className="theme-preview">
      <canvas ref={canvasRef} className="theme-preview__canvas" />
      {failed && (
        <p className="theme-preview__failed muted small">
          Preview unavailable — WebGL could not start. The colours below still save normally.
        </p>
      )}
    </div>
  );
}

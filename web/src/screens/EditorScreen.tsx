import type { AnalysisResult, Beatmap, DifficultyName, Theme, Waveform } from '@tap-tap/shared';
import { BUILTIN_THEMES, DIFFICULTIES, DIFFICULTY_NAMES, themeCatalog, themeFor } from '@tap-tap/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
import { getAnalysis, getBeatmap, getWaveform, listCustomThemes } from '../api/client.js';
import { drawTimeline, formatTime } from '../editor/timeline.js';
import {
  DEFAULT_VIEWPORT,
  clampCursor,
  yToTime,
  type Viewport,
} from '../editor/view.js';
import { AudioClock } from '../game/clock.js';

interface EditorScreenProps {
  songId: string;
  difficulty: DifficultyName;
  onExit: () => void;
  onChangeDifficulty: (difficulty: DifficultyName) => void;
}

const SUBDIVISIONS = [1, 2, 4] as const;
/** Seconds of notes to schedule tick sounds for ahead of the playhead. */
const TICK_LOOKAHEAD_SEC = 0.25;

export function EditorScreen({
  songId,
  difficulty,
  onExit,
  onChangeDifficulty,
}: EditorScreenProps): JSX.Element {
  const [beatmap, setBeatmap] = useState<Beatmap | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [waveform, setWaveform] = useState<Waveform | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [subdivision, setSubdivision] = useState<number>(4);
  const [zoom, setZoom] = useState(DEFAULT_VIEWPORT.pixelsPerSecond);
  const [ticks, setTicks] = useState(true);
  /** Mirrored into state only so the header readout re-renders. */
  const [cursorLabel, setCursorLabel] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef<AudioClock | null>(null);
  const rafRef = useRef<number | null>(null);

  // Everything the draw loop reads lives in refs: it runs every frame and must
  // never depend on a React render having happened first.
  const cursorRef = useRef(0);
  /** Built-ins until the custom themes arrive; see the load effect. */
  const catalogRef = useRef<readonly Theme[]>(BUILTIN_THEMES);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const subdivisionRef = useRef(subdivision);
  subdivisionRef.current = subdivision;
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  const dataRef = useRef<{ beatmap: Beatmap | null; analysis: AnalysisResult | null; waveform: Waveform | null }>({
    beatmap: null,
    analysis: null,
    waveform: null,
  });
  dataRef.current = { beatmap, analysis, waveform };

  const params = DIFFICULTIES[difficulty];

  // Load chart, onset pool, waveform and audio.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load(): Promise<void> {
      try {
        const [map, pool, wave, customThemes] = await Promise.all([
          getBeatmap(songId),
          getAnalysis(songId).catch(() => null),
          getWaveform(songId).catch(() => null),
          listCustomThemes().catch(() => []),
        ]);
        if (cancelled) return;
        // A ref, not state: the draw loop reads it every frame and nothing
        // about it should trigger a re-render or restart the loop.
        catalogRef.current = themeCatalog(customThemes);

        const clock = await AudioClock.load(map.audioUrl, controller.signal);
        if (cancelled) {
          void clock.dispose();
          return;
        }

        clockRef.current = clock;
        setBeatmap(map);
        setAnalysis(pool);
        setWaveform(wave);
        setReady(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      void clockRef.current?.dispose();
      clockRef.current = null;
    };
  }, [songId]);

  // Draw loop. Runs continuously so scrubbing and zooming stay live even when
  // paused — the canvas is cheap and this avoids a second redraw path.
  useEffect(() => {
    if (!ready) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let scheduledUntil = -Infinity;
    let lastLabel = -1;

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio, 2);
      const { clientWidth, clientHeight } = canvas;
      canvas.width = Math.round(clientWidth * dpr);
      canvas.height = Math.round(clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const frame = (): void => {
      const clock = clockRef.current;
      const { beatmap: map, analysis: pool, waveform: wave } = dataRef.current;

      if (clock && clock.isPlaying) {
        cursorRef.current = clock.currentTime;

        // Schedule hit sounds ahead of the playhead so they land sample-accurate
        // rather than on whichever frame happens to notice the note.
        if (ticksRef.current && map) {
          const notes = map.charts[difficulty]?.notes ?? [];
          const until = cursorRef.current + TICK_LOOKAHEAD_SEC;
          for (const note of notes) {
            if (note.t <= scheduledUntil || note.t > until) continue;
            clock.playTickAt(clock.contextTimeFor(note.t));
          }
          scheduledUntil = Math.max(scheduledUntil, until);
        }
      }

      const view: Viewport = {
        cursor: cursorRef.current,
        pixelsPerSecond: zoomRef.current,
        playheadRatio: DEFAULT_VIEWPORT.playheadRatio,
      };

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width > 0 && height > 0 && map) {
        drawTimeline(ctx, width, height, view, {
          laneCount: map.charts[difficulty]?.laneCount ?? params.laneCount,
          duration: map.duration,
          subdivision: subdivisionRef.current,
          beatGrid: map.beatGrid,
          onsets: pool?.onsets ?? [],
          notes: map.charts[difficulty]?.notes ?? [],
          waveform: wave,
          theme: themeFor(catalogRef.current, map.themeId),
        });
      }

      // Throttle the header readout to ~10Hz; it does not need every frame.
      const decisecond = Math.floor(cursorRef.current * 10);
      if (decisecond !== lastLabel) {
        lastLabel = decisecond;
        setCursorLabel(cursorRef.current);
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      observer.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [ready, difficulty, params.laneCount]);

  const seek = (t: number): void => {
    const clock = clockRef.current;
    const duration = beatmap?.duration ?? 0;
    cursorRef.current = clampCursor(t, duration);
    setCursorLabel(cursorRef.current);
    if (clock?.isPlaying) void clock.start(Math.max(0, cursorRef.current));
  };

  const togglePlay = (): void => {
    const clock = clockRef.current;
    if (!clock) return;
    if (clock.isPlaying) {
      clock.pause();
      cursorRef.current = clock.currentTime;
      setPlaying(false);
    } else {
      void clock.start(Math.max(0, cursorRef.current));
      setPlaying(true);
    }
  };

  // Keyboard transport.
  useEffect(() => {
    if (!ready) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) return;

      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'Escape') {
        onExit();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        seek(cursorRef.current + (event.shiftKey ? 1 : 0.1));
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        seek(cursorRef.current - (event.shiftKey ? 1 : 0.1));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const chart = beatmap?.charts[difficulty] ?? null;

  return (
    <div className="editor">
      <header className="editor__bar">
        <button type="button" className="btn btn--ghost btn--small" onClick={onExit}>
          Back
        </button>

        <div className="editor__title">
          <strong>{beatmap?.title ?? 'Loading…'}</strong>
          <span className="muted small">
            {chart ? `${chart.notes.length} notes · ${chart.laneCount} lanes` : ''}
            {analysis ? ` · ${analysis.onsets.length} candidates` : ''}
          </span>
        </div>

        <div className="editor__transport">
          <span className="editor__time">{formatTime(cursorLabel)}</span>
          <button type="button" className="btn btn--primary btn--small" onClick={togglePlay}>
            {playing ? 'Pause' : 'Play'}
          </button>
        </div>
      </header>

      <div className="editor__tools">
        <label className="editor__tool">
          Difficulty
          <select
            value={difficulty}
            onChange={(e) => onChangeDifficulty(e.target.value as DifficultyName)}
          >
            {DIFFICULTY_NAMES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <label className="editor__tool">
          Grid
          <select value={subdivision} onChange={(e) => setSubdivision(Number(e.target.value))}>
            {SUBDIVISIONS.map((s) => (
              <option key={s} value={s}>
                1/{s}
              </option>
            ))}
          </select>
        </label>

        <label className="editor__tool">
          Zoom
          <input
            type="range"
            min={60}
            max={500}
            step={10}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>

        <label className="editor__tool editor__tool--check">
          <input type="checkbox" checked={ticks} onChange={(e) => setTicks(e.target.checked)} />
          Hit sounds
        </label>

        <span className="muted small editor__hint">
          Space play · ↑↓ nudge · drag to scrub
        </span>
      </div>

      {error && <p className="error-text editor__error">{error}</p>}

      <canvas
        ref={canvasRef}
        className="editor__canvas"
        onPointerDown={(e) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.setPointerCapture(e.pointerId);
          const rect = canvas.getBoundingClientRect();
          seek(
            yToTime(
              e.clientY - rect.top,
              {
                cursor: cursorRef.current,
                pixelsPerSecond: zoomRef.current,
                playheadRatio: DEFAULT_VIEWPORT.playheadRatio,
              },
              rect.height,
            ),
          );
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 1) return;
          // Dragging moves time under the playhead, so the gesture feels like
          // pulling the tape rather than pointing at a spot.
          seek(cursorRef.current - e.movementY / zoomRef.current);
        }}
        onWheel={(e) => {
          if (e.ctrlKey) {
            setZoom((z) => Math.max(60, Math.min(500, z - e.deltaY * 0.3)));
            return;
          }
          seek(cursorRef.current - e.deltaY / zoomRef.current);
        }}
      />
    </div>
  );
}

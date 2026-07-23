import { DEFAULT_THEME, keymapFor } from '@tap-tap/shared';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { resolveCalibration } from '../game/calibration.js';
import { GameEngine } from '../game/engine.js';
import type { Tier, Timing } from '../game/judge.js';
import { type Metronome, startMetronome } from '../game/metronome.js';
import {
  TUTORIAL_APPROACH_SEC,
  TUTORIAL_BPM,
  TUTORIAL_LANES,
  buildTutorialLesson,
  tutorialHintAt,
} from '../game/tutorialChart.js';
import { cancelHaptics, vibrateTap } from '../haptics.js';
import { useWakeLock } from '../hooks/useWakeLock.js';
import { Highway } from '../render/highway.js';
import { TIER_COLORS, TIER_LABELS, TIMING_COLORS, TIMING_LABELS } from '../render/palette.js';
import { getStoredCalibration, setTutorialSeen } from '../storage.js';
import { playUiSound } from '../uisfx.js';

/**
 * The interactive first-run tutorial.
 *
 * A stripped-down `PlayScreen`: it reuses the real `Highway` and `GameEngine` so
 * what you learn is exactly what you play, but there is no song — the clock is a
 * metronome (`AudioContext.currentTime` as master, per invariant 1.5) and the
 * chart is the hand-built lesson. No score, no fail; misses just re-encourage.
 */

type Phase = 'intro' | 'playing' | 'done';
const BEAT = 60 / TUTORIAL_BPM;

/** The audio graph's own latency, for seeding calibration when none is stored. */
function latencyOf(ctx: AudioContext): number {
  const reported = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
  const value = typeof reported === 'number' && reported > 0 ? reported : (ctx.baseLatency ?? 0);
  return Number.isFinite(value) && value > 0 && value < 0.5 ? value : 0;
}

export function TutorialScreen({
  onDone,
  onCalibrate,
}: {
  onDone: () => void;
  onCalibrate: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('intro');
  const phaseRef = useRef<Phase>('intro');
  const applyPhase = (next: Phase): void => {
    phaseRef.current = next;
    setPhase(next);
  };

  const lesson = useMemo(buildTutorialLesson, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const judgementRef = useRef<HTMLDivElement>(null);
  const timingRef = useRef<HTMLDivElement>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const metronomeRef = useRef<Metronome | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const highwayRef = useRef<Highway | null>(null);
  const rafRef = useRef<number | null>(null);
  const startAtRef = useRef(0);
  /** The intro "Start" button drives this, set up once the loop is installed. */
  const startRef = useRef<(() => void) | null>(null);

  useWakeLock(true);

  useEffect(() => {
    const keys = keymapFor(TUTORIAL_LANES);
    const spectrum = new Uint8Array(new ArrayBuffer(512));
    let lastFrame = performance.now();
    let judgementAlpha = 0;

    const restartAnim = (el: HTMLElement | null, cls: string): void => {
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    };

    const showJudgement = (tier: Tier, timing: Timing | null): void => {
      const el = judgementRef.current;
      if (el) {
        el.textContent = TIER_LABELS[tier];
        el.style.color = TIER_COLORS[tier];
      }
      const tag = timingRef.current;
      if (tag) {
        tag.textContent = timing ? TIMING_LABELS[timing] : '';
        tag.style.color = timing ? TIMING_COLORS[timing] : '#fff';
      }
      restartAnim(el, 'play__judgement--pop');
      judgementAlpha = 1;
    };

    const finish = (): void => {
      if (phaseRef.current !== 'playing') return;
      metronomeRef.current?.stop();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      setTutorialSeen(true);
      playUiSound('fanfare');
      applyPhase('done');
    };

    const step = (now: number): void => {
      const ctx = ctxRef.current;
      const engine = engineRef.current;
      const highway = highwayRef.current;
      if (!ctx || !engine || !highway) return;

      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      const songTime = ctx.currentTime - startAtRef.current;
      const shownTime = engine.judgementTime(songTime);

      for (const missed of engine.update(songTime)) {
        highway.burst(missed.note.lane, 'miss');
        showJudgement('miss', null);
      }

      // No song to react to — the spectrum stays zero, so the highway pulses only
      // on the beat grid.
      highway.render(shownTime, engine.visibleNotes(shownTime, TUTORIAL_APPROACH_SEC), dt, 0, 0, spectrum);

      const hint = tutorialHintAt(lesson.phases, songTime);
      if (hintRef.current && hintRef.current.textContent !== hint) hintRef.current.textContent = hint;

      judgementAlpha = Math.max(0, judgementAlpha - dt * 2.2);
      if (judgementRef.current) judgementRef.current.style.opacity = String(judgementAlpha);
      if (timingRef.current) timingRef.current.style.opacity = String(judgementAlpha * 0.9);

      if (songTime >= lesson.endSec) {
        finish();
        return;
      }
      rafRef.current = requestAnimationFrame(frame);
    };

    let loopFailed = false;
    const frame = (now: number): void => {
      try {
        step(now);
      } catch (err) {
        if (!loopFailed) {
          loopFailed = true;
          console.error('[tap-tap] tutorial loop error', err);
        }
      }
    };

    const start = (): void => {
      const canvas = canvasRef.current;
      if (!canvas || phaseRef.current !== 'intro') return;

      const ctx = new AudioContext();
      void ctx.resume();
      ctxRef.current = ctx;

      const metro = startMetronome(ctx, { bpm: TUTORIAL_BPM, startAt: ctx.currentTime + 0.7 });
      metronomeRef.current = metro;
      startAtRef.current = metro.startAt;

      // A synthetic beat grid in song-time so the backdrop still pulses.
      const beatGrid: number[] = [];
      for (let b = 0; b * BEAT <= lesson.endSec + 1; b++) beatGrid.push(Number((b * BEAT).toFixed(4)));

      const highway = new Highway({
        canvas,
        laneCount: TUTORIAL_LANES,
        approachSec: TUTORIAL_APPROACH_SEC,
        theme: DEFAULT_THEME,
        beatGrid,
      });
      highway.resize(canvas.clientWidth, canvas.clientHeight);
      highwayRef.current = highway;

      engineRef.current = new GameEngine(lesson.chart, {
        calibrationSec: resolveCalibration(getStoredCalibration(), latencyOf(ctx)),
      });

      applyPhase('playing');
      lastFrame = performance.now();
      rafRef.current = requestAnimationFrame(frame);
    };
    startRef.current = start;

    const hit = (lane: number): void => {
      const ctx = ctxRef.current;
      const engine = engineRef.current;
      const highway = highwayRef.current;
      if (!ctx || !engine || !highway || phaseRef.current !== 'playing') return;

      vibrateTap();
      highway.flashLane(lane);
      const result = engine.hitLane(lane, ctx.currentTime - startAtRef.current);
      if (result) {
        highway.burst(lane, result.tier, result.combo);
        showJudgement(result.tier, result.timing);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      if ((event.code === 'Space' || event.code === 'Enter') && phaseRef.current === 'intro') {
        event.preventDefault();
        start();
        return;
      }
      if (phaseRef.current !== 'playing') return;
      const lane = keys.indexOf(event.key.toLowerCase());
      if (lane === -1) return;
      event.preventDefault();
      hit(lane);
    };

    const canvas = canvasRef.current;
    const onPointerDown = (event: PointerEvent): void => {
      if (phaseRef.current !== 'playing' || !canvas) return;
      const highway = highwayRef.current;
      if (!highway) return;
      const rect = canvas.getBoundingClientRect();
      const lane = highway.laneAtScreenPoint(
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
      );
      if (lane >= 0 && lane < TUTORIAL_LANES) hit(lane);
    };

    const onResize = (): void => {
      const c = canvasRef.current;
      if (c && c.clientWidth > 0) highwayRef.current?.resize(c.clientWidth, c.clientHeight);
    };

    window.addEventListener('keydown', onKeyDown);
    canvas?.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      canvas?.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      startRef.current = null;
      metronomeRef.current?.stop();
      metronomeRef.current = null;
      highwayRef.current?.dispose();
      highwayRef.current = null;
      void ctxRef.current?.close();
      ctxRef.current = null;
      engineRef.current = null;
      cancelHaptics();
    };
    // Installed once; the loop and inputs read live state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson]);

  const skip = (): void => {
    setTutorialSeen(true);
    onDone();
  };

  return (
    <div className="play tutorial" data-phase={phase}>
      <canvas ref={canvasRef} className="play__canvas" />

      {/* Guided hint, written imperatively from the loop. */}
      <div ref={hintRef} className="tutorial__hint" aria-live="polite" />
      <div ref={judgementRef} className="play__judgement" style={{ opacity: 0 }} />
      <div ref={timingRef} className="play__timing" style={{ opacity: 0 }} />

      {phase === 'intro' && (
        <div className="play__overlay play__overlay--ready">
          <h2 className="rise">How to play</h2>
          <p className="muted rise" style={{ '--i': 1 } as CSSProperties}>
            Notes fall down four lanes. Tap a lane the moment its tile lands in the frame at the
            bottom. That&rsquo;s the whole game.
          </p>
          <div className="keycaps only-desktop rise" style={{ '--i': 2 } as CSSProperties}>
            {keymapFor(TUTORIAL_LANES).map((key) => (
              <kbd key={key}>{key.toUpperCase()}</kbd>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--primary btn--start rise"
            style={{ '--i': 3 } as CSSProperties}
            onClick={() => {
              playUiSound('confirm');
              startRef.current?.();
            }}
          >
            <span className="only-desktop">Press SPACE to start</span>
            <span className="only-mobile">Start</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost rise"
            style={{ '--i': 4 } as CSSProperties}
            onClick={skip}
          >
            Skip
          </button>
        </div>
      )}

      {phase === 'done' && (
        <div className="play__overlay play__overlay--ready">
          <div className="tutorial__done-badge pop" aria-hidden>
            🎉
          </div>
          <h2 className="rise">You&rsquo;ve got it</h2>
          <p className="muted rise" style={{ '--i': 1 } as CSSProperties}>
            One thing worth doing first: calibrate, so notes line up with what you hear —
            especially on Bluetooth.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--start rise"
            style={{ '--i': 2 } as CSSProperties}
            onClick={() => {
              playUiSound('confirm');
              onCalibrate();
            }}
          >
            Calibrate timing
          </button>
          <button
            type="button"
            className="btn rise"
            style={{ '--i': 3 } as CSSProperties}
            onClick={() => {
              playUiSound('back');
              onDone();
            }}
          >
            Start playing
          </button>
        </div>
      )}
    </div>
  );
}

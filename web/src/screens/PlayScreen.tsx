import type { Beatmap, Chart, DifficultyName, Note } from '@tap-tap/shared';
import { DIFFICULTIES, keymapFor, themeCatalog, themeFor } from '@tap-tap/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
import { getBeatmap, listCustomThemes } from '../api/client.js';
import { AudioClock, bandLevel } from '../game/clock.js';
import { GameEngine } from '../game/engine.js';
import { gradeFor, type Tier, type Timing } from '../game/judge.js';
import type { RunResult } from '../game/run.js';
import { cancelHaptics, vibrateMiss, vibrateTap } from '../haptics.js';
import { useWakeLock } from '../hooks/useWakeLock.js';
import { Highway } from '../render/highway.js';
import { TIER_COLORS, TIER_LABELS, TIMING_COLORS, TIMING_LABELS } from '../render/palette.js';
import { HapticToggle } from '../components/HapticToggle.js';
import { getStoredCalibration } from '../storage.js';
import { resolveCalibration } from '../game/calibration.js';

/**
 * Seconds of silence before the audio begins. Without it the first notes are
 * already inside the approach window when the song starts, so they are
 * unhittable no matter how good the player is.
 */
const LEAD_IN_SEC = 3;

/** Countdown after un-pausing, so play does not resume mid-stream. */
const RESUME_COUNTDOWN_SEC = 3;

/**
 * How long the track keeps playing after the final note.
 *
 * A chart's last note usually lands well before the audio ends, so ending the
 * run the instant it is judged chops the song off mid-phrase. Let it ride, then
 * fade out.
 */
const OUTRO_SEC = 4;
const OUTRO_FADE_SEC = 2.5;

/**
 * How long the finished highway stays up while the crowd cheers, before the
 * results card replaces it. Slightly longer than the cheer so it is not cut off
 * mid-decay — the same abruptness the outro fade exists to avoid.
 */
const CHEER_HOLD_MS = 1750;

/**
 * Skip a long beatless intro rather than making the player wait through it.
 *
 * Some tracks open with 30 seconds of quiet atmosphere that contains no
 * percussive onsets at all. The chart is empty there because the music really
 * has no beats — inventing notes to fill it would be worse — so playback simply
 * starts near the first note instead.
 */
const INTRO_SKIP_THRESHOLD_SEC = 8;
const INTRO_SKIP_LEAD_SEC = 3;
/** A note counts as "sustained" if this many follow it within the window. */
const SUSTAINED_WINDOW_SEC = 8;
const SUSTAINED_MIN_NOTES = 4;

/**
 * Where playback should begin.
 *
 * Skipping to the *first* note is not enough: an atmospheric intro can contain
 * one isolated hit followed by another 20 seconds of nothing. Find where the
 * chart actually gets going — the first note with several others close behind —
 * and start shortly before that.
 */
/**
 * Read fresh for every engine, so recalibrating and restarting takes effect
 * without reloading the page.
 */
function effectiveCalibration(clock: AudioClock): number {
  return resolveCalibration(getStoredCalibration(), clock.outputLatency);
}

function startOffsetFor(notes: readonly Note[]): number {
  if (notes.length === 0) return 0;

  for (let i = 0; i < notes.length; i++) {
    const from = notes[i]!.t;
    let count = 0;
    for (let j = i; j < notes.length && notes[j]!.t < from + SUSTAINED_WINDOW_SEC; j++) count++;
    if (count >= SUSTAINED_MIN_NOTES) {
      return from < INTRO_SKIP_THRESHOLD_SEC ? 0 : Math.max(0, from - INTRO_SKIP_LEAD_SEC);
    }
  }

  const first = notes[0]!.t;
  return first < INTRO_SKIP_THRESHOLD_SEC ? 0 : Math.max(0, first - INTRO_SKIP_LEAD_SEC);
}

interface PlayScreenProps {
  songId: string;
  difficulty: DifficultyName;
  /** Reports the loaded chart's title — the URL carries only ids. */
  onTitle: (title: string) => void;
  onExit: () => void;
  onFinish: (result: RunResult) => void;
}

type Phase = 'loading' | 'ready' | 'playing' | 'paused' | 'error';

interface Controls {
  start: () => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
}

export function PlayScreen({
  songId,
  difficulty,
  onTitle,
  onExit,
  onFinish,
}: PlayScreenProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [beatmap, setBeatmap] = useState<Beatmap | null>(null);
  /** Flips exactly once, when the engine is built. Gates the input effect. */
  const [engineReady, setEngineReady] = useState(false);
  /**
   * Download progress, 0..1. Only state that survives to the next paint is kept
   * here; this one is fine because it changes a few times a second at most and
   * nothing is rendering yet while it moves.
   */
  const [loadProgress, setLoadProgress] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  const accuracyRef = useRef<HTMLDivElement>(null);
  const judgementRef = useRef<HTMLDivElement>(null);
  const timingRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  // Mutable game objects live in refs: they change every frame and must never
  // trigger a React render.
  const clockRef = useRef<AudioClock | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  /** Kept so Restart can build a fresh engine without refetching the beatmap. */
  const chartRef = useRef<Chart | null>(null);
  /** Seconds of beatless intro skipped at the start of this run. */
  const introOffsetRef = useRef(0);
  const highwayRef = useRef<Highway | null>(null);
  const rafRef = useRef<number | null>(null);
  const controlsRef = useRef<Controls | null>(null);
  /** Pending hand-off to the results screen, held while the cheer plays. */
  const finishTimerRef = useRef<number | null>(null);

  /**
   * The phase the game logic reads. Kept alongside the state copy because the
   * render loop must not be torn down and rebuilt when the phase changes —
   * doing so cancels the very animation frame that started it.
   */
  const phaseRef = useRef<Phase>('loading');
  const applyPhase = (next: Phase): void => {
    phaseRef.current = next;
    setPhase(next);
  };

  // Callbacks arrive as fresh closures each render; hold them in refs so the
  // input effect never re-runs on the parent's account.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;

  const params = DIFFICULTIES[difficulty];

  // Held for the whole screen, not just while playing: the ready and pause
  // screens can sit untouched for a while too.
  useWakeLock(true);

  // External-system setup: network, Web Audio, WebGL. Genuine side effects.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function setup(): Promise<void> {
      try {
        // Custom themes are fetched alongside the beatmap rather than cached in
        // a module: a shared cache would make theme resolution impure and
        // load-order dependent, which is the same reason `laneColor` takes a
        // theme instead of reading one. A failed fetch falls back to built-ins
        // only — a song with a custom theme then renders as the default, which
        // is the documented behaviour for an unresolvable id anyway.
        const [map, customThemes] = await Promise.all([
          getBeatmap(songId),
          listCustomThemes().catch(() => []),
        ]);
        if (cancelled) return;

        const chart = map.charts[difficulty];
        if (!chart || chart.notes.length === 0) {
          throw new Error(`This song has no ${difficulty} chart`);
        }

        const clock = await AudioClock.load(map.audioUrl, controller.signal, (fraction) => {
          if (!cancelled) setLoadProgress(fraction);
        });
        if (cancelled) {
          void clock.dispose();
          return;
        }

        const canvas = canvasRef.current;
        if (!canvas) throw new Error('Canvas unavailable');

        // Notes before the start offset are dropped from the run entirely.
        // Leaving them in would have the engine retire every one as a miss the
        // instant the clock starts past them, wrecking the score before the
        // player has touched a key.
        const offset = startOffsetFor(chart.notes);
        const played: Chart =
          offset > 0 ? { ...chart, notes: chart.notes.filter((n) => n.t >= offset) } : chart;

        clockRef.current = clock;
        chartRef.current = played;
        introOffsetRef.current = offset;
        engineRef.current = new GameEngine(played, {
          calibrationSec: effectiveCalibration(clock),
          minGapSec: params.minGapSec,
        });
        highwayRef.current = new Highway({
          canvas,
          laneCount: chart.laneCount,
          approachSec: params.approachSec,
          theme: themeFor(themeCatalog(customThemes), map.themeId),
          beatGrid: map.beatGrid,
        });
        highwayRef.current.resize(canvas.clientWidth, canvas.clientHeight);

        setBeatmap(map);
        onTitleRef.current(map.title);
        applyPhase('ready');
        setEngineReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        applyPhase('error');
      }
    }

    void setup();

    return () => {
      cancelled = true;
      controller.abort();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      highwayRef.current?.dispose();
      highwayRef.current = null;
      void clockRef.current?.dispose();
      clockRef.current = null;
      engineRef.current = null;
      setEngineReady(false);
      phaseRef.current = 'loading';
    };
  }, [songId, difficulty, params.approachSec]);

  // Keep the WebGL drawing buffer matched to the element size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = (): void => {
      const { clientWidth, clientHeight } = canvas;
      if (clientWidth > 0 && clientHeight > 0) {
        highwayRef.current?.resize(clientWidth, clientHeight);
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [engineReady]);

  // Input and the render loop. Deliberately depends only on `engineReady`, so
  // it is installed once per song and never rebuilt mid-play.
  useEffect(() => {
    if (!engineReady) return;

    const keys = keymapFor(params.laneCount);
    let judgementAlpha = 0;
    let lastFrame = performance.now();
    let outroStarted = false;
    const spectrum = new Uint8Array(new ArrayBuffer(512));
    const lastNoteAt = chartRef.current?.notes.at(-1)?.t ?? 0;
    const introOffset = introOffsetRef.current;

    const showJudgement = (tier: Tier, timing: Timing | null): void => {
      const el = judgementRef.current;
      if (el) {
        el.textContent = TIER_LABELS[tier];
        el.style.color = TIER_COLORS[tier];
      }
      // The early/late tag is the feedback that actually teaches timing.
      const tag = timingRef.current;
      if (tag) {
        tag.textContent = timing ? TIMING_LABELS[timing] : '';
        tag.style.color = timing ? TIMING_COLORS[timing] : '#fff';
      }
      judgementAlpha = 1;
    };

    const finish = (): void => {
      const engine = engineRef.current;
      if (!engine || phaseRef.current === 'loading') return;
      phaseRef.current = 'loading';

      const snap = engine.snapshot;
      const clock = clockRef.current;
      clock?.stop();
      // Scaled by the run: an F grade should not get a stadium ovation.
      clock?.playCheer(0.3 + snap.accuracy * 0.7);

      const result = {
        score: snap.score,
        accuracy: snap.accuracy,
        maxCombo: snap.maxCombo,
        grade: gradeFor(snap.accuracy),
        counts: snap.counts,
        timingCounts: snap.timingCounts,
        meanDelta: snap.meanDelta,
        totalNotes: snap.totalNotes,
      };

      // Hold on the finished board so the cheer is heard before the results
      // card takes over. Navigating immediately would cut it off instantly,
      // since unmounting disposes the AudioContext playing it.
      finishTimerRef.current = window.setTimeout(() => {
        finishTimerRef.current = null;
        onFinishRef.current(result);
      }, CHEER_HOLD_MS);
    };

    // Belt and braces. The frame loop finishes on `songTime >= duration`, but it
    // only samples once per frame, so a run that ends exactly between two frames
    // could slip past the comparison and leave the player on a frozen board.
    // The buffer source firing `onended` is the one signal that cannot be
    // missed. `finish` guards against running twice, so whichever arrives first
    // wins.
    clockRef.current?.onEnded(() => finish());

    // Driven by the clock's own lead-in rather than by song time, so the same
    // code covers the opening countdown and every resume.
    let counting = false;
    let goUntil = 0;

    const paintCountdown = (nowSec: number): void => {
      const el = countdownRef.current;
      const clock = clockRef.current;
      if (!el || !clock) return;

      const remaining = clock.leadInRemaining;

      if (remaining > 0) {
        counting = true;
        el.textContent = String(Math.max(1, Math.ceil(remaining)));
        el.style.opacity = '1';
        // Each digit swells as it lands.
        el.style.transform = `translate(-50%, -50%) scale(${1 + (1 - (remaining % 1)) * 0.35})`;
        return;
      }

      if (counting) {
        counting = false;
        goUntil = nowSec + 0.7;
      }

      const goLeft = goUntil - nowSec;
      if (goLeft > 0) {
        el.textContent = 'GO';
        el.style.opacity = String(goLeft / 0.7);
        el.style.transform = `translate(-50%, -50%) scale(${1 + (0.7 - goLeft)})`;
      } else if (el.textContent !== '') {
        el.textContent = '';
        el.style.opacity = '0';
      }
    };

    // An exception inside a requestAnimationFrame callback simply stops the
    // loop: nothing reschedules, and the screen goes black with no error
    // surfaced anywhere. Report the first failure rather than dying silently.
    let loopFailed = false;
    const frame = (now: number): void => {
      try {
        step(now);
      } catch (err) {
        if (!loopFailed) {
          loopFailed = true;
          console.error('[tap-tap] render loop error', err);
          setError(err instanceof Error ? err.message : String(err));
          applyPhase('error');
        }
      }
    };

    const step = (now: number): void => {
      const engine = engineRef.current;
      const clock = clockRef.current;
      const highway = highwayRef.current;
      if (!engine || !clock || !highway) return;

      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      const songTime = clock.currentTime;
      // What the player sees and hears, which on a calibrated device trails the
      // clock. Everything visual is drawn at this time so the pill meets the
      // receptor on the beat rather than one output latency early; `update` and
      // `hitLane` take raw clock time and shift it themselves.
      const shownTime = engine.judgementTime(songTime);

      for (const missed of engine.update(songTime)) {
        highway.burst(missed.note.lane, 'miss');
        showJudgement('miss', null);
        vibrateMiss();
      }

      clock.readSpectrum(spectrum);
      const bass = bandLevel(spectrum, 1, 8);
      const treble = bandLevel(spectrum, 60, 160);

      highway.render(
        shownTime,
        engine.visibleNotes(shownTime, params.approachSec),
        dt,
        bass,
        treble,
      );
      paintCountdown(now / 1000);

      // HUD is written straight to the DOM — re-rendering React at 60fps would
      // cost more than the entire render loop.
      const snap = engine.snapshot;
      if (scoreRef.current) scoreRef.current.textContent = snap.score.toLocaleString();
      if (comboRef.current) comboRef.current.textContent = snap.combo > 2 ? `${snap.combo}x` : '';
      if (accuracyRef.current) {
        accuracyRef.current.textContent = `${(snap.accuracy * 100).toFixed(1)}%`;
      }
      if (progressRef.current && clock.duration > 0) {
        const played = Math.max(0, songTime);
        progressRef.current.style.width = `${Math.min(100, (played / clock.duration) * 100)}%`;
      }

      judgementAlpha = Math.max(0, judgementAlpha - dt * 2.2);
      if (judgementRef.current) judgementRef.current.style.opacity = String(judgementAlpha);
      if (timingRef.current) timingRef.current.style.opacity = String(judgementAlpha * 0.9);

      // Ride out the tail rather than cutting on the last note.
      if (snap.finished && !outroStarted) {
        outroStarted = true;
        const remaining = Math.max(0, clock.duration - songTime);
        clock.fadeOut(Math.min(OUTRO_FADE_SEC, Math.max(0.4, remaining - 0.2)));
      }

      const outroDone = songTime >= lastNoteAt + OUTRO_SEC;
      if ((snap.finished && outroDone) || (songTime > 0 && songTime >= clock.duration)) {
        finish();
        return;
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    /**
     * Which lane each finger grabbed, by `pointerId`.
     *
     * The lane is resolved once on press and remembered — **it is deliberately
     * not recomputed on release**. A finger drifts while it holds, and asking
     * `laneAtScreenPoint` where it ended up would break a hold the player never
     * let go of, or worse, release a neighbouring lane they were still holding.
     * A map also makes multi-touch work at all: two fingers on two lanes are two
     * entries, and neither release can be mistaken for the other.
     */
    const laneByPointer = new Map<number, number>();

    /** Let go of everything. Used when the player stops playing mid-hold. */
    const releaseAllHeld = (): void => {
      const engine = engineRef.current;
      const clock = clockRef.current;
      laneByPointer.clear();
      if (!engine || !clock) return;
      for (let lane = 0; lane < params.laneCount; lane++) {
        engine.releaseLane(lane, clock.currentTime);
      }
    };

    const start = (): void => {
      const clock = clockRef.current;
      if (!clock || clock.isPlaying || phaseRef.current !== 'ready') return;
      void clock.start(introOffset, LEAD_IN_SEC);
      applyPhase('playing');
      lastFrame = performance.now();
      rafRef.current = requestAnimationFrame(frame);
    };

    const pause = (): void => {
      const clock = clockRef.current;
      if (!clock || phaseRef.current !== 'playing') return;

      // Drop any held lanes first.
      //
      // Alt-tabbing fires `blur`, which pauses — but it does *not* fire keyup,
      // so without this the engine still believes the key is down. The hold
      // would then auto-complete at its tail on resume and hand out a bonus for
      // a note nobody was holding. Releasing here is also just true: the player
      // has stopped playing.
      releaseAllHeld();

      clock.pause();
      applyPhase('paused');
      // The loop keeps running so the scene stays alive behind the menu. Song
      // time is frozen, so the engine judges nothing while paused.
    };

    const resume = (): void => {
      const clock = clockRef.current;
      if (!clock || phaseRef.current !== 'paused') return;
      void clock.resume(RESUME_COUNTDOWN_SEC);
      applyPhase('playing');
    };

    const restart = (): void => {
      const clock = clockRef.current;
      const engine = engineRef.current;
      if (!clock || !engine) return;
      // A fresh engine is the simplest correct reset: score, combo and every
      // note's judged state all come back with it.
      engineRef.current = new GameEngine(chartRef.current!, {
        calibrationSec: effectiveCalibration(clock),
        minGapSec: params.minGapSec,
      });
      outroStarted = false;
      void clock.start(introOffset, LEAD_IN_SEC);
      applyPhase('playing');
      lastFrame = performance.now();
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(frame);
    };

    controlsRef.current = { start, pause, resume, restart };

    const hit = (lane: number): void => {
      // First statement in the path: the buzz acknowledges the tap, so nothing
      // — not even reading the clock — sits between the press and the feedback.
      vibrateTap();

      const engine = engineRef.current;
      const clock = clockRef.current;
      const highway = highwayRef.current;
      if (!engine || !clock || !highway) return;

      highway.flashLane(lane);
      const result = engine.hitLane(lane, clock.currentTime);
      if (result) {
        highway.burst(lane, result.tier);
        showJudgement(result.tier, result.timing);
      }
    };

    /**
     * Let go of a lane.
     *
     * A no-op unless a hold is actually down there, so it is safe to call on
     * every key and finger release without asking first.
     */
    const release = (lane: number): void => {
      const engine = engineRef.current;
      const clock = clockRef.current;
      if (!engine || !clock) return;

      const result = engine.releaseLane(lane, clock.currentTime);
      if (!result) return;

      if (result.completed) {
        // Same burst as a hit: finishing a hold is the same kind of success and
        // should feel like one.
        highwayRef.current?.burst(lane, 'perfect');
        vibrateTap();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      // Key repeat would let a held key farm every note in a lane.
      if (event.repeat) return;

      // Escape pauses rather than quitting outright — losing a run to a stray
      // keypress is worse than one extra click to leave.
      if (event.key === 'Escape') {
        event.preventDefault();
        if (phaseRef.current === 'playing') pause();
        else if (phaseRef.current === 'paused') resume();
        else onExitRef.current();
        return;
      }

      // `code` rather than `key`: more robust across layouts and event sources.
      if (event.code === 'Space' || event.code === 'Enter') {
        if (phaseRef.current === 'ready') {
          event.preventDefault();
          start();
          return;
        }
        if (phaseRef.current === 'paused') {
          event.preventDefault();
          resume();
          return;
        }
      }

      if (phaseRef.current !== 'playing') return;

      const lane = keys.indexOf(event.key.toLowerCase());
      if (lane === -1) return;
      event.preventDefault();
      hit(lane);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (phaseRef.current !== 'playing') return;
      const lane = keys.indexOf(event.key.toLowerCase());
      if (lane === -1) return;
      release(lane);
    };

    const canvas = canvasRef.current;


    const onPointerDown = (event: PointerEvent): void => {
      if (phaseRef.current === 'ready') {
        start();
        return;
      }
      if (phaseRef.current !== 'playing' || !canvas) return;

      const highway = highwayRef.current;
      if (!highway) return;

      // Asking the renderer rather than splitting the canvas into equal columns.
      // The lanes are neither evenly spaced nor where they look — perspective
      // converges them and the fisheye moves them again after rendering — so
      // only the renderer can answer this.
      const rect = canvas.getBoundingClientRect();
      const lane = highway.laneAtScreenPoint(
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
      );
      if (lane >= 0 && lane < params.laneCount) {
        laneByPointer.set(event.pointerId, lane);
        hit(lane);
      }
    };

    const onPointerUp = (event: PointerEvent): void => {
      const lane = laneByPointer.get(event.pointerId);
      if (lane === undefined) return;
      laneByPointer.delete(event.pointerId);
      release(lane);
    };

    /**
     * Pause whenever the game stops being the thing in front of the player.
     *
     * Alt-tabbing, switching apps, or locking a phone otherwise leaves the song
     * playing to an empty room and every note retiring as a miss — you come
     * back to a wrecked run. `pause` already no-ops unless a run is actually
     * playing, so this is safe to fire on both signals.
     *
     * Both are needed: `visibilitychange` covers a backgrounded tab or a
     * screen-locked phone, `blur` covers a desktop window losing focus while
     * still fully visible, which never fires `visibilitychange`.
     */
    const onLeave = (): void => pause();
    const onVisibility = (): void => {
      if (document.hidden) pause();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onVisibility);
    canvas?.addEventListener('pointerdown', onPointerDown);
    // On `window`, not the canvas: a finger that slides off the canvas — or off
    // the screen edge — still fires these, and a release that never arrives
    // leaves the lane held forever. `pointercancel` matters on touch, where the
    // browser can take the pointer away for a scroll or a system gesture.
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas?.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      controlsRef.current = null;
      // Quitting mid-cheer must not navigate to results afterwards.
      if (finishTimerRef.current !== null) {
        window.clearTimeout(finishTimerRef.current);
        finishTimerRef.current = null;
      }
      // Never leave the device buzzing after the screen is gone.
      cancelHaptics();
    };
  }, [engineReady, params.laneCount, params.approachSec]);

  const keys = keymapFor(params.laneCount);

  return (
    <div className="play" data-phase={phase} data-engine-ready={String(engineReady)}>
      <canvas ref={canvasRef} className="play__canvas" />

      <div className="play__progress">
        <div ref={progressRef} className="play__progress-bar" />
      </div>

      <div className="play__hud">
        <div className="play__hud-left">
          <div className="hud-label">SCORE</div>
          <div ref={scoreRef} className="hud-score">0</div>
        </div>
        <div className="play__hud-right">
          <div className="hud-label">ACCURACY</div>
          <div ref={accuracyRef} className="hud-accuracy">100.0%</div>
        </div>
      </div>

      <div ref={comboRef} className="play__combo" />
      <div ref={judgementRef} className="play__judgement" style={{ opacity: 0 }} />
      <div ref={timingRef} className="play__timing" style={{ opacity: 0 }} />
      <div ref={countdownRef} className="play__countdown" style={{ opacity: 0 }} />

      {phase === 'playing' && (
        <button
          type="button"
          className="play__pause-btn"
          aria-label="Pause"
          onClick={() => controlsRef.current?.pause()}
        >
          ❚❚
        </button>
      )}

      {phase === 'paused' && (
        <div className="play__overlay">
          <h2>Paused</h2>
          {beatmap && <p className="muted">{beatmap.title}</p>}
          <div className="pause-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => controlsRef.current?.resume()}
            >
              Resume
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => controlsRef.current?.restart()}
            >
              Restart
            </button>
            <button type="button" className="btn btn--ghost" onClick={onExit}>
              Quit
            </button>
          </div>
          {/* Below the actions, not among them: this changes a setting rather
              than the state of the run, and it must not sit next to Quit where
              a mistap costs a whole song. */}
          <HapticToggle className="pause-setting" />
          <p className="muted small">ESC or SPACE to resume</p>
        </div>
      )}

      {phase === 'loading' && (
        <div className="play__overlay">
          <div className="spinner" />
          <p>Loading song…</p>
          {/* Only once the download is actually moving — a bar sitting at 0%
              looks more broken than no bar at all. */}
          {loadProgress > 0 && (
            <div className="load-bar" aria-label="Download progress">
              <div className="load-bar__fill" style={{ width: `${Math.round(loadProgress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {phase === 'error' && (
        <div className="play__overlay">
          <h2>Could not start</h2>
          <p className="error-text">{error}</p>
          <button type="button" className="btn" onClick={onExit}>
            Back to songs
          </button>
        </div>
      )}

      {phase === 'ready' && beatmap && (
        <div className="play__overlay play__overlay--ready">
          <h2>{beatmap.title}</h2>
          <p className="muted">
            {difficulty} · {params.laneCount} lanes · {beatmap.bpm} BPM
          </p>
          <div className="keycaps">
            {keys.map((key) => (
              <kbd key={key}>{key.toUpperCase()}</kbd>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => controlsRef.current?.start()}
          >
            Press SPACE to start
          </button>
          <p className="muted small">ESC to pause</p>
        </div>
      )}
    </div>
  );
}

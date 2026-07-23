import type { Beatmap, Chart, DifficultyName, Note } from '@tap-tap/shared';
import { DEFAULT_ACCENT, DIFFICULTIES, isHold, keymapFor, themeCatalog, themeFor } from '@tap-tap/shared';
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { getBeatmap, listCustomThemes } from '../data/index.js';
import { AudioClock, bandLevel } from '../game/clock.js';
import { comboMilestone, comboTier } from '../game/combo.js';
import { GameEngine, type GameSnapshot } from '../game/engine.js';
import { accuracyOf, foldUnreached, gradeFor, type Tier, type Timing } from '../game/judge.js';
import { playUiSound } from '../uisfx.js';
import type { RunResult } from '../game/run.js';
import { cancelHaptics, vibrateHold, vibrateMiss, vibrateTap } from '../haptics.js';
import { useWakeLock } from '../hooks/useWakeLock.js';
import { Highway } from '../render/highway.js';
import { TIER_COLORS, TIER_LABELS, TIMING_COLORS, TIMING_LABELS } from '../render/palette.js';
import { HapticToggle } from '../components/HapticToggle.js';
import { SoundToggle } from '../components/SoundToggle.js';
import { ModifierPanel } from '../components/ModifierPanel.js';
import { CalibrationScreen } from './CalibrationScreen.js';
import { accentVars } from '../accent.js';
import { getStoredCalibration, getStoredModifiers, setCalibration, setStoredModifiers } from '../storage.js';
import { type Modifiers, mirrorNotes } from '../game/modifiers.js';
import { MIN_STORED_SEC, autoCalibrationStep, resolveCalibration } from '../game/calibration.js';

/**
 * Seconds of silence before the audio begins. Without it the first notes are
 * already inside the approach window when the song starts, so they are
 * unhittable no matter how good the player is.
 */
const LEAD_IN_SEC = 3;

/** Countdown after un-pausing, so play does not resume mid-stream. */
const RESUME_COUNTDOWN_SEC = 3;

/**
 * How long the track keeps playing after the final note, before the run ends.
 *
 * A chart's last note usually lands before the audio ends, so cutting the run
 * the instant it is judged chops the song off mid-phrase. Ride it out for this
 * long — with the audio fading across the same window — then finish. The fade
 * is timed to land exactly on this point, not on the audio's own end, so the
 * ending feels the same whether the track has two seconds of tail left or two
 * minutes.
 */
const OUTRO_SEC = 2;

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

/**
 * A hold whose head lands within this much of the start has too little runway to
 * be grabbed — the note is at the receptor almost as the song begins, and unlike
 * a tap you would miss the *whole* sustain, not just an instant. Such holds are
 * demoted to taps so the opening is always playable. Measured from where
 * playback actually starts (`offset`), so an intro-skip that already leaves
 * several seconds of runway keeps its holds.
 */
const HOLD_START_LEAD_SEC = 1.5;
/** A note counts as "sustained" if this many follow it within the window. */
const SUSTAINED_WINDOW_SEC = 8;
const SUSTAINED_MIN_NOTES = 4;

/**
 * No note is required in the first second after playback begins.
 *
 * A chart that opens on beat one otherwise lands a note on the player the
 * instant the count-in ends, with no beat to settle. Notes inside this window
 * are dropped — the music still plays them — rather than delayed, which would
 * desync every note from the audio it was timed against. Measured from where
 * playback actually starts (`offset`), so an intro-skip already past this keeps
 * all its notes.
 */
const START_GRACE_SEC = 1;

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

/**
 * Best-effort fullscreen, so the mobile browser's URL bar gets out of the way
 * during a run. Must be called from a user gesture (the start/resume tap is one).
 *
 * Android Chrome honours it and drops all browser chrome. iOS Safari has no
 * Fullscreen API for a page, so this is a silent no-op there — the only way to
 * lose the URL bar on iOS is to install the app to the home screen (the PWA runs
 * in standalone mode with no chrome, which needs a secure HTTPS origin).
 */
function enterFullscreen(): void {
  if (document.fullscreenElement) return;
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => unknown;
  };
  const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
  if (!req) return;
  try {
    const result = req();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // No gesture, unsupported, or the user declined — nothing to do.
  }
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
  onFinish: (result: RunResult, accent: number) => void;
}

type Phase = 'loading' | 'ready' | 'playing' | 'paused' | 'error';

interface Controls {
  start: () => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  /** Ends the run and keeps the score — quitting from the pause menu is a game-over. */
  quit: () => void;
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
  /** The playing song's theme accent, so ready/results keep the track's palette. */
  const [themeAccent, setThemeAccent] = useState<number>(DEFAULT_ACCENT);
  const accentRef = useRef<number>(DEFAULT_ACCENT);
  /** The pause menu is two steps: the main actions, or the calibration sub-view. */
  const [pauseView, setPauseView] = useState<'menu' | 'calibrate'>('menu');
  const pauseViewRef = useRef<'menu' | 'calibrate'>('menu');
  pauseViewRef.current = pauseView;

  /**
   * Per-run modifiers, chosen on the ready screen. Seeded from the last-used set
   * so a player's choice persists. Read through a ref by the engine builder so a
   * change on the ready screen takes effect on the *next* start without the
   * input/render effect re-running.
   */
  const [mods, setMods] = useState<Modifiers>(getStoredModifiers);
  const modsRef = useRef<Modifiers>(mods);
  modsRef.current = mods;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  const accuracyRef = useRef<HTMLDivElement>(null);
  /** Health bar fill; width + colour written from the render loop. */
  const healthRef = useRef<HTMLDivElement>(null);
  const judgementRef = useRef<HTMLDivElement>(null);
  const timingRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  /** Combo-milestone banner ("50 COMBO"), flashed and animated imperatively. */
  const milestoneRef = useRef<HTMLDivElement>(null);
  /** Red edge flash on a broken combo. A class toggle replays the animation. */
  const vignetteRef = useRef<HTMLDivElement>(null);

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

  // --- live auto-calibration ---
  /** Recent confident-hit errors (late positive), a rolling window for auto-cal. */
  const autoDeltasRef = useRef<number[]>([]);
  /** Auto-calibration applied so far this run, for the drift cap. */
  const autoDriftRef = useRef(0);
  /** The "timing tuned" toast and its dismiss timer. */
  const calibToastRef = useRef<HTMLDivElement>(null);
  const calibTimerRef = useRef<number | null>(null);

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

  /**
   * Build a fresh engine for the played chart under the current modifiers.
   *
   * Mirror is applied here rather than baked into `chartRef`, so toggling it and
   * restarting re-flips from the unmodified chart instead of compounding. `Fail`
   * becomes the engine's `canFail`. Called at load, at start (to pick up a
   * ready-screen change), and at restart — all cheap, a chart is just an array.
   */
  const makeEngine = (chart: Chart, clock: AudioClock, run: Modifiers): GameEngine => {
    // Holds off → every hold plays as a plain tap. Then mirror, if on.
    let notes = run.holds
      ? chart.notes
      : chart.notes.map((n) => (isHold(n) ? { ...n, type: 'tap' as const, duration: undefined } : n));
    if (run.mirror) notes = mirrorNotes(notes, chart.laneCount);
    const played: Chart = notes === chart.notes ? chart : { ...chart, notes };
    return new GameEngine(played, {
      // Calibration is stored in real seconds (song-seconds at 1x). At rate r a
      // physical output latency of L real seconds is L*r song-seconds late, and
      // the engine subtracts song-seconds — so the offset scales with speed, or
      // a fast run would judge and draw everything a fraction off.
      calibrationSec: effectiveCalibration(clock) * run.speed,
      minGapSec: params.minGapSec,
      canFail: run.fail,
    });
  };

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
        // Plus a grace second (see START_GRACE_SEC): never demand a hit in the
        // first second of playback. Guarded so a pathologically short chart is
        // never emptied entirely.
        const firstPlayableAt = offset + START_GRACE_SEC;
        const graced = chart.notes.filter((n) => n.t >= firstPlayableAt);
        const kept = graced.length > 0 ? graced : chart.notes.filter((n) => n.t >= offset);
        // Demote holds too close to the start (see HOLD_START_LEAD_SEC): a hold
        // sitting on the hit line as the song begins is ungrabbable.
        const played: Chart = {
          ...chart,
          notes: kept.map((n) =>
            isHold(n) && n.t - offset < HOLD_START_LEAD_SEC
              ? { ...n, type: 'tap' as const, duration: undefined }
              : n,
          ),
        };

        clockRef.current = clock;
        chartRef.current = played;
        introOffsetRef.current = offset;
        engineRef.current = makeEngine(played, clock, modsRef.current);
        autoDeltasRef.current = [];
        autoDriftRef.current = 0;
        const theme = themeFor(themeCatalog(customThemes), map.themeId);
        accentRef.current = theme.accent ?? DEFAULT_ACCENT;
        highwayRef.current = new Highway({
          canvas,
          laneCount: chart.laneCount,
          approachSec: params.approachSec,
          theme,
          beatGrid: map.beatGrid,
          // The beatmap carries a platform-resolved thumbnail URL (an HTTP path
          // on the server, a convertFileSrc file URL on device); hardcoding
          // `/media/…` here would not resolve in the bundled Android app.
          coverUrl: map.thumbnailUrl ?? undefined,
        });
        highwayRef.current.resize(canvas.clientWidth, canvas.clientHeight);
        highwayRef.current.setVisibility(modsRef.current.visibility);

        setBeatmap(map);
        setThemeAccent(theme.accent ?? DEFAULT_ACCENT);
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
    // Combo from the previous frame, so the loop can spot a milestone crossing
    // or a break without the engine having to emit an event for it.
    let prevCombo = 0;
    let prevTier = 0;
    // Low-health warning state, toggled on the health bar only when it changes.
    let prevLow = false;

    /** Replay a one-shot CSS animation by clearing the class and forcing reflow. */
    const restartAnim = (el: HTMLElement | null, cls: string): void => {
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth; // reflow so the re-added class counts as a fresh start
      el.classList.add(cls);
    };
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
      // A quick pop on each new judgement, on top of the alpha decay below.
      restartAnim(el, 'play__judgement--pop');
      judgementAlpha = 1;
    };

    // Score a run over the *whole* chart, not just the notes reached. Any note
    // the player never got to (a mid-song quit) folds into the miss count, so
    // accuracy and grade reflect the entire song rather than the handful that
    // were faced. On a natural finish every note is already judged, so this
    // matches `snap.accuracy` exactly — the difference only bites an early quit.
    const buildResult = (snap: GameSnapshot): RunResult => {
      const counts = foldUnreached(snap.counts, snap.totalNotes);
      const accuracy = accuracyOf(counts);
      return {
        score: snap.score,
        accuracy,
        maxCombo: snap.maxCombo,
        grade: gradeFor(accuracy),
        counts,
        timingCounts: snap.timingCounts,
        meanDelta: snap.meanDelta,
        totalNotes: snap.totalNotes,
        failed: snap.failed,
      };
    };

    const finish = (): void => {
      const engine = engineRef.current;
      if (!engine || phaseRef.current === 'loading') return;
      phaseRef.current = 'loading';

      const snap = engine.snapshot;
      const result = buildResult(snap);
      const clock = clockRef.current;
      clock?.stop();
      // A failed run gets no ovation — a descending game-over sting and a quicker
      // hand-off to the results card, which shows FAILED. A natural finish rides
      // out the cheer, scaled by the run so an F grade does not get an ovation.
      if (result.failed) {
        playUiSound('fail');
      } else {
        clock?.playCheer(0.3 + result.accuracy * 0.7);
      }

      // Hold on the finished board so the cheer is heard before the results
      // card takes over. Navigating immediately would cut it off instantly,
      // since unmounting disposes the AudioContext playing it.
      finishTimerRef.current = window.setTimeout(() => {
        finishTimerRef.current = null;
        onFinishRef.current(result, accentRef.current);
      }, result.failed ? 700 : CHEER_HOLD_MS);
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
    // The last digit a beep was fired for, so each number beeps once as it
    // appears rather than every frame it is on screen.
    let lastBeepDigit = 0;

    const paintCountdown = (nowSec: number): void => {
      const el = countdownRef.current;
      const clock = clockRef.current;
      if (!el || !clock) return;

      const remaining = clock.leadInRemaining;

      if (remaining > 0) {
        counting = true;
        const digit = Math.max(1, Math.ceil(remaining));
        el.textContent = String(digit);
        el.style.opacity = '1';
        // Each digit swells as it lands.
        el.style.transform = `translate(-50%, -50%) scale(${1 + (1 - (remaining % 1)) * 0.35})`;
        // One beep per digit, on the frame it first shows.
        if (digit !== lastBeepDigit) {
          lastBeepDigit = digit;
          playUiSound('count');
        }
        return;
      }

      if (counting) {
        counting = false;
        goUntil = nowSec + 0.7;
        lastBeepDigit = 0;
        playUiSound('go');
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

      // A hold carried all the way to its tail completes inside `update` and
      // never passes through `release`, so it bursts from here instead — same
      // success feedback a released completion gets.
      for (const lane of engine.takeCompletedHoldLanes()) {
        highway.burst(lane, 'perfect', engine.snapshot.combo);
        vibrateTap();
      }

      // Rolling buzz for as long as any lane is held. Self-throttled.
      for (let lane = 0; lane < params.laneCount; lane++) {
        if (engine.heldNoteId(lane) >= 0) {
          vibrateHold();
          break;
        }
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
        spectrum,
      );
      paintCountdown(now / 1000);

      // HUD is written straight to the DOM — re-rendering React at 60fps would
      // cost more than the entire render loop.
      const snap = engine.snapshot;
      if (scoreRef.current) scoreRef.current.textContent = snap.score.toLocaleString();
      if (comboRef.current) {
        const combo = snap.combo;
        comboRef.current.textContent = combo > 2 ? `${combo}x` : '';
        // Tier drives the readout's size and glow; only touch the DOM when it
        // actually changes, since this runs every frame.
        const tier = comboTier(combo);
        if (tier !== prevTier) {
          comboRef.current.dataset.tier = String(tier);
          prevTier = tier;
        }
      }
      if (accuracyRef.current) {
        accuracyRef.current.textContent = `${(snap.accuracy * 100).toFixed(1)}%`;
      }
      if (healthRef.current) {
        healthRef.current.style.height = `${Math.max(0, snap.health * 100)}%`;
        // Warn when the margin gets thin — a class toggle drives the pulse, only
        // touched on the transition since this runs every frame.
        const low = snap.health <= 0.25;
        if (low !== prevLow) {
          healthRef.current.classList.toggle('play__health-fill--low', low);
          prevLow = low;
        }
      }

      // Health hit zero with Fail on: end the run as a game-over. `finish` scores
      // over the whole chart (unreached notes become misses) and flags `failed`.
      if (snap.failed) {
        finish();
        return;
      }

      // Milestone banner on the way up; red flash + soft sound on a break.
      const combo = snap.combo;
      const milestone = comboMilestone(prevCombo, combo);
      if (milestone !== null) {
        const banner = milestoneRef.current;
        if (banner) {
          banner.textContent = `${milestone} COMBO`;
          restartAnim(banner, 'play__milestone--show');
        }
        playUiSound('milestone');
      } else if (combo === 0 && prevCombo >= 10) {
        // Only a streak worth noticing "breaks" — dropping a 3-combo is not a
        // moment. Both the flash and the sound respect their mute settings.
        restartAnim(vignetteRef.current, 'play__vignette--flash');
        playUiSound('comboBreak');
      }
      prevCombo = combo;
      if (progressRef.current && clock.duration > 0) {
        const played = Math.max(0, songTime);
        progressRef.current.style.width = `${Math.min(100, (played / clock.duration) * 100)}%`;
      }

      judgementAlpha = Math.max(0, judgementAlpha - dt * 2.2);
      if (judgementRef.current) judgementRef.current.style.opacity = String(judgementAlpha);
      if (timingRef.current) timingRef.current.style.opacity = String(judgementAlpha * 0.9);

      const finishAt = lastNoteAt + OUTRO_SEC;

      // Ride out the tail rather than cutting on the last note. Fade across the
      // window between now and the finish point, so the audio reaches silence
      // exactly as the run ends — capped by the audio actually remaining, in
      // the rare case the track ends inside the outro.
      if (snap.finished && !outroStarted) {
        outroStarted = true;
        const untilFinish = finishAt - songTime;
        const audioLeft = Math.max(0, clock.duration - songTime) - 0.2;
        // `fadeOut` takes *real* seconds, but these are song-seconds — at rate r
        // the same span of song passes in 1/r the real time, so divide.
        const realLeft = Math.min(untilFinish, audioLeft) / clock.rate;
        clock.fadeOut(Math.max(0.4, realLeft));
      }

      const outroDone = songTime >= finishAt;
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
      // Called from the start tap — the gesture fullscreen needs.
      enterFullscreen();
      // Rebuild the engine so any modifier changed on the ready screen (Fail,
      // Mirror) is honoured — the one built during loading predates them.
      engineRef.current = makeEngine(chartRef.current!, clock, modsRef.current);
      highwayRef.current?.setVisibility(modsRef.current.visibility);
      clock.setRate(modsRef.current.speed);
      autoDeltasRef.current = [];
      autoDriftRef.current = 0;
      outroStarted = false;
      prevCombo = 0;
      prevTier = 0;
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
      // Every pause opens on the main actions, never mid-calibration.
      setPauseView('menu');
      applyPhase('paused');
      // The loop keeps running so the scene stays alive behind the menu. Song
      // time is frozen, so the engine judges nothing while paused.
    };

    const resume = (): void => {
      const clock = clockRef.current;
      if (!clock || phaseRef.current !== 'paused') return;
      playUiSound('back');
      // Re-hide the URL bar if leaving fullscreen (e.g. Escape) dropped it.
      enterFullscreen();
      void clock.resume(RESUME_COUNTDOWN_SEC);
      applyPhase('playing');
    };

    const restart = (): void => {
      const clock = clockRef.current;
      const engine = engineRef.current;
      if (!clock || !engine) return;
      // A fresh engine is the simplest correct reset: score, combo, health and
      // every note's judged state all come back with it. Reads the current
      // modifiers so a change made in the pause menu applies on restart too.
      engineRef.current = makeEngine(chartRef.current!, clock, modsRef.current);
      autoDeltasRef.current = [];
      autoDriftRef.current = 0;
      outroStarted = false;
      prevCombo = 0;
      prevTier = 0;
      void clock.start(introOffset, LEAD_IN_SEC);
      applyPhase('playing');
      lastFrame = performance.now();
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(frame);
    };

    const quit = (): void => {
      const engine = engineRef.current;
      // No run to score (shouldn't happen from pause, but stay safe): just leave.
      if (!engine) {
        onExitRef.current();
        return;
      }
      // Quitting from the pause menu is a deliberate game-over — keep the score.
      // Cancel any pending natural-finish hand-off so it can't double-navigate.
      if (finishTimerRef.current !== null) {
        window.clearTimeout(finishTimerRef.current);
        finishTimerRef.current = null;
      }
      phaseRef.current = 'loading';
      clockRef.current?.stop();
      // Scored over the whole chart: the notes never reached count as misses, so
      // quitting three notes in cannot read as a flawless S-grade best.
      onFinishRef.current(buildResult(engine.snapshot), accentRef.current);
    };

    controlsRef.current = { start, pause, resume, restart, quit };

    const hit = (lane: number): void => {
      const engine = engineRef.current;
      const clock = clockRef.current;
      const highway = highwayRef.current;
      if (!engine || !clock || !highway) return;

      // Ignore taps during the 3-2-1 lead-in: the board is not live yet, so a
      // tap has nothing to hit, and letting it flash and buzz makes the
      // countdown feel interactive when it is not.
      if (clock.leadInRemaining > 0) return;

      // The buzz acknowledges the tap first, before any scoring work, so nothing
      // sits between the press and the feedback.
      vibrateTap();

      highway.flashLane(lane);
      const result = engine.hitLane(lane, clock.currentTime);
      if (result) {
        // Combo drives how hard the impact shakes — a long streak hits heavier.
        highway.burst(lane, result.tier, result.combo);
        showJudgement(result.tier, result.timing);
        autoCalibrate(engine, result.tier, result.delta);
      }
    };

    /**
     * Learn the player's latency from their own hits, live.
     *
     * Only *confident* hits feed it — perfect and great, never a sloppy `good`
     * near the miss window, which would just add noise. Once a window has filled
     * it nudges the engine's offset by a tiny, capped amount toward zeroing the
     * measured bias (`autoCalibrationStep` owns the maths and the sign), then
     * clears the window to measure the residual afresh. The nudge is small enough
     * to be invisible mid-song; the real payoff is persisting the result, so the
     * *next* song starts already calibrated. This is why the metronome screen is
     * now optional rather than a gate.
     */
    const autoCalibrate = (engine: GameEngine, tier: Tier, delta: number): void => {
      if (tier !== 'perfect' && tier !== 'great') return;
      // A sped-up or slowed run measures a *scaled* bias (the engine's offset is
      // in song-seconds, scaled by rate), so persisting it would corrupt the
      // real-time calibration every other run relies on. Leave it alone at any
      // non-normal speed — the stored value only means anything at 1x.
      if (modsRef.current.speed !== 1) return;

      const window = autoDeltasRef.current;
      window.push(delta);

      const step = autoCalibrationStep(window, autoDriftRef.current);
      if (step === 0) return;

      engine.bumpCalibration(step);
      autoDriftRef.current += step;
      window.length = 0;
      // Persist floored, for the same reason `resolveCalibration` floors on read:
      // a value below `MIN_STORED_SEC` is physically impossible and makes the
      // game unplayable, so it must never reach storage.
      setCalibration(Math.max(MIN_STORED_SEC, engine.calibration));
      showCalibToast();
    };

    /** Brief, unobtrusive "timing tuned" flash so the auto-cal is visible when it acts. */
    const showCalibToast = (): void => {
      const el = calibToastRef.current;
      if (!el) return;
      el.style.opacity = '1';
      if (calibTimerRef.current !== null) window.clearTimeout(calibTimerRef.current);
      calibTimerRef.current = window.setTimeout(() => {
        el.style.opacity = '0';
      }, 850);
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
        highwayRef.current?.burst(lane, 'perfect', engine.snapshot.combo);
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
        else if (phaseRef.current === 'paused') {
          // In the calibration sub-view, Escape steps back to the pause menu
          // rather than resuming the run out from under it.
          if (pauseViewRef.current === 'calibrate') setPauseView('menu');
          else resume();
        } else onExitRef.current();
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
          // While calibrating, SPACE is the metronome tap — leave it for the
          // calibration screen's own handler rather than resuming.
          if (pauseViewRef.current === 'calibrate') return;
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
      if (calibTimerRef.current !== null) {
        window.clearTimeout(calibTimerRef.current);
        calibTimerRef.current = null;
      }
      // Never leave the device buzzing after the screen is gone.
      cancelHaptics();
    };
  }, [engineReady, params.laneCount, params.approachSec]);

  const keys = keymapFor(params.laneCount);

  return (
    <div
      className="play"
      data-phase={phase}
      data-engine-ready={String(engineReady)}
      style={accentVars(themeAccent)}
    >
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

      {/* Health. A vertical meter down the left edge, out of the way of the
          cover art. Hidden outside a run (CSS, keyed on data-phase). Height +
          low-health pulse are written from the render loop. */}
      <div className="play__health" aria-hidden>
        <div ref={healthRef} className="play__health-fill" style={{ height: '100%' }} />
      </div>

      {/* Red edge flash on a broken combo. Sits above the canvas, below the
          HUD; the animation class is toggled from the render loop. */}
      <div ref={vignetteRef} className="play__vignette" aria-hidden />

      <div ref={comboRef} className="play__combo" data-tier="0" />
      <div ref={milestoneRef} className="play__milestone" aria-hidden />
      <div ref={judgementRef} className="play__judgement" style={{ opacity: 0 }} />
      <div ref={timingRef} className="play__timing" style={{ opacity: 0 }} />
      <div ref={countdownRef} className="play__countdown" style={{ opacity: 0 }} />
      <div ref={calibToastRef} className="play__calib" style={{ opacity: 0 }}>
        ⏱ timing synced
      </div>

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

      {phase === 'paused' && pauseView === 'menu' && (
        <div className="play__overlay play__overlay--pause">
          <div className="pause-card">
            <div className="pause-card__head rise" style={{ '--i': 0 } as CSSProperties}>
              <span className="pause-card__eyebrow">❚❚ Paused</span>
              {beatmap && <h2>{beatmap.title}</h2>}
              <span className="pause-card__meta">
                {difficulty} · {Math.round(beatmap?.bpm ?? 0)} BPM
              </span>
            </div>

            <div className="pause-actions rise" style={{ '--i': 1 } as CSSProperties}>
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => controlsRef.current?.resume()}
              >
                Resume
              </button>
              <div className="pause-actions__row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => controlsRef.current?.restart()}
                >
                  ↻ Restart
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => controlsRef.current?.quit()}
                >
                  Quit
                </button>
              </div>
            </div>

            {/* Settings, grouped and divided from the run actions: these change a
                setting rather than the run, and must not sit next to Quit where a
                mistap costs a whole song. */}
            <div className="pause-settings rise" style={{ '--i': 2 } as CSSProperties}>
              <HapticToggle className="pause-setting" />
              <SoundToggle className="pause-setting" />
              <button
                type="button"
                className="pause-setting"
                onClick={() => setPauseView('calibrate')}
              >
                <span>Calibrate timing</span>
                <span className="pause-setting__chev" aria-hidden>›</span>
              </button>
            </div>

            <p className="muted small pause-card__hint rise" style={{ '--i': 3 } as CSSProperties}>
              ESC or SPACE to resume
            </p>
          </div>
        </div>
      )}

      {/* Step two of the pause menu: the real calibration screen, with its own
          Back button (and Escape) returning to the menu. The run stays paused. */}
      {phase === 'paused' && pauseView === 'calibrate' && (
        <div className="play__overlay play__overlay--calibrate">
          <CalibrationScreen onDone={() => setPauseView('menu')} />
        </div>
      )}

      {phase === 'loading' && (
        <div className="play__overlay play__overlay--loading">
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
          <button type="button" className="play__back" onClick={onExit}>
            ‹ Back
          </button>
          {/* The ready screen shares the pause card's chrome — the same bordered
              panel, head (eyebrow/title/meta) and pill actions — so pausing feels
              like the same surface returning, not a different screen. */}
          <div className="pause-card ready-card">
            {/* The song's cover, ringed and haloed like the CD on the highway.
                The thumbnail is a rectangle in a circle, so a blurred copy fills
                behind it instead of leaving black corners. */}
            <div className="ready-cover pop">
              <div className="ready-cover__burst" aria-hidden />
              <div className="ready-cover__disc">
                <img
                  className="ready-cover__blur"
                  src={beatmap.thumbnailUrl ?? undefined}
                  alt=""
                  aria-hidden
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
                <img
                  className="ready-cover__art"
                  src={beatmap.thumbnailUrl ?? undefined}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </div>
            </div>

            <div className="pause-card__head rise" style={{ '--i': 0 } as CSSProperties}>
              <span className="pause-card__eyebrow">▶ Ready</span>
              <h2>{beatmap.title}</h2>
              <span className="pause-card__meta">
                {difficulty} · {Math.round(beatmap.bpm)} BPM
              </span>
            </div>

            {/* Modifiers take the settings section's place — the pre-run choices,
                divided from the head by the same hairline the pause menu uses. */}
            <div className="pause-settings rise" style={{ '--i': 1 } as CSSProperties}>
              <ModifierPanel
                mods={mods}
                onChange={(next) => {
                  setMods(next);
                  setStoredModifiers(next);
                }}
              />
              {/* Keyboard keys are desktop-only; on a phone you tap the lanes. */}
              <div className="keycaps only-desktop">
                {keys.map((key) => (
                  <kbd key={key}>{key.toUpperCase()}</kbd>
                ))}
              </div>
            </div>

            <div className="pause-actions rise" style={{ '--i': 2 } as CSSProperties}>
              <button
                type="button"
                className="btn btn--primary btn--block btn--start"
                onClick={() => controlsRef.current?.start()}
              >
                <span className="only-desktop">Press SPACE to start</span>
                <span className="only-mobile">Tap to start</span>
              </button>
            </div>

            <p
              className="muted small only-desktop pause-card__hint rise"
              style={{ '--i': 3 } as CSSProperties}
            >
              ESC to pause
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

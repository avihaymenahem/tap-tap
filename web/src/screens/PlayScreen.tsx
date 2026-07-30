import type { Beatmap, Chart, DifficultyName, Note } from '@tap-tap/shared';
import { DEFAULT_ACCENT, DIFFICULTIES, isHold, keymapFor, themeCatalog, themeFor } from '@tap-tap/shared';
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { getBeatmap, listCustomThemes } from '../data/index.js';
import { AudioClock, bandLevel } from '../game/clock.js';
import { comboMilestone, comboTier } from '../game/combo.js';
import { GameEngine, type GameSnapshot } from '../game/engine.js';
import {
  accuracyOf,
  capGrade,
  foldUnreached,
  gradeFor,
  hitWindowsFor,
  timingOf,
  type Tier,
} from '../game/judge.js';
import { playUiSound } from '../uisfx.js';
import { approachSecFor, getScrollSpeed } from '../scrollSpeed.js';
import { noteTicksEnabled } from '../noteTicks.js';
import { musicLevel, sfxLevel } from '../mixer.js';
import { normalizeScore } from '../game/score.js';
import { TICK_LOOKAHEAD_SEC, cursorAt, ticksInWindow } from '../game/tickSchedule.js';
import type { RunResult } from '../game/run.js';
import { cancelHaptics, vibrateHold, vibrateMiss, vibrateTap } from '../haptics.js';
import { useWakeLock } from '../hooks/useWakeLock.js';
import { Highway } from '../render/highway.js';
import { TIER_COLORS, TIER_LABELS, TIMING_COLORS, TIMING_LABELS } from '../render/palette.js';
import { adaptiveAllowed, qualityProfile, resolveQuality } from '../render/quality.js';
import { comboMeter, drawWaveDeck, easeBars, spectrumBars } from '../render/hudWave.js';
import { FlashToggle } from '../components/FlashToggle.js';
import { HapticToggle } from '../components/HapticToggle.js';
import { MixerToggle } from '../components/MixerToggle.js';
import { SoundToggle } from '../components/SoundToggle.js';
import { CalibrationScreen } from './CalibrationScreen.js';
import { accentVars } from '../accent.js';
import { getStoredCalibration, getStoredModifiers, setCalibration } from '../storage.js';
import { gradeCeiling, type Modifiers, mirrorNotes } from '../game/modifiers.js';
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
 * Cells in the HUD's health meter.
 *
 * Kept in TS as well as CSS because the fill width is *quantised* to it in the
 * render loop: a continuous fill under a segmented overlay terminates mid-cell
 * at most values, which reads as a bar with decorative notches rather than as a
 * discrete gauge. Five, not the eight it had, so each cell is ~14 CSS px and
 * countable at arm's length — and so it does not share a segment count with the
 * progress rail above it, which is a *continuous* meter for exactly that reason.
 * The `20%` step in `.hud__health::after` is the other half of this number.
 */
const HEALTH_CELLS = 5;

/** How long the verdict word stays at full opacity before it fades. */
const JUDGEMENT_HOLD_SEC = 0.26;

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

/**
 * 1048320 -> "1,048,320", for the HUD's hero readout.
 *
 * Grouped by hand rather than with `toLocaleString`: this runs on every frame of
 * the render loop, so it must not build an `Intl.NumberFormat`, and the score
 * needs one fixed grouping whatever the device locale is — a locale that groups
 * by four digits, or swaps in a decimal comma, would turn the hero number into
 * nonsense. Grouping only ever changes width when the digit *count* changes, so
 * it costs nothing in stability on top of the tabular figures.
 */
function groupDigits(value: number): string {
  const s = String(value);
  if (s.length <= 3) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
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
   * Per-run modifiers, chosen on the menu hero and persisted. Read through a ref
   * by the engine builder so `start` picks up the stored choice without the
   * input/render effect re-running.
   */
  // Read once at mount: the modifiers were chosen on the hero (the old ready
  // screen's job) and persisted, so this run just adopts them.
  const [mods] = useState<Modifiers>(getStoredModifiers);
  const modsRef = useRef<Modifiers>(mods);
  modsRef.current = mods;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scoreRef = useRef<HTMLSpanElement>(null);
  const comboRef = useRef<HTMLSpanElement>(null);
  /**
   * The combo plaque itself, not its digits: `data-tier` drives the plaque's
   * scale and glow, so it has to sit on the element that owns the underline and
   * the halo rather than on the number inside it.
   */
  const comboPodRef = useRef<HTMLDivElement>(null);
  /** Health bar fill; width + colour written from the render loop. */
  const healthRef = useRef<HTMLDivElement>(null);
  /**
   * The verdict word is TWO exactly-registered layers, and that is the fix for
   * its worst defect rather than a flourish.
   *
   * It used to be one element whose "rim" was eight offset copies in a
   * `text-shadow` stack. Offset copies cannot make an even outline: they
   * measured 6-9px on outer contours and **0px** on inner ones (the right side
   * of an S counter went white straight to background), they are not
   * antialiased, and where four of them meet you get a 90-degree notch cut out
   * of the rim. Adjacent glyphs' rims also fused into one mass.
   *
   * So: `judgeStrokeRef` carries the same word painted with `-webkit-text-stroke`
   * — one true, even, antialiased stroke — plus the tier bloom; `judgeFillRef`
   * carries the visible gradient core on top of it. Both are `grid-area: 1/1`
   * of the same box with identical type metrics, so registration is exact by
   * construction and there is no positional maths to drift.
   *
   * Two refs, one write each per judgement, still nowhere near React state.
   */
  /**
   * The verdict *stack* — the wrapper that owns the position. `--vs` is written
   * on it per judgement so the word steps away from the lane it reports on; the
   * inner element keeps the pop animation, which is why the two cannot be one
   * element (a transform on the animating node would be replaced by the pop).
   */
  const verdictRef = useRef<HTMLDivElement>(null);
  const judgementRef = useRef<HTMLDivElement>(null);
  const judgeStrokeRef = useRef<HTMLSpanElement>(null);
  const judgeFillRef = useRef<HTMLSpanElement>(null);
  /** EARLY/LATE tag under the tier word. `TIMING_COLORS`, never themed. */
  const timingRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  /*
   * The HUD waveform deck — the album disc and the mirrored spectrum running
   * left and right from it. All three are written from the render loop, never
   * from React state: this repaints every frame, and a 60fps re-render costs
   * more than the whole loop.
   */
  const waveRef = useRef<HTMLCanvasElement>(null);
  const multRef = useRef<HTMLSpanElement>(null);
  const arcRef = useRef<HTMLDivElement>(null);
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
  // Scroll speed is the player's, not the chart's (`scrollSpeed.ts`). Resolved
  // here rather than at each use below: `visibleNotes` is called from the render
  // loop, and this must not become a per-frame storage read. `getScrollSpeed`
  // caches, and the value cannot change while this screen is mounted — the
  // setting lives in the menu — so it stays stable for the effect deps too.
  const approachSec = approachSecFor(params.approachSec, getScrollSpeed());

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
      // The chart's own spacing when it has one — note spacing is beat-relative,
      // so a slow song's chart is spaced wider than `params.minGapSec` and may
      // fairly be judged on the wider window. Absent on charts generated before
      // that existed, where the nominal value *is* what they were built with.
      minGapSec: chart.minGapSec ?? params.minGapSec,
      // Slices per-section accuracy over the song rather than the last note, so a
      // chart that stops early shows empty final sections instead of stretching the
      // rest to fill the bar. Taken from the decoded buffer, which is the song's
      // real length.
      songDuration: clock.duration,
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
        // Level this track against the rest of the library before anything is
        // heard. Absent on songs ingested before loudness was measured, which
        // `setTrackGain` reads as unity.
        clock.setTrackGain(map.gainDb);

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
          approachSec,
          theme,
          beatGrid: map.beatGrid,
          // Gameplay: honor the resolved tier and let the renderer downgrade
          // live on a weak GPU (unless the player pinned a tier).
          quality: qualityProfile(resolveQuality()),
          adaptive: adaptiveAllowed(),
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
  }, [songId, difficulty, approachSec]);

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
    /**
     * Seconds the verdict is held at full opacity before it starts to fade.
     *
     * Without it the word begins fading on the very next frame, so at any
     * randomly-sampled instant it is typically at ~55% opacity — a white core
     * measured at relative luminance 0.46 instead of ~1.0, i.e. the most
     * time-critical readout on screen spends most of its life half faded. The
     * hold is short enough that consecutive notes still each get their own
     * punch (the pop animation replays regardless).
     */
    let judgementHold = 0;
    let lastFrame = performance.now();
    let outroStarted = false;
    // Combo from the previous frame, so the loop can spot a milestone crossing
    // or a break without the engine having to emit an event for it.
    let prevCombo = 0;
    let prevTier = 0;
    // Health meter state. Both are only written to the DOM on a change, since
    // this runs 120 times a second and health moves a handful of times a run.
    let prevHealthPct = '100%';
    let prevLevel = 'ok';
    /**
     * Last strings actually written to the HUD.
     *
     * Assigning `textContent` invalidates layout for that node whether or not
     * the text changed, and score/combo hold the same value for most frames
     * of a run. Comparing a string first is far cheaper than the layout the
     * write would otherwise schedule 120 times a second.
     */
    let prevScoreText = '';
    let prevComboText = '';
    /** '1' once a streak exists — see the reveal note at the write site. */
    let prevComboOn = '0';
    /**
     * Note-tick scheduling state (`game/tickSchedule.ts`).
     *
     * Read once per run rather than per frame, and re-read in `start`/`restart`,
     * so toggling the setting in the menu applies to the next run — the same
     * treatment the modifiers get.
     */
    let ticksOn = false;
    let tickCursor = 0;

    /** Replay a one-shot CSS animation by clearing the class and forcing reflow. */
    const restartAnim = (el: HTMLElement | null, cls: string): void => {
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth; // reflow so the re-added class counts as a fresh start
      el.classList.add(cls);
    };
    const spectrum = new Uint8Array(new ArrayBuffer(512));

    /*
     * The HUD waveform deck's per-frame state, hoisted out of the loop.
     *
     * `waveTarget` is this frame's folded spectrum and `waveBars` the eased
     * version actually drawn — a raw analyser frame is noisy enough that drawn
     * straight the deck strobes rather than flows. Both are allocated once: they
     * are touched every frame and a per-frame `Float32Array` is exactly the cost
     * that hides on a render path.
     *
     * The bar count comes from the resolved quality tier and is fixed for the
     * screen's life, the same way the `Highway` resolves its profile once at
     * construction — it sizes these buffers.
     */
    const waveProfile = qualityProfile(resolveQuality());
    const waveTarget = new Float32Array(waveProfile.hudWaveBars);
    const waveBars = new Float32Array(waveProfile.hudWaveBars);
    let waveCtx: CanvasRenderingContext2D | null = null;
    let waveW = 0;
    let waveH = 0;
    let prevMultText = '';
    let prevArcPct = '';
    const lastNoteAt = chartRef.current?.notes.at(-1)?.t ?? 0;
    const introOffset = introOffsetRef.current;

    /**
     * Judgement-time as of the last frame, and a monotonic cursor into the
     * chart. Both exist for `verdictSide` below, which needs to know what is
     * currently ON the runway and must not scan the whole chart to find out.
     */
    let verdictNow = 0;
    let verdictCursor = 0;

    /**
     * Which side of the board the verdict word is thrown to: +1 right, -1 left.
     *
     * The previous rule was "the opposite side from the lane being judged", and
     * it is not enough — measured on a capture, a lane-0 miss correctly went
     * right and landed directly under a lane-3 tile, where it read as a caption
     * belonging to that tile rather than as a verdict. The lane that was judged
     * is the one lane guaranteed to be EMPTY at the word's depth; the notes that
     * can collide are the ones still approaching.
     *
     * So the side is chosen against the runway itself: every note currently in
     * flight (the next `approachSec` of chart) is counted into a left or right
     * half, and the word goes to the emptier half — falling back to the old
     * away-from-the-judged-lane rule only when the two are tied. The scan is a
     * few dozen notes at most and runs once per judgement, not per frame.
     */
    const verdictSide = (lane: number): number => {
      const mid = params.laneCount / 2;
      const notes = chartRef.current?.notes;
      let left = 0;
      let right = 0;
      if (notes) {
        // The cursor only ever advances, so the whole run costs one pass.
        while (verdictCursor < notes.length && notes[verdictCursor]!.t < verdictNow) {
          verdictCursor++;
        }
        const until = verdictNow + approachSec;
        for (let i = verdictCursor; i < notes.length; i++) {
          const n = notes[i]!;
          if (n.t > until) break;
          if (n.lane < mid) left++;
          else right++;
        }
      }
      if (left !== right) return left < right ? -1 : 1;
      return lane < mid ? 1 : -1;
    };

    /**
     * The verdict for one note: the tier word, plus an EARLY/LATE tag when the
     * hit was off-centre.
     *
     * `delta` is absent for a miss — nothing was tapped, so there is no
     * direction to report. Both colour languages come from `palette.ts` and are
     * deliberately *not* themed: perfect/great/good/miss and early/late are the
     * one vocabulary the player learns once and relies on in every song.
     */
    const showJudgement = (tier: Tier, lane: number, delta?: number): void => {
      const el = judgementRef.current;
      const verdict = verdictRef.current;
      /*
       * Step the word sideways, clear of the highway, on the side away from the
       * lane it is reporting on.
       *
       * Centred it printed MISS straight across a note tile — measured on a
       * capture, and the one thing a judgement must never obscure is the board
       * it is judging. Half-measures do not fix it: mid-highway the word is
       * ~76 CSS px against a ~140px track, so *any* on-track position covers two
       * lanes and the only question is which two. The offset therefore clears
       * the rails entirely (CSS caps it so a wide window does not fling it to
       * the screen edge), which is the only placement that holds for every note
       * pattern rather than for the frame it was tuned on.
       *
       * `verdictSide` picks the emptier half of the runway rather than merely
       * the half away from the judged lane — see its own note. One `--vs` write
       * per judgement, on a ref'd element: nowhere near React state.
       */
      if (verdict) {
        verdict.style.setProperty('--vs', String(verdictSide(lane)));
      }
      if (el) {
        // The word goes to both layers of the stack (see the refs' note): the
        // stroke layer under it, the gradient core over it. Same string, same
        // metrics, same grid cell — so the outline registers exactly.
        const word = TIER_LABELS[tier];
        if (judgeStrokeRef.current) judgeStrokeRef.current.textContent = word;
        if (judgeFillRef.current) judgeFillRef.current.textContent = word;
        // The tier colour goes to a custom property, not to `color`. As a fill
        // it made the verdict the DIMMEST text in the frame — MISS (#ff2e88) is
        // luminance 0.165, under 2:1 against a note's bloom — so the word read
        // as a caption rather than as the one time-critical event on screen. CSS
        // spends `--verdict` on a true even stroke and on the bloom outside it,
        // over a gradient core, which keeps the tier identifiable while putting
        // the peak luminance near 1.0. `TIER_COLORS` is untouched and unthemed.
        el.style.setProperty('--verdict', TIER_COLORS[tier]);
      }
      const tag = timingRef.current;
      if (tag) {
        // `TIMING_LABELS.exact` is empty on purpose, so a dead-centre hit shows
        // the tier alone rather than a third word to read at speed.
        const timing = delta === undefined ? null : timingOf(delta);
        tag.textContent = timing ? TIMING_LABELS[timing] : '';
        if (timing) tag.style.color = TIMING_COLORS[timing];
      }
      // A quick pop on each new judgement, on top of the alpha decay below.
      restartAnim(el, 'play__judgement--pop');
      judgementAlpha = 1;
      judgementHold = JUDGEMENT_HOLD_SEC;
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
        // Fixed scale, not the raw total — see `RunResult.score`.
        score: normalizeScore(snap.score, snap.scoreMax),
        scoreMax: snap.scoreMax,
        timingHistogram: snap.timingHistogram,
        sections: snap.sections,
        accuracy,
        maxCombo: snap.maxCombo,
        // Capped by the run's conditions, so an assisted run cannot display or
        // store a grade it could not have earned at full difficulty. Applied here
        // rather than at render time so the *stored* best carries the capped
        // grade too — and so the S-rank achievement cannot be farmed on 0.75x.
        grade: capGrade(gradeFor(accuracy), gradeCeiling(modsRef.current)),
        counts,
        timingCounts: snap.timingCounts,
        meanDelta: snap.meanDelta,
        totalNotes: snap.totalNotes,
        failed: snap.failed,
        // Snapshotted here rather than read at results time: the player can
        // change modifiers between finishing and looking at the card, and a
        // personal best has to be judged on how the run was actually played.
        modifiers: modsRef.current,
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

    /*
     * DEV ONLY — the screenshot harness's way onto the results card.
     *
     * `scripts/shoot.mjs --state=results` otherwise cannot reach a finished run:
     * quitting posts a result but scores every unreached note as a miss, and
     * sitting through a whole song is minutes per capture. This plays the chart
     * out against the *real* engine instead — `engine.update`, `engine.hitLane`
     * and `engine.releaseLane`, then the ordinary `finish()` — so the card is
     * laid out by a genuine `RunResult`. Fabricating one would hide exactly the
     * states a critique loop is looking at: a flawless run shows no misses, no
     * advice line and no failure banner.
     *
     * `import.meta.env.DEV` is a static literal to Vite, so the whole block is
     * dead-code-eliminated from a production bundle and `window.__tapTapDebug`
     * cannot exist in the shipped APK.
     */
    if (import.meta.env.DEV) {
      const debugWindow = window as Window & { __tapTapDebug?: { jumpToEnd: () => void } };
      const jumpToEnd = (): void => {
        const engine = engineRef.current;
        const chart = chartRef.current;
        if (!engine || !chart || phaseRef.current === 'loading') return;

        const w = hitWindowsFor(chart.minGapSec ?? params.minGapSec);
        /*
         * A deterministic 20-note cycle: mostly perfect, a scattering of great
         * and good, and two notes dropped entirely. Errors are written as
         * fractions of the chart's own windows rather than as literal
         * milliseconds — `hitWindowsFor` scales them per difficulty, and a
         * literal would silently land in a different tier on Extreme (the same
         * trap the tier tests already document). `null` means "no tap", which
         * `update` retires as a real miss.
         */
        const PATTERN: readonly (number | null)[] = [
          w.perfect * 0.3, w.perfect * -0.5, w.great * 0.7, w.perfect * 0.15,
          w.perfect * -0.2, w.great * -0.8, w.perfect * 0.4, null,
          w.perfect * 0.25, w.good * 0.85, w.perfect * -0.35, w.great * 0.6,
          w.perfect * 0.1, w.perfect * 0.5, null, w.great * 0.75,
          w.perfect * -0.15, w.good * -0.9, w.perfect * 0.2, w.perfect * 0.45,
        ];

        const notes = chart.notes;
        for (let i = 0; i < notes.length; i++) {
          const n = notes[i]!;
          // `hitLane`/`update` take RAW clock time and subtract the calibration
          // themselves, so every time fed in here has to add it back.
          const cal = engine.calibration;
          engine.update(n.t + cal);
          const err = PATTERN[i % PATTERN.length];
          if (err === null || err === undefined) continue;
          /*
           * Ask the engine which note is live at this instant instead of
           * trusting the chart's lane: `makeEngine` rebuilds the played notes
           * under the run's modifiers (mirror flips lanes, holds-off demotes
           * sustains), so the chart's own copy can disagree with it.
           */
          const state = engine
            .visibleNotes(n.t, 0.001)
            .find((s) => Math.abs(s.note.t - n.t) < 1e-6 && s.tier === null);
          if (!state) continue;
          const lane = state.note.lane;
          const hit = engine.hitLane(lane, n.t + err + cal);
          // Carry a hold to its tail rather than dropping it the frame after the
          // head, which would score every sustain as a broken hold.
          if (hit?.startedHold) {
            engine.releaseLane(lane, n.t + (state.note.duration ?? 0) + cal);
          }
        }
        // Sweep past the last note's miss window so nothing is left unjudged and
        // the snapshot reads `finished`.
        engine.update((notes.at(-1)?.t ?? 0) + 5 + engine.calibration);
        finish();
      };
      debugWindow.__tapTapDebug = { jumpToEnd };
    }

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
      // What `verdictSide` reads to know what is on the runway. A single number
      // per frame — the alternative is passing the time through every judgement
      // call site, which is more plumbing for the same value.
      verdictNow = shownTime;

      // Hand the next few notes to the audio clock, sample-accurately.
      //
      // Against **raw** song time, not `shownTime`: the tick has to coincide with
      // the music at the note's own time, and `contextTimeFor` maps song time onto
      // the same timeline the buffer is playing on. Using the calibration-shifted
      // time would drag every tick off the beat by the player's own output latency
      // — which is the exact defect prescheduling exists to avoid.
      if (ticksOn && clock.isPlaying) {
        const window = ticksInWindow(
          chartRef.current?.notes ?? [],
          tickCursor,
          songTime,
          songTime + TICK_LOOKAHEAD_SEC,
        );
        tickCursor = window.cursor;
        for (const t of window.times) clock.playTickAt(clock.contextTimeFor(t));
      }

      for (const missed of engine.update(songTime)) {
        highway.burst(missed.note.lane, 'miss');
        showJudgement('miss', missed.note.lane);
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
        engine.visibleNotes(shownTime, approachSec),
        dt,
        bass,
        treble,
        spectrum,
      );
      paintCountdown(now / 1000);

      /*
       * The HUD waveform deck. Driven by the SAME `spectrum` array the highway
       * reads — the analyser sits after loudness normalisation and before
       * `musicVol` on purpose (see the audio-graph section of CLAUDE.md), so this
       * reflects what the track actually sounds like and does not go flat when a
       * player turns the music down. Never a timer, never a frame counter.
       *
       * Nothing here pulses on the beat, so nothing here needs `beatPulse` or the
       * `MAX_FLASH_HZ` stride: it is a continuous spectrum reading, which cannot
       * produce the periodic full-area flash that rule exists to bound. The
       * `easeBars` smoothing pushes it further from that shape rather than nearer.
       */
      const waveCanvas = waveRef.current;
      if (waveCanvas) {
        const cssW = waveCanvas.clientWidth;
        const cssH = waveCanvas.clientHeight;
        if (cssW > 0 && cssH > 0) {
          if (!waveCtx || cssW !== waveW || cssH !== waveH) {
            // Capped by the tier's pixel-ratio ceiling, like the highway's own
            // drawing buffer — a 3x panel would otherwise push nine times the
            // pixels through a per-bar shadow blur.
            const ratio = Math.min(window.devicePixelRatio || 1, waveProfile.pixelRatioCap);
            waveCanvas.width = Math.max(1, Math.round(cssW * ratio));
            waveCanvas.height = Math.max(1, Math.round(cssH * ratio));
            waveCtx = waveCanvas.getContext('2d');
            waveCtx?.setTransform(ratio, 0, 0, ratio, 0, 0);
            waveW = cssW;
            waveH = cssH;
          }
          if (waveCtx) {
            spectrumBars(spectrum, waveTarget);
            easeBars(waveBars, waveTarget);
            const a = accentRef.current;
            /*
             * 0.85, up from 0.62, for the reason on the `fade` factor inside
             * `drawWaveDeck`: at the old combined strength the deck read as a
             * desaturated olive rather than as the song's accent, which put a
             * fourth hue in a frame whose whole idea is one. It is still held
             * under 1 so the deck stays quieter than the notes. Applied here
             * rather than inside `drawWaveDeck` because that module is the
             * renderer's and is shared with other call sites.
             */
            waveCtx.save();
            waveCtx.globalAlpha = 0.85;
            drawWaveDeck(waveCtx, waveBars, cssW, cssH, {
              rgb: `${(a >> 16) & 0xff}, ${(a >> 8) & 0xff}, ${a & 0xff}`,
              // Disc radius (62) + its 6px ring + a small gap, matching
              // `.hud__disc`. Re-spaced off the LARGER disc: at the old 40 the
              // bars started well inside the new ring and the deck read as a
              // slash crossing the disc rather than as a spectrum radiating
              // from it. Still capped as a fraction of the frame so a narrow
              // viewport cannot leave zero span for the bars.
              // Disc radius (46) + its ring + a small gap; see `.hud__disc`,
              // which shrank in the trim pass.
              holeRadius: Math.min(cssW * 0.3, 60),
              glow: waveProfile.hudWaveGlow,
            });
            waveCtx.restore();
          }
        }
      }

      // HUD is written straight to the DOM — re-rendering React at 60fps would
      // cost more than the entire render loop.
      const snap = engine.snapshot;
      if (scoreRef.current) {
        const text = groupDigits(normalizeScore(snap.score, snap.scoreMax));
        if (text !== prevScoreText) {
          scoreRef.current.textContent = text;
          prevScoreText = text;
        }
      }
      if (comboRef.current) {
        const combo = snap.combo;
        const text = String(combo);
        if (text !== prevComboText) {
          comboRef.current.textContent = text;
          prevComboText = text;
        }
        // Tier drives the plaque's scale, glow and underline; only touch the DOM
        // when it actually changes, since this runs every frame.
        const tier = comboTier(combo);
        if (tier !== prevTier) {
          if (comboPodRef.current) comboPodRef.current.dataset.tier = String(tier);
          prevTier = tier;
        }
        // Revealed only once a streak exists. A "0"/"1" under the score pill is
        // chrome with no information in it, and the corner reads cleaner without
        // it; the reference carries no combo field on screen at all. One write
        // per transition, never per frame.
        const on = combo >= 2 ? '1' : '0';
        if (on !== prevComboOn) {
          if (comboPodRef.current) comboPodRef.current.dataset.on = on;
          prevComboOn = on;
        }
        /*
         * The disc's `x N` band and the amber arc under it. Same ladder the
         * plaque's tier uses (see `comboMeter`) so the two cannot disagree about
         * one streak, and both written only when the string changes — this is a
         * per-frame path.
         *
         * The arc is quantised to whole percent, which is what makes that guard
         * bite: at 60fps an unquantised fraction differs every frame and the
         * write is unconditional in practice.
         */
        const meter = comboMeter(combo);
        const multText = `x${meter.multiplier}`;
        if (multText !== prevMultText) {
          if (multRef.current) multRef.current.textContent = multText;
          prevMultText = multText;
        }
        const arcPct = `${Math.round(meter.progress * 100)}%`;
        if (arcPct !== prevArcPct) {
          if (arcRef.current) arcRef.current.style.setProperty('--arc', arcPct);
          prevArcPct = arcPct;
        }
      }
      if (healthRef.current) {
        // A horizontal meter now, in the top plate — the old vertical bar hung
        // off the left screen edge, clipped and unlabelled, reading as a second
        // progress bar rather than as health.
        //
        // Quantised to the meter's cell count so the fill always terminates on a
        // cell wall: a continuous fill under a segmented overlay ends mid-cell at
        // most values, which defeats the whole point of segmenting it. `ceil`, so
        // any health at all lights a cell and only a dead run shows none.
        const cells = Math.ceil(Math.max(0, Math.min(1, snap.health)) * HEALTH_CELLS);
        const pct = `${(cells / HEALTH_CELLS) * 100}%`;
        if (pct !== prevHealthPct) {
          healthRef.current.style.width = pct;
          prevHealthPct = pct;
        }
        // Colour is a second channel, not a constant alarm: green / amber / red.
        // `low` additionally rings and pulses the whole row (see the `:has()`
        // rule), because at 1 cell left there is almost no fill to colour and 4
        // CSS px of red cannot carry the state that ends a run.
        const level = snap.health > 0.5 ? 'ok' : snap.health > 0.25 ? 'warn' : 'low';
        if (level !== prevLevel) {
          healthRef.current.dataset.level = level;
          prevLevel = level;
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

      // Hold at full, then fade. See `judgementHold`.
      if (judgementHold > 0) judgementHold = Math.max(0, judgementHold - dt);
      else judgementAlpha = Math.max(0, judgementAlpha - dt * 3.4);
      if (judgementRef.current) judgementRef.current.style.opacity = String(judgementAlpha);
      // The tag trails the tier word slightly, so the word is what the eye
      // catches and the direction is the detail underneath it.
      if (timingRef.current) timingRef.current.style.opacity = String(judgementAlpha * 0.85);

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
      // Both the cache AND the attribute: a restart from a live streak would
      // otherwise leave the corner showing a combo the new run has not earned.
      prevComboOn = '0';
      if (comboPodRef.current) comboPodRef.current.dataset.on = '0';
      verdictCursor = 0;
      // Re-read the setting and anchor the cursor at where playback actually
      // begins — the intro skip means that is rarely zero.
      ticksOn = noteTicksEnabled();
      tickCursor = cursorAt(chartRef.current!.notes, introOffset);
      clock.setTicksAudible(ticksOn);
      clock.setMixer(musicLevel(), sfxLevel());
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
      // `pause` stops the music source but leaves the context running, so ticks
      // already committed to the graph would click on into a silent, paused game.
      clock.setTicksAudible(false);
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
      // Re-anchor the cursor: the ticks pending across the pause were scheduled
      // against context times that no longer line up with the song once the source
      // restarts, and they have already elapsed silently.
      tickCursor = cursorAt(chartRef.current?.notes ?? [], clock.currentTime);
      clock.setTicksAudible(ticksOn);
      // Re-read the levels: the pause overlay is where they are most likely to
      // have just been changed.
      clock.setMixer(musicLevel(), sfxLevel());
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
      // Both the cache AND the attribute: a restart from a live streak would
      // otherwise leave the corner showing a combo the new run has not earned.
      prevComboOn = '0';
      if (comboPodRef.current) comboPodRef.current.dataset.on = '0';
      verdictCursor = 0;
      ticksOn = noteTicksEnabled();
      tickCursor = cursorAt(chartRef.current!.notes, introOffset);
      clock.setTicksAudible(ticksOn);
      clock.setMixer(musicLevel(), sfxLevel());
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
        showJudgement(result.tier, lane, result.delta);
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
      if (import.meta.env.DEV) {
        delete (window as Window & { __tapTapDebug?: unknown }).__tapTapDebug;
      }
      // Never leave the device buzzing after the screen is gone.
      cancelHaptics();
    };
  }, [engineReady, params.laneCount, approachSec]);

  // Auto-start once the engine is ready AND the audio is actually running — so
  // the menu's PLAY tap drops straight into the run with no second "tap to
  // start". `onceRunning` fires immediately if the primed context is already
  // live, or when its async resume lands a beat later (the race that left the
  // ready screen sitting there). If nothing ever unlocks it (a replay/deep link
  // with no gesture), it never fires and the slim ready overlay waits for a tap.
  // Runs after the effect above, so `controlsRef.current` is already set.
  useEffect(() => {
    if (!engineReady) return;
    const clock = clockRef.current;
    if (!clock) return;
    return clock.onceRunning(() => controlsRef.current?.start());
  }, [engineReady]);

  const keys = keymapFor(params.laneCount);

  return (
    <div
      className="play"
      data-phase={phase}
      data-engine-ready={String(engineReady)}
      style={accentVars(themeAccent)}
    >
      <canvas ref={canvasRef} className="play__canvas" />

      {/* --- HUD ------------------------------------------------------------
          ONE top plate, not four corner chips. The chips used to bracket the
          playfield at its four corners — two of them at 19% height, right over
          the far end of the highway — which crowded the board and gave four
          readouts of very different importance the same weight.

          Hierarchy: SCORE is hero one and COMBO hero two, stacked in the same
          column of a 3-column grid whose side columns are equal `1fr`, so both
          numerals sit on the frame's centre axis at every digit count — the
          previous hand-balanced flex row left their optical centres 22 CSS px
          apart and slid the combo sideways as it gained digits.

          The two heroes are **one metal in two lights**: identical hue and
          saturation, the score's body ~22% brighter than the combo's, which is
          the only difference the eye can measure across a whole glyph. The
          previous pass tried to give the combo the luminance channel and the
          score the size channel; measured on the glyph *body* that came out as a
          4% difference (invisible) with the combo 30% *less* saturated, so they
          read as two different materials with the emphasis on the wrong one. The
          combo now wins on its own channels instead: the accent halo the score
          never gets, plus tier scale and a lengthening underline.

          Accuracy is a hairline peripheral in the right column with the chart
          tag as its secondary line — one tight top-anchored group, not two items
          pinned to the ends of a stretched column. The plate itself is a soft
          top-down scrim rather than a panel — legibility over an uncontrollable
          background, the way Guitar Hero Live scrimmed its highway — and it has
          no bottom edge of any kind.

          Every value is written from the render loop through a ref. React must
          never re-render during a run: that costs more than the whole loop. */}
      <div className="hud">
        {/* Song progress — a thin quiet line, and nothing more.
            It used to be a 9px grooved capsule with a rim, a lit lower lip,
            three quarter notches and a hard gold playhead terminator: five
            decorative registers spent on the one number in the frame nobody acts
            on. The reference ships no progress element at all; the trim pass
            keeps the information and drops the furniture, so this is now a 3px
            bed with a flat accent fill. It is inset from the top rather than
            flush at y=0 — that row is exactly what a status bar or a centred
            punch-hole occludes. */}
        <div className="hud__rail">
          <div ref={progressRef} className="hud__rail-fill" />
        </div>

        <div className="hud__deck">
          {/* 46px, over the platform touch minimum, and a plated disc rather
              than the 34px hairline ring it was. The glyph is drawn from two
              rounded pseudo-elements so it matches the tiles' corner language —
              the typed ❚❚ was the only square-cornered shape on screen.
              Every dimension on it is now an integer number of *device* pixels at
              DPR 3 and the two bars are placed symmetrically from opposite edges:
              at 4.5px wide off `calc(50% ± n)` they rounded to 15 and 12 device
              px, a visible 25% mismatch on the frame's only control. It is also
              deliberately dim — as the brightest ink in the frame it was failing
              the readability gate that reserves that for the receptor row.
              It lives in the right-hand corner group below. */}
          {/* The corner group. Score is ONE numeral in a dark pill with no
              caption, tucked into the top-left — the reference's exact
              composition, and the fix for a four-line SCORE/0/COMBO/0 stack
              that sat on the frame's centre axis directly above the vanishing
              point and read as a debug readout. Nothing belongs on that axis:
              it is the one column every note travels.

              Combo keeps its place in the hierarchy (it is the core feedback
              loop) but loses the axis and the caption: a bare accent numeral
              under the pill, revealed only once a streak exists. `data-on` is
              written from the loop alongside `data-tier`, so at 0 and 1 the
              corner carries the score alone. */}
          <div className="hud__corner">
            {/* `hud-chip` is kept on the pill: it is still a plate readout, and
                `scripts/shoot.mjs` uses that class as its "the run is playing"
                probe. */}
            <div className="hud-chip hud__pill">
              <span ref={scoreRef} className="hud__score-value">0</span>
            </div>
            <div ref={comboPodRef} className="hud-chip--combo" data-tier="0" data-on="0">
              <span ref={comboRef} className="hud__combo-value">0</span>
            </div>
          </div>

          {/* The opposite corner: pause, and health only when a run can fail.
              ACC and the difficulty tag were removed from the play screen in the
              trim pass: accuracy is a lagging aggregate nobody acts on mid-run
              (it is on the pause card and on the results card, where it is read),
              and the difficulty was chosen on the screen immediately before this
              one. */}
          <div className="hud__aside">
            <button
              type="button"
              className="hud__pause"
              aria-label="Pause"
              onClick={() => controlsRef.current?.pause()}
            />
            {/* Health, ONLY when the run can actually fail.
                With `fail` off — the default — health has no consequence
                whatsoever: it drains on the first few misses of any imperfect run
                and then sits at empty for the rest of the song while nothing
                happens. A meter that is guaranteed to read "one hit from death"
                and then "dead" in a run that carries on regardless is worse than
                no meter: it is the shipped screenshot saying the opposite of
                SCORE/COMBO/ACC, and it costs HUD ink for no information. With
                `fail` on it is the most consequential number on the plate, so it
                gets the size, the graded colour and the alarm ring.
                Segmented on purpose: the cells are a second, shape-based channel
                so it cannot be mistaken for the progress rail above it, and the
                fill width is *quantised* to them in the loop so a cell is lit or
                unlit and never half. `data-level` (ok/warn/low) is the colour
                channel and drives the alarm state on the whole row. */}
            {mods.fail ? (
              <div className="hud__health-row">
                <span className="hud-chip__label hud__health-label">HP</span>
                <div className="hud__health" aria-hidden>
                  <div
                    ref={healthRef}
                    className="hud__health-fill"
                    data-level="ok"
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* --- The waveform deck ------------------------------------------
            The owner's third rejection clause was "there is no waveforms
            around", and the reference answers it in TWO places. The vertical
            bars flanking the board are the highway's (`buildSpectrumWings`);
            this is the other one — an album disc centred above the playfield
            with a mirrored horizontal spectrum running left and right from it.

            It is a separate row under the deck, in the band of the frame that
            was empty black on both flanks and only the vanishing point in the
            middle. The trim pass moved the plate's readouts into the two top
            corners, which is what let this row shrink and lift clear of the
            runway rather than standing on it.

            It is NOT the retired 3D album ring — see the note at the top of
            `hudWave.ts`. That was 96 instanced spectrum spikes standing in world
            space at the horizon; this is one 2D canvas at the top of the screen.

            `pointer-events: none` on the whole row (in the CSS): it sits over
            the canvas, and a dead zone at the top of the playfield would eat
            taps aimed at the far end of a lane. */}
        <div className="hud__wavedeck" aria-hidden>
          <canvas ref={waveRef} className="hud__wave" />
          <div className="hud__disc">
            {beatmap?.thumbnailUrl ? (
              <img className="hud__disc-art" src={beatmap.thumbnailUrl} alt="" />
            ) : null}
            {/* The amber progress arc toward the next multiplier step, and the
                band carrying the multiplier itself.

                AMBER, not the accent, and deliberately so: it is a reward
                indicator, and reward indicators in this app are outside the
                accent system exactly as `TIER_COLORS` and `--gold` already are.
                It cannot be `--amber` either — `accentVars` overrides that to a
                shade of the song's accent, which is the whole thing this must
                not be. Hence the literal. */}
            <div className="hud__disc-band" />
            <div ref={arcRef} className="hud__disc-arc" style={{ '--arc': '0%' } as CSSProperties} />
            <span ref={multRef} className="hud__disc-mult">x1</span>
          </div>
        </div>
      </div>

      {/* Red edge flash on a broken combo. Sits above the canvas, below both
          the HUD plate and the verdict stack (see the z-index note in the CSS —
          this used to paint *over* the judgement it was reacting to). The
          animation class is toggled from the render loop. */}
      <div ref={vignetteRef} className="play__vignette" aria-hidden />

      <div ref={milestoneRef} className="play__milestone" aria-hidden />

      {/* The verdict for the last note: mid-highway (~33% down) and thrown into
          the gutter on whichever half of the runway currently carries fewer
          notes — see `verdictSide`. Neither half of that is optional. Centred it
          printed MISS across a tile; thrown merely away from the judged lane it
          landed under a *different* lane's tile and read as that tile's caption,
          which is what the second review caught. */}
      <div ref={verdictRef} className="play__verdict">
        <div ref={judgementRef} className="play__judgement" style={{ opacity: 0 }}>
          <span ref={judgeStrokeRef} className="play__judgement-stroke" aria-hidden />
          <span ref={judgeFillRef} className="play__judgement-fill" />
        </div>
        <div ref={timingRef} className="play__timing" style={{ opacity: 0 }} />
      </div>

      <div ref={countdownRef} className="play__countdown" style={{ opacity: 0 }} />
      <div ref={calibToastRef} className="play__calib" style={{ opacity: 0 }}>
        ⏱ timing synced
      </div>

      {phase === 'paused' && pauseView === 'menu' && (
        <div className="play__overlay play__overlay--pause">
          <div className="pause-card">
            <div className="pause-card__head rise" style={{ '--i': 0 } as CSSProperties}>
              <span className="pause-card__eyebrow">❚❚ Paused</span>
              {beatmap && <h2>{beatmap.title}</h2>}
              <span className="pause-card__meta">
                {difficulty} · {Math.round(beatmap?.bpm ?? 0)} BPM
              </span>
              {/* Accuracy lives HERE and on the results card, not on the play
                  screen: it is a lagging aggregate, so it is read when the player
                  has stopped to look rather than glanced at mid-stream. Safe to
                  compute in render because this markup only exists while paused —
                  the run is frozen, so there is no 60fps re-render to provoke. */}
              <span className="pause-card__stats">
                {Math.round((engineRef.current?.snapshot.accuracy ?? 0) * 100)}% accuracy ·{' '}
                {engineRef.current?.snapshot.maxCombo ?? 0} best combo
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
              <HapticToggle className="setting-row" />
              <SoundToggle className="setting-row" />
              <MixerToggle kind="music" className="setting-row" />
              <MixerToggle kind="sfx" className="setting-row" />
              {/* Reachable mid-run on purpose: flashing is something a player
                  discovers is a problem during a song, and if turning it off
                  costs them the run they stop playing instead. */}
              <FlashToggle className="setting-row" />
              <button
                type="button"
                className="setting-row"
                onClick={() => setPauseView('calibrate')}
              >
                <span>Calibrate timing</span>
                <span className="setting-row__chev" aria-hidden>›</span>
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

      {/* The ready overlay is now only a fallback: the run auto-starts when the
          menu's PLAY tap unlocked the audio. It shows only when it did not
          (a replay or deep link, where there was no such gesture) — a slim
          "tap to start" over the already-rendered scene, not a second song
          screen. Difficulty and modifiers were chosen on the hero. */}
      {phase === 'ready' && beatmap && (
        <div className="play__overlay play__overlay--ready play__overlay--ready-min">
          <button type="button" className="play__back" onClick={onExit}>
            ‹ Back
          </button>
          <div className="ready-min rise">
            <span className="pause-card__eyebrow">▶ Ready</span>
            <h2 className="ready-min__title">{beatmap.title}</h2>
            <span className="pause-card__meta">
              {difficulty} · {Math.round(beatmap.bpm)} BPM
            </span>
            <div className="keycaps only-desktop">
              {keys.map((key) => (
                <kbd key={key}>{key.toUpperCase()}</kbd>
              ))}
            </div>
            <button
              type="button"
              className="btn btn--primary btn--block btn--start"
              onClick={() => controlsRef.current?.start()}
            >
              <span className="only-desktop">Press SPACE to start</span>
              <span className="only-mobile">Tap to start</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

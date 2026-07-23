import type { Beatmap, Chart, DifficultyName, Note } from '@tap-tap/shared';
import { DIFFICULTIES, isHold, keymapFor, themeCatalog, themeFor } from '@tap-tap/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
import { accentVars } from '../accent.js';
import { getBeatmap, listCustomThemes } from '../data/index.js';
import { AudioClock, bandLevel } from '../game/clock.js';
import { GameEngine, type GameSnapshot } from '../game/engine.js';
import { accuracyOf, foldUnreached, gradeFor, type Tier, type Timing } from '../game/judge.js';
import { resolveCalibration } from '../game/calibration.js';
import type { RunResult } from '../game/run.js';
import { decideWinner, tugRatio, type VersusOutcome } from '../game/versus.js';
import { Highway } from '../render/highway.js';
import { TIER_COLORS, TIER_LABELS, TIMING_COLORS, TIMING_LABELS } from '../render/palette.js';
import { getStoredCalibration } from '../storage.js';
import { playUiSound } from '../uisfx.js';
import { useWakeLock } from '../hooks/useWakeLock.js';

/**
 * Local two-player Versus on one phone (PLAN: tap-tap-versus-2player).
 *
 * The phone lies flat between two players; the screen splits into two stacked
 * highways and the **top** one is rotated 180° so it reads upright for the
 * player on the far short end. Both play the *same chart at the same instant*
 * off **one shared `AudioClock`** — invariant 1.5 holds, there is exactly one
 * audio clock driving all timing. Everything else is doubled: two pure
 * `GameEngine`s and two `Highway`s, each independent.
 *
 * This is deliberately a slimmer sibling of `PlayScreen`: no modifiers, no live
 * auto-calibration (two players' mixed hits would poison the one shared stored
 * value — we *read* it and apply it to both, we never write it here) and no
 * haptics (a shared phone buzzing cannot say whose hit it was). The whole match
 * lifecycle lives in this one screen — ready → play → a mirrored results
 * overlay — so Versus needs only a single new route and no results storage.
 */

const LEAD_IN_SEC = 3;
const RESUME_COUNTDOWN_SEC = 3;
const OUTRO_SEC = 2;

// Intro-skip + early-hold demotion, mirrored from PlayScreen so a beatless
// opening or a hold sitting on the line at t=0 is not unplayable. Kept compact
// and local: this is stable, pure, and Versus should not reach into the play
// screen's internals. See PlayScreen for the fuller reasoning.
const INTRO_SKIP_THRESHOLD_SEC = 8;
const INTRO_SKIP_LEAD_SEC = 3;
const HOLD_START_LEAD_SEC = 1.5;
const SUSTAINED_WINDOW_SEC = 8;
const SUSTAINED_MIN_NOTES = 4;

/** Player accents: cyan below, pink above — so each side owns a colour. The
 *  highways stay on the song's own theme (fair — identical lanes for both). */
const P1_ACCENT = 0x37d0ff;
const P2_ACCENT = 0xff5db1;

/**
 * Player 2's keyboard map, for desktop dev only (on a phone you tap the lanes).
 * Player 1 uses the standard left-hand `keymapFor`; Player 2 gets a disjoint
 * right-hand set so both sides are drivable from one keyboard.
 */
const P2_KEYMAPS: Record<number, readonly string[]> = {
  3: ['j', 'k', 'l'],
  4: ['h', 'j', 'k', 'l'],
  5: ['h', 'j', 'k', 'l', ';'],
};

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

/** Prepare the played chart: drop the skipped intro, demote ungrabbable holds. */
function prepareChart(chart: Chart): { played: Chart; offset: number } {
  const offset = startOffsetFor(chart.notes);
  const kept = offset > 0 ? chart.notes.filter((n) => n.t >= offset) : chart.notes;
  const played: Chart = {
    ...chart,
    notes: kept.map((n) =>
      isHold(n) && n.t - offset < HOLD_START_LEAD_SEC
        ? { ...n, type: 'tap' as const, duration: undefined }
        : n,
    ),
  };
  return { played, offset };
}

type Phase = 'loading' | 'ready' | 'playing' | 'paused' | 'finished' | 'error';

/** The 0-based player index. 0 = bottom (P1), 1 = top (P2, rotated). */
type PlayerIndex = 0 | 1;

interface SideRuntime {
  engine: GameEngine;
  highway: Highway;
  canvas: HTMLCanvasElement;
  /** Which lane each finger grabbed on this side, by pointerId. */
  laneByPointer: Map<number, number>;
  judgementAlpha: number;
  prevCombo: number;
}

interface MatchResult {
  p1: RunResult;
  p2: RunResult;
  outcome: VersusOutcome;
}

interface VersusPlayScreenProps {
  songId: string;
  difficulty: DifficultyName;
  onExit: () => void;
}

/** Bundle of the DOM refs one side writes to from the render loop. */
function useSideRefs(): {
  canvas: React.RefObject<HTMLCanvasElement | null>;
  score: React.RefObject<HTMLDivElement | null>;
  combo: React.RefObject<HTMLDivElement | null>;
  acc: React.RefObject<HTMLDivElement | null>;
  judgement: React.RefObject<HTMLDivElement | null>;
  timing: React.RefObject<HTMLDivElement | null>;
  countdown: React.RefObject<HTMLDivElement | null>;
} {
  return {
    canvas: useRef<HTMLCanvasElement>(null),
    score: useRef<HTMLDivElement>(null),
    combo: useRef<HTMLDivElement>(null),
    acc: useRef<HTMLDivElement>(null),
    judgement: useRef<HTMLDivElement>(null),
    timing: useRef<HTMLDivElement>(null),
    countdown: useRef<HTMLDivElement>(null),
  };
}

export function VersusPlayScreen({
  songId,
  difficulty,
  onExit,
}: VersusPlayScreenProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [beatmap, setBeatmap] = useState<Beatmap | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [match, setMatch] = useState<MatchResult | null>(null);

  const p1Refs = useSideRefs();
  const p2Refs = useSideRefs();
  const tugRef = useRef<HTMLDivElement>(null);

  const clockRef = useRef<AudioClock | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const introOffsetRef = useRef(0);
  /** Index 0 = bottom (P1), index 1 = top (P2). */
  const sidesRef = useRef<SideRuntime[]>([]);
  const rafRef = useRef<number | null>(null);
  const finishTimerRef = useRef<number | null>(null);

  const phaseRef = useRef<Phase>('loading');
  const applyPhase = (next: Phase): void => {
    phaseRef.current = next;
    setPhase(next);
  };

  interface Controls {
    start: () => void;
    pause: () => void;
    resume: () => void;
    rematch: () => void;
  }
  const controlsRef = useRef<Controls | null>(null);

  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const params = DIFFICULTIES[difficulty];

  useWakeLock(true);

  // Build a fresh pair of engines from the prepared chart. Same options for
  // both — one device, one calibration; fail is off (both play to the end and
  // scores are compared).
  const makeEngine = (chart: Chart, clock: AudioClock): GameEngine =>
    new GameEngine(chart, {
      calibrationSec: resolveCalibration(getStoredCalibration(), clock.outputLatency),
      minGapSec: params.minGapSec,
      canFail: false,
    });

  // External-system setup: one clock, two highways, two engines.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function setup(): Promise<void> {
      try {
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

        const canvases = [p1Refs.canvas.current, p2Refs.canvas.current];
        if (!canvases[0] || !canvases[1]) throw new Error('Canvas unavailable');

        const { played, offset } = prepareChart(chart);
        const theme = themeFor(themeCatalog(customThemes), map.themeId);

        clockRef.current = clock;
        chartRef.current = played;
        introOffsetRef.current = offset;
        sidesRef.current = canvases.map((canvas): SideRuntime => {
          const highway = new Highway({
            canvas: canvas!,
            laneCount: chart.laneCount,
            approachSec: params.approachSec,
            theme,
            beatGrid: map.beatGrid,
            // No per-highway cover disc in Versus: two of them, back to back at
            // the divider, crowd out the highways. A single shared disc is drawn
            // in the centre instead (`.vs-cover`), so each track's vanishing
            // point stays clear and both players get more runway.
          });
          highway.resize(canvas!.clientWidth, canvas!.clientHeight);
          return {
            engine: makeEngine(played, clock),
            highway,
            canvas: canvas!,
            laneByPointer: new Map(),
            judgementAlpha: 0,
            prevCombo: 0,
          };
        });

        setBeatmap(map);
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
      if (finishTimerRef.current !== null) window.clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
      for (const side of sidesRef.current) side.highway.dispose();
      sidesRef.current = [];
      void clockRef.current?.dispose();
      clockRef.current = null;
      setEngineReady(false);
      phaseRef.current = 'loading';
    };
  }, [songId, difficulty, params.approachSec]);

  // Keep both drawing buffers matched to their (half-height) panes.
  useEffect(() => {
    if (!engineReady) return;
    const resize = (): void => {
      for (const side of sidesRef.current) {
        const { clientWidth, clientHeight } = side.canvas;
        if (clientWidth > 0 && clientHeight > 0) side.highway.resize(clientWidth, clientHeight);
      }
    };
    const observer = new ResizeObserver(resize);
    for (const side of sidesRef.current) observer.observe(side.canvas);
    return () => observer.disconnect();
  }, [engineReady]);

  // Input + render loop. Installed once per song; never rebuilt mid-play.
  useEffect(() => {
    if (!engineReady) return;

    const p1Keys = keymapFor(params.laneCount);
    const p2Keys = P2_KEYMAPS[params.laneCount] ?? p1Keys;
    const spectrum = new Uint8Array(new ArrayBuffer(512));
    const lastNoteAt = chartRef.current?.notes.at(-1)?.t ?? 0;
    const introOffset = introOffsetRef.current;
    let lastFrame = performance.now();
    let outroStarted = false;

    const refsFor = (player: PlayerIndex): ReturnType<typeof useSideRefs> =>
      player === 0 ? p1Refs : p2Refs;

    const showJudgement = (player: PlayerIndex, tier: Tier, timing: Timing | null): void => {
      const refs = refsFor(player);
      const el = refs.judgement.current;
      if (el) {
        el.textContent = TIER_LABELS[tier];
        el.style.color = TIER_COLORS[tier];
      }
      const tag = refs.timing.current;
      if (tag) {
        tag.textContent = timing ? TIMING_LABELS[timing] : '';
        tag.style.color = timing ? TIMING_COLORS[timing] : '#fff';
      }
      const side = sidesRef.current[player];
      if (side) side.judgementAlpha = 1;
    };

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
      if (phaseRef.current === 'finished' || phaseRef.current === 'loading') return;
      const sides = sidesRef.current;
      if (sides.length < 2) return;
      phaseRef.current = 'finished';

      const p1 = buildResult(sides[0]!.engine.snapshot);
      const p2 = buildResult(sides[1]!.engine.snapshot);
      const clock = clockRef.current;
      clock?.stop();
      // A shared ovation, scaled by the better of the two runs.
      clock?.playCheer(0.3 + Math.max(p1.accuracy, p2.accuracy) * 0.7);

      setMatch({ p1, p2, outcome: decideWinner(p1, p2) });
      setPhase('finished');
    };

    clockRef.current?.onEnded(() => finish());

    // Shared countdown — computed once from the clock's lead-in and painted into
    // both panes so each player reads it upright.
    let counting = false;
    let goUntil = 0;
    let lastBeepDigit = 0;
    const paintCountdowns = (nowSec: number): void => {
      const clock = clockRef.current;
      const els = [p1Refs.countdown.current, p2Refs.countdown.current];
      if (!clock) return;
      const remaining = clock.leadInRemaining;

      const write = (text: string, opacity: number, scale: number): void => {
        for (const el of els) {
          if (!el) continue;
          el.textContent = text;
          el.style.opacity = String(opacity);
          el.style.transform = `translate(-50%, -50%) scale(${scale})`;
        }
      };

      if (remaining > 0) {
        counting = true;
        const digit = Math.max(1, Math.ceil(remaining));
        write(String(digit), 1, 1 + (1 - (remaining % 1)) * 0.35);
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
        write('GO', goLeft / 0.7, 1 + (0.7 - goLeft));
      } else {
        for (const el of els) {
          if (el && el.textContent !== '') {
            el.textContent = '';
            el.style.opacity = '0';
          }
        }
      }
    };

    let loopFailed = false;
    const frame = (now: number): void => {
      try {
        step(now);
      } catch (err) {
        if (!loopFailed) {
          loopFailed = true;
          console.error('[tap-tap] versus loop error', err);
          setError(err instanceof Error ? err.message : String(err));
          applyPhase('error');
        }
      }
    };

    const step = (now: number): void => {
      const clock = clockRef.current;
      const sides = sidesRef.current;
      if (!clock || sides.length < 2) return;

      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      const songTime = clock.currentTime;

      clock.readSpectrum(spectrum);
      const bass = bandLevel(spectrum, 1, 8);
      const treble = bandLevel(spectrum, 60, 160);

      for (let p = 0; p < 2; p++) {
        const side = sides[p]!;
        const { engine, highway } = side;

        for (const missed of engine.update(songTime)) {
          highway.burst(missed.note.lane, 'miss');
          showJudgement(p as PlayerIndex, 'miss', null);
        }
        for (const lane of engine.takeCompletedHoldLanes()) {
          highway.burst(lane, 'perfect', engine.snapshot.combo);
        }

        const shownTime = engine.judgementTime(songTime);
        highway.render(
          shownTime,
          engine.visibleNotes(shownTime, params.approachSec),
          dt,
          bass,
          treble,
          spectrum,
        );

        const snap = engine.snapshot;
        const refs = refsFor(p as PlayerIndex);
        if (refs.score.current) refs.score.current.textContent = snap.score.toLocaleString();
        if (refs.combo.current) {
          refs.combo.current.textContent = snap.combo > 2 ? `${snap.combo}x` : '';
        }
        if (refs.acc.current) refs.acc.current.textContent = `${(snap.accuracy * 100).toFixed(1)}%`;

        side.judgementAlpha = Math.max(0, side.judgementAlpha - dt * 2.2);
        if (refs.judgement.current) refs.judgement.current.style.opacity = String(side.judgementAlpha);
        if (refs.timing.current) refs.timing.current.style.opacity = String(side.judgementAlpha * 0.9);
      }

      // Tug-of-war meter — P1's share of the combined score.
      if (tugRef.current) {
        const ratio = tugRatio(sides[0]!.engine.snapshot.score, sides[1]!.engine.snapshot.score);
        tugRef.current.style.width = `${ratio * 100}%`;
      }

      paintCountdowns(now / 1000);

      const bothFinished = sides[0]!.engine.snapshot.finished && sides[1]!.engine.snapshot.finished;
      const finishAt = lastNoteAt + OUTRO_SEC;

      if (bothFinished && !outroStarted) {
        outroStarted = true;
        const untilFinish = finishAt - songTime;
        const audioLeft = Math.max(0, clock.duration - songTime) - 0.2;
        const realLeft = Math.min(untilFinish, audioLeft) / clock.rate;
        clock.fadeOut(Math.max(0.4, realLeft));
      }

      const outroDone = songTime >= finishAt;
      if ((bothFinished && outroDone) || (songTime > 0 && songTime >= clock.duration)) {
        finish();
        return;
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    // --- shared controls ---

    const releaseAllHeld = (): void => {
      const clock = clockRef.current;
      for (const side of sidesRef.current) {
        side.laneByPointer.clear();
        if (!clock) continue;
        for (let lane = 0; lane < params.laneCount; lane++) {
          side.engine.releaseLane(lane, clock.currentTime);
        }
      }
    };

    const resetEngines = (): void => {
      const clock = clockRef.current;
      const chart = chartRef.current;
      if (!clock || !chart) return;
      for (const side of sidesRef.current) {
        side.engine = makeEngine(chart, clock);
        side.judgementAlpha = 0;
        side.prevCombo = 0;
        side.laneByPointer.clear();
      }
    };

    const beginRun = (): void => {
      const clock = clockRef.current;
      if (!clock) return;
      outroStarted = false;
      void clock.start(introOffset, LEAD_IN_SEC);
      applyPhase('playing');
      lastFrame = performance.now();
      // Always (re)start the loop. `finish()` stops rescheduling without nulling
      // `rafRef`, so a Rematch cannot rely on the "start only if idle" guard — it
      // would leave the loop dead and the board frozen on the previous score.
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(frame);
    };

    const start = (): void => {
      const clock = clockRef.current;
      if (!clock || clock.isPlaying || phaseRef.current !== 'ready') return;
      resetEngines();
      beginRun();
    };

    const rematch = (): void => {
      const clock = clockRef.current;
      if (!clock) return;
      if (finishTimerRef.current !== null) {
        window.clearTimeout(finishTimerRef.current);
        finishTimerRef.current = null;
      }
      setMatch(null);
      resetEngines();
      beginRun();
    };

    const pause = (): void => {
      const clock = clockRef.current;
      if (!clock || phaseRef.current !== 'playing') return;
      releaseAllHeld();
      clock.pause();
      applyPhase('paused');
    };

    const resume = (): void => {
      const clock = clockRef.current;
      if (!clock || phaseRef.current !== 'paused') return;
      playUiSound('back');
      void clock.resume(RESUME_COUNTDOWN_SEC);
      applyPhase('playing');
    };

    controlsRef.current = { start, pause, resume, rematch };

    // --- input ---

    const hit = (player: PlayerIndex, lane: number): void => {
      const side = sidesRef.current[player];
      const clock = clockRef.current;
      if (!side || !clock) return;
      if (clock.leadInRemaining > 0) return;
      side.highway.flashLane(lane);
      const result = side.engine.hitLane(lane, clock.currentTime);
      if (result) {
        side.highway.burst(lane, result.tier, result.combo);
        showJudgement(player, result.tier, result.timing);
      }
    };

    const release = (player: PlayerIndex, lane: number): void => {
      const side = sidesRef.current[player];
      const clock = clockRef.current;
      if (!side || !clock) return;
      const result = side.engine.releaseLane(lane, clock.currentTime);
      if (result?.completed) {
        side.highway.burst(lane, 'perfect', side.engine.snapshot.combo);
      }
    };

    /** A pointer down on one side's canvas. `rotated` inverts the 180° top pane. */
    const onCanvasPointerDown = (player: PlayerIndex, rotated: boolean) => (event: PointerEvent): void => {
      if (phaseRef.current === 'ready') {
        start();
        return;
      }
      if (phaseRef.current !== 'playing') return;
      const side = sidesRef.current[player];
      if (!side) return;

      const rect = side.canvas.getBoundingClientRect();
      let xRatio = (event.clientX - rect.left) / rect.width;
      let yRatio = (event.clientY - rect.top) / rect.height;
      // A 180° CSS rotation flips content within the same bounding box, so the
      // screen-space ratio is the mirror of the canvas-content ratio.
      if (rotated) {
        xRatio = 1 - xRatio;
        yRatio = 1 - yRatio;
      }
      const lane = side.highway.laneAtScreenPoint(xRatio, yRatio);
      if (lane >= 0 && lane < params.laneCount) {
        side.laneByPointer.set(event.pointerId, lane);
        hit(player, lane);
      }
    };

    const onPointerUp = (event: PointerEvent): void => {
      // A finger can slide off its canvas before lifting, so releases are caught
      // on the window and resolved against whichever side was holding it.
      for (let p = 0; p < 2; p++) {
        const side = sidesRef.current[p];
        if (!side) continue;
        const lane = side.laneByPointer.get(event.pointerId);
        if (lane === undefined) continue;
        side.laneByPointer.delete(event.pointerId);
        release(p as PlayerIndex, lane);
        return;
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (phaseRef.current === 'playing') pause();
        else if (phaseRef.current === 'paused') resume();
        else onExitRef.current();
        return;
      }
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

      const key = event.key.toLowerCase();
      const p1Lane = p1Keys.indexOf(key);
      if (p1Lane !== -1) {
        event.preventDefault();
        hit(0, p1Lane);
        return;
      }
      const p2Lane = p2Keys.indexOf(key);
      if (p2Lane !== -1) {
        event.preventDefault();
        hit(1, p2Lane);
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (phaseRef.current !== 'playing') return;
      const key = event.key.toLowerCase();
      const p1Lane = p1Keys.indexOf(key);
      if (p1Lane !== -1) {
        release(0, p1Lane);
        return;
      }
      const p2Lane = p2Keys.indexOf(key);
      if (p2Lane !== -1) release(1, p2Lane);
    };

    const onLeave = (): void => pause();
    const onVisibility = (): void => {
      if (document.hidden) pause();
    };

    const c1 = p1Refs.canvas.current;
    const c2 = p2Refs.canvas.current;
    const down1 = onCanvasPointerDown(0, false);
    const down2 = onCanvasPointerDown(1, true);
    c1?.addEventListener('pointerdown', down1);
    c2?.addEventListener('pointerdown', down2);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      c1?.removeEventListener('pointerdown', down1);
      c2?.removeEventListener('pointerdown', down2);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineReady, params.laneCount, params.approachSec]);

  const outcomeTag = (player: PlayerIndex): string => {
    if (!match) return '';
    if (match.outcome === 'draw') return 'DRAW';
    return (match.outcome === 'p1') === (player === 0) ? 'WINNER' : '';
  };

  const sideResult = (player: PlayerIndex): RunResult | null =>
    match ? (player === 0 ? match.p1 : match.p2) : null;

  /** The upright content for one pane: HUD during play, result at finish. */
  const paneContent = (player: PlayerIndex, refs: ReturnType<typeof useSideRefs>): JSX.Element => {
    const label = player === 0 ? 'P1' : 'P2';
    const result = sideResult(player);
    return (
      <>
        <div className="vs-hud">
          <div className="vs-hud__player">{label}</div>
          <div ref={refs.combo} className="vs-hud__combo" />
          <div className="vs-hud__line">
            <span ref={refs.score} className="vs-hud__score">0</span>
            <span ref={refs.acc} className="vs-hud__acc">100.0%</span>
          </div>
        </div>
        <div ref={refs.judgement} className="vs-judgement" style={{ opacity: 0 }} />
        <div ref={refs.timing} className="vs-timing" style={{ opacity: 0 }} />
        <div ref={refs.countdown} className="vs-countdown" style={{ opacity: 0 }} />

        {phase === 'ready' && (
          <div className="vs-card">
            <span className="vs-card__eyebrow">⚔ 2-Player Versus · {label}</span>
            <h2>{beatmap?.title}</h2>
            <span className="vs-card__meta">
              {difficulty} · {Math.round(beatmap?.bpm ?? 0)} BPM
            </span>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => controlsRef.current?.start()}
            >
              Tap to start
            </button>
          </div>
        )}

        {phase === 'finished' && result && (
          <div className="vs-card vs-card--result">
            {outcomeTag(player) && (
              <div
                className={`vs-outcome ${outcomeTag(player) === 'WINNER' ? 'vs-outcome--win' : 'vs-outcome--draw'}`}
              >
                {outcomeTag(player)}
              </div>
            )}
            <div className={`vs-result__disc grade--${result.grade}`}>
              <span className="vs-result__grade">{result.grade}</span>
            </div>
            <div className="vs-result__score">{result.score.toLocaleString()}</div>
            <div className="vs-result__stats">
              <span>{(result.accuracy * 100).toFixed(1)}%</span>
              <span>{result.maxCombo}x</span>
            </div>
            <div className="vs-card__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  playUiSound('confirm');
                  controlsRef.current?.rematch();
                }}
              >
                Rematch
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  playUiSound('back');
                  onExit();
                }}
              >
                Menu
              </button>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="vs" data-phase={phase}>
      <div className="vs-pane vs-pane--top" style={accentVars(P2_ACCENT)}>
        <canvas ref={p2Refs.canvas} className="vs-pane__canvas" />
        {paneContent(1, p2Refs)}
      </div>

      <div className="vs-mid">
        <div className="vs-tug" aria-hidden>
          <div ref={tugRef} className="vs-tug__fill" style={{ width: '50%' }} />
        </div>
        {phase === 'playing' && (
          <button
            type="button"
            className="vs-pause"
            aria-label="Pause"
            onClick={() => controlsRef.current?.pause()}
          >
            ❚❚
          </button>
        )}
      </div>

      {/* The single shared album, straddling the divider at both highways'
          vanishing point. Replaces the two per-highway cover discs. */}
      {beatmap?.thumbnailUrl && (
        <div className="vs-cover" aria-hidden>
          <img src={beatmap.thumbnailUrl} alt="" />
        </div>
      )}

      <div className="vs-pane vs-pane--bottom" style={accentVars(P1_ACCENT)}>
        <canvas ref={p1Refs.canvas} className="vs-pane__canvas" />
        {paneContent(0, p1Refs)}
      </div>

      {phase === 'loading' && (
        <div className="vs-overlay">
          <div className="spinner" />
          <p>Loading song…</p>
          {loadProgress > 0 && (
            <div className="load-bar" aria-label="Download progress">
              <div className="load-bar__fill" style={{ width: `${Math.round(loadProgress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {phase === 'error' && (
        <div className="vs-overlay">
          <h2>Could not start</h2>
          <p className="error-text">{error}</p>
          <button type="button" className="btn" onClick={onExit}>
            Back to songs
          </button>
        </div>
      )}

      {phase === 'paused' && (
        <div className="vs-overlay vs-overlay--pause">
          <div className="pause-card">
            <span className="pause-card__eyebrow">❚❚ Paused</span>
            <div className="vs-card__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => controlsRef.current?.resume()}
              >
                Resume
              </button>
              <button type="button" className="btn btn--ghost" onClick={onExit}>
                Quit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

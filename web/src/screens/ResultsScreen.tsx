import { DEFAULT_ACCENT, type DifficultyName } from '@tap-tap/shared';
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { accentVars } from '../accent.js';
import { TIERS, TIMINGS, biasAdvice, type Tier, type Timing } from '../game/judge.js';
import { loadRun } from '../lastRun.js';
import { TIER_COLORS, TIER_LABELS, TIMING_COLORS } from '../render/palette.js';
import { recordScore } from '../storage.js';
import { playUiSound } from '../uisfx.js';

interface ResultsScreenProps {
  songId: string;
  difficulty: DifficultyName;
  onRetry: () => void;
  onMenu: () => void;
  /** Called when this URL was opened without a matching run to show. */
  onMissing: () => void;
}

const TIMING_TITLES: Record<Timing, string> = {
  exact: 'Dead on',
  early: 'Early',
  late: 'Late',
};

export function ResultsScreen({
  songId,
  difficulty,
  onRetry,
  onMenu,
  onMissing,
}: ResultsScreenProps): JSX.Element {
  // Read once per mount: the run is fixed for this screen.
  const [result] = useState(() => loadRun(songId, difficulty));

  // Persist during the initializer so a re-render cannot double-record.
  const [isBest] = useState(() =>
    result
      ? recordScore(songId, difficulty, {
          score: result.score,
          accuracy: result.accuracy,
          maxCombo: result.maxCombo,
          grade: result.grade,
        })
      : false,
  );

  // The reveal is a small ceremony, sequenced so the beats land in order: the
  // card and medal settle (CSS), a fanfare sounds, then the score counts up
  // with tally clicks and a thud, and a new best gets its own sting on top.
  // Everything is driven off one effect so the timers clean up together.
  const [shownScore, setShownScore] = useState(0);
  useEffect(() => {
    if (!result) return;
    const target = result.score;
    const DELAY_MS = 550; // let the card rise and the medal slam land first
    const DURATION_MS = 900;
    const TICK_MS = 70; // throttle the tally clicks, or it is a 60fps machine gun

    let raf = 0;
    let startTs = 0;
    let lastTick = 0;
    let ended = false;

    const tick = (now: number): void => {
      const t = Math.min(1, (now - startTs) / DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setShownScore(Math.round(target * eased));
      if (now - lastTick >= TICK_MS && t < 1 && target > 0) {
        lastTick = now;
        playUiSound('tallyTick');
      }
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else if (!ended) {
        ended = true;
        playUiSound('tallyEnd');
        // The new-best sting lands just after the score settles, not on top of
        // it — two celebrations at once read as one muddled noise.
        if (isBest) bestTimer = window.setTimeout(() => playUiSound('newBest'), 280);
      }
    };

    // The fanfare tracks the medal slamming in (its CSS animation runs ~0.5s).
    const fanfareTimer = window.setTimeout(() => playUiSound('fanfare'), 240);
    const startTimer = window.setTimeout(() => {
      startTs = performance.now();
      lastTick = startTs;
      raf = requestAnimationFrame(tick);
    }, DELAY_MS);
    let bestTimer = 0;

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fanfareTimer);
      window.clearTimeout(startTimer);
      window.clearTimeout(bestTimer);
    };
  }, [result, isBest]);

  // Someone deep-linked or reloaded into a results URL with nothing to show —
  // typically a new session. Bounce to the menu rather than render an empty
  // scorecard. Held in a ref so a new callback identity cannot re-fire it.
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;
  useEffect(() => {
    if (!result) onMissingRef.current();
  }, [result]);

  if (!result) return <div className="results" />;

  const hits = TIMINGS.reduce((sum, timing) => sum + result.timingCounts[timing], 0);
  const advice = biasAdvice(result.meanDelta, hits);
  const meanMs = Math.round(result.meanDelta * 1000);

  return (
    <div className="results">
      <div className="results__card" style={accentVars(result.accent ?? DEFAULT_ACCENT)}>
        {/* Confetti burst, only when the run set a new best. Pure CSS particles;
            hidden entirely under reduced motion. */}
        {isBest && (
          <div className="results__confetti" aria-hidden>
            {Array.from({ length: 14 }, (_, i) => (
              <span key={i} className="confetti-bit" style={{ '--n': i } as CSSProperties} />
            ))}
          </div>
        )}

        <p className="results__diff">{difficulty}</p>
        <h1>{result.title}</h1>

        {/* The grade is the hero: a glowing medal with a firework burst behind
            it, the same gold-on-dark language as the game. */}
        <div className="results__medal">
          <div className="results__burst" aria-hidden />
          <div className={`results__disc grade--${result.grade}`}>
            <span className="results__grade">{result.grade}</span>
          </div>
        </div>

        {isBest && (
          <div className="results__best rise" style={{ '--i': 2 } as CSSProperties}>
            ★ New best
          </div>
        )}

        <div className="results__score">{shownScore.toLocaleString()}</div>

        <div className="results__stats rise" style={{ '--i': 3 } as CSSProperties}>
          <div className="stat">
            <div className="stat__value">
              {(result.accuracy * 100).toFixed(1)}
              <span className="stat__unit">%</span>
            </div>
            <div className="stat__label">Accuracy</div>
          </div>
          <div className="stat">
            <div className="stat__value">
              {result.maxCombo}
              <span className="stat__unit">x</span>
            </div>
            <div className="stat__label">Max combo</div>
          </div>
        </div>

        <div className="results__tiers rise" style={{ '--i': 4 } as CSSProperties}>
          {TIERS.map((tier: Tier) => (
            <div key={tier} className="tier-chip" style={{ color: TIER_COLORS[tier] }}>
              <span className="tier-chip__count">{result.counts[tier]}</span>
              <span className="tier-chip__label">{TIER_LABELS[tier]}</span>
            </div>
          ))}
        </div>

        <div className="timing-bars rise" style={{ '--i': 5 } as CSSProperties}>
          {TIMINGS.map((timing) => {
            const count = result.timingCounts[timing];
            const share = hits > 0 ? (count / hits) * 100 : 0;
            return (
              <div key={timing} className="timing-bar">
                <div className="timing-bar__head">
                  <span style={{ color: TIMING_COLORS[timing] }}>{TIMING_TITLES[timing]}</span>
                  <span className="results__count">{count}</span>
                </div>
                <div className="timing-bar__track">
                  <div
                    className="timing-bar__fill"
                    style={{ width: `${share}%`, background: TIMING_COLORS[timing] }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {hits > 0 && (
          <p className="muted small">
            Average offset {meanMs >= 0 ? '+' : ''}
            {meanMs} ms
          </p>
        )}
        {advice && <p className="results__advice">{advice}</p>}

        <div className="results__actions rise" style={{ '--i': 6 } as CSSProperties}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              playUiSound('confirm');
              onRetry();
            }}
          >
            Retry
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              playUiSound('back');
              onMenu();
            }}
          >
            Song list
          </button>
        </div>
      </div>
    </div>
  );
}

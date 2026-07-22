import { DEFAULT_ACCENT, type DifficultyName } from '@tap-tap/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
import { accentVars } from '../accent.js';
import { TIERS, TIMINGS, biasAdvice, type Tier, type Timing } from '../game/judge.js';
import { loadRun } from '../lastRun.js';
import { TIER_COLORS, TIER_LABELS, TIMING_COLORS } from '../render/palette.js';
import { recordScore } from '../storage.js';

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

  // Count the score up on arrival — the one bit of motion that makes the card
  // feel like a reward rather than a receipt.
  const [shownScore, setShownScore] = useState(0);
  useEffect(() => {
    if (!result) return;
    const target = result.score;
    const start = performance.now();
    const duration = 900;
    let raf = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setShownScore(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [result]);

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

        {isBest && <div className="results__best">★ New best</div>}

        <div className="results__score">{shownScore.toLocaleString()}</div>

        <div className="results__stats">
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

        <div className="results__tiers">
          {TIERS.map((tier: Tier) => (
            <div key={tier} className="tier-chip" style={{ color: TIER_COLORS[tier] }}>
              <span className="tier-chip__count">{result.counts[tier]}</span>
              <span className="tier-chip__label">{TIER_LABELS[tier]}</span>
            </div>
          ))}
        </div>

        <div className="timing-bars">
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

        <div className="results__actions">
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Retry
          </button>
          <button type="button" className="btn" onClick={onMenu}>
            Song list
          </button>
        </div>
      </div>
    </div>
  );
}

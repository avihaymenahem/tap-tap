import type { DifficultyName } from '@tap-tap/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
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
      <div className="results__card">
        <p className="muted">{difficulty}</p>
        <h1>{result.title}</h1>

        <div className={`grade grade--large grade--${result.grade}`}>{result.grade}</div>
        {isBest && <p className="results__best">New best!</p>}

        <div className="results__score">{result.score.toLocaleString()}</div>
        <p className="muted">
          {(result.accuracy * 100).toFixed(2)}% accuracy · {result.maxCombo}x max combo
        </p>

        <ul className="results__breakdown">
          {TIERS.map((tier: Tier) => (
            <li key={tier}>
              <span className="results__label" style={{ color: TIER_COLORS[tier] }}>
                {TIER_LABELS[tier]}
              </span>
              <span className="results__count">{result.counts[tier]}</span>
            </li>
          ))}
        </ul>

        <h3 className="results__subhead">Timing</h3>
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

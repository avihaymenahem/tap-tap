import { DEFAULT_ACCENT, type DifficultyName } from '@tap-tap/shared';
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { accentVars } from '../accent.js';
import { achievementById } from '../game/achievements.js';
import { TIERS, TIMINGS, biasAdvice, type Tier } from '../game/judge.js';
import { loadRun } from '../lastRun.js';
import { isAssisted } from '../game/modifiers.js';
import { TIER_COLORS, TIER_LABELS, TIMING_COLORS } from '../render/palette.js';
import { getBestScore, recordScore } from '../storage.js';
import { normalizeScore } from '../game/score.js';
import {
  HISTOGRAM_CENTRE,
  binCentreSec,
  emptyHistogram,
  histogramPeak,
  sectionAccuracies,
} from '../game/timingStats.js';
import { playUiSound } from '../uisfx.js';

interface ResultsScreenProps {
  songId: string;
  difficulty: DifficultyName;
  onRetry: () => void;
  onMenu: () => void;
  /** Called when this URL was opened without a matching run to show. */
  onMissing: () => void;
}

export function ResultsScreen({
  songId,
  difficulty,
  onRetry,
  onMenu,
  onMissing,
}: ResultsScreenProps): JSX.Element {
  // Read once per mount: the run is fixed for this screen.
  const [result] = useState(() => loadRun(songId, difficulty));

  // Whether this run was made easier than a plain one. Read off the run itself,
  // never off current settings — see RunResult.modifiers. A run stored before
  // that field existed reads as clean, which is the same forgiving default
  // `BestScore.assisted` takes.
  const assisted = result?.modifiers ? isAssisted(result.modifiers) : false;

  // Read the standing record *before* `recordScore` below can replace it —
  // `useState` initializers run in declaration order, so this must stay above
  // it. Without the snapshot there is nothing left to compare against: the
  // whole point of the delta is the number this run just beat.
  const [previousBest] = useState(() => getBestScore(songId, difficulty));

  // Persist during the initializer so a re-render cannot double-record. A failed
  // run is never a "best" — it folds its unreached notes to misses, so its score
  // would not beat a real run anyway, but skipping the record makes that explicit
  // and keeps a game-over from ever flashing "New best".
  const [isBest] = useState(() =>
    result && !result.failed
      ? recordScore(songId, difficulty, {
          score: result.score,
          accuracy: result.accuracy,
          maxCombo: result.maxCombo,
          grade: result.grade,
          assisted,
          // The exact full-combo signal for the clear lamp — `maxCombo` alone
          // cannot say, because the played chart may be shorter than the stored
          // one (intro skip, start grace). See `BestScore.misses`.
          misses: result.counts.miss,
          // `result.score` is already on the fixed scale; mark it so a legacy raw
          // record in this slot is rescaled rather than compared against it.
          normalized: true,
        },
        // Lets `recordScore` migrate a legacy record it finds here.
        result.scoreMax)
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
        // An achievement gets its own sparkle too — but only if a new best did
        // not already fire one, so the moment is never doubled.
        else if ((result.newAchievements?.length ?? 0) > 0) {
          bestTimer = window.setTimeout(() => playUiSound('newBest'), 320);
        }
      }
    };

    // No fanfare on a failed run — the game-over already sounded on the play
    // screen, and a triumphant sting over a FAILED card is the wrong note.
    const fanfareTimer = result.failed
      ? 0
      : window.setTimeout(() => playUiSound('fanfare'), 240);
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

  // The split, not just the mean. A mean of zero hides the difference between a
  // player who is dead on and one who is wildly early half the time and wildly
  // late the other half — and those two need opposite advice. Already stored on
  // every run; the card simply never showed it.
  const early = result.timingCounts.early;
  const late = result.timingCounts.late;

  // Measured against the record this run was up against, captured before it was
  // replaced. Shown whether the run beat it or not: falling 300 short is as
  // useful to know as clearing it by 300.
  // Against the previous best *on the current scale*. A legacy record holds a raw
  // total, which is a different unit — subtracting it would report a delta of
  // hundreds of thousands the first time a chart is replayed. Rescaled with this
  // run's own ideal, exactly as `recordScore` does; omitted entirely when there is
  // nothing to rescale with, since no delta beats a fabricated one.
  const previousScore =
    previousBest === null
      ? null
      : previousBest.normalized === true
        ? previousBest.score
        : result.scoreMax !== undefined
          ? normalizeScore(previousBest.score, result.scoreMax)
          : null;
  const scoreDelta = previousScore !== null ? result.score - previousScore : null;

  // Both are optional on the run: a result stored by an older build has neither, and
  // the card simply leaves those panels out rather than drawing empty ones.
  const histogram = result.timingHistogram ?? emptyHistogram();
  const sectionValues = result.sections ? sectionAccuracies(result.sections) : [];
  const sectionsLabel = `Accuracy by section: ${sectionValues
    .map((v, i) => `${i + 1} ${v === null ? 'not played' : `${Math.round(v * 100)}%`}`)
    .join(', ')}`;
  const accuracyDelta = previousBest ? result.accuracy - previousBest.accuracy : null;
  const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

  // Badges this run unlocked, resolved from their stored ids. Unknown ids (a
  // badge removed in a later build) are dropped rather than rendered blank.
  const earned = (result.newAchievements ?? [])
    .map(achievementById)
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

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

        {result.failed && <div className="results__failed">FAILED</div>}

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
            ★ New best{assisted && <span className="results__assisted-tag">assisted</span>}
          </div>
        )}

        {/* An assisted run that did not record needs to say why, or it reads as
            the game having lost the score. */}
        {assisted && !isBest && !result.failed && (
          <p className="results__assisted rise" style={{ '--i': 2 } as CSSProperties}>
            Assisted run — your best is kept
          </p>
        )}

        {earned.length > 0 && (
          <div className="results__achievements">
            <span className="results__achievements-label rise" style={{ '--i': 2 } as CSSProperties}>
              Achievement{earned.length > 1 ? 's' : ''} unlocked
            </span>
            <div className="results__badges">
              {earned.map((a, i) => (
                <div
                  key={a.id}
                  className="badge-pop pop"
                  style={{ '--i': i } as CSSProperties}
                  title={a.description}
                >
                  <span className="badge-pop__icon" aria-hidden>
                    {a.icon}
                  </span>
                  <span className="badge-pop__name">{a.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No thousands separators — the seven-segment face has no comma glyph. */}
        <div className="results__score">{shownScore}</div>

        {scoreDelta !== null && accuracyDelta !== null && (
          <p
            className={`results__delta ${scoreDelta >= 0 ? 'results__delta--up' : 'results__delta--down'}`}
          >
            {signed(scoreDelta)} · {accuracyDelta >= 0 ? '+' : ''}
            {(accuracyDelta * 100).toFixed(1)}% vs best
          </p>
        )}

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

        {hits > 0 && (
          <div className="results__timing rise" style={{ '--i': 5 } as CSSProperties}>
            <span className="results__timing-side">
              <b style={{ color: TIMING_COLORS.early }}>{early}</b> early
            </span>
            <span className="results__timing-mean">
              {meanMs >= 0 ? '+' : ''}
              {meanMs} ms
            </span>
            <span className="results__timing-side">
              <b style={{ color: TIMING_COLORS.late }}>{late}</b> late
            </span>
          </div>
        )}
        {advice && <p className="results__advice">{advice}</p>}

        {/* The distribution, not another average of it. Early is left of centre,
            late is right, and the marked centre line is "dead on" — a spread tells
            you to practise, a spike sitting off the line tells you to recalibrate,
            and two humps usually means one hand is behind the other. */}
        {histogramPeak(histogram) > 0 && (
          <div className="results__hist rise" style={{ '--i': 6 } as CSSProperties}>
            <div
              className="results__hist-bars"
              role="img"
              aria-label={`Timing spread: ${early} hits early, ${result.timingCounts.exact} dead on, ${late} late, averaging ${meanMs >= 0 ? '+' : ''}${meanMs} milliseconds`}
            >
              {histogram.map((count, bin) => (
                <span
                  key={bin}
                  className={`results__hist-bar${bin === HISTOGRAM_CENTRE ? ' results__hist-bar--centre' : ''}`}
                  style={{ '--h': `${(count / histogramPeak(histogram)) * 100}%` } as CSSProperties}
                  title={`${Math.round(binCentreSec(bin) * 1000)} ms — ${count} hit${count === 1 ? '' : 's'}`}
                />
              ))}
            </div>
            <div className="results__hist-axis">
              <span>early</span>
              <span>dead on</span>
              <span>late</span>
            </div>
          </div>
        )}

        {/* Where the run went wrong, rather than only how much. Equal time slices —
            the game does not know where the chorus is, and naming them as if it did
            would be a lie. An unplayed slice is blank, not zero. */}
        {sectionValues.some((v) => v !== null) && (
          <div className="results__sections rise" style={{ '--i': 6 } as CSSProperties}>
            <div className="results__sections-bars" role="img" aria-label={sectionsLabel}>
              {sectionValues.map((value, i) => (
                <span
                  key={i}
                  className={`results__section${value === null ? ' results__section--empty' : ''}`}
                  style={{ '--h': `${(value ?? 0) * 100}%` } as CSSProperties}
                  title={
                    value === null
                      ? `Section ${i + 1} — not played`
                      : `Section ${i + 1} — ${Math.round(value * 100)}%`
                  }
                />
              ))}
            </div>
            <div className="results__hist-axis">
              <span>start</span>
              <span>accuracy through the song</span>
              <span>end</span>
            </div>
          </div>
        )}

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

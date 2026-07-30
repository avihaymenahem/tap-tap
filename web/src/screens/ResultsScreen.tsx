import { DEFAULT_ACCENT, type DifficultyName } from '@tap-tap/shared';
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { accentVars } from '../accent.js';
import { achievementById } from '../game/achievements.js';
import { biasAdvice } from '../game/judge.js';
import { loadRun } from '../lastRun.js';
import { isAssisted } from '../game/modifiers.js';
import { TIER_COLORS, TIER_LABELS } from '../render/palette.js';
import { getBestScore, recordScore } from '../storage.js';
import { normalizeScore } from '../game/score.js';
import { playUiSound } from '../uisfx.js';

interface ResultsScreenProps {
  songId: string;
  difficulty: DifficultyName;
  onRetry: () => void;
  onMenu: () => void;
  /** Called when this URL was opened without a matching run to show. */
  onMissing: () => void;
}

/**
 * The one line of flavour, sourced from something this game actually has.
 *
 * The reference puts "Masterful! You outscored 97.9% of the world." here, and we
 * cannot: there is no leaderboard and there deliberately never will be — the app
 * is serverless with per-device storage. The *slot* is what matters, so it is
 * filled from the local record instead. Ordered by what the player most wants
 * told: a new record first, then a first clear, then a plain verdict on the run.
 */
const VERDICTS: Record<string, string> = {
  S: 'Flawless.',
  A: 'Sharp run.',
  B: 'Solid run.',
  C: 'Getting there.',
  D: 'Rough one.',
  F: 'Keep at it.',
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

  const hits = result.timingCounts.exact + result.timingCounts.early + result.timingCounts.late;
  // Only when the bias is real and measured over enough hits — `biasAdvice`
  // returns null otherwise, which is why this is a rare extra line rather than a
  // permanent block. It is the one piece of coaching the card still carries; the
  // two charts it used to sit under are gone.
  const advice = biasAdvice(result.meanDelta, hits);

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
  const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

  const accuracyPct = (result.accuracy * 100).toFixed(1);
  /*
   * One line, and it must not restate the badge above it.
   *
   * It used to say "New personal best, by 300" directly under a gold NEW BEST
   * pill — two centred rows making one claim, which is exactly the residual
   * density the reference does not have. The record claim now lives entirely in
   * the inline badge beside the score; this line only ever carries the verdict
   * and the numbers that are nowhere else on the card.
   */
  const flavour = result.failed
    ? `Ran out of health — ${accuracyPct}% accuracy.`
    : `${VERDICTS[result.grade] ?? ''} ${accuracyPct}% accuracy, ${result.maxCombo} max combo.`;

  // The badge that rides beside the score, reference-style. "First clear" when
  // there was no record to beat, so the two cases never need a second line.
  const bestLabel = isBest ? (previousScore === null ? 'First clear' : 'New best') : null;

  // Badges this run unlocked, resolved from their stored ids. Unknown ids (a
  // badge removed in a later build) are dropped rather than rendered blank.
  const earned = (result.newAchievements ?? [])
    .map(achievementById)
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

  /*
   * The summary band: THREE numbers, not eight.
   *
   * The card used to carry a four-chip tier grid, an accuracy/max-combo stat
   * pair, an early|mean|late row, a timing histogram and a per-section bar chart
   * — five separate readings of one run, none of them the thing a player looks
   * at the card to find out. Perfect, great and miss are the three that carry the
   * shape of a run: how much of it was clean, how much was scrappy, and how much
   * was dropped. Accuracy and max combo moved into the flavour line, which is a
   * sentence rather than a sixth chart. `good` is folded away deliberately — it
   * is the residue of the other three and adds a number without adding a fact.
   *
   * `TIER_COLORS` and never a theme accent: perfect/great/miss is the one visual
   * language the player learns once and relies on everywhere.
   */
  const band = (['perfect', 'great', 'miss'] as const).map((tier) => ({
    tier,
    count: result.counts[tier],
  }));

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

        {/* The header strip: what was played, and on what. One row, so the whole
            top of the card costs a single line rather than a stacked eyebrow. */}
        <div className="results__head">
          <h1>{result.title}</h1>
          <span className="results__diff">{difficulty}</span>
        </div>

        {result.failed && <div className="results__failed">FAILED</div>}

        {/* --- the hero: grade, then score, and nothing else in this region ---
            The reference gives the grade about a quarter of the frame and leaves
            the space around it empty; that emptiness is what makes it read as the
            one thing on the screen. Everything that used to sit between the grade
            and the score (best pill, assisted tag, achievements) now sits after
            the score, so the two never have anything between them. */}
        <div className="results__hero">
          <div className="results__medal">
            <div className="results__burst" aria-hidden />
            <div className={`results__disc grade--${result.grade}`}>
              <span className="results__grade">{result.grade}</span>
            </div>
          </div>

          {previousScore !== null && (
            <p className="results__prev">
              Best <b>{previousScore.toLocaleString()}</b>
            </p>
          )}

          {/* Badge, score and delta on ONE baseline — the reference's shape, and
              the reason the card no longer carries a separate NEW BEST row. The
              score is grouped and set in the display face: the seven-segment
              readout belongs to the in-run HUD, where a number ticks every
              frame; here it is a payout and has to be legible at a glance. */}
          <div className="results__score-row">
            {bestLabel && (
              <span className="results__best pop" style={{ '--i': 1 } as CSSProperties}>
                {bestLabel}
                {assisted && <span className="results__assisted-tag">assisted</span>}
              </span>
            )}
            <span className="results__score">{shownScore.toLocaleString()}</span>
            {scoreDelta !== null && (
              <span
                className={`results__delta ${scoreDelta >= 0 ? 'results__delta--up' : 'results__delta--down'}`}
              >
                {signed(scoreDelta)}
              </span>
            )}
          </div>
        </div>

        <p className="results__flavour rise" style={{ '--i': 2 } as CSSProperties}>
          {flavour}
        </p>

        {/* Rare and celebratory, so it earns its place — but with no heading of
            its own: the badges say what they are. */}
        {earned.length > 0 && (
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
        )}

        <div className="results__band rise" style={{ '--i': 3 } as CSSProperties}>
          {band.map(({ tier, count }) => (
            <div key={tier} className="results__band-cell" style={{ color: TIER_COLORS[tier] }}>
              <span className="results__band-count">{count}</span>
              <span className="results__band-label">{TIER_LABELS[tier]}</span>
            </div>
          ))}
        </div>

        {advice && <p className="results__advice">{advice}</p>}

        {/* An assisted run that did not record needs to say why, or it reads as
            the game having lost the score. */}
        {assisted && !isBest && !result.failed && (
          <p className="results__assisted">Assisted run — your best is kept</p>
        )}

        <div className="results__actions rise" style={{ '--i': 4 } as CSSProperties}>
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
        </div>
      </div>
    </div>
  );
}

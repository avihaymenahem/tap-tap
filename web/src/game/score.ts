import { isHold, type Note } from '@tap-tap/shared';
import {
  EXACT_BONUS,
  HOLD_TICK_SCORE,
  HOLD_TICK_SEC,
  SCORE_VALUES,
  comboMultiplier,
  holdBonus,
} from './judge.js';

/**
 * Score normalisation — a fixed ceiling instead of a raw running total.
 *
 * The raw score is the sum of every hit's tier value times the combo multiplier,
 * so it scales with how many notes a chart has. 292,875 is a flawless run on a
 * 232-note easy chart and 1,387,875 is a flawless run on a 962-note extreme one:
 * the same performance, two numbers with no relationship. That makes the figure
 * unreadable on its own — "1,204,880" tells a player nothing without knowing the
 * chart's length — and it means a longer song always posts a bigger number.
 *
 * **Worth being straight about the scope of the problem.** Nothing in the app
 * currently compares scores across songs: `recordScore` compares within one chart,
 * Versus compares two players on the same chart in the same run, and the menu
 * sorts offer no score option. So this is a legibility fix and a foundation for
 * any future cross-song feature, not the repair of an active defect.
 *
 * **The migration is the dangerous half.** There is one best slot per chart and no
 * second copy. A raw record of 1,387,875 compared against a normalised run capped
 * at 1,000,000 would reject every future clean run *permanently* — the same
 * irreversible shape that assisted runs overwriting clean ones had. So legacy
 * records are rescaled on read rather than left to be compared across scales;
 * see `rescaleLegacyScore`.
 */

/** The ceiling a flawless run reaches. */
export const MAX_SCORE = 1_000_000;

/** What one note is worth at the top tier, landed dead-on, before the multiplier. */
const PERFECT_EXACT = Math.round(SCORE_VALUES.perfect * EXACT_BONUS);

/**
 * The raw score a flawless run over these notes would earn.
 *
 * Mirrors the engine's accumulation: combo is incremented *before* the multiplier
 * is read, so the i-th consecutive hit is worth `PERFECT_EXACT *
 * comboMultiplier(i)`. Chord voices are separate notes and each advance the combo,
 * which is why this walks notes rather than distinct timestamps.
 *
 * Holds add their ticks and their tail bonus at the multiplier in force around
 * their own head. That is an approximation — the real ticks are interleaved with
 * later notes as the combo keeps climbing — and it is why `normalizeScore` clamps.
 * Being a little conservative here means a flawless run reads exactly the ceiling
 * rather than a hair under it.
 */
export function idealScore(notes: readonly Note[]): number {
  let total = 0;
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!;
    const multiplier = comboMultiplier(i + 1);
    total += PERFECT_EXACT * multiplier;

    if (isHold(note)) {
      const duration = note.duration ?? 0;
      const ticks = Math.floor(duration / HOLD_TICK_SEC);
      total += ticks * HOLD_TICK_SCORE * multiplier;
      total += holdBonus(duration) * multiplier;
    }
  }
  return total;
}

/**
 * A raw score expressed against {@link MAX_SCORE}.
 *
 * Clamped at both ends. The ceiling matters: `idealScore` models interleaved hold
 * ticks approximately, so a genuinely flawless run can compute a hair above the
 * ideal, and a score reading 1,000,240 would look like a bug.
 */
export function normalizeScore(raw: number, ideal: number): number {
  if (!Number.isFinite(raw) || !Number.isFinite(ideal) || ideal <= 0) return 0;
  return Math.max(0, Math.min(MAX_SCORE, Math.round((raw / ideal) * MAX_SCORE)));
}

/**
 * Bring a record stored on the old raw scale onto the normalised one.
 *
 * Rescaling rather than discarding, and rescaling rather than comparing across
 * scales, because both alternatives are worse. Comparing a raw 1,387,875 against a
 * normalised ceiling of 1,000,000 locks the chart's record forever. Letting any
 * new run displace a legacy one regardless of quality throws away a real personal
 * best — a mediocre first run would wipe an S-rank clear.
 *
 * The transform is monotonic, so a chart's ranking is unchanged; it only restates
 * the number. It is approximate when the chart has been regenerated since the
 * record was set, because the note count it is measured against has moved — but
 * regenerating already invalidates stored scores, so that is not a new caveat.
 */
export function rescaleLegacyScore(legacyScore: number, notes: readonly Note[]): number {
  return normalizeScore(legacyScore, idealScore(notes));
}

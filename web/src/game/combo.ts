/**
 * Combo milestones — the streak lengths worth celebrating.
 *
 * Pure so it can be unit-tested and called from the render loop without any
 * DOM. The render loop tracks the previous frame's combo and asks whether the
 * new one just crossed a milestone; the answer drives a flash and a sound.
 *
 * Spacing rationale: dense early (25, 50) because the first long streak is the
 * one that hooks a new player, then every 50 so a strong run through a full
 * song still lands a handful of moments rather than a constant drip.
 */

/** Is `n` itself a milestone value? */
export function isComboMilestone(n: number): boolean {
  if (n === 25 || n === 50) return true;
  return n >= 100 && n % 50 === 0;
}

/**
 * The milestone the combo just reached, or `null`.
 *
 * `prev` is the combo before this hit, `next` after it. Combo only ever climbs
 * by one per hit, but this scans the whole `(prev, next]` range so a reset
 * (next <= prev) correctly returns null and a hypothetical jump still fires at
 * most once, on the highest milestone crossed.
 */
export function comboMilestone(prev: number, next: number): number | null {
  let hit: number | null = null;
  for (let n = prev + 1; n <= next; n++) {
    if (isComboMilestone(n)) hit = n;
  }
  return hit;
}

/**
 * A coarse "how hot is this streak" tier, for sizing and glowing the combo
 * readout. Tiers, not a continuous scale, so the number's size is stable
 * within a tier instead of jittering every single hit.
 */
export function comboTier(combo: number): 0 | 1 | 2 | 3 | 4 {
  if (combo >= 100) return 4;
  if (combo >= 50) return 3;
  if (combo >= 25) return 2;
  if (combo >= 10) return 1;
  return 0;
}

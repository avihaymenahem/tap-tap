import type { Onset } from '@tap-tap/shared';

export type Band = 'low' | 'mid' | 'high';

export interface LaneRanges {
  low: readonly number[];
  mid: readonly number[];
  high: readonly number[];
}

/**
 * Which lanes each frequency band may occupy.
 *
 * This is the decision that makes generated charts feel musical. Kick drums
 * land on the left, hats and melody on the right, snare and vocal body in the
 * middle — so the player's hand physically mirrors the kit. Random lane
 * assignment is the usual reason auto-generated charts feel like noise.
 */
const RANGES: Record<number, LaneRanges> = {
  3: { low: [0], mid: [1], high: [2] },
  4: { low: [0], mid: [1, 2], high: [3] },
  5: { low: [0], mid: [1, 2, 3], high: [4] },
};

export function laneRangesFor(laneCount: number): LaneRanges {
  const r = RANGES[laneCount];
  if (r) return r;

  // Fallback for lane counts we have not hand-tuned: split into even thirds.
  const third = Math.max(1, Math.floor(laneCount / 3));
  const all = Array.from({ length: laneCount }, (_, i) => i);
  return {
    low: all.slice(0, third),
    mid: all.slice(third, laneCount - third),
    high: all.slice(laneCount - third),
  };
}

export function dominantBand(onset: Onset): Band {
  if (onset.low >= onset.mid && onset.low >= onset.high) return 'low';
  if (onset.high >= onset.mid) return 'high';
  return 'mid';
}

/**
 * Pick a lane within the band's range, avoiding an immediate repeat where the
 * range allows it. Repeating the same lane produces "jackhammer" streams that
 * feel bad to play even when they are rhythmically correct.
 */
export function pickLane(
  range: readonly number[],
  previousLane: number | null,
  rand: () => number,
): number {
  if (range.length === 0) return 0;
  if (range.length === 1) return range[0]!;

  const candidates = range.filter((l) => l !== previousLane);
  const pool = candidates.length > 0 ? candidates : range;
  return pool[Math.floor(rand() * pool.length) % pool.length]!;
}

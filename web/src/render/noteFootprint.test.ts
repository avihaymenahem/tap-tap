import { describe, expect, it } from 'vitest';
import {
  HIGHWAY_LENGTH,
  HIT_ZONE_DEPTH,
  HIT_ZONE_WIDTH,
  LANE_WIDTH,
  TILE_HEIGHT,
  TILE_OUTER_DEPTH,
  TILE_OUTER_WIDTH,
} from './highway.js';

/**
 * The note's footprint against its receptor's, pinned.
 *
 * These are four plain numbers and it would be easy to read this as a test that
 * only restates them. It is not: the relationship between them is the shape the
 * reference frames specify, and every one of the three has already been broken
 * once in this file.
 *
 * The renderer cannot check any of it — a tile that is two thirds the width of
 * its socket renders perfectly happily, and the defect only shows up as "the note
 * bars are tiny" from a player looking at the finished frame. It is also
 * *indirect* in the source: the tile is authored at `TILE_WIDTH` and grown by
 * `TILE_BEVEL` on every side, so the number that has to agree with the pad is one
 * nobody types.
 */
describe('note and receptor footprints', () => {
  it('makes a note exactly as wide as the pad it lands in', () => {
    /*
     * The reference's own construction, and the cleanest way to specify it: in
     * every frame the note and the receptor directly beneath it are the same width
     * to within a few pixels (measured on the cyan frame: a 243px pad, and a note
     * that works out to 251px once its extra nearness is divided out). Match the
     * footprints and the landing reads correctly by construction, with no socket
     * rim to tune.
     *
     * The model this replaced put the tile at 0.52 of a lane so it would drop
     * *through* a visible rim — a socket, from a different genre — and it measured
     * 69% of its pad's width on the shipped frame.
     */
    expect(TILE_OUTER_WIDTH).toBeCloseTo(HIT_ZONE_WIDTH, 6);
  });

  it('keeps the slab taller than it is wide at the CREST, not just at the row', () => {
    /*
     * The reference's notes are taller than wide ON SCREEN, which is not the same
     * as being deeper than wide in world units: the track is seen at an angle, so
     * depth is compressed and the compression is worst at the far end of the
     * runway. That is why this is asserted at the crest — the previous version
     * used the receptor row's foreshortening, passed comfortably, and shipped a
     * board whose two upper notes measured 1:0.79 and 1:0.96, i.e. WIDER than
     * tall. No reference note anywhere is under 1:0.95.
     *
     * All three factors are read off the real rig by projecting the slab's
     * bounding box through a camera set up exactly as `fovFor` and `resize` do,
     * at 390x844 with 4 lanes, for a note **at the spawn point**.
     *
     * The height term is the load-bearing one and it is nearly constant with
     * distance, because a vertical world segment projects at the same scale as a
     * horizontal one at the same depth. That is what makes the side wall — not the
     * depth, which is capped below — the lever that lifts a FAR note's aspect.
     *
     * The width is the TAPERED one: `curveWidth` pulls the track in at the crest
     * and the tile is scaled with it, so a check written against the nominal width
     * under-reports the aspect and fails a rig that in fact passes.
     *
     * **Re-read at z = -16.5, and the previous set was measured at z = -19.**
     * `NOTE_SPAWN_PROGRESS` is 0.66 of a 25-unit highway, so -19 is a spawn point
     * that has not existed since the flat rig landed — and foreshortening changes
     * fast out there, 0.263 at -19 against 0.288 at -16.5. The stale pair made the
     * check about 10% pessimistic, which is the difference between passing and
     * failing for any wall under half a unit. Nothing about the assertions moved.
     */
    /*
     * **Re-read at z = -17 under the (24, 39) rig** (`NOTE_SPAWN_PROGRESS` 0.68 of
     * a 25-unit highway). Pulling the camera back 1.3x is what moved these: the
     * crest is seen 22.6 degrees below the horizontal instead of 16.7, so
     * foreshortening is 0.384 against 0.288 and the far note's silhouette goes
     * 1:1.01 to 1:1.25. The far note getting *rounder* is the whole point of the
     * flatter rig, and this is the assertion that rules out the other way of
     * flattening it — shortening `HIGHWAY_LENGTH`, which forces `TILE_DEPTH` down
     * (see the travel check below) and takes the crest to 1:0.97, i.e. a note
     * wider than tall.
     */
    /*
     * **Re-read at z = -16.5 under the (15, 24) rig** (`NOTE_SPAWN_PROGRESS` 0.66
     * of a 25-unit highway). Bringing the camera back IN is what moved these:
     * the crest is now seen through a 22-degree lens from 28 units out instead of
     * a 10-degree one from 77, so foreshortening reads 0.335 against 0.384 and
     * the upright term 0.946 against 0.923. Both are read off the same projection
     * `fovFor`/`resize` build. The assertions below did not move — the slab is
     * shorter (TILE_DEPTH 2.9) so the NEAR note stops measuring 1.50:1, and the
     * crest still clears 1:1 at 1.22.
     */
    const CREST_FORESHORTEN = 0.3348;
    const CREST_UPRIGHT = 0.9463;
    const CREST_TAPER = 0.9913;
    const crestWidth = TILE_OUTER_WIDTH * CREST_TAPER;
    const wallPart = TILE_HEIGHT * CREST_UPRIGHT;
    const aspect = (TILE_OUTER_DEPTH * CREST_FORESHORTEN + wallPart) / crestWidth;
    expect(aspect).toBeGreaterThan(1.0);

    /*
     * And the wall has to be a legible share of that silhouette, not a hairline:
     * the reference's far note spends 13.5% of its height on wall.
     *
     * **There is deliberately no upper bound here, and the reason is worth
     * recording.** Ours runs about 28%, which is twice the reference's, and both
     * ways of buying that back are spent: the depth is capped by hard's own note
     * spacing (below), and the wall is the only term keeping the assertion above
     * from failing — at 0.30 the crest note comes out 1:0.96, i.e. WIDER than
     * tall, which is the owner gate. The underlying difference is the approach
     * runway: the reference shows ~30% of its frame as approach where CLAUDE.md
     * requires 55% of ours, so our far notes are foreshortened about 2.4x harder
     * and their faces cannot carry the aspect the way its faces do. What closes
     * the gap is lighting rather than geometry — the wall is graded down its own
     * height now, so the dark band a profile measures is its lower half.
     */
    expect(wallPart / (crestWidth * aspect)).toBeGreaterThan(0.12);
  });

  it('leaves a groove between neighbouring pads, and room for a note to travel', () => {
    // Pads that touch read as one continuous bar rather than four targets.
    expect(HIT_ZONE_WIDTH).toBeLessThan(LANE_WIDTH);
    expect(LANE_WIDTH - HIT_ZONE_WIDTH).toBeGreaterThan(0.03);

    /*
     * The pad has to stay clearly deeper than the tile, because "it went in" is
     * carried by the tile dropping into something bigger than itself — the
     * reference runs its tile at 56% of its pad's depth.
     */
    expect(TILE_OUTER_DEPTH).toBeLessThan(HIT_ZONE_DEPTH * 0.9);

    /*
     * And it has to fit the gap a chart leaves. Hard spaces notes 0.19s apart,
     * which is 3.65 world units of travel at this approach time; a slab longer
     * than that would have consecutive notes in one lane touching.
     */
    /*
     * Derived from `HIGHWAY_LENGTH` rather than typed, because the gap SCALES
     * with the track's length — a note crosses the whole runway in `approachSec`,
     * so `minGapSec` buys `L * gap / approach` world units of it. Written as the
     * literal 3.65 this read as a fact about tiles when it is a fact about the
     * rig, and it silently becomes false the moment anyone shortens the track to
     * flatten the perspective (which is exactly the change this file exists to
     * stop: at L = 18 the travel is 2.63 and no legal `TILE_DEPTH` survives).
     */
    const HARD_GAP_SEC = 0.19;
    const HARD_APPROACH_SEC = 1.3;
    const HARD_NOTE_TRAVEL = (HIGHWAY_LENGTH * HARD_GAP_SEC) / HARD_APPROACH_SEC;
    expect(TILE_OUTER_DEPTH).toBeLessThan(HARD_NOTE_TRAVEL - 0.5);
  });
});

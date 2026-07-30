import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { NoteState } from '../game/engine.js';
import type { Tier } from '../game/judge.js';
import type { Visibility } from '../game/modifiers.js';
import type { Theme } from '@tap-tap/shared';
import { DEFAULT_ACCENT } from '@tap-tap/shared';
import { flashEffectsEnabled, flashStride } from './flash.js';
import { laneColor } from './palette.js';
import { RenderClock } from './renderClock.js';
import {
  markAutoTier,
  nextTierDown,
  qualityProfile,
  type QualityProfile,
  type QualityTier,
} from './quality.js';

/**
 * Perspective note highway.
 *
 * Reads game state and draws it. Owns no rules: it is handed the notes to show
 * and the current song time, and decides nothing about hits, scoring, or timing.
 *
 * Note colours run above 1.0 in their peak channel, but only in the tile's rim
 * zone and only to a fixed, hue-independent amount — see `buildNotes`. Glow is
 * the halo's job, not over-exposure's: driving a fill past the tone curve's
 * shoulder desaturates it, which is what turned the red lane into pale pink.
 */

/**
 * Lane pitch, in world units.
 *
 * 1.28, not 1.15, and it is the composition lever the FOV maths *allows* rather
 * than one it fights. `fovFor` takes the max of a width requirement and a height
 * requirement; on this rig the height one binds (19.28 deg against 18.63 at
 * 390x844), so widening the board buys frame width for free right up to the
 * point where the width requirement crosses over. Measured against the
 * reference: its receptor row spans ~95% of the frame, ours spanned 84%.
 */
/*
 * **1.05, and it is a pure horizontal zoom-out.** At 1.28 the outermost pads ran
 * off both edges of a 1170x2532 portrait frame — the receptor row measured 99.5%
 * of the frame's width, so two of the four targets lost their outer bezel at the
 * one row the player stares at. The reference fits all four with ~6.5% of the
 * frame as margin either side (pads x65-865 of 923).
 *
 * Scaling the lane pitch rather than opening the FOV is what makes this free:
 * `fovFor` takes the max of a width and a height requirement, and the HEIGHT one
 * binds here (20.5 deg against 18.3), so narrowing the board does not move the
 * lens at all — the vertical framing, the approach runway and the far/near lane
 * pitch ratio are all untouched. Opening the FOV instead would have shrunk the
 * track vertically too and taken the runway under its 55% floor.
 *
 * Everything sized off it scales with it: `HIT_ZONE_WIDTH` and `TILE_WIDTH` keep
 * their ratios (0.883 and 0.883 - 2 x TILE_BEVEL), so a note is still exactly its
 * pad's width.
 */
const LANE_WIDTH = 1.05;
/**
 * Tap-tile footprint on the track, in world units — the *shape*, before the bevel.
 *
 * **A note is the same width as its receptor pad**, which is the reference's own
 * construction and is measurable in all four of its frames: the note and the pad
 * under it agree to within a few pixels, so a landing reads correctly by
 * construction rather than by a tuned clearance. `TILE_OUTER_WIDTH` is therefore
 * defined to equal `HIT_ZONE_WIDTH` and this is derived from it.
 *
 * The previous model was the opposite — 0.52 of a lane, so the tile dropped
 * *inside* a visible rim of socket. Measured on the shipped frame that put the
 * note at 61% of its lane and 69% of the pad's width, against the reference's 91%
 * and 93%: a tile two thirds the width of its slot never reads as landing in it,
 * and a narrow tile is harder to attribute to a lane in peripheral vision. The
 * "it went in" cue now comes from the pad being much DEEPER than the tile (3.5
 * against 2.0), which is where the reference puts it too.
 */
/*
 * **0.88 of the lane pitch, not 0.97, and the gap is the point.** Matching the
 * pad was right and is kept (`TILE_OUTER_WIDTH === HIT_ZONE_WIDTH`, pinned in
 * `noteFootprint.test.ts`); what was wrong is that BOTH filled almost the whole
 * lane. Measured on the shipped frame, two notes in adjacent lanes abutted with
 * a ~2px seam and read as one 320px block rather than as a chord. The reference
 * runs its tile at ~180px on a ~205px pitch precisely so deck always shows
 * between neighbours. 1.03 + 2 x TILE_BEVEL = 1.13 on a 1.28 lane = 0.883.
 */
const TILE_WIDTH = 0.83;
/**
 * Front-to-back length of a tile — its on-screen height.
 *
 * The reference's notes are TALLER THAN WIDE on screen, and the previous number
 * was set against a mis-measurement of them. Sampled properly, its lane-2 note
 * spans 216 x 299 device px — 1:1.38 — and reaches 85% of the height of the pad
 * beneath it. At 2.05 ours measured 215 x 195, i.e. 1:0.91 (wider than tall) and
 * only 53% of its pad, which is most of what is left of "the note bars are tiny".
 * Foreshortening at this rig is ~0.49, so buying screen height costs about twice
 * as much world depth.
 *
 * 2.70, raised with the width. Screen aspect here is (outerDepth x foreshorten) /
 * outerWidth, and the foreshortening at this rig is ~0.49 — so widening the tile
 * to match the reference's 95.3%-of-lane pad (see `HIT_ZONE_WIDTH`) costs aspect
 * and has to be bought back in depth or the slab goes square. At 2.70 the
 * finished slab is 2.80 x 1.22, i.e. 1:1.12 on screen: still taller than wide,
 * which is the property the reference has and the gate checks.
 *
 * **3.00, which is the ceiling, not a preference.** The tile has to fit the gap a
 * chart leaves: hard spaces notes 0.19s apart, which at this approach time is
 * 3.65 world units of travel, so 3.10 (outer, bevel included) leaves 0.55 units
 * of visible deck between consecutive notes in one lane — and the pad has to stay
 * clearly deeper than the tile (3.5 * 0.9 = 3.15) or "it went in" stops being
 * carried by the slot being bigger than the thing landing in it. Both bounds land
 * on 3.15 and `noteFootprint.test.ts` asserts them, so depth is spent out; the
 * rest of the aspect the reference has comes from the camera and the side wall.
 */
/*
 * **2.50 under the (15, 24) rig, and depth is no longer the scarce term.**
 *
 * The paragraph above was written when the camera was a long lens looking down a
 * shallow slope, where depth foreshortened to almost nothing and every unit of it
 * was needed to keep the slab taller than wide. The short lens inverts that: the
 * receptor row is seen 32 degrees down instead of through a 10-degree lens — but
 * the short lens is also a WIDE one, and that is the term that actually fixed the
 * silhouette. The near slab measures 262 device px across where it measured 217,
 * so the same depth divided by a wider note is a rounder note.
 *
 * **2.70, and the number has to be read as a PROFILE, not a value.** A slab's
 * on-screen aspect depends on where it is: measured on the reference's own cyan
 * frame its notes run 1.09:1 at the crest, 1.38:1 mid-runway and 1.50:1 once past
 * the row, so quoting one figure for "the note aspect" is quoting one point on a
 * curve. Ours ran 1.50:1 at the ROW under the old rig — the reference's *near*
 * figure, at the place its own notes read 1.38 — and 3.00 under this camera still
 * measured 1.47 there. 2.70 lands 1.08 / 1.32 / 1.38 across the same three
 * positions, i.e. within 0.03 of the reference at every one of them. 2.50 was
 * over-correcting: it took the crest to 1.16 and mid-runway under the reference.
 * The two bounds above (3.15) still hold with half a unit to spare.
 */
/*
 * 2.05, MEASURED on the capture rather than scaled off the old value. With the
 * narrower board a near tile profiled 170 x 250 device px, i.e. 1.47:1 against the
 * reference's 1.27:1 — the side wall is a fixed 55px of that height, so the top
 * face had to come down from ~195px to ~160px, which is this ratio. It also puts
 * the tile at 59% of the pad's depth, against the reference's 56%.
 */
const TILE_DEPTH = 2.05;
/**
 * Bevel `makeTileGeometry` adds on every side of the extruded slab.
 *
 * It is named here because it is what the eye actually measures: the shape is
 * built at `TILE_WIDTH x TILE_DEPTH` and then grown by this on all four sides,
 * so "the tile" on screen is `TILE_OUTER_*`, not `TILE_*`. Sizing the receptor
 * frame from `TILE_WIDTH` (as it was) made the target 1.59x smaller than the bar
 * dropping into it, which is why a tile never visibly landed *in* anything.
 */
const TILE_BEVEL = 0.05;
/** The finished slab's outer footprint, bevel included. */
const TILE_OUTER_WIDTH = TILE_WIDTH + TILE_BEVEL * 2;
const TILE_OUTER_DEPTH = TILE_DEPTH + TILE_BEVEL * 2;
/**
 * Extrusion depth and total slab height — the SIDE WALL, which is the whole
 * reason a note reads as an object rather than a decal.
 *
 * Named, because the note's fragment shader has to know where the top face stops
 * and the wall begins: it separates them on `position.y / TILE_HEIGHT`, and the
 * wall is deliberately much darker than the face (see `buildNotes`). While the
 * two zones were separated on the *footprint* metric instead, every wall
 * fragment fell inside the "rim" band and rendered at 1.3x — measured on the
 * shipped frame, the tile's front wall read relative luminance 0.800 against a
 * top face of 0.584, i.e. lit from below. The reference does the opposite by a
 * factor of three (top face 0.240, wall 0.082).
 *
 * **0.44 total, and the third of the note's aspect it buys is deliberate.** A
 * slab's on-screen aspect is `(depth/width) * sin(view) + (height/width) *
 * cos(view)`; the first term is capped (see `TILE_DEPTH`) and the second is
 * almost exactly constant with distance, because a vertical world segment
 * projects at the same scale as a horizontal one at the same depth. That makes
 * the wall the ONE lever that raises a far note's aspect without touching a near
 * one's — which is what the measurement asked for: our silhouettes ran 0.79 /
 * 0.96 / 1.10 against the reference's 1.12 / 1.29 / 1.54, a near-constant deficit
 * of 0.35 in h:w at every depth. 0.44/1.24 = 0.35. The camera pays the rest.
 *
 * At 0.30 the wall was also simply not there to be seen: profiled on the shipped
 * frame, the far note went face L33 -> L41 -> deck L21 with no wall band at all,
 * where the reference's far note still shows 30px of wall (L27 then L16 at S100)
 * before its deck. It is 60px at the crest now and 79px at the row.
 *
 * **0.38 total, and this is the floor rather than a preference — the wall cannot
 * reach the reference's share without the note going wider than tall.** Profiled
 * on the reference's mid note the wall is 30px of a 299px silhouette (10.0%):
 * face L55 -> a 2px specular lip at L72.7 -> wall L26.7 S78 -> L15.5 S92 -> a
 * contact contour at L11.8 -> deck L17.6. Ours ran 28-33%. But the two levers
 * that would buy the height back are both spent: `TILE_DEPTH` is capped at 3.0
 * by hard's own note spacing (see above), and the wall is what carries the
 * crest aspect over 1:1 at all — projected through the real rig, 0.48 gives
 * 1:1.09 at the spawn point and 0.30 gives **1:0.96**, i.e. a note WIDER than
 * tall, which is an owner gate. The remaining difference is our runway: the
 * reference shows ~30% of its frame as approach and we show 55%, so our far
 * notes are foreshortened about 2.4x harder and their faces cannot carry the
 * aspect the way its do.
 *
 * What closes the gap instead is that the wall is now *graded* rather than a
 * flat fill (see `buildNotes`) — the dark band a profile actually measures is
 * its lower half, so the silhouette stays legal while the note stops reading as
 * a tile glued to a block. 0.38 keeps the crest at 1:1.02.
 */
const TILE_EXTRUDE = 0.28;
const TILE_BEVEL_THICKNESS = 0.05;
/**
 * Where the straight side wall stops and the top chamfer begins, as a fraction
 * of the slab's total height.
 */
const TILE_HEIGHT = TILE_EXTRUDE + TILE_BEVEL_THICKNESS * 2;
/**
 * Where the straight side wall stops and the top chamfer begins, as a fraction
 * of the slab's total height.
 *
 * Derived, not typed: the slab is `bevelThickness` of bottom chamfer, then the
 * straight wall, then the same again as the top chamfer. The note's fragment
 * shader splits face from wall on it, and typing the number is how it drifted
 * last time — the crossover sat halfway up the straight wall, so the wall's
 * upper half rendered as face and the profile came out as a soft ramp instead
 * of an edge.
 */
const TOP_SPLIT = 1 - TILE_BEVEL_THICKNESS / TILE_HEIGHT;
/**
 * The receptor pad's footprint. **The tile's outer width equals this**, by
 * construction — see `TILE_WIDTH`.
 *
 * 0.969 of a lane, measured off the reference rather than estimated from it.
 * Scanning its pad row for the eight bright-neutral rim runs, at each pad's
 * WIDEST row so the corner radius does not cut the reading, gives four pads
 * 243px wide on a 252px lane pitch — **96.4%**. Ours was 1.16 (90.6% nominal,
 * 87.5% measured), and since the tile's outer width is defined to equal this,
 * every note inherited that shortfall: the whole board read one notch narrower
 * than the reference's at the one row where the player is looking hardest.
 *
 * Nominal runs a little above the measured figure because the rim texture's
 * bright band stops short of its quad — 1.24 measures ~94.5%. The groove is still
 * what keeps "neighbouring pads must not touch or merge glows" true: 0.04 units
 * is ~9 device px at the row on a 390x844 phone at DPR 3, against the reference's
 * own 9px at its scale.
 *
 * **Widening this is only free while the FOV's height requirement binds.** It
 * feeds `requiredHalfWidth`, and if `fromWidth` crosses `fromHeight` the camera
 * opens up and cancels the change (the trap already recorded on that margin).
 * Checked: at 4 lanes, 390x844, fromWidth goes 18.63 -> 18.84 deg against a
 * height requirement of 19.28, so the composition is untouched. Anything past
 * ~1.30 crosses over.
 */
const HIT_ZONE_WIDTH = 0.93;
/**
 * Pad depth — the slab's length up-lane, centred on the judgement moment.
 *
 * 3.5, nearly triple. A receptor was a 105px-tall hollow outline, 4.1% of a
 * portrait frame, against the reference's 351px solid slot at 15.0%; a note
 * cannot visibly drop INTO something with no depth, it can only pass over an
 * outline. The pad is now a rounded slab with a dark textured face, a graded
 * chrome bezel and ONE bright dash across its midline (see `makePadTexture` /
 * `makeRimTexture`), and the tile is 2.0 deep against it — 57% of the pad,
 * against the reference's 56%.
 *
 * Centred on z = 0 so the dash lands exactly on the judged moment. That means the
 * slab reaches 1.75 units in FRONT of the row, which is deliberate: the reference
 * pads extend as far below their dash as above it, and it is what fills the
 * near field a note passes through.
 */
const HIT_ZONE_DEPTH = 3.5;
/**
 * World-space distance from the spawn point to the hit line.
 *
 * 23, not 18, and the reason is measurable: the approach runway has to be at
 * least 55% of the frame's height for a player to read a chart (the topmost
 * visible note against the receptor row). At 18 the whole playfield spanned
 * 50.9% of a 390x844 frame and the topmost note only 47% — no note placement
 * could clear the bar, because the *geometry* stopped too near.
 *
 * At 21 it measured 54.1%, still short, and **this is the only lever that moves
 * it**: the spawn point is `-HIGHWAY_LENGTH`, so lengthening the track is what
 * puts the first visible tile further from the camera and therefore higher up the
 * frame. Two obvious alternatives do not work and were measured: `CURVE_HEIGHT`
 * is into diminishing returns (1.0 -> 1.25 bought ~3px, because the far end is
 * already asymptotic to the on-screen horizon), and `HIT_RAISE_FRACTION` is a
 * pure translation — it moves the row and the notes by the same amount, so the
 * distance between them is exactly unchanged.
 *
 * It costs on-screen scroll speed: `approachSec` is unchanged, so a note covers
 * more world units — and more screen — in the same time. That is the trade, and
 * it is the right one: judgement timing is untouched and the chart becomes
 * readable further out.
 *
 * 26, not 23. At 23 the *geometry* allowed 58% but only for a note within 15% of
 * the spawn point; a note at 80% of the approach measured 53.6%, so whether the
 * gate passed came down to whether the chart happened to have a note that far out
 * at the sampled instant. Length shifts the whole curve: at 26 the same 80%
 * position measures 56%, so the gate stops depending on chart density.
 *
 * **25 under the flat rig, and the 55% floor was re-measured rather than
 * inherited.** Every number above was read against the old wide-angle camera, and
 * a longer lens changes all of them: length now buys runway *and* costs
 * convergence (it is the `L` in `d_near / (d_near + L)`), where before it was
 * nearly free. Measured at 390x844, 4 lanes, by projecting the rig below through
 * a `THREE.PerspectiveCamera` set up exactly as `fovFor` and `resize` do: a note
 * at 80% of the approach sits **59.4%** of the frame above the receptor row, and
 * a note at the spawn point 68%. 26 buys another point of runway and costs a
 * point of convergence; 25 is where the two stop trading evenly.
 */
const HIGHWAY_LENGTH = 25;

/** World units between two deck rungs. Must stay in step with the shader's `2.25`. */
export const DECK_RUNG_PERIOD = 2.25;
/**
 * How fast the ground grid runs relative to the deck. The ground is further
 * away and is meant to read as the same sheet sliding under a longer lever
 * arm, not as a second surface with its own agenda.
 */
export const GROUND_SCROLL_FRACTION = 0.5;

/**
 * How fast a note travels down the highway, in world units per second.
 *
 * A note covers the whole runway in exactly `approachSec`, and `approachSec`
 * already carries the player's scroll-speed setting (`approachSecFor`), so
 * anything derived from this follows that setting for free — and nothing here
 * needs to resolve it per frame.
 */
export function noteWorldSpeed(approachSec: number): number {
  return HIGHWAY_LENGTH / approachSec;
}

/**
 * Phase of the deck's scrolling markings, in rung periods, at a given song time.
 *
 * **This is the "moving but not in motion" defect, and it is arithmetic rather
 * than taste.** The floor drove its rungs from a hardcoded `-songTime * 1.6`
 * periods per second, i.e. 3.6 world units per second. A note on hard travels
 * `25 / 1.3` = **19.2 world units per second**. So the one scrolling marking on
 * the track surface crawled at **a fifth of the speed of the objects sliding
 * over it** — and, because the sign was inverted against the floor's uv (v
 * increases *away* from the camera, which `toward` in the fragment shader
 * already documents), it crawled in the **opposite direction**, up the track.
 * The ground plane underneath, whose `uScroll` had the other sign, was
 * meanwhile running correctly toward the player. Two surfaces sliding apart
 * under notes moving five times faster than either: there is no consistent
 * velocity for the eye to read, so the notes translate and the world does not.
 *
 * Deriving it from `noteWorldSpeed` makes the deck, the ground and the notes
 * one rigid sheet by construction, at any difficulty and any scroll-speed
 * setting, rather than by three constants agreeing until someone retunes one.
 *
 * Positive and increasing: the shader samples `fract(v * N + phase)`, so a
 * crest sits at `v = (c - phase) / N`, and `v` must *fall* for the crest to
 * travel toward the camera.
 */
export function deckScrollPhase(songTime: number, approachSec: number): number {
  return (songTime * noteWorldSpeed(approachSec)) / DECK_RUNG_PERIOD;
}

/**
 * The ground grid's scroll offset, in world units — it samples world distance
 * directly rather than periods. Same direction as the deck by construction.
 */
export function groundScrollWorld(songTime: number, approachSec: number): number {
  return songTime * noteWorldSpeed(approachSec) * GROUND_SCROLL_FRACTION;
}

/**
 * Rattle frequencies for the hit shake, in Hz — one per axis, deliberately
 * incommensurate so the camera traces a Lissajous figure rather than sliding
 * back and forth along a single diagonal.
 *
 * **Tuned against frame coherence, not against how "fast" a rattle should
 * feel.** 13/17Hz was tried first and is wrong: at 120Hz the faster axis moves
 * 86% of its peak-to-peak span between consecutive frames, which is barely
 * better than the noise it replaces — a vibration that fast is not a trajectory
 * the eye can track, it is a shimmer. These sit at ~7 and ~10 samples per cycle
 * on the S25 and ~3.5/5 at 60Hz, which is a curve rather than a scatter.
 *
 * They are also the right *duration*. `shake` bleeds off at 2.6/sec and the
 * offset carries a squared falloff, so a capped burst is visually spent in
 * ~0.08s — about one cycle at this rate. That is a kick and a recoil, which is
 * what an impact is, rather than a sustained buzz on the whole playfield.
 */
const SHAKE_HZ_X = 8.5;
const SHAKE_HZ_Y = 11.5;
/**
 * Peak match against the white noise this replaces. `(Math.random() - 0.5)`
 * spans ±0.5; a sine spans ±1, so half the gain reproduces the old maximum
 * excursion exactly. The impact language — how hard a hit kicks, how the combo
 * scales it, how fast it decays — is untouched; only the *waveform* changes.
 */
const SHAKE_PEAK_MATCH = 0.5;

/**
 * The camera's shake offset, in world units, at a given magnitude and time.
 *
 * **This is the intermittent stutter, and it is the only frame-incoherent term
 * left in the scene.** Everything a player watches move is drawn from song
 * time — note z, the deck scroll, the hold bodies — and song time is smoothed
 * by `RenderClock`, which simulates clean at every plausible refresh-rate /
 * audio-quantum ratio (zero frozen frames, <=11% worst per-frame velocity error
 * at any granularity an Android audio path produces). So the notes' own motion
 * is not the defect. But the *camera* moves too, and every object in frame
 * inherits that motion — and the shake term used to be
 * `(Math.random() - 0.5) * shake * shake * 1.6`, resampled **every frame**.
 *
 * White noise has no correlation between consecutive samples, which is the
 * literal definition of the thing the eye reads as stutter: the board is in a
 * new random place each frame instead of travelling to it. At the shipped cap
 * (`shake` 0.42) the peak excursion is 0.141 world units, and a lane is 1.05 —
 * so the whole playfield jumps by up to ~13% of a lane, frame to frame, at
 * random. Measured against the projection in a 390px portrait capture that is
 * roughly +/-30 device px of pure noise.
 *
 * **And it is gated exactly where the owner reports it.** `shake` is bumped per
 * hit by `base * (0.6 + min(1, combo/40))` and bleeds off at 2.6/sec, so it
 * only sustains once hits are dense *and* the combo is long — "at some point in
 * game", with the frame rate reading perfectly fine the whole time, which is
 * the report.
 *
 * A pair of decaying sinusoids fixes it without touching the feel: the peak
 * excursion, the combo scaling, the squared falloff and the decay rate are all
 * unchanged, so a hit kicks exactly as hard as it did. What changes is that
 * consecutive frames are now *near* each other, so the kick reads as a rattle
 * the camera travels through rather than as a position that is re-rolled 120
 * times a second. It is also frame-rate independent for the first time: white
 * noise at 120Hz has twice the bandwidth of white noise at 60Hz, so the effect
 * was literally a different effect on a different device.
 *
 * Pure and three-free so it can be pinned by a test — the same reason
 * `holdSpan` and `deckScrollPhase` are exported.
 *
 * @param shake magnitude, 0..0.42; the squared falloff is applied here
 * @param timeSec accumulated wall seconds (NOT song time — a rattle is a
 *   physical event in the room, not a musical one, and must not stretch under a
 *   speed modifier)
 * @param phase randomised once per fresh burst so repeated hits do not rattle
 *   in lockstep
 */
export function shakeOffset(
  shake: number,
  timeSec: number,
  phase: number,
): { x: number; y: number } {
  const s = shake * shake;
  const w = timeSec * Math.PI * 2;
  return {
    x: Math.sin(w * SHAKE_HZ_X + phase) * s * 1.6 * SHAKE_PEAK_MATCH,
    y: Math.sin(w * SHAKE_HZ_Y + phase * 2.3) * s * 1.2 * SHAKE_PEAK_MATCH,
  };
}

/**
 * The near field — everything between the receptors and the bottom of the frame.
 *
 * This region was the game's worst visual defect and all three numbers below
 * exist to fix one half of it. On a portrait phone `setViewOffset` raises the hit
 * line to ~74% down the screen, which reveals ~1.3 world units of track *in
 * front of* the receptors that the desktop framing had always cropped. Filled
 * with lane separators, scrolling rungs and a second bright bar, it read as the
 * playfield rendering twice.
 *
 * The rule, refined against the reference: **no SCROLLING marking exists past
 * z = 0.** The scrolling rungs and the accent sill stop at the row — those are
 * what made the near field read as the playfield drawn twice. The deck itself,
 * its weave and its lane grooves carry straight on to the bottom edge, because
 * that is what the reference does and because stopping them left the bottom 13%
 * of the frame measurably empty (nothing above 0.013 relative luminance, against
 * a reference that still resolves four lane runs and a note at 85% of its frame).
 */
/**
 * Where the track surface's near edge sits. Must clear the bottom of the frame at
 * every shipped aspect, or the raw cut edge of the plane shows as a horizontal
 * seam across the apron.
 *
 * 9, not 4. The flat rig looks down a long lens, so the near field is far less
 * foreshortened and z=4 now projects to 93% of the frame height — inside it.
 * Measured by projecting the plane's near edge: at 9 it lands at 125% (4
 * lanes) and 111% (5 lanes, the widest FOV and therefore the worst case).
 */
const FLOOR_NEAR_Z = 9;
/**
 * Depth of the connector band, centred on z = 0.
 *
 * **No longer derived from `HIT_ZONE_DEPTH`.** It was `HIT_ZONE_DEPTH * 1.01`
 * back when the pad was a 1.26-deep outline and band-plus-socket wanted to read
 * as one block. The pad is a 3.5-deep slab now and carries its own timing dash,
 * so all this has left to do is join the four dashes across the gaps between
 * pads; scaling it with the slab would lay a 3.5-deep additive haze over the one
 * region that has to stay dark.
 */
const HIT_BAND_DEPTH = 1.2;
/**
 * Where the track's SCROLLING markings stop, in world units past the hit line.
 *
 * The rungs and the accent sill; the deck, its weave and its lane grooves run on
 * past this. See the near-field note above.
 */
const FLOOR_APRON_FADE = 0.3;
/**
 * How far past the hit line a note has faded to nothing.
 *
 * 1.5, not 0.5. A note passing the receptors and continuing toward the camera is
 * NORMAL — the reference shows one large and partly off-screen at the bottom of
 * two of its four frames, and it reads fine. What was actually wrong when this
 * was cut to 0.5 was a note at full brightness sitting *below* the moment it
 * marked, on a row that had no pad under it. The pad is now 3.5 deep and reaches
 * 1.75 in front of the line, so an exiting tile is inside its own slot the whole
 * way; `NOTE_EXIT_POWER` still takes it down fast, so it is dim well before it
 * leaves.
 *
 * The alpha ramp reaches exactly zero here and the hard cull is at the same
 * number, so a note is never *both* invisible and still writing depth — a ghost
 * tile in front of the impact particles would clip them out of their own burst.
 */
const NOTE_EXIT_Z = 3.4;
/**
 * How far past the line a tile stays at FULL opacity before the ramp starts.
 *
 * A ramp that begins at the line is the wrong shape, and it looked it: at half
 * alpha an emissive slab over the pad's dark face is neither a note nor a
 * target — it reads as dirty glass laid across the row. The reference's exiting
 * notes are fully opaque objects that simply leave the frame. So the tile holds
 * its own colour until it has cleared the dash and the pad's near lip, and only
 * then fades, off the bottom of the frame.
 *
 * 2.0, raised with `TILE_DEPTH`. At 1.15 the hold ended while a 2.7-deep tile was
 * still lying across its own pad, and two half-faded slabs over the receptor row
 * is precisely the dirty-glass failure above. The pad reaches z = 1.75, which
 * projects to 85.5% of the frame's height, so a tile that stays opaque to z = 2.0
 * has cleared the whole row before it starts to go.
 */
/*
 * **2.9, and it is the fix for "the largest nearest object is the dullest".** At
 * 2.0 a tile spent the last 1.4 units of its life ramping to zero alpha, which
 * on a portrait frame is the bottom fifth of the screen — so the note nearest
 * the camera rendered as a washed translucent ghost with the pad showing through
 * it, exactly the desaturation the brief forbids. The reference's exiting notes
 * are fully opaque objects that simply leave the frame. 2.9 of a 3.4 cull holds
 * full chroma essentially all the way out and leaves half a unit of ramp so the
 * tile still does not pop.
 */
const NOTE_EXIT_HOLD = 2.9;

/**
 * How far up the approach a note is drawn at all, as a fraction of it.
 *
 * **The spawn point has to be on LEGIBLE track, and it was not.** The floor plane
 * reaches z = -29 and projects to 3.6% of the frame's height, but measured down
 * its centre the deck only rises out of the black at about 17%: 0.005 relative
 * luminance at y = 0.176 against 0.037 at y = 0.249 and 0.047 mid-track. Notes
 * spawned at z = -25, which projects to 6.4% — a full tenth of the frame ABOVE
 * anything the player can see as track. A tile there, and the soft rounded-rect
 * halo that sits ~2.5% of the frame below it, read exactly as the critique
 * described them: "a stray rounded-rect quad floating in the black above the
 * track's far end", aligned with no visible lane and outside the playfield
 * silhouette. It was a note, and the void it hung in was the defect.
 *
 * **0.66 under the steeper rig, re-measured rather than inherited.** The rule is
 * unchanged and so is the reason for it; what moved is where the legible track
 * starts. Sampling a matched patch down one lane, the deck holds ~50 (value) as
 * far out as z = -14.5 and has fallen to 13 by z = -20 — so under the new camera
 * a note at 0.76 (z = -19) spawns in the dead band the old number was chosen to
 * clear, and it measured L5 there. 0.66 puts the spawn at z = -16.5, whose tile
 * top lands at ~16% of the frame on deck reading ~45, and the runway still
 * measures 60.4% against the 55% floor. (`instanceNear`'s exposure lift in
 * `buildNotes` covers what is left of the falloff.)
 *
 * The reasoning that produced the old figure, for the record: **The runway gate
 * survives it, measured rather than assumed:** CLAUDE.md requires the topmost visible note to sit at least 55% of
 * the frame above the receptor row; the row's dash measures 76.0% and a tile at
 * the spawn point 17.9%, so the geometry allows **58.1%**. As CLAUDE.md already
 * records for HIGHWAY_LENGTH, what a given FRAME measures still depends on whether
 * the chart happens to place a note near the spawn — the shipped capture reads
 * 54.7% because its topmost note sits at 66% of the approach — and that is a
 * property of the chart, not of the rig. `HIGHWAY_LENGTH` is untouched, so the
 * world geometry, the scroll speed and the judgement window are all exactly as
 * they were; this only stops drawing the part of the runway that had nothing
 * under it.
 *
 * **0.68 under the flattened (24, 39) rig, and it had to be re-measured rather
 * than carried over.**
 * The rule is unchanged — a note must spawn over track the player can SEE — and
 * so is the way of finding the number: shoot a frame, read where the deck stops
 * reading as a surface, and put the spawn under that. What moved is the mapping
 * from progress to screen, and it moved a long way: the long lens is close to
 * linear in z, so the same 0.66 that put the old rig's spawn at 17.9% of the
 * frame puts the new one at **9.6%** — a tile hanging in the black scrim above
 * the deck with its glow quad above *that*, which is exactly the "stray
 * rounded-rect quad floating above the track's far end" this constant exists to
 * prevent. Projecting the rig, screen height 0.28 of the frame is z = -17, i.e.
 * 0.68 of the approach, and a shot at 0.85 confirmed the failure directly.
 *
 * **The deck stops reading at about z = -18 and that is not geometry.** The floor
 * plane runs to z = -29 and its far dissolve does not start until v = 0.94
 * (z = -27), so there is solid, full-alpha surface a further ten units past where
 * the eye loses it — the deck is simply a 0.024-luminance charcoal by design (see
 * `DECK_LINEAR`) and the frame's top is dark. Do not "fix" that by lifting the
 * deck's far exposure: the gate this rebuild is measured against is that nothing
 * on the track competes with a note, and the runway does not need it — 0.68
 * measures 58% against a 55% floor.
 *
 * **0.60 once the wave deck exists.** The rule ("spawn over track the player can
 * SEE") acquired a second clamp: the HUD's album disc and mirrored spectrum now
 * occupy the top band of the frame, and a note spawning behind that row entered
 * the picture already sliced — its top face cut on a dead-straight horizontal at
 * the deck's lower edge, which reads as broken geometry rather than as a spawn
 * plane. Pulling the spawn point down the runway is the fix that costs nothing
 * the player can use: those first units of approach were never legible anyway.
 */
/*
 * **0.64 under the (15, 24) rig — it moves with the camera, see CAMERA_HEIGHT.**
 * The shorter lens spends frame height on convergence, so the runway (topmost
 * visible note to the receptor row) falls to 52.4% at 0.60. 0.66 restores 56.0%,
 * which is the documented floor, and it moves the spawn point up only 2.4% of
 * the frame — well inside the band the HUD disc already overlaps.
 */
const NOTE_SPAWN_PROGRESS = 0.66;

/**
 * Length of the floor plane, near edge to far edge.
 *
 * Derived, because it has to contain the whole approach *plus* the apron in
 * front of it: the near edge sits at `FLOOR_NEAR_Z` and notes spawn at
 * `-HIGHWAY_LENGTH`, so anything shorter than the sum leaves the topmost note
 * with no track under it. It used to be written as the literal
 * `HIGHWAY_LENGTH + 7` in four places, which was true only while `FLOOR_NEAR_Z`
 * was 4 — raising the near edge for the flat rig silently pulled the far edge in
 * front of the spawn point. The extra 4 is the dissolve at the far end.
 */
const FLOOR_LENGTH = HIGHWAY_LENGTH + FLOOR_NEAR_Z + 4;

/**
 * The track surface's own tone, as a LINEAR value — near-neutral charcoal.
 *
 * The single number the "dark textured deck" rebuild is measured against. The
 * reference frames' track reads #2b2b2b at HSL saturation 0.1-0.6%, i.e. 0.024
 * relative luminance and no chroma worth the name; ours measured saturation
 * 88-98% at up to 0.20 luminance, because the lane tint was painted across the
 * whole lane (`ambient * separator * 0.30`, where `separator` was 1 over the lane
 * body and 0 only in a hairline at its edge — the term reads like a lane
 * *divider* and was in fact the lane *fill*).
 *
 * Written straight into the fragment as an almost-opaque grey rather than
 * accumulated out of a dozen scalars behind a 0.62 alpha, so what the surface
 * measures is what this constant says.
 *
 * **0.072 is not 0.024, and the gap is the tone curve's black point.** PBR
 * Neutral subtracts `x - 6.25x^2` for any channel under 0.08, so for a neutral
 * colour the whole pipeline collapses to `out = 6.25 * c^2`: a deck authored at
 * linear 0.026 renders 0.0042 relative luminance, an eighth of what it says, and
 * comes out black rather than charcoal. Solved rather than guessed —
 * invert `out = 6.25 * c^2` rather than eyeballing it. Anything else in this file
 * written as a small linear constant is subject to the same squashing; do not
 * "correct" one of them by eye.
 *
 * **0.090, re-measured against the reference rather than against a recalled
 * number.** The comment above quoted the reference deck at 0.024 relative
 * luminance; sampling all four frames with the same probe puts mid-track at
 * **0.0416-0.0441** (#393939-#3b3b3b, HSL saturation 0.2-0.3%), and 0.072 landed
 * ours at 0.0274 — a third short, which is most of why the frame measured
 * 0.0344 mean luminance against the reference's 0.0934. The hue reading was
 * right and the level was not.
 *
 * **0.070, taken down as `DECK_EDGE_FALLOFF` was flattened, and the two are one
 * change.** With a 2.6x lateral falloff the deck's *centre* was much brighter
 * than its edges, so the level that read correctly on average read too bright
 * down the middle: HSL L ran 19.8 (outer lanes) to 29.2 (centre line) against a
 * reference that is flat at L22.0-23.5. Removing the falloff without lowering
 * the tone would have taken the whole board to the centre's value. Measured on
 * the same probe, 0.070 lands the flat deck at ~L23.
 */
/*
 * **0.040, and the previous 0.07 was measured against the wrong thing.** Sampled
 * on the shipped capture the deck ran 55-70 on the 0-255 display scale where the
 * reference's runs ~20: our gold notes had barely any figure/ground left and the
 * lane separators were competing with them for the eye. Solved rather than
 * eyeballed, through the same inversion the note above describes — display
 * value = sRGB(6.25 c^2), so sRGB 0.086 (22/255) needs c = sqrt(0.00796/6.25) =
 * 0.036. Rounded up a notch so the weave still has something to modulate.
 */
/*
 * **0.085, and the 0.040 above was measured against the wrong reference read.**
 *
 * At 0.040 the deck sampled 24-26 on the 0-255 display scale, i.e. functionally
 * black: the notes floated in a void with no surface under them, which is the
 * single loudest "amateur" tell after the receptor rim. Re-measured on the
 * reference frames the deck runs **55-59**, not the ~20 the note above quotes —
 * that earlier figure came from the reference's *apron* (the near field in front
 * of the receptor row), which really is near-black and really is a quarter of the
 * playfield's value. The two are different surfaces and the apron ratio is
 * preserved separately, below.
 *
 * The inversion is the same one: display = sRGB(6.25 c^2), so sRGB 0.223
 * (57/255) needs 6.25 c^2 = 0.041, c = 0.081 before the longitudinal term, which
 * averages ~0.9. Do NOT read this as licence to brighten the ground GRID beside
 * the track — that is scenery and stays at 0.15 (CLAUDE.md). The deck is the
 * surface the notes travel on, and the reference lifts it precisely so the notes
 * have something to be brighter *than*.
 */
const DECK_LINEAR = 0.081;

/**
 * Cross-track lighting: how much of the deck's tone survives at the board's outer
 * edge, as a fraction of its value on the centre line.
 *
 * The deck had NO lateral gradient at all — all four lanes measured 0.0296 at
 * mid-track, identical to four decimal places — and a surface with zero
 * cross-track falloff is a printed texture rather than something under a lamp.
 * The references bracket the answer rather than agreeing on it: the cyan frame is
 * nearly flat (0.0416/0.0441/0.0441/0.0417, 1.06 centre-to-edge) and the purple
 * one falls 2.3x. This sits between them.
 *
 * A LINEAR fraction, so the quadratic black point squares it on the way to the
 * screen: 0.62 linear read as ~2.6x centre-to-edge across the whole plane and
 * ~1.5x between an inner lane and an outer one. It multiplies the neutral tone,
 * so it can never introduce chroma.
 *
 * **0.95, and 0.62 was simply too much light for one lamp to be believable.**
 * Measured across one constant-depth row, ours ran L16.3 at x=180 to L28.8 at
 * x=560 — a 12.5 L spread, 77% of the deck's own value — where the reference
 * holds 1.1-1.6 L across the same kind of row at three separate depths. The
 * visible result was two broad grey glare bands running down the board, and it
 * is most of what made the whole surface read as a fog bank rather than as a
 * sharply-lit machined deck: nothing appeared to sit ON the surface because the
 * surface had no constant tone to sit on. Depth alone drives brightness now
 * (the longitudinal term below); the lateral term is a hint, not a wash.
 * 0.95 linear is ~1.10x centre-to-edge across the plane, i.e. ~1.4 L.
 */
const DECK_EDGE_FALLOFF = 0.95;

/**
 * How far the deck extends past the outermost lane, in world units.
 *
 * New. The deck used to stop exactly at `halfWidth`, a fifteenth of a lane
 * outside the outer pad's edge, so there was no surface for the rails to sit on
 * and the board's silhouette was the pads' own. The reference carries a margin
 * with the accent rail on it. Small (a tenth of a lane) because `fovFor` sizes
 * the frame to the *receptor row*, and every unit here is deck that runs off the
 * bottom corners rather than board the player can use.
 */
const FLOOR_MARGIN = 0.12;

/**
 * The deck's weave, as diamond cells per lane across and cells over the whole
 * plane's length.
 *
 * Sized so a cell is roughly square *on screen at the receptor row*, not in world
 * space: the track is foreshortened, so a world-square cell renders as a wide
 * flat lozenge and reads as horizontal banding rather than as a twill. At 5 across
 * a lane and 56 down the plane the cell measures ~40 x 34 device px at the row on
 * a 390x844 phone at DPR 3 — fine enough to be material, coarse enough to survive
 * the downsample a critic squints at.
 */
const FLOOR_WEAVE_ACROSS = 8;
/**
 * Weave cells down the plane — now a RATE at the receptor row, not a total.
 *
 * It used to be a count over the whole plane, i.e. a period constant in the
 * plane's own v. That is constant in *world* space and therefore collapses in
 * screen space: v is linear in world z, screen position is not, so by mid-track
 * the cells were under a pixel and averaged straight back out. Measured, our
 * mid-track deck carried high-pass energy 0.25-0.29 on the 0-255 luminance scale
 * against the reference's 1.26 at the same depth — no material at all across the
 * band where most of the board's area lives, while the near field read 2.98
 * against 3.18, i.e. at parity. The pattern was not too faint; it was being
 * resolved away.
 *
 * `weavePhase` (in `buildFloor`) turns this into a hyperbolic coordinate whose
 * SCREEN period is constant, so the same figure now means "cells per unit v at
 * the hit line" and the weave survives to the vanishing point the way the
 * reference's does.
 *
 * 100 across with `FLOOR_WEAVE_ACROSS` at 8, which puts the cell at ~34 x 35
 * device px at the row — the fine twill the brief asks for. At 56/5 the
 * constant-screen-period version came out as a ~70px ripple, which reads as
 * unevenness in the surface rather than as a material.
 */
const FLOOR_WEAVE_ALONG = 100;
/**
 * Weave contrast, as a fraction of the deck tone.
 *
 * **0.032, a third of what it was, and this is a measured number.** Standard
 * deviation of relative luminance over 41x41 patches, normalised by the patch
 * mean: at 0.10 ours read 9.7-15.6% against the reference deck's 1.9-3.8%. At
 * that amplitude the diamond stops being a material property and becomes the
 * primary event on the surface — it reads as a speaker grille, and it dithers in
 * the mid-track where it should already be dissolving. The tone curve is
 * quadratic down here (see `DECK_LINEAR`), so a linear swing arrives on screen
 * roughly doubled; 0.032 lands near 3%.
 *
 * It is a multiplier on a NEUTRAL tone, so the texture can never add chroma
 * however it is retuned.
 *
 * **0.058, and both earlier readings of this were taken over the wrong patch.**
 * Standard deviation normalised by the patch mean picks up the deck's own
 * longitudinal gradient as well as its texture (it reported ours at 9.7-15.6%
 * against a reference at 1.9-3.8%); high-pass energy over a patch that crosses a
 * rail or a lane groove picks up the groove (it reported the reference at 3.133
 * against our 0.101, i.e. "31x the texture energy"). Neither is a measurement of
 * a weave.
 *
 * Read properly — a raw luminance scan across 170px of clean deck, no groove in
 * frame — **the reference's mid-track deck is FLAT**: L 23.1-23.5, a ripple of
 * ±0.4, which is JPEG grain. Ours ripples 21-28 over the same span at 0.058. So
 * this is already at the ceiling rather than under it, and it is deliberately
 * not pushed further: the 0.10 the same note records as reading like a speaker
 * grille is only a little above where it now sits. What the raise from 0.032
 * bought is a weave the eye can find at the near end, not a number.
 *
 * **0.14 — and BOTH earlier readings of the reference were contaminated, in
 * opposite directions. Measure a clean patch, and say which patch.**
 *
 * The "reference mid-track deck is FLAT" note above is right about the deck and
 * was read off one column. The later claim that the reference carries 1.26-2.87
 * high-pass energy mid-track against our 0.21-0.31 is measured over patches that
 * contain a NOTE — at (594,1287) the cyan frame's mid note spans x540-772,
 * y1237-1530, so that reading is the note's own emblem and rim, not a weave.
 *
 * Read over patches of genuinely clean deck in both frames, the reference runs
 * **0.46-0.86** and ours ran 0.16-0.55; down a clean column its deck holds
 * L22.4 within +-0.4 (which at that level is JPEG chroma noise) where ours
 * ripples about +-1. So the reference's own texture is faint, our weave was
 * already the stronger signal of the two, and the honest target is "a fine
 * material the eye can find", not a number four times what the reference has.
 * 0.14 lands our clean-patch high-pass at the top of the reference's range with
 * a cell fine enough (see `FLOOR_WEAVE_ALONG`) to read as twill.
 *
 * It is still a multiplier on a NEUTRAL tone, so the texture can never add
 * chroma however it is retuned.
 */
/*
 * 0.055, halved with the deck's tone. The amplitude is a FRACTION of the deck, so
 * halving the base already halves the absolute swing — but the reported defect
 * was the weave's *contrast*, i.e. the swing relative to the surface, which reads
 * as tiling noise once the surface is this dark. The reference's near-black deck
 * carries only a soft vertical sheen at this scale.
 */
const FLOOR_WEAVE_AMOUNT = 0.055;
/**
 * How far up the approach the accent sill reaches, as a fraction of it.
 *
 * The one place the track is allowed any of the song's colour. Kept to the last
 * eighth deliberately: "mid-track saturation" is what the composition gate
 * samples, and a sill that reached the middle of the runway would be the old lane
 * fill with a gentler falloff.
 */
const FLOOR_SILL_SPAN = 0.13;

/**
 * How far the far end of the highway lifts, in world units.
 *
 * The track is not a flat plane: it bends upward with distance, so it reads as
 * a slope cresting away from the player and rolling down toward them. Notes
 * ride the same curve, which means they travel a visible arc down the screen
 * instead of a dead-straight line, and the far end compresses into a narrow
 * ribbon before the haze takes it.
 *
 * This is the one number to change if the curve feels wrong. Much past the
 * camera height (6.2) the far end rises to eye level and folds over on itself.
 *
 * Doubled from 0.5 as part of the runway-length fix: lifting the far end is what
 * raises the track's vanishing point *on screen* without moving the camera, and
 * the camera cannot move — its pitch is what puts the receptor row 25% up from
 * the bottom, where a thumb is not covering it.
 *
 * 1.25, not 1.0: measured at 390x844 the topmost note sat 54.2% of the frame's
 * height above the receptor row against a 55% floor — 15px short, which is a
 * readability gate failing by a rounding error. The extra quarter unit buys ~25px
 * and costs nothing else. The far end is still 6.25 units below eye level (7.5),
 * nowhere near folding over on itself.
 *
 * 1.3 under the flat rig. The lift is *more* visible through a long lens looking
 * down at 28 degrees than it was through a wide one at 26, so the same world
 * height reads as a steeper crest; and it is now a direct cost on the runway
 * measurement, because it pushes the far end up the frame faster than it pushes
 * the notes. Re-measured, not inherited.
 */
const CURVE_HEIGHT = 1.3;

/**
 * Falloff of the lift. Must stay above 1 so the slope is still zero at the hit
 * line — that is what keeps the curve from meeting the receptors at a crease.
 *
 * Below 2 on purpose. A square puts most of its displacement in the last few
 * metres, which is precisely where the far fade swallows it: the curve is
 * mathematically large and visually absent. Pulling the exponent down moves the
 * bend into the mid-field, where the player is actually looking, and roughly
 * doubles the lift halfway down the track for the same height at the end.
 */
const CURVE_POWER = 1.6;

/** Vertical lift of the track surface at a given z. Flat at the hit line. */
function curveLift(z: number): number {
  const t = Math.min(1, Math.max(0, -z / HIGHWAY_LENGTH));
  return CURVE_HEIGHT * Math.pow(t, CURVE_POWER);
}

/** d(lift)/dz — used to lay flat things (the note halos) along the slope. */
function curveSlope(z: number): number {
  const t = Math.min(1, Math.max(0, -z / HIGHWAY_LENGTH));
  return (-CURVE_HEIGHT * CURVE_POWER * Math.pow(t, CURVE_POWER - 1)) / HIGHWAY_LENGTH;
}

/**
 * Fraction of full track width remaining at the far end.
 *
 * **0.98 — all but off.** It was 0.42, i.e. the track threw away more than half
 * its remaining width on top of what perspective had already taken, to sell "the
 * vanishing end is a thin ribbon". Against the reference that is the defect, not
 * the effect: the reference playfield stays wide the whole way up and the far
 * lanes are as readable as the near ones. Perspective through the long lens now
 * does all the narrowing that is wanted (0.60 of the near width at the far end),
 * and this is left as a token 5% so the far edge still reads as receding rather
 * than as a rectangle.
 *
 * Still quadratic, so it is identity where the player is actually aiming, and
 * still applied to the *vertices* (see `bendToCurve`) rather than in the shader —
 * that is what keeps the UVs, and therefore the weave and the lane structure,
 * tapering along with the geometry for free.
 */
const FAR_WIDTH = 0.98;

function curveWidth(z: number): number {
  const t = Math.min(1, Math.max(0, -z / HIGHWAY_LENGTH));
  return 1 - (1 - FAR_WIDTH) * t * t;
}

/**
 * The neon ground grid flanking the highway.
 *
 * The far end stops in front of the backdrop plane (z=-40), not past it: the
 * sky has `depthWrite: false` and so occludes nothing, and a ground plane
 * reaching behind it would be drawn on top of the sun.
 */
const GROUND_WIDTH = 170;
const GROUND_NEAR_Z = 12;
const GROUND_LENGTH = 48;

const MAX_NOTE_INSTANCES = 512;

/**
 * Explicit draw order for the near field.
 *
 * Almost everything here is `transparent`, and three sorts transparent objects by
 * `renderOrder` and *then* by the depth of the object's origin. The receptor row,
 * the hit band, the floor and the notes all have origins within 0.2 of z=0, so
 * leaving them on one renderOrder made their order a coin-flip decided by a
 * rounding difference — and the flip that lost drew the hit band *over* a tile
 * landing on it. Naming the layers costs nothing and removes the coin.
 *
 * The other reason this has to be explicit: a note past the hit line fades out
 * through alpha but still writes depth (it is a lit 3D slab, not a billboard), so
 * anything drawn *after* it would be punched through by an invisible tile. The
 * band must therefore be committed before any note.
 */
const LAYER = {
  backdrop: -60,
  stars: -50,
  ground: -40,
  floor: -30,
  rails: -20,
  /**
   * The connector band, then the pad slabs, then the contact shadows, then the
   * pads' own light.
   *
   * **The band is UNDER the slabs again, and this time that is right.** It was
   * moved above them when the pad became a dark well and the band was the row's
   * only timing marker — a marker that survives everywhere except the four places
   * a note is judged is no marker. Each pad now carries its own bright dash at
   * z = 0 (`makeRimTexture`), so all the band has left to do is join those four
   * dashes across the gaps, and an additive haze laid over an opaque slab would
   * only wash the face the slab exists to keep dark. It still lands before any
   * note, which is the ordering that actually matters — a faded-out tile past the
   * line writes depth and would otherwise punch a hole in it.
   *
   * Numbered in tens rather than ones so a layer can be inserted without
   * renumbering the file — which is what `noteShadow` needed. It has to darken
   * the surface a tile is standing on (track and pad face alike) and must NOT
   * darken the pad's rim, which is the row's brightest element.
   */
  hitBand: -14,
  pad: -10,
  noteShadow: 5,
  receptorFrame: 10,
  hold: 20,
  noteTrail: 20,
  noteGlow: 30,
  note: 40,
  /** Impact effects read on top of the tile that caused them. */
  impact: 50,
} as const;

/**
 * Hold bodies drawn at once.
 *
 * A pool of individual meshes rather than an `InstancedMesh`, because every
 * hold is a different length and instancing shares one geometry. Small on
 * purpose: only holds inside the approach window are ever on screen, and the
 * chart generator caps how many can overlap.
 */
const MAX_HOLD_BODIES = 24;

/** Where a hold's body starts and ends on the track, or null when it is off it. */
export interface HoldSpan {
  /** Nearest end, clamped at the hit line. */
  nearZ: number;
  /** Far end — the tail. */
  farZ: number;
}

/**
 * The z range a hold body should cover right now.
 *
 * Pure, and exported so it can be tested without a WebGL context — the same
 * split the rest of the project uses, where the geometry decision is logic and
 * only the vertex writing is rendering.
 *
 * **The near end is clamped at the hit line**, which is what makes a hold read
 * as being *consumed*: once its head arrives the body stops advancing and the
 * tail keeps coming, so the strip drains into the receptor while it is held.
 * Without the clamp the whole body would slide past the player like a long note
 * that had already been missed.
 */
export function holdSpan(
  noteT: number,
  duration: number,
  songTime: number,
  approachSec: number,
): HoldSpan | null {
  if (!(duration > 0)) return null;

  const zOf = (t: number): number => (-(t - songTime) / approachSec) * HIGHWAY_LENGTH;
  const farZ = zOf(noteT + duration);
  // Entirely behind the camera.
  if (farZ > 1) return null;

  const nearZ = Math.min(zOf(noteT), 0);
  // Fully consumed: the tail has reached the line too.
  if (nearZ <= farZ) return null;

  return { nearZ, farZ };
}

/**
 * Lengthwise segments in a hold body.
 *
 * **A hold has to be bent to the track and a plane cannot bend without
 * segments** — `PlaneGeometry(w, h)` is a single quad and stays flat however
 * its vertices are moved. The body also spans far more z than a note does, so
 * it needs enough divisions to follow `curveLift` smoothly rather than
 * chording across it.
 */
const HOLD_SEGMENTS = 24;
/**
 * Particle-pool *capacity* — the buffers are sized to this once. How many are
 * actually emitted and drawn is `this.particleBudget`, which the quality tier
 * sets at or below this, so a live downgrade only has to lower a number rather
 * than reallocate.
 */
const MAX_PARTICLES = 1500;
/** Concurrent hit shockwaves. A short burst can stack a few across lanes. */
const MAX_SHOCKWAVES = 16;
/** Starfield *capacity* — see `MAX_PARTICLES`; the live count is `this.starCount`. */
const STAR_COUNT = 560;

// Live quality adaptation. A budget GPU that cannot hold 60fps is caught by
// watching frame time rather than guessing from specs (which lie — a weak-GPU
// phone reports flagship CPU/RAM). See `quality.ts` for why this is the reliable
// signal.
/** Below this frame time (seconds) a frame counts as slow — ~45fps. */
const SLOW_FRAME_SEC = 1 / 45;
/** Skip the opening frames: shader compile and texture upload spike them. */
const ADAPT_WARMUP_FRAMES = 45;
/** Net slow frames (slow ones add, fast ones subtract) that trip a downgrade. */
const ADAPT_SLOW_BUDGET = 45;

/**
 * Camera rig. Height and distance set how steeply you look down the highway:
 * higher and closer tilts the view further over, which shows more of the lane
 * and makes note spacing easier to read.
 *
 * The height is per-style. The stage look uses a flatter, higher camera; the
 * classic synthwave look keeps its original 6.2, where its striped sun sits
 * framed on the horizon — the higher stage camera pushes that sun off the top.
 */
/*
 * Stage rig: a LONG LENS, well back and well up.
 *
 * It was (7.5, 6.2) with a 60-degree lens, and that is what made the lanes
 * converge to a point a third of the way up the frame — measured, the track's
 * outer edge at the far end was **0.118** of its width at the hit line, so ~85%
 * of the runway was spent inside a wedge narrower than one near lane. The
 * reference frames measure ~0.77 there: near-parallel lanes holding most of the
 * frame's width the whole way up.
 *
 * Convergence is `d_near / d_far`, so the only way to flatten it is to make the
 * track's length small next to the camera's distance from it — a longer lens
 * further back. `fovFor` narrows the FOV to suit automatically, so these two
 * numbers are the whole knob. At (16, 30) the same measurement is **0.569**, with
 * an 19-degree lens.
 *
 * The costs are real and were checked. A note far up the runway is now nearly as
 * large as a near one (that is the point, and it is half of the "note bars are
 * tiny" complaint). Landscape and desktop get a *narrower* board — a short wide
 * frame cannot hold both a 68%-tall track and a wide one at this focal length —
 * which is the right trade for a game whose shipped artifact is a portrait phone.
 *
 * **18.5, not 16, and the reason is the note silhouette.** A slab's on-screen
 * aspect is `(depth/width) * sin(view angle) + (height/width) * cos(view angle)`,
 * so how tall a note reads is set by how steeply the camera looks down and by
 * nothing else the tile can control — depth is capped by note spacing (a slab
 * longer than the gap a chart leaves has consecutive notes touching) and width is
 * pinned to the pad. At 16 the rig looked down 28 degrees at the row and ~15 at
 * the crest, which rendered every far note WIDER than tall (measured 1:0.79) where
 * the reference is 1:1.12 there and never drops below 1:1 anywhere. Projecting the
 * real rig, 18.5 lands 1.01 / 1.12 / 1.24 / 1.38 / 1.54 from the spawn point to
 * the row, against the reference's 1.12 / 1.29 / 1.54 at matched widths.
 *
 * It is paid for out of `TRACK_FRAME_SHARE`, and that pairing is not optional: a
 * steeper look at a fixed-length track subtends more angle, so `fovFor`'s height
 * requirement grows and — left alone — opens the lens, which shrinks the board
 * and cancels the change exactly (measured: at share 0.68 the board falls from
 * 96.9% of the frame to 85%). Raising the share instead keeps the FOV at 19.2,
 * i.e. the same lens as before, and spends the extra angle on track.
 *
 * **(24, 39), and the pair moved together on purpose.** Convergence is
 * `d_near / d_far` and the ONLY thing that moves it is how far back the eye sits
 * relative to the track's length: at (18.5, 30) the far end measured 0.581 of the
 * near width, against ~0.80 in the reference frames. Scaling both numbers by 1.3
 * leaves the look-down angle at the receptor row **exactly** where it was
 * (`atan2(24, 39)` = `atan2(18.5, 30)` = 31.6 deg), which is what protects the
 * note silhouette — a slab's on-screen aspect is set by that angle and by nothing
 * else the tile can control — while taking convergence to **0.662**. The crest
 * note is *less* foreshortened than before as a result (1:1.20 against 1:1.01),
 * so the "notes are tiny" gate improves rather than pays for this.
 *
 * **Shortening `HIGHWAY_LENGTH` is the other way to flatten it, and it is
 * closed.** It was measured: convergence wants L ~ 18, but the world gap a chart
 * leaves scales with L (`L * minGapSec / approachSec`), so an 18-unit track gives
 * hard 2.63 units between notes in a lane against a slab 3.10 deep — consecutive
 * notes touching. Cutting `TILE_DEPTH` to fit takes the crest silhouette to
 * 1:0.97, i.e. a note wider than tall, which is an owner gate. Distance is the
 * lever that has no such coupling; length is not.
 */
/*
 * **(31.2, 50.7) — the same pair scaled by 1.3 once more, for the same reason.**
 *
 * Convergence measured 0.662 at (24, 39) against the reference's ~0.77, and the
 * frame it produced still read as a tunnel: the four lanes held 79% of the
 * frame's width at the receptor row but only ~33% at the far end. Scaling both
 * numbers by the same factor leaves `atan2(31.2, 50.7)` = `atan2(24, 39)` =
 * 31.6 deg — the look-down angle at the row is EXACTLY unchanged, which is what
 * protects the note silhouette (a slab's on-screen aspect is set by that angle
 * and by nothing else the tile can control) — while taking convergence to
 * ~0.72. This is the only lever with no coupling: shortening `HIGHWAY_LENGTH`
 * is closed (see below) and `FAR_WIDTH` is already all but off at 0.98.
 */
/*
 * **(40.6, 65.9) — the pair scaled by 1.3 once more, and the reason is measured.**
 *
 * At (31.2, 50.7) the deck's far end held 0.719 of its width at the receptor row,
 * against ~0.77 in the reference frames, and both critics read the upper runway as
 * a wedge. The same 1.3 scaling keeps `atan2(40.6, 65.9)` = `atan2(31.2, 50.7)` =
 * 31.6 deg — the look-down angle at the row is EXACTLY unchanged, which is what
 * protects the note silhouette — and takes convergence to **0.768**, i.e. the
 * reference's own figure.
 *
 * It is paid for out of `TRACK_FRAME_SHARE` and the pairing is not optional (see
 * the note there): at share 0.74 the longer lens costs board width, dropping the
 * receptor row from 78.3% of the frame to 73.4%. At 0.80 the row holds **79.4%**
 * (the reference's is ~77%) and the approach runway goes 52.6% -> **55.9%** of the
 * frame height, which is the first time it has cleared the documented ~55% floor.
 *
 * It also *improves* the motion distribution, which is what this pass is for: a
 * note's on-screen pixel velocity runs 12.40 px/frame at the spawn point against
 * 15.30 at the receptor, a far/near ratio of **1.23** where the old rig measured
 * 1.34. A flatter perspective is a more even one by construction.
 */
/*
 * **(15, 24) — the scaling ladder above went two rungs too far, MEASURED.**
 *
 * Every entry above computes convergence as the pitch ratio between z = 0 and
 * z = -25, the deck's geometric far end. That number is not what anyone sees:
 * the far fade takes the deck to black around z = -14, so the *visible* top of
 * the track is there, and the ratio the eye reads is the one measured across the
 * visible span. Read off the shipped capture with a scanline probe, the rails
 * spanned 810px at the top of the visible track against 900px at the receptor
 * row — **0.90**, i.e. a flat box standing on end, against the reference frames'
 * own 0.61-0.68 measured exactly the same way (636px against 1048px on the cyan
 * frame). The ladder was tuning a statistic the frame does not contain.
 *
 * So the pair comes back down. Projected at 1170x2532, 4 lanes, the visible-span
 * ratio at z = -14 runs 0.86 at (40.6, 65.9), 0.78 at (24, 39) and **0.687** at
 * (15, 24), which is the reference's figure. `atan2(15, 24)` is 32.0 degrees
 * against the long lens's 31.6, so the look-down angle at the receptor row — the
 * thing that sets a slab's on-screen aspect, and the reason the ladder scaled
 * both numbers together — is within half a degree of every rung above it.
 *
 * What it costs is the approach runway, which is why `NOTE_SPAWN_PROGRESS` moves
 * with it: at spawn 0.60 the runway is 52.4% of the frame, at 0.64 it is 54.8%,
 * which clears the documented ~55% floor. The two are one knob.
 */
const CAMERA_HEIGHT = 15;
const CAMERA_DISTANCE = 24;
/**
 * The classic synthwave rig, unchanged at its original values.
 *
 * Nothing ships `style: 'classic'`, but its striped sun is framed against this
 * exact camera and the flat-lens numbers above would push it off the top. Kept
 * as its own pair rather than scaled, so the dormant path is byte-identical.
 */
const CLASSIC_CAMERA_HEIGHT = 6.2;
const CLASSIC_CAMERA_DISTANCE = 6.2;
const CAMERA_TARGET_Z = -9;
/**
 * Floor on the vertical FOV. Only the classic rig can reach it; the stage rig's
 * requirement is always well above (it is a long lens looking at a long track).
 */
const MIN_FOV = 8;
/**
 * How much of the frame's height the track is allowed to occupy, far end to
 * receptor row.
 *
 * This replaces the old `BASE_FOV = 60` floor, which was a constant standing in
 * for "don't crop the track" and only held for the one aspect it was tuned at.
 * With the camera this far back the vertical requirement is the binding one at
 * every wide aspect, and a number the frame is measured in says what it means.
 * 0.68 left the far end at ~8% of the frame and the receptors at ~76% on a
 * 390x844 phone.
 *
 * **0.745, and it moves with `CAMERA_HEIGHT` — the two are one knob.**
 *
 * The share is the denominator of the height requirement, so it is what decides
 * whether a steeper camera buys a taller note or just a wider lens. Projected at
 * 390x844, 4 lanes: at 0.68 the steeper rig asks for a 21.3-degree lens and the
 * receptor row falls to 85% of the frame's width; at 0.745 it asks for 19.2 —
 * the same lens the flatter rig used — and the row holds 94.0%, against the
 * reference's own 90.6%. What the frame spends on it is track: the far end sits
 * at ~4% instead of ~8%, and the runway between the spawn point and the row goes
 * from 59.6% to 66.1%.
 *
 * **0.74 under the (24, 39) rig.** The long lens costs board width — the width
 * requirement stops binding entirely, so the share is what decides how much of
 * the frame the row fills. Projected at 390x844, 4 lanes: the track's angular
 * height is 12.1 deg, so the lens sits at 16.4 deg and the receptor row holds
 * ~87% of the frame's width, which is the reference's own figure (800 of 923 px
 * on the cyan frame). Raising it further is the wrong trade twice over: the row
 * already sits at 76.6% of the frame, so a share past ~0.76 pushes the track's
 * far end off the top edge.
 */
/*
 * **0.80 under the (40.6, 65.9) rig**, and it moves with the camera as always.
 *
 * The longer lens spends board width on convergence, so the share is what buys it
 * back. Projected at 390x844, 4 lanes: 0.74 leaves the receptor row at 73.4% of
 * the frame and the runway at 51.7%; 0.80 puts them at 79.4% and 55.9%. What it
 * costs is the deck's far END, which now sits ~5% above the top edge — that is
 * geometry the far-end fade has already taken to near-black, and cropping it is
 * the same fix as the "the deck terminates on a hard scanline" report: there is
 * no longer an edge there to see.
 */
const TRACK_FRAME_SHARE = 0.8;
/** Upper bound on widening; past this the perspective distortion is worse than the crop. */
const MAX_FOV = 96;

/**
 * Aspect below which the board counts as "portrait phone" and the hit line is
 * raised. Just under square, so tall phones qualify and landscape never does.
 */
const PORTRAIT_ASPECT = 0.85;
/**
 * How far up the receptor line is nudged on a phone, as a fraction of viewport
 * height.
 *
 * 0.04, not 0.13. It is a pure translation of the whole scene (that is why it
 * cannot buy runway), so its only job is placing the receptor row — and the flat
 * rig already lands the row at 79% before any raise. The old 0.13 on top of that
 * put it at 76% with the track's far end above the top of the frame; a twentieth
 * restores the 76% row *and* leaves the far end visible at ~8%, which is the
 * background the reference shows above the track.
 *
 * 0.058 with the steeper rig, which is the same row in the same place: raising
 * the camera and the frame share together slides the whole projection down (the
 * row lands at 79% untouched), and this pans it back to 76.6% — within a point of
 * where the flat rig put it, so nothing about where a thumb goes moved.
 */
/*
 * 0.089 under the (15, 24) rig, and it is the same row in the same place: the
 * shorter lens lands the receptor row at 78.1% of the frame untouched, and this
 * pans it back to 75.0% — within a quarter point of where the long lens put it,
 * so nothing about where a thumb goes moved.
 */
const HIT_RAISE_FRACTION = 0.089;

/**
 * Height of the sky plane, in world units.
 *
 * Three times the 120 it was, and every sky constant is still written against
 * 120 — `sv` in the shader rescales. The reason is coverage, not sky: a
 * 120-unit plane at this depth reaches world y = -52, while the bottom row of a
 * portrait frame looks at roughly y = -85. Below the plane's edge the flat
 * `scene.background` colour showed through, which is what made the region either
 * side of and below the track read as one dead slab of black.
 */
const SKY_PLANE_HEIGHT = 360;
/**
 * Where the stage sky sits. Fixed, not `-HIGHWAY_LENGTH - 14`.
 *
 * The sky band's numbers (the glow's centre, the city's base and top) are
 * measured off this plane's projection, so deriving its depth from the track's
 * length meant that lengthening the track silently rescaled the sky.
 */
const STAGE_BACKDROP_Z = -34;

/**
 * Stars stream from `STAR_FAR_Z` toward the camera and recycle **before they
 * ever reach the playfield**.
 *
 * The recycle point used to be +12 — past the camera — with a squared fade over
 * the last 14 units. A squared fade is not a cull: a star at z = -3 still
 * carried 4% of its colour, and `sizeAttenuation` had by then swollen it into a
 * fat sprite, so ten resolvable pale dots were sitting *inside* the green
 * receptor socket. High-frequency noise in the one region the eye has to read
 * sharpest is the worst possible place for it. Recycling at -20 means the field
 * is atmosphere behind the vanishing point and nothing else.
 */
const STAR_FAR_Z = -130;
const STAR_RECYCLE_Z = -20;
/**
 * Half-angle of the star corridor, as a tangent.
 *
 * A little wider than the widest shipped half-FOV (5 lanes at 390x844 resolves to
 * 11.6 degrees), so the field fills the frame at every lane count and aspect
 * without being placed per-viewport. See `placeStar`.
 */
const STAR_CORRIDOR_TAN = 0.23;
/** Distance over which a star fades to nothing before it is recycled. */
const STAR_FADE_Z = 18;

/**
 * Fixed uniform-array length for the floor shader.
 *
 * GLSL array uniforms have a compile-time size, and three.js uploads exactly
 * as many elements as the declared length. Passing a shorter array (one entry
 * per actual lane) throws during the uniform upload and takes the whole render
 * loop down with it, so these are always padded to this length regardless of
 * how many lanes the chart uses.
 */
const MAX_SHADER_LANES = 8;

/**
 * A theme's sRGB hex as a linear `vec3` for a shader uniform.
 *
 * `THREE.Color` does the conversion because ColorManagement is on by default,
 * which is the same path the lane tints already take. Doing it here — rather
 * than storing linear values in the theme — is what lets a palette be picked in
 * an ordinary colour picker. Shader colours are linear; hex values are not, and
 * mixing the two up is how the ground grid first came out near-white.
 */
function skyColor(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

/**
 * A theme accent reduced to `chroma` of its saturation and normalised to a peak
 * channel of 1 — a *tint*, for scenery that should carry the song's colour
 * without competing with the notes for it.
 *
 * Normalising is what makes an amplitude in a shader mean the same thing for
 * every theme: a raw accent's brightness varies by a factor of three across the
 * built-ins (gold peaks at linear 0.905, a deep violet at 0.29), so an unscaled
 * multiply would light the stage to a different depth per song.
 */
function skyAccent(hex: number, chroma: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  const grey = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const v = new THREE.Vector3(
    grey + (c.r - grey) * chroma,
    grey + (c.g - grey) * chroma,
    grey + (c.b - grey) * chroma,
  );
  return v.divideScalar(Math.max(v.x, v.y, v.z, 1e-4));
}

export interface HighwayOptions {
  canvas: HTMLCanvasElement;
  laneCount: number;
  approachSec: number;
  /**
   * The song's palette. Resolve it with `themeFor(beatmap.themeId)` — that
   * never fails, which matters here because a theme that could not resolve
   * would throw in the constructor and leave a black screen rather than merely
   * the wrong colours.
   */
  theme: Theme;
  /** Beat times, used to pulse the scene in time with the music. */
  beatGrid?: readonly number[];
  /**
   * Rendering quality. Omit for the full `high` pipeline. Screens resolve it
   * with `resolveQuality()` (quality.ts) and pass the profile; the low profile
   * drops bloom, MSAA and pixel ratio and thins the effects for weak GPUs.
   */
  quality?: QualityProfile;
  /**
   * Allow the renderer to downgrade to low live when frames run slow. Enabled on
   * gameplay screens under the `auto` setting; the decision is remembered
   * (`markAutoLow`) so it happens once, not every song.
   */
  adaptive?: boolean;
}

export class Highway {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  // Nullable and mutable: absent on the low tier (which renders straight to the
  // canvas), and torn down mid-run when the adaptive downgrade fires.
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private readonly laneCount: number;
  private readonly approachSec: number;
  /**
   * Note-visibility modifier. `normal` draws every note fully; `hidden` fades a
   * note out as it nears the receptor (commit blind); `fadeout` keeps it dark
   * until it is close (read late). Applied as a plain colour multiply in
   * `updateNotes`/`updateHoldBodies` — the tiles glow against a dark track, so
   * multiplying toward 0 fades them to nothing without any transparent-material
   * or shader change.
   */
  private visibility: Visibility = 'normal';
  private readonly theme: Theme;
  /** Beatstar-style rendering: dark colourless track, glowing rails, cover ring. */
  private readonly stage: boolean;
  /** The theme's bright accent — metal notes, rails, firework. */
  private readonly accent: number;
  /** Camera height, per style — the classic sun needs the lower original camera. */
  private readonly camHeight: number;
  private readonly camDistance: number;
  /** The camera's view axis as a unit direction in the yz plane (x is always 0). */
  private readonly viewDirY: number;
  private readonly viewDirZ: number;
  private readonly beatGrid: readonly number[];
  private beatCursor = 0;
  /**
   * Beats between flashes, holding the beat flare within `MAX_FLASH_HZ`. Fixed
   * for the song at construction — see `flashStride` for why it must not track
   * the tempo live.
   */
  private readonly flashStride: number;

  /**
   * Pool of hold bodies, checked out per frame.
   *
   * Their geometry is rewritten in place each frame — a hold's on-screen length
   * changes continuously as it approaches and again as it is consumed — so these
   * are allocated once and mutated rather than rebuilt.
   */
  private readonly holdBodies: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];

  private readonly notes: THREE.InstancedMesh;
  /**
   * Soft additive pool under each note.
   *
   * Glow and core are deliberately separate meshes. Driving both from one
   * brightness value means the ramp straddles the bloom threshold: distant
   * notes fall under it and do not glow at all, while near ones blow past it
   * and clip to white, losing their silhouette exactly when the player needs
   * to read it. The halo carries the glow so the core can stay legible.
   */
  private readonly noteGlow: THREE.InstancedMesh;
  /**
   * The contact shadow each tile casts on the surface it is standing on.
   *
   * Nothing in the playfield used to be *grounded*: not one tile darkened the
   * track under it, so the track directly beneath a note measured identical to
   * the track 200px to its left and every tile read as a glowing decal
   * composited over a photograph of a highway. All the bevel authoring in the
   * world cannot fix that — an object with no shadow is a sticker. One extra
   * instanced quad per note is the cheapest thing on this list and the loudest.
   */
  private readonly noteShadows: THREE.InstancedMesh | null;
  /** Light-streak trails behind the falling gems (stage only). */
  private readonly noteTrails: THREE.InstancedMesh | null;
  /**
   * Smooths the audio clock's per-quantum staircase into continuous motion.
   * See the note at the top of `render` — this is what fixed the reported
   * "sluggy, not smooth" note movement, which was never a frame-rate problem.
   */
  private readonly renderClock = new RenderClock();
  /**
   * Wall time for `renderClock`, accumulated from the `dt` the play loop passes
   * in — which comes from the **rAF timestamp**, i.e. the frame's vsync time.
   *
   * Deliberately not `performance.now()` read here: that is the moment the
   * callback happened to be dispatched, and its scheduling noise would be
   * injected straight into the interpolation. Measured on the same probe, in
   * play, on the real GPU: the smoothed scroll rate deviates 7.5% on average
   * (worst frame 65%) when driven off `performance.now()`, against **2.9%
   * (worst 19%)** off the frame timestamp.
   */
  private renderWallSec = 0;
  private readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly stars: THREE.Points;
  private readonly starPositions: Float32Array;
  /** Per-star travel speed, so the field parallaxes instead of moving as a sheet. */
  private readonly starSpeeds: Float32Array;
  /**
   * Each star's undimmed tint, so `updateStars` can fade it out on approach.
   *
   * The live `color` attribute is destructive (a fade cannot be un-applied), so
   * the base has to be kept. It exists because stars used to fly all the way to
   * `STAR_RECYCLE_Z`, i.e. straight through the receptor row: additive blue-white
   * specks drifting across the four targets, which is high-frequency noise at the
   * one place in the frame the eye is told to rest.
   */
  private readonly starBase: Float32Array;

  private readonly pads: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  /** Rectangular hit-zone frames, one per lane. The target a tap tile lands in. */
  private readonly hitZones: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  /** The two bright glowing rails down the outer edges of the track. */
  private readonly rails: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
  /** The animated electric capsule of the hit bar (stage only), driven per frame. */
  private hitBarMaterial: THREE.ShaderMaterial | null = null;
  /** Live audio spectrum as a 1D texture, so the rails can read it as a waveform. */
  private spectrumTex: THREE.DataTexture | null = null;
  private spectrumData: Uint8Array | null = null;
  private readonly particles: THREE.Points;
  private readonly particlePositions: Float32Array;
  private readonly particleColors: Float32Array;
  /**
   * Emitted colour, kept so the drawn colour can decay with life.
   *
   * Without it a spark held full brightness for its whole life and then vanished
   * on one frame — the reason the burst read as scattered specks rather than as
   * a spray with a shape.
   */
  private readonly particleBase: Float32Array;
  /** Per-particle base size, so a burst has large and small elements in it. */
  private readonly particleSizes: Float32Array;
  private readonly particleVelocities: Float32Array;
  private readonly particleLife: Float32Array;
  private particleCursor = 0;

  /** Per-lane glow that decays each frame, driven by key presses and hits. */
  private readonly laneFlash: Float32Array;
  /**
   * Per-lane "denied" decay, driven by a miss.
   *
   * A miss has to be legible AT the receptor without borrowing the language of a
   * hit: the row's response is to dim and flinch rather than to flare. Separate
   * from `laneFlash` because they must be able to overlap — the player can strike
   * one lane on the beat a neighbour is being missed on.
   */
  private readonly laneMiss: Float32Array;
  /** Camera kick on a hit, decaying back to rest. */
  private punch = 0;
  /** Screen-shake magnitude, decaying to rest. Bumped on a hit, scaled by combo. */
  private shake = 0;
  /**
   * Phase of the shake waveform, re-rolled only when a burst starts from rest.
   *
   * Re-rolling it on every hit would put a position discontinuity in the middle
   * of a decaying rattle — reintroducing, once per note, exactly the frame-to-
   * frame jump `shakeOffset` exists to remove.
   */
  private shakePhase = 0;

  /** Expanding shockwave rings, one pool slot per concurrent hit. */
  private readonly shockwaves: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  /** 1 → 0 over a shockwave's life; 0 means the slot is free. */
  private readonly shockwaveLife = new Float32Array(MAX_SHOCKWAVES);
  private shockwaveCursor = 0;

  private readonly dummy = new THREE.Object3D();
  /** Scratch vector for projecting receptors during hit testing. */
  private readonly probe = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private disposed = false;

  /** The active quality profile. Swapped for the low one on a live downgrade. */
  private quality: QualityProfile;
  /** Active starfield count (≤ STAR_COUNT capacity). */
  private starCount: number;
  /** Active particle count (≤ MAX_PARTICLES capacity); also the draw range. */
  private particleBudget: number;
  /** Whether the renderer may auto-downgrade on sustained slow frames. */
  private readonly adaptive: boolean;
  /** Frames seen (for warmup) and the running slow-frame tally. */
  private framesSeen = 0;
  private slowFrameScore = 0;
  /** Last size passed to `resize`, so a live downgrade can re-apply it. */
  private viewWidth = 1;
  private viewHeight = 1;

  constructor({
    canvas,
    laneCount,
    approachSec,
    theme,
    beatGrid = [],
    quality,
    adaptive = false,
  }: HighwayOptions) {
    this.laneCount = laneCount;
    this.approachSec = approachSec;
    // Resolved before any build* call: they size the star/particle buffers and
    // decide which effects exist. Default to the full pipeline when unspecified.
    const q = quality ?? qualityProfile('high');
    this.quality = q;
    // Clamped to the buffer capacities. The profile lives in quality.ts and the
    // capacities here, and the two files cannot import from each other's numbers
    // — same drift risk as the sw.ts/pwa.ts cache name. Raising a profile above
    // capacity would place stars past the end of a Float32Array (a silent no-op)
    // and then draw that range: a field of vertices stuck at the origin.
    this.starCount = Math.min(q.starCount, STAR_COUNT);
    this.particleBudget = Math.min(q.particleBudget, MAX_PARTICLES);
    // Only adaptive when high: nothing to shed once already low.
    this.adaptive = adaptive && q.tier !== 'low';
    // Assigned before any build* call: every one of them reads it, and a field
    // set after `buildBackdrop()` would be undefined at the moment it is needed.
    this.theme = theme;
    // Stage is the default look now; the classic synthwave sun is an explicit
    // opt-in that nothing ships with, so a theme is classic only if it says so.
    this.stage = theme.style !== 'classic';
    this.accent = theme.accent ?? DEFAULT_ACCENT;
    this.camHeight = this.stage ? CAMERA_HEIGHT : CLASSIC_CAMERA_HEIGHT;
    this.camDistance = this.stage ? CAMERA_DISTANCE : CLASSIC_CAMERA_DISTANCE;
    // Resting view axis, from the eye to the look target. Read by `placeStar` to
    // keep the star corridor inside the frame; the per-frame sway and shake are
    // deliberately not folded in, since the field would then swim with the camera.
    {
      const dy = -this.camHeight;
      const dz = CAMERA_TARGET_Z - this.camDistance;
      const len = Math.hypot(dy, dz);
      this.viewDirY = dy / len;
      this.viewDirZ = dz / len;
    }
    this.beatGrid = beatGrid;
    this.flashStride = flashStride(beatGrid);
    this.laneFlash = new Float32Array(laneCount);
    this.laneMiss = new Float32Array(laneCount);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap));
    /*
     * Khronos PBR Neutral, not ACES — and this is the single change that makes
     * lane colour survive to the screen.
     *
     * ACES is a *film* curve: its input matrix pushes 35% of the green channel
     * into red before the shoulder, so a saturated colour desaturates as it
     * brightens, by construction. Measured on a green tile whose emissive term is
     * (0.018, 0.557, 0.135) — a pure lane hue with almost nothing in R — ACES
     * returns (92, 205, 124): saturation 0.55 against a 0.65 floor, before bloom
     * takes it to 0.46. Every knob was tried: the level that gave green
     * saturation 0.65 dropped its value to 0.749, i.e. under the other half of the
     * same rule. Green cannot satisfy both under ACES.
     *
     * PBR Neutral is designed for exactly this — it holds hue and chroma until
     * the peak channel reaches 0.76 and then compresses with only a 15%
     * desaturation. The same tile renders saturation ~0.94 at value 0.87, and all
     * five lanes land on the *same* value, which is the other thing the rule asks
     * for. Scenery is affected too (it is a little darker in the deep tones and
     * holds more chroma up high); every scenery scalar in this file was re-read
     * against it.
     *
     * The bloom threshold is unaffected: `UnrealBloomPass` high-passes the
     * scene-linear buffer *before* tone mapping, so 0.85 still means 0.85.
     */
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.scene = new THREE.Scene();
    // Derived from the theme rather than a fixed near-black. The backdrop plane
    // covers the frustum in normal play, but it stops short at very wide aspect
    // ratios, and a violet sliver either side of an arctic sky reads as a bug.
    this.scene.background = new THREE.Color(theme.sky.below).multiplyScalar(0.4);

    // Lights exist ONLY for the note buttons — every other object uses an unlit
    // MeshBasicMaterial and ignores them, so the rest of the scene is unchanged.
    // A key light raking down from above-front lets the tiles' beveled edges
    // catch a real highlight and shade, which is what makes them read as solid
    // 3D metal; the ambient keeps the shadowed bevels from crushing to black.
    // 1.6, and no ambient. The tiles' albedo is black (buildNotes: the lane hue
    // is an emissive term, so it survives ACES), which makes every DIFFUSE light
    // path a no-op by construction — an `AmbientLight` feeds irradiance and
    // nothing else, so it was already contributing exactly zero before that
    // change and is gone rather than left as decoration. What this light still
    // does is the specular sheen on the chamfers, which is the whole reason it
    // exists; at 2.4 with a tight lobe that sheen was a blown white hotspot.
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(0.25, 1, 0.5);
    this.scene.add(key);

    /*
     * There is no `scene.environment` any more, and re-adding one is a mistake.
     *
     * It existed for the notes' reflection when they were `metalness: 1`. They are
     * not: the lane hue is emissive now (see `buildNotes`), so a greyscale
     * environment could only ever add untinted light to a face whose whole job is
     * to carry chroma — measured, it was most of a 0.65 -> 0.54 saturation loss.
     *
     * Deleting it also removes a per-run cost the audit flagged: a raw equirect
     * CanvasTexture is PMREM-generated lazily inside the FIRST `composer.render()`
     * of every run — several passes plus a shader compile — and the PMREM target
     * belongs to the renderer, so `texCache` never saved it across runs. That is a
     * candidate for the unattributed run-start hitch, removed for free.
     */

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);
    this.camera.position.set(0, this.camHeight, this.camDistance);
    this.camera.lookAt(0, 0, CAMERA_TARGET_Z);

    this.backdrop = this.buildBackdrop();
    this.scene.add(this.backdrop);

    /*
     * The cover art ringed at the vanishing point used to stand here — a spinning
     * disc, an accent rim, and 96 spectrum spikes around it. All three are gone
     * (deliverable 07). The `SongHero` disc shows the artwork before the run and
     * the results card after it, so the horizon copy was a third place to draw
     * something the player had just looked at, and it cost 96 `setMatrixAt` plus
     * 96 `setColorAt` calls and two buffer uploads on every single frame.
     *
     * The spectrum plumbing it shared is still live: `spectrumTex` feeds the
     * rails' waveform shader, which is the reactive element that survived.
     */

    this.starPositions = new Float32Array(STAR_COUNT * 3);
    this.starSpeeds = new Float32Array(STAR_COUNT);
    this.starBase = new Float32Array(STAR_COUNT * 3);
    this.stars = this.buildStars();
    this.scene.add(this.stars);

    // Before the floor: the highway is translucent and has to composite over
    // the ground, not the other way round.
    this.ground = this.buildGround();
    this.scene.add(this.ground);

    this.floor = this.buildFloor();
    this.scene.add(this.floor);

    // A 1D spectrum texture the rails sample to draw the live waveform. Linear
    // filtered so the waveform is smooth, and wrapped so it can scroll.
    if (this.stage) {
      this.spectrumData = new Uint8Array(256);
      this.spectrumTex = new THREE.DataTexture(this.spectrumData, 256, 1, THREE.RedFormat);
      this.spectrumTex.minFilter = THREE.LinearFilter;
      this.spectrumTex.magFilter = THREE.LinearFilter;
      this.spectrumTex.wrapS = THREE.RepeatWrapping;
      this.spectrumTex.needsUpdate = true;
    }

    // Rails are a stage-style flourish; the classic synthwave look has none.
    if (this.stage) this.buildRails();
    // The spectrum wings flanking the board — the reference's most energetic
    // background element, and the owner's third acceptance criterion.
    if (this.stage) this.buildSpectrumWings();

    this.buildReceptors();

    // The electric hit bar sits just in front of the receptors — stage only.
    if (this.stage) this.buildHitBar();

    // Before the notes, so a hold's head pill draws over its own body rather
    // than being swallowed by it.
    this.buildHoldBodies();

    // Grounding, before any of the light: the shadow lies *under* the halo and
    // the tile, and over the hit band, so a landed tile darkens the target it is
    // standing in.
    this.noteShadows = this.stage ? this.buildNoteShadows() : null;
    if (this.noteShadows) this.scene.add(this.noteShadows);

    this.noteGlow = this.buildNoteGlow();
    this.scene.add(this.noteGlow);

    // Light-streak trails behind the gems — stage only, and dropped on the low
    // tier. Built before the notes so a gem draws over its own trail.
    this.noteTrails = this.stage && q.trails ? this.buildNoteTrails() : null;
    if (this.noteTrails) this.scene.add(this.noteTrails);

    this.notes = this.buildNotes();
    this.scene.add(this.notes);

    this.particlePositions = new Float32Array(MAX_PARTICLES * 3);
    this.particleColors = new Float32Array(MAX_PARTICLES * 3);
    this.particleBase = new Float32Array(MAX_PARTICLES * 3);
    this.particleSizes = new Float32Array(MAX_PARTICLES);
    this.particleVelocities = new Float32Array(MAX_PARTICLES * 3);
    this.particleLife = new Float32Array(MAX_PARTICLES);
    this.particles = this.buildParticles();
    this.scene.add(this.particles);

    this.buildShockwaves();

    // Bloom is the low tier's biggest saving: the composer renders the scene
    // into a half-float target and runs several full-screen blur passes on it
    // every frame. Skip the whole chain when off — `render()` then draws the
    // scene straight to the canvas.
    if (q.bloom) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      // Tight radius and a high threshold. A wide radius smears the hit line and
      // lit floor across the entire sky as a flat haze, which reads as a washed
      // out background rather than as glow.
      // Radius 0 and a low strength: a wide, strong bloom smears every bright edge
      // into a soft haze that reads as the whole scene being out of focus. Keep it
      // to a faint flare so the notes, rails and glow stay crisp.
      /*
       * Threshold 1.05, not 0.85 — above every note FILL and below its rim.
       *
       * A bloomed fill is a white fill: the halo re-enters the silhouette,
       * washes the hue out of the face and lifts the surrounding pixels, which
       * is measurable as "the note's edge transition is a 15-20px gradient with
       * no defined outline anywhere". The tile's body now runs at a peak channel
       * of 0.76-1.0 (`buildNotes`), so 1.05 excludes it by construction while the
       * lit chamfer (1.30-1.75) still crosses and glows. Everything else that is
       * supposed to bloom — the receptor rims, the hit band core, the impact
       * sparks — is additive and over-driven well past this.
       */
      /*
       * **Strength 0.07 and threshold 1.35 — the notes were the only objects in
       * either image that bleed.**
       *
       * Measured across the deck approaching a note on the shipped capture, track
       * luminance rose 49 -> 76 over the last ~25px before the tile's edge; the
       * same scan on every reference frame is flat to within 2 luma right up to
       * the note edge, which then drops 253 -> 36 in ten pixels. `UnrealBloomPass`
       * blurs over a five-mip chain whatever `radius` says, so the only levers on
       * that skirt are how much gets in and how hard it is added. 1.35 keeps the
       * lit chamfer (`borderBright`, up to 1.75) as the only part of a note that
       * blooms at all — the fill (0.76-1.0) and the emblem (now capped at 1.2)
       * are both excluded by construction — and 0.07 halves what it adds.
       *
       * The beam is untouched by either change: its core is driven to 7.0, five
       * times the threshold, and it is supposed to be the frame's specular tier.
       */
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.07, 0.0, 1.35);
      this.composer.addPass(this.bloom);

      this.composer.addPass(new OutputPass());
    }
  }

  // --- construction --------------------------------------------------------

  private get halfWidth(): number {
    return (this.laneCount * LANE_WIDTH) / 2;
  }

  /**
   * Half the DECK's width — the lanes plus `FLOOR_MARGIN` either side.
   *
   * Distinct from `halfWidth`, which is half the lane *pitch* times the lane
   * count and is what the receptors and the FOV are sized against. The floor
   * plane, the rails and the ground's cut-out all want the deck's real edge; they
   * used `halfWidth` and therefore had no surface outside the outer lane at all.
   */
  private get deckHalfWidth(): number {
    return this.halfWidth + FLOOR_MARGIN;
  }

  private laneX(lane: number): number {
    return (lane - (this.laneCount - 1) / 2) * LANE_WIDTH;
  }

  /**
   * A note's body colour — always the lane hue.
   *
   * The stage path used to return `this.accent` here, which made the `lane`
   * argument dead: no shipped theme sets `style: 'classic'`, so every note on
   * every theme rendered one flat colour while each theme's five validated,
   * deliberately distinguishable lane hues went nowhere. Colour is how a player
   * parses which lane a note is in at speed, and with four converging lanes it
   * is doing real work — the theme picker showed five swatches and the highway
   * showed four identical gems.
   *
   * The accent still carries the scene: it is on the halo, the trail, the rails,
   * the PCB traces and the hit-bar arcs (`noteAuraHex`). Only the gem itself
   * moved. If the single-colour look is ever wanted back, this is the one line.
   */
  private noteHex(lane: number): number {
    return laneColor(this.theme, lane);
  }

  /**
   * The halo and trail behind a note — **the lane hue, on both paths.**
   *
   * This returned `this.accent` on stage, which put a single fixed colour on the
   * largest and softest part of every note. Measured on the shipped frame: a
   * lane-3 tile trailing gold above a *blue* receptor, a lane-2 tile trailing
   * gold above a green one, and the halo out-luminancing the tile inside it. The
   * halo and the trail are the parts the eye catches first, so a constant there
   * cancels the lane coding the tile is carrying, and no amount of tile chroma
   * recovers it.
   *
   * The accent still ties the frame together everywhere it is not competing with
   * lane identity: the rails, the apron pool, the hit band's wash.
   */
  private noteAuraHex(lane: number): number {
    return laneColor(this.theme, lane);
  }

  private buildBackdrop(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    // The classic synthwave sky: a striped sun setting on the horizon over a
    // graded backdrop. Statements only — the shared header below declares the
    // uniforms, helpers and consts it uses.
    const classicMain = /* glsl */ `
          // The sky colours arrive as LINEAR uniforms — THREE.Color converted
          // them from the theme's sRGB hex. ACES tone mapping plus the sRGB
          // transfer curve lifts midtones hard, so a theme whose sky reads as a
          // reasonable hex still has to be a *dark* hex: linear 0.14 lands near
          // sRGB 0.42 on screen.
          //
          // Everything below is deliberately dim. This is a backdrop: the notes
          // and the hit line have to stay the brightest things on screen, so
          // nothing here may cross the bloom threshold (0.8) and start glowing
          // in competition with them.
          float sky = smoothstep(HORIZON, 0.545, sv);

          vec3 horizonCol = mix(uSkyHorizon, uSkyHorizonAlt, 0.3 + uTreble * 0.3);
          vec3 base = mix(horizonCol, uSkyTop, sky);

          // Below eye level the backdrop only peeks past the edges of the
          // track, so it drops away to near-black rather than competing.
          base = mix(base, uSkyBelow, smoothstep(HORIZON, HORIZON - 0.08, sv));

          // --- sun --- anchored in world space, not guessed in uv. The disc
          // beats with the track: uPulse swells and flares it on the downbeat.
          float sunR = SUN_R * (1.0 + uPulse * 0.06);
          vec2 sunOffset = vec2((vUv.x - 0.5) * PLANE_ASPECT, sv - SUN_Y);
          float sunDist = length(sunOffset);
          float sunMask = smoothstep(sunR, sunR - 0.004, sunDist);

          // 0 at the crown, 1 at the waterline.
          float depth = clamp((SUN_Y + SUN_R - sv) / (2.0 * SUN_R), 0.0, 1.0);

          // Horizontal slits, the retrowave signature. Gaps widen toward the
          // bottom so the disc dissolves into the haze, crown stays solid.
          float slitPhase = fract(sv * 150.0);
          float gap = mix(0.10, 0.66, depth);
          sunMask *= mix(1.0, step(gap, slitPhase), smoothstep(0.12, 0.5, depth));

          vec3 sunCol = mix(uSun, uSunCrown, smoothstep(HORIZON, SUN_Y + SUN_R, sv));
          sunCol *= 1.0 + uPulse * 0.5;
          // Cut flat at the horizon so the sun sets behind the world.
          sunMask *= step(HORIZON, sv);
          base = mix(base, sunCol, sunMask);

          // Atmospheric bloom around the disc, swelling with the beat.
          base += uHaze * smoothstep(SUN_R * 2.6, SUN_R * 0.9, sunDist) * (0.5 + uPulse * 0.55);

          // Drifting nebula, kept subtle: it is texture, not a light source.
          float n = noise(vec2(vUv.x, sv) * vec2(5.0, 3.0) + vec2(uTime * 0.03, uTime * 0.015));
          n *= noise(vec2(vUv.x, sv) * vec2(11.0, 7.0) - vec2(uTime * 0.02, 0.0));
          base += uGlow * 0.34 * n * (0.05 + uTreble * 0.14) * sky;

          // Haze hugging the horizon.
          base += uHaze * 0.34 * smoothstep(0.022, 0.0, abs(sv - HORIZON)) * 0.40;

          // Glow at the vanishing point, swelling on the low end and each beat.
          float d = distance(vec2(vUv.x, sv), vec2(0.5, 0.44));
          float glow = smoothstep(0.20, 0.0, d) * (0.03 + uBass * 0.18 + uPulse * 0.10);
          base += uGlow * glow;

          gl_FragColor = vec4(base, 1.0);
    `;

    /*
     * The dark stage, restrained to a gradient and a vignette.
     *
     * What stood here: a warm lamp band pooled behind the vanishing point, a hot
     * bloomed core, a drifting nebula, a wide below-horizon pool, a city-glow halo
     * and a hand-drawn neon skyline sampled from a 1024x320 canvas. Measured on
     * the rejected frame, the result was a warm cast over the WHOLE viewport —
     * every background column read HSL saturation 95-100% — with horizontal city
     * and grid banding across the upper third. The reference background is a dark
     * gradient, a soft accent vignette behind the album disc, and nothing else;
     * everything that could compete with a note was taken out.
     *
     * **Written in SCREEN space, not in the plane's uv.** Every constant the old
     * version used (HORIZON 0.414, GLOW_Y 0.434, CITY_BASE 0.4185) was measured
     * off one camera rig, and the flat rig moves all of them — the sky band the
     * comments describe is not where it was. A vignette anchored to the frame
     * cannot drift when the camera does, and it is what the reference actually is:
     * a 2D wash behind the playfield, not an object at a depth.
     */
    const stageMain = /* glsl */ `
          /*
           * Screen position from the fragment's OWN clip coordinate, not from
           * gl_FragCoord / uResolution.
           *
           * That pair is only equal when the render target and the drawing buffer
           * agree, and they stop agreeing the moment the adaptive downgrade fires:
           * downgradeTo re-caps the renderer's pixel ratio, but an
           * EffectComposer captures renderer.getPixelRatio() at CONSTRUCTION and
           * keeps sizing its targets from that stale number. Measured on a
           * headless capture, the vignette's centre landed at 0.376 of the frame
           * instead of 0.5 — a warm smudge hugging the LEFT rail with no
           * counterpart on the right, 1.4x the mirrored background. setPixelRatio
           * on the composer fixes the sizing (and is applied), but deriving the
           * position here rather than passing it in removes the whole class of bug.
           * (No backticks anywhere inside a shader string: one closes the template
           * literal and TypeScript then parses the GLSL as code.)
           *
           * vClip is perspective-correct because the divide happens per fragment.
           */
          vec2 s = vClip.xy / max(vClip.w, 1e-4) * 0.5 + 0.5;
          // Clip y is up; the frame is described top-down here so the numbers read
          // the way a screenshot does.
          float fy = 1.0 - s.y;

          /*
           * The floor of the whole frame: a NEUTRAL dark grey, with a
           * barely-there lift toward the top so it is a gradient and not a slab.
           *
           * Neutral because that is what the reference measures — beside the
           * playfield at mid-frame it reads #1b1b1a, HSL saturation 0.8%, 0.0106
           * relative luminance. The accent lives in the vignette and on the notes,
           * not in the air. uSkyBelow still gets a whisper in (0.15) so a theme
           * is not entirely absent from its own background, which at these levels
           * is worth about two units of saturation.
           *
           * 0.0412 linear, solved through the tone curve for that 0.0106 — see
           * DECK_LINEAR for why the number looks four times too big.
           */
          vec3 base = vec3(0.0412) * (0.80 + 0.20 * smoothstep(0.9, 0.0, fy))
                    + uSkyBelow * 0.15;

          /*
           * The vignette: one soft accent halo centred behind where the album disc
           * sits, wider than it is tall.
           *
           * The ellipse is in frame units, so it is the same shape on any aspect.
           * Its centre is ABOVE the track's far end, which is what makes the
           * highway read as running out of a pool of light rather than into a
           * lamp — and it keeps the brightest part of the background out of the
           * band where the topmost notes live.
           *
           * Kept SHORT vertically (0.22) on measurement, not taste: at 0.34 the
           * ellipse reached fy 0.40, and since the opaque track covers the middle
           * of the frame, what was actually visible of it was two warm lobes at the
           * left and right edges of the mid-frame — the one place the reference is
           * flat neutral. It now dies above the track's far end.
           */
          vec2 halo = vec2((s.x - 0.5) / 0.60, (fy - 0.02) / 0.22);
          float hd = length(halo);
          float wash = pow(smoothstep(1.0, 0.0, hd), 2.0);
          base += uAccent * wash * (0.030 + uBass * 0.022 + uPulse * 0.030);

          /*
           * A few faint concentric arcs inside the halo — the one piece of
           * structure the reference background has. Ridged rather than banded
           * (a raised cosine to the sixth), so each arc is a soft ring instead of
           * a step, and multiplied by the halo so they never exist out in the flat
           * black where they would read as scan lines.
           */
          float ring = 0.5 + 0.5 * cos(hd * 26.0 - uTime * 0.35);
          base += uAccent * pow(ring, 6.0) * wash * (0.018 + uTreble * 0.03);

          gl_FragColor = vec4(base, 1.0);
    `;

    const material = new THREE.ShaderMaterial({
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uTreble: { value: 0 },
        uPulse: { value: 0 },
        // THREE.Color linearizes sRGB hex on the way in (ColorManagement is on
        // by default), which is exactly what the shader wants — these used to be
        // hand-written linear literals. Converting here rather than storing
        // linear values in the theme means a palette can be picked in a normal
        // colour picker; see the note on SkyPalette.
        uSkyTop: { value: skyColor(this.theme.sky.top) },
        uSkyHorizon: { value: skyColor(this.theme.sky.horizon) },
        uSkyHorizonAlt: { value: skyColor(this.theme.sky.horizonAlt) },
        uSkyBelow: { value: skyColor(this.theme.sky.below) },
        uSun: { value: skyColor(this.theme.sky.sun) },
        uSunCrown: { value: skyColor(this.theme.sky.sunCrown) },
        uHaze: { value: skyColor(this.theme.sky.haze) },
        uGlow: { value: skyColor(this.theme.sky.glow) },
        /*
         * The song's accent — the only colour the background carries — at 45% of
         * its chroma and normalised to a peak of 1.
         *
         * Both halves matter. The chroma cut is because a raw accent is a
         * near-pure hue (gold linearizes to a blue channel of 0.09), and a wash of
         * it reads HSL 90%+ even at a tenth of a note's luminance, which is the
         * "nothing but the notes is high-chroma" rule broken by the largest object
         * in the frame. The normalisation is so the vignette's *level* is set by
         * the amplitude in the shader rather than by how bright the theme's accent
         * happens to be — a gold theme and a deep-blue one should light the stage
         * to the same depth.
         */
        uAccent: { value: skyAccent(this.accent, 0.45) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec4 vClip;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vClip = gl_Position;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec4 vClip;
        uniform float uTime;
        uniform float uBass;
        uniform float uTreble;
        uniform float uPulse;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSkyHorizonAlt;
        uniform vec3 uSkyBelow;
        uniform vec3 uSun;
        uniform vec3 uSunCrown;
        uniform vec3 uHaze;
        uniform vec3 uGlow;
        uniform vec3 uAccent;

        // Cheap value noise, enough for a soft nebula.
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                     mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
        }



        /**
         * Eye level, and therefore the on-screen horizon.
         *
         * Measured, not derived: a temporary debug stripe every 0.05 of vUv.y
         * showed the visible band is only about 0.19 to 0.53, with the horizon
         * at 0.485 — right at the top. There is only ~95px of sky above the
         * track.
         *
         * Anything sized from the plane's 200x120 dimensions instead of this
         * number comes out enormous: a sun radius that looked small in uv terms
         * filled the whole frame on the first attempt.
         */
        const float HORIZON = 0.414;

        /** Plane is 200x120, so x must be scaled to measure a round sun. */
        const float PLANE_ASPECT = 200.0 / 120.0;
        /** Just above the horizon line, so the disc reads as half-set. Lowered
         * from 0.446 and shrunk so the crown clears the top of the frame under
         * the current (shorter, flatter) track framing instead of being cut. */
        const float SUN_Y = 0.428;
        /** ~7.4 world units. Roughly the sky's height above the horizon. */
        const float SUN_R = 0.05;


        void main() {
          /*
           * The SKY coordinate: this plane's v as if it were still 120 units tall.
           *
           * Every constant in both paths (HORIZON, SUN_Y, GLOW_Y, CITY_*) was
           * measured against a 120-unit plane, and a 120-unit plane cannot cover a
           * portrait frustum below the horizon — the frame's bottom row lands ~85
           * world units under the camera, well past the plane's edge, where the
           * flat scene.background colour showed through as a dead slab. The stage plane
           * is 360 tall for that reason; remapping here is what lets it grow
           * without re-deriving a single one of those numbers.
           */
          float sv = 0.5 + (vUv.y - 0.5) * ${(SKY_PLANE_HEIGHT / 120).toFixed(4)};
          ${this.stage ? stageMain : classicMain}
        }
      `,
    });

    // Sized to overshoot the frustum in every direction: a visible plane edge
    // reads as a hard seam across the sky, and an *unreached* edge shows the flat
    // scene background, which reads as a dead region.
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(200, SKY_PLANE_HEIGHT), material);
    // Classic sits at its original -40, where its sun was tuned to frame on the
    // horizon. Stage sits closer, and at a FIXED distance rather than
    // `-HIGHWAY_LENGTH - 14`: the sky band's constants are measured against this
    // plane's projection, so deriving its depth from the track's length meant
    // lengthening the track silently re-scaled the sky.
    mesh.position.set(0, 8, this.stage ? STAGE_BACKDROP_Z : -40);
    mesh.renderOrder = LAYER.backdrop;
    return mesh;
  }

  /**
   * Soft round sprite for point clouds. Without it `THREE.Points` renders each
   * point as a hard square, which reads as blocky debris rather than as stars
   * or sparks — very obvious once points get large near the camera.
   */

  /**
   * Canvas textures, generated once for the whole session.
   *
   * They carry *shape*, not colour — lane colour arrives via `instanceColor` and
   * the shaders' uniforms — so every `Highway` builds byte-identical ones.
   * `makeDotTexture` alone was called three times in a single construction.
   * **The win is smaller than it looks though: 110.9ms -> 97.7ms, about 13ms.**
   * The `new Highway` phase is ~111ms and texture generation is only a tenth of
   * it — geometry and material construction are the rest. Worth keeping because
   * it is free, but do not expect this to be where a run's setup time goes.
   *
   * Deliberately never disposed: they outlive any one run, which is the point.
   * That is safe because `dispose()` only disposes geometries and materials, and
   * a three.js material does not dispose its maps — and a `Texture` reused across
   * a new `WebGLRenderer` simply re-uploads on first use.
   */
  private static readonly texCache = new Map<string, THREE.CanvasTexture>();

  private static cachedTexture(
    key: string,
    build: () => THREE.CanvasTexture,
  ): THREE.CanvasTexture {
    const hit = Highway.texCache.get(key);
    if (hit) return hit;
    const made = build();
    Highway.texCache.set(key, made);
    return made;
  }

  private static makeDotTexture(): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.35, 'rgba(255,255,255,0.75)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }

    return new THREE.CanvasTexture(canvas);
  }

  /**
   * How much the pad texture's greys are scaled by on the way to the screen.
   *
   * The texture is a LINEAR multiplier (a `CanvasTexture` is `NoColorSpace`, and
   * the pad material is `toneMapped: false`), so a texel of 1.0 would render at
   * relative luminance 1.0. The pad's face has to land near 0.03 and its bezel
   * near 0.26 — authoring those directly would put the face at texel 8 of 255,
   * which bands. Authoring against this and scaling in the material keeps five
   * bits of headroom on the darkest tone.
   */
  private static readonly PAD_TONE_SCALE = 0.42;

  /**
   * The receptor pad: a SOLID rounded slab, not an outline.
   *
   * The row used to be four hollow frames — a bright stroke with the deck showing
   * through the middle, 105px tall on a 2532px frame. Measured against the
   * reference that is 4.1% of frame height against 15.0%, and a note cannot drop
   * INTO an outline; it can only pass over one. So the pad is built the way the
   * reference builds it: a dark textured face, a graded chrome bezel with a lit
   * far lip and a dark outer lip, and (in `makeRimTexture`, which is the additive
   * half) one bright dash across the midline.
   *
   * Canvas v=1 is the top row and the quad's FAR edge (`rotation.x = -PI/2` plus
   * the texture's default flipY), so "top" here really is up-screen.
   */
  private static makePadTexture(aspect: number): THREE.CanvasTexture {
    const w = 192;
    const h = Math.round(w * aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    const scale = Highway.PAD_TONE_SCALE;
    // A linear target luminance as a 0-255 texel under PAD_TONE_SCALE.
    const tone = (linear: number): number =>
      Math.max(0, Math.min(255, Math.round((linear / scale) * 255)));

    if (ctx) {
      const r = Math.round(w * 0.16);
      /*
       * **0.105 of the pad, not 0.085.** The bezel is the shoulder the three
       * specular bands are laid on, and once the board narrowed (see LANE_WIDTH)
       * the whole roll spanned ~13 device px at the receptor row with ~4px per
       * band — too fine for a light-to-dark-to-light profile to survive, so it
       * averaged back into the flat bright outline the critique kept reporting.
       * At 0.105 the roll spans ~17px on a ~183px pad, which is the reference's
       * own proportion, and each band gets 5-7px to say something with.
       * Both halves of the pad read this, so they must move together.
       */
      /*
       * **0.070, and the band is now well under half what it was — measured, not felt.**
       *
       * At 0.105 the rim profiled 19-27 device px at the near row against the
       * reference's 12-16, i.e. ~1.6x too wide, and a rim that wide cannot help
       * reading as a drawn outline whatever its cross-section says: there is
       * simply too much of it. The paragraph above argued the opposite — that a
       * three-band roll needed the width to survive — and that argument is dead,
       * because the cross-section is no longer three bands trying to average into
       * a roll. It is one dark bevel and one hairline specular (see
       * `makeRimTexture`), and a hard two-tone survives minification precisely
       * because it has no midtones to average into.
       */
      /*
       * **0.100 — the two-tone was right and the AREA was wrong.**
       *
       * At 0.070 the lit part of the rim profiled 9 device px against the
       * reference's 14 (233 hairline, then a 12px plateau at 155-165, then a 190
       * lip before the groove). Ours reached the right PEAK over about a third of
       * the reference's lit area, so at 1x it collapsed to a 2px white line and
       * read as a keyline stroked round a die-cut hole. The fix is not a brighter
       * hairline — 230 is already correct — it is a plateau outboard of it, and a
       * plateau needs width to exist. `makeRimTexture` spends it; both halves of
       * the pad read this number and they must move together.
       */
      const bezel = Math.round(w * 0.086); // 0.086: 0.100 profiled 19 device px of lit rim against the reference's 14.

      // The bezel SUBSTRATE, and it is now DARK.
      //
      // It used to run linear 0.12-0.22, which put the opaque half of the rim at
      // ~110 display on its own; the additive plateau on top took the whole band
      // to a flat 140-146 with a symmetric bright edge either side. That is a
      // rounded plastic bevel — light in the middle, light at both edges, no
      // direction. Real machined metal seen at this angle is mostly SHADOW with
      // one specular line where the roll faces the lamp, so the substrate is the
      // shadow (target ~60 display) and `makeRimTexture` supplies the one line.
      const metal = ctx.createLinearGradient(0, 0, 0, h);
      metal.addColorStop(0, `rgb(${tone(0.040)},${tone(0.040)},${tone(0.040)})`);
      metal.addColorStop(0.2, `rgb(${tone(0.032)},${tone(0.032)},${tone(0.032)})`);
      metal.addColorStop(0.6, `rgb(${tone(0.046)},${tone(0.046)},${tone(0.046)})`);
      // The near lip is the one edge that catches the room, so it stays the
      // brightest part of the substrate — but only just. The pad's light
      // direction is carried by the additive specular, not by this.
      metal.addColorStop(0.94, `rgb(${tone(0.062)},${tone(0.062)},${tone(0.062)})`);
      // The SHADOW LINE under the front lip. A machined part standing proud of a
      // surface has a dark line beneath its brightest edge; without it the bezel's
      // highlight meets the deck directly and the pad reads as a stroked outline
      // laid on the track rather than as an object seated in it. Paired with the
      // specular lip in `makeRimTexture`, which sits just above this.
      metal.addColorStop(1, `rgb(${tone(0.02)},${tone(0.02)},${tone(0.02)})`);
      /*
       * THE SILHOUETTE IS FEATHERED, over `fe` texels.
       *
       * Canvas antialiases a fill over about one texel; magnified onto ~220
       * device px at the near row that is a hard alpha cliff, and at 7x the pad's
       * outer boundary against the deck stair-stepped in three or four discrete
       * jumps down its left edge and around the top-left corner — an aliased
       * silhouette on the highest-contrast edge in the lower frame. The rings
       * below spend ~2 device px on an alpha ramp instead. `makeRimTexture`
       * starts its sweep at the same fraction (bezel * 0.12) so the two halves
       * of the pad still share one outer edge.
       */
      const fe = Math.max(2, Math.round(w * 0.012));
      ctx.fillStyle = `rgb(${tone(0.018)},${tone(0.018)},${tone(0.018)})`;
      for (let k = fe; k >= 1; k--) {
        ctx.globalAlpha = 1 - k / (fe + 1);
        Highway.roundRectPath(ctx, fe - k, fe - k, w - (fe - k) * 2, h - (fe - k) * 2, r);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      Highway.roundRectPath(ctx, fe, fe, w - fe * 2, h - fe * 2, r);
      ctx.fillStyle = metal;
      ctx.fill();

      // The dark outer lip. Without it the bezel's bright edge meets the deck
      // directly and the pad reads as a sticker rather than as a part seated in
      // a surface.
      ctx.lineWidth = Math.max(2, Math.round(w * 0.022));
      ctx.strokeStyle = `rgb(${tone(0.018)},${tone(0.018)},${tone(0.018)})`;
      ctx.stroke();

      // The face — darker than the deck around it, which is what makes it read
      // as a recess rather than a plate.
      // Authored ~1.5x the target: minification at the far end of a 3:1 slab
      // eats about a third of the face's value, so the numbers that land on the
      // reference's 0.019-0.032 are not the numbers that read it here.
      //
      //
      // Retuned against the reference and against the STEEPER camera, which is
      // most of the story: at the old down-angle these texels landed on L10.1,
      // a black void between two chrome rails, and at the new one the very same
      // numbers land near L19 — the pad is far less foreshortened, so far less of
      // its dark face is averaged away against the bright rim by the mip chain.
      // The target is the reference's L17.9, and the ordering is the point: the
      // pad face has to stay DARKER than the deck around it (L22-23 mid-track) or
      // it stops being a recess. Authored ~1.4x the target because minification at
      // the far end of a 3:1 slab still eats about a third of the value.
      //
      // Lifted ~45% again with the (40.6, 65.9) rig. The longer lens foreshortens
      // the pad's depth harder still, so the mip chain averages more of the face
      // away against the bright rim beside it: at the previous numbers the row
      // rendered as four pure-black holes cut in the deck with a white stroke
      // round them, which is the "reads as UI, not hardware" report. The ordering
      // that matters is unchanged — the face stays darker than the deck (L22-23
      // mid-track), because a face at or above the deck stops being a recess.
      const inner = ctx.createLinearGradient(0, 0, 0, h);
      inner.addColorStop(0, `rgb(${tone(0.046)},${tone(0.046)},${tone(0.046)})`);
      inner.addColorStop(0.5, `rgb(${tone(0.067)},${tone(0.067)},${tone(0.067)})`);
      inner.addColorStop(1, `rgb(${tone(0.055)},${tone(0.055)},${tone(0.055)})`);
      Highway.roundRectPath(
        ctx,
        bezel,
        bezel,
        w - bezel * 2,
        h - bezel * 2,
        Math.round(r * 0.7),
      );
      ctx.fillStyle = inner;
      ctx.fill();

      /*
       * THE PAD FACE IS FLAT. NO WEAVE. Do not put the diamond lattice back.
       *
       * It was drawn here at three successive amplitudes (0.0075, 0.012, 0.004)
       * chasing "the pad is cut out of the same material as the deck", and the
       * amplitude was never the problem: the pad is a 192x672 canvas squeezed onto
       * ~55 device rows at the near end, so a lattice whose cell is ~38 texels
       * lands under two pixels and beats against the pixel grid. Read at 3x, the
       * face carried visible moire — a shimmering screen door inside the one
       * element the player is aiming at. The deck can hold a weave because its uv
       * is hyperbolic in v (see Highway.weavePhase) and its cell keeps a constant
       * SCREEN size; the pad's uv is linear over a hard-foreshortened quad and
       * cannot. A flat face is also what the reference has.
       */
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 8;
    return texture;
  }

  /**
   * The pad's LIGHT: a bezel highlight and one bright dash across the midline.
   *
   * Additive and over-driven, so this is the half that blooms; the slab itself
   * (`makePadTexture`) is opaque and dark. Splitting them is what lets the pad be
   * a solid object *and* the brightest non-note thing in the frame.
   *
   * **The dash is the whole point of this texture.** The row previously marked
   * the tap instant with two short ticks reaching in from the side walls, leaving
   * 114px of bare deck between them — measured, the pad centre read 0.032
   * relative luminance where the reference's reads 0.823. The exact instant of
   * the tap was the one element not drawn. It is one continuous bar at ~70% of
   * the pad's width, centred on v = 0.5, which is z = 0 exactly: the quad is
   * centred on the hit line and the texture maps linearly along it, so the mark
   * cannot drift off the judged moment the way a separately-positioned object
   * can.
   */
  private static makeRimTexture(aspect: number): THREE.CanvasTexture {
    // 384, not 192. The three bands span ~16 texels at 192 and land on ~14
    // device px at the receptor row, so minification averaged the light-dark-light
    // roll into one flat value — the profile was authored and then thrown away by
    // the mip chain. At 2x the bands survive the trip.
    const w = 384;
    const h = Math.round(w * aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      const r = Math.round(w * 0.16);
      /*
       * **0.105 of the pad, not 0.085.** The bezel is the shoulder the three
       * specular bands are laid on, and once the board narrowed (see LANE_WIDTH)
       * the whole roll spanned ~13 device px at the receptor row with ~4px per
       * band — too fine for a light-to-dark-to-light profile to survive, so it
       * averaged back into the flat bright outline the critique kept reporting.
       * At 0.105 the roll spans ~17px on a ~183px pad, which is the reference's
       * own proportion, and each band gets 5-7px to say something with.
       * Both halves of the pad read this, so they must move together.
       */
      /*
       * **0.070 — cut from 0.105, and it must track `makePadTexture`'s copy exactly.**
       * See the note there: the rim measured 19-27 device px against a reference
       * that measures 12-16. Both halves of the pad read this number.
       */
      // **0.100 — see the long note in `makePadTexture`.** The two-tone had the
      // right peak over a third of the reference's lit area; the plateau below
      // needs room to exist.
      const bezel = Math.round(w * 0.086); // 0.086: 0.100 profiled 19 device px of lit rim against the reference's 14.

      /*
       * THE BEZEL IS THREE BANDS, NOT ONE GRADIENT.
       *
       * A single soft stroke is what made the row read as a painted grey outline:
       * measured on the shipped frame the pad's vertical rails peaked at 0.084 /
       * 0.107 / 0.259 relative luminance at three depths, against a reference whose
       * rails peak at 0.765-0.838 with a legible three-part profile — an outer
       * highlight near 0.5, a satin plateau near 0.33, and a hot inner edge near
       * 0.8. That 3-10x miss is the difference between a drawn rectangle and
       * machined chrome, and the chrome is what makes four dark pads read as a row
       * against a black deck.
       *
       * Each band is its own stroke at its own inset, and each carries a vertical
       * gradient so the near lip is the brightest edge on the pad (the reference's
       * measures 0.95) and the far one the dimmest (0.27). They do not overlap:
       * this layer is ADDITIVE, so two strokes crossing would sum into a value
       * neither of them says.
       */
      /*
       * Thinner and pushed OUTWARD, both measured against the reference.
       *
       * The rim ran 23 device px at the receptor row against the reference's 15,
       * so it read as a thick white outline rather than a bezel; and because the
       * bright band stopped ~3% short of the quad on each side, the pad measured
       * 94.7% of its lane where the reference's is 96.6% and the groove between
       * two pads came out 16px against its 7. Starting the outer band at 0.08 of
       * the bezel (just inside the dark seating lip, which still shows) fixes the
       * measured width, and the narrower bands fix the run.
       */
      /*
       * The vertical gradient on each band is DIRECTIONAL LIGHTING, and it is
       * steeper than it was: measured, ours ran within 20 L of itself all the way
       * round, so the rim read as a constant-value stroke rather than as metal
       * under a lamp. The reference's rims fall from a hot near lip to a dim far
       * one, which is what gives a flat quad a light direction.
       */
      /*
       * **Widened and lifted, because the row was reading as a die-cut hole.**
       *
       * The three bands spanned 0.62 of the bezel between them at alphas peaking
       * 0.96/0.42/0.72, and on the shipped frame that resolved to a uniform ~3px
       * white stroke around a black face — UI, not hardware. The reference's pads
       * are physical plates: an 8-10px chrome shoulder with a legible light
       * gradient from a near-white near lip down to mid-grey at the far one. The
       * bands now span the bezel almost end to end (0.06 -> 0.86) and the outer
       * two carry most of the width, so the shoulder has body rather than being
       * one hot hairline with two faint companions beside it.
       */
      /*
       * **The contrast ACROSS the band is what makes it metal, and it was the
       * one axis with no gradient on it.**
       *
       * Every band above carried a vertical (along-track) ramp, so on any
       * horizontal scanline through the row all four pads' side rails read the
       * same value from their outer edge to their inner one — a constant-value
       * stroke, i.e. a neon outline. Profiled across a rail on the shipped
       * capture: 152,187,202,204,190,174,166,175,187,191,190,186,174,130 — a
       * 1.2:1 swing over 14px. The reference's, measured the same way:
       * 234,222,164,162,162,162,160,160,160,159,155,186,174 — a near-white outer
       * highlight, a 160 satin plateau, a brighter inner lip, 1.46:1, and it
       * reads as a machined shoulder because a cylinder lit from outside is
       * exactly that profile.
       *
       * So the middle band drops to a dark satin instead of merely a dimmer
       * white, and the outer one goes to the top of the range. Two bright edges
       * with a dark trough between them is a chrome roll; three parallel whites
       * is a printed border.
       */
      /*
       * **ONE BAND WITH A GRADIENT ACROSS IT, not three strokes.**
       *
       * The three-band version was the right *idea* and the wrong *construction*,
       * and cropping ours beside the reference at 2x makes it obvious: the
       * reference's bezel is a single continuous chrome shoulder that rolls from a
       * near-white outer edge, through a satin plateau, to a slightly brighter
       * inner lip and then off a cliff into the dark face. Ours drew three
       * separate 5px strokes with gaps between them, which at the receptor row
       * reads as a striped decal — "a flat white outline", exactly as reported,
       * twice.
       *
       * Profiled across the reference's rail: 234,222 / 164,162,162,160,160 /
       * 186,174 — normalised, 1.0 -> 0.70 plateau -> 0.79 inner lip -> face. That
       * curve is `shoulder` below, swept as ~40 hairline strokes so the roll is
       * continuous rather than quantised into bands. Each stroke still carries the
       * vertical (along-track) gradient that gives the metal its light direction:
       * the near lip is the brightest edge on the pad, the far one the dimmest.
       */
      /*
       * **A HARD TWO-TONE, NOT A ROLL. This is the third construction and the
       * previous two failed for the same reason.**
       *
       * Every version above — three separate bands, then a 40-stroke continuous
       * shoulder — authored a light-to-dark-to-light *roll* across the bezel and
       * then handed it to a mip chain that compressed 17 texture px into ~20
       * device px on a quad foreshortened 3.5:1. Profiled on the shipped capture
       * the result was 140-146 flat with a symmetric bright edge either side and a
       * peak of 167: a rounded plastic bevel with no light direction at all,
       * against a reference that measures a 230-236 specular immediately inside a
       * ~60 dark bevel. A midtone-rich profile cannot survive that trip, because
       * averaging IS what the mip chain does; a two-tone can, because there are no
       * midtones to average.
       *
       * So the bezel substrate is the dark tone (`makePadTexture`, ~60 display)
       * and this layer contributes almost nothing over its outer 55% and one
       * hairline specular over the next 25%. The line lands ~4-5 device px on a
       * ~240px pad — the reference's own proportion — and it is bright enough that
       * even if minification halves it, what is left is still a specular and not a
       * grey stroke.
       */
      /*
       * **THE FOURTH CONSTRUCTION: hairline + PLATEAU + outer lip, in that order
       * outboard.** The two-tone above was measured and it produced the right
       * peak (230, against the reference's 233) over about a third of the
       * reference's lit AREA — 9 device px of which only ~4 cleared 200, then a
       * falling ramp. Cropped beside the reference at 3x that is a white keyline
       * stroked round a die-cut hole, not a machined bezel.
       *
       * The reference, profiled from the pad's dark FACE outward at y=1600:
       *   face 45 | 233 | 163,164,162,161,160,161,160,159,155 | 190,173 | 107 | groove 9
       * i.e. a hairline against the face, a flat ~160 plateau ~12px wide, a
       * second ~190 lip at the outer edge, then the dark seating groove. The
       * plateau IS the top face of the bezel; it is what makes the pad read as a
       * part standing on the deck rather than a hole cut into it, and it is also
       * why the reference's rim never resolves to a sub-pixel silhouette.
       *
       * Read through the material's own gain (see `buildReceptors`: exposure
       * 1.55 x resting opacity 0.62 = 0.96), an alpha lands near sRGB(0.96a),
       * and MEASURED on the capture: 1.00 -> 225, 0.40 -> 160, 0.63 -> 181. Those are the reference's three
       * numbers directly, which is the whole reason the exposure and the profile
       * were retuned together rather than one at a time.
       */
      /*
       * DRAWN AS BANDS, NOT AS A SWEEP OF OVERLAPPING STROKES.
       *
       * The previous versions swept 34-40 hairlines at 1.25x their own spacing
       * and relied on the overlap to make the profile continuous. `source-over`
       * does not add, but it does composite — a stroke at alpha a over one at
       * alpha b leaves a + b(1-a), so an overlapped region is brighter than
       * either band asks for. That is invisible on a monotonic roll and fatal on
       * a FLAT plateau, which would come out rippled at exactly the spatial
       * frequency the mip chain then turns into a moire. Each band is one stroke
       * of its own width, edge to edge, so the plateau is flat by construction.
       *
       * t: 0 at the pad's outer (feathered) edge, 1 where the bezel meets the
       * dark face. The sweep starts at bezel * 0.12, which is the slab's own
       * feathered silhouette (see `makePadTexture`'s `fe`), so the outer lip
       * cannot hang off the part.
       */
      const span = bezel * 0.88;
      const band = (t0: number, t1: number, a: number): void => {
        const width = span * (t1 - t0);
        if (width < 0.4 || a <= 0.01) return;
        const inset = bezel * 0.12 + span * t0 + width / 2;
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        // far / mid / near. The swing is the light direction. Shallow, because
        // the plateau has to stay readable along the pad's whole length — a
        // steep ramp deletes the far half of a band and the pad then reads as
        // two disconnected brackets.
        grad.addColorStop(0, `rgba(255,250,245,${(a * 0.62).toFixed(3)})`);
        grad.addColorStop(0.45, `rgba(255,250,245,${(a * 0.85).toFixed(3)})`);
        grad.addColorStop(1, `rgba(255,250,245,${a.toFixed(3)})`);
        ctx.lineWidth = width;
        ctx.strokeStyle = grad;
        Highway.roundRectPath(
          ctx,
          inset,
          inset,
          w - inset * 2,
          h - inset * 2,
          Math.max(2, r - inset),
        );
        ctx.stroke();
      };

      // An alpha RAMP out of the dark seating groove. The hard cliff that used
      // to be here put the highest-contrast edge in the lower frame on a
      // sub-pixel boundary, and it stair-stepped down the pad's left side at 7x.
      band(0.04, 0.09, 0.22);
      band(0.09, 0.14, 0.45);
      // The outer lip — the reference's 190. Brighter than the plateau because
      // it is the edge that turns toward the room.
      band(0.14, 0.3, 0.63);
      // THE PLATEAU: the bezel's top face. Flat, wide, and the element the
      // previous three constructions all lacked.
      band(0.3, 0.86, 0.4);
      // THE SPECULAR HAIRLINE, hard against the dark face — the reference's 233.
      // It is at the INNER edge, so the pad's bright mass sits outboard of it and
      // the whole part reads as standing proud of the deck rather than as a hole
      // cut into it.
      band(0.86, 1.0, 1.0);

      // The timing dash. Measured against the reference's own: four runs of 184px
      // on a 1080-wide frame, i.e. 17.0% of the frame and ~73% of the pad. At 0.70
      // of the pad ours measured 162px = 13.8%, so it goes to 0.78.
      const dashW = w * 0.78;
      // 0.09 of the pad's depth, which lands ~32 screen px at the receptor row on
      // a 390x844 phone at DPR 3 — the reference's is 30px on a frame of the same
      // height. It used to be authored at 0.155 to compensate for a dash that
      // measured 15px, but the compression was the rim quad's broken scale (see
      // `buildReceptors`), not the mip chain, and over-authoring on top of the fix
      // would put a 55px bar across the row.
      //
      // 0.115 once the camera moved back again. The rig is a longer lens from
      // further out, which foreshortens the pad's depth harder — the same 0.09
      // of texture landed visibly thinner on screen than the number above
      // describes, and the mark read as a hairline rather than the reference's
      // chunky rounded bar. The authoring number tracks the rig; the *screen*
      // target (~30px on a frame this tall) has not moved.
      const dashH = Math.max(3, h * 0.115);
      /*
       * PARALLEL LONG EDGES — the corner radius is 0.28 of the height, not half of
       * it.
       *
       * At `dashH / 2` the rounded caps ate 90 of the shape's 150 texels, so the
       * mark was a lens: measured, 199px wide (which is right) but tapering to
       * 11-17px fragments a third of the way out from centre, so it read as a
       * specular glint rather than as a deliberate marker — and that is what let
       * the connector band's own edge compete with it for the eye. The reference's
       * is a rounded rectangle with flat edges and a flat top (184x30px at
       * 0.804-0.844).
       */
      Highway.roundRectPath(ctx, (w - dashW) / 2, h / 2 - dashH / 2, dashW, dashH, dashH * 0.28);
      /*
       * 0.62, not 1.0. The exposure on this material nearly doubled so the bezel
       * specular could reach the reference's ~230 (see `buildReceptors`), and the
       * dash rides the same exposure. Left at 1.0 it clipped, and a clipped dash
       * is both the brightest thing in the lower frame — which the row must not be
       * — and a bloom source sitting on the notes' landing point. 0.62 holds it
       * where it measured before, a little under the specular line beside it.
       */
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.fill();

      /*
       * THE FRONT LIP — the one element that makes the row read as four machined
       * parts rather than four drawn rectangles.
       *
       * The reference's pads carry a thick specular band along their bottom-front
       * edge with a dark shadow line under it (`makePadTexture` draws that half).
       * Ours had a constant-width, constant-value stroke all the way round and a
       * soft white bloom instead of a crisp edge, so nothing said which way the
       * light came from. Canvas row h is the NEAR edge (see the class note on
       * flipY), so this is the bottom of the pad on screen.
       */
      /*
       * **TWO bands, because a plate has THICKNESS.** It was one gradient, so
       * the near edge terminated in the same value the top and side edges do —
       * measured, the perimeter read within a luma of itself the whole way
       * round, which is the "no light direction" failure at the silhouette level
       * rather than the cross-section level. The reference's near edge shows the
       * bezel's top face and then a second, dimmer band under it: the extruded
       * SIDE face of the part, seen because the camera looks down on the row.
       * `makePadTexture`'s substrate supplies the dark contact line under that,
       * and the deck shader darkens a short band of track beneath the whole row
       * (see `uHitV` / the pad shadow term) so the part is seated rather than
       * printed.
       */
      const faceH = Math.max(2, bezel * 0.42);
      const sideH = Math.max(2, bezel * 0.40);
      const faceTop = h - bezel * 0.45 - faceH - sideH;
      const lipGrad = ctx.createLinearGradient(0, faceTop, 0, faceTop + faceH);
      // 0.46, not 0.86 — the same exposure change the dash absorbs. The lip is a
      // wide bright rectangle across the pad's near edge, so it contributes more
      // total light to the lower frame than anything else in this texture; at the
      // new exposure it was the single reason the row still out-read the notes.
      lipGrad.addColorStop(0, 'rgba(255,255,255,0.10)');
      lipGrad.addColorStop(1, 'rgba(255,255,255,0.46)');
      ctx.fillStyle = lipGrad;
      ctx.fillRect(r * 0.85, faceTop, w - r * 1.7, faceH);
      // The side face: about half the top face's value, and it must be FLAT —
      // a gradient here would blend the two bands back into the single soft roll
      // this replaces. Inset slightly so the extrusion reads as narrower than
      // the top, which is what the camera's down-angle would actually show.
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; // 0.12, not 0.19: at 0.19 the side face measured 182 against the top face's 223 — 82%, too close to read as a separate plane.
      ctx.fillRect(r * 1.0, faceTop + faceH, w - r * 2.0, sideH);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 8;
    return texture;
  }

  /**
   * A hollow rounded-rectangle frame — the CLASSIC path's receptor only.
   *
   * The stage path uses `makePadTexture` + `makeRimTexture` instead. Kept because
   * nothing ships `style: 'classic'` and its receptors are tuned against a bright
   * neon track, where a dark slab would be a hole rather than a target.
   */
  private static makeFrameTexture(aspect: number): THREE.CanvasTexture {
    // Matches the tile footprint and its rounding, so a bar drops into a slot of
    // the same rounded shape. Aspect-driven like the tile so corners stay round.
    const w = 256;
    const h = Math.round(w * aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      // The stroke is centred on the path, so the inset is HALF the line width and
      // no more: that puts the rim's outer edge exactly on the quad boundary, and
      // the quad's world scale therefore *is* the visible rectangle. It used to
      // inset 10% of the canvas on every side, which quietly made the drawn target
      // 80% of the quad — so a frame scaled to the tile footprint still measured
      // 1.59x smaller than the tile on screen, and no note ever looked like it
      // landed in anything.
      const line = Math.round(w * 0.075);
      const r = Math.round(w * 0.19);
      Highway.roundRectPath(ctx, line / 2, line / 2, w - line, h - line, r);

      /*
       * A machined socket, not a traced rectangle.
       *
       * The frames were a ~4px wireframe outline with a flat 0.06 wash, which is
       * nothing like the glowing tap target the genre uses as its signature
       * near-field element — and the receptor row is required to be the
       * brightest non-note thing in the frame. Three parts do the work: a graded
       * floor so the socket has an inside, a thick rim, and a hot lip along the
       * FAR edge with a dimmer one along the near edge, which is what gives a
       * flat quad a direction of light.
       *
       * Canvas v=1 is the top row and the quad's far edge (`rotation.x = -PI/2`
       * plus the texture's default flipY), so "top" here really is up-screen.
       */
      // Halved (0.13/0.045/0.09 -> 0.07/0.022/0.048). This layer is ADDITIVE and
      // over-driven 2.8x by the frame's colour, so it was putting ~0.36 of the
      // lane hue back into the socket the pad exists to keep dark — the two
      // elements were fighting and the haze won. It is a graded floor, not a fill.
      const floor = ctx.createLinearGradient(0, 0, 0, h);
      floor.addColorStop(0, 'rgba(255,255,255,0.07)');
      floor.addColorStop(0.45, 'rgba(255,255,255,0.022)');
      floor.addColorStop(1, 'rgba(255,255,255,0.048)');
      ctx.fillStyle = floor;
      ctx.fill();

      /*
       * The rim is BRUSHED CHROME, not a uniform stroke.
       *
       * A single flat alpha around the whole path is a UI outline: it has no
       * light direction, so the pad reads as a rounded rectangle drawn on the
       * deck rather than as a machined part sitting in it. The reference's rim
       * is unmistakably a gradient — bright along the lower-left where the
       * scene's light falls, darker across the top edge where it turns away.
       *
       * Diagonal rather than vertical so the highlight runs along the pad's long
       * side and one short side, which is the same lit-edge language the note
       * slab's own side wall uses. 0.95 at the hot end, not 1: the two lips
       * below still have to be able to read as brighter than the rim, and a
       * canvas cannot express a value over 1.
       */
      const rim = ctx.createLinearGradient(w, 0, 0, h);
      rim.addColorStop(0, 'rgba(255,255,255,0.42)');
      rim.addColorStop(0.3, 'rgba(255,255,255,0.62)');
      rim.addColorStop(0.62, 'rgba(255,255,255,0.95)');
      rim.addColorStop(1, 'rgba(255,255,255,0.7)');
      ctx.lineWidth = line;
      ctx.strokeStyle = rim;
      ctx.stroke();

      ctx.lineCap = 'round';
      for (const [y, alpha] of [
        [line / 2, 1],
        [h - line / 2, 0.5],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(line / 2 + r * 0.7, y);
        ctx.lineTo(w - line / 2 - r * 0.7, y);
        ctx.lineWidth = line * 0.6;
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.stroke();
      }

      /*
       * Index marks at the judgement moment, one reaching in from each side wall.
       *
       * The row needs *something* that says "this exact depth is the moment", and
       * the thing that used to do it was a full-width bar of near-white light laid
       * straight across all four sockets — reported, correctly, as placeholder art.
       * Two short ticks are the same information as a sight line on an instrument:
       * they mark the depth, they belong to the frame they are cut into, and they
       * leave the middle of the target clear for the tile that lands in it.
       *
       * v = 0.5 is z = 0 exactly: the quad is centred on the hit line and the
       * texture maps linearly along it, so the marks cannot drift off the judged
       * moment the way a separately-positioned object can.
       */
      const tick = w * 0.19;
      ctx.beginPath();
      ctx.moveTo(line / 2, h / 2);
      ctx.lineTo(line / 2 + tick, h / 2);
      ctx.moveTo(w - line / 2, h / 2);
      ctx.lineTo(w - line / 2 - tick, h / 2);
      ctx.lineWidth = line * 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 8;
    return texture;
  }

  /*
   * `makeSocketTexture` — a blurred rounded-rect fill that stood in for the pad's
   * dark well — is gone. The pad is a real slab with a face, a bezel and a lip
   * now (`makePadTexture`), and a soft mask multiplied by one flat colour cannot
   * express any of that.
   */

  /** Rounded-rect path helper; `roundRect` is not in every target's 2D context. */
  private static roundRectPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Randomize a star's lateral position. Depth is set by the caller. */
  /**
   * Seed one star at depth `z`, inside the camera's own view corridor.
   *
   * It used to be a fixed world band (`y = 4 + rand * 44`), which was in frame
   * only because the old camera sat 6 units back at eye level. The flat rig looks
   * DOWN a long lens from 30 units out, so at z = -130 the frame covers world y
   * -79 to -20 and every star in that band was off the top of the screen — 560
   * points updated per frame, drawn nowhere.
   *
   * Centring on the view axis instead makes the field frame-relative: the
   * corridor widens with distance exactly as the frustum does, so it stays full
   * whatever the rig or the aspect. `y` is the interesting one; the horizontal
   * spread is deliberately wider than the frustum so stars also drift in from the
   * sides rather than all radiating from the vanishing point.
   */
  private placeStar(i: number, z: number): void {
    // Distance along the view axis at which the axis reaches this depth.
    const s = (z - this.camDistance) / this.viewDirZ;
    const axisY = this.camHeight + this.viewDirY * s;
    const half = s * STAR_CORRIDOR_TAN;
    this.starPositions[i * 3] = (Math.random() - 0.5) * half * 1.8;
    this.starPositions[i * 3 + 1] = axisY + (Math.random() - 0.5) * 2 * half * 0.92;
    this.starPositions[i * 3 + 2] = z;
  }

  private buildStars(): THREE.Points {
    const colors = new Float32Array(STAR_COUNT * 3);
    const tint = new THREE.Color();

    const accentHsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(this.accent).getHSL(accentHsl);

    // Only the active count is placed and drawn; the buffers stay at capacity so
    // a downgrade lowers `starCount` without reallocating.
    for (let i = 0; i < this.starCount; i++) {
      // Seed depth across the whole corridor so the field starts full rather
      // than arriving as one wave.
      this.placeStar(i, STAR_FAR_Z + Math.random() * (STAR_RECYCLE_Z - STAR_FAR_Z));
      this.starSpeeds[i] = 7 + Math.random() * 17;

      /*
       * Sparkles in the song's accent, not a blue-violet starfield.
       *
       * It was `setHSL(0.55 + rand * 0.28, 0.75, ...)` — a fixed 100-degree sweep
       * of blue through pink at three-quarters saturation, i.e. the one part of
       * the background carrying colours no theme chose. The reference's sparkles
       * are accent-tinted specks. A narrow hue jitter and a low saturation keep
       * them from reading as a flat wash of dots.
       */
      tint.setHSL(
        accentHsl.h + (Math.random() - 0.5) * 0.04,
        accentHsl.s * (0.18 + Math.random() * 0.22),
        0.62 + Math.random() * 0.3,
      );
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
      this.starBase[i * 3] = tint.r;
      this.starBase[i * 3 + 1] = tint.g;
      this.starBase[i * 3 + 2] = tint.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.starPositions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Draw only the active stars, not the full capacity buffer.
    geometry.setDrawRange(0, this.starCount);

    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        // Small on purpose. With size attenuation the near ones swell as they
        // pass the camera, so anything much larger reads as blobs drifting over
        // the track rather than as distant stars.
        size: 0.22,
        map: Highway.cachedTexture('dot', () => Highway.makeDotTexture()),
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        // Size attenuation is what sells the depth: stars swell as they pass.
        sizeAttenuation: true,
      }),
    );
    points.renderOrder = LAYER.stars;
    points.frustumCulled = false;
    return points;
  }

  /** Fly the starfield toward the camera, recycling stars once they pass. */
  private updateStars(dt: number, bass: number): void {
    const boost = 1 + bass * 2.4;
    const colors = this.stars.geometry.attributes['color']!.array as Float32Array;

    for (let i = 0; i < this.starCount; i++) {
      const zi = i * 3 + 2;
      const z = (this.starPositions[zi] ?? 0) + (this.starSpeeds[i] ?? 0) * boost * dt;

      if (z > STAR_RECYCLE_Z) {
        this.placeStar(i, STAR_FAR_Z + Math.random() * 10);
      } else {
        this.starPositions[zi] = z;
      }

      // Zero AT the recycle point, so a star is genuinely gone before the
      // playfield rather than merely dim. Squared so it dies early rather than
      // lingering across the whole mid-field.
      const near = Math.max(
        0,
        Math.min(1, (-(this.starPositions[zi] ?? 0) + STAR_RECYCLE_Z) / STAR_FADE_Z),
      );
      const dim = near * near;
      colors[i * 3] = (this.starBase[i * 3] ?? 0) * dim;
      colors[i * 3 + 1] = (this.starBase[i * 3 + 1] ?? 0) * dim;
      colors[i * 3 + 2] = (this.starBase[i * 3 + 2] ?? 0) * dim;
    }

    this.stars.geometry.attributes['position']!.needsUpdate = true;
    this.stars.geometry.attributes['color']!.needsUpdate = true;
  }

  /**
   * The neon grid the highway stands on.
   *
   * The signature of the whole look, and the piece that was missing: without it
   * the track floats in black space, while the menu behind it has a full grid
   * floor. This is what makes the game and the shell read as one place.
   *
   * Three things keep it from becoming noise:
   *
   *  - It is **cut out under the highway**. The floor is translucent, so grid
   *    lines would otherwise run straight through the lanes and cross the notes
   *    the player is trying to read.
   *  - It **stops short of the backdrop**. The sky plane sits at z=-40 with
   *    `depthWrite: false`, so it cannot occlude anything; a ground plane
   *    running past it would draw *over* the sky. This one fades to nothing
   *    well before it gets there and dissolves into the horizon haze.
   *  - It is held far below the bloom threshold. Anything that glows here
   *    competes with the notes.
   */
  private buildGround(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uScroll: { value: 0 },
        uBass: { value: 0 },
        uPulse: { value: 0 },
        // How much of the middle to keep clear for the track. Just past the real
        // half-width so the cut lands outside the lane tints rather than exactly
        // on their edge, where it would read as a seam.
        //
        // +0.5, not +1.2. The wider gap left an unlit margin ~60px across running
        // the whole length outside each rail, and any note's halo spilling into it
        // read as a dark rounded shadow *beside* the track — it was reported as a
        // stray object. The grid now comes up to the rail, so there is no unlit
        // channel for a halo to sit in.
        uClear: { value: this.deckHalfWidth + 0.4 },
        /*
         * The ground echoes the first two lane colours rather than carrying its
         * own pair. That keeps a theme coherent for free — the scenery is
         * visibly made of the same neon as the track.
         *
         * On the dark stage both are pulled most of the way to neutral. The lanes
         * are now one accent family (see `laneTones`), so a grid drawn from two of
         * them is the accent painted across the whole floor either side of the
         * track — which is exactly the wash the background restraint pass exists to
         * remove. The classic path keeps the full hues: there the grid IS the look.
         */
        uGridA: {
          value: this.stage
            ? skyColor(laneColor(this.theme, 0)).lerp(new THREE.Vector3(1, 1, 1), 0.72)
            : skyColor(laneColor(this.theme, 0)),
        },
        uGridB: {
          value: this.stage
            ? skyColor(laneColor(this.theme, 3)).lerp(new THREE.Vector3(1, 1, 1), 0.72)
            : skyColor(laneColor(this.theme, 1)),
        },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uScroll;
        uniform float uBass;
        uniform float uPulse;
        uniform float uClear;
        uniform vec3 uGridA;
        uniform vec3 uGridB;

        const float WIDTH = ${GROUND_WIDTH.toFixed(1)};
        const float LENGTH = ${GROUND_LENGTH.toFixed(1)};
        /**
         * World units between grid lines.
         *
         * Read against the lane width (1.15), not in the abstract: at 4.0 a
         * single grid cell was wider than three lanes, which made the floor look
         * like a scaled-up version of a different scene sitting behind the
         * track. Roughly one lane per cell puts the floor at the same scale as
         * the thing standing on it.
         */
        const float SPACING = 2.4;

        /*
         * Lines widen with distance instead of using fwidth().
         *
         * A constant world-space width aliases into a shimmering mess at the far
         * end, where many lines fall inside one pixel. Widening them keeps each
         * line at roughly a constant size on screen, which is what a real
         * receding grid looks like anyway.
         */
        float gridLine(float coord, float halfWidth) {
          float d = abs(fract(coord / SPACING - 0.5) - 0.5) * SPACING;
          return smoothstep(halfWidth, 0.0, d);
        }

        void main() {
          float worldX = (vUv.x - 0.5) * WIDTH;
          float along = vUv.y * LENGTH;
          // Scales with SPACING: keeping the old widths against a denser grid
          // fattens the lines until the gaps between them close up.
          // Wider near the player (0.028 -> 0.055) as well as far away. A grid
          // line has to be softer-edged than a note edge or the background is
          // competing at gameplay's own spatial frequency, and width is the only
          // way to soften one: the line is a smoothstep across its own half-width,
          // so a thin line is a hard line however dim it is.
          float lineW = mix(0.055, 0.34, vUv.y);

          // Pink runs away from the player, cyan across — the same split as the
          // menu's CSS grid, so the two backgrounds agree.
          float lengthwise = gridLine(worldX, lineW);
          float crosswise = gridLine(along + uScroll, lineW);

          // These are LINEAR and therefore much lower than they look. ACES plus
          // the sRGB curve lifts midtones hard; the first pass at 0.42 pink came
          // out near-white and buried the lanes.
          // The scalars are the tuning, not the colours. Lane hues arrive at
          // full brightness — they are meant to be the brightest things on
          // screen — and the ground is scenery that must lose to the notes.
          // The first pass at this grid used linear 0.42 pink and came out
          // near-white, burying the lanes it was supposed to frame.
          // 0.15/0.11 -> 0.10/0.075. The grid is the brightest thing outside the
          // track: its lines peaked at 0.235 relative luminance against a near
          // note's 0.65, i.e. 36% of the gameplay layer, and every one of them is a
          // hard edge at the same spatial frequency as a tile. Scenery loses to
          // notes, and this is the piece that was closest to not doing so.
          vec3 col = uGridA * 0.10 * lengthwise
                   + uGridB * 0.075 * crosswise;

          float grid = max(lengthwise, crosswise);

          // Clear the track. Feathered, not a hard edge.
          float clear = smoothstep(uClear - 0.9, uClear + 0.9, abs(worldX));

          // Dissolve into the horizon haze rather than ending at the plane's
          // edge, and pull the very near foreground down so the grid does not
          // crowd the receptors.
          float farFade = smoothstep(1.0, 0.55, vUv.y);
          // The near foreground fades over a long run, not a token one: the
          // closest lines are metres wide on screen and sit right beside the
          // receptors, which is the last place anything should pull the eye.
          // 0.17 rather than 0.22, so the grid still reaches the lower corners:
          // dying at 0.22 left the bottom third of the frame either side of the
          // track with nothing in it at all.
          float nearFade = smoothstep(0.0, 0.17, vUv.y);
          // Sides fall away too, so the plane's left and right edges never show.
          float sideFade = smoothstep(0.5, 0.24, abs(vUv.x - 0.5));

          // On the dark stage the grid is only a faint hint of a floor; in the
          // classic synthwave look it is the signature neon and stays bright.
          //
          // 0.11 -> 0.028 on stage, and the beat terms with it. The reference has
          // no ground grid at all; what earns this one its place is that a black
          // void either side of the track reads as an unfinished composition. At
          // 0.11 it was legible horizontal banding running across the whole upper
          // frame — background structure at the notes' own scale — and it is the
          // second thing (after the sky) that put a cast over everything.
          float alpha = grid * clear * farFade * nearFade * sideFade
                      * (${this.stage ? '0.05 + uBass * 0.02 + uPulse * 0.015' : '0.34 + uBass * 0.20 + uPulse * 0.10'});

          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    const geometry = new THREE.PlaneGeometry(GROUND_WIDTH, GROUND_LENGTH, 1, 120);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    // Below the highway floor (-0.12) by enough to never z-fight with it.
    mesh.position.set(0, -0.34, GROUND_NEAR_Z - GROUND_LENGTH / 2);

    // Same lift as the track, so the highway stays sitting on the ground as it
    // climbs. Deliberately NOT `bendToCurve`: that also applies `curveWidth`,
    // which tapers the track — pulling the ground's far edges inward with it
    // would leave the sky showing through wedges either side of the horizon.
    const position = geometry.attributes['position'] as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      // See bendToCurve: rotation.x = -PI/2 maps local +Y to world -Z and local
      // +Z to world +Y, so lift is written into local Z.
      position.setZ(i, curveLift(mesh.position.z - position.getY(i)));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();

    mesh.renderOrder = LAYER.ground;
    return mesh;
  }

  /**
   * The weave's along-track phase, as `K * (1/A - 1/(A + v))`.
   *
   * A constant-SCREEN-period coordinate, derived from the rig rather than tuned.
   * For a ground plane the projected scale goes as 1/(view-axis depth), and the
   * depth of a point on this plane is affine in v — so `d(v) = D0 + v * (D1-D0)`
   * and a phase proportional to `-1/d` advances at a constant number of cycles
   * per screen pixel. `A` is `D0 / (D1 - D0)`; `K` is chosen so the rate AT THE
   * HIT LINE still equals `FLOOR_WEAVE_ALONG`, which is what keeps the near
   * field looking as it did while the far field stops dissolving.
   *
   * Returned as a pair rather than written into the shader by hand because both
   * numbers are functions of the camera rig, the plane's length and where the
   * hit line falls on it — four constants that have each moved at least once.
   *
   * **The weave deliberately does NOT scroll, and adding `uScroll` to it is the
   * obvious wrong fix.** It is the deck's most legible detail, so once the rungs
   * were locked to the notes' speed (`deckScrollPhase`) the surface reads as a
   * moving marking sliding over a pinned material — which is a fair complaint
   * and *is* part of "moving but not in motion". But the property this function
   * exists to provide is constant period **per screen pixel**, and a phase
   * offset in that coordinate therefore moves the whole weave at one uniform
   * on-screen rate, near field and vanishing point alike. The rungs travel at
   * true perspective rate (fast near, crawling far), so the two would shear
   * against each other on the same surface — worse than one of them being
   * still.
   *
   * Making the weave travel correctly means giving it a **world**-linear
   * along-track coordinate instead of this one, which re-introduces exactly the
   * far-field dissolve and aliasing this map was built to remove, and so also
   * needs the distance fade the `No distance fade` note below deliberately
   * removed to match the reference. That is a real trade with two documented
   * decisions on the other side of it — not a one-line addition. Measure it in
   * motion before attempting it; a still frame cannot show the defect or the fix.
   */
  private static weavePhase(): { a: number; k: number } {
    // View-axis depth of a point on the deck at world z. The camera looks from
    // (0, CAMERA_HEIGHT, CAMERA_DISTANCE) at (0, 0, CAMERA_TARGET_Z).
    const dy = -CAMERA_HEIGHT;
    const dz = CAMERA_TARGET_Z - CAMERA_DISTANCE;
    const len = Math.hypot(dy, dz);
    const depth = (z: number): number =>
      (-CAMERA_HEIGHT * dy) / len + ((z - CAMERA_DISTANCE) * dz) / len;
    const near = depth(FLOOR_NEAR_Z);
    const far = depth(FLOOR_NEAR_Z - FLOOR_LENGTH);
    const a = near / (far - near);
    const hitV = FLOOR_NEAR_Z / FLOOR_LENGTH;
    // d(phase)/dv = k / (a + v)^2, matched to the old linear rate at the row.
    const k = FLOOR_WEAVE_ALONG * (a + hitV) * (a + hitV);
    return { a, k };
  }

  private buildFloor(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const { a: weaveA, k: weaveK } = Highway.weavePhase();
    // Feed the lane tints in as a uniform so the floor is coloured per lane
    // rather than a single flat purple.
    const laneTints: THREE.Vector3[] = [];
    for (let i = 0; i < MAX_SHADER_LANES; i++) {
      if (i < this.laneCount) {
        const c = new THREE.Color(laneColor(this.theme, i));
        laneTints.push(new THREE.Vector3(c.r, c.g, c.b));
      } else {
        laneTints.push(new THREE.Vector3(0, 0, 0)); // padding, never sampled
      }
    }

    const material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uBass: { value: 0 },
        uPulse: { value: 0 },
        uLaneCount: { value: this.laneCount },
        uLaneTints: { value: laneTints },
        uLaneFlash: { value: new Float32Array(MAX_SHADER_LANES) },
        // Where the hit line falls in this plane's v. Everything about the near
        // field keys off it: markings live behind it, the apron in front. Passed
        // as a uniform rather than hardcoded because it is a ratio of two other
        // constants and would silently drift if either moved.
        uHitV: { value: FLOOR_NEAR_Z / FLOOR_LENGTH },
        // Fraction of the plane's half-width the LANES occupy. The plane is wider
        // than the lanes now (`FLOOR_MARGIN`), so `vUv.x * laneCount` is no longer
        // a lane coordinate — without this remap every lane groove would sit a
        // margin's worth off its receptor.
        uLaneSpan: { value: this.halfWidth / this.deckHalfWidth },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        #define MAX_LANES ${MAX_SHADER_LANES}
        varying vec2 vUv;
        uniform float uTime;
        uniform float uScroll;
        uniform float uBass;
        uniform float uPulse;
        uniform float uLaneCount;
        uniform vec3 uLaneTints[MAX_LANES];
        uniform float uLaneFlash[MAX_LANES];
        uniform float uHitV;
        uniform float uLaneSpan;

        void main() {
          // The plane is wider than the lanes (FLOOR_MARGIN), so a lane
          // coordinate has to be remapped out of the plane's own u. 0 at the
          // left-hand lane boundary, uLaneCount at the right-hand one; negative
          // and past-the-end in the margins, which is what uInside detects.
          float lanePos = ((vUv.x - 0.5) / uLaneSpan + 0.5) * uLaneCount;
          int laneIndex = int(clamp(floor(lanePos), 0.0, uLaneCount - 1.0));
          vec3 tint = uLaneTints[laneIndex];
          float flash = uLaneFlash[laneIndex];
          // 1 over the lanes, 0 out in the deck margin. Every piece of LANE
          // structure is gated by it; without it fract() keeps manufacturing
          // grooves out past the outermost lane.
          float inside = smoothstep(-0.06, 0.06, lanePos)
                       * smoothstep(uLaneCount + 0.06, uLaneCount - 0.06, lanePos);

          // --- the near field, split at the hit line ------------------------
          // forwardZ is world units IN FRONT of the receptors (negative behind
          // them), so both masks below are expressed in the same units as the
          // tiles and the receptors rather than in this plane's own v.
          // (No backticks anywhere in here: a stray one closes the template
          // literal and TypeScript then parses the GLSL as code.)
          float forwardZ = (uHitV - vUv.y) * ${FLOOR_LENGTH.toFixed(1)};
          /*
           * The SURFACE exists all the way to the plane's near edge, which
           * projects past the bottom of the frame at every shipped aspect. It used
           * to end 0.8 units in front of the row, and the measured cost was the
           * bottom 13% of the frame reading as literally empty. What must not
           * survive down here is anything that SCROLLS — see uFront.
           */
          float playfield = smoothstep(9.0, 6.0, forwardZ);
          // 0 behind the receptor row, 1 well in front of it. Gates the rungs and
          // the accent sill, which are the two things that made the near field
          // read as the playfield drawn a second time.
          float front = smoothstep(${FLOOR_APRON_FADE.toFixed(2)}, 1.6, forwardZ);

          // 0 at the receptor row, 1 at the far end. The whole surface is written
          // against this rather than against raw v, because v also covers the
          // near field in front of the row.
          float toward = clamp((vUv.y - uHitV) / max(1.0 - uHitV, 0.0001), 0.0, 1.0);
          float nearness = 1.0 - toward;

          /*
           * --- THE DECK ------------------------------------------------------
           *
           * A near-neutral dark charcoal carrying a fine diamond weave, and
           * nothing else. What it replaces was a per-lane colour FIELD: the term
           * named "separator" was 1 across the whole lane body and 0 only in a
           * hairline at its edge, so "ambient * separator * 0.30" painted 25% of
           * the lane hue down the entire length of every lane. Measured mid-track
           * on the shipped frame: HSL saturation 88-98% at up to 0.20 relative
           * luminance, against a reference track of 0.1-0.6% at 0.024. The lanes
           * were the most saturated large objects in the frame; the notes are
           * supposed to be the only ones.
           *
           * The deck is written as an almost-opaque grey instead of accumulating
           * six scalars behind a 0.62 alpha. That is not tidiness: with alpha at
           * 0.97 the composited surface IS this number, so the contrast budget can
           * be read off a constant instead of estimated through a blend.
           */
          vec3 tone = vec3(${DECK_LINEAR.toFixed(4)});

          /*
           * The weave — a diamond twill, in the plane's own uv so it tapers with
           * the geometry (bendToCurve scales vertices, not UVs, precisely so
           * that surface detail follows the taper for free).
           *
           * Two crossed sines rather than a thresholded lattice: a sine has no
           * edges to alias, and the pattern's period at the receptor row is ~40
           * device px across against a note's ~200, i.e. a fifth of the note's
           * scale, which is the "background must be lower spatial frequency than
           * gameplay" rule pointing the other way for once — it is texture, not
           * structure. It fades out over the far half regardless, where the cells
           * fall under a pixel and would shimmer.
           */
          float wx = lanePos * ${FLOOR_WEAVE_ACROSS.toFixed(1)};
          // Hyperbolic in v, so the cell's SCREEN height is constant and the
          // lattice survives to the vanishing point instead of being resolved
          // away by mid-track. See Highway.weavePhase for the derivation.
          float wy = ${weaveK.toFixed(4)}
                   * (${(1 / weaveA).toFixed(6)} - 1.0 / (${weaveA.toFixed(6)} + vUv.y));
          // No distance fade. The reference holds its weave the whole way down
          // the board, and the mid-track band is where most of our board area
          // lives — fading it there left that band with no material at all.
          float weave = sin((wx + wy) * 3.14159265) * sin((wx - wy) * 3.14159265);
          /*
           * An ANTI-ALIAS taper, which is not the same as the distance fade the
           * note above rules out. The hyperbolic wy holds the cell's screen
           * period roughly constant, but only roughly — between a third and two
           * thirds of the way up, the two crossed sines beat against the pixel
           * grid and the twill turned into a visible screen-door moiré (reported
           * as "a mesh, not a material" over y350-700). Rolling the amplitude
           * down over exactly that band and back up beyond it costs the material
           * nothing where the eye can resolve it and removes the interference
           * where it cannot. Written on toward (0 at the row, 1 far), so it is
           * a band rather than a fade to nothing.
           */
          weave *= mix(1.0, 0.34, smoothstep(0.16, 0.46, toward) * smoothstep(0.92, 0.62, toward));

          /*
           * Lane structure is a GROOVE, not a fill: a dark seam on the boundary
           * with a faint lit lip just inside it, which is how the reference
           * separates lanes on a surface that carries no colour of its own.
           *
           * Gated by uInside, or the fract() would keep generating boundaries out
           * in the deck margin where there are no lanes.
           */
          float laneEdge = abs(fract(lanePos) - 0.5);
          /*
           * A CUT, not a smear. The groove ran 0.09 of a lane on each side and
           * measured 19 device px at half-depth against the reference's 7, with
           * its floor only reaching L39 against the reference's L16 — wide, soft
           * and grey. The grooves are the only hard lines on the deck, so a soft
           * groove is most of what reads as "the whole board is out of focus".
           *
           * Widened slightly with distance because a seam narrower than a pixel
           * shimmers; "toward" is 0 at the row and 1 at the far end.
           * (No backticks anywhere in here — one closes the template literal.)
           */
          float gw = mix(0.021, 0.040, toward);
          /*
           * The deck margin outside the outermost lanes is darkened by a flat
           * 0.35, and it used to key off "inside" — which transitions over 0.12
           * of a lane, i.e. a HARD material boundary. Measured on the shipped
           * frame that produced a visible luminance step (L~18 inner against
           * L~11 outer) running the full length of the board down both sides,
           * read as a seam the reference does not have. "margin" is the same
           * mask spread over ~0.6 of a lane so the step becomes a gradient,
           * kept separate because "inside" also gates the lane
           * GROOVES and widening that would manufacture a groove out in the
           * margin where there is no lane boundary.
           */
          float margin = smoothstep(-0.60, 0.12, lanePos)
                       * smoothstep(uLaneCount + 0.60, uLaneCount - 0.12, lanePos);
          float groove = smoothstep(0.5 - gw, 0.5, laneEdge) * inside
                       + (1.0 - margin) * 0.35;
          /*
           * The rail's specular edge — a thin bright line just inside the cut,
           * which is what makes a groove read as machined rather than drawn. It
           * was a 0.10-of-a-lane band at 0.20 gain, i.e. a soft lift over a
           * quarter of the lane rather than an edge; the reference's is 2px.
           */
          float lip = smoothstep(0.5 - gw * 2.6, 0.5 - gw * 1.35, laneEdge)
                    * (1.0 - groove) * inside;

          /*
           * CROSS-TRACK LIGHTING. One lamp over the middle of the board, falling
           * off toward the outer lanes — see DECK_EDGE_FALLOFF. Squared so the
           * centre stays flat and the loss is spent at the edges, which is where a
           * real light's falloff is legible; a linear ramp reads as a gradient
           * painted on rather than as light.
           */
          float across = clamp(abs(vUv.x - 0.5) * 2.0, 0.0, 1.0);
          float lamp = mix(1.0, ${DECK_EDGE_FALLOFF.toFixed(2)}, across * across);

          // Rungs scrolling toward the player — measure lines, the Rock Band
          // solution to rhythm legibility. The count is derived from the plane's
          // length so world spacing stays fixed whatever the plane measures.
          //
          // 2.25 units apart, not 1.5: a background pattern has to have a period
          // of at least ~1.5x a note's short edge near the hit line or it competes
          // with gameplay at gameplay's own spatial frequency. A tile is 1.36 deep,
          // so 1.5 was 1.1x — inside the note's own scale.
          float rung = vUv.y * ${(FLOOR_LENGTH / DECK_RUNG_PERIOD).toFixed(3)} + uScroll;
          // A twelfth of what it was. The reference deck has no rungs at all; this
          // keeps the beat readable on the surface without being a second set of
          // horizontal bars competing with the receptor row. Killed in front of
          // the row (see uFront) — a scrolling marking down there is the "playfield
          // rendered twice" defect.
          /*
           * A PULSE, not a sawtooth — and this is where the "contour banding in
           * the deck" defect actually came from.
           *
           * It was smoothstep(0.93, 1.0, rung): a ramp that climbs over the last
           * 7% of the period and then falls off a CLIFF at the fract() wrap. In a
           * still that cliff is a hard horizontal 2-4 luma step running the full
           * track width, and there is one per 2.25 world units — which is why the
           * six steps measured on the previous capture were evenly spaced in
           * world z with screen spacing growing toward the camera (169, 186, 205,
           * 226, 254 px), and why they survived a dither pass aimed at 8-bit
           * quantisation. They are not contour bands and not a quantised ramp;
           * they are this function's discontinuity. Fading symmetrically back to
           * zero before the wrap costs the rung nothing visually and removes the
           * step entirely.
           */
          /*
           * **A RAISED COSINE, and the shape had to change the moment the speed
           * was fixed.**
           *
           * The pair of smoothsteps this replaces was a ~12%-duty crest. At the
           * rate the rungs actually ran (3.6 world units/sec) it took ~75ms to
           * cross its own width and that was fine. At the notes' real speed —
           * 19.2 units/sec on hard, 26.3 on extreme — the same crest transits in
           * **14ms, under two frames at 120Hz**: it would not scroll, it would
           * strobe, and a hard-edged band aliasing against the pixel grid at 8.5
           * per second is the worst possible thing to put on the largest surface
           * in the frame.
           *
           * A cosine has no edges to alias at any speed, and it also retires the
           * fract() cliff the note above spends four paragraphs on — there is no
           * discontinuity left to fade symmetrically around, because cos is
           * already continuous across the wrap. The exponent sharpens the trough
           * so it still reads as a travelling BAND rather than as a flat ripple,
           * while the peak stays round. (No backticks anywhere in here — one
           * closes the template literal, and this comment cost a build once.)
           *
           * Not a flash hazard, and worth stating since anything periodic here
           * is one question away from beatPulse: this is a travelling wave, not
           * a synchronous one. ~11 periods are on screen at once at different
           * phases, so no large area changes luminance together — which is what
           * WCAG 2.3.1 measures — and the amplitude is a few percent of an
           * already-dark deck.
           */
          /*
           * Squared falloff with distance, where it used to be linear.
           *
           * Two reasons, and the second is the real one. A cosine is 100% duty
           * where the old crest was 12%, so adjacent bands now touch — and up
           * the board, where 2.25 world units projects to a handful of pixels,
           * a continuous ripple beats against the pixel grid exactly as the
           * weave does (the note on the weave's anti-alias taper is the same
           * problem, already solved once). And the far field is not where a
           * velocity cue is legible anyway: it is where the perspective has
           * compressed everything to a crawl. Spending the contrast in the near
           * half is both safer and where it does the work.
           */
          float rungs = pow(0.5 - 0.5 * cos(rung * 6.28318531), 1.7)
                      * nearness * nearness * (1.0 - front) * inside;

          // The lit deck. Every term here is a MULTIPLIER on one neutral tone, so
          // no combination of them can introduce chroma.
          //
          // The longitudinal term holds a floor of 0.86 rather than 0.78 and no
          // longer collapses in the near field: the deck under and below the
          // receptor row is what the reference keeps readable to the bottom edge.
          /*
           * The weave is driven HARDER in front of the receptor row.
           *
           * Everything down there is multiplied by the apron dim below, and a
           * multiplier scales the material's contrast along with its value — at
           * 0.42 of a 0.07 deck the twill's peak-to-trough fell under one 8-bit
           * step, so the bottom fifth of the board read as flat void with a slab
           * pasted onto it. Raising the amplitude by the inverse of the dim keeps
           * the apron's *material* legible at the apron's own (correctly lower)
           * brightness. Reference apron measures L 0.007 against 0.038 mid-track,
           * so the dimming itself is right; only the texture was being spent.
           */
          float deck = (1.0 + weave * ${FLOOR_WEAVE_AMOUNT.toFixed(3)} * (1.0 + front * 0.35))
                     // 0.92, not 0.66: the reference's groove floor is L16 on a
                     // L23 deck, and at 0.66 ours bottomed out at L39.
                     * (1.0 - groove * 0.92)
                     /*
                      * THE LENGTHWISE SHADING GRADIENT.
                      *
                      * 0.82 -> 1.16, where it was 0.86 -> 1.00. The reference's
                      * deck is not one flat value up the board: it falls off
                      * toward the vanishing point, which is what tells the eye the
                      * surface is receding under a light rather than being a flat
                      * fill seen face on. Display is roughly c^0.83, so this 1.35x
                      * in the multiplier is about 1.28x on screen — a legible ramp
                      * without the far end going dark enough to lose the weave.
                      */
                      /*
                       * **0.37 -> 1.02, not 0.82 -> 1.16.** At the narrower
                       * swing the deck ran 1.3x end to end where the reference's
                       * runs 1.85x, so our far field sat at L50 against its L32
                       * and the track never RECEDED — the horizon read as a wall.
                       * The near end is unchanged, so the "deck 55-59" target and
                       * the flat-to-a-note-edge property both hold; all of the
                       * new range is spent up the board where distance lives.
                       */
                     * (0.37 + 0.65 * nearness * nearness)
                     * lamp
                     /*
                      * THE ROW'S CONTACT SHADOW.
                      *
                      * The pads had no visible thickness and no shadow, so the
                      * whole row read as printed onto the deck. makeRimTexture
                      * (no backticks in here — one closes the template literal)
                      * gives the near edge a side face; this is the other half —
                      * a short darkening of the track immediately in front of the
                      * pads' near edge (the pad spans +-HIT_ZONE_DEPTH/2 about
                      * z=0, so its near edge is at forwardZ ~ 1.75). A band, not
                      * a step: keyed off forwardZ on both sides so it cannot leak
                      * back up the playfield.
                      */
                     * (1.0 - 0.3 * smoothstep(1.35, 1.9, forwardZ)
                                  * smoothstep(4.6, 2.1, forwardZ))
                     // Dimmer in front of the row. The deck has to stay READABLE
                     // down there (the reference resolves its lane grooves and a
                     // note to the bottom edge) without being as bright as the
                     // playfield — measured, the reference's near field runs
                     // 0.010-0.017 relative luminance against 0.042 mid-track.
                     /*
                      * **0.20, not 0.52, and the apron keeps fading past that.**
                      * The bottom ~17% of the frame rendered as a lit grey
                      * crosshatch slab where the reference is essentially black:
                      * it lifted the image's black level, added visible tiling
                      * noise at the largest texel density on the board, and was
                      * the loudest amateur tell in the capture. The reference's
                      * near field measures 0.010-0.017 relative luminance against
                      * 0.042 mid-track, i.e. a QUARTER, not a half.
                      */
                     * mix(1.0, 0.20, front)
                     /*
                      * ...and it keeps going down to nothing over the last few
                      * units, so the deck reaches black before the plane's near
                      * edge instead of terminating on a lit slab. forwardZ is
                      * world units in front of the row.
                      */
                     * smoothstep(7.5, 3.0, forwardZ)
                     // 0.28, not 0.55. The lip is the separators' bright edge and
                     // it was rendering as a 5-6px near-white stroke — the
                     // reference's is a dark groove with a hairline light lip, and
                     // the notes have to be the brightest thing on the board by a
                     // clear margin.
                     + lip * 0.28 * lamp
                     /*
                      * **0.22, not 0.10 — the amount that makes the deck read as
                      * moving.**
                      *
                      * 0.10 was set to make the rungs nearly invisible, on the
                      * grounds that "the reference deck has no rungs at all".
                      * True of a still frame, and a still frame cannot show
                      * motion — which is the owner's actual report: "i can see
                      * the note bars moving, but dont feel in motion inside
                      * game". A deck with no legible moving detail leaves the
                      * notes sliding over a stationary board, and that is exactly
                      * what "moving but not in motion" describes.
                      *
                      * Still scenery, and still a long way from competing: this
                      * lands the crest at roughly 0.02 relative luminance on a
                      * deck of 0.081 linear, against a note face that is the
                      * brightest object in the frame by an order of magnitude.
                      * Raise it further only with a capture to prove the notes
                      * still win.
                      */
                     + rungs * 0.30;
          /*
           * DITHER, and it is not optional once the lengthwise ramp is wide.
           *
           * The deck is the largest flat area in the frame, and a smooth ramp
           * across it quantises: measured on the previous capture, six hard
           * horizontal level steps ran the full track width (51->53, 53.7->55.6,
           * 55.6->59.4, 56.8->59.3, 61.9->64.3, 62.6->65.4), evenly spaced in
           * world z and each a permanent 2-4 luma jump. They are contour bands,
           * not beat rungs — a rung is a transient line, these were level
           * changes that never came back. The old 0.86->1.00 multiplier was too
           * narrow to expose it; 0.54->1.16 is not, and the reference deck's own
           * ramp is wider still.
           *
           * A per-pixel hash of +-0.5 of a step, applied to the MULTIPLIER
           * rather than to the output, because the output is sRGB-encoded
           * downstream and a fixed linear epsilon would be inaudible in the near
           * field and enormous at the far end. At L~55 one 8-bit code is ~3.4%
           * of the linear value, so +-2.5% is a little under half a code either
           * way: enough to break the contour, far too little to read as grain.
           */
          float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          deck *= 1.0 + (grain - 0.5) * 0.05;
          vec3 col = tone * deck * playfield;

          /*
           * Lane identity, hinted at the sill and nowhere else.
           *
           * The accent is allowed onto the surface only in the last stretch before
           * the receptor row, as a soft gradient — the brief's "edge glow or a soft
           * gradient near the receptor, never flooding the lane". The sill span is a
           * fraction of the approach, so mid-track (which is what the saturation
           * gate samples) is untouched neutral by construction rather than by
           * being dim enough to get away with it.
           */
          float sill = pow(clamp(1.0 - toward / ${FLOOR_SILL_SPAN.toFixed(2)}, 0.0, 1.0), 2.2)
                     * (1.0 - front) * inside;

          // A press lights the whole lane, not just the near end. The constant
          // term is what carries the highlight all the way up the highway;
          // without it the flash collapses into the hit line and reads as a
          // separate object rather than as "this lane". It is the one thing
          // allowed to carry lane colour past the row — a struck lane spilling its
          // own light forward is information, not decoration.
          float flashGlow = flash * (0.34 + pow(nearness, 3.0) * 0.85) * inside;

          col += tint * sill * (${this.stage ? '0.022 + uBass * 0.010 + uPulse * 0.008' : '0.14 + uBass * 0.22'})
               + tint * flashGlow * 0.55;

          // Dissolve the far end instead of stopping at a hard edge, so the
          // highway reads as receding into the distance rather than being cut.
          //
          // 0.90, not 0.86: the plane is longer than it was (see FLOOR_LENGTH), so
          // the spawn point now sits at v = 0.895 rather than 0.91. Starting the
          // dissolve past it is what keeps the topmost note — which is what "the
          // approach runway" is measured to — over solid track rather than over a
          // surface already 30% gone.
          /*
           * **Started much earlier (0.80, not 0.94) so the deck DISSOLVES.** At
           * 0.94 the far end popped: a lighter grey band ending on a visible
           * horizontal cut, where the reference fades smoothly into black with no
           * discernible edge. The dissolve now runs over ~20% of the plane, which
           * is still past the spawn point in world terms (v = 0.895) but reaches
           * it at ~0.5 rather than at 1.0 — the topmost note keeps track under it,
           * just track that is already on its way out.
           */
          float farFade = smoothstep(1.0, 0.86, vUv.y);

          /*
           * NEARLY OPAQUE across the playfield, where it used to peak around 0.12.
           *
           * The deck is a material now, not a set of glows summed behind a low
           * alpha, and a translucent material is not one: at 0.12 the stage glow
           * and the ground grid both showed *through* the lanes, which is where the
           * mid-track amber cast in the rejected frame came from. Opaque also means
           * the composited surface equals DECK_LINEAR, so the contrast budget is
           * a constant rather than an estimate.
           */
          float alpha = clamp(playfield * 0.97, 0.0, 1.0) * farFade;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    // Segmented along its length so it can actually bend — a single quad would
    // stay flat no matter what the vertices say. Wider than the lanes by
    // FLOOR_MARGIN either side; `uLaneSpan` is what keeps the lane structure
    // registered to the receptors once the two differ.
    const length = FLOOR_LENGTH;
    const geometry = new THREE.PlaneGeometry(this.deckHalfWidth * 2, length, 1, 96);
    const mesh = new THREE.Mesh(geometry, material);
    // `rotation.x = -PI/2` alone already puts v=0 at the near edge and leaves u
    // running left-to-right. An extra `rotation.z = PI` was here to "flip v", but
    // rotating about Z mirrors BOTH axes — which silently reversed u and drew
    // every lane's floor tint under the wrong lane.
    mesh.rotation.x = -Math.PI / 2;
    // The near edge is FLOOR_NEAR_Z, out past the bottom of the frame at every
    // shipped aspect. It used to stop at z=3, which a 5-lane portrait board
    // (widest FOV, cutting at z=3.4) showed the raw edge of.
    mesh.position.set(0, -0.12, -length / 2 + FLOOR_NEAR_Z);
    Highway.bendToCurve(geometry, mesh.position.z);
    // Before the hit band, so the band's additive light lands on top of the
    // apron rather than the apron's alpha muddying the band.
    mesh.renderOrder = LAYER.floor;
    return mesh;
  }

  /**
   * Push the floor's vertices onto the curve.
   *
   * Done in the geometry's local space, before the mesh rotation is applied.
   * That `rotation.x = -PI/2` maps local +Y onto world -Z and local +Z onto
   * world +Y, so the vertical lift is written into local Z, and a vertex's
   * world z is `meshZ - localY`. Getting that mapping backwards tips the track
   * sideways rather than bending it, which looks like a bug in the camera.
   */
  private static bendToCurve(geometry: THREE.PlaneGeometry, meshZ: number): void {
    const position = geometry.attributes['position'] as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const worldZ = meshZ - position.getY(i);
      position.setZ(i, curveLift(worldZ));
      // Local X is the width axis and survives the mesh rotation untouched.
      // Scaling it here rather than in the shader keeps the UVs intact, so the
      // lane tints and beat rungs taper along with the geometry for free.
      position.setX(i, position.getX(i) * curveWidth(worldZ));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  /**
   * The two bright rails running down the outer edges of the track — the
   * signature of the reference look. Each is a thin strip lying on the track
   * surface, bent onto the curve and tapered inward with it, glowing hot enough
   * to cross the bloom threshold so it reads as a light strip, not a painted
   * line. Tinted by the theme's warm sun colour so it matches the stage glow.
   */
  private buildRails(): void {
    const RAIL_WIDTH = 0.14;
    /**
     * How far past the receptor row the rail runs, in world units. Just past the
     * bottom of a portrait frame (z ~ 2.4), so the deck's edge is drawn all the
     * way down rather than terminating at the row.
     */
    const RAIL_NEAR_Z = 3.0;
    /*
     * NEUTRAL, not the accent — and this reverses the previous pass on measured
     * evidence rather than on taste.
     *
     * The note beside `bright` below argued the reference spends its headline
     * energy on accent piping down both sides of the board, quoting 0.226-0.541
     * relative luminance. That measurement was taken on the reference's side
     * SPECTRUM (`buildSpectrumWings`, which is off the deck entirely); its track
     * rails, sampled at the matched rows, read #3e3e40 and #3e3f41 — HSL
     * saturation 1.6% and 2.4% at 0.048 and 0.050 relative luminance. A black
     * groove with a faint grey highlight, in other words. Ours ran a continuous
     * gold sill at saturation 51-54% peaking at 0.180, the longest continuous line
     * in the frame and the brightest thing outside the notes.
     *
     * A trace of the accent survives so the edge is not literally grey on a themed
     * board, but at a tenth it cannot register as chroma.
     */
    const railColor = new THREE.Color(0xffffff).lerp(new THREE.Color(this.accent), 0.1);

    for (const side of [-1, 1] as const) {
      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Vector3(railColor.r, railColor.g, railColor.b) },
          uBass: { value: 0 },
          uPulse: { value: 0 },
          uTime: { value: 0 },
          uSpectrum: { value: this.spectrumTex },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          uniform vec3 uColor;
          uniform float uBass;
          uniform float uPulse;
          uniform float uTime;
          uniform sampler2D uSpectrum;
          void main() {
            // Soft core across the strip's width. Exponent 1.0, not 1.6: at 1.6
            // the profile collapsed into a 2-3px hard line — the SHARPEST edge in
            // the frame, sharper than any note, whose own rims blur over 6-8px.
            // A 1600px-long high-frequency decorative line beats a 90x50px
            // gameplay object on both sharpness and length, which is the failure
            // "the background must be lower spatial frequency than a note" names.
            float cross = smoothstep(0.5, 0.0, abs(vUv.x - 0.5));
            // Dissolve into the horizon glow at the far end, and terminate INTO
            // the receptor row rather than 150px short of it.
            //
            // The rails used to simply STOP at z=0: two bright strokes ending
            // with no cap, whose bloom pooled into unmotivated warm wedges in the
            // bottom corners of a portrait frame. Then they were ramped out over
            // ~2.3 world units, which overcorrected the other way — the highway
            // was brightly bounded where nothing happens and unbounded exactly
            // where the player aims, leaving the outer receptors outside any
            // visible track edge. 0.03 of the length is ~0.8 units: enough to be
            // a cap rather than a cut, short enough that the edge reaches the row.
            float farFade = smoothstep(1.0, 0.55, vUv.y);
            // No near cap any more. The rail geometry runs past the receptor row
            // to the bottom of the frame (see RAIL_NEAR_Z), because the deck does:
            // an edge that stops at the row leaves the bottom eighth of the frame
            // as an unbounded dark slab, which is what "the bottom 13% is empty"
            // measured. What still has to die is the very last sliver, or the
            // plane's own cut end shows as a bright stub.
            float nearFade = smoothstep(0.0, 0.02, vUv.y);
            // Brightest at the near end, faintest far. The rail is CONTAINMENT —
            // it says where the track's edge is, which is information the player
            // needs beside the receptors and does not need at the vanishing
            // point. Inverting the old flat profile also takes the scenery out of
            // the top band of the luminance histogram, where the far notes live.
            float nearness = 1.0 - vUv.y;

            // The rail carries the live audio spectrum as a waveform: sample it
            // along the rail's length, scrolling toward the player, so peaks of
            // light flow down the rail with the music. A baseline keeps the rail
            // lit in quiet passages; the peaks flare bright and bloom.
            float level = texture2D(uSpectrum, vec2(fract(vUv.y * 1.6 - uTime * 0.4), 0.5)).r;
            /*
             * WIDE, not centred. (No backticks anywhere in this comment: these
             * shaders are JS template literals and one closes the string early —
             * the trap CLAUDE.md records.)
             *
             * The swing was 0.5 + level * 0.9, i.e. 0.5..1.4, and the
             * "bright" term below clamps at 0.22 — so from about level 0.35
             * upward every value clipped to the same number and the waveform
             * stopped existing. The rail read as a flat hairline that happened to
             * be fed by an analyser. The swing now runs 0.30..1.95 and the base
             * is dropped to match, so the *product* still lands under the same
             * ceiling while the modulation survives: dark troughs and bright
             * crests travel down the rail with the music, which is the whole
             * point of spectrumTex reaching this shader at all.
             */
            float wave = 0.30 + level * 1.65;

            /*
             * EDGE DEFINITION, not neon. Measured on the shipped frame the rails
             * peaked at 0.931 relative luminance and held 0.79-0.86 for 800px,
             * against a brightest-note peak of 0.708 — the scenery was 131% of
             * gameplay, and posterizing the frame left two full-height white
             * rails owning the top band with the notes as small blobs. The order
             * has to be note > receptor row > rails > horizon > grid, and it was
             * almost exactly reversed.
             *
             * Clamped, not merely scaled: a spectrum peak on the downbeat is
             * precisely when the notes need the top of the histogram to
             * themselves.
             *
             * Then halved twice more, to 0.17, and that was a 3-7x OVER-correction
             * measured against the reference rather than against a rule of thumb:
             * its rails run #338da9 to #84cdde, relative luminance **0.226 to
             * 0.541**, the full length of the board. Ours read 0.033-0.076 — a
             * dull hairline where the reference spends its headline energy. The
             * accent piping down both sides is the one place the reference puts
             * chroma on the board itself, and denying the deck a wash (which is
             * right) is not a reason to gag a 0.14-wide structural line.
             *
             * 0.22 near, ~0.09 far, and NEUTRAL. The reference's rails measure
             * 0.048-0.050 relative luminance at HSL saturation 1.6-2.4%, which is
             * what this lands on once the near-end weighting and the alpha ramp are
             * spent (measured 0.013 at 0.12, so the cap has to be nearly double).
             * The old 0.55 put it at 0.148-0.180 in the song's accent — three to
             * four times the reference, on the longest continuous shape in the
             * frame.
             */
            float bright = min(0.22, (0.085 + 0.030 * uBass + 0.035 * uPulse) * wave)
                         * (0.40 + 0.60 * nearness * nearness);
            vec3 col = uColor * bright * cross;
            // Alpha carries the waveform too, not just the colour: at this width
            // an additive strip on near-black reads mostly through its coverage,
            // so modulating brightness alone left the crests barely separable
            // from the troughs. 0.30..1.0 across the spectrum's range.
            float alpha = cross * farFade * nearFade * (0.30 + level * 0.70)
                        * (0.55 + 0.45 * nearness);
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      material.toneMapped = false;

      /*
       * Long and thin, segmented so it can bend along the curve — and it runs
       * from the spawn point PAST the receptor row to `RAIL_NEAR_Z`, where the
       * deck runs off the bottom of the frame. Stopping it at z=0 is what left
       * the near field unbounded.
       */
      const railLength = HIGHWAY_LENGTH + RAIL_NEAR_Z;
      const geometry = new THREE.PlaneGeometry(RAIL_WIDTH, railLength, 1, 96);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      // Just above the floor (-0.12) so it sits on the surface, not through it.
      const meshZ = -HIGHWAY_LENGTH / 2 + RAIL_NEAR_Z / 2;
      mesh.position.set(0, -0.04, meshZ);

      // Bend onto the curve and ride the DECK's outer edge — not `halfWidth`,
      // which is the lane pitch and sits a margin inside it. Same local-space
      // mapping as bendToCurve: rotation.x = -PI/2 writes lift into local Z, and a
      // vertex's world z is meshZ - localY. The edge itself tapers with
      // curveWidth, so the rail follows the narrowing track instead of hanging
      // off it.
      const position = geometry.attributes['position'] as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const worldZ = meshZ - position.getY(i);
        const w = curveWidth(worldZ);
        position.setZ(i, curveLift(worldZ));
        position.setX(i, side * this.deckHalfWidth * w + position.getX(i) * w);
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();

      mesh.renderOrder = LAYER.rails;
      this.rails.push(mesh);
      this.scene.add(mesh);
    }
  }

  /**
   * The spectrum wings — vertical bars flanking the playfield, in the accent.
   *
   * The third of the owner's three acceptance criteria ("there is no waveforms
   * around") and the one the earlier passes never answered. The reference frames
   * carry a mirrored spectrum either side of the board, following its outward
   * splay; it is the single biggest source of the luminous-energy gap between our
   * frame and theirs (measured 3.5% of pixels above 0.15 relative luminance
   * against 18.1%), and it is what makes the composition read as a *stage* rather
   * than as a track floating in black.
   *
   * Built as two flat planes rather than instanced quads, for the same reason the
   * 3D album ring was retired: a strip of geometry with a pattern in its fragment
   * shader costs one draw call and no per-frame CPU work, where one mesh per bar
   * would be ~48 `setMatrixAt` calls a frame for decoration.
   *
   * Three rules keep it out of the way of gameplay:
   *  - it lies OUTSIDE the deck's rail, never over a lane;
   *  - it fades out before the receptor row, so nothing crosses the judgement
   *    moment (the reference does the same);
   *  - its peak is held under the notes' own, so the notes still own the top of
   *    the luminance histogram.
   */
  private buildSpectrumWings(): void {
    /**
     * Radial extent of a wing, in world units — the longest a bar can reach.
     *
     * 0.85, not 2.4. One world unit reads as about 5% of the frame's width beside
     * the board, so 2.4 drew 150px rungs spanning 12.8% of the frame — long, thick
     * horizontals fighting the track's diagonal and clipping at the frame edge.
     * The reference's are a dense ribbon of ~25px dashes, 2.3% of its frame,
     * hugging the track edge.
     */
    const WING_WIDTH = 1.05;
    /** Gap between the deck's rail and a bar's inner end. */
    const WING_GAP = 0.2;
    /** Bars over the wing's length. Dense enough to read as a spectrum, sparse
     *  enough that the pattern's period stays well above a note's. */
    const WING_BARS = 84;
    const color = new THREE.Color(this.accent);

    for (const side of [-1, 1] as const) {
      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        /*
         * DoubleSide is load-bearing, not defensive. Mirroring the left wing's x
         * (`side * ...` while its local x still increases) reverses the triangle
         * winding, so at the default FrontSide the whole left wing was
         * back-face-culled and the frame came back with a spectrum on the right
         * and nothing on the left. That is the same "obvious asymmetry" failure
         * mode the vignette had, arriving by a completely different route.
         */
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
          uBass: { value: 0 },
          uPulse: { value: 0 },
          uTime: { value: 0 },
          uSpectrum: { value: this.spectrumTex },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          uniform vec3 uColor;
          uniform float uBass;
          uniform float uPulse;
          uniform float uTime;
          uniform sampler2D uSpectrum;
          void main() {
            // vUv.x is 0 at the INNER end (beside the rail) and 1 at the outer;
            // the geometry is flipped per side so both wings grow outward.
            // vUv.y is 0 at the near end and 1 at the far one.
            float amp = texture2D(uSpectrum, vec2(fract(vUv.y * 1.3 - uTime * 0.22), 0.5)).r;
            // A floor so the wing is a visible structure in a quiet passage and a
            // reactive one in a loud bar, rather than blinking in and out. Raised
            // with the wing's width: at 0.85 world units a 0.22 floor is a 2px
            // stub, where at 2.4 it was a readable bar.
            // Range widened from 0.52..1.0: the bar LENGTH is what carries the
            // waveform envelope, and a floor two thirds of the way out left every
            // bar looking the same length. 0.30..1.0 makes a quiet bin visibly a
            // stub and a loud one a full-reach dash.
            float reach = 0.30 + amp * 0.70;

            // The bars. A soft duty cycle rather than a hard step: at this
            // grazing angle a hard-edged repeat aliases into moire. SLANTED, by
            // shearing the repeat against vUv.x — the reference's dashes lean with
            // the track's edge rather than cutting across it, and a horizontal
            // rung beside a converging board is the one direction that reads as a
            // mistake.
            float row = fract(vUv.y * ${WING_BARS.toFixed(1)} + vUv.x * 0.55);
            // Thinner duty cycle (0.56 -> 0.42 of the period): the reference's
            // flanking dashes are hairlines with black between them, and a fat
            // bar is half of why ours read as a second light source rather than
            // as texture at the periphery.
            float bar = smoothstep(0.0, 0.18, row) * smoothstep(0.42, 0.28, row);

            // Length: full at the inner end, dying at the bar's own reach, with a
            // soft tip so the outer end is a taper rather than a cut.
            float len = smoothstep(reach, reach - 0.28, vUv.x);
            // The innermost sliver is dimmed so the wing does not fuse with the
            // rail into one solid block of accent.
            float inner = smoothstep(0.0, 0.06, vUv.x);

            /*
             * IT LIVES IN THE NEAR FIELD ONLY, and the upper flanks are black.
             *
             * Measured on the shipped frame, the outer margins between y 0.20 and
             * 0.42 read 0.0426-0.0696 relative luminance at HSL saturation 15-34%,
             * over about 18% of the frame's area — flanking exactly the stretch of
             * track a note is approached through. The reference's are #161616 to
             * #1a1a19 at saturation 0.3-1.2%: black. It puts its spectrum LOW,
             * beside the receptor row, and nowhere else.
             *
             * Still nothing crosses the judgement moment; the near cut is now a
             * hairline rather than a fifth of the runway, because the reference's
             * ribbon runs right down past its pads.
             */
            float nearFade = smoothstep(0.0, 0.04, vUv.y);
            /*
             * Extent, re-read off the reference rather than off the earlier
             * correction. That correction cut the ribbon to the bottom 40% of the
             * runway to answer a "the upper flanks are a grey wash" measurement —
             * but the wash it was measuring was OUR vignette, not the wing. In
             * hibeatz-cyan.jpeg the flanking bars run from immediately under the
             * album disc all the way down past the pads: essentially the full
             * height of the board. At 0.40 ours were a stub in the bottom corner
             * that the owner's "there is no waveforms around" would still be true
             * of. 0.86 -> 0.42 keeps them solid over the near half and dissolves
             * them before the horizon, where a bar is a sub-pixel speck anyway.
             */
            float farFade = smoothstep(0.86, 0.42, vUv.y);

            /*
             * DECORATION MUST LOSE TO THE NOTES, and at 0.66 this did not.
             *
             * Measured on the previous frame the flanking bars sat at ~L60 in the
             * accent hue at full chroma — the same hue as a note face and within a
             * few points of its luminance — over roughly four times a note's screen
             * area, so the eye landed on the decoration first. In both reference
             * frames the equivalent bars measure ~L35 and are unambiguously
             * background. The cap goes to 0.24 (about a third), which is where a
             * wing reads as texture at the periphery rather than as a second light
             * source, and the accent is desaturated ~20% toward its own luminance
             * for the same reason: the frame is allowed exactly one full-chroma
             * system and the notes own it.
             */
            float lum = dot(uColor, vec3(0.2126, 0.7152, 0.0722));
            vec3 quiet = mix(uColor, vec3(lum), 0.2);
            float bright = min(0.24, 0.11 + uBass * 0.08 + uPulse * 0.05) * (0.42 + amp * 0.58);
            float a = bar * len * inner * nearFade * farFade;
            gl_FragColor = vec4(quiet * bright * a, a);
          }
        `,
      });

      const wingLength = HIGHWAY_LENGTH;
      const geometry = new THREE.PlaneGeometry(WING_WIDTH, wingLength, 1, 96);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      const meshZ = -wingLength / 2;
      // Below the deck, on the ground, so a wing can never be mistaken for track.
      mesh.position.set(0, -0.30, meshZ);

      const position = geometry.attributes['position'] as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const worldZ = meshZ - position.getY(i);
        const w = curveWidth(worldZ);
        // Local x runs -W/2..+W/2 and u runs 0..1 with it, so `along` (and
        // therefore u) already means "distance outward from the rail" on BOTH
        // wings once the whole offset is negated for the left one. The uv needs
        // no mirroring; mirroring it was tried and put each wing's spectrum
        // growing the wrong way.
        const along = position.getX(i) + WING_WIDTH / 2;
        position.setZ(i, curveLift(worldZ));
        position.setX(i, side * ((this.deckHalfWidth + WING_GAP) * w + along));
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();

      mesh.renderOrder = LAYER.rails;
      // Pushed into `rails` so the per-frame uniform write covers it too — the
      // two share a uniform vocabulary exactly so there is one loop, not two.
      this.rails.push(mesh);
      this.scene.add(mesh);
    }
  }

  /**
   * The hit band — the light element that marks the judgement moment, spanning
   * the track across every lane (stage only). This is what consumes
   * `theme.hitLine`.
   *
   * A world-space object rather than a DOM strip: `setViewOffset` pans the whole
   * projection on portrait and `fovFor` widens it per aspect, so a DOM overlay
   * would have to re-derive the receptor line's screen-y on every resize and
   * still disagree at in-between aspects. Anchored in the world it is glued to
   * the receptors by construction and participates in the bloom.
   *
   * **It is centred ON z = 0, and everything about its shape is symmetric about
   * the centre line.** Its predecessor was a 0.9-deep gold-bezelled capsule at
   * z = 1.7 — a full 1.7 units *in front of* the judgement line, i.e. 90ms
   * (extreme) to 179ms (easy) late, which is the same defect CLAUDE.md already
   * records for a hit line at z=0.45, in a new object, three times further out
   * and far brighter. It was also invisible on desktop, which is why it survived:
   * at 1280x800 it sits at 100.8%-111.7% down the frame.
   *
   * The old one was additionally the source of the reported *grain*: a hashed arc
   * re-randomising 11x/second plus a live spectrum waveform, both drawn across a
   * band compressed into ~87px of screen at a grazing angle. Per-pixel noise at
   * the one place the eye rests. Neither survives: the band is now a hard bright
   * core line at the exact hit moment with a smooth symmetric falloff and rounded
   * ends. It brightens on the beat and on a lane press — nothing else moves in it.
   */
  private buildHitBar(): void {
    /*
     * Exactly the receptor row's own lateral extent — outer receptor edge to
     * outer receptor edge — and no wider.
     *
     * It used to be `halfWidth * 2 + 0.5`, which is *wider than the frame* at the
     * receptor row's depth on a portrait phone: the bar ran edge to edge across
     * the viewport, over ~45px of unlit black void outside each rail, with no
     * lateral falloff. A marker that crosses surfaces it is not marking reads as
     * a debug line laid over the scene in screen space, which is what it was
     * accused of being.
     */
    const width = (this.laneCount - 1) * LANE_WIDTH + HIT_ZONE_WIDTH;
    /*
     * `theme.hitLine` pulled halfway to the accent, so the marker always carries
     * theme colour on screen.
     *
     * Every shipped theme's `hitLine` is a near-white (0xffffff on this one) and
     * the field is deliberately exempt from the palette's brightness rules — so
     * used raw it measured saturation 0.01 and read as neutral grey-white, i.e.
     * as no theme at all. CLAUDE.md records that a *white* hit-line bar was
     * deliberately deleted once; blending toward the accent is what keeps this one
     * from being that bar again.
     */
    const core = new THREE.Color(this.theme.hitLine).lerp(new THREE.Color(this.accent), 0.85);
    const accent = new THREE.Color(this.accent);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uPulse: { value: 0 },
        uCore: { value: new THREE.Vector3(core.r, core.g, core.b) },
        uAccent: { value: new THREE.Vector3(accent.r, accent.g, accent.b) },
        // Lane geometry in the band's own uv, so the connector line can be cut
        // out of the socket interiors. See `socket` in the fragment shader.
        uHalfBand: { value: width / 2 },
        uLaneW: { value: LANE_WIDTH },
        uLaneCount: { value: this.laneCount },
        uSocketHalf: { value: HIT_ZONE_WIDTH / 2 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime;
        uniform float uBass;
        uniform float uPulse;
        uniform vec3 uCore;
        uniform vec3 uAccent;
        uniform float uHalfBand;
        uniform float uLaneW;
        uniform float uLaneCount;
        uniform float uSocketHalf;
        void main() {
          // Feathered over the outer 14% of the width — about 30px on a portrait
          // phone — so the light dies inside the outermost receptors and never
          // reaches the rails, let alone the void beyond them. The cost is that
          // the outer lane's slice of the band sits at ~93% brightness; the
          // per-lane marker is the receptor frame, and it is unaffected.
          float ends = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
          float taper = pow(ends, 0.8);

          // Distance from the centre line, in half-band units: 0 exactly at the
          // judgement moment, 1 at the band's edges. Symmetric on purpose — a
          // marker whose bright part is off-centre rewards tapping early or late,
          // and nothing bright may sit forward of z=0 that does not have an equal
          // twin behind it. (An accent kerb at the band's rim was tried and cut
          // for exactly that: the forward one read as a second track edge below
          // the receptors, which is the defect this whole pass removes.)
          float dy = abs(vUv.y - 0.5) * 2.0;

          /*
           * Two zones, and the profile lives entirely in the COLOUR.
           *
           * The core is a soft ~12px-per-side lit core at the judgement moment,
           * not the 3px aliased hairline this was — that hairline measured 0.86
           * relative luminance against 0.71 for the brightest note, so the most
           * artificial mark in the frame was also the brightest. And the wash it
           * sat in measured 0.10-0.15 against 0.06 above it, a 2x gradient nobody
           * sees, so the marker the player actually got was a line rather than
           * Beatstar's labelled band.
           *
           * Both fall off linearly-ish rather than through alpha AND colour: with
           * additive blending the visible amount is colour x alpha, so shaping
           * both squares the falloff, which is how a 0.16 wash became invisible.
           */
          // 0.26 -> 0.13 of the half-band, and dim. Wide and bright, the core was
          // not a marker: it was a near-white haze lying across all four sockets,
          // which is the "white horizontal bar inside each frame" that reads as
          // placeholder art. The per-target marks are now cut into the frames
          // themselves (see makeFrameTexture); what is left here is the thin line
          // that continues them across the gaps, so the row reads as one row.
          float core = pow(smoothstep(0.13, 0.0, dy), 1.2);
          float wash = pow(1.0 - dy, 2.4);

          /*
           * The connector line exists ONLY IN THE GAPS between sockets.
           *
           * It was a full-width additive line, and inside a socket it measured
           * rgb(140,114,45) — hue 44, i.e. warm olive, at 0.19 relative luminance,
           * BRIGHTER than the red lane's own note fill and 25 hue-degrees off the
           * lane it was crossing. So the element whose job is to say "this depth
           * is the moment" was also the thing repainting every target's interior a
           * colour that belongs to no lane. The frames carry their own index marks
           * at the same depth (see makeFrameTexture); this only has to join them
           * up, which is exactly the span between one socket and the next.
           *
           * Measured in world units off the nearest lane centre, so it is lane-count
           * agnostic and cannot drift if HIT_ZONE_WIDTH moves. (No backticks: this
           * is a JS template literal and one would close the string mid-shader.)
           */
          float xw = (vUv.x - 0.5) * uHalfBand * 2.0;
          float rel = xw / uLaneW + (uLaneCount - 1.0) * 0.5;
          float dLane = abs(rel - floor(rel + 0.5)) * uLaneW;
          float gap = smoothstep(uSocketHalf * 0.80, uSocketHalf * 1.02, dLane);

          // A narrow beat range on purpose. This element sits where the eye
          // rests, so a 1.7x downbeat swing would repeatedly take it past the
          // notes' own peak — and past the bloom threshold, which is the flash
          // the beat-flare rate limit exists to avoid.
          float beat = 0.85 + uBass * 0.12 + uPulse * 0.22;
          // The profile moved out of the WASH and into the CORE (0.10/0.22 ->
          // 0.16/0.09). The wash is the full depth of the band, so at 0.22 it laid
          // a flat accent-coloured haze straight across all four sockets — the
          // receptors measured a warm olive interior and read as tinted glass
          // rather than as wells a tile drops into. Weighting the core instead
          // keeps the row's luminance where the judgement actually is.
          /*
           * THE WASH IS GONE; only the core line in the gaps survives.
           *
           * Two reasons, both measured. The reference has *nothing* between its
           * pads — dark deck, edge to edge — so a full-depth haze across the row
           * is an invention, and it was reading as a second contour: the band's
           * own top and bottom edges drew horizontals at 0.062-0.079 and
           * 0.222-0.243 across every pad, against a reference pad that carries
           * exactly one bright horizontal. The pad slab is opaque now (see
           * buildReceptors) so nothing of this reaches a pad's face at all, and
           * what is left has the single job the comment above already claims for
           * it: joining four dashes across three gaps. (No backticks in here: this
           * is a JS template literal and one closes the string mid-shader.)
           *
           * The wash survives only as the core's own shoulder, which is what stops
           * the connector ending in a hard edge where it meets a pad.
           */
          vec3 col = mix(uCore, uAccent, 0.25) * (core + wash * 0.06) * 0.085 * gap * beat;
          gl_FragColor = vec4(col * taper, 1.0);
        }
      `,
    });

    const band = new THREE.Mesh(new THREE.PlaneGeometry(width, HIT_BAND_DEPTH), material);
    band.rotation.x = -Math.PI / 2;
    // Under the receptor frames (-0.05) and pads (-0.07 outer edge) but above the
    // floor (-0.12), so the frames sit ON the band and the band lies on the track.
    band.position.set(0, -0.062, 0);
    // 0, with the receptors and the notes: the floor (-1) composites first, then
    // this, then anything depth-nearer — which is a landed tile, so a tile still
    // draws over the band it lands on. A faded-out tile past the line writes depth
    // but cannot punch a hole in the band, because the band drew first.
    band.renderOrder = LAYER.hitBand;
    this.scene.add(band);
    this.hitBarMaterial = material;
  }

  private buildReceptors(): void {
    for (let lane = 0; lane < this.laneCount; lane++) {
      const hex = laneColor(this.theme, lane);

      /*
       * The slab. On the stage path this is an OPAQUE part — a dark face inside a
       * graded chrome bezel — drawn under everything else in the row; on the
       * classic path it stays the soft lit glow it always was (there the track is
       * bright neon, and a dark slab would read as a hole rather than a target).
       *
       * `PAD_TONE_SCALE` and `toneMapped: false` together are what make the
       * texture's greys mean a relative luminance directly: see `makePadTexture`.
       * The colour is a hair of the lane's tone over white so the row belongs to
       * the song without carrying chroma — the reference's rims are neutral
       * chrome in all four frames, and that is the deliberate exception to "the
       * accent is the only colour in the frame".
       */
      const padAspect = HIT_ZONE_DEPTH / HIT_ZONE_WIDTH;
      const pad = new THREE.Mesh(
        new THREE.PlaneGeometry(HIT_ZONE_WIDTH, HIT_ZONE_DEPTH),
        new THREE.MeshBasicMaterial({
          map: this.stage
            ? Highway.cachedTexture(`pad:${padAspect.toFixed(3)}`, () =>
                Highway.makePadTexture(padAspect),
              )
            : Highway.cachedTexture(`glow:${padAspect.toFixed(3)}`, () =>
                Highway.makeGlowTexture(padAspect),
              ),
          /*
           * NEUTRAL, with no lane tint at all.
           *
           * It was `white -> laneHex at 0.08`, which is invisible as colour and
           * very visible as VALUE: the five lane hues have different luminances,
           * so an 8% lerp made one pad in the row measurably duller than its
           * neighbours ("lane 1's bezel reads distinctly duller than lane 2/3").
           * Four copies of one machined part have to be four copies of one
           * machined part. The reference's rims are neutral chrome in all four
           * frames, and this is the deliberate exception to "the accent is the
           * only colour in the frame".
           */
          color: this.stage
            ? new THREE.Color(0xffffff).multiplyScalar(Highway.PAD_TONE_SCALE)
            : hex,
          transparent: true,
          /*
           * OPAQUE on the stage path, and `updateLanes` no longer animates it.
           *
           * It rested at 0.88, and the missing 12% was a hole: the connector band
           * is drawn before the slab and lands inside the pad's own footprint, so
           * an eighth of it composited straight through the face and drew two extra
           * horizontal edges across every pad — measured at 0.062-0.079 and
           * 0.222-0.243 relative luminance, the second brighter than the far bezel
           * and 57px below the true dash. Three horizontals per pad where the
           * reference has exactly one. `transparent` stays on for the rounded
           * corners; what changed is that the interior is now solid.
           */
          opacity: this.stage ? 1 : 0.18,
          toneMapped: false,
        }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(this.laneX(lane), -0.07, 0);
      pad.renderOrder = LAYER.pad;
      this.pads.push(pad);
      this.scene.add(pad);

      /*
       * The pad's LIGHT — the bezel highlight and the timing dash, additive over
       * the slab. See `makeRimTexture`; on the classic path it is still the old
       * hollow frame, which is what that look's bright track needs.
       *
       * NEUTRAL BRUSHED CHROME on the stage path, the deliberate exception to
       * "the accent is the only colour in the frame". It was the lane hue at 2.8x,
       * which was the right answer while the five lanes were five hues: the rim
       * was where a player checked which lane a note was heading for. Under a
       * single-accent theme that argument inverts — four rims in one hue at four
       * values is a row of four differently-lit copies of the same object, and it
       * spends the frame's whole chroma budget on scenery. The reference is
       * unambiguous here: the rims are chrome/silver in all four frames while
       * everything else carries the accent.
       *
       * 1.9x, not 1.5x, because the dash has to land near 0.8 relative luminance
       * through `updateLanes`'s resting opacity of 0.5 — the reference's pad
       * centre measures 0.823 and ours measured 0.032, which is the difference
       * between marking the tap instant and not drawing it at all.
       */
      const rim = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: this.stage
            ? Highway.cachedTexture(`rim:${(HIT_ZONE_DEPTH / HIT_ZONE_WIDTH).toFixed(3)}`, () =>
                Highway.makeRimTexture(HIT_ZONE_DEPTH / HIT_ZONE_WIDTH),
              )
            : Highway.cachedTexture(
                `frame:${(HIT_ZONE_DEPTH / HIT_ZONE_WIDTH).toFixed(3)}`,
                () => Highway.makeFrameTexture(HIT_ZONE_DEPTH / HIT_ZONE_WIDTH),
              ),
          // 1.55x against a resting opacity of 0.62 (see `updateLanes`) puts the
          // additive gain at 0.96, so a texel authored at alpha a lands at ~0.96a
          // relative luminance on top of the slab's own tone. That is what lets
          // `makeRimTexture` be written in the units the reference was measured
          // in, and it keeps the hot inner edge (0.72) short of the bloom
          // threshold (1.05) — a bloomed bezel is a white smear over the row.
          /*
           * **WARM SILVER, NEUTRAL ACROSS LANES, AND UNDER THE BLOOM FLOOR.**
           *
           * Three separate reports, one cause. (1) The lane lerp made each pad's
           * bezel a different value — see the slab above. (2) Driven to pure white
           * at 1.55 the peak texel landed at 0.96 and the whole rim read as a
           * uniform glowing outline whose bloom skirt was the brightest furniture
           * in the frame, i.e. bloom inverted: the static parts glowed and the
           * notes did not. (3) Real chrome is never pure white — a warm silver is
           * what stops it reading as neon.
           *
           * 0.82 puts the hot band at ~0.51 through `updateLanes`'s resting 0.62
           * and the satin plateau at ~0.26 — sRGB 0.75 and 0.55, which is the
           * reference's own 234-against-160 roll. At 1.12 the peak clipped and the
           * whole shoulder compressed back into one flat cream value, which is why
           * a correctly-authored three-part profile kept reading as a neon
           * outline. Comfortably under the 1.35 bloom threshold, and leaves the notes'
           * rim (1.75) and emblem as the only things in the frame that bloom.
           * `makeRimTexture`'s three bands carry the profile; this only sets the
           * exposure and the tint.
           */
          /*
           * **1.62, not 0.82 — the exposure had to rise so the cross-section
           * could become a two-tone.**
           *
           * At 0.82 the peak texel landed at ~167 display, which is why every
           * attempt to author a 230 specular came back as a grey stroke: the
           * material simply could not express it, so the profile got authored
           * wide-and-bright to compensate and the mip chain averaged it into the
           * flat 140-146 slab the critique kept reporting. The fix is exposure on
           * a NARROW mark, not width on a dim one. `makeRimTexture` now spends
           * almost nothing over the outer half of the bezel and 1.0 on a ~4px
           * line, so the total light the row emits is DOWN even though its peak is
           * up — which is what "the receptor row must not be the brightest
           * structure in the lower frame" asks for.
           *
           * Through `updateLanes`'s resting 0.62 this is a gain of 0.93, so an
           * alpha-1.0 texel lands just under the bloom threshold (1.35) and the
           * notes' rim (1.75) and emblem stay the only things in the frame that
           * bloom. Warm silver, still neutral across lanes.
           */
          /*
           ** **1.55, down from 1.62, because the profile now has AREA.**
           *
           * The two-tone version spent almost nothing over the outer half of the
           * bezel, so 1.62 was affordable: one 4px line at 230 and darkness
           * either side. The bezel now carries a full-width plateau and an outer
           * lip (see `makeRimTexture`), which is several times the emitted light
           * for the same peak — left at 1.62 the row would out-read the notes
           * again, which is the one thing the previous pass fixed. At 1.55 the
           * gain through `updateLanes`'s resting 0.62 is 0.96, and the profile's three
           * authored alphas measure 225 / 160 / 181 against the reference's
           * 233 / 160 / 190,
           * and the peak is still under the 1.35 bloom threshold: the notes
           * (237-254, with 60 luma of headroom over this) stay the only things
           * in the frame that bloom.
           */
          color: this.stage
            ? new THREE.Color(0xfffaf4).multiplyScalar(1.55)
            : new THREE.Color(hex).multiplyScalar(2.8),
          transparent: true,
          // Dead on the stage path: `updateLanes` rewrites this every frame from
          // the lane's flash and the beat pulse, so the resting value is whatever
          // that writes (0.5), not this. Kept for the classic path, which has no
          // per-frame update.
          opacity: 0.6,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(this.laneX(lane), -0.05, 0);
      /*
       * Exactly the slab's footprint — the two are one part. `updateLanes`
       * rewrites this every frame; both sites read the same constants.
       *
       * **SCALE THE PLANE'S OWN AXES: (width, depth, 1), not (width, 1, depth).**
       * `Object3D` applies scale in local space *before* rotation, and this mesh
       * is rotated by the transform rather than by a baked `geometry.rotateX`
       * (which is what `buildNoteGlow` does, and why the same call is spelled
       * differently there). A `PlaneGeometry` lies in local XY, so scaling local Z
       * did nothing at all and the depth stayed 1 against a 3.5-deep pad.
       *
       * The whole rim texture was therefore squashed into a 3.5x-compressed strip
       * across the pad's middle, which is exactly what the critique measured and
       * misattributed: "an additive band 102px tall and 11% wider than the pad is
       * drawn OVER each pad", "two nested rounded-rect contours per pad", and the
       * timing dash reading as "a lens, not a bar" — a 75-texel dash lands at 21
       * screen px when the quad it is on is a third of its intended depth. Three
       * separate blocker findings, one wrong axis.
       */
      rim.scale.set(HIT_ZONE_WIDTH, HIT_ZONE_DEPTH, 1);
      rim.renderOrder = LAYER.receptorFrame;
      this.hitZones.push(rim);
      this.scene.add(rim);
    }
  }


  private buildHoldBodies(): void {
    for (let i = 0; i < MAX_HOLD_BODIES; i++) {
      // 1 x 1 in local space, rebuilt every frame by `layoutHoldBody`. The
      // segment count is what lets it bend; the dimensions here are arbitrary.
      const geometry = new THREE.PlaneGeometry(1, 1, 1, HOLD_SEGMENTS);
      const material = new THREE.MeshBasicMaterial({
          // The beam profile, shared with the head streak (`makeTrailTexture`):
          // R is the accent flank, G the white core. A hold body IS the beam the
          // reference shows, so it has to be built out of the same two masks —
          // as a flat accent ribbon it measured chroma-only with no core at all,
          // which is the "all-accent beam looks markedly cheaper" defect.
          map: Highway.cachedTexture('trail', () => Highway.makeTrailTexture()),
          transparent: true,
          // Additive, like the halos: a hold body is light on the track, and
          // over-writing the lane tint underneath would flatten the highway.
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
          // Fog would eat the far end of a long body, which is exactly the part
          // that needs to read as "this continues".
          fog: false,
      });
      /*
       * Spend the two masks the same way `buildNoteTrails` does, but off the
       * `diffuse` UNIFORM rather than an instance colour — these are individual
       * meshes (each hold is a different length, so they cannot be instanced) and
       * there is no `vColor` here to read. The core is added as neutral white and
       * scaled by the accent's peak channel, so it dims with the body's own
       * brightness ramp instead of needing a second uniform.
       *
       * **Re-weighted to 2.2 flank / 8.0 core once the envelope was widened.**
       * The old 2.8/4.5 was tuned around a beam a third of this width, where the
       * core was a thread and chroma was all there was room for; at the measured
       * width the same weighting rendered the whole rod as flat accent, and the
       * reference is explicit that "an all-accent beam looks markedly cheaper" —
       * its core is near-white and the accent lives only in the surrounding
       * glow. The core's hue mix drops to 0.10 for the same reason: it is white
       * that is tinted by its neighbour, not accent that happens to be bright.
       *
       * **Then 2.8 flank / 5.0 core, with the core mask halved.** At 8.0 the core
       * clipped over most of its own bell, so the "solid core" measured on the
       * capture was far wider than the mask that authored it — 0.32 of the note
       * against the reference's 0.14-0.17. Narrowing the mask alone would have
       * left a thread; the gain has to come down WITH it so the clipped plateau
       * is the filament rather than the whole bell, and the flank rises to keep
       * the >80-luma envelope where it was.
       *
       * `diffuseColor.a` is forced to 1: the profiles live in the colour
       * channels, and additive blending would otherwise dim them a second time by
       * `opacity`. Brightness is folded into `material.color` for that reason.
       *
       * (No backticks in here: this is a JS template literal and one would close
       * the string mid-shader.)
       */
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          /* glsl */ `
	vec4 beam = texture2D( map, vMapUv );
	float energy = max( diffuse.r, max( diffuse.g, diffuse.b ) );
	vec3 hue = diffuse / max( energy, 0.04 );
	diffuseColor.rgb = diffuse * beam.r * 2.4
	                 + mix( vec3( 1.0 ), hue, 0.10 ) * beam.g * energy * 5.2;
	diffuseColor.a = 1.0;`,
        );
      };
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      // Behind the notes, in front of the floor.
      mesh.renderOrder = LAYER.hold;
      this.holdBodies.push(mesh);
      this.scene.add(mesh);
    }
  }

  /**
   * Lay a body's vertices along the track between two z values.
   *
   * Written in world space directly rather than by positioning and rotating the
   * mesh, because the strip is *curved* — there is no single transform that
   * puts a flat quad on a bending surface. Each row of vertices gets its own
   * `curveLift` and `curveWidth`, which is the same treatment the floor and the
   * notes get and the reason they stay visually attached.
   */
  private layoutHoldBody(
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
    lane: number,
    nearZ: number,
    farZ: number,
  ): void {
    const position = mesh.geometry.attributes['position'] as THREE.BufferAttribute;
    const rows = HOLD_SEGMENTS + 1;

    for (let row = 0; row < rows; row++) {
      // PlaneGeometry rows run from +height/2 down, so row 0 is the far end.
      const t = row / HOLD_SEGMENTS;
      const z = farZ + (nearZ - farZ) * t;
      /*
       * The quad is the beam's OUTER envelope, matched to the head streak's
       * (`TILE_WIDTH * 0.42`) so body and head are one continuous beam rather
       * than a bright head sitting on a thinner thread. The texture's compact
       * bell reaches zero well inside it, so the visible glow is ~0.42 of the
       * note and the white core ~0.09 — the reference's own proportions.
       *
       * Tapered along its length as well: `t` is 1 at the near (head) end, so
       * the far end narrows to 72%. That is a shape the perspective alone does
       * not give — a constant-width strip laid on a receding plane reads as a
       * wedge that gets *wider* as it recedes relative to its lane.
       */
      /*
       * **0.34, not 0.21 — measured against the reference rather than derived.**
       * The reference's beam profiles at a constant 59-63 device px against a
       * note ~238 device px wide, i.e. the visible glow is ~0.26 of the note.
       * At 0.21 (envelope 0.42 of the tile, of which the bell uses well under
       * half) ours measured ~0.10 of the note: a gold thread, not the broad
       * white-hot rod the reference streams up the lane. It is the ONLY element
       * allowed to carry that energy — tap notes get no beam at all, by the
       * owner's explicit instruction — so it has to be the right size.
       */
      /*
       * **0.19 with the taper INVERTED, and both halves are measured.**
       *
       * At 0.34 the visible glow measured 0.54 of the note's width on the shipped
       * capture, against 0.25-0.34 in the reference — a wedge, not a rod, and the
       * single biggest reason a hold read as cheap. 0.21 puts the near end at 0.27 measured (0.19 landed at 0.25, the bottom of the band)
       * of the note, which is also exactly what the head streak now uses.
       *
       * The length taper ran the wrong way. `t` is 1 at the NEAR end, so
       * `0.72 + 0.28 t` widened the end that perspective was already widening:
       * profiled up the beam, ours ran 25 -> 108 device px where the reference's
       * runs 26 -> 45. Widening the FAR end in world units is what buys back a
       * near-constant screen width; it cannot be bought fully (the reference's
       * lane is seen through a much shallower runway), but 1.34 -> 1.0 takes a
       * 4.3x screen flare down to about 3.2x.
       */
      /*
       * **0.30, re-measured on a frame that actually contains a hold.** The 0.21
       * above was set from a capture whose beam was profiled at the receptors;
       * cropped at 2x against the reference at matched depths, ours runs 27 device
       * px against a 165px note (0.16) where the reference runs 55 against 205
       * (0.27). The band the brief asks for is 0.25-0.34, so the envelope has to
       * grow — 0.30 with a p=1.7 bell overshot to 0.40, so 0.255/p=2.0 is where it
       * lands (measured 0.30 of the note, near-constant up the track) — and the bell inside it widens too (see makeTrailTexture),
       * because a compact profile only spends about 40% of its envelope.
       */
      /*
       * **1.60 at the far end, not 1.34 — measured on the first capture that
       * contains a hold at all.**
       *
       * The head end is unchanged (t = 1 gives 1.0), and it is the end the
       * hold/note width ratio is specified against: profiled at 4x, the glow
       * envelope runs ~62 device px against a ~205px note, i.e. **0.30**, inside
       * the 0.25-0.34 band. What the capture also shows is that the far end had
       * collapsed to ~15 device px, which is what turned the rounded cap into a
       * spearhead — a cap cannot read as a cap on a beam narrower than the cap is
       * long. Widening the far end in world units is the only lever that buys back
       * screen width against the perspective, and it costs the head nothing.
       */
      const halfWidth = TILE_WIDTH * 0.30 * (2.2 - 1.2 * t) * curveWidth(z);
      const x = this.laneX(lane) * curveWidth(z);
      // Just above the floor and just below the note pills, so it reads as
      // lying on the track rather than floating over it.
      const y = 0.02 + curveLift(z);

      for (let col = 0; col < 2; col++) {
        const index = row * 2 + col;
        position.setXYZ(index, x + (col === 0 ? -halfWidth : halfWidth), y, z);
      }
    }

    position.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
  }

  private buildNotes(): THREE.InstancedMesh {
    // Real 3D geometry, not a painted tile. A rounded rectangle extruded into a
    // slab with BEVELLED edges, lit by the scene's key light so the chamfers
    // catch a highlight on top and shade underneath — genuinely three-dimensional
    // metal, which a flat quad with a baked-in bevel could never fake at this
    // camera angle. Sized in world units here (not per-instance-scaled from a
    // unit cube), so the bevel stays even. A faceted-gem variant was tried in the
    // neon-arcade redesign and reverted: the strong emissive tint washed out the
    // facets and it read flatter than the glossy metal bar it replaced.
    const geometry = Highway.makeTileGeometry();

    /*
     * The lane hue is driven through EMISSIVE, and the albedo is black.
     *
     * This tile used to be `metalness: 1, envMapIntensity: 2.6` with a constant
     * `emissive: accent`. At full metalness the PBR model *zeroes the diffuse
     * term* and spends the instance colour as specular F0 only, so the face's
     * brightness came almost entirely from an untinted greyscale environment and
     * a white key light — measured on the shipped frame, a lane-3 tile read
     * #b9c4c1 (saturation 0.06) sitting above its own blue receptor, and every
     * lane's halo was the same fixed accent. The four-hue lane system existed in
     * the theme, in the floor and in the receptors, and nowhere on the object the
     * player actually tracks. That is a readability failure, not a taste one.
     *
     * Black albedo removes every untinted diffuse path (key light, ambient, IBL
     * diffuse) at a stroke, leaving one authored term — `vColor * shade` — so a
     * lane's chroma survives ACES intact. What the lights still contribute is a
     * faint white specular on the chamfers (F0 = 0.04 at metalness 0), which is
     * the "manufactured object" cue and is far too small to bleach the face.
     */
    const material = new THREE.MeshStandardMaterial({
      color: 0x000000,
      metalness: 0,
      // Deliberately broad. A tight lobe (0.12) at this key intensity puts a
      // blown near-white specular hotspot across whichever tiles catch the
      // mirror direction — the same wash, re-introduced through the back door.
      //
      // The white specular is the LAST untinted path into the fill, and it is
      // measurable: at `envMapIntensity: 1.4` a green tile whose emissive predicts
      // (1,165,80) rendered (89,196,120), saturation 0.54 against a 0.65 floor.
      // Almost all of that lift is in the channels the lane hue leaves near zero,
      // which is exactly where saturation lives. Hence 0.25 — enough that the
      // chamfers catch a highlight, too little to grey the face.
      roughness: 0.62,
      envMapIntensity: 0.25,
      emissive: 0xffffff,
      emissiveIntensity: 1,
      fog: false,
    });

    // Per-instance fade for the visibility modifiers (Hidden / Fade-out).
    //
    // A colour multiply cannot hide these tiles: the material is emissive, so a
    // black instance colour still shows the emissive term. Real per-instance
    // *alpha* is needed, which InstancedMesh only supports through a shader.
    // `instanceReveal` (1 = fully visible, 0 = gone) is read in the vertex shader
    // and multiplied into the fragment alpha, so a fading note takes its emissive
    // and its sheen down with it.
    material.transparent = true;
    // Half-extents of the extruded slab's TOP FACE, which is what the camera
    // mostly sees. `bevelSize` expands the slab's waist beyond these, so the
    // metric below runs past 1.0 on the chamfers — that is deliberate, it is what
    // puts the lit rim on the chamfer.
    const halfW = (TILE_WIDTH / 2).toFixed(4);
    const halfD = (TILE_DEPTH / 2).toFixed(4);
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float instanceReveal;\nattribute float instanceNear;\n' +
        'varying float vReveal;\nvarying float vNear;\nvarying vec3 vTile;\n' +
        shader.vertexShader.replace(
          'void main() {',
          'void main() {\n\tvReveal = instanceReveal;\n\tvNear = instanceNear;\n\tvTile = position;',
        );
      shader.fragmentShader =
        'varying float vReveal;\nvarying float vNear;\nvarying vec3 vTile;\n' +
        shader.fragmentShader
          .replace(
            '#include <emissivemap_fragment>',
            /* glsl */ `#include <emissivemap_fragment>
	/*
	 * THE SLAB HAS A TOP AND IT HAS A WALL, AND THE SPLIT IS ON HEIGHT.
	 *
	 * Two things were wrong here and both were measurable. The zones were first cut
	 * on the FOOTPRINT metric alone, so every fragment of the extruded side wall —
	 * which by construction sits at the outer edge of that metric — landed in the
	 * "rim" band and rendered at 1.3x: the shipped frame read top face 0.584
	 * relative luminance against a front wall of 0.800, a solid lit from
	 * underneath. Splitting on height fixed the polarity and then got the height
	 * wrong: the crossover sat at 0.52-0.78 of TILE_HEIGHT, which is halfway up the
	 * STRAIGHT WALL, so the wall's upper half rendered as face and the profile came
	 * out as a soft 15px ramp instead of an edge. Profiled on the shipped frame the
	 * near note went face L50 -> ramp -> wall L20 with no lip anywhere, and the far
	 * note had no wall band at all; the reference gives six legible levels in 36px
	 * (face L55 -> specular lip L74 -> wall L26 S80 -> deeper wall L15 S90 ->
	 * contact shadow L11 -> deck L17).
	 *
	 * The slab is bevelThickness of bottom chamfer, then a straight wall, then the
	 * same again as the top chamfer — so the crossover belongs at
	 * 1 - bevelThickness/TILE_HEIGHT = 0.864, and the numbers below straddle
	 * exactly that. TILE_HEIGHT exists so the shader and the geometry cannot drift.
	 * (No backticks in here: this is a JS template literal and one closes the
	 * string mid-shader.)
	 */
	float ax = abs(vTile.x) / ${halfW};
	float az = abs(vTile.z) / ${halfD};
	// Squircle, so the zones follow the tile's rounded corners instead of
	// cutting them square.
	float edge = pow(pow(ax, 6.0) + pow(az, 6.0), 0.16667);
	// 0 on the deck, 1 on the top face.
	float up = clamp(vTile.y / ${TILE_HEIGHT.toFixed(4)}, 0.0, 1.0);
	// The straight wall ends where the top chamfer begins. Derived rather than
	// typed, or it silently drifts the moment either constant moves.
	float top = smoothstep(${(TOP_SPLIT - 0.014).toFixed(4)}, ${(TOP_SPLIT + 0.097).toFixed(4)}, up);
	// 0 at the wall's bottom edge, 1 where it meets the chamfer.
	float wallUp = clamp(up / ${TOP_SPLIT.toFixed(4)}, 0.0, 1.0);
	/*
	 * WHICH WAY THE LIGHT COMES FROM. The reference's rim light is a 3-4px line
	 * confined to the LEFT and NEAR edges of the top face, wrapping the
	 * bottom-left corner and dying out toward the top-right. Ours was a uniform
	 * ~14px cream stroke of the same brightness on all four sides — no physical
	 * object is lit equally on four sides, so it read as a printed outline or a
	 * sticker rather than as a chamfer catching light.
	 *
	 * The outward direction in the tile's own plane, dotted with the key. Used by
	 * the inner border and the chamfer lip, which are the two elements that were
	 * drawing an outline.
	 */
	vec2 outward = normalize(vec2(vTile.x, vTile.z) + vec2(1e-4, 1e-4));
	float dirLit = clamp(dot(outward, vec2(-0.66, 0.75)), 0.0, 1.0);
	/*
	 * A NOTE IS A SOLID; A RECEPTOR IS A HOLE. There is no concentric groove.
	 *
	 * The tile used to carry a dark ring just inside its rim, which is exactly the
	 * drawing a receptor socket is: bright outer rounded-rect rim, dark inset
	 * groove, lighter interior. At 400% the mid-runway tile and the receptor below
	 * it were the same object in two brightnesses, and at 1/8 downsample a landed
	 * tile read as "the fourth socket, lit up" rather than as a note. The player
	 * has to tell "thing I tap" from "place I tap it" in peripheral vision, so the
	 * two now have OPPOSITE tonal structures: the socket is dark-inside/thin-rim,
	 * the tile is a filled bright body with a single bright hairline at its edge.
	 */
	// 0 at the trailing edge, 1 at the leading one.
	float lead = clamp(vTile.z / ${halfD} * 0.5 + 0.5, 0.0, 1.0);
	// 1 at the left edge, 0 at the right.
	float side = clamp(-vTile.x / ${halfW} * 0.5 + 0.5, 0.0, 1.0);
	/*
	 * The top face: a glossy gradient along the slab, brighter at the near edge.
	 *
	 * The ramp is 0.52 -> 0.70, which is the reference's own and is three times
	 * what this used to run. Profiled down the middle of its lane-3 note the face
	 * goes L42 at the far edge to L55 at the near one — a 31% lift — where ours
	 * went 0.55 -> 0.62 linear, about 8% in L, i.e. visually flat. (The brief's
	 * "brighter toward the top" is the one place the frames contradict the words;
	 * every one of them is brighter toward the CAMERA, and the measurement wins.)
	 */
	/*
	 * **The ramp is 0.20, not 0.15, and the reason is a craft read rather than a
	 * measurement of the reference.** At 0.15 across the slab the face profiled as
	 * "near-flat matte gold" — the gradient existed arithmetically and did not
	 * survive tone mapping as something an eye calls glossy. The reference's face
	 * carries an unmistakable ramp from a bright near edge to a deeper accent at
	 * the far one; 0.48 -> 0.68 is +42% in the authored term against the old +27%,
	 * and it costs nothing in peak brightness because the ramp is spent at the far
	 * end (where the note is also smallest) rather than added at the near one.
	 */
	/*
	 * **The LATERAL term goes to 0.12, from 0.03.** The face profiled as a flat
	 * single-value fill: a 0.03 swing across the slab is under one 8-bit step once
	 * the tone curve has had it, so the only gradient on the object ran along the
	 * lane, where perspective already compresses it. The reference's face is
	 * unmistakably graded across its width as well as along it — that cross-gradient
	 * is what says "a curved moulding under one lamp" rather than "a coloured
	 * rectangle". It is on side (1 at the left edge), the same direction dirLit
	 * uses, so the face, the border and the chamfer lip all agree about where the
	 * key is.
	 */
	float face = 0.44 + 0.20 * lead + 0.12 * side;
	// The sheen a moulded plastic key catches, in HUE. Deliberately not white: a
	// white specular is the last untinted path into the fill and it is what greyed
	// this face before. Placed on the leading edge, where the key rakes it.
	face += smoothstep(0.10, 0.0, abs(lead - 0.90)) * (0.04 + 0.05 * vNear);
	/*
	 * A far-field lift, and it is compensation rather than a depth cue.
	 *
	 * CLAUDE.md's readability rule is comparative — every lane's fill has to sit
	 * within about 0.15 value of the others, and a brightness ramp with distance is
	 * what broke that once. This runs the other way: the far tile is geometrically
	 * penalised (its top face is foreshortened to a sliver while its wall stands
	 * nearly perpendicular to the view ray), so a flat authored value renders the
	 * topmost note as the DIMMEST thing on the board — the one note the player
	 * reads first. Smaller than it was, because the wall it is compensating for is
	 * no longer painted at face value.
	 */
	face += 0.10 * (1.0 - vNear);
	/*
	 * The side wall: darker than the face by a factor of three, and in a DEEPER
	 * shade of the same accent rather than a scalar multiple of it.
	 *
	 * The reference's wall is not its face turned down — its face is (91,168,188)
	 * and its wall (0,61,82), which is 0.00 / 0.36 / 0.44 per channel. A scalar
	 * cannot express that, and the difference is the whole "darker shade of the
	 * accent" the brief asks for: the wall reads S80-100 against a face at S43.
	 * Squaring each channel against the peak keeps the hue and the peak channel
	 * where they are while collapsing the flanks, which is exactly that move.
	 *
	 * The shade is still depth-dependent. The view ray to a far tile is much closer
	 * to horizontal than the ray to a near one, so at the crest the wall is a third
	 * of the note's whole silhouette; authored at the near value it painted the
	 * topmost note black. vNear is 0 at the spawn point and 1 at the receptors.
	 */
	float peakC = max(vColor.r, max(vColor.g, vColor.b));
	vec3 deepHue = vColor * vColor / max(peakC, 0.04);
	// One more collapse of the flanks, for the bottom of the wall — the reference
	// gains 14 points of saturation between the top of its wall and the bottom.
	vec3 deeperHue = deepHue * vColor / max(peakC, 0.04);
	/*
	 * GRADED DOWN ITS OWN HEIGHT, which is the half of this the last pass missed.
	 *
	 * Profiled down the centre of the shipped far note the wall read
	 * rgb(145,114,13) unchanged for 60 consecutive rows: zero gradient, no
	 * contour under it, and it went straight from L31 wall to L23 deck. That is a
	 * mustard rectangle glued under a tile, not a shadowed side. The reference
	 * grades 15,97,121 (S78, L26.7) at the top of its wall to 0,61,82 (S92, L15.5)
	 * at the bottom and then hits a 46,61,64 contact contour before the deck.
	 *
	 * Sub-linear in wallUp so the loss is spent low, where a real wall turns away
	 * from the light — a linear ramp reads as a gradient painted on.
	 */
	/*
	 * **The near end goes to 0.40, not 0.24.** At 0.24 a near tile's wall bottomed
	 * out around 0.08 against a face of 0.68 — a heavy near-black slab under the
	 * note rather than the same material in shadow, which is what the reference's
	 * is (face 91,168,188 against wall 0,61,82 is 0.36 of the face's luminance, not
	 * 0.12). The hue collapse below already carries the "deeper shade of the accent"
	 * read; the value did not need to do it a second time.
	 */
	float wall = (mix(0.34, 1.0, pow(wallUp, 0.72)) * mix(0.56, 0.40, vNear) + 0.07 * side);
	// The contact contour: the last sliver of wall goes near-black, so the
	// silhouette sits on a dark line rather than dissolving into the deck.
	float contour = smoothstep(0.16, 0.0, wallUp);
	/*
	 * The bright inner border, just inside the top face's outline — and it is
	 * ALLOWED TO CLIP now, which is the change.
	 *
	 * It used to be capped at a linear peak of 0.80 "just under the bloom
	 * threshold", and the cost of that was the whole frame: measured on the shipped
	 * capture, ZERO pixels at value >= 250 and an absolute maximum of 245 that was
	 * HUD text, against reference frames that put 0.5-4.4% of their pixels at 250+.
	 * A picture with no specular tier reads printed rather than lit, whatever its
	 * mid-tones measure. The reference's own ratio is a 3px line at val 249 over a
	 * 185 face, i.e. +34%; the band below is a few px wide and lands there.
	 *
	 * Peak-normalised, not luminance-normalised: luminance weights green 0.72
	 * against red 0.21, so solving for luminance gave a red lane a rim at peak
	 * channel 6.6 and a green one 1.4. Peak-normalising makes every lane compress
	 * by exactly the same amount on the way through the tone curve.
	 *
	 * **Accent-tinted and directional now, not driven to cream.** At 3.6x it
	 * measured 247,238,214 / 249,241,221 — the same value on all four sides, a
	 * 14px printed outline. The frame's specular tier is bought from the emblem
	 * and the beams instead (both of which the reference also clips to white),
	 * which is where light of that intensity actually belongs.
	 */
	// 1.5, not 1.75. Still past the bloom threshold (1.35) — the note's rim and its
	// emblem are the only things in the frame that are, now that the receptor bezel
	// has been taken under it — but no longer far enough past to skirt the deck.
	float borderBright = min(face * 2.3, 1.50 / max(peakC, 0.06));
	// A hairline, not a band. At 0.80-1.02 of the edge metric this spanned ~24
	// device px on the near note and read as a soft glow around the whole tile;
	// the reference's is 3px. Half that span, centred just inside the rim.
	/*
	 * **Wider, and with a floor under dirLit — that floor is the correction.** At a
	 * (No backticks anywhere in here: this is a JS template literal.)
	 * 0.028-wide band gated to 0.14 on the unlit sides it was a 1-2px line that
	 * survived on one edge only, and the frame read as a tinted card. The reference
	 * carries a defined 3-4px bright inset line that runs the whole way round —
	 * dimmer where the key turns away, but never absent. The band goes to 0.042
	 * wide and the floor to 0.34, which restores the "moulded slab" read without
	 * going back to the flat 14px printed outline that was reverted before: it is
	 * still directional, just no longer directional to the point of vanishing.
	 */
	/*
	 * **Softened into a roll, and the unlit floor dropped to 0.22.** The band read
	 * as "a hard blown white bar across the top edge": at 0.930-0.962 rising and
	 * 1.000-0.972 falling it is a 3-texel plateau with near-vertical shoulders, so
	 * the whole outline landed on one clipped value, and with the floor at 0.34 it
	 * did so on the far edge too — where the key does not reach and the reference's
	 * rim is at its dimmest. Wider and shallower on both shoulders is a bevel
	 * catching light; the same energy with vertical sides is a printed stroke.
	 */
	float border = smoothstep(0.908, 0.958, edge) * smoothstep(1.008, 0.962, edge) * top
	             * (0.22 + 0.78 * dirLit);
	/*
	 * The specular chamfer lip — the single highlight that makes a moulded object
	 * read as moulded, and the one element the profile above was missing entirely.
	 *
	 * It lives on the top chamfer only: up runs 0.864 -> 1.0 across it, so the band
	 * below excludes both the straight wall (up < 0.864) and the flat top face
	 * (up = 1.0). Added as white rather than multiplied into the hue, because that
	 * is what the reference's is — (156,205,219) against a face of (56,133,159) is
	 * brighter AND less saturated, which a tint cannot do.
	 */
	/*
	 * **Directional, and that is a fix rather than a refinement.** Added flat, it
	 * put a blown near-white bar right across the tile's full width at the
	 * face/wall junction (measured 247,237,213), which the reference does not
	 * have; its lip is 2px and only where the key rakes it.
	 */
	float lip = smoothstep(${(TOP_SPLIT + 0.002).toFixed(4)}, ${(TOP_SPLIT + 0.062).toFixed(4)}, up)
	          * smoothstep(1.000, 0.950, up)
	          * (0.08 + 0.92 * dirLit);
	/*
	 * The LEFT AND RIGHT walls roll off dark — the tile's contour where it matters.
	 *
	 * Gated on ax rather than on the squircle: the straight wall sits at a single
	 * value of the edge metric all the way round, so an edge-gated skirt darkens
	 * the whole wall instead of a band of it. What this is for is the seam between
	 * two notes landing in adjacent lanes — measured on the shipped frame, the
	 * lane-2 and lane-3 notes welded into one 588px bar separated by a 4px line —
	 * and that seam is made of left and right walls only.
	 */
	float skirt = smoothstep(0.97, 1.05, ax) * (1.0 - top);
	/*
	 * A centred emblem. The reference carries its own logo here; ours is a plain
	 * rounded diamond, which is a themed mark rather than borrowed art.
	 *
	 * It is not decoration alone: it is most of the frame's specular tier (the
	 * reference's emblem clips to 255) and it is what stops the face measuring as a
	 * dead flat fill — high-pass energy over ours read 0.042 against the
	 * reference's 0.97-1.77 across the same size patch. Scaled in world units,
	 * wider in z than in x so it projects square rather than as a lozenge.
	 *
	 * **A CHEVRON AT REFERENCE SCALE, not a rotationally-symmetric speck.** The
	 * diamond measured 41px across a 255px note face — 16% — where the reference's
	 * logo is 41% of its note's width at two different depths, and counting bright
	 * neutral pixels inside equal-area faces put ours 3.1x short. At 16% it is too
	 * small to function as the note's brightest feature, which is the job it has.
	 *
	 * **NOT A CHEVRON, and this is an owner ruling rather than a taste call.**
	 * The mark this replaces was a V pointing at the receptor: "the arrow on top
	 * of them not needed". An arrow implies a swipe, or a direction to hit from,
	 * and the game has neither — every note is a tap. So the mark keeps the size
	 * and the specular job the chevron was carrying (it is most of the frame's
	 * clipped-white tier, and without it the face measures as a dead flat fill)
	 * and loses the orientation.
	 *
	 * A diamond OUTLINE rather than a filled blob: an outline has the fine
	 * high-frequency detail that made the chevron read as a machined glyph, where
	 * a solid lozenge at 40% of the face reads as a paint splash.
	 *
	 * The half-extents are in world units and the z one is roughly twice the x
	 * one, because the top face is foreshortened by about half at this camera —
	 * that is what makes the mark project square rather than as a lozenge.
	 */
	float ex = vTile.x / 0.254;
	float ez = vTile.z / 0.505;
	// Distance to the diamond |ex| + |ez| = 1, normalised by the gradient. Fully
	// symmetric in both axes, so it points nowhere.
	float chev = abs(abs(ex) + abs(ez) - 1.0) * 0.7071;
	// A soft vignette so the ring's corners fall off rather than ending square.
	float arms = smoothstep(1.55, 1.30, max(abs(ex), abs(ez)));
	/*
	 * **A THIN OUTLINE, not a band — and it may not blow out.**
	 *
	 * Measured on the shipped capture, the mark ran HSL L96 over ~90px with 3493
	 * pixels above L90 inside the near slab: a white blob, not a glyph. The
	 * reference's mark is L98 too, but as 5-8px strokes interleaved with a face at
	 * L65-68, so it reads as a machined logo rather than as a light. So the fix is
	 * WIDTH, not only exposure: 0.13/0.07 across the distance metric is roughly
	 * half the band, and the exposure below is capped under the note's own rim
	 * highlight (borderBright, 1.75) so the specular tier stays where the tile's
	 * lit chamfer puts it.
	 */
	float emblem = smoothstep(0.125, 0.065, chev) * arms * top;
	// A soft halo around it, which is what the reference's mark carries and what
	// stops a hard-edged glyph reading as a decal printed on the face.
	float emblemGlow = smoothstep(0.30, 0.11, chev) * arms * top;

	/*
	 * A far-field EXPOSURE lift on the whole slab, not just its face.
	 *
	 * Measured rather than reasoned: sampling the same lane down the runway, both
	 * the deck AND every object on it fall by about 3.5x between z = -14 and
	 * z = -19 (deck value 50 -> 13 on a matched patch), which is far more than any
	 * term in either shader accounts for. Whatever the mechanism, the consequence
	 * is the one CLAUDE.md warns about: the topmost note — the one the player reads
	 * FIRST to parse the pattern — arrives as the dimmest object on the board, and
	 * on a capture it measured L5 against L55 for its neighbours a third of the way
	 * down. This cancels most of it. Held to the last fifth of the runway and
	 * tapered out by vNear 0.55, so nothing in the field the player is actually
	 * aiming at is touched.
	 */
	float farLift = mix(2.4, 1.0, smoothstep(0.10, 0.55, vNear));
	// The wall's hue deepens as it darkens, which is the reference's own move —
	// its wall gains 14 points of saturation over the same 11 L it loses.
	vec3 wallHue = mix(deeperHue, deepHue, smoothstep(0.0, 0.75, wallUp));
	vec3 body = mix(wallHue * wall, vColor * face, top) * farLift;
	body = mix(body, vColor * borderBright, border);
	body *= (1.0 - 0.62 * skirt);
	// The dark line where the wall meets the deck.
	body *= (1.0 - 0.66 * contour * (1.0 - top));
	// Half tinted, so the chamfer keeps the lane's hue instead of bleaching to
	// cream: the reference's lip is brighter AND less saturated than the face,
	// which is a partial desaturation rather than a jump to white.
	body += mix(vColor / max(peakC, 0.06), vec3(1.0), 0.55) * lip * (0.34 + 0.46 * vNear);
	// The mark, and its halo. The core is allowed to clip — it is the note's
	// brightest feature in every reference frame and it is where the frame's
	// specular tier is supposed to come from.
	/*
	 * Accent-tinted and held UNDER the rim, where it used to be driven to 3.7 as
	 * neutral white. Two consequences were measured: the mark clipped all three
	 * channels (253,251,244 — chroma 9 on a gold lane, i.e. no lane information at
	 * all), and it sat far enough past the bloom threshold to be the note's main
	 * contributor to the deck bleed either side of it. The reference's own mark
	 * clips too, but it is cyan where it clips (231,250,254) and it is a glyph, not
	 * a lamp.
	 */
	body += mix(vColor / max(peakC, 0.06), vec3(1.0), 0.66) * emblem * (0.86 + 0.34 * vNear);
	body += mix(vColor / max(peakC, 0.06), vec3(1.0), 0.4) * emblemGlow * (0.11 + 0.13 * vNear);
	totalEmissiveRadiance *= body;`,
          )
          .replace(
            '#include <dithering_fragment>',
            '#include <dithering_fragment>\n\tgl_FragColor.a *= vReveal;',
          );
    };

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_NOTE_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = LAYER.note;

    // `instanceColor` allocated up front, not left to the first `setColorAt`.
    // The shader injection above READS `vColor`, and that varying only exists
    // when `USE_INSTANCING_COLOR` is defined — which three derives from this
    // attribute being present at compile time. Left lazy, the first program
    // compiled without it and the fragment shader failed to link with
    // "'vColor': undeclared identifier", i.e. no notes at all.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_NOTE_INSTANCES * 3).fill(1),
      3,
    );
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    // The reveal attribute lives on the geometry (InstancedMesh reads instanced
    // attributes from there). Default 1 so a note is fully visible until the
    // modifier says otherwise.
    const reveal = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_NOTE_INSTANCES).fill(1),
      1,
    );
    reveal.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('instanceReveal', reveal);

    // Nearness (0 at the spawn point, 1 at the receptors). Only the groove reads
    // it, and only to switch itself off in the distance — a per-instance float is
    // cheaper and steadier than re-deriving depth in the shader.
    const near = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NOTE_INSTANCES), 1);
    near.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('instanceNear', near);

    return mesh;
  }

  /** A soft rounded-rect glow, shaped to the tile, for the outer glow it casts on the lane. */
  private static makeGlowTexture(aspect: number): THREE.CanvasTexture {
    const w = 128;
    const h = Math.round(w * aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      // A small rounded rect blurred hard, so it feathers out into a glow that
      // reaches zero alpha WELL before the canvas edge — otherwise the still-lit
      // blur meets the quad boundary and reads as a hard rectangular cut. The
      // generous pad plus the blur radius guarantees a fully transparent margin.
      const pad = Math.round(w * 0.24);
      ctx.filter = `blur(${Math.round(w * 0.1)}px)`;
      Highway.roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, Math.round((w - pad * 2) * 0.45));
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fill();
    }

    return new THREE.CanvasTexture(canvas);
  }

  /** A rounded-rect slab with bevelled edges, laid flat on the track (thickness up). */
  private static makeTileGeometry(): THREE.ExtrudeGeometry {
    const w = TILE_WIDTH;
    const d = TILE_DEPTH;
    const r = Math.min(w, d) * 0.22;
    const x0 = -w / 2;
    const y0 = -d / 2;

    const shape = new THREE.Shape();
    shape.moveTo(x0 + r, y0);
    shape.lineTo(x0 + w - r, y0);
    shape.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    shape.lineTo(x0 + w, y0 + d - r);
    shape.quadraticCurveTo(x0 + w, y0 + d, x0 + w - r, y0 + d);
    shape.lineTo(x0 + r, y0 + d);
    shape.quadraticCurveTo(x0, y0 + d, x0, y0 + d - r);
    shape.lineTo(x0, y0 + r);
    shape.quadraticCurveTo(x0, y0, x0 + r, y0);

    const geometry = new THREE.ExtrudeGeometry(shape, {
      // `bevelSize` is the in-plane offset, so the finished footprint is
      // `TILE_*` + 2 * bevelSize — that is what `TILE_OUTER_*` records, and it must
      // stay in step with this. `bevelThickness` is the out-of-plane one, and the
      // slab's total height is `depth + 2 * bevelThickness` = 0.12.
      //
      // The reference's notes have a clearly visible SIDE WALL along the bottom
      // and one side — that is what makes them read as objects rather than
      // decals, and it is the half of "the note bars are tiny" that size alone
      // does not fix. The old worry (a raised slab's silhouette sitting off its
      // flat target) is gone with the pad: the slot is 3.5 deep against a 2.0
      // tile, so the tile has room to stand in it. More bevel segments keep the
      // chamfer a soft rounded-over lip rather than a hard facet.
      // See `TILE_HEIGHT` for why the wall is as tall as it is.
      depth: TILE_EXTRUDE,
      bevelEnabled: true,
      bevelThickness: TILE_BEVEL_THICKNESS,
      bevelSize: TILE_BEVEL,
      bevelSegments: 4,
      steps: 1,
      curveSegments: 14,
    });
    // Extruded along +Z; lay it flat so thickness runs up (+Y) and depth into
    // the screen. Keep the extrude's own normals (no recompute) so the bevel
    // facets stay crisp rather than smoothing into a dome.
    geometry.rotateX(-Math.PI / 2);
    geometry.computeBoundingBox();
    // Seat the base on the track: shift so the lowest point sits at y = 0.
    geometry.translate(0, -(geometry.boundingBox?.min.y ?? 0), 0);
    return geometry;
  }


  private buildNoteGlow(): THREE.InstancedMesh {
    // A flat quad lying on the highway, so the glow reads as light spilling
    // onto the lane rather than as a sprite floating in front of it. In stage
    // style it is a rounded-rect glow shaped to the bar (a round dot under a
    // rectangle read as a weird blob); classic keeps the soft dot.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
      // The aspect is folded into the key. `makeFrameTexture`/`makeGlowTexture`
      // both take one and both used a fixed key, which is correct only while the
      // argument is a constant expression — the moment tile size or lane count
      // varies per Highway the cache silently hands back the wrong art.
      map: this.stage
        ? Highway.cachedTexture(`glow:${(TILE_DEPTH / TILE_WIDTH).toFixed(3)}`, () =>
            Highway.makeGlowTexture(TILE_DEPTH / TILE_WIDTH),
          )
        : Highway.cachedTexture('dot', () => Highway.makeDotTexture()),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_NOTE_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = LAYER.noteGlow;
    return mesh;
  }

  /**
   * The contact shadows — one soft dark quad on the track under each tile.
   *
   * Black diffuse over an alpha ramp under NORMAL blending, which is a multiply
   * by `1 - a`: it darkens whatever it lands on (track, socket well, hit band)
   * without needing a second pass or a light. Per-instance strength rides an
   * injected attribute for the same reason `instanceReveal` exists — an
   * `InstancedMesh` has no per-instance opacity otherwise, and `instanceColor`
   * cannot express it because the colour is already pinned to black.
   */
  private buildNoteShadows(): THREE.InstancedMesh {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    const aspect = TILE_OUTER_DEPTH / TILE_OUTER_WIDTH;
    const material = new THREE.MeshBasicMaterial({
      map: Highway.cachedTexture(`shadow:${aspect.toFixed(3)}`, () =>
        Highway.makeShadowTexture(aspect),
      ),
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float instanceShade;\nvarying float vShade;\n' +
        shader.vertexShader.replace('void main() {', 'void main() {\n\tvShade = instanceShade;');
      shader.fragmentShader =
        'varying float vShade;\n' +
        shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n\tgl_FragColor.a *= vShade;',
        );
    };

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_NOTE_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = LAYER.noteShadow;

    const shade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NOTE_INSTANCES), 1);
    shade.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('instanceShade', shade);
    return mesh;
  }

  /**
   * A soft occlusion pool: dense under the slab's own footprint, feathering to
   * nothing well inside the quad so the shadow has no edge of its own.
   */
  private static makeShadowTexture(aspect: number): THREE.CanvasTexture {
    const w = 128;
    const h = Math.round(w * aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      const pad = Math.round(w * 0.2);
      ctx.filter = `blur(${Math.round(w * 0.09)}px)`;
      // Two stacked passes: a broad soft pool plus a tighter, denser core right
      // under the slab. A single blur gives a uniform smudge; the second pass is
      // what reads as the object touching the surface.
      Highway.roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, Math.round(w * 0.16));
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();
      const tight = Math.round(w * 0.28);
      ctx.filter = `blur(${Math.round(w * 0.05)}px)`;
      Highway.roundRectPath(ctx, tight, tight, w - tight * 2, h - tight * 2, Math.round(w * 0.14));
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fill();
    }

    return new THREE.CanvasTexture(canvas);
  }

  /** A vertical light streak that trails a gem up the track as it falls. */
  private buildNoteTrails(): THREE.InstancedMesh {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      map: Highway.cachedTexture('trail', () => Highway.makeTrailTexture()),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    /*
     * Spend the texture's two masks: accent in the flanks, white in the core.
     *
     * **Both includes are replaced, and the split between them is not optional.**
     * In a basic material the chunk order is map_fragment THEN color_fragment, so
     * the instance colour is NOT yet on diffuseColor where the texture is sampled
     * — composing there reads a white diffuse, gets an energy of 1, and then hands
     * the result to color_fragment, which tints the white core with the lane hue.
     * That is precisely the all-accent beam this is meant to replace, and it looks
     * like the shader did nothing. So the sample happens at map_fragment and the
     * composition at color_fragment, where vColor is live.
     *
     * The core is added as neutral WHITE, so its strength cannot come from the
     * instance colour the way the accent's does. It is scaled by that colour's
     * peak channel instead, which makes the beam's core fade with distance
     * alongside its glow using the value already on the instance — no second
     * attribute, no second uniform.
     *
     * **7.0, not 1.15, and the number is set by the tone curve.** Under
     * NeutralToneMapping a linear peak of 1.2 arrives at val 246 and 1.0 at 242, so
     * the old gain could not reach white however it was tuned — measured, the core
     * peaked at 236 carrying chroma 51, a warm cream, while the reference's holds
     * val 250-255 at chroma 16-22 over its entire run. The gain has to carry the
     * WEAKEST channel to white, not the peak, and on a gold accent the weakest is
     * a seventh of it: at 3.0 the core measured (253,247,232) — clipped in red,
     * still 232 in blue, so not one pixel in the frame was white in all three
     * channels. 7.0 lands it at (255,254,252). It is also what earns the beam its bloom (the pass
     * thresholds at 1.05), which is the halo the note's own border used to spend.
     * (No backticks in here: this is a JS template literal and one closes the
     * string mid-shader.)
     */
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
	vec4 beam = texture2D( map, vMapUv );
	diffuseColor.a = 1.0;`,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
	float energy = max( vColor.r, max( vColor.g, vColor.b ) );
	/*
	 * The envelope is driven 1.8x, because the beam's job is CHROMA and ours had
	 * none: measured across the beam, our halo topped out at chroma 53 where the
	 * reference's reaches 98-125 within 24px of the core, and a beam that reads
	 * grey is fog rather than light. The core keeps a little of the accent in it
	 * for the same reason — the reference's is 231,250,254, unmistakably cyan
	 * even where it clips.
	 */
	vec3 hue = vColor / max( energy, 0.04 );
	diffuseColor.rgb = vColor * beam.r * 1.8
	                 + mix( vec3( 1.0 ), hue, 0.22 ) * beam.g * energy * 7.0;`,
        );
    };
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_NOTE_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    // Under the gems and glow, over the floor.
    mesh.renderOrder = LAYER.noteTrail;

    // Allocated up front, not left to the first `setColorAt` — the same trap
    // `buildNotes` records, and it bites here for exactly the same reason now that
    // the injection above READS `vColor`. That varying only exists when
    // `USE_INSTANCING_COLOR` is defined, which three derives from this attribute
    // being present at compile time; left lazy, the first program links with
    // "'vColor': undeclared identifier" and every trail vanishes.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_NOTE_INSTANCES * 3).fill(1),
      3,
    );
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  /**
   * The beam behind a gem — **two profiles in two channels, not one streak.**
   *
   * The reference's trails are the single most energetic thing in its frames, and
   * profiling one settles how they are built. Sampled across the beam 200px above
   * its note: a 20px core at val 251 carrying chroma 18 — i.e. near-WHITE — inside
   * a ~76px flank at chroma 98-128, i.e. pure accent. Sampled 150px higher again,
   * the white core is gone entirely and only a thin accent line is left. So it is
   * a white-hot centre in an accent glow, tapering to accent alone. An all-accent
   * beam is the cheap-looking version of this, and it is what we had: ours
   * measured a peak of val 108 at chroma 32, with no core at any height.
   *
   * One tint cannot produce both, because `map` RGB and `instanceColor` multiply —
   * every pixel would land on the same hue. So the channels carry MASKS instead of
   * colour and the material's shader spends them (see `buildNoteTrails`):
   *
   *   R = the accent envelope   G = the white-hot core
   *
   * Written as raw `ImageData` rather than with gradients and composite ops
   * because the two profiles differ in width AND in how fast they die up-track,
   * and expressing that as canvas fills is more code that says less. Built once
   * and cached.
   */
  private static makeTrailTexture(): THREE.CanvasTexture {
    const w = 64;
    const h = 256;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        /*
         * 1 at the GEM end, 0 at the far end — and the direction is the one thing
         * here that cannot be reasoned about from the canvas alone.
         *
         * A CanvasTexture flips Y, so canvas row 0 is texture v=1; the quad is a
         * PlaneGeometry turned by rotateX(-PI/2), which sends local +Y (v=1) to
         * world -Z, i.e. AWAY up the track. So canvas BOTTOM is the gem end and
         * nearness is y/h, not 1 - y/h. Written the intuitive way round first, and
         * it measured: the beam's brightest, widest section sat at its far cap and
         * it faded as it reached the note it belongs to — backwards, and it reads
         * as a comet flying the wrong way.
         */
        const v = (y + 0.5) / h;
        /*
         * A ROD, not a comet. Both profiles hold flat down the length and the far
         * end is a rounded cap, which is what the reference measures and what the
         * previous tapering version got wrong.
         *
         * Profiled across its beam at four heights, the reference's width is
         * constant (59/63/63/63 device px) with a clipped-255 core that holds
         * 250-255 from the gem to about 85% of the way up and only then hands over
         * to accent alone. Ours ramped 34 -> 47px wide while its peak ramped
         * 185 -> 236: a tapering scratch, brightest exactly where it is least
         * visible. `capW` below is a semicircular end (sqrt of a linear ramp), so
         * the cap is a shape rather than a fade.
         */
        /*
         * **The taper has to be spent in SCREEN space, and 5% of v is not.**
         * `sqrt(min(1, v/0.055))` is a cap, but the far end of a beam laid on a
         * receding plane is where the perspective compression is worst: 5.5% of
         * the length projected to about five pixels, so the whole ramp collapsed
         * into a hard horizontal cut. Measured on the shipped frame the peak
         * luminance went 91 -> 131 -> 212 -> 252 across four rows — a clipped
         * quad, and it reads as exactly that. The reference's beam ramps 54 ->
         * 217 over 50 rows and tapers to a point with nothing above it.
         *
         * Over the far 30% of v instead, which is roughly the top quarter of the
         * beam on screen. Both profiles reach zero, so the geometry ends in a fade
         * rather than an edge and there is no low-alpha extension left over it.
         */
        /*
         * **A ROUNDED CAP AT FULL BRIGHTNESS, not a taper to a point.**
         *
         * The three terms above between them faded the beam out over its far
         * THIRD: measured on the shipped capture the hold's luminance fell to 148
         * at the far end and narrowed to a point, where the reference holds ~248
         * right up to a rounded cap and then stops. Two of the three go flat and
         * only the WIDTH rounds off, over the far 15% — a semicircular end is a
         * shape, and a shape does not need a brightness ramp to stop reading as an
         * edge. (The earlier 5.5% cap collapsed into a hard cut because the far end
         * of a 7.8-unit quad projected to five pixels; the short lens spends far
         * less of the frame out there, and 0.15 of the length is ~30px of it.)
         */
        // 0.09 of the length, not 0.15. The cap is a fraction of the BODY, and a
        // long hold's body is long: on a long hold the 0.15 version spent ~150
        // device px tapering, which reads as a beam fading to a point rather than
        // as a rounded end. (It cannot go much below this — at 0.055 a short
        // hold's cap projected to ~5px and read as a hard cut.)
        /*
         * **0.035, and this is the first version measured on a frame that
         * actually contains a hold.**
         *
         * Every number above was reasoned about without a capture — four fixed-
         * wait shots in a row landed on plain taps, so the beam had never been
         * seen. Photographed (`--progress`, see scripts/shoot.mjs) the 0.09 cap
         * renders as a SPEARHEAD: the taper runs ~30 device px on a beam whose far
         * end is only ~15 device px wide, i.e. the "rounded cap" is twice as long
         * as it is wide and reads as a point.
         *
         * The cause is that a fraction of the body's LENGTH is not a fraction of
         * its screen length — the far end of a beam on a receding plane is exactly
         * where the compression is worst, so 9% of v buys far more pixels up there
         * than it does anywhere else. A semicircular cap should be about half the
         * beam's own width tall; at this depth that is ~7px, which is what 0.035
         * lands. The old warning about 0.055 collapsing into a hard cut was
         * written against a longer lens and a much narrower beam; the far end is
         * now widened in world units (see `layoutHoldBody`) so there is a cap
         * shape left to see.
         */
        const capW = Math.pow(Math.min(1, Math.max(0, v / 0.02)), 0.5);
        // FLAT. The reference holds ~248 luminance from the gem right up to its
        // rounded cap; a length ramp, however slight, compounds with the far end's
        // own minification and is what left ours reading 148 up there.
        const glowLen = 1;
        const coreLen = 1;
        for (let x = 0; x < w; x++) {
          const u = ((x + 0.5) / w) * 2 - 1;
          /*
           * **Compact support, not a Gaussian, and that is the fix for the deck's
           * glare.** A Gaussian's tail never reaches zero, and this material is
           * ADDITIVE and driven past 1 — so the last few percent of the profile
           * lifted a 40px band of deck either side of every beam. Measured across
           * one constant-depth row, the lanes carrying a beam read L27-32 against
           * L19.4-19.8 for the lanes that did not: the "broad grey glare bands"
           * were the trails, not the deck's own lighting.
           *
           * (1 - r^2)^p is bell-shaped, has an analytic FWHM, and is exactly zero
           * outside its support, so the beam terminates instead of fading forever.
           */
          const bell = (r: number, p: number): number =>
            Math.pow(Math.max(0, 1 - r * r), p);
          // p = 2.0, not 2.5. The exponent is what decides how much of the
          // envelope the beam actually occupies: at 2.5 the half-max radius is
          // 0.49 of the support, so a 0.41-of-a-note envelope rendered as a
          // 0.16-of-a-note rod. At 2.0 it is 0.54, which is a fuller cylinder
          // rather than a thread — and the support is still COMPACT (it reaches
          // exactly zero at the envelope), which is the property that stopped the
          // beam lifting a band of deck either side of itself.
          /*
           * TWO BELLS, because one cannot be both narrow and long-skirted.
           *
           * A single compact bell at any exponent trades bright width against
           * skirt width one-for-one: at p=1.55 the beam profiled a 45px shoulder
           * sitting at 213 luma with the envelope dying 10px later, which is a
           * bright rod with no halo — the reference is the opposite, a ~30px core
           * inside a soft halo running out to ~120px. So the flank is a strong
           * narrow term plus a weak wide one. Both still reach EXACTLY zero at
           * their support, which is the property that stopped the beam lifting a
           * band of deck either side of itself.
           */
          const glow =
            0.72 * bell(u / Math.max(0.42 * capW, 1e-3), 1.6) +
            0.28 * bell(u / Math.max(1.0 * capW, 1e-3), 1.3);
          /*
           * **0.17, half what it was, and this is the difference between a laser
           * and a plank.**
           *
           * Photographed at last (mat-hold2.png) the solid core measured 66 device
           * px on a 209px note — 0.32 — against a reference whose core is 27-31px
           * on a 187px note (0.14-0.17) carried by a wide soft halo out to ~120px.
           * The 0.25-0.34 target band was written about the ENVELOPE and hitting
           * it with the core is what produced a butter-yellow plank with a tight
           * edge. The core is the white-hot filament; the accent lives in the
           * glow around it, and the reference is explicit that an all-accent (or
           * all-anything) slab reads markedly cheaper.
           */
          const core = bell(u / Math.max(0.10 * capW, 1e-3), 1.4);
          const i = (y * w + x) * 4;
          img.data[i] = Math.round(255 * glow * glowLen);
          img.data[i + 1] = Math.round(255 * core * coreLen);
          img.data[i + 2] = 0;
          // Additive blending multiplies by src alpha; the profiles live in the
          // channels, so alpha stays flat and does not dim them a second time.
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    const texture = new THREE.CanvasTexture(canvas);
    /*
     * **No mipmaps — this is why the far end of a beam went grey.**
     *
     * Profiled up a hold on the capture, peak luminance ran 250 at the gem, 203,
     * 162 and 121 at the cap, while the beam's WIDTH held 52-54px the whole way.
     * A brightness ramp with no width ramp is not a taper in the geometry; it is
     * the mip chain. The quad is 7.5 world units long on a receding plane, so the
     * length axis is minified hard, and three picks the mip from the LARGER
     * derivative — which then averages the 22-texel white core across its
     * neighbours in *both* axes. The profile was authored flat (see `glowLen` and
     * `coreLen`) and thrown away by the sampler.
     *
     * `LinearFilter` costs nothing here: the cross-section is magnified at every
     * distance (a 22-texel core over ~18 device px), so there is no aliasing for a
     * mip chain to solve, and the texture is 64x256 — one small upload, shared by
     * the head streak and every hold body.
     */
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return texture;
  }

  private buildParticles(): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3));
    // Per-point size. `PointsMaterial` has one size for the whole cloud, and a
    // burst of identically-sized dots reads as a texture rather than as debris —
    // the rubric asks for individually resolvable elements *with size falloff*,
    // which needs both a spread at emission and a shrink over life.
    geometry.setAttribute('pSize', new THREE.BufferAttribute(this.particleSizes, 1));
    // Draw only the active budget; the cursor never wraps beyond it, so higher
    // indices are always dead. On the low tier this cuts additive overdraw too.
    geometry.setDrawRange(0, this.particleBudget);

    const material = new THREE.PointsMaterial({
      size: 1,
      map: Highway.cachedTexture('dot', () => Highway.makeDotTexture()),
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    // `size` above is the unit; `pSize` carries the world size of each spark.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float pSize;\n' +
        shader.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = size * pSize;');
    };

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = LAYER.impact;
    return points;
  }

  // --- public API ----------------------------------------------------------

  /**
   * Which lane a tap at this canvas position belongs to.
   *
   * Lives here because the renderer is the only thing that knows where a lane
   * actually ends up on screen. The play screen used to split the canvas into
   * equal columns, which is wrong: perspective converges the lanes, so they are
   * not evenly spaced and the outer ones land a whole lane out.
   *
   * Projecting the receptors and taking the nearest in x covers perspective,
   * the width taper and the lane count for free, rather than assuming any
   * particular spacing.
   *
   * @param xRatio 0..1 across the canvas, 0..1 down it.
   */
  laneAtScreenPoint(xRatio: number, _yRatio: number): number {
    const tapUvX = xRatio;

    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let lane = 0; lane < this.laneCount; lane++) {
      // Receptors sit at z = 0, where the curve and the taper are both identity.
      this.probe.set(this.laneX(lane), 0, 0);
      this.probe.project(this.camera);
      // NDC (-1..1) to uv (0..1).
      const laneUvX = this.probe.x * 0.5 + 0.5;

      const distance = Math.abs(laneUvX - tapUvX);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = lane;
      }
    }

    return best;
  }

  resize(width: number, height: number): void {
    // Remembered so a live downgrade can re-apply the size after re-capping the
    // pixel ratio.
    this.viewWidth = width;
    this.viewHeight = height;

    this.renderer.setSize(width, height, false);
    /*
     * The composer's pixel ratio has to be re-asserted, not assumed.
     *
     * `EffectComposer` reads `renderer.getPixelRatio()` **once, in its
     * constructor**, and every later `setSize` multiplies by that captured value.
     * `downgradeTo` lowers the renderer's ratio and then calls this — so without
     * this line the composer keeps allocating targets at the OLD ratio. Two
     * consequences, both measured: the scene renders at a resolution the
     * downgrade was supposed to stop paying for (the opposite of the point), and
     * anything composed in screen space is offset, because the render target and
     * the drawing buffer no longer share a coordinate system. That is where the
     * one-sided warm smudge outside the left rail came from.
     */
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(width, height);
    // Must come *after* `composer.setSize`, which resizes every pass back to the
    // full canvas. `bloom.setSize` is what actually reallocates the mip chain's
    // render targets — writing `bloom.resolution` alone (as this did) only set a
    // number the targets were never rebuilt from, so it did nothing at all.
    if (this.bloom) {
      const s = this.quality.bloomScale;
      this.bloom.setSize(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)));
    }

    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.fov = this.fovFor(aspect);
    this.camera.updateProjectionMatrix();

    // Raise the hit line on portrait phones, where it otherwise sits right
    // against the bottom edge — awkward for a thumb and cramped against the
    // phone's gesture bar. `setViewOffset` pans the projection up without
    // touching the 3D framing or the perspective; a positive y-offset shows a
    // window lower in the virtual frame, which slides the whole scene (and the
    // receptors with it) upward. Cleared on landscape so desktop is untouched.
    // Must come *after* updateProjectionMatrix, which resets the offset.
    if (aspect < PORTRAIT_ASPECT) {
      this.camera.setViewOffset(width, height, 0, height * HIT_RAISE_FRACTION, width, height);
    } else {
      this.camera.clearViewOffset();
    }
  }

  /**
   * The narrowest vertical FOV that still contains the board **and** the track.
   *
   * A PerspectiveCamera's `fov` is vertical, so horizontal coverage shrinks
   * with the aspect ratio: on a portrait phone a five-lane board runs off both
   * sides at the desktop FOV. Widen only as much as the viewport requires.
   *
   * The vertical half is new, and it is what a `BASE_FOV = 60` floor used to
   * stand in for. That constant was "don't crop the track" written as a number
   * true of exactly one aspect ratio; on the long lens it is the *binding*
   * requirement at every wide aspect, where the horizontal half asks for 5
   * degrees and the receptors would end up 22% below the bottom of the frame.
   * Taking the max of the two makes both fit at any aspect, and the trade a wide
   * frame cannot avoid — a short frame holding a 68%-tall track cannot also hold
   * a wide one — falls out as a narrower board rather than as a lost row.
   */
  private fovFor(aspect: number): number {
    const distanceToHitLine = Math.hypot(this.camHeight, this.camDistance);
    /*
     * What has to fit is the **receptor row**, not `halfWidth`.
     *
     * `halfWidth` is half the lane *pitch* times the lane count — it runs to the
     * rails, a third of a lane outside the outermost receptor's edge. Padding
     * that by another 18% asked for 15% more frame than the board needs, and a
     * vertical FOV is the only way a perspective camera can buy horizontal
     * coverage: the surplus was spent making everything smaller, which is what
     * squeezed the playable highway into 51% of a portrait frame (the runway is
     * measured against 55%) and left a black margin either side of the track.
     *
     * Sized to the outer receptor's outer edge plus a third of a lane, this
     * leaves the 5-lane and desktop cases to the same formula rather than to a
     * second constant.
     */
    const outerReceptorEdge = this.halfWidth - LANE_WIDTH / 2 + HIT_ZONE_WIDTH / 2;
    /*
     * A sixteenth of a lane of margin, not a third.
     *
     * This is the term that decides how much of the frame the board may fill, and
     * the surplus is spent making everything smaller. At 0.36 the receptor row
     * measured 84% of the frame's width against the reference's 95%, and the
     * board could not be widened to close the gap: widening it raised
     * `requiredHalfWidth` in step, `fromWidth` crossed `fromHeight`, and the FOV
     * opened by exactly enough to cancel the change. Cutting the margin is what
     * puts the width requirement (18.6 deg at 390x844, 4 lanes) safely under the
     * height one (19.3), so the lane pitch is free to carry the composition.
     *
     * It cannot go to zero: the outer pads would touch the frame edge at the row,
     * and a pad clipped by the viewport is a target the player cannot see land.
     */
    const requiredHalfWidth = outerReceptorEdge + LANE_WIDTH * 0.06;
    const horizontalHalf = Math.atan(requiredHalfWidth / distanceToHitLine);
    const fromWidth =
      THREE.MathUtils.radToDeg(Math.atan(Math.tan(horizontalHalf) / Math.max(0.1, aspect))) * 2;

    /*
     * The track's own angular height, from the receptor row to the far end,
     * divided by the share of the frame it may occupy.
     *
     * Measured off the rig rather than assumed: the far end is lifted
     * (`CURVE_HEIGHT`) as well as pushed back, so its direction is not simply
     * "the hit line, further away". Both angles are taken below the horizontal
     * from the camera's eye, which is the same plane `HIT_RAISE_FRACTION` pans
     * in — the raise is a translation and cancels out of the difference.
     */
    const toHitLine = Math.atan2(this.camHeight, this.camDistance);
    const toFarEnd = Math.atan2(
      this.camHeight - CURVE_HEIGHT,
      this.camDistance + HIGHWAY_LENGTH,
    );
    const fromHeight = THREE.MathUtils.radToDeg(toHitLine - toFarEnd) / TRACK_FRAME_SHARE;

    return Math.min(MAX_FOV, Math.max(MIN_FOV, fromWidth, fromHeight));
  }

  /** Flash a lane, e.g. when its key goes down. */
  flashLane(lane: number, intensity = 1): void {
    if (lane < 0 || lane >= this.laneCount) return;
    this.laneFlash[lane] = Math.min(1.6, (this.laneFlash[lane] ?? 0) + intensity);
  }

  /**
   * Big hit impact at a lane's receptor: particle burst, an expanding
   * shockwave ring, a camera punch, and a screen shake that grows with the
   * combo. `combo` is the streak *after* this hit — higher combo, harder hit.
   */
  burst(lane: number, tier: Tier, combo = 0): void {
    if (lane < 0 || lane >= this.laneCount) return;

    const missed = tier === 'miss';
    const count = tier === 'perfect' ? 56 : tier === 'great' ? 40 : tier === 'good' ? 24 : 16;
    const speed = tier === 'perfect' ? 5.0 : missed ? 2.0 : 3.4;
    /*
     * A hit sprays the LANE's hue, over-driven so the sparks bloom; a miss sprays
     * the same hue pulled halfway to grey and at a third the brightness.
     *
     * `0x662233` — one fixed dark rose for every lane — was what made a miss read
     * as "dust or dead pixels": no lane information, and too dim to resolve as
     * anything at all. A miss still must not borrow a hit's language, so what it
     * loses is chroma and brightness, not identity.
     */
    this.color.setHex(laneColor(this.theme, lane));
    if (missed) {
      const grey = (this.color.r + this.color.g + this.color.b) / 3;
      this.color.lerp(new THREE.Color(grey, grey, grey), 0.5).multiplyScalar(0.42);
    } else {
      this.color.multiplyScalar(1.5);
    }
    const x = this.laneX(lane);

    if (missed) {
      // The receptor's own "denied" state — see `laneMiss`.
      this.laneMiss[lane] = 1;
    }

    if (tier !== 'miss') {
      this.punch = Math.min(1, this.punch + (tier === 'perfect' ? 0.6 : 0.36));
      this.triggerShockwave(lane, this.color);

      // Shake grows with the streak and caps, so a long combo *feels* heavier
      // without ever getting so violent the lanes become unreadable. A perfect
      // hits harder than a good.
      const comboFactor = Math.min(1, combo / 40);
      const base = tier === 'perfect' ? 0.16 : tier === 'great' ? 0.11 : 0.07;
      // Only a burst starting from rest re-rolls the rattle's phase; mid-decay
      // it would be a position jump. See `shakePhase`.
      if (this.shake < 0.02) this.shakePhase = Math.random() * Math.PI * 2;
      this.shake = Math.min(0.42, this.shake + base * (0.6 + comboFactor));
    }

    for (let i = 0; i < count; i++) {
      const p = this.particleCursor;
      this.particleCursor = (this.particleCursor + 1) % this.particleBudget;

      const angle = Math.random() * Math.PI * 2;
      const lift = missed ? 0.15 + Math.random() * 0.4 : 0.4 + Math.random() * 1.3;
      // Some fly out fast, some drift — a mix of radii reads as a spray "all
      // around" rather than a tidy uniform fan.
      const spread = 0.5 + Math.random() * 0.9;

      this.particlePositions[p * 3] = x + (Math.random() - 0.5) * 0.7;
      this.particlePositions[p * 3 + 1] = 0.12;
      this.particlePositions[p * 3 + 2] = 0.2 + (Math.random() - 0.5) * 0.6;
      // A real size spread, in world units at the receptor. The falloff over life
      // is applied in `updateParticles`.
      this.particleSizes[p] = missed ? 0.07 + Math.random() * 0.06 : 0.1 + Math.random() * 0.16;

      // A wide lateral fan, but only a small forward bias (was +1.2, i.e. up to
      // 2.6 units of travel toward the camera over a particle's life). Impact has
      // to stay anchored *at* the receptor: a spray that drifts a whole tile-depth
      // into the apron scatters high-frequency dots across the one region that is
      // supposed to be a smooth gradient, and detaches the effect from its source.
      this.particleVelocities[p * 3] = Math.cos(angle) * speed * 0.6 * spread;
      this.particleVelocities[p * 3 + 1] = lift * speed * 0.55;
      this.particleVelocities[p * 3 + 2] = Math.sin(angle) * speed * 0.42 * spread + 0.45;

      this.particleBase[p * 3] = this.color.r;
      this.particleBase[p * 3 + 1] = this.color.g;
      this.particleBase[p * 3 + 2] = this.color.b;

      // Shorter on a miss: debris, not a plume.
      this.particleLife[p] = missed ? 0.55 : 1;
    }
  }

  /**
   * A gentle upward spray at the receptor while a hold is held — the reward for
   * keeping it down. No shockwave or shake (that is for a hit); just a few
   * short-lived embers in the lane colour, emitted intermittently by
   * `updateHoldBodies` so a held note visibly fizzes.
   */
  private emitHoldSparkle(lane: number): void {
    if (lane < 0 || lane >= this.laneCount) return;
    this.color.setHex(laneColor(this.theme, lane));
    const x = this.laneX(lane);

    for (let i = 0; i < 2; i++) {
      const p = this.particleCursor;
      this.particleCursor = (this.particleCursor + 1) % this.particleBudget;

      this.particlePositions[p * 3] = x + (Math.random() - 0.5) * 0.35;
      this.particlePositions[p * 3 + 1] = 0.1;
      this.particlePositions[p * 3 + 2] = 0.1 + (Math.random() - 0.5) * 0.4;

      // Mostly up, a little toward the camera, far slower than a hit burst.
      this.particleVelocities[p * 3] = (Math.random() - 0.5) * 1.2;
      this.particleVelocities[p * 3 + 1] = 1.6 + Math.random() * 1.3;
      this.particleVelocities[p * 3 + 2] = 0.7 + Math.random() * 0.8;

      this.particleSizes[p] = 0.08 + Math.random() * 0.07;
      this.particleBase[p * 3] = this.color.r;
      this.particleBase[p * 3 + 1] = this.color.g;
      this.particleBase[p * 3 + 2] = this.color.b;

      // Shorter-lived than a burst ember, so it reads as a fizz, not a plume.
      this.particleLife[p] = 0.6;
    }
  }

  private buildShockwaves(): void {
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      // A thin flat annulus that starts small at the receptor and expands. Lies
      // on the track (rotateX) so it reads as a ring rushing outward across the
      // lane, not a disc facing the camera.
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.34, 0.46, 40),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          fog: false,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(0, 0.02, 0);
      mesh.visible = false;
      mesh.renderOrder = LAYER.impact;
      this.shockwaves.push(mesh);
      this.scene.add(mesh);
    }
  }

  /** Fire a shockwave from a lane's receptor, reusing the oldest pool slot. */
  private triggerShockwave(lane: number, color: THREE.Color): void {
    const slot = this.shockwaveCursor;
    this.shockwaveCursor = (this.shockwaveCursor + 1) % MAX_SHOCKWAVES;

    const mesh = this.shockwaves[slot]!;
    mesh.position.x = this.laneX(lane);
    mesh.material.color.copy(color);
    mesh.visible = true;
    this.shockwaveLife[slot] = 1;
  }

  private updateShockwaves(dt: number): void {
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const life = this.shockwaveLife[i]!;
      if (life <= 0) continue;

      const next = life - dt * 3.4; // ~0.3s
      this.shockwaveLife[i] = next;

      const mesh = this.shockwaves[i]!;
      if (next <= 0) {
        mesh.visible = false;
        continue;
      }

      // Grow outward as it fades. `1 - next` runs 0 → 1 over the life.
      const t = 1 - next;
      const scale = 1 + t * 6;
      mesh.scale.set(scale, scale, 1);
      mesh.material.opacity = next * 0.7;
    }
  }

  /**
   * Draw one frame.
   *
   * @param audioTime seconds into the song, from the audio clock (may be negative during lead-in)
   * @param visible   notes currently within the approach window
   * @param dt        seconds since the previous frame, for particle motion only
   */
  render(
    audioTime: number,
    visible: readonly NoteState[],
    dt: number,
    bass: number,
    treble: number,
    spectrum?: Uint8Array,
  ): void {
    if (this.disposed) return;

    /*
     * **Everything below draws against the SMOOTHED time, not the raw one, and
     * that is the fix for "note bars movement feels kinda sluggy. not smooth".**
     *
     * `AudioContext.currentTime` is republished once per audio render quantum —
     * measured here at 10.667ms steps and nothing finer — so sampling it once
     * per frame hands the renderer a staircase. At 120Hz a note's per-frame
     * advance alternates 10.67 / 21.33ms and at 149Hz it alternates 0 / 10.67,
     * i.e. the note freezes for a frame and then jumps double, while the frames
     * themselves are perfectly even (149fps, zero frames over 33ms on the real
     * GPU). `RenderClock` interpolates between the audio clock's updates and
     * feeds the phase error back every frame, so the audio clock is still what
     * is being followed — it is the anchor, not the source of per-frame motion.
     *
     * Judgement never sees this. The engine reads `AudioClock.currentTime`
     * directly and `hitLane` is untouched; the bound here is one quantum, an
     * order of magnitude inside the tightest hit window.
     */
    this.renderWallSec += Math.min(0.25, Math.max(0, dt));
    const songTime = this.renderClock.update(audioTime, this.renderWallSec);

    const pulse = this.beatPulse(songTime);

    this.updateHoldBodies(songTime, visible);
    this.updateNotes(songTime, visible);
    this.updateLanes(dt, pulse);
    this.updateStars(dt, bass);
    this.updateParticles(dt);
    this.updateShockwaves(dt);
    this.updateCamera(dt, songTime, pulse);
    const floorUniforms = this.floor.material.uniforms;
    floorUniforms['uTime']!.value = songTime;
    // Locked to the notes' own speed and direction — see `deckScrollPhase`. The
    // hardcoded `-songTime * 1.6` this replaces ran the deck backwards at a
    // fifth of the notes' velocity, which is why the board read as static.
    floorUniforms['uScroll']!.value = deckScrollPhase(songTime, this.approachSec);
    floorUniforms['uBass']!.value = bass;
    floorUniforms['uPulse']!.value = pulse;
    (floorUniforms['uLaneFlash']!.value as Float32Array).set(this.laneFlash);

    const groundUniforms = this.ground.material.uniforms;
    // Half the floor's scroll rate, which is what the comment here always
    // claimed and what the constant never delivered: the floor's own rate was
    // 3.6 world units/sec *away* from the player against this 3.2 *toward*, so
    // "half" was really "the other way, and slightly slower". Both now derive
    // from the notes' speed, so the two are one sliding sheet at every
    // difficulty and every scroll-speed setting.
    groundUniforms['uScroll']!.value = groundScrollWorld(songTime, this.approachSec);
    groundUniforms['uBass']!.value = bass;
    groundUniforms['uPulse']!.value = pulse;

    const backdropUniforms = this.backdrop.material.uniforms;
    backdropUniforms['uTime']!.value = songTime;
    backdropUniforms['uBass']!.value = bass;
    backdropUniforms['uTreble']!.value = treble;
    backdropUniforms['uPulse']!.value = pulse;

    // Push the live spectrum into the rails' waveform texture (low 256 bins are
    // the real ones; the rest of the analyser buffer is padding).
    if (this.spectrumTex && this.spectrumData && spectrum) {
      this.spectrumData.set(spectrum.subarray(0, 256));
      this.spectrumTex.needsUpdate = true;
    }
    for (const rail of this.rails) {
      rail.material.uniforms['uBass']!.value = bass;
      rail.material.uniforms['uPulse']!.value = pulse;
      rail.material.uniforms['uTime']!.value = songTime;
    }

    if (this.hitBarMaterial) {
      const u = this.hitBarMaterial.uniforms;
      u['uTime']!.value = songTime;
      u['uBass']!.value = bass;
      u['uPulse']!.value = pulse;
    }

    // Dim, sparse motes on the dark stage; the classic look keeps its brighter
    // synthwave starfield.
    (this.stars.material as THREE.PointsMaterial).opacity = this.stage
      ? 0.18 + treble * 0.18
      : 0.55 + treble * 0.45;

    if (this.composer && this.bloom) {
      // Base and swing both scaled to match the constructor's 0.07 — the reactive
      // half was the larger contributor to the deck bleed, since it triples the
      // strength on a downbeat and the skirt is where that lands.
      this.bloom.strength = 0.07 + bass * 0.05 + this.punch * 0.09;
      this.composer.render();
    } else {
      // Low tier (or after a live downgrade): no post-processing chain, so draw
      // the scene straight to the canvas. three.js still applies the renderer's
      // tone mapping and sRGB output, which is exactly what OutputPass did.
      this.renderer.render(this.scene, this.camera);
    }

    this.maybeDowngrade(dt);
  }

  /**
   * Drop to the low tier if frames are consistently slow.
   *
   * The reliable way to catch a weak GPU — device specs lie (a budget phone
   * reports flagship CPU/RAM). Slow frames add to a score and fast ones subtract,
   * so a downgrade needs *sustained* slowness, not one hitch; the opening frames
   * are skipped because shader compilation and texture upload spike them. The
   * decision is remembered so the next song starts low instead of flickering
   * through this again.
   */
  private maybeDowngrade(dt: number): void {
    if (!this.adaptive || this.quality.tier === 'low') return;

    this.framesSeen++;
    if (this.framesSeen < ADAPT_WARMUP_FRAMES) return;

    // `dt` is already capped at 0.05 by the play loop, so a single stall (a GC
    // pause, a backgrounded tab) reads as one slow frame and cannot trip this.
    this.slowFrameScore += dt > SLOW_FRAME_SEC ? 1 : -1;
    if (this.slowFrameScore < 0) this.slowFrameScore = 0;
    if (this.slowFrameScore < ADAPT_SLOW_BUDGET) return;

    const next = nextTierDown(this.quality.tier);
    if (next) this.downgradeTo(next);
    // Reset the budget so the next rung has to be earned the same way. Without
    // this a single bad stretch would cascade straight to the bottom on
    // consecutive frames, which is the "lost the whole look at once" failure
    // the medium tier exists to avoid.
    this.slowFrameScore = 0;
    this.framesSeen = 0;
  }

  /** Apply a lower profile to a running Highway and remember the decision. */
  private downgradeTo(tier: QualityTier): void {
    const next = qualityProfile(tier);
    this.quality = next;
    markAutoTier(tier);

    if (next.bloom) {
      // Still bloomed, just cheaper — `resize` re-applies the new `bloomScale`.
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, next.pixelRatioCap));
      this.resize(this.viewWidth, this.viewHeight);
    } else {
      // Tear down the bloom chain: `render()` falls through to the direct path.
      this.composer?.dispose();
      this.composer = null;
      this.bloom = null;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, next.pixelRatioCap));
      this.resize(this.viewWidth, this.viewHeight);
    }

    // Thin the effects. Buffers stay at capacity; only the active counts shrink,
    // and the draw ranges follow so overdraw drops with them. `Math.min` so a
    // second downgrade never raises a count back up.
    this.starCount = Math.min(this.starCount, next.starCount);
    this.stars.geometry.setDrawRange(0, this.starCount);
    this.particleBudget = Math.min(this.particleBudget, next.particleBudget);
    this.particles.geometry.setDrawRange(0, this.particleBudget);
    // The cursor may sit past the new budget; wrap it so fresh bursts land in
    // the visible range (particles already beyond it just fade out unseen).
    if (this.particleCursor >= this.particleBudget) this.particleCursor = 0;
    if (this.noteTrails && !next.trails) this.noteTrails.visible = false;
  }

  /**
   * 1 on a flashing beat, decaying to 0 before the next one.
   *
   * Rate-limited and switchable — see `flash.ts`. A fast song flashes on every
   * `flashStride`-th beat rather than every beat, which keeps a 240 BPM track
   * from strobing the whole backdrop four times a second.
   */
  private beatPulse(songTime: number): number {
    const grid = this.beatGrid;
    if (grid.length === 0 || !flashEffectsEnabled()) return 0;

    // Reset on a seek or restart.
    if (this.beatCursor > 0 && (grid[this.beatCursor - 1] ?? 0) > songTime) this.beatCursor = 0;
    while (this.beatCursor < grid.length && (grid[this.beatCursor] ?? Infinity) <= songTime) {
      this.beatCursor++;
    }

    const index = this.beatCursor - 1;
    const last = grid[index];
    if (last === undefined) return 0;
    // Skipped beats hold at 0 rather than decaying from the previous flash, so
    // the gap reads as a rest instead of a slower fade.
    if (index % this.flashStride !== 0) return 0;
    return Math.max(0, 1 - (songTime - last) * 5);
  }

  /** Set the note-visibility modifier for this run. See the `visibility` field. */
  setVisibility(mode: Visibility): void {
    this.visibility = mode;
  }

  /**
   * How visible a note at this approach `progress` is, 0..1, under the current
   * visibility modifier. `progress` is 1 at spawn and 0 at the receptor.
   *  - normal:  always 1.
   *  - hidden:  1 far out, ramping to 0 as it nears the line — commit blind.
   *  - fadeout: 0 far out, ramping to 1 as it approaches — read it late.
   * The bands leave a readable sliver either side so a note never simply pops.
   */
  private revealFor(progress: number): number {
    if (this.visibility === 'normal') return 1;
    const p = Math.max(0, Math.min(1, progress));
    if (this.visibility === 'hidden') {
      // Fully lit until the note is well down the track, then fade over the last
      // stretch before the receptor. The band was too high before — notes
      // vanished with most of the highway still to travel.
      return Math.max(0, Math.min(1, (p - 0.06) / 0.22));
    }
    // fadeout: dark far out, revealing as it approaches — but a touch sooner
    // than before, so it is readable rather than a last-instant pop.
    return Math.max(0, Math.min(1, (0.7 - p) / 0.26));
  }

  /**
   * Draw the body of every visible hold.
   *
   * The near end is clamped at the hit line, so once the head arrives the body
   * *drains* into the receptor as the song advances rather than sliding past
   * it. That is what makes a hold read as being consumed while it is held.
   */
  private updateHoldBodies(songTime: number, visible: readonly NoteState[]): void {
    let used = 0;

    for (const state of visible) {
      if (used >= MAX_HOLD_BODIES) break;

      if (state.note.type !== 'hold') continue;
      const span = holdSpan(state.note.t, state.note.duration ?? 0, songTime, this.approachSec);
      if (!span) continue;

      const mesh = this.holdBodies[used]!;
      this.layoutHoldBody(mesh, state.note.lane, span.nearZ, span.farZ);
      mesh.visible = true;

      const held = state.hold === 'held';
      const broken = state.hold === 'broken';
      const missed = state.tier === 'miss';

      // Under a visibility modifier a body rides the same ramp its head does,
      // keyed on the head's approach progress — except while actually held, when
      // it stays lit so the player can see what they are holding.
      const headProgress = (state.note.t - songTime) / this.approachSec;
      const reveal = held ? 1 : this.revealFor(headProgress);

      // Brightest while actually held — the body is the main feedback that the
      // player is doing it right, since the note itself is long gone under
      // their finger. A broken or missed hold drops back to scenery.
      /*
       * Folded into the colour, not split between colour and opacity: the beam
       * shader forces `diffuseColor.a` to 1 (the profiles live in the texture's
       * channels and additive blending would dim them twice), so `opacity` no
       * longer reaches the pixel. One scalar also keeps the white core fading in
       * step with its accent glow, which is what the shader's `energy` term
       * reads.
       *
       * Capped below the head streak's own exposure so the gem stays the
       * brightest object in its lane — the same rule `updateNotes` records.
       */
      /*
       * 0.52 approaching, not 0.34.
       *
       * The beam is the frame's energy in every reference shot, and it is the
       * ONLY thing that carries it — tap notes get no trail at all (the owner
       * rejected that explicitly: "note bars shouldn't have this glowing line on
       * top, only when it's a hold note"). At 0.34 an approaching body read as a
       * faint smear rather than as the white-hot core the reference streams up
       * the lane, so the one element allowed to supply that energy was supplying
       * almost none of it. Still capped under the held value and under the head
       * streak's own exposure, so the gem stays the brightest object in its lane.
       */
      const brightness = held ? 0.72 : broken || missed ? 0.1 : 0.52;
      mesh.material.color.setHex(this.noteAuraHex(state.note.lane));
      mesh.material.color.multiplyScalar(brightness * reveal);

      // Sparkle while held. Emitted probabilistically per frame so the fizz is
      // irregular rather than a metronomic stream; cheap (2 short-lived points).
      if (held && Math.random() < 0.3) this.emitHoldSparkle(state.note.lane);

      used++;
    }

    for (let i = used; i < this.holdBodies.length; i++) this.holdBodies[i]!.visible = false;
  }

  private updateNotes(songTime: number, visible: readonly NoteState[]): void {
    let count = 0;
    // Trails are HOLD-ONLY, so they are not one-per-note and need their own
    // cursor. See the `noteTrails.count` write at the end of this method.
    let trailCount = 0;
    const revealAttr = this.notes.geometry.getAttribute(
      'instanceReveal',
    ) as THREE.InstancedBufferAttribute;
    const nearAttr = this.notes.geometry.getAttribute(
      'instanceNear',
    ) as THREE.InstancedBufferAttribute;
    const shadeAttr = this.noteShadows?.geometry.getAttribute(
      'instanceShade',
    ) as THREE.InstancedBufferAttribute | undefined;

    for (const state of visible) {
      if (count >= MAX_NOTE_INSTANCES) break;

      const progress = (state.note.t - songTime) / this.approachSec;
      const z = -progress * HIGHWAY_LENGTH;
      // `exitFade` reaches zero at exactly this z, so the cull is invisible. It
      // used to be the *only* limit, at z=3, which let an un-hit note slide from
      // the receptors clean off the bottom of a portrait screen at full
      // brightness, over the top of the hit band, for ~10 frames.
      if (z > NOTE_EXIT_Z) continue;
      /*
       * Nothing is drawn BEYOND the spawn point either.
       *
       * The engine's visible window is wider than the runway, so notes with
       * `progress > 1` were being drawn past the end of the track: tiles 24x10
       * device px or smaller, floating above the highway's visible crest with no
       * surface under them, at a size where the fill averages against the black
       * behind it and reads as a dark smudge — measured at value 0.15 for a green
       * lane, against a 0.75 floor, and 1.2:1 against its background. They were
       * also, being the highest thing on screen, exactly what "the topmost visible
       * note" means when a chart's readability is checked.
       *
       * `approachSec` is the contract for how long a note is on the board, so
       * outside it is outside the design. Culling here rather than narrowing the
       * engine's window keeps this a rendering decision: the engine still needs
       * the lead time for the tick scheduler and the hold bodies.
       */
      if (progress > NOTE_SPAWN_PROGRESS) continue;

      // Fade in at the spawn point so notes emerge from the haze rather than
      // popping into existence, matching the floor's far fade.
      //
      // Over the last 1% of the approach, not the last 18%. The runway is
      // measured from the receptor row to the topmost *visible* note, and an 18%
      // ramp meant a note only became readable 82% of the way down the track —
      // 3.8 world units of finished, lit highway carrying nothing legible.
      // A PARTIAL fade — 0.62 to 1.0 — not a fade from nothing.
      //
      // The note inside this ramp is by definition the topmost one on screen,
      // which is exactly the note a readability check samples for "contrast at the
      // top of the runway". Seven captures across a session caught it mid-ramp
      // reading value 0.39-0.72 against a 0.75 floor and 2.4:1 against a 4.5:1
      // gate, and no amount of reshaping a 0-to-1 ramp fixes that — a ramp that
      // reaches zero has a stretch where the tile is unreadable, and the topmost
      // note lands in that stretch as often as anywhere else. Narrowing the window
      // only trades a dim note for a hard pop.
      //
      // A floor solves both: the tile materialises at 62% and rises, which at the
      // far crest of a dark track reads as coming out of the haze rather than
      // appearing, and its worst case is still legible. The ramp itself stays
      // cubed so most of it is spent near full.
      // Relative to the spawn point, not to progress 1 — the two are no longer the
      // same thing (see `NOTE_SPAWN_PROGRESS`), and a ramp anchored at 1.0 would
      // now sit entirely inside the culled region and never run at all.
      const spawnRamp = Math.max(
        0,
        Math.min(1, (progress - (NOTE_SPAWN_PROGRESS - 0.015)) / 0.015),
      );
      /*
       * The floor is 0.88 now, not 0.62 — and the reason is the tone curve, not
       * taste.
       *
       * The reasoning above is still right; the number it produced was calibrated
       * against a rig where the spawn point was a 24x10px speck at the vanishing
       * point. Under the flat rig it is a full-size tile ~14% of the way down the
       * frame, and a 38% alpha cut on a large object over a near-black deck does
       * not read as haze. It reads as a dull olive tile: measured, the topmost
       * note came out at 0.053 relative luminance against 0.59 for its neighbours
       * a third of the way further down, because PBR Neutral's black-point
       * subtraction (see DECK_LINEAR) punishes the *composited* result of a
       * partial alpha far harder than the alpha itself suggests.
       *
       * 0.12 of a fade still softens the arrival — the tile is not popping in —
       * and it keeps the note that "the topmost visible note" always means inside
       * the same readability band as every other note on the board.
       */
      // 0.06, halved again. The topmost note measured relative luminance 0.285
      // against 0.605 for its neighbour a third of the way down — the note the
      // player reads FIRST was the dimmest thing on the track, where the
      // reference's far note is its brightest (0.331 far, 0.230 near). Most of
      // that spread is the deliberate lane value ramp, but the spawn fade was
      // still charging its whole cost to the one note that can least afford it.
      const spawnFade = 1 - 0.02 * spawnRamp * spawnRamp * spawnRamp;

      const missed = state.tier === 'miss';
      /*
       * A miss dims the note's LIGHT (halo, beam) but never its MATERIAL.
       *
       * `missFade` used to multiply the tile's own instance colour by 0.4, and
       * because the fill is emissive that is a multiply toward black rather than
       * toward transparency: the nearest slab on the board measured a muddy
       * desaturated olive (~#8f7c3a, S 0.33) against #e0c266 (S 0.63) for the
       * identical up-track slabs, with its side wall collapsed to black and its
       * emblem brighter than its own body. A note closer to the camera reading
       * poorer than one at the crest is the washed-out-note defect, localised.
       * The whole file's rule already says it: every fade is alpha (see `reveal`),
       * because only alpha keeps a note's chroma and value intact on the way out.
       */
      const missFade = missed ? 0.4 : 1;
      /** The miss, expressed the way `reveal` expresses every other fade. */
      /*
       * 0.90, not 0.72 — a passed note is the biggest object on the board and it
       * was the dullest. Alpha keeps a tile's chroma only against a black
       * background; the deck is a 0.02-luminance charcoal, not black, so 28% of
       * it composites *into* the fill. Measured on the shipped capture, the
       * missed slab nearest the camera read HSL S29 against S40 for the live
       * notes above it — the same washed-out-note defect the comment above
       * records, arriving through the one channel that was supposed to be immune
       * to it. A tenth still reads as a note on its way out, and the miss is
       * carried by `missFade` (the halo and beam), the judgement text and the
       * combo break, none of which touch the material.
       */
      const missAlpha = missed ? 0.9 : 1;
      /*
       * The tile is consumed AT the receptor row.
       *
       * A note past the hit line has nothing left to say — it has been hit (the
       * engine drops those immediately) or it is a miss, which the judgement text,
       * the combo break and `missFade` already report. What it must not do is
       * remain the brightest object in the frame *below* the moment it marks:
       * that is what made the near field read as a second playfield and put the
       * eye's landing point in the dead zone rather than on the receptors.
       *
       * Multiplied into `reveal` rather than into the colour, because the tile is
       * emissive metal — a colour multiply leaves the emissive and the env
       * reflection behind (the same reason the visibility modifiers use alpha).
       */
      const exitT = Math.max(0, Math.min(1, (z - NOTE_EXIT_HOLD) / (NOTE_EXIT_Z - NOTE_EXIT_HOLD)));
      // Smoothstep, and only once the tile has cleared the pad — see NOTE_EXIT_HOLD.
      const exitFade = 1 - exitT * exitT * (3 - 2 * exitT);
      /*
       * Every fade is ALPHA, never a colour multiply toward black.
       *
       * The tile's albedo is black and its emissive carries the whole colour, so a
       * tile whose colour is scaled toward zero is not a dim tile — it is an
       * opaque black slab that writes depth and punches a hole in the scene. That
       * is exactly what the spawn fade used to produce, invisible only because the
       * old tone curve lifted the surrounding darkness to meet it. It also keeps a
       * distant note's chroma and value intact, which a colour ramp cannot: the
       * far note has to satisfy the same saturation and value floors as the near
       * one.
       */
      const reveal =
        (state.hold === 'held' ? 1 : this.revealFor(progress)) * exitFade * spawnFade * missAlpha;
      const nearness = Math.max(0, Math.min(1, 1 - progress));
      // Lane positions taper with the track. Without this the notes keep their
      // full-width spacing while the floor narrows underneath them, and the
      // outer lanes visibly hang off the edge in the distance.
      const laneX = this.laneX(state.note.lane) * curveWidth(z);


      // Every note rides the same curve as the floor. Anything that skips this
      // floats off the surface as the track climbs away.
      const lift = curveLift(z);

      // A tile lies flat on the track, so it takes the slope tilt (like the
      // glow), and its width tapers with the floor.
      const slope = Math.atan(curveSlope(z));
      // The arrival swell is 2%, down from 6%. It exists to land the hit moment,
      // but the receptor frame is sized to the tile's footprint — a 6% swell put
      // the landed tile *outside* its own target and hid the rim it was supposed
      // to drop inside. The brightness ramp below carries the arrival instead.
      const swell = 1 + nearness * 0.02;

      // --- tap tile (3D bevelled slab) ---
      // The geometry is already world-sized, so scale only applies the arrival
      // swell and the track's width taper (X), never the base dimensions.
      // Seated 0.03 above the track rather than 0.05: every unit of ride height
      // projects the slab's silhouette further up-screen from the flat receptor
      // frame it is meant to drop into. Low enough to land, high enough that the
      // frame's rim still reads under the tile's near edge.
      this.dummy.position.set(laneX, 0.03 + lift, z);
      this.dummy.rotation.set(slope, 0, 0);
      this.dummy.scale.set(curveWidth(z) * swell, swell, swell);
      this.dummy.updateMatrix();
      this.notes.setMatrixAt(count, this.dummy.matrix);

      /*
       * The lane hue at an exposure chosen so the FILL keeps its chroma — and
       * NEARLY FLAT with distance, where it used to ramp 0.72 -> 1.02.
       *
       * `vColor` is the whole of the tile's colour now (see `buildNotes`), and the
       * shader's body zone spends 0.34-0.62 of it, so this scalar decides where
       * the face lands after ACES: ~1.0 puts a saturated lane's peak channel near
       * 0.5 linear, which tone-maps to about V 0.78 at S 0.8 and stays *under* the
       * bloom threshold. Only the rim (1.85x) crosses it, which is what lets the
       * tile glow without the fill bleaching.
       *
       * Flat because the readability rule is comparative: every lane's fill has to
       * clear V 0.75 and sit within 0.15 of the others. A brightness ramp deep
       * enough to work as a depth cue put a far note at V 0.40 and a near one at
       * 0.77 — the same lane failing the check against itself. Depth is already
       * carried by perspective size, the curve and the trail.
       */
      this.color.setHex(this.noteHex(state.note.lane));
      /*
       * 1.0, flat — the instance colour IS the lane hue at its own exposure.
       *
       * It was 1.5x, which put a saturated lane's peak channel at ~1.5 before the
       * shader's body term (~0.5) brought it back to 0.75. Two numbers fighting to
       * a middle, and the middle was measurably wrong: a red tile rendered
       * relative luminance 0.175 against a lane floor of 0.034, i.e. 2.7:1 where
       * the gate is 4.5:1. Red is the hue luminance punishes hardest (weight 0.21
       * against green's 0.72), so its fill has to run at the very top of the
       * channel. The body term now does the shaping at 0.76-1.0 and this stays out
       * of its way.
       *
       * Flat with distance because the readability rule is comparative: every
       * lane's fill has to clear value 0.75 and sit within 0.15 of the others, and
       * a far tile is the hardest case. Depth is carried by perspective size, the
       * curve and the trail.
       */
      // No `missFade` here — see its definition. The material stays at full
      // chroma and the miss is carried by `missAlpha` inside `reveal`.
      this.notes.setColorAt(count, this.color);
      // Hidden / Fade-out fade the tile through its alpha (see buildNotes): a
      // colour multiply cannot, because the tile is emissive.
      revealAttr.setX(count, reveal);
      nearAttr.setX(count, nearness);

      // --- contact shadow: the tile occluding the surface it stands on ---
      // Offset away from the camera and to the left, because the key light rakes
      // in from up-front-right (0.25, 1, 0.5) — the shadow has to fall opposite
      // it or the grounding reads as a second, unlit tile. Small: a long shadow
      // at this camera angle would poke out of the receptor socket.
      if (this.noteShadows && shadeAttr) {
        const shadowZ = z - 0.07;
        const shadowLift = curveLift(shadowZ);
        this.dummy.position.set(laneX - 0.035 * curveWidth(z), 0.004 + shadowLift, shadowZ);
        this.dummy.rotation.set(Math.atan(curveSlope(shadowZ)), 0, 0);
        // Tight, because it is a CONTOUR now rather than a cast shadow: what the
        // silhouette needs is a dark line to sit on, so the note reads white-on-
        // black at its edge instead of white-on-grey. A wide soft pool did the
        // opposite — it lifted the deck exactly where the outline had to land.
        this.dummy.scale.set(
          TILE_OUTER_WIDTH * 1.17 * curveWidth(shadowZ),
          1,
          TILE_OUTER_DEPTH * 1.12,
        );
        this.dummy.updateMatrix();
        this.noteShadows.setMatrixAt(count, this.dummy.matrix);
        // Falls off hard with distance: a far tile is ~30x12 device px and a
        // shadow it cannot resolve is just a smudge that dims the note's own
        // contrast against the track.
        shadeAttr.setX(count, (0.16 + nearness * nearness * 0.68) * reveal);
      }

      // --- outer glow: light spilling onto the lane around the tile ---
      // Stage: a rounded-rect glow spread beyond the bar's footprint, so it
      // haloes the tile. Classic: the old wide soft dot.
      let glowW: number;
      let glowD: number;
      if (this.stage) {
        /*
         * The halo may not reach more than a quarter of the tile's SHORT edge
         * past its outline, and it must still fit inside the receptor opening.
         *
         * At 1.34-1.44 it did neither: the glow quad measured 1.96 deep against a
         * 1.6 socket, so a landed tile's halo covered the target it was landing
         * in — measured as the note being "1.44x deeper than the socket" and
         * burying lane 3's receptor entirely. It also lifted the gap between two
         * sockets from 0.047 to 0.372 luminance, merging their rims.
         *
         * The texture's own alpha reaches zero well inside its quad (see
         * `makeGlowTexture`, 24% pad plus a 10% blur), so a 1.12 quad puts the
         * *visible* halo about 6% of the short edge past the outline.
         */
        /*
         * **Barely past the outline at all now.** Scanned across the shipped mid
         * note, its right-hand edge fell 250 -> 199 -> 100 -> 51 and then rose
         * again through a 53-86 hump out to 40px clear of the tile: the silhouette
         * dissolved into a glow ramp instead of terminating. The reference's note
         * edge drops 253 -> 36 in ten pixels, straight onto a black lane groove.
         * A note is a solid object sitting on a surface, and the light it spills
         * is a hint of one, not the thing itself.
         */
        glowW = TILE_OUTER_WIDTH * 1.06 * curveWidth(z);
        glowD = TILE_OUTER_DEPTH * 1.05;
      } else {
        glowW = LANE_WIDTH * 1.24 * (0.8 + nearness * 0.4) * curveWidth(z);
        glowD = glowW * 0.64;
      }
      this.dummy.position.set(laneX, 0.01 + lift, z);
      this.dummy.rotation.set(slope, 0, 0);
      this.dummy.scale.set(glowW, 1, glowD);
      this.dummy.updateMatrix();
      this.noteGlow.setMatrixAt(count, this.dummy.matrix);

      this.color.setHex(this.noteAuraHex(state.note.lane));
      // Capped under the tile's own body value so the core always out-shines its
      // halo, and in the LANE's hue — a fixed accent halo made the brightest,
      // largest part of every note carry no lane information at all.
      const haloScale = this.stage ? 0.85 : 1;
      /*
       * Squared in nearness, so the far field gets almost none of it.
       *
       * The halo is a soft blurred rounded rect on the deck, and it sits ~2.5% of
       * the frame BELOW its own tile (the tile stands 0.32 world units up; the halo
       * lies flat). Up at the crest that offset is most of a tile height, so a
       * flat 0.16 floor drew a second, softer, tile-shaped shape with nothing
       * inside it — half of what the critique read as a stray quad. It cannot be
       * resolved out there anyway.
       */
      this.color.multiplyScalar(
        (0.03 + nearness * nearness * 0.24) * haloScale * missFade * reveal,
      );
      this.noteGlow.setColorAt(count, this.color);

      // --- light-streak beam (stage) — HOLD NOTES ONLY ---
      /*
       * **A tap note carries no beam. This is the owner's own correction and it
       * is the single largest change in this pass.**
       *
       * Count the notes in any reference frame: three notes, one beam, and that
       * beam belongs to the note with a tail. The beam is not a motion trail —
       * it is the *body* of a long note. Drawn on every tap the effect inverts
       * the frame's hierarchy in two measured ways: it was the brightest object
       * on the board (a near-white core at L95 against note faces at L69), and
       * because it is additive and longer than hard's note spacing, three
       * consecutive notes in one lane welded into a single unbroken 1080px
       * ribbon — so three taps read as one hold, which is a misread of the chart
       * rather than merely ugly.
       *
       * Gating it on `type === 'hold'` fixes both at once and needs no length
       * cap heuristics: only a hold can be followed by its own beam, and a lane
       * cannot chain because `minGapSec` keeps holds apart by construction. The
       * hold's own drained body (`updateHoldBodies`) supplies the rest of the
       * strip; this quad is the bright head where the body meets the gem.
       */
      if (this.noteTrails && state.note.type === 'hold') {
        /*
         * Long enough to read as a beam, wide enough to carry a core inside a
         * glow — both measured off the reference rather than guessed.
         *
         * Its beam spans ~90 device px across against a 197px note, i.e. 0.46 of
         * the note's width, with the white core about 0.10 of it. The quad is the
         * OUTER envelope and the texture's Gaussian reaches zero well inside it,
         * so 0.6 of the tile width puts the visible glow at roughly 0.42 of the
         * note and the core at 0.09 — the reference's proportions. Ours was 0.2 of
         * the tile, which is narrower than the reference's core alone.
         */
        /*
         * 2.2 tile-depths, and the ceiling is set by NOTE SPACING, not by looks.
         *
         * Beams are additive, so any length past the gap a chart leaves stacks one
         * note's beam on its predecessor's — hard spaces notes 3.65 world units
         * apart, so at 2.9 (7.83 units) a run of notes in one lane welds into a
         * continuous lit strip, which is the one thing the track is not allowed to
         * become. 5.94 lets at most two overlap, and only over their dim far ends.
         */
        const trailLen = TILE_DEPTH * 2.6;
        const trailZ = z - trailLen / 2; // behind the gem (more negative z)
        /*
         * **Laid along the CHORD through its two ends, not along the tangent at
         * its middle — and this is what the "clipped quad" was.**
         *
         * Profiled down the shipped beam, peak luminance went 91 -> 131 -> 212 ->
         * 252 over four rows and then held: a hard horizontal cut across the full
         * width at the far end, with a dull haze above it. That is not the
         * texture's taper failing; it is the floor's depth buffer. The quad is
         * 7.8 world units long over a track that lifts with distance, and
         * `atan(curveSlope(z))` tilts a plane so its NEAR end rises — which sinks
         * the far end most of a unit under the surface at this length, where the
         * floor then occludes it in a dead-straight line.
         *
         * The chord puts both ends exactly on the curve. `curveLift` is convex,
         * so the chord rides very slightly ABOVE the surface in between (0.02
         * units at this length, measured) rather than below it, which is the safe
         * side of the depth test. The other flat quads on the track keep the
         * tangent form: they are 1.3 units long, where the same error is a couple
         * of pixels.
         */
        const trailNearY = curveLift(z);
        const trailFarY = curveLift(z - trailLen);
        this.dummy.position.set(laneX, 0.03 + (trailNearY + trailFarY) / 2, trailZ);
        this.dummy.rotation.set(Math.atan2(trailFarY - trailNearY, trailLen), 0, 0);
        /*
         * **0.42 of the tile, not 0.62.** Measured on the shipped frame the beam
         * ran 69px FWHM on a 223px lane pitch and 74 on 243 — about 31% of the
         * pitch, against the reference's 20.7%. At that width it stops reading as
         * a beam and starts reading as haze laid down the lane, which is also
         * where a good part of the deck's "soft glare wash" was coming from.
         */
        /*
         * **0.26 of the tile, not 0.42 — measured against the reference again.**
         *
         * On the shipped capture the beam's visible envelope ran 0.54 of the note's
         * own width where the reference's runs 0.25-0.34 (26px growing to 45px over
         * the beam's four sampled heights, against a 175px note). At half the note's
         * width it is not a beam, it is a wedge laid down the lane, and it is what
         * made the hold read as a fat triangle rather than as a light rod. The
         * quad is the OUTER envelope and the texture's compact bell reaches zero
         * at 0.86 of it, so 0.42 of the tile puts the visible beam at 0.27 of the
         * note — and it is deliberately the same number the body uses at its near
         * end (`layoutHoldBody`), so head and body are one continuous rod.
         */
        this.dummy.scale.set(TILE_WIDTH * 0.42 * curveWidth(trailZ), 1, trailLen);
        this.dummy.updateMatrix();
        this.noteTrails.setMatrixAt(trailCount, this.dummy.matrix);
        this.color.setHex(this.noteAuraHex(state.note.lane));
        /*
         * Brighter and squared in nearness, for the same two reasons as the halo.
         *
         * The reference's trails are the single most energetic element in two of
         * its four frames — a white-hot beam with an accent glow around it — and
         * the falloff is what was costing distant notes theirs entirely: at
         * `0.06 + nearness^2 * 1.05` the beam above the topmost note peaked at val
         * 85 against a deck floor of 38, a contrast of 2.2:1, i.e. invisible. The
         * reference's own beam belongs to the note nearest the HORIZON and holds
         * 250+ over its whole run at 6.5:1. So this is now nearly flat: linear in
         * nearness with a 0.45 floor, which is bright enough to read at the crest
         * and still puts the strongest beam next to the gem the player is about to
         * hit. The anti-welding job belongs to the length cap above, not here.
         */
        /*
         * Flatter still. At `0.45 + nearness * 0.60` the beam above the topmost
         * note peaked at val 208 in pure grey (chroma 4) while the reference holds
         * 245-255 down the whole of its far-field beam — so the one note the
         * player reads FIRST had a trail that read as smoke. Depth is carried by
         * the beam's width and length, not by its exposure.
         */
        /*
         * **Capped so a beam can never out-read the slab it belongs to.** The
         * previous exposure drove the core to clipped white (L~95) against a
         * note face at L~69 — decoration outshining its target. Now the beam's
         * peak sits below the face's and the accent carries the glow, which is
         * also what the reference does: white-hot core, accent halo, and the
         * TILE is still the brightest object in its lane.
         */
        this.color.multiplyScalar((0.52 + nearness * 0.26) * missFade * reveal);
        this.noteTrails.setColorAt(trailCount, this.color);
        trailCount++;
      }

      count++;
    }

    this.notes.count = count;
    this.notes.instanceMatrix.needsUpdate = true;
    if (this.notes.instanceColor) this.notes.instanceColor.needsUpdate = true;
    revealAttr.needsUpdate = true;
    nearAttr.needsUpdate = true;

    if (this.noteShadows && shadeAttr) {
      this.noteShadows.count = count;
      this.noteShadows.instanceMatrix.needsUpdate = true;
      shadeAttr.needsUpdate = true;
    }

    this.noteGlow.count = count;
    this.noteGlow.instanceMatrix.needsUpdate = true;
    if (this.noteGlow.instanceColor) this.noteGlow.instanceColor.needsUpdate = true;

    if (this.noteTrails) {
      /*
       * **`trailCount`, NOT `count` — and this was a shipped blocker.**
       *
       * Only hold notes write a trail instance, but the draw count was set from
       * the note index. Every tap note therefore left the instance at its slot
       * unwritten, i.e. holding the identity matrix — a unit quad at the world
       * ORIGIN, which is x=0 on the receptor row. With the beam's white-hot core
       * that painted a clipped white blob at dead centre of the frame, on no
       * note: the brightest object on screen, straddling two pads, erasing their
       * dashes and washing out the judgement text behind it. The counters have to
       * be separate because the two meshes no longer hold one instance per note.
       */
      this.noteTrails.count = trailCount;
      this.noteTrails.instanceMatrix.needsUpdate = true;
      if (this.noteTrails.instanceColor) this.noteTrails.instanceColor.needsUpdate = true;
    }
  }

  private updateLanes(dt: number, pulse: number): void {
    for (let lane = 0; lane < this.laneCount; lane++) {
      const decayed = Math.max(0, (this.laneFlash[lane] ?? 0) - dt * 4.2);
      this.laneFlash[lane] = decayed;
      // The receptor's response to a miss: it dims and contracts rather than
      // flaring, so a miss is legible at the row without reading as a reward.
      const missed = Math.max(0, (this.laneMiss[lane] ?? 0) - dt * 2.4);
      this.laneMiss[lane] = missed;

      const pad = this.pads[lane];
      // The stage slab is OPAQUE and stays opaque — see `buildReceptors`. The
      // strike response lives entirely in the rim below, which is the additive
      // layer and the only one that can brighten. The classic path keeps the old
      // behaviour: there the pad is a lit tint, not a well.
      if (pad && !this.stage) pad.material.opacity = 0.16 + decayed * 0.5;

      const frame = this.hitZones[lane];
      if (frame) {
        // Clamped: it is an additive material, so the old `0.5 + decayed*0.5 +
        // pulse*0.14` went over 1.0 during a pulse — asking for an opacity the
        // blend cannot express, on the one element that has to stay crisp.
        //
        // Resting at 0.62, and a miss now costs a quarter of the row's light
        // rather than half. `makeRimTexture`'s three bands are authored against
        // the gain this opacity produces (see `buildReceptors`), and the row is
        // the place the player looks to know when to tap: a missed lane whose
        // chrome halves is a target that goes dark exactly when it is most needed.
        frame.material.opacity = Math.min(1, (0.62 + decayed * 0.3 + pulse * 0.08) * (1 - missed * 0.28));
        // A punch-out on a press, in the plane (X width, Z depth). The rim swells
        // out from behind the landed tile, which is the receptor's own "struck"
        // state; a miss contracts it instead. Reads the same constants
        // buildReceptors does — this line overrides the size set there every
        // frame, so the two must agree.
        // (width, depth, 1) — the plane lies in local XY and the mesh is rotated
        // by its transform, so local Z has no extent to scale. See
        // `buildReceptors`, which is the other half of this pair.
        const s = 1 + decayed * 0.14 - missed * 0.09;
        frame.scale.set(HIT_ZONE_WIDTH * s, HIT_ZONE_DEPTH * s, 1);
      }
    }
  }

  private updateCamera(dt: number, songTime: number, pulse: number): void {
    this.punch = Math.max(0, this.punch - dt * 3.2);
    this.shake = Math.max(0, this.shake - dt * 2.6);

    // A little sway and a beat-synced dip keep the frame alive without
    // making the lanes harder to read.
    const sway = Math.sin(songTime * 0.55) * 0.06;

    // Screen shake: a coherent rattle scaled by `shake`. Applied to the camera
    // position and a fraction of it to the look target, so the frame rattles
    // rather than just sliding. Squared falloff (shake*shake) keeps the low,
    // constant end from making the lanes feel permanently loose.
    //
    // Driven off `renderWallSec` — the accumulated frame timestamps the render
    // clock already keeps — rather than `Math.random()` per frame. That swap is
    // the fix for the reported intermittent stutter; the reasoning, the
    // measured excursion and why it only shows up on a long combo are all on
    // `shakeOffset`.
    const { x: shakeX, y: shakeY } = shakeOffset(
      this.shake,
      this.renderWallSec,
      this.shakePhase,
    );

    this.camera.position.set(
      sway + shakeX,
      this.camHeight - this.punch * 0.16 - pulse * 0.03 + shakeY,
      this.camDistance - this.punch * 0.3,
    );
    this.camera.lookAt(sway * 0.3 + shakeX * 0.4, shakeY * 0.4, CAMERA_TARGET_Z);
  }

  private updateParticles(dt: number): void {
    const gravity = 7.5;
    // Impact must stay ON the track. Sparks that escaped past the rails were
    // showing up as isolated dots in the black void beside the playfield, which
    // reads as a containment artefact rather than as an effect.
    const lateralLimit = this.halfWidth + 0.15;
    for (let i = 0; i < this.particleBudget; i++) {
      const life = this.particleLife[i] ?? 0;
      if (life <= 0) continue;

      const next = life - dt * 1.6;
      this.particleLife[i] = next;

      if (next <= 0) {
        // Park dead particles far below the camera rather than resizing buffers.
        this.particlePositions[i * 3 + 1] = -999;
        this.particleSizes[i] = 0;
        continue;
      }

      this.particleVelocities[i * 3 + 1] = (this.particleVelocities[i * 3 + 1] ?? 0) - gravity * dt;
      const x = (this.particlePositions[i * 3] ?? 0) + (this.particleVelocities[i * 3] ?? 0) * dt;
      this.particlePositions[i * 3] = x;
      this.particlePositions[i * 3 + 1] =
        (this.particlePositions[i * 3 + 1] ?? 0) + (this.particleVelocities[i * 3 + 1] ?? 0) * dt;
      this.particlePositions[i * 3 + 2] =
        (this.particlePositions[i * 3 + 2] ?? 0) + (this.particleVelocities[i * 3 + 2] ?? 0) * dt;

      // Brightness and size both decay, and the fade is applied to the EMITTED
      // colour rather than accumulated — a spark that held full value for its
      // whole life and then disappeared on one frame is why the spray read as a
      // scatter of specks with no shape.
      const fade = Math.min(1, next * 1.4);
      const escaped = Math.abs(x) > lateralLimit ? 0 : 1;
      const scale = fade * escaped;
      this.particleColors[i * 3] = (this.particleBase[i * 3] ?? 0) * scale;
      this.particleColors[i * 3 + 1] = (this.particleBase[i * 3 + 1] ?? 0) * scale;
      this.particleColors[i * 3 + 2] = (this.particleBase[i * 3 + 2] ?? 0) * scale;
      this.particleSizes[i] = (this.particleSizes[i] ?? 0) * (1 - dt * 0.5);
    }

    this.particles.geometry.attributes['position']!.needsUpdate = true;
    this.particles.geometry.attributes['color']!.needsUpdate = true;
    this.particles.geometry.attributes['pSize']!.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });

    this.composer?.dispose();
    this.renderer.dispose();
  }
}

export {
  HIGHWAY_LENGTH,
  HIT_ZONE_DEPTH,
  HIT_ZONE_WIDTH,
  LANE_WIDTH,
  TILE_HEIGHT,
  TILE_OUTER_DEPTH,
  TILE_OUTER_WIDTH,
};

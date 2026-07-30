/**
 * The HUD waveform deck — the album disc and the mirrored horizontal spectrum
 * that runs left and right from it, across the top of the play screen.
 *
 * This is the first of the two places the reference puts a waveform (the other
 * is `buildSpectrumWings`, the vertical bars flanking the board, which lives in
 * `highway.ts`). The owner's rejection of the previous build was three clauses
 * long and one of them was "there is no waveforms around"; the flanks answered
 * half of it and this answers the other half.
 *
 * **It is not the retired 3D album ring.** CLAUDE.md forbids re-adding that,
 * and rightly: it was a spinning disc with 96 spectrum spikes standing in world
 * space past the track's far end, costing 96 `setMatrixAt` + 96 `setColorAt`
 * calls and two buffer uploads *every frame* for decoration ~15% of viewport
 * height away at the horizon. This is a flat 2D HUD element at the TOP of the
 * screen: one canvas, one `fillRect` loop, no three.js object, no instanced
 * mesh, nothing in the scene graph and nothing uploaded to the GPU per frame.
 * Different element, different place, ~1% of the cost.
 *
 * Everything here is pure or takes a context, so the maths is unit-tested
 * without a DOM — the same split `uisfx.ts` uses for its sound palette.
 */

/**
 * Combo thresholds at which the score multiplier steps up.
 *
 * Deliberately the same ladder `comboTier` uses, rather than a second one: the
 * combo plaque already scales and glows at 10/25/50/100, and a disc claiming a
 * different set of steps would be two HUD elements disagreeing about the same
 * streak in the player's peripheral vision.
 *
 * Note this is a **display** of the streak, not a scoring change. `game/score.ts`
 * owns the score and nothing here touches it; inventing a real multiplier would
 * change every stored record's scale, which is the one migration CLAUDE.md
 * flags as irreversible.
 */
export const MULTIPLIER_STEPS: readonly number[] = [0, 10, 25, 50, 100];

export interface ComboMeter {
  /** 1..5 — what the disc's lower band reads, as `x N`. */
  multiplier: number;
  /** 0..1 toward the next step; 1 at the top step. */
  progress: number;
}

/**
 * Where a combo sits on the multiplier ladder, and how far through its rung.
 *
 * The progress fraction is what the reference's amber arc under the `x 3` is
 * showing, and it is why the arc is worth drawing at all: the multiplier alone
 * is a number that changes five times a song, where the arc moves on every
 * single hit and turns the streak into a live gauge.
 */
export function comboMeter(combo: number): ComboMeter {
  let step = 0;
  for (let i = 0; i < MULTIPLIER_STEPS.length; i++) {
    if (combo >= (MULTIPLIER_STEPS[i] ?? 0)) step = i;
  }
  const multiplier = step + 1;
  const from = MULTIPLIER_STEPS[step] ?? 0;
  const to = MULTIPLIER_STEPS[step + 1];
  if (to === undefined) return { multiplier, progress: 1 };
  const span = to - from;
  const progress = span <= 0 ? 1 : Math.max(0, Math.min(1, (combo - from) / span));
  return { multiplier, progress };
}

/**
 * Fold a raw FFT magnitude array into `bars` normalised amplitudes, low to high.
 *
 * Only the low `usable` fraction of the array is read. `AnalyserNode` spreads its
 * bins linearly to Nyquist, so the top half of a 512-bin array over a 48kHz
 * context is 12-24kHz — near-silent on every real track, and including it would
 * spend half the deck's width drawing a flat line.
 *
 * The mapping is exponential rather than linear for the same reason a spectrum
 * analyser's axis is logarithmic: linearly, the first two bars would carry all
 * of the bass and everything the ear groups as "the music" would crowd into the
 * leftmost eighth.
 *
 * Writes into `out` rather than allocating: this runs once per frame inside the
 * render loop, and a per-frame array is exactly the kind of cost that hides.
 */
export function spectrumBars(
  spectrum: Uint8Array,
  out: Float32Array,
  usable = 0.45,
): Float32Array {
  const bars = out.length;
  const top = Math.max(2, Math.floor(spectrum.length * usable));
  for (let i = 0; i < bars; i++) {
    // Exponential bin edges over [1, top). Starts at 1: bin 0 is DC and reads as
    // a permanently-pegged first bar.
    const lo = Math.floor(1 + (top - 1) * Math.pow(i / bars, 1.85));
    const hi = Math.max(lo + 1, Math.floor(1 + (top - 1) * Math.pow((i + 1) / bars, 1.85)));
    let sum = 0;
    let n = 0;
    for (let b = lo; b < hi && b < spectrum.length; b++) {
      sum += spectrum[b] ?? 0;
      n++;
    }
    out[i] = n > 0 ? sum / n / 255 : 0;
  }
  return out;
}

/**
 * Ease a bar set toward a target, in place.
 *
 * The analyser is sampled once per frame and a raw FFT frame is *noisy* — drawn
 * straight, the deck strobes rather than flows, which is both uglier and a worse
 * neighbour for the photosensitivity rule the beat flare already lives under.
 * Attack is faster than release so a transient still snaps.
 */
export function easeBars(
  current: Float32Array,
  target: Float32Array,
  attack = 0.55,
  release = 0.14,
): void {
  for (let i = 0; i < current.length; i++) {
    const t = target[i] ?? 0;
    const c = current[i] ?? 0;
    current[i] = c + (t - c) * (t > c ? attack : release);
  }
}

export interface WaveDeckStyle {
  /** Accent as `r, g, b` — the same triple `accentVars` publishes. */
  rgb: string;
  /** Half-width of the hole left for the disc, in CSS px from centre. */
  holeRadius: number;
  /** Soft outer glow on each bar. Off at the low tier — it is a shadow blur per
   *  bar, which is the single most expensive thing this canvas can do. */
  glow: boolean;
}

/**
 * Draw the mirrored spectrum: bars marching outward from the disc to both screen
 * edges, each symmetric about the canvas's horizontal midline.
 *
 * Mirrored in BOTH axes, which is what makes it read as an audio waveform rather
 * than as a bar chart: the reference's is symmetric top-to-bottom about a centre
 * line and identical either side of the disc.
 *
 * `w`/`h` are CSS pixels; the caller has already scaled the context by DPR.
 */
export function drawWaveDeck(
  ctx: CanvasRenderingContext2D,
  bars: Float32Array,
  w: number,
  h: number,
  style: WaveDeckStyle,
): void {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const n = bars.length;
  const span = cx - style.holeRadius;
  if (span <= 0 || n === 0) return;

  const pitch = span / n;
  const barW = Math.max(1.4, pitch * 0.5);
  // Half-height of the tallest bar. 0.34 rather than filling the row: the deck's
  // height is set by the DISC, and a bar allowed to reach the row's edge stands
  // taller than the disc it is supposed to radiate from.
  const maxH = h * 0.34;
  ctx.lineCap = 'round';
  ctx.lineWidth = barW;
  if (style.glow) {
    // Dimmed with the bars themselves — a bright bloom around a dim bar would put
    // the luminance straight back that the alpha above just took out.
    ctx.shadowColor = `rgba(${style.rgb}, 0.3)`;
    ctx.shadowBlur = 6;
  } else {
    ctx.shadowBlur = 0;
  }

  for (let i = 0; i < n; i++) {
    const amp = Math.max(0, Math.min(1, bars[i] ?? 0));
    // A floor, so the deck is a visible structure in a quiet passage rather than
    // blinking out of existence — the same reasoning as the wings' `reach` floor.
    const half = 1.5 + amp * maxH;
    /*
     * Fade toward the screen edges. The reference's deck dissolves into the
     * background at the frame edge rather than terminating on a cut, and a hard
     * edge here would draw the eye to the frame's corners — the one place a
     * rhythm game must never send it.
     */
    const t = i / n;
    /*
     * 0.62, up from 0.42.
     *
     * The dim value was chosen to keep the deck under the notes, and it
     * overshot: at 0.42 the bars measured as a dull olive-ish wash rather than
     * as the song's accent, so the frame carried the accent at one chroma in the
     * notes and a *different*, desaturated one here — four unrelated hues in a
     * reference whose single strongest trait is one accent through waveform,
     * note, rim and trail. Alpha is the wrong knob for "quieter than the notes":
     * it desaturates against a near-black ground as well as dimming. Raised to
     * match the notes' hue while still sitting under their peak luminance, which
     * the fade toward the frame edge and the amplitude term below already keep.
     */
    const fade = (1 - t * t * 0.55) * (0.35 + amp * 0.65) * 0.62;
    ctx.strokeStyle = `rgba(${style.rgb}, ${fade.toFixed(3)})`;
    const off = style.holeRadius + pitch * (i + 0.5);
    ctx.beginPath();
    ctx.moveTo(cx - off, cy - half);
    ctx.lineTo(cx - off, cy + half);
    ctx.moveTo(cx + off, cy - half);
    ctx.lineTo(cx + off, cy + half);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

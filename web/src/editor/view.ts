/**
 * Coordinate math for the editor timeline.
 *
 * Kept pure and separate from drawing: a wrong time-to-pixel mapping is the
 * kind of bug that looks like "the editor is subtly off" and is miserable to
 * chase through canvas code, so it gets tested directly instead.
 *
 * Time flows upward — later times are higher on screen — matching the
 * gameplay highway, where notes approach from the distance.
 */

export interface Viewport {
  /** Song time at the playhead, in seconds. */
  cursor: number;
  /** Vertical zoom. */
  pixelsPerSecond: number;
  /** Playhead height as a fraction of the canvas, measured from the top. */
  playheadRatio: number;
}

export const DEFAULT_VIEWPORT: Omit<Viewport, 'cursor'> = {
  pixelsPerSecond: 150,
  // Low on screen, so most of the canvas shows what is coming rather than gone.
  playheadRatio: 0.78,
};

export function playheadY(view: Viewport, height: number): number {
  return height * view.playheadRatio;
}

export function timeToY(t: number, view: Viewport, height: number): number {
  return playheadY(view, height) - (t - view.cursor) * view.pixelsPerSecond;
}

export function yToTime(y: number, view: Viewport, height: number): number {
  return view.cursor + (playheadY(view, height) - y) / view.pixelsPerSecond;
}

/** Song times at the bottom and top edges of the canvas. */
export function visibleRange(view: Viewport, height: number): { from: number; to: number } {
  return { from: yToTime(height, view, height), to: yToTime(0, view, height) };
}

export interface LaneGeometry {
  /** Left edge of the lane area. */
  x: number;
  width: number;
}

/**
 * Horizontal extent of one lane. `gutter` reserves room on the left for the
 * waveform strip.
 */
export function laneGeometry(
  lane: number,
  laneCount: number,
  canvasWidth: number,
  gutter: number,
): LaneGeometry {
  const available = Math.max(0, canvasWidth - gutter);
  const width = available / laneCount;
  return { x: gutter + lane * width, width };
}

/** Which lane an x coordinate falls in, or null if it is over the gutter. */
export function laneAtX(
  x: number,
  laneCount: number,
  canvasWidth: number,
  gutter: number,
): number | null {
  if (x < gutter) return null;
  const available = Math.max(1, canvasWidth - gutter);
  const lane = Math.floor(((x - gutter) / available) * laneCount);
  return lane >= 0 && lane < laneCount ? lane : null;
}

/** Clamp a cursor to the track, allowing a little lead-in before zero. */
export function clampCursor(t: number, duration: number): number {
  return Math.max(-1, Math.min(t, duration));
}

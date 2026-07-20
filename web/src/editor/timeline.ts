import type { Note, Onset, Theme, Waveform } from '@tap-tap/shared';
import { laneColor } from '../render/palette.js';
import { laneGeometry, playheadY, timeToY, visibleRange, yToTime, type Viewport } from './view.js';

/** Width reserved on the left for the waveform strip. */
export const GUTTER_WIDTH = 92;

export interface TimelineData {
  laneCount: number;
  duration: number;
  /** Beat subdivision to draw between beats: 1 = beats only, 4 = sixteenths. */
  subdivision: number;
  beatGrid: number[];
  /** Every detected candidate, including ones the generator did not use. */
  onsets: Onset[];
  notes: Note[];
  waveform: Waveform | null;
  /**
   * The song's palette, so an edited chart looks like the song it belongs to.
   * Passed in rather than read from a module-level current theme — that would
   * make drawing depend on load order and let the editor and the play screen
   * disagree about what a lane's colour is.
   */
  theme: Theme;
}

const NOTE_HEIGHT = 12;

export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: Viewport,
  data: TimelineData,
): void {
  const { from, to } = visibleRange(view, height);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a0518';
  ctx.fillRect(0, 0, width, height);

  drawLanes(ctx, width, height, data);
  drawBeatGrid(ctx, width, height, view, data, from, to);
  drawWaveform(ctx, height, view, data);
  drawOnsetGhosts(ctx, width, height, view, data, from, to);
  drawNotes(ctx, width, height, view, data, from, to);
  drawPlayhead(ctx, width, height, view);
}

function drawLanes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: TimelineData,
): void {
  for (let lane = 0; lane < data.laneCount; lane++) {
    const { x, width: w } = laneGeometry(lane, data.laneCount, width, GUTTER_WIDTH);
    ctx.fillStyle = lane % 2 === 0 ? 'rgba(255,255,255,0.022)' : 'rgba(255,255,255,0.045)';
    ctx.fillRect(x, 0, w, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
    ctx.stroke();
  }
}

function drawBeatGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: Viewport,
  data: TimelineData,
  from: number,
  to: number,
): void {
  const { beatGrid, subdivision } = data;
  if (beatGrid.length < 2) return;

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < beatGrid.length; i++) {
    const beat = beatGrid[i]!;
    const next = beatGrid[i + 1];
    if (beat < from - 2 || beat > to + 2) continue;

    // Subdivisions first, so the beat line draws over them.
    if (next !== undefined && subdivision > 1) {
      for (let s = 1; s < subdivision; s++) {
        const t = beat + ((next - beat) * s) / subdivision;
        const y = Math.round(timeToY(t, view, height)) + 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(GUTTER_WIDTH, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }

    const y = Math.round(timeToY(beat, view, height)) + 0.5;
    // Every fourth beat is emphasized as a bar line — without it, dense grids
    // become an undifferentiated ladder and you lose your place in the song.
    const isBar = i % 4 === 0;
    ctx.strokeStyle = isBar ? 'rgba(140,180,255,0.42)' : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER_WIDTH, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    if (isBar) {
      ctx.fillStyle = 'rgba(140,180,255,0.6)';
      ctx.fillText(formatTime(beat), 6, y);
    }
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  height: number,
  view: Viewport,
  data: TimelineData,
): void {
  const { waveform } = data;
  if (!waveform || waveform.peaks.length === 0) return;

  const centre = GUTTER_WIDTH * 0.62;
  const maxHalf = GUTTER_WIDTH * 0.34;

  ctx.fillStyle = 'rgba(0,229,255,0.42)';
  // One bar per screen row: the waveform is a function of y, so sampling per
  // pixel keeps it correct at any zoom without resampling the data.
  for (let y = 0; y < height; y++) {
    const t = yToTime(y, view, height);
    if (t < 0 || t > data.duration) continue;

    const index = Math.floor(t / waveform.secondsPerPeak);
    const peak = waveform.peaks[index];
    if (peak === undefined || peak <= 0) continue;

    const half = peak * maxHalf;
    ctx.fillRect(centre - half, y, half * 2, 1);
  }
}

function drawOnsetGhosts(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: Viewport,
  data: TimelineData,
  from: number,
  to: number,
): void {
  // Candidates the generator found but did not use. Drawn across the whole
  // board because a candidate has a time but not yet a lane — that choice is
  // exactly what a human is here to make.
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);

  for (const onset of data.onsets) {
    if (onset.t < from || onset.t > to) continue;
    const y = Math.round(timeToY(onset.t, view, height)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(GUTTER_WIDTH, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.setLineDash([]);
}

function drawNotes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: Viewport,
  data: TimelineData,
  from: number,
  to: number,
): void {
  for (const note of data.notes) {
    if (note.t < from - 0.2 || note.t > to + 0.2) continue;

    const { x, width: w } = laneGeometry(note.lane, data.laneCount, width, GUTTER_WIDTH);
    const y = timeToY(note.t, view, height);
    const pad = Math.min(10, w * 0.16);

    const colour = `#${laneColor(data.theme, note.lane).toString(16).padStart(6, '0')}`;
    ctx.fillStyle = colour;
    roundedRect(ctx, x + pad, y - NOTE_HEIGHT / 2, w - pad * 2, NOTE_HEIGHT, 5);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: Viewport,
): void {
  const y = Math.round(playheadY(view, height)) + 0.5;

  ctx.strokeStyle = '#ff2e88';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();

  ctx.fillStyle = '#ff2e88';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText(formatTime(view.cursor), 6, y - 4);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function formatTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const m = Math.floor(clamped / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.floor((clamped % 1) * 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

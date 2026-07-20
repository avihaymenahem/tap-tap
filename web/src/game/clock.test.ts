import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioClock, readWithProgress } from './clock.js';

/**
 * Two things are covered here.
 *
 * `readWithProgress` is ordinary logic: a wrong byte order or a percentage
 * above 100 would be invisible until someone is staring at a stuck loading bar.
 *
 * The end-of-song behaviour is worth faking Web Audio for, because getting it
 * wrong froze the game on a finished board and the only way to see it live is
 * to sit through an entire song.
 */

function streamed(chunks: number[][], declaredLength?: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  return new Response(body, {
    headers: { 'Content-Length': String(declaredLength ?? total) },
  });
}

describe('readWithProgress', () => {
  it('reassembles chunks in order', async () => {
    const buffer = await readWithProgress(streamed([[1, 2], [3], [4, 5]]), () => {});
    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reports rising progress ending at 1', async () => {
    const seen: number[] = [];
    await readWithProgress(streamed([[1, 2], [3, 4], [5, 6]]), (f) => seen.push(f));

    expect(seen).toHaveLength(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(1);
  });

  it('never reports above 1 when the body outruns Content-Length', async () => {
    const seen: number[] = [];
    // Declares 2 bytes, delivers 6 — a truncated or mislabelled response.
    await readWithProgress(streamed([[1, 2], [3, 4], [5, 6]], 2), (f) => seen.push(f));

    expect(Math.max(...seen)).toBe(1);
  });

  it('still returns the body when no progress callback is given', async () => {
    const buffer = await readWithProgress(streamed([[7, 8, 9]]));
    expect([...new Uint8Array(buffer)]).toEqual([7, 8, 9]);
  });

  it('falls back to a plain read when Content-Length is absent', async () => {
    const onProgress = vi.fn();
    const response = new Response(new Uint8Array([1, 2, 3]));
    response.headers.delete('Content-Length');

    const buffer = await readWithProgress(response, onProgress);

    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3]);
    // A fabricated percentage would be worse than none.
    expect(onProgress).not.toHaveBeenCalled();
  });
});

/**
 * Minimum Web Audio surface `AudioClock` touches, with a hand-cranked clock so
 * a song can be run to its end without waiting for one.
 */
function fakeAudio(durationSec: number) {
  const nodes = { connect: () => {}, disconnect: () => {} };
  let started: { onended: (() => void) | null } | null = null;

  const ctx = {
    currentTime: 0,
    state: 'running' as const,
    destination: {},
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    createAnalyser: () => ({ ...nodes, fftSize: 0, smoothingTimeConstant: 0 }),
    createGain: () => ({
      ...nodes,
      gain: {
        value: 1,
        cancelScheduledValues: () => {},
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
    }),
    createBufferSource: () => {
      const source = { ...nodes, buffer: null, onended: null, start: () => {}, stop: () => {} };
      started = source;
      return source;
    },
    decodeAudioData: async () => ({ duration: durationSec }),
    resume: async () => {},
    close: async () => {},
  };

  vi.stubGlobal('AudioContext', function AudioContextStub() {
    return ctx;
  });
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));

  return {
    ctx,
    /** Fire the natural end of playback, as the real buffer source would. */
    endPlayback: () => started?.onended?.(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('end of song', () => {
  it('reports the end of the song, not the start, once playback finishes', async () => {
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');

    // Songs frequently start past 0 — the intro skip does exactly this — and
    // that offset is what `currentTime` used to collapse back to.
    await clock.start(40);
    audio.ctx.currentTime = 200;
    audio.endPlayback();

    // The play loop finishes on `songTime >= duration`. Reporting 40 here left
    // it convinced the song was still running, so the board froze forever.
    expect(clock.currentTime).toBe(200);
    expect(clock.currentTime).toBeGreaterThanOrEqual(clock.duration);
  });

  it('notifies the listener when playback ends', async () => {
    const audio = fakeAudio(120);
    const clock = await AudioClock.load('/audio.m4a');
    const ended = vi.fn();

    clock.onEnded(ended);
    await clock.start(0);
    audio.endPlayback();

    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('does not fire the ended callback for a deliberate stop', async () => {
    const audio = fakeAudio(120);
    const clock = await AudioClock.load('/audio.m4a');
    const ended = vi.fn();

    clock.onEnded(ended);
    await clock.start(0);
    clock.stop();
    audio.endPlayback();

    // Pausing and restarting both stop the source. Treating that as the song
    // ending would send the player to the results screen mid-run.
    expect(ended).not.toHaveBeenCalled();
  });
});

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
  /** Every gain node built, in construction order. */
  const gains: { gain: { value: number } }[] = [];
  /** Oscillators built by `playTickAt`, with the context time each was scheduled at. */
  const oscillators: { startedAt: number | null; stoppedAt: number | null }[] = [];

  const ctx = {
    currentTime: 0,
    state: 'running' as const,
    destination: {},
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    createAnalyser: () => ({ ...nodes, fftSize: 0, smoothingTimeConstant: 0 }),
    createGain: () => {
      const node = {
        ...nodes,
        gain: {
          value: 1,
          cancelScheduledValues: () => {},
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
        },
      };
      gains.push(node);
      return node;
    },
    createBiquadFilter: () => ({
      ...nodes,
      type: '',
      Q: { value: 0 },
      gain: { value: 0 },
      frequency: {
        value: 0,
        cancelScheduledValues: () => {},
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
      },
    }),
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
    createOscillator: () => {
      const osc = {
        ...nodes,
        frequency: { value: 0 },
        startedAt: null as number | null,
        stoppedAt: null as number | null,
        start(at: number) {
          this.startedAt = at;
        },
        stop(at: number) {
          this.stoppedAt = at;
        },
      };
      oscillators.push(osc);
      return osc;
    },
    createBufferSource: () => {
      const source = {
        ...nodes,
        buffer: null,
        onended: null,
        playbackRate: { value: 1 },
        start: () => {},
        stop: () => {},
      };
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
    oscillators,
    /**
     * Every gain node, so assertions can be made on the graph *behaviourally*
     * rather than by construction order. Indexing positionally was tried and is a
     * trap: adding the mixer buses reordered them and would have silently pointed
     * an existing assertion at the wrong node.
     */
    gains,
    /** How many gains currently sit at a given value. */
    gainsAt: (value: number) => gains.filter((g) => g.gain.value === value).length,
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

  it('advances song time at the playback rate', async () => {
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');
    clock.setRate(1.5);

    await clock.start(0); // no lead-in: audio starts at ctx time 0
    audio.ctx.currentTime = 2; // two real seconds elapse

    // At 1.5x, two real seconds is three song seconds.
    expect(clock.currentTime).toBeCloseTo(3, 5);
    expect(clock.rate).toBe(1.5);
  });

  it('round-trips contextTimeFor against the rate', async () => {
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');
    clock.setRate(0.75);
    await clock.start(10); // starts at song offset 10, audio start at ctx 0

    // A sound scheduled for song time 16 is 6 song-seconds ahead = 8 real
    // seconds at 0.75x.
    expect(clock.contextTimeFor(16)).toBeCloseTo(8, 5);
    void audio;
  });

  it('clamps a nonsense rate to a safe range', async () => {
    await fakeAudio(10);
    const clock = await AudioClock.load('/audio.m4a');
    clock.setRate(0);
    expect(clock.rate).toBe(1);
    clock.setRate(Number.NaN);
    expect(clock.rate).toBe(1);
    clock.setRate(99);
    expect(clock.rate).toBe(4);
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

describe('note ticks', () => {
  it('schedules a tick on the same timeline as the music', async () => {
    // The whole point of prescheduling: a tick for note time T must sound at the
    // moment the *music* for T does, whatever the output latency. Getting this
    // wrong is inaudible on a desktop and ruins the feature on a phone.
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');
    await clock.start(0, 3); // three seconds of lead-in

    clock.playTickAt(clock.contextTimeFor(2));

    expect(audio.oscillators).toHaveLength(1);
    // Audio starts at ctx 3 (the lead-in), so song time 2 is ctx 5.
    expect(audio.oscillators[0]!.startedAt).toBeCloseTo(5, 5);
    // And it stops shortly after, rather than running for the rest of the song.
    expect(audio.oscillators[0]!.stoppedAt).toBeGreaterThan(5);
    expect(audio.oscillators[0]!.stoppedAt! - 5).toBeLessThan(0.2);
  });

  it('follows the rate, so a tick stays on its beat at any speed', async () => {
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');
    clock.setRate(1.5);
    await clock.start(0);

    clock.playTickAt(clock.contextTimeFor(3));
    // Three song-seconds at 1.5x is two real seconds.
    expect(audio.oscillators[0]!.startedAt).toBeCloseTo(2, 5);
  });

  it('never schedules a tick in the past', async () => {
    // A stale window could ask for a time already gone; the Web Audio spec would
    // fire it immediately, which is a click nowhere near a beat.
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');
    await clock.start(0);
    audio.ctx.currentTime = 10;

    clock.playTickAt(clock.contextTimeFor(1)); // ctx time 1, long past
    expect(audio.oscillators[0]!.startedAt).toBe(10);
  });

  it('silences pending ticks when the run pauses, and restores on resume', async () => {
    // `pause` stops the music source but does **not** suspend the context, so
    // ticks already committed to the graph would click on into a paused, silent
    // game. They are muted at the shared bus rather than cancelled one by one.
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');
    await clock.start(0);

    const silencedBefore = audio.gainsAt(0);

    clock.setTicksAudible(false);
    // Exactly one more node went silent — the bus — and not the music with it.
    expect(audio.gainsAt(0)).toBe(silencedBefore + 1);

    clock.setTicksAudible(true);
    expect(audio.gainsAt(0)).toBe(silencedBefore);
  });
});

describe('mixer', () => {
  it('applies music and effect levels independently', async () => {
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');

    clock.setMixer(0.45, 0);
    // Two distinct nodes moved: one to 0.45, one silenced.
    expect(audio.gains.filter((g) => g.gain.value === 0.45)).toHaveLength(1);
    expect(audio.gainsAt(0)).toBe(1);
  });

  it('clamps a nonsense level rather than inverting or blowing up the output', async () => {
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');

    clock.setMixer(Number.NaN, -2);
    // NaN falls back to unity; a negative level clamps to silence rather than
    // flipping the waveform's phase.
    expect(audio.gains.some((g) => Number.isNaN(g.gain.value))).toBe(false);
    expect(audio.gains.every((g) => g.gain.value >= 0)).toBe(true);

    clock.setMixer(9, 9);
    expect(audio.gains.every((g) => g.gain.value <= 1)).toBe(true);
  });

  it('leaves the music level alone when only effects change', async () => {
    const audio = fakeAudio(200);
    const clock = await AudioClock.load('/audio.m4a');

    clock.setMixer(0.7, 1);
    clock.setMixer(0.7, 0.35);
    expect(audio.gains.filter((g) => g.gain.value === 0.7)).toHaveLength(1);
  });
});

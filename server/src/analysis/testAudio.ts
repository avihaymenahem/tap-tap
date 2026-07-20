/**
 * Synthetic audio generators for tests.
 *
 * Ground truth matters here: a click track has an exactly known tempo and
 * exactly known onset times, so the analysis can be asserted against real
 * numbers instead of eyeballed against a song.
 */

export interface ClickTrackOptions {
  bpm: number;
  durationSec: number;
  sampleRate?: number;
  /** Carrier frequency of each click, in Hz. Controls which band it lands in. */
  freqHz?: number;
  /** Exponential decay rate of the click envelope. */
  decay?: number;
}

export function clickTrack({
  bpm,
  durationSec,
  sampleRate = 44100,
  freqHz = 1000,
  decay = 40,
}: ClickTrackOptions): { pcm: Float32Array; sampleRate: number; clickTimes: number[] } {
  const pcm = new Float32Array(Math.floor(durationSec * sampleRate));
  const periodSec = 60 / bpm;
  const clickLen = Math.floor(sampleRate * 0.05);
  const clickTimes: number[] = [];

  for (let t = 0; t < durationSec; t += periodSec) {
    clickTimes.push(t);
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < clickLen && start + i < pcm.length; i++) {
      // Exponential decay times a linear fade to exactly zero at the tail.
      // Without the fade the click is truncated mid-amplitude, and that step
      // discontinuity splatters broadband energy that reads as a second onset.
      const envelope = Math.exp((-decay * i) / sampleRate) * (1 - i / clickLen);
      const sample = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * envelope * 0.8;
      pcm[start + i] = pcm[start + i]! + sample;
    }
  }

  return { pcm, sampleRate, clickTimes };
}

/**
 * A loud constant bass drone with quiet periodic hi-hats on top.
 *
 * Models a bass-heavy master: absolute low-band energy dwarfs the high band at
 * every instant, but the only *events* are the hats. Lane assignment must
 * follow the events, not the loudest band.
 */
export function droneWithHats({
  bpm,
  durationSec,
  sampleRate = 44100,
  droneHz = 60,
  hatHz = 8000,
}: ClickTrackOptions & { droneHz?: number; hatHz?: number }): {
  pcm: Float32Array;
  sampleRate: number;
  hatTimes: number[];
} {
  const pcm = new Float32Array(Math.floor(durationSec * sampleRate));

  // Continuous drone: loud, but never changes, so it produces no onsets.
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.sin((2 * Math.PI * droneHz * i) / sampleRate) * 0.75;
  }

  const periodSec = 60 / bpm;
  const hatLen = Math.floor(sampleRate * 0.04);
  const hatTimes: number[] = [];

  for (let t = 0; t < durationSec; t += periodSec) {
    hatTimes.push(t);
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < hatLen && start + i < pcm.length; i++) {
      const envelope = Math.exp((-90 * i) / sampleRate) * (1 - i / hatLen);
      pcm[start + i] =
        pcm[start + i]! + Math.sin((2 * Math.PI * hatHz * i) / sampleRate) * envelope * 0.22;
    }
  }

  return { pcm, sampleRate, hatTimes };
}

/**
 * Alternating bass and hi-hat hits — kick, hat, kick, hat.
 *
 * The realistic band-discrimination fixture: within one track there are two
 * clearly different kinds of hit, which is exactly the situation lane
 * assignment exists to resolve.
 */
export function alternatingClicks({
  bpm,
  durationSec,
  sampleRate = 44100,
  lowHz = 70,
  highHz = 9000,
}: ClickTrackOptions & { lowHz?: number; highHz?: number }): {
  pcm: Float32Array;
  sampleRate: number;
  lowTimes: number[];
  highTimes: number[];
} {
  const pcm = new Float32Array(Math.floor(durationSec * sampleRate));
  const periodSec = 60 / bpm;
  const lowTimes: number[] = [];
  const highTimes: number[] = [];

  let index = 0;
  for (let t = 0; t < durationSec; t += periodSec, index++) {
    const isLow = index % 2 === 0;
    (isLow ? lowTimes : highTimes).push(t);

    const freq = isLow ? lowHz : highHz;
    // Bass hits ring longer than hats, which is most of what tells them apart.
    const decay = isLow ? 18 : 110;
    const len = Math.floor(sampleRate * (isLow ? 0.22 : 0.05));
    const start = Math.floor(t * sampleRate);

    for (let i = 0; i < len && start + i < pcm.length; i++) {
      const envelope = Math.exp((-decay * i) / sampleRate) * (1 - i / len);
      pcm[start + i] = pcm[start + i]! + Math.sin((2 * Math.PI * freq * i) / sampleRate) * envelope * 0.8;
    }
  }

  return { pcm, sampleRate, lowTimes, highTimes };
}

/**
 * Clicks at deterministic pseudo-random times — audio with plenty of onsets
 * and no tempo at all. The negative fixture for confidence: whatever grid the
 * estimator settles on here is wrong by construction, and confidence must say
 * so. Seeded LCG rather than Math.random so a failure reproduces.
 */
export function irregularClicks({
  durationSec,
  sampleRate = 44100,
  seed = 1,
  freqHz = 1000,
}: {
  durationSec: number;
  sampleRate?: number;
  seed?: number;
  freqHz?: number;
}): { pcm: Float32Array; sampleRate: number; clickTimes: number[] } {
  const pcm = new Float32Array(Math.floor(durationSec * sampleRate));
  const clickLen = Math.floor(sampleRate * 0.05);

  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  // Random inter-click gaps between 150 and 750ms — dense enough to produce a
  // rich onset pool, irregular enough that no periodic grid fits it.
  const clickTimes: number[] = [];
  for (let t = next() * 0.5; t < durationSec; t += 0.15 + next() * 0.6) {
    clickTimes.push(t);
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < clickLen && start + i < pcm.length; i++) {
      const envelope = Math.exp((-40 * i) / sampleRate) * (1 - i / clickLen);
      pcm[start + i] =
        pcm[start + i]! + Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * envelope * 0.8;
    }
  }

  return { pcm, sampleRate, clickTimes };
}

/**
 * A humanized drum groove — kick on 1 and 3, snare on 2 and 4, hats on every
 * eighth with occasional sixteenth fills, every hit jittered by a few
 * milliseconds and varied in level.
 *
 * The realistic *positive* fixture for tempo confidence. Metronome clicks are
 * too easy: no jitter, no off-half-beat content, silence between hits. Real
 * songs failed a confidence calibrated only against clicks — dense activity
 * dilutes beat contrast and sixteenths sit off the half-beat alignment grid —
 * which surfaced as "solid songs read 0.4". Whatever the confidence formula
 * is, this groove must score as trustworthy.
 */
export function drumLoop({
  bpm,
  durationSec,
  sampleRate = 44100,
  seed = 1,
  jitterMs = 10,
}: ClickTrackOptions & { seed?: number; jitterMs?: number }): {
  pcm: Float32Array;
  sampleRate: number;
  beatTimes: number[];
} {
  const pcm = new Float32Array(Math.floor(durationSec * sampleRate));
  const periodSec = 60 / bpm;

  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const jitter = (): number => ((next() * 2 - 1) * jitterMs) / 1000;

  const hit = (t: number, freqHz: number, decay: number, lenSec: number, amp: number): void => {
    const start = Math.floor(t * sampleRate);
    const len = Math.floor(sampleRate * lenSec);
    if (start < 0) return;
    for (let i = 0; i < len && start + i < pcm.length; i++) {
      const envelope = Math.exp((-decay * i) / sampleRate) * (1 - i / len);
      pcm[start + i] =
        pcm[start + i]! + Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * envelope * amp;
    }
  };

  const beatTimes: number[] = [];
  for (let beat = 0; beat * periodSec < durationSec; beat++) {
    const t = beat * periodSec;
    beatTimes.push(t);

    if (beat % 2 === 0) hit(t + jitter(), 55, 22, 0.24, 0.85 + next() * 0.15); // kick
    else hit(t + jitter(), 190, 55, 0.16, 0.65 + next() * 0.15); // snare body

    // Hats on both eighths, quieter and shorter.
    hit(t + jitter(), 8200, 110, 0.05, 0.24 + next() * 0.08);
    hit(t + periodSec / 2 + jitter(), 8200, 110, 0.05, 0.2 + next() * 0.08);

    // Occasional sixteenth fills — content genuinely off the half-beat grid.
    if (next() < 0.35) hit(t + periodSec / 4 + jitter(), 8200, 130, 0.04, 0.16 + next() * 0.06);
    if (next() < 0.2) hit(t + (3 * periodSec) / 4 + jitter(), 8200, 130, 0.04, 0.14 + next() * 0.06);
  }

  return { pcm, sampleRate, beatTimes };
}

/**
 * Clicks whose tempo ramps smoothly between two BPMs — a human drummer, not a
 * click track. No constant grid can fit this: extrapolating one tempo from
 * either end drifts by whole beats. The fixture that justifies tracking beats
 * through the song instead of extrapolating a single (period, phase).
 */
export function tempoRamp({
  fromBpm,
  toBpm,
  durationSec,
  sampleRate = 44100,
  freqHz = 1000,
}: {
  fromBpm: number;
  toBpm: number;
  durationSec: number;
  sampleRate?: number;
  freqHz?: number;
}): { pcm: Float32Array; sampleRate: number; clickTimes: number[] } {
  const pcm = new Float32Array(Math.floor(durationSec * sampleRate));
  const clickLen = Math.floor(sampleRate * 0.05);
  const clickTimes: number[] = [];

  let t = 0;
  while (t < durationSec) {
    clickTimes.push(t);
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < clickLen && start + i < pcm.length; i++) {
      const envelope = Math.exp((-40 * i) / sampleRate) * (1 - i / clickLen);
      pcm[start + i] =
        pcm[start + i]! + Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * envelope * 0.8;
    }
    const bpm = fromBpm + (toBpm - fromBpm) * (t / durationSec);
    t += 60 / bpm;
  }

  return { pcm, sampleRate, clickTimes };
}

/** A steady sine, used to check FFT bin placement. */
export function sine(freqHz: number, durationSec: number, sampleRate = 44100): Float32Array {
  const pcm = new Float32Array(Math.floor(durationSec * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return pcm;
}

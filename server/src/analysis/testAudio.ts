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

/** A steady sine, used to check FFT bin placement. */
export function sine(freqHz: number, durationSec: number, sampleRate = 44100): Float32Array {
  const pcm = new Float32Array(Math.floor(durationSec * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return pcm;
}

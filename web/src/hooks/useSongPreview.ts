import { useEffect, useRef } from 'react';

/**
 * Menu song previews — a short clip of a track when you select it.
 *
 * One reused `HTMLAudioElement`, which *streams and seeks* rather than decoding
 * the whole file the way `AudioClock` does — exactly right for a 15s taste that
 * the player has not committed to. Robust by construction: every failure path
 * (offline, autoplay refusal, a stale load finishing after a newer selection) is
 * swallowed, because a preview that does not play must never look like a bug.
 */

export const PREVIEW_SEC = 15;
const TARGET_VOLUME = 0.9;
const FADE_MS = 450;
const FADE_STEPS = 12;

/**
 * Where a preview starts — a fraction into the song so it clears the intro and
 * lands somewhere with a hook, clamped so a short track still gets a full clip.
 * Pure, so it is unit-tested.
 */
export function previewStartSec(duration: number): number {
  if (!(duration > 0)) return 0;
  const hook = duration * 0.28;
  return Math.max(0, Math.min(hook, Math.max(0, duration - PREVIEW_SEC)));
}

export interface SongPreview {
  /** Start a preview of `url` from `startSec`. Replaces any current preview. */
  play(url: string, startSec: number): void;
  /** Stop and silence immediately. Safe to call when nothing is playing. */
  stop(): void;
}

const clampVol = (v: number): number => Math.max(0, Math.min(1, v));

export function useSongPreview(): SongPreview {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fadeRef = useRef<number | null>(null);
  const endRef = useRef<number | null>(null);
  // Bumped on every play()/stop(); a load or timer from an older token is ignored.
  const tokenRef = useRef(0);

  const clearTimers = (): void => {
    if (fadeRef.current !== null) {
      clearInterval(fadeRef.current);
      fadeRef.current = null;
    }
    if (endRef.current !== null) {
      clearTimeout(endRef.current);
      endRef.current = null;
    }
  };

  const fade = (audio: HTMLAudioElement, to: number, done?: () => void): void => {
    if (fadeRef.current !== null) clearInterval(fadeRef.current);
    const from = audio.volume;
    const step = (to - from) / FADE_STEPS;
    let i = 0;
    fadeRef.current = window.setInterval(() => {
      i += 1;
      audio.volume = clampVol(from + step * i);
      if (i >= FADE_STEPS) {
        if (fadeRef.current !== null) clearInterval(fadeRef.current);
        fadeRef.current = null;
        audio.volume = clampVol(to);
        done?.();
      }
    }, FADE_MS / FADE_STEPS);
  };

  const stop = (): void => {
    tokenRef.current += 1;
    clearTimers();
    const audio = audioRef.current;
    if (audio) audio.pause();
  };

  const play = (url: string, startSec: number): void => {
    stop();
    const token = tokenRef.current;

    if (!audioRef.current) {
      const el = new Audio();
      el.preload = 'metadata';
      audioRef.current = el;
    }
    const audio = audioRef.current;
    audio.volume = 0;
    audio.src = url;

    const onReady = (): void => {
      audio.removeEventListener('loadedmetadata', onReady);
      if (token !== tokenRef.current) return; // superseded before it loaded
      try {
        audio.currentTime = startSec;
      } catch {
        // Seeking before enough is buffered can throw; the clip just starts early.
      }
      void audio
        .play()
        .then(() => {
          if (token !== tokenRef.current) return; // stopped while play() resolved
          fade(audio, TARGET_VOLUME);
          endRef.current = window.setTimeout(() => {
            fade(audio, 0, () => audio.pause());
          }, PREVIEW_SEC * 1000);
        })
        .catch(() => {
          // Offline+uncached, or an autoplay refusal — leave it silent.
        });
    };

    audio.addEventListener('loadedmetadata', onReady);
    audio.load();
  };

  // Never let a preview outlive the menu.
  useEffect(() => {
    return () => {
      stop();
      audioRef.current?.removeAttribute('src');
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { play, stop };
}

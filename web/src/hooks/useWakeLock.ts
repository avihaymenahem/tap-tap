import { useEffect } from 'react';

/**
 * Hold a screen wake lock while the component is mounted.
 *
 * A rhythm game can run for minutes with no touch or keyboard input on a phone,
 * which is exactly the pattern that trips the idle screen timeout — the display
 * dims or sleeps mid-song.
 *
 * The lock is released automatically by the browser whenever the tab is hidden,
 * so it has to be re-acquired on `visibilitychange` rather than requested once.
 * Unsupported browsers and rejected requests are ignored: this is a nicety, and
 * nothing about the game should fail without it.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async (): Promise<void> => {
      if (released || document.visibilityState !== 'visible') return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        // Denied, unsupported, or the document lost visibility mid-request.
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release().catch(() => {
        // Already released by the browser; nothing to do.
      });
      sentinel = null;
    };
  }, [active]);
}

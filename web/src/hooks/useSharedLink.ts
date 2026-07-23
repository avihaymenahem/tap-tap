import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { takeSharedUrl } from '../plugins/share.js';

/**
 * Deliver a YouTube link shared into the app to `onShared`.
 *
 * Checks once on mount — a cold start launched by the share sheet — and again on
 * every resume, which is a warm start where a share arrived while the app was
 * already open (Android delivers it through `onNewIntent`, and the foreground
 * transition fires a resume). Native-only; a no-op in a plain browser, and every
 * failure is swallowed so a missing plugin never breaks startup.
 */
export function useSharedLink(onShared: (url: string) => void): void {
  const handlerRef = useRef(onShared);
  handlerRef.current = onShared;

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let disposed = false;
    const check = (): void => {
      void takeSharedUrl().then((url) => {
        if (url && !disposed) handlerRef.current(url);
      });
    };

    check(); // cold start

    let remove: (() => void) | undefined;
    void CapacitorApp.addListener('resume', check).then((handle) => {
      remove = () => void handle.remove();
    });

    return () => {
      disposed = true;
      remove?.();
    };
  }, []);
}

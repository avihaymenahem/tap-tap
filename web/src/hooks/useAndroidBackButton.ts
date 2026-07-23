import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';

/**
 * Wire the Android hardware back button to a route-aware handler.
 *
 * Plain `history.back()` is wrong for a game: the history stack can leave the
 * player one tap away from a finished run's results, or back inside the run they
 * just left. So `App` decides where back goes for the *current* screen — always
 * a stable parent, never a transient play/results screen — and returns whether
 * it navigated. Returning false means "nowhere left to go", and the app exits.
 *
 * The listener is registered once and reads the handler through a ref, so a
 * re-render (every navigation changes `route`) does not thrash the native
 * listener. A no-op off-device — a plain browser has its own back button.
 */
export function useAndroidBackButton(onBack: () => boolean): void {
  const handlerRef = useRef(onBack);
  handlerRef.current = onBack;

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let remove: (() => void) | undefined;
    void CapacitorApp.addListener('backButton', () => {
      if (!handlerRef.current()) void CapacitorApp.exitApp();
    }).then((handle) => {
      remove = () => void handle.remove();
    });

    return () => remove?.();
  }, []);
}

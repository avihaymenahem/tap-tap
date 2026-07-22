import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the built web app as a native Android package (PLAN.md §6h).
 *
 * `webDir` is the Vite production build — the app ships bundled, not pointed at
 * a dev server, so it runs with no server of any kind. Android-only for now;
 * desktop and the Express server are being retired (MD1).
 */
const config: CapacitorConfig = {
  appId: 'com.taptap.game',
  appName: 'Tap-Tap',
  webDir: 'web/dist',
  android: {
    // The game is dark end to end; a white flash between splash and first paint
    // reads as a bug on a phone.
    backgroundColor: '#07030f',
  },
};

export default config;

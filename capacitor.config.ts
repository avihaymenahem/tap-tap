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
  // For an emulator/device smoke test before MB2's local storage exists, point at
  // the host dev server so the WebView has a real library:
  //   server: { url: 'http://10.0.2.2:5173', cleartext: true }
  // (10.0.2.2 is the emulator's host alias). Verified working this way — the full
  // highway renders and audio plays on an Android WebView. Kept OUT of the
  // committed config so a real build stays bundled.
};

export default config;

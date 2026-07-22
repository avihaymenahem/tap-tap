import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { loadServerConfig } from './api/serverConfig.js';
import { isNativePlatform, seedIfEmpty } from './data/index.js';
import { registerServiceWorker } from './pwa.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
const root = createRoot(container);

/**
 * Boot sequence. Split from a bare chain because the native app has one extra
 * step — seeding the on-device library — and because the service worker is a
 * browser-only concern: in the Capacitor shell there is no server to be offline
 * from, and a cache-first worker in front of the `convertFileSrc` file URLs would
 * only get in the way.
 *
 * Not a top-level await: that forces a build target above the browsers this game
 * supports, and Vite only rejects it at build time.
 */
async function boot(): Promise<void> {
  if (isNativePlatform()) {
    // Populate the library from bundled assets the first time it is empty, so a
    // fresh install is not a blank menu. No-op once the user has any song.
    await seedIfEmpty();
  } else {
    registerServiceWorker();
  }

  // Resolved before the first render so screens can read the config
  // synchronously (no effect, no loading flash of a maybe-dead Admin button).
  await loadServerConfig();

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();

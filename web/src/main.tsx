import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { loadServerConfig } from './api/serverConfig.js';
import { registerServiceWorker } from './pwa.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// Resolved before the first render so screens can read the config
// synchronously. Chained rather than awaited at the top level: top-level await
// forces a build target above the browsers this game already supports, and Vite
// only rejects it at build time, so the dev server happily hides the problem.
// Not awaited with the config: offline support is not a prerequisite for
// rendering, and the registration itself waits for `load` anyway.
registerServiceWorker();

void loadServerConfig().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

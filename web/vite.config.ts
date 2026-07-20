import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Compile the shared workspace from source. Without this, Vite resolves
      // it through the node_modules symlink and refuses to transform the TS.
      '@tap-tap/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // Vite rejects requests whose Host header it does not recognize, which
    // otherwise turns a tunnelled URL into a blank "host not allowed" page.
    // Scoped to known providers rather than `true` so this does not become a
    // blanket opt-out of that protection.
    //
    // `.ts.net` is the Tailscale MagicDNS suffix. A phone reaching the dev
    // server by tailnet IP is fine without it — bare IPs pass the host check —
    // but `https://espired.tail6485dc.ts.net` would be rejected, and that is
    // the hostname Wake Lock needs, since it requires HTTPS.
    allowedHosts: ['.ts.net', '.trycloudflare.com', '.loca.lt', '.ngrok-free.app', '.ngrok.io'],
    // Expose on the LAN so a phone can load the game. Vite prints the Network
    // URL on startup; the /api and /media proxies below still resolve
    // server-side, so the phone never needs to know the backend port.
    host: true,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/media': { target: SERVER, changeOrigin: true },
    },
  },
  build: {
    // three.js and its postprocessing addons are inherently large; this keeps
    // the build output quiet rather than warning on every run.
    chunkSizeWarningLimit: 1200,
  },
});

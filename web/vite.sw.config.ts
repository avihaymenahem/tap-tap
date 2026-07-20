import { defineConfig } from 'vite';

/**
 * Second build pass, for the service worker only.
 *
 * It needs its own config because the worker has requirements the app build
 * cannot satisfy:
 *
 *  - **Its filename must be stable and at the root.** A worker's scope is
 *    limited by its own path, so `/assets/sw-a1b2c3.js` could only control
 *    `/assets/`. Content hashing is exactly wrong here.
 *  - **It must not be an ES module.** `registration({ type: 'module' })` is
 *    still not universally supported, so this emits an IIFE.
 *
 * Putting the file in `public/` instead would satisfy both and cost the type
 * checking — `public/` is copied verbatim, so it would have to be hand-written
 * JavaScript, which this project does not do.
 *
 * Runs after the app build and must not clear the directory (`emptyOutDir`).
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    // No modulepreload polyfill and no code splitting: a worker is one file.
    modulePreload: false,
    target: 'es2020',
    rollupOptions: {
      input: 'src/sw.ts',
      output: {
        format: 'iife',
        entryFileNames: 'sw.js',
        inlineDynamicImports: true,
      },
    },
  },
});

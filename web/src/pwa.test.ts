import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEDIA_CACHE } from './pwa.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const swSource = readFileSync(path.join(here, 'sw.ts'), 'utf8');

/**
 * The worker is compiled as a separate program — it needs the WebWorker lib,
 * which cannot share a program with DOM — so it cannot export anything the app
 * can import. These constants are therefore written twice, and the compiler
 * cannot tell when they drift.
 *
 * Drift here fails silently in the worst way: the worker keeps caching audio
 * under one name while the page queries another, so every song reports as
 * unavailable offline while offline play actually works fine. Asserting against
 * the worker's source is ugly, and much less ugly than that bug.
 */
describe('service worker constants', () => {
  it('agrees with the page about the media cache name', () => {
    const match = /const MEDIA_CACHE = '([^']+)'/.exec(swSource);
    expect(match?.[1], 'MEDIA_CACHE not found in sw.ts').toBeDefined();
    expect(match?.[1]).toBe(MEDIA_CACHE);
  });

  it('keeps the media cache out of the versioned names', () => {
    // The media cache must not carry VERSION, or bumping the app version makes
    // every player re-download every track they had offline.
    expect(MEDIA_CACHE).not.toMatch(/v\d+$/);
    expect(swSource).toMatch(/const MEDIA_CACHE = '[^']*'/);
    expect(swSource).not.toMatch(/MEDIA_CACHE = `[^`]*\$\{VERSION\}/);
  });

  it('keeps the media cache in the activate keep-set', () => {
    // Cleanup deletes every `tap-tap-` cache not in KEEP. Dropping MEDIA_CACHE
    // from that set would wipe the offline library on the next app update.
    const keep = /const KEEP = new Set\(\[([^\]]+)\]\)/.exec(swSource)?.[1] ?? '';
    expect(keep).toContain('MEDIA_CACHE');
  });

  it('never intercepts non-GET requests', () => {
    // Ingest, rename, delete and theme writes must fail honestly when offline
    // rather than being served or queued from a cache.
    expect(swSource).toMatch(/request\.method !== 'GET'/);
  });
});

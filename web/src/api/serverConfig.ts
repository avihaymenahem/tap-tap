/**
 * Server capabilities, resolved once before the app renders.
 *
 * Read-only mode is a property of the server, not of this session, so it cannot
 * change while the page is open. Fetching it at boot and holding it in a module
 * lets screens read it synchronously during render — no effect, no loading
 * state, no flash of an Admin button that turns out to be dead.
 */

import { getConfig } from '../data/index.js';

let readOnly = false;

/** Called from `main.tsx` before the first render. */
export async function loadServerConfig(): Promise<void> {
  try {
    ({ readOnly } = await getConfig());
  } catch {
    // An older server has no /api/config. Assume full access: this only ever
    // runs against a server the player reached directly, and guessing wrong
    // hides features rather than exposing them — the server is the real guard.
    readOnly = false;
  }
}

export function isReadOnly(): boolean {
  return readOnly;
}

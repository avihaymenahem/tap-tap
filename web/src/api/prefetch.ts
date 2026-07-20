/**
 * Warm the browser's HTTP cache with a song's audio.
 *
 * A song cannot start until its whole file has downloaded — `decodeAudioData`
 * needs a complete buffer — and over a slow link that is a long stare at a
 * spinner. But a player spends several seconds picking a difficulty first, and
 * that time is free. Starting the fetch on selection means the play screen's
 * request is often served from cache instead of the network.
 *
 * This is a cache warm, not a download manager: the response is deliberately
 * dropped on the floor. Holding decoded audio here would duplicate what
 * `AudioClock` already owns, and several songs' worth is tens of megabytes.
 */

/** Songs already requested this session, so browsing back and forth is free. */
const warmed = new Set<string>();

export function prefetchAudio(url: string | undefined): void {
  // A server older than this client omits `audioUrl`. Without this guard the
  // fetch would resolve against the SPA fallback and quietly pull index.html
  // on every hover — wasted bytes that look like nothing is wrong.
  if (!url) return;
  if (warmed.has(url)) return;
  warmed.add(url);

  // `low` keeps this behind anything the current screen actually needs; the
  // player has not committed to this song yet.
  void fetch(url, { priority: 'low' } as RequestInit).catch(() => {
    // A failed warm is not an error worth surfacing — the play screen will
    // fetch it again for real and report properly if it is genuinely broken.
    // Forget it so a later attempt can retry.
    warmed.delete(url);
  });
}

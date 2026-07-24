/**
 * Tidy a raw YouTube title (and uploader) into a song title + artist.
 *
 * YouTube music titles are noisy: promotional tags like "(Official Music
 * Video)", "[HD]", "| Lyrics", resolution/quality junk, and uploader names that
 * end in "VEVO" or "- Topic". This strips the reliably-removable cruft while
 * staying conservative — anything that carries meaning (Remix, Live, Acoustic,
 * "feat. …") is kept, because a wrong strip is worse than a leftover tag.
 *
 * Pure and unit-tested; ingest wires it in over the native metadata.
 */

/**
 * Words that mark a bracketed group or a separator-delimited segment as
 * promotional noise. A group is dropped only when *every* meaningful token in
 * it is junk, so "(Official Video)" goes but "(Live at Wembley)" and
 * "(feat. Someone)" stay.
 */
const JUNK_WORDS = new Set([
  'official',
  'video',
  'videos',
  'audio',
  'music',
  'lyric',
  'lyrics',
  'lyrical',
  'visualizer',
  'visualiser',
  'visual',
  'mv',
  'hd',
  'hq',
  'uhd',
  'explicit',
  'clip',
  'vevo',
  'full',
  'remaster',
  'remastered',
  'monstercat',
  'ncs',
  'release',
  'promo',
]);

/** Filler that never blocks a group from being considered junk. */
const FILLER_WORDS = new Set(['the', 'a', 'an', 'with', 'in', 'and', 'of', 'on', 'at', 'by']);

function isJunkToken(tok: string): boolean {
  if (JUNK_WORDS.has(tok)) return true;
  // Resolutions and frame rates: 4k, 8k, 1080p, 720p, 60fps.
  return /^\d+k$/.test(tok) || /^\d{3,4}p$/.test(tok) || /^\d+fps$/.test(tok);
}

/**
 * True if a chunk of text is entirely promotional — every word is junk or
 * filler (or a bare number, e.g. a "Remastered 2011" year), with at least one
 * genuine junk word present. Empty chunks count as junk so "()" is dropped.
 */
function isJunkChunk(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  let sawJunk = false;
  for (const tok of tokens) {
    if (/^\d+$/.test(tok) || FILLER_WORDS.has(tok)) continue; // neutral
    if (isJunkToken(tok)) {
      sawJunk = true;
      continue;
    }
    return false; // a real, meaningful word — keep the chunk
  }
  return sawJunk;
}

function collapse(s: string): string {
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** Strip surrounding matched quotes and leftover edge separators/dots. */
function trimEdges(s: string): string {
  let out = collapse(s);
  out = out.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '');
  out = out.replace(/^[\s\-–—|·•.]+|[\s\-–—|·•.]+$/g, '');
  return collapse(out);
}

/** Clean an uploader into a plausible artist: drop VEVO / "- Topic" / "Official". */
function cleanUploader(uploader: string): string {
  return collapse(
    uploader
      .replace(/\s*[-–—]\s*topic\s*$/i, '')
      .replace(/vevo\s*$/i, '')
      .replace(/\bofficial\b/gi, ''),
  );
}

export interface CleanMeta {
  title: string;
  artist: string;
}

/**
 * Sanitize `rawTitle` and derive an artist, preferring an "Artist - Title"
 * split in the title over the uploader name (the YouTube-music convention),
 * falling back to a cleaned uploader otherwise. Never returns an empty title —
 * if cleaning would erase everything, the trimmed original is used.
 */
export function cleanTrackMeta(rawTitle: string, uploader = ''): CleanMeta {
  const fallbackArtist = cleanUploader(uploader);
  const original = collapse(rawTitle);

  // 1. Drop bracketed junk groups: (…), […], {…}. Keep meaningful ones.
  let text = original.replace(/[([{]\s*([^)\]}]*?)\s*[)\]}]/g, (m, inner: string) =>
    isJunkChunk(inner) ? ' ' : m,
  );

  // 2. Pipe/•/· often separate title from a promo segment ("Song | Lyrics") or
  //    join artist and title ("Artist | Song"). Keep the non-junk segments and
  //    rejoin with a dash so the split below can read artist/title from them.
  const segments = text
    .split(/\s*[|•·]\s*/)
    .map((s) => s.trim())
    .filter((s) => s && !isJunkChunk(s));
  text = segments.join(' - ');

  // 3. Split on dashes into artist/title parts, drop any junk-only parts
  //    ("Song - Official Video" → "Song"), then read the convention: first part
  //    is the artist when two or more real parts remain.
  const parts = text
    .split(/\s+[-–—]\s+/)
    .map(trimEdges)
    .filter((p) => p && !isJunkChunk(p));

  let title: string;
  let artist: string;
  if (parts.length >= 2) {
    artist = parts[0];
    title = parts.slice(1).join(' - ');
  } else {
    title = parts[0] ?? '';
    artist = fallbackArtist;
  }

  title = trimEdges(title);
  if (!title) {
    // Cleaning erased everything (e.g. the whole title was one junk chunk) —
    // fall back to the raw title rather than shipping a blank name.
    title = trimEdges(original) || original;
    artist = fallbackArtist;
  }
  return { title, artist };
}

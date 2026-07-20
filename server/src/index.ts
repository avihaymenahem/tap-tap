import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Beatmap,
  type Theme,
  isBuiltinTheme,
  isThemeId,
  themeCatalog,
  themeErrors,
  validateTheme,
} from '@tap-tap/shared';
import cors from 'cors';
import express from 'express';
import { computeWaveform } from './analysis/waveform.js';
import { decodeToMonoPcm } from './ingest/transcode.js';
import { ingestSong, regenerateCharts } from './ingest/pipeline.js';
import { extractVideoId } from './ingest/ytdlp.js';
import { clearFinishedJobs, createJob, getJob, listJobs, setJobStatus, updateJob } from './jobs.js';
import {
  AUDIO_FILE,
  MEDIA_DIR,
  deleteSong,
  listBeatmaps,
  loadAnalysis,
  loadCustomThemes,
  saveCustomThemes,
  loadBeatmap,
  loadWaveform,
  saveBeatmap,
  saveWaveform,
  songDir,
  toSummary,
} from './storage.js';

// Deliberately not `PORT`: this runs alongside Vite under one `npm run dev`,
// and a generic PORT in the environment gets applied to both, so whichever
// binds first steals the other's port.
const PORT = Number(process.env['TAP_TAP_SERVER_PORT'] ?? 8787);

/**
 * Read-only mode, for when the server is reachable by someone other than you.
 *
 * Every mutating endpoint here is unauthenticated, which is fine on localhost
 * and catastrophic through a tunnel: anyone holding the URL could wipe the
 * library or make this machine download arbitrary videos. Rather than bolt on
 * an auth system for a temporary demo, this turns the whole write surface off.
 *
 * Deliberately fails closed — anything other than an explicit "0"/"false"/unset
 * counts as public, so a typo in the env var cannot silently expose writes.
 *
 * The `--public` flag is the same switch by another name: it survives being run
 * through npm scripts on any platform, where exporting an env var does not.
 */
const PUBLIC_MODE =
  process.argv.includes('--public') ||
  !['', '0', 'false', undefined].includes(process.env['TAP_TAP_PUBLIC']);

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

// Ahead of every route, so a new endpoint is covered without being remembered.
app.use((req, res, next) => {
  if (!PUBLIC_MODE || req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }
  res.status(403).json({ error: 'This server is running in read-only mode.' });
});

/** Lets the UI hide what it cannot use, instead of showing buttons that 403. */
app.get('/api/config', (_req, res) => {
  res.json({ readOnly: PUBLIC_MODE });
});

// Audio is served with range support so the browser can seek without
// re-fetching the whole file.
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1h', acceptRanges: true }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// --- songs -----------------------------------------------------------------

app.get('/api/songs', async (_req, res) => {
  const beatmaps = await listBeatmaps();
  res.json(beatmaps.map(toSummary));
});

app.get('/api/songs/:songId', async (req, res) => {
  const beatmap = await loadBeatmap(req.params.songId);
  if (!beatmap) {
    res.status(404).json({ error: 'Song not found' });
    return;
  }
  res.json(beatmap);
});

// --- editor data -----------------------------------------------------------

/** The full onset pool, including candidates the generator rejected. */
app.get('/api/songs/:songId/analysis', async (req, res) => {
  const analysis = await loadAnalysis(req.params.songId);
  if (!analysis) {
    res.status(404).json({ error: 'No analysis for this song' });
    return;
  }
  res.json(analysis);
});

app.get('/api/songs/:songId/waveform', async (req, res) => {
  const songId = req.params.songId;
  const cached = await loadWaveform(songId);
  if (cached) {
    res.json(cached);
    return;
  }

  // Older songs were ingested before waveforms were cached; build it on demand
  // rather than forcing a full re-ingest just to open the editor.
  const beatmap = await loadBeatmap(songId);
  if (!beatmap) {
    res.status(404).json({ error: 'Song not found' });
    return;
  }

  try {
    const pcm = await decodeToMonoPcm(path.join(songDir(songId), AUDIO_FILE), 44100);
    const waveform = computeWaveform(pcm, 44100);
    await saveWaveform(songId, waveform);
    res.json(waveform);
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.patch('/api/songs/:songId', async (req, res) => {
  const beatmap = await loadBeatmap(req.params.songId);
  if (!beatmap) {
    res.status(404).json({ error: 'Song not found' });
    return;
  }

  const rawTitle: unknown = req.body?.title;
  const rawArtist: unknown = req.body?.artist;
  const rawTheme: unknown = req.body?.themeId;

  const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 200) : beatmap.title;
  const artist = typeof rawArtist === 'string' ? rawArtist.trim().slice(0, 200) : beatmap.artist;

  if (title.length === 0) {
    res.status(400).json({ error: 'Title cannot be empty' });
    return;
  }

  // Rejected rather than stored. An unrecognised id that gets persisted is a
  // song that renders default forever with nothing in the UI to explain why —
  // the dropdown would show no selection and the game would look untouched.
  // Validated against built-ins *plus* whatever custom themes exist right now,
  // so a song can be assigned a theme the admin just created.
  if (rawTheme !== undefined && !isThemeId(themeCatalog(await loadCustomThemes()), rawTheme)) {
    res.status(400).json({ error: `Unknown theme: ${String(rawTheme)}` });
    return;
  }

  // `customName` keeps a re-ingest from reverting this to the YouTube metadata —
  // but only when a name was actually sent. This route used to exist solely for
  // rename, so the flag was unconditional; now that a theme-only PATCH is a
  // normal thing to do, setting it here would freeze the title of every song
  // whose colours were changed, and the revert would only surface at re-ingest.
  const renamed = typeof rawTitle === 'string' || typeof rawArtist === 'string';

  const updated: Beatmap = {
    ...beatmap,
    title,
    artist,
    ...(renamed || beatmap.customName ? { customName: true } : {}),
    ...(rawTheme === undefined ? {} : { themeId: rawTheme }),
  };
  await saveBeatmap(updated);
  res.json(toSummary(updated));
});

app.delete('/api/songs/:songId', async (req, res) => {
  const removed = await deleteSong(req.params.songId);
  res.status(removed ? 200 : 404).json({ removed });
});

app.post('/api/songs/:songId/regenerate', async (req, res) => {
  try {
    const beatmap = await regenerateCharts(req.params.songId);
    res.json(toSummary(beatmap));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

// --- themes ----------------------------------------------------------------

/**
 * Custom themes only. The built-ins are compiled into `shared/`, so the client
 * already has them and shipping them over the wire would just create a second
 * copy that could disagree.
 */
app.get('/api/themes', async (_req, res) => {
  res.json(await loadCustomThemes());
});

/**
 * Parse a theme from a request body.
 *
 * Returns null rather than throwing on a malformed shape — `validateTheme`
 * handles *bad* values with useful messages, but it takes a `Theme`, so
 * something that is not even theme-shaped has to be rejected before it.
 */
function parseTheme(body: unknown): Theme | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') return null;
  if (!Array.isArray(raw['lanes']) || typeof raw['hitLine'] !== 'number') return null;
  if (typeof raw['sky'] !== 'object' || raw['sky'] === null) return null;

  return {
    id: raw['id'].trim(),
    name: raw['name'].trim().slice(0, 60),
    lanes: raw['lanes'] as number[],
    hitLine: raw['hitLine'],
    sky: raw['sky'] as Theme['sky'],
  };
}

function problemResponse(problems: ReturnType<typeof validateTheme>): { error: string; problems: typeof problems } {
  const errors = themeErrors(problems);
  return { error: errors[0]?.message ?? 'Invalid theme', problems };
}

app.post('/api/themes', async (req, res) => {
  const theme = parseTheme(req.body);
  if (!theme) {
    res.status(400).json({ error: 'Not a theme' });
    return;
  }

  const existing = await loadCustomThemes();
  // The catalogue is passed so a duplicate id is caught here rather than
  // silently shadowing — `themeCatalog` would drop the newcomer and the user
  // would see their theme "save" and then not exist.
  const problems = validateTheme(theme, existing);
  if (themeErrors(problems).length > 0) {
    res.status(400).json(problemResponse(problems));
    return;
  }

  await saveCustomThemes([...existing, theme]);
  res.status(201).json(theme);
});

app.put('/api/themes/:themeId', async (req, res) => {
  const { themeId } = req.params;
  if (isBuiltinTheme(themeId)) {
    res.status(403).json({ error: `“${themeId}” is a built-in theme and cannot be edited.` });
    return;
  }

  const theme = parseTheme(req.body);
  if (!theme) {
    res.status(400).json({ error: 'Not a theme' });
    return;
  }
  if (theme.id !== themeId) {
    // Renaming an id would orphan every song pointing at the old one, silently
    // reverting them to the default. Duplicate-and-delete is the honest way to
    // do it, and it makes the consequence visible.
    res.status(400).json({ error: 'A theme’s id cannot be changed once it exists.' });
    return;
  }

  const existing = await loadCustomThemes();
  const index = existing.findIndex((candidate) => candidate.id === themeId);
  if (index === -1) {
    res.status(404).json({ error: 'Theme not found' });
    return;
  }

  // Validated against the catalogue *minus itself*, or its own id would read as
  // a collision with itself.
  const others = existing.filter((_, i) => i !== index);
  const problems = validateTheme(theme, others);
  if (themeErrors(problems).length > 0) {
    res.status(400).json(problemResponse(problems));
    return;
  }

  const updated = [...existing];
  updated[index] = theme;
  await saveCustomThemes(updated);
  res.json(theme);
});

app.delete('/api/themes/:themeId', async (req, res) => {
  const { themeId } = req.params;
  if (isBuiltinTheme(themeId)) {
    res.status(403).json({ error: `“${themeId}” is a built-in theme and cannot be deleted.` });
    return;
  }

  const existing = await loadCustomThemes();
  const remaining = existing.filter((theme) => theme.id !== themeId);
  if (remaining.length === existing.length) {
    res.status(404).json({ removed: false });
    return;
  }

  // Songs keep the dead `themeId`. `themeFor` resolves anything unknown to the
  // default, so they render as they did before a theme was chosen — deliberately
  // not a cascade, which would rewrite every beatmap to undo one delete.
  await saveCustomThemes(remaining);
  const songsAffected = (await listBeatmaps()).filter((map) => map.themeId === themeId).length;
  res.json({ removed: true, songsAffected });
});

// --- ingest ----------------------------------------------------------------

app.post('/api/ingest', (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!extractVideoId(url)) {
    res.status(400).json({ error: 'Not a recognizable YouTube URL or video id' });
    return;
  }

  const job = createJob(url);
  res.status(202).json(job);

  // Fire and forget: the client polls /api/jobs/:id for progress.
  void ingestSong(url, (status, msg) => setJobStatus(job.id, status, msg))
    .then((beatmap) => {
      updateJob(job.id, { status: 'done', message: `Ready — ${beatmap.bpm} BPM`, songId: beatmap.songId });
    })
    .catch((error: unknown) => {
      updateJob(job.id, { status: 'error', message: 'Failed', error: message(error) });
    });
});

app.get('/api/jobs', (_req, res) => {
  res.json(listJobs());
});

/**
 * Drop finished jobs. Anything still running is kept — see `clearFinishedJobs`.
 *
 * A write, so read-only mode blocks it like every other mutation.
 */
app.delete('/api/jobs/finished', (_req, res) => {
  res.json({ removed: clearFinishedJobs() });
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

// --- built frontend --------------------------------------------------------

/**
 * Serve `web/dist` when it exists, so the whole game is one origin on one port.
 *
 * In development Vite serves the frontend and proxies here, and this block does
 * nothing. It matters when the server is reached through a tunnel: Vite's dev
 * server ships the app as hundreds of unbundled ES modules, and a tunnel drops
 * enough of those requests that the app never finishes booting. A production
 * build is a couple of files, so it survives the trip.
 *
 * Registered after the API routes so it can never shadow them.
 */
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

/**
 * `--no-web` is passed by `npm run dev`, where Vite serves the frontend.
 *
 * Without it a stale `web/dist` keeps being served on this port alongside the
 * live Vite app on 5173 — two URLs for the same game, one of them frozen at
 * whenever it was last built. That is a genuinely confusing way to lose an hour
 * wondering why edits do not show up.
 */
const SERVE_WEB = !process.argv.includes('--no-web');

if (SERVE_WEB && existsSync(WEB_DIST)) {
  // Hashed asset filenames make them safe to cache hard; index.html must not be.
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1y' }));

  // The router is hand-rolled over the History API, so a deep link like
  // /play/abc/hard is a real URL the server has to answer with the app shell.
  app.get(/^(?!\/(api|media)\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Bind all interfaces so phones on the same network can reach it. This does
// expose the server to your LAN — fine on a home network, not on a shared one.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`tap-tap server on http://localhost:${PORT}`);
  for (const address of lanAddresses()) {
    console.log(`                  http://${address}:${PORT}`);
  }
  console.log(`media: ${MEDIA_DIR}`);
  console.log(
    SERVE_WEB && existsSync(WEB_DIST) ? `web:   ${WEB_DIST}` : 'web:   served by Vite on :5173',
  );
  if (PUBLIC_MODE) console.log('READ-ONLY: ingest, rename, delete and regenerate are disabled.');
});

/** Non-internal IPv4 addresses, for connecting from another device. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) out.push(address.address);
    }
  }
  return out;
}

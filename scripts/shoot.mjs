/*
 * Headless screenshot harness — the eyes for the AAA visual-critique loop.
 *
 * Usage:
 *   node scripts/shoot.mjs --state=play --out=shots/play.png
 *   node scripts/shoot.mjs --state=menu --out=a.png --port=9444 --url=http://localhost:5174
 *
 * Every knob that could collide between concurrent runs is a flag (--port, --out,
 * --profile, --url) so N critic agents can each drive their own Chrome against
 * their own Vite without stepping on each other. That is the whole reason this
 * exists rather than using the Browser pane, which is one shared surface per
 * session and wedges after a handful of WebGL contexts.
 *
 * WebGL under headless needs SwiftShader explicitly (--enable-unsafe-swiftshader
 * since Chrome 125-ish, or the context creation silently fails and the highway
 * screenshots come back as a black canvas that reads like a rendering bug).
 *
 * States are reached by driving the REAL controls with trusted CDP touch events,
 * not by pushing history: PlayScreen's AudioContext unlock requires a trusted
 * gesture, and the router's canonicalising effect reverts a pushState (the trap
 * measure-runstart.mjs already documents).
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);

const STATE = args.state ?? 'menu';
const OUT = resolve(args.out ?? `shots/${STATE}.png`);
const PORT = Number(args.port ?? 9333);
const URL_BASE = args.url ?? 'http://localhost:5173';
const W = Number(args.w ?? 390);
const H = Number(args.h ?? 844);
const DPR = Number(args.dpr ?? 3);
const SONG = args.song ? String(args.song) : null;
const DIFFICULTY = args.difficulty ? String(args.difficulty) : null;
const PLAY_WAIT = Number(args.wait ?? 9000);
/*
 * `--progress=<0..1>` — hold the capture until the song reaches a given fraction
 * of its length, instead of a fixed `--wait`.
 *
 * This exists because the HOLD-NOTE beam had never once been photographed. Holds
 * are 10-20% of a chart and cluster where the music sustains, so four fixed-wait
 * captures in a row can (and did) all land on plain taps. `--wait` cannot fix
 * that reliably: it is wall-clock from the moment the run starts, and the run
 * starts after a loading phase whose length depends on download and decode, so
 * the same `--wait` lands on a different bar every time.
 *
 * The song's own progress rail (`.hud__rail-fill`, written from the audio clock
 * every frame by PlayScreen) is the one signal already on the page that maps to
 * song time, so we poll its width rather than adding a debug hook to PlayScreen.
 * Work out the target from the beatmap: `progress = (holdTime - lead) / duration`
 * for the hold you want, with ~0.4s of lead so the head is still on the highway
 * and the whole beam is in frame.
 */
const PROGRESS = args.progress != null ? Number(args.progress) : null;
const KEEP = !!args.keep;
const VERBOSE = !!args.verbose;
/*
 * Frame-timing mode. A still cannot show "movement feels sluggish", so --probe=frames
 * samples the page's own rAF deltas for --probeMs after reaching the state.
 *
 * It implies --gpu, and that is the whole point: the default capture path runs
 * SwiftShader (software raster), whose frame times say nothing about how the real
 * app feels. --gpu drops the SwiftShader flags so Chrome uses the actual GPU. Check
 * the reported `renderer` — if it still says SwiftShader, the numbers are worthless
 * and you must re-run with --headful.
 */
const PROBE = args.probe ? String(args.probe) : null;
const PROBE_MS = Number(args.probeMs ?? 8000);
/*
 * GPU is the DEFAULT. SwiftShader was the original choice for reproducibility, but
 * software-rasterising a bloom-composited WebGL scene made every capture take the
 * better part of a minute, and the critique loop runs dozens of them. The real GPU
 * is both faster and more representative. --software opts back out if a machine
 * has no usable GPU.
 */
const GPU = !args.software;
const HEADFUL = !!args.headful;

const CHROME =
  args.chrome ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => existsSync(p));

if (!CHROME) {
  console.error('shoot: no Chrome/Edge binary found; pass --chrome=<path>');
  process.exit(2);
}

const PROFILE = resolve(args.profile ?? `${tmpdir()}/shoot-profile-${PORT}`);
const log = (...m) => VERBOSE && console.error('[shoot]', ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- chrome ---- */

await rm(PROFILE, { recursive: true, force: true });
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    ...(HEADFUL ? ['--window-position=-2400,-2400'] : ['--headless=new']),
    '--hide-scrollbars',
    '--mute-audio',
    // WebGL: SwiftShader (software) is the default because it renders identically
    // everywhere and stills only need correct pixels. --gpu drops it for the real
    // GPU, which is mandatory for any timing measurement.
    ...(GPU ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    // The play screen must be reachable without a real finger.
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore' },
);

const cleanup = async () => {
  try { chrome.kill('SIGKILL'); } catch {}
  if (!KEEP) await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
};
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

/* ------------------------------------------------------------------- cdp ---- */

async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('CDP target never appeared');
}

const wsUrl = await findTarget();
log('cdp', wsUrl);
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text}`);
  return r.result?.value ?? null;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: DPR, mobile: true,
  screenOrientation: { angle: 0, type: 'portraitPrimary' },
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

/*
 * Seed device state BEFORE any app JS runs. A fresh Chrome profile is a
 * first-run player, so App redirects every route to /tutorial and every
 * selector below times out — that cost the first run of this harness.
 * addScriptToEvaluateOnNewDocument lands ahead of the bundle; setting
 * localStorage after navigate is already too late.
 */
const seed = { 'tap-tap.tutorialSeen': 'true' };
if (args.quality) seed['tap-tap.quality'] = JSON.stringify(String(args.quality));
if (args.calibration) seed['tap-tap.calibration'] = String(args.calibration);
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{${Object.entries(seed)
    .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`)
    .join('')}}catch(e){}`,
});

/* --------------------------------------------------------------- helpers ---- */

async function tap(x, y) {
  const pt = [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(70);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Centre of the first visible match, optionally filtered by text. */
async function locate(selector, textMatch = null, nth = 0) {
  const expr = `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      ${textMatch ? `if (!/${textMatch}/i.test(el.textContent || '')) return false;` : ''}
      return true;
    });
    const el = els[${nth}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                            text: (el.textContent || '').trim().slice(0, 30) });
  })()`;
  const raw = await evaluate(expr);
  return raw ? JSON.parse(raw) : null;
}

async function waitFor(selector, { timeout = 20000, textMatch = null } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = await locate(selector, textMatch);
    if (hit) return hit;
    await sleep(180);
  }
  throw new Error(`timeout waiting for ${selector}${textMatch ? ` /${textMatch}/` : ''}`);
}

async function tapSelector(selector, opts = {}) {
  const hit = await waitFor(selector, opts);
  log('tap', selector, JSON.stringify(hit));
  await tap(hit.x, hit.y);
  return hit;
}

async function goto(path) {
  await send('Page.navigate', { url: `${URL_BASE}${path}` });
  // #root having children is the signal React mounted; load alone fires too early.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await evaluate(`!!document.querySelector('#root')?.children.length`)) return;
    await sleep(150);
  }
  throw new Error('app never mounted');
}

/* ---------------------------------------------------------------- states ---- */

async function toMenu() {
  await goto('/');
  await waitFor('.song-row');
  await sleep(1400); // let .rise stagger settle so the shot is the resting state
}

async function toHero() {
  await toMenu();
  if (SONG) {
    /*
     * SCROLL IT INTO VIEW FIRST. `locate` returns a viewport-relative centre and
     * `tap` dispatches a touch at that point, so a song below the fold resolved
     * to a y outside the viewport and the tap landed on nothing — the run then
     * failed much later with "timeout waiting for .song-hero__play", which reads
     * like a broken hero rather than a missed row. Only the top handful of the
     * library was reachable by name before this, which matters because the song
     * you need is the one with an early HOLD in it, not the one that sorts first.
     */
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('.song-card__title')]
        .find((e) => /${SONG.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}/i.test(e.textContent || ''));
      if (el) el.scrollIntoView({ block: 'center' });
      return !!el;
    })()`);
    await sleep(700); // the list scrolls smoothly; a rect read mid-scroll is stale
    const hit = await locate('.song-card__title', SONG);
    if (!hit) throw new Error(`song not found: ${SONG}`);
    await tap(hit.x, hit.y);
  } else {
    await tapSelector('.song-row');
  }
  await waitFor('.song-hero__play');
  if (DIFFICULTY) await tapSelector('.difficulty__name', { textMatch: DIFFICULTY }).catch(() => {});
  await sleep(1600); // hero-in + aura spin-up
}

/**
 * Wait out `loading`, then land on whichever of the two the app chooses.
 * The run AUTO-STARTS when the hero's PLAY tap unlocked the AudioContext, so
 * `.btn--start` is only the fallback path (replay / deep link). Waiting for it
 * unconditionally times out even though the game is running fine behind the
 * overlay — that cost the first play capture.
 */
async function settleAfterPlayTap({ timeout = 90000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locate('.hud-chip')) return 'playing';
    if (await locate('.btn--start')) return 'ready';
    if (await locate('.error-text')) {
      throw new Error(`play failed: ${(await locate('.error-text')).text}`);
    }
    await sleep(200);
  }
  throw new Error('neither playing nor ready after PLAY tap');
}

async function toReady() {
  await toHero();
  await tapSelector('.song-hero__play');
  const where = await settleAfterPlayTap();
  if (where === 'playing') log('auto-started; no ready overlay to shoot');
  await sleep(900);
}

async function toPlay() {
  await toHero();
  await tapSelector('.song-hero__play');
  /*
   * Poll rather than settle-then-act. The ready overlay is racy: it can be up
   * when we look and gone a moment later once the auto-start fires, so a
   * settle() that returns 'ready' followed by a tapSelector() times out on a
   * game that is already running fine. Re-checking each pass absorbs that.
   */
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await locate('.hud-chip')) break;
    const start = await locate('.btn--start');
    if (start) await tap(start.x, start.y);
    const err = await locate('.error-text');
    if (err) throw new Error(`play failed: ${err.text}`);
    await sleep(250);
  }
  if (!(await locate('.hud-chip'))) throw new Error('never reached the playing state');
  if (PROGRESS != null) {
    await waitForProgress(PROGRESS);
    return;
  }
  await sleep(PLAY_WAIT); // clear the countdown and get notes onto the highway
}

/**
 * Block until the song progress rail reaches `target` (0..1). See --progress.
 *
 * Polled tight (40ms) because the rail is the only clock we can see and the
 * window a note is in a given place is a few hundred milliseconds. The rail's
 * width is a percentage string written by PlayScreen's render loop, so reading
 * it costs one CDP round-trip and no page work.
 */
async function waitForProgress(target, { timeout = 180000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = 0;
  while (Date.now() < deadline) {
    const raw = await evaluate(
      `(() => { const el = document.querySelector('.hud__rail-fill');
                return el ? parseFloat(el.style.width) : null; })()`,
    );
    if (raw == null) throw new Error('progress rail gone; is the run still playing?');
    last = raw / 100;
    if (last >= target) {
      log('progress', last.toFixed(4), '>=', target);
      return;
    }
    await sleep(40);
  }
  throw new Error(`timeout waiting for progress ${target} (reached ${last.toFixed(4)})`);
}

async function toResults() {
  await toPlay();
  // Fast-forward rather than sitting through a song: quit posts no result, so
  // drive the clock instead if the app exposes it, else play on and time out.
  const jumped = await evaluate(`(() => {
    const w = window; if (!w.__tapTapDebug?.jumpToEnd) return false;
    w.__tapTapDebug.jumpToEnd(); return true;
  })()`);
  if (!jumped) {
    log('no debug hook; results state needs a full run — capturing play instead');
  }
  await waitFor('.results', { timeout: 30000 }).catch(() => {});
  await sleep(1200);
}

async function toSettings() {
  await goto('/settings');
  await waitFor('.setting-row');
  await sleep(900);
}

const STATES = {
  menu: toMenu, hero: toHero, ready: toReady, play: toPlay,
  results: toResults, settings: toSettings,
};

/* ------------------------------------------------------------------ shoot ---- */

let code = 0;
try {
  const run = STATES[STATE];
  if (!run) throw new Error(`unknown state '${STATE}'; have ${Object.keys(STATES).join(', ')}`);
  await run();

  const consoleErrors = events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '?').join(' '))
    .slice(0, 8);

  /*
   * Prove we are on the state we were asked for, BEFORE capturing.
   *
   * `canvas: "ok"` only says a WebGL context is alive; it stayed "ok" on a
   * "Could not start / Internal Server Error" screen, and that frame went to a
   * reviewer as if it were gameplay. A screenshot harness that cannot tell a
   * crash from a playfield poisons every judgement downstream, so this is a hard
   * failure rather than a warning.
   */
  const EXPECT = {
    menu: '.song-row', hero: '.song-hero__play', ready: '.play__canvas',
    play: '.hud-chip', results: '.results', settings: '.setting-row',
  };
  const want = EXPECT[STATE];
  if (want && !(await locate(want))) {
    throw new Error(`state '${STATE}' not on screen: '${want}' missing at capture time`);
  }
  const onError = await locate('.error-text');
  if (onError) throw new Error(`error screen at capture time: ${onError.text}`);

  // Which GL is actually behind the canvas. Reported on every run because a
  // timing number from SwiftShader is worse than no number — it looks like a
  // measurement and describes nothing the player will ever experience.
  const renderer = await evaluate(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'no-webgl';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  })()`);

  if (PROBE === 'frames') {
    /*
     * Sample the page's own rAF cadence. This is what the render loop actually
     * gets — it is deliberately not a compositor metric, because the complaint is
     * about how the notes move, and the loop is what moves them.
     */
    await evaluate(`(() => {
      window.__ft = { d: [], last: 0, stop: false };
      const tick = (t) => {
        if (window.__ft.stop) return;
        if (window.__ft.last) window.__ft.d.push(t - window.__ft.last);
        window.__ft.last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })()`);
    await sleep(PROBE_MS);
    const stats = await evaluate(`(() => {
      const f = window.__ft; f.stop = true;
      const d = f.d.slice(1).sort((a, b) => a - b);
      if (!d.length) return null;
      const q = (p) => d[Math.min(d.length - 1, Math.floor(d.length * p))];
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      // Jank as the player feels it: a frame that overran two refreshes at all,
      // and the variance around the median, which is what reads as "stutter"
      // even when the average is fine.
      const med = q(0.5);
      const jank = d.filter((x) => x > med * 1.9).length;
      const bad = d.filter((x) => x > 33).length;
      return JSON.stringify({
        frames: d.length, fps: +(1000 / mean).toFixed(1),
        p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2),
        max: +d[d.length - 1].toFixed(2),
        jankFrames: jank, jankPct: +(100 * jank / d.length).toFixed(2),
        over33ms: bad,
      });
    })()`);
    console.log(JSON.stringify({ ok: true, state: STATE, probe: 'frames', renderer,
                                 software: /swiftshader|llvmpipe|software/i.test(String(renderer)),
                                 windowMs: PROBE_MS, stats: stats ? JSON.parse(stats) : null }, null, 2));
    await cleanup();
    process.exit(0);
  }

  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, Buffer.from(data, 'base64'));

  // A black WebGL canvas is the classic silent failure; report it rather than
  // handing a critic an empty frame to review.
  const canvasAlive = await evaluate(`(() => {
    const c = document.querySelector('canvas'); if (!c) return 'no-canvas';
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return gl ? (gl.isContextLost() ? 'context-lost' : 'ok') : 'no-context';
  })()`);

  console.log(JSON.stringify({ ok: true, state: STATE, out: OUT, canvas: canvasAlive,
                               viewport: `${W}x${H}@${DPR}`, consoleErrors }, null, 2));
} catch (err) {
  code = 1;
  console.log(JSON.stringify({ ok: false, state: STATE, error: String(err?.message ?? err) }, null, 2));
} finally {
  await cleanup();
}
process.exit(code);

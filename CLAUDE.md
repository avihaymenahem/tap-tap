# CLAUDE.md

Working notes for agents on this repo. **Read `PLAN.md` too** — it holds the
architecture, the reasoning behind every non-obvious decision, and a progress
log. This file is the operational layer: how to run things, what must not be
broken, and the traps that have already cost time.

## What this is

A browser rhythm game. An admin pastes a YouTube link; the server downloads the
audio, analyses it, and generates note charts at three difficulties. Players
pick from the curated list and play on 3/4/5 lanes.

**Local-only. Do not deploy it.** `yt-dlp` against YouTube breaks their ToS;
that is a non-issue on `localhost` and a real problem the moment it is public.

## Commands

```bash
npm run dev                    # server :8787 + web :5173 — USE THIS. Live reload.
npm test                       # vitest, all workspaces
npx tsc -b                     # typecheck the project graph
npm run build                  # production web build — app, then the service worker
npm run icons                  # regenerate PWA icons (only when the art changes)
npm run serve:public           # build + serve everything from :8787. USE THIS to
                               #   test offline/PWA; the worker is prod-only.
npm run ingest -w server -- "<youtube-url>"   # ingest one song from the CLI
```

The Browser pane tools (`preview_start`, then `navigate`/`computer`) are the way
to run and verify the app. `.claude/launch.json` already defines the dev server.

**Develop on :5173, not :8787.** `serve:public` builds the frontend and serves it
from Express, which is right for sharing and wrong for working: it has no HMR, so
every edit needs a rebuild and the page silently keeps showing the last build.
This cost real time once. `npm run dev` passes `--no-web` so the server refuses
to serve a stale `web/dist` alongside the live Vite app — without that flag both
ports serve the game and one of them is frozen.

## Running it in Docker

For keeping it up without starting it by hand — `restart: unless-stopped` brings
it back after a crash or a reboot. **Still local-only**; the ToS note above does
not stop applying because it is in a container.

```bash
docker compose up -d --build     # start
docker compose logs -f           # watch
docker compose down              # stop. The volume and its songs survive.
```

It serves the **production build on :8787**, the same as `npm run serve:public`
— which is also the only mode where the service worker exists, so the PWA and
offline play work here and do not under `npm run dev`.

- **Develop with `npm run dev`, not the container.** There is no HMR inside it
  and every change needs a rebuild.
- **:8787 collides with `npm run dev`'s API server.** Windows Docker does not
  reliably refuse the bind — it publishes anyway and the host routes to
  whichever process got there first. The tell is the container "serving" a 404
  at `/`, which is really the dev server answering with `--no-web`. Stop one, or
  republish the container on another port.
- **Everything persistent is one directory**, so one volume covers it: audio,
  thumbnails, beatmaps, cached analysis, waveforms and `themes.json` all live
  under `MEDIA_DIR`, which the image points at `/data`.
- **Seeding the volume needs a `chown`.** `docker cp` writes as root, the app
  runs as `node`; skip it and reads work while every write silently 403s. The
  commands are in `docker-compose.yml`.
- **The image needs Python** — `youtube-dl-exec` refuses to install without a
  binary named exactly `python` (not `python3`), and yt-dlp needs it at runtime.
  Both stages install `python-is-python3`. Debian slim, **not Alpine**:
  `ffmpeg-static` ships glibc builds that install fine on musl and then fail to
  exec.
- `node_modules` is in `.dockerignore` for a reason beyond size — the vendored
  `ffmpeg.exe` and `yt-dlp.exe` here are Windows binaries.

## Letting someone else play it

**Tailscale is the answer, and it is already installed and signed in** on this
machine (`espired`, 100.82.104.20). The phone `avihays-s25-ultra` is already on
the tailnet too — it just needs the app toggled on.

```
http://100.82.104.20:5173       # while `npm run dev` is running
http://100.82.104.20:8787       # only under `npm run serve:public`
```

**Which port depends on which server is up**, and getting this wrong looks like
a broken tailnet. `npm run dev` passes `--no-web`, so :8787 serves the API only
and its root returns **404** — that is the flag working, not a connectivity
problem. Use :5173 in dev; use :8787 when serving the production build. Both
bind all interfaces already (`app.listen(PORT, '0.0.0.0')` and Vite's
`host: true`); verified reachable on the tailnet IP.

Vite's `allowedHosts` includes `.ts.net`, so the MagicDNS name works as well as
the bare IP. Bare IPs pass Vite's host check without being listed; hostnames do
not, so `https://espired.tail6485dc.ts.net` would otherwise render a blank
"host not allowed" page.

No firewall rule needed: Tailscale bypasses the inbound block that stopped LAN
access, because the connection arrives on the Tailscale interface. For a friend,
share the single machine from the admin console rather than adding them to the
tailnet.

For HTTPS — which **Wake Lock requires**, so the screen still sleeps without it —
enable MagicDNS and HTTPS Certificates in the Tailscale admin console, then
`tailscale serve --bg 8787` and use `https://espired.tail6485dc.ts.net`. The two
console toggles are account settings and are a human step.

### Public tunnels: only if Tailscale is not an option

`scripts/share.sh` drives a pinggy tunnel and still works, but it is the fallback
now. Measured here: pinggy ~29 Mbps / 60-minute sessions / one-click gate;
localtunnel ~1 Mbps / ~4-minute sessions, and it silently reconnects onto a
*random* subdomain, invalidating a link already sent. **Cloudflare quick tunnels
never routed from this machine at all** — four attempts including
`--edge-ip-version 4`; do not spend time on it again without a new hypothesis.
Both working providers expose the host's public IP.

Two rules if you do tunnel:

- **Serve the production build** (`npm run serve:public`), never the dev server.
  Vite dev ships hundreds of unbundled ES modules and a tunnel drops enough of
  them that the page stays blank with no console error.
- **Turn on read-only mode** (`--public` / `TAP_TAP_PUBLIC=1`). Ingest, rename,
  delete and regenerate have **no auth at all**; the flag rejects every non-GET
  before it reaches a route and makes the UI hide Admin. It fails closed. Verify
  with `curl <url>/api/config` before sharing. Currently **off** — admin is
  deliberately enabled for local use.

**Song load time.** The whole m4a must download before play can start —
`decodeAudioData` needs a complete buffer, and the sample-accurate clock depends
on playing a decoded `AudioBuffer`. **If this feels slow, suspect the tunnel
before the code**: the same 4.7MB file took 30s on localtunnel and 1.4s on
pinggy (29 Mbps). Two mitigations exist, neither of which changes the
architecture:

- The menu calls `prefetchAudio` on hover and on selection, so the download runs
  while the player picks a difficulty. The play screen then reads from the HTTP
  cache (`transferSize: 0`) instead of the network.
- `AudioClock.load` streams the body and reports progress, so the wait shows a
  real percentage rather than an indefinite spinner.

Streaming playback (`<audio>` + `MediaElementAudioSourceNode`) would cut
time-to-first-note but is **not** a free win: it trades a predictable wait for
mid-song stalls, and a stall desyncs every note from the audio until it is
re-anchored. In a rhythm game that is a worse failure than waiting. Do not
attempt it to save 20 seconds on a link that is already unreliable.

Close the tunnel when done. It serves full copyrighted tracks from `/media` to
anyone with the URL — see the ToS note above.

## Offline / PWA

Installable, and songs already played stay playable with no server. Cache-on-use
throughout — nothing is precached but the app shell, because the library is ~28
tracks of ~5MB and precaching would mean a 125MB first visit.

**It requires a secure context, and your phone's current URL is not one.**
Measured, not assumed: `http://localhost:5173` reports `isSecureContext: true`,
`http://100.82.104.20:5173` reports **false** with `navigator.serviceWorker`
undefined. So on the tailnet IP there is no service worker, no install prompt
and no offline — the game still runs, it just has none of this. The fix is the
same two Tailscale console toggles Wake Lock already needs (MagicDNS + HTTPS
Certificates), then `tailscale serve --bg 8787` and the `.ts.net` hostname.

**It only exists in production builds.** `registerServiceWorker` is a no-op
under `import.meta.env.DEV`, and `sw.js` is only emitted by `npm run build`.
Putting a cache-first worker in front of Vite's unbundled dev graph would serve
stale modules and reproduce the "my change did nothing" confusion HMR already
causes here. **Test offline against `npm run serve:public`, never `npm run dev`.**

```
web/src/sw.ts            the worker: four fetch rules and a cleanup pass
web/src/pwa.ts           the page's side — registration and cache queries
web/vite.sw.config.ts    second build pass; the worker cannot be hashed or ESM
web/tsconfig.sw.json     its own program: WebWorker lib cannot coexist with DOM
scripts/make-icons.ts    generates the PNG icons; `npm run icons`
```

- **Three caches, and only two are versioned.** `tap-tap-media` has no version in
  its name **on purpose** — bumping `VERSION` in `sw.ts` must not cost the player
  a re-download of every offline track. It is also in the `KEEP` set that
  `activate` cleans against. `pwa.test.ts` asserts both, plus that the name still
  matches the copy in `pwa.ts` — the two files cannot import from each other, so
  drift is possible and would silently report every song as unavailable offline
  while offline play kept working.
- **Non-GET requests are never intercepted.** Ingest, rename, delete and theme
  writes must fail honestly offline rather than appear to succeed from a cache.
- **Navigations are network-first**, so a running server always wins — including
  when it answers 404. That is what stops a worker registered by a previous
  `serve:public` session from serving a cached app at `:8787` during `npm run
  dev`, where that root is *supposed* to 404.
- Ranged requests are passed straight through: a 206 cannot be `cache.put`.
  Nothing issues one today because audio is fetched whole for `decodeAudioData`,
  but a `<audio>` element added later would.
- The icons are hand-encoded PNGs (`zlib` + a CRC, no image dependency) and are
  committed. Re-run `npm run icons` only if the art changes.

## Layout

```
shared/src/     wire contract: beatmap, difficulty params, keymaps, themes
server/src/
  analysis/     FFT, spectral-flux onsets, tempo, waveform  (+ synthetic-audio tests)
  charts/       lane assignment, difficulty filters, note selection
  ingest/       yt-dlp, ffmpeg, pipeline
  storage.ts    beatmaps, cached analysis, waveforms, custom themes
  index.ts      Express API on :8787
web/src/
  game/         PURE TS — clock, judge, engine, calibration, run types (unit tested)
  editor/       PURE TS — timeline coordinate math (unit tested)
  render/       three.js highway + palette helpers
  components/   RetroBackdrop (the shared 80s sunset), toggles, row menus,
                ThemePicker, ThemePreview (a live Highway)
  hooks/        useWakeLock, useOffline
  screens/      menu, play, results, calibration, admin, themes, editor
  router.ts     hand-rolled typed router over the History API
  sw.ts         service worker — separate program, see the Offline section
  pwa.ts        registration + offline-cache queries
scripts/
  make-icons.ts hand-rolled PNG encoder for the PWA icons
  share.sh      pinggy tunnel (fallback; Tailscale is the answer)
```

## Invariants — do not break these

- **`shared/` is the single source of truth** for anything crossing the wire.
  Never redeclare a beatmap type in `web/` or `server/`.
- **`web/src/game/` and `web/src/editor/` import no three.js, no React, no DOM.**
  That is what makes them testable. Rendering reads state; it never owns it.
- **`AudioContext.currentTime` is the master clock.** Never `setTimeout`,
  `setInterval`, or accumulated frame deltas for anything the player can hear or
  feel. `requestAnimationFrame` drives rendering only.
- **`laneCount` is a parameter, never a constant.** Difficulty determines it
  (3/4/5). Anything that hardcodes 3 is a bug.
- **The server binds `TAP_TAP_SERVER_PORT`, not `PORT`.** It runs alongside Vite
  under one `npm run dev`; a generic `PORT` in the environment gets applied to
  both and one steals the other's port.
- **Analysis decodes `audio.m4a`** — the file the browser plays — not the
  original download. AAC priming delay means analysing the source times every
  note against audio nobody hears.
- **Snapping to the beat grid is conservative** (only when the grid already
  agrees, capped at 30ms). The onsets are ground truth; the grid is an estimate
  that drifts. See PLAN.md §2.2.
- **`customName`, `customChart` and `themeId` protect hand edits.** Ingest
  refetches YouTube metadata and Regenerate rebuilds charts; both must respect
  these rather than silently discarding work. **Anything new that admin can set
  by hand joins this list** — `regenerateCharts` spreads the existing beatmap so
  it inherits new fields for free, but `ingestSong` builds a fresh one and will
  drop them silently.
- **Colours crossing the wire are sRGB hex; shader colours are linear.** A theme
  stores hex, and `skyColor`/`THREE.Color` linearize at the shader boundary. Do
  not "simplify" by storing linear values in `shared/`: linear 0.001 does not
  survive 8 bits per channel, and no one can tune a palette against tone-mapped
  linear numbers.
- **Every theme needs >= 5 *distinguishable* lane colours.** Five is hard —
  `laneColor` indexes by lane and hard difficulty uses five, so a short palette
  wraps and gives two lanes the same colour. Distinguishable is the part that is
  easy to get wrong: a themed palette wants hues that share a mood, and lanes
  that share a mood are lanes the player cannot tell apart at speed. The sky
  carries a theme's identity; the lanes carry its readability. `theme.test.ts`
  enforces count and uniqueness, but only an eye catches "too similar".

## Traps that have already cost time

**Shell**
- `cmd | tail` returns *tail's* exit code. Always `set -o pipefail` before
  piping a build or test command, or you will report a failing build as passing.

**Browser tooling**
- The Browser pane wedges after many tabs — each WebGL context counts. Close
  tabs with `tabs_close`, or restart the preview. If `navigate` starts failing,
  that is usually why.
- Vite HMR can leave a stale module graph after renaming exports; the page then
  shows old behaviour with confusing console errors. Open a fresh tab.
- **Shader edits need a full reload, not HMR.** Materials are built in the
  `Highway` constructor, so an HMR update leaves the existing instance compiled
  from the old source. Editing a shader and screenshotting without reloading
  shows the *previous* values and reads as "my change did nothing".
- **The user often has the app open in the same browser.** If a page navigates
  unexpectedly mid-verification, that is probably them. Do not fight for control.

**CSS / the shell's 80s backdrop**
- `RetroBackdrop` is **one fixed layer rendered once in `App`**, not per screen.
  A screen that paints its own background hides it — that is why `.menu` and
  `.results` no longer have one. New screens need `position: relative; z-index: 1`
  or they render *under* the sunset.
- **`--horizon` is the single knob.** Sky gradient, sun, horizon line and grid all
  key off it. Change it, not the four of them.
- It is deliberately at 78%, not the poster's 50%: at poster height the sun lands
  behind the song list and reads as a smudge. Details and the rest of the
  reasoning are in PLAN.md §6e.
- - **`body` is `overflow: hidden`, so a full-height screen must scroll itself.**
  That rule is right — the play screen must never scroll — but it means nothing
  above a screen can rescue content taller than the viewport. Any centred card
  screen (`.results`, `.calibration`) needs `overflow-y: auto` of its own.
- **Centre an over-tall card with `margin: auto`, never `align-items: center`.**
  Flex centring crops an oversized child at *both* ends and puts its top above
  the scroll origin, where no amount of scrolling reaches it. The results card
  measured `top: -12px` on a 375x812 phone: not clipped, genuinely unreachable.
  `margin: auto` on the child centres identically and still lets the start edge
  be scrolled to. Check with `getBoundingClientRect().top < 0`, which tells you
  this instantly and looks like ordinary clipping otherwise.
- **`backdrop-filter` creates a stacking context, and that traps z-index.** The
  admin row menu opened *behind* the rows below it despite `z-index: 20`. Every
  `.admin-song` has `backdrop-filter: blur(8px)`, so each row is its own stacking
  context and the menu's z-index only ordered it *within* its row — later
  siblings simply painted after. Raising the number does nothing; the fix is to
  lift the row itself (`.admin-song:has(.dropdown)`). Any translucent panel that
  needs to overflow its own bounds has this problem. Diagnose it with
  `document.elementFromPoint` inside the overflowing element rather than by
  eye — it names the element actually on top.

**Translucent panels make transparent form fields a bug.** The sunset showed
  *inside* the search box. Inputs are dark and opaque on purpose; don't
  "simplify" them back to `rgba(255,255,255,0.05)`.
- The sun is hidden under 560px and dimmed on admin. Both are deliberate — it
  reads as a nub or a blob otherwise.

**three.js**
- **Backdrop coordinates: measure, do not derive.** The sky plane is 200x120 at
  world y=8, so `uv.y = 0.5 + (worldY - 8) / 120`. But the on-screen horizon is
  **not** eye level in that space — the track's far edge sits at `uv.y ≈ 0.414`,
  because the highway geometry stops at z=-29 rather than running to infinity.
  Sizing a sun from the plane's dimensions produced one that filled the frame,
  and assuming the horizon was at eye level (0.485) left it hanging in the sky.
  Both were fixed by striping the shader every 0.05 of `uv.y`, screenshotting,
  and reading the mapping off the picture.
- **The ground grid must stop short of the backdrop.** The sky plane sits at
  z=-40 with `depthWrite: false`, so it occludes nothing — any geometry running
  behind it is drawn *over* the sun. `GROUND_LENGTH` is sized to fade out well
  in front of it.
- The ground uses its own lift loop, **not `bendToCurve`**: that also applies
  `curveWidth`, which tapers the *track*. Pulling the ground's far edges in with
  it leaves the sky showing through wedges either side of the horizon.
- **Grid brightness is the trap the colour warning below is about.** The first
  pass used linear 0.42 pink and came out near-white, burying the lanes. It sits
  at 0.15 now. Anything on the ground plane is scenery and must lose to the
  notes.
- The far end of the track is far too narrow to occlude anything, so a sun has
  to be **clipped in the shader** (`step(HORIZON, vUv.y)`) to read as setting.
  Nothing in the scene will hide it for you.
- **There is no fisheye any more, and do not re-add one as a post-process.** A
  barrel-distortion `ShaderPass` was built, tuned and then removed: a full-screen
  pass bends *every* pixel, so the sky and the drifting star field curved along
  with the track, and it cropped the top of the sky — which is what made the
  retro sun impossible to place for three attempts. If the lens is ever wanted
  again it has to be per-vertex on the highway meshes only, and each of those
  meshes needs enough segments to bend.
- **Tap-to-lane must go through `Highway.laneAtScreenPoint`.** Lanes are not
  evenly spaced across the canvas — perspective converges them — so splitting the
  width into equal columns puts the outer lanes a *whole lane* off. The renderer
  projects the receptors and takes the nearest. Anything needing a lane from a
  screen position must ask it rather than do arithmetic. This bug predated the
  lens; the lens only made it obvious.
- **The highway is also curved *and* tapered in 3D.** Anything drawn on the track
  must offset its Y by `curveLift(z)` and scale its X by `curveWidth(z)`, or it
  floats off the surface as the track climbs and hangs off the edge as the track
  narrows. Tapering the floor's vertices rather than its shader keeps the UVs
  intact, so lane tints and beat rungs follow for free.
  Flat things (the note halos) also need `rotation.x = atan(curveSlope(z))` to
  lie along the slope instead of shearing through it. `CURVE_HEIGHT` is the one
  knob; past the camera height (6.2) the far end reaches eye level and folds
  over itself.
- Bending a plane needs segments. `PlaneGeometry(w, h)` is a single quad and
  stays flat however you move its vertices.
- The floor's `rotation.x = -PI/2` maps local **+Y to world −Z** and local **+Z
  to world +Y**, so vertex lift is written into local Z and a vertex's world z
  is `meshZ - localY`. Getting that backwards tilts the track sideways and
  looks like a broken camera rather than a bad curve.
- `InstancedMesh` per-instance colour comes from `instanceColor` (`setColorAt`).
  Setting `vertexColors: true` makes the shader look for a per-vertex attribute
  that is not there, and everything renders black.
- Scene fog applies to `MeshBasicMaterial`. Notes need `fog: false` or they fade
  to nothing before the player ever sees them.
- A shader uniform array must match its GLSL declared length exactly. A shorter
  array throws inside `composer.render()` — which kills the rAF loop **with no
  console error**, leaving a black screen and no clue.
- Colours in shaders are *linear*. ACES tone mapping plus sRGB lifts midtones
  hard; anything that looks reasonable as a hex value reads as a washed-out haze.
- `rotation.z = PI` on a plane mirrors **both** axes. It silently reversed the
  floor's lane tints once.

**Timing**
- **`AudioClock.currentTime` falls back to `startOffset` when not playing.** When
  a song reaches its natural end, `onended` therefore has to park the playhead at
  `buffer.duration`, or the clock reports a time near the *start* — and the play
  loop, which finishes on `songTime >= duration`, decides the song is still
  running and freezes on a finished board. This froze real runs. `clock.test.ts`
  fakes Web Audio to cover it, because the only way to see it live is to sit
  through an entire song.
- The play loop samples once per frame, so the end can fall between two frames.
  `clock.onEnded` is wired to `finish()` as the signal that cannot be missed;
  `finish()` guards against running twice so whichever fires first wins.
- `HIT_WINDOWS` are the forgiveness knobs and get retuned by feel. Write tests
  *relative* to them, never with literal deltas — literals silently land on a
  boundary when the windows move, which is exactly how the tier tests broke.
- **"Feels offbeat" on a phone but fine on a desktop is output latency, not the
  chart.** Rendering follows the audio clock, which tracks what has been
  *scheduled*; the player taps to what they *hear*, one output latency later.
  10-20ms on a Mac, 200ms+ over Bluetooth — wider than the whole "good" window.
  `resolveCalibration` seeds the offset from `AudioContext.outputLatency` when a
  device has never been calibrated. Before blaming chart generation for bad
  feel, confirm the device is calibrated.
- `outputLatency` is reported as **exactly 0** by some engines (and is missing
  entirely on Safari). Treat 0 as "not implemented" and fall back to
  `baseLatency`. `ctx.outputLatency ?? ctx.baseLatency` is wrong — `0 ?? x` is
  0, so the fallback never fires.
- "Never calibrated" and "calibrated to exactly 0" must stay distinguishable, or
  auto-seeding silently overrides a player's deliberate choice. That is why
  `getStoredCalibration()` returns `number | null`.
- **Rendering must go through `engine.judgementTime`, never the raw clock.**
  Judgement subtracts the calibration; the renderer did not, so on a phone
  calibrated to +280ms the pill crossed the receptor 280ms before the beat was
  audible and a visually perfect tap was judged 280ms early — past
  `MISS_WINDOW`, so `hitLane` matched nothing and the tap vanished with no
  judgement text at all. Anything positional (`visibleNotes`, `highway.render`)
  takes shifted time; `update` and `hitLane` take raw clock time and shift it
  themselves. Do not pass shifted time to those two or it double-counts.
  This is invisible on a desktop, where the offset is ~10-20ms.
- **A bad stored calibration makes the game 100% miss, on one device only.**
  `hitLane` does `songTime - calibrationSec`, so a *negative* offset judges every
  tap later than it landed; once it passes `MISS_WINDOW` nothing can be hit and
  there is no feedback at all — no judgement text, just misses. Calibration is
  per-device localStorage, so "broken on my phone, fine on desktop" is a
  calibration symptom before it is a rendering or input one. `resolveCalibration`
  now floors stored values at `MIN_STORED_SEC`; large *positive* values are left
  alone, because 300ms is an ordinary Bluetooth reading.
- **A metronome aliases, and it aliases exactly where Bluetooth lives.** Matching
  a tap to the *nearest* click flips sign at half a period: at 120 BPM a genuine
  300ms-late tap is nearer the next click and gets measured as **200ms early**.
  That is where a reported −200ms calibration came from — wrong sign, wrong
  magnitude, and it would then shift every note the wrong way. `foldTapDelta`
  breaks the tie asymmetrically instead, because latency is physically
  non-negative: only `MAX_LEAD_SEC` of genuine anticipation reads as early.
  The measurable range is therefore `beatSec - MAX_LEAD_SEC`, which is why the
  metronome runs at **90 BPM and must not be sped up** — 120 BPM caps out at
  380ms, inside Bluetooth's range.
- The calibration tap pad uses **`pointerdown`, never `click`**. `click` only
  fires after the finger lifts, and that gap is tens of milliseconds of error in
  the one measurement whose whole job is measuring milliseconds. It also avoids
  double-counting: a focused `<button>` fires `click` on SPACE, so a click
  handler would record the same keypress twice alongside the global keydown.
  `touch-action: manipulation` matters for the same reason — the double-tap-zoom
  delay would be recorded as latency that is not there.

**React**
- Never let the render loop's effect depend on state the loop itself sets.
  `phase` was in the deps and `start()` set it, so the effect tore down and
  cancelled the very frame it had just scheduled. Game state lives in refs;
  `phase` is mirrored into a ref for logic and state only for rendering.
- The HUD is written via DOM refs during the loop, not React state. Re-rendering
  at 60fps costs more than the entire render loop.

**Themes**
- **Built-in themes are code; custom themes are data. Do not merge the two.**
  `BUILTIN_THEMES` in `shared/` is read-only at runtime and the API returns 403
  on any attempt to edit or delete one. Two reasons: `DEFAULT_THEME` is the
  fallback `themeFor` guarantees never fails, so it cannot depend on a JSON file
  existing; and `synthwave` reproduces the pre-theme renderer colour for colour,
  which nobody would reconstruct after overwriting it. Admin offers Duplicate.
- **`themeFor` takes the catalogue as an argument.** Custom themes arrive over
  the wire, so a module-level cache would make resolution impure and load-order
  dependent, and the play screen and editor could disagree — the same reasoning
  that makes `laneColor` take a theme. Screens fetch `listCustomThemes()` and
  wrap it in `themeCatalog()`. Passing raw custom themes as a catalogue silently
  resolves every built-in to the default.
- **Validation lives in `shared/validateTheme` and runs on both sides.** It used
  to be enough for `theme.test.ts` to police the brightness rules, which is no
  protection at all once a palette can be typed in at runtime. The server
  rejects; the editor shows the same messages live. Errors block saving,
  warnings (lanes that merely look similar) do not — that one is a judgement
  call about a specific chart and player.
- **Deleting a theme does not cascade.** Songs keep the dead id and `themeFor`
  resolves it to the default, which is what makes delete safe rather than a
  rewrite of every beatmap. The API reports `songsAffected` so the UI can say so
  instead of silently recolouring a library.
- **The hit line sits at `z = 0`, on the receptor centres. Do not move it
  forward for looks.** It was at `z = 0.45`, which is 22ms on hard and 33ms on
  easy — the brightest, sharpest object on the track was marking a moment that
  could only be reached by tapping *late*. The receptor ring compounds it from
  the other side: it is far wider than a note, so the pill *touches* it ~40ms
  early. The two obvious cues bracketed the real moment and neither marked it.
  The symptom was a player scoring `perfect` tier while reading 80% EARLY, which
  looks like a calibration fault and is not one. Any change to receptor size or
  note size changes these numbers — recompute them, do not eyeball.
- **`0xe0` is the practical ceiling for a channel in a sky colour.** `0xe8`
  linearizes to 0.807 and crosses the bloom threshold (0.8), so the sky starts
  glowing in competition with the notes. Two of the four original themes shipped
  with exactly that value in `sunCrown` and it read as "bright", not as "wrong".
  `theme.test.ts` now asserts it, which is the only reason it was caught.
- **`PATCH /api/songs/:songId` is no longer just rename.** It set
  `customName: true` unconditionally, which was right when rename was its only
  caller and became a bug the moment a theme-only PATCH existed — changing a
  song's colours would freeze its title against the next re-ingest, and the
  damage would surface much later looking nothing like its cause. It now sets
  the flag only when a title or artist was actually sent. Any future field on
  this route needs the same care.
- **An unknown `themeId` is rejected at the API, not stored.** A persisted typo
  is a song that renders default forever with nothing in the UI to explain it.
  Resolution on the *read* side is the opposite — `themeFor` never fails,
  because an unresolvable theme would throw in the `Highway` constructor and
  leave a black screen rather than merely the wrong colours.
- The ground grid takes its colours from lanes 0 and 1, so it themes itself.
  Judgement colours (`TIER_COLORS`, `TIMING_COLORS`) are deliberately **not**
  themed: they mean perfect/great/good/early/late, and that is the one visual
  language the player learns once and relies on everywhere.

**Holds — currently OFF**
- **`holdShare` is 0 on every difficulty, which disables the feature.** They
  were built (L1–L4) and did not play well enough to keep. Nothing is deleted:
  the engine, input and renderer are intact and tested, and `applyHolds` returns
  immediately on a zero budget so none of it ever fires. Restore the tuned
  shares recorded in `difficulty.ts` to turn it back on; `holds.test.ts` asserts
  the off state, so re-enabling is deliberate rather than accidental.
- The generation tests enable holds explicitly via a local `enabled()` helper,
  so the mechanism stays covered while the feature is dark.
- **Disabling only affects newly generated charts.** Beatmaps keep whatever
  they were built with, so every song that already had holds needed regenerating
  — including one that existed *only in the Docker volume*, because it was
  ingested there. See the Docker section: the container's library is a copy.
- **Release input is bound on `window`, not the canvas**, and keyed by
  `pointerId`. A finger that slides off the canvas still fires `pointerup`
  there, and a release that never arrives leaves the lane held forever.
  `pointercancel` matters too — the browser takes the pointer away for system
  gestures. The lane is resolved once on press and remembered; recomputing it
  from the release position would break a hold whose finger merely drifted.
- **Pausing releases every held lane.** Alt-tab fires `blur` (which pauses) but
  *not* `keyup`, so the engine would still think the key was down and the hold
  would auto-complete at its tail on resume — a free bonus for a note nobody
  held.
- **A hold body is drained, not scrolled.** Its near end clamps at the hit line,
  so the strip shrinks into the receptor while held. The z-range is the pure
  `holdSpan` in `highway.ts`, exported so it can be tested without WebGL.
  Its world length is **constant** while approaching — the body travels at a
  fixed speed — and only shrinks once the head lands. The intuitive "it grows as
  it nears" is wrong and there is a test asserting so.
- Bodies are a **pool of individual meshes**, not an `InstancedMesh`: each hold
  is a different length and instancing shares one geometry. Each needs
  `HOLD_SEGMENTS` divisions, because a plane cannot bend to the track without
  them, and per-row `curveLift`/`curveWidth` or it floats off the surface.
- **Sustains come from the cached `Waveform`, never from new `AnalysisResult`
  fields.** `analysis.json` is what lets regeneration skip decoding, so a new
  field there would strand every already-ingested song. The waveform is already
  saved per song at 20ms resolution, and `regenerateCharts` rebuilds a missing
  one (best-effort — charts still rebuild without it, just hold-free).
- **A "sustain" is a *flat* envelope, not a loud one.** A cymbal stays above any
  floor for a second while decaying the whole way; the test is late energy
  against early energy. Getting this wrong turns every drum hit into a hold.
- **Only onsets above the song's own p75 strength end a sustain.** Stopping at
  every onset sounds right and destroys the feature: onsets fire every 80-130ms
  in real music, so spans never reach the minimum hold length. Absolute
  thresholds are wrong here for the same reason they are in lane assignment.
- **A hold occupies its lane for its whole length**, so generation trims it to
  end `minGapSec` before the next note in that same lane, and drops it if that
  leaves too little. Promotion therefore has to run *after* lane assignment.
- **`maxConcurrentHolds` caps simultaneous holds at 2** — a physical limit, not
  a taste one: the keymaps are one left hand and touch is two thumbs. Sustains
  in different frequency bands land in different lanes at the same instant, so
  without the cap the generator stacked **up to 4 at once** on hard. Enforced
  with a sweep (`peakConcurrency`), *not* by counting overlapping holds: two
  holds can each overlap a candidate without overlapping each other, and
  counting would reject a perfectly playable note. Costs ~12% of holds on hard
  and none on easy/medium, because rejected candidates are replaced by the
  next-steadiest within the same budget.
- `holdShare` is a ceiling, not a target. A song with no sustained sounds gets
  no holds, and that is the right chart for it — never manufacture them to fill
  a quota.

**The menu's detail panel is two different things**
- Below 860px it is a **fixed bottom sheet** overlaying the list; above, it is a
  column beside it. `sheetOpen` state dismisses it, and **only mobile CSS reads
  that state** — on desktop there is nothing covering anything, so the dismiss
  button is `display: none` and the hidden class has no effect.
- Selecting any track reopens it. That is the only way back, deliberately: it is
  also the only reason you would want it back.
- **Hiding the sheet must also collapse `.song-list`'s bottom padding**, which
  is ~19rem to clear it. Otherwise dismissing trades a covered list for a short
  one with a gap under it.
- **The sheet needs an explicit `z-index`** (5). The favorite stars carry
  `z-index: 2` to sit above their own card, and a `position: fixed` element with
  `z-index: auto` loses to them — the stars of the rows underneath punch
  straight through the sheet and float over the title and the PLAY button. Same
  family as the `backdrop-filter` stacking trap below; diagnose it the same way,
  with `elementFromPoint`.

**Favorites**
- **Per-device, in `localStorage`** alongside scores and calibration — *not* a
  field on the beatmap. Chosen knowingly: it keeps starring instant and working
  offline, where a server flag would be a PATCH and the service worker never
  fakes writes. The cost is that favorites do **not** sync between desktop and
  phone. Moving them server-side is a `favorite` flag on `Beatmap` plus the
  usual re-ingest/regenerate preservation, if that trade ever stops being worth
  it.
- `sortSongs` takes favorites as an argument rather than reading storage, so it
  stays pure and the admin screen can keep calling it without them.
- The star is overlaid on the song card, not nested inside it — the card is a
  `<button>` and a button inside a button is invalid and breaks activation.
- The favorites-only filter is hidden until something is starred, and
  `filterFavorites` is identity on an empty set. A filter whose only possible
  effect is emptying the list is worse than no filter.

**Charts**
- Regenerating charts invalidates stored scores. Mention it when you do.
- **Existing songs have no holds until they are regenerated.** That is by
  design — `duration` is optional so old beatmaps stay valid — but it means a
  song will look like holds "did not work" until it is rebuilt.
- `minGapSec` governs how hard a chart feels far more than `targetNps` — the
  target is only an average, the gap is a hard ceiling on sustained streams.

## Testing conventions

- Pure logic gets real tests: judge/engine, chart generation, router, editor
  coordinate math, haptics.
- **DSP is tested against synthetic audio with known ground truth** — click
  tracks at a known BPM, alternating kick/hat for band classification. Do not
  test DSP by eyeballing a real song.
- **Chart quality is measured, not listened to.** The diagnostic that matters:
  decode audio → per-second RMS → per-second note count → correlate. Near zero
  or negative means the charts are fighting the music. This caught two separate
  bugs. See PLAN.md §2.4.
- Write throwaway diagnostics as `dbg.ts` at the repo root and delete them after
  — relative imports do not resolve from a temp directory.

## Style

- TypeScript everywhere, `strict`, no plain `.js` source files.
- Comments explain **why**, not what. Most of the non-obvious code here exists
  because of a specific failure; say which one.
- Match the surrounding code. Prefer deleting a dependency over adding one —
  the DSP, the router and the crowd cheer are all hand-rolled for that reason.

## Open items

- **Long notes are the next feature** — designed in PLAN.md §6f, not built.
  Milestones L1–L5. Two things to know before starting: sustain spans come from
  the **cached waveform**, not from new analysis output, so the existing library
  needs no re-analysis; and L2 (the engine state machine) should land before any
  rendering, because it is the part that can be designed wrong. Three scoring
  and forgiveness questions are open at the end of that section.

- **Phone access is solved — via Tailscale, not the firewall.** No allow rule was
  ever created; Tailscale sidesteps the inbound block. See the sharing section.
  Still to do if you want Wake Lock to work: the two HTTPS toggles in the
  Tailscale console, then `tailscale serve --bg 8787`.
- **Unverified on a real device:** wake lock, haptics, and the intro-skip. The
  crowd cheer is unverified by ear at all. The lane-tap fix has only been checked
  synthetically — worth a real thumb on a phone. Calibration *is* now verified
  on a phone (~+280ms over Bluetooth); whether the game feels right with that
  applied is still open.
- **Per-song themes are built** (PLAN.md §6d, T1–T4): five built-in palettes
  plus an editor at `/admin/themes` for custom ones, picked per
  song in admin. Two follow-ups remain — whether a theme should change note
  *shape* as well as colour, and whether the shell (`RetroBackdrop`) should
  follow it. The shell is awkward on purpose: the menu lists every song, so
  there is no single theme to apply there; results and the play screen's own
  chrome are the parts that could.
- **Editor:** E1 (read-only timeline) is built at `/edit/:songId/:difficulty`.
  E2 (global timing offset + save + `customChart`) and E3 (note editing with
  undo/redo) are designed in PLAN.md §6c but not built. E2 is the highest-value
  next piece: one slider fixing a whole chart's timing beats editing notes.
- **Chart feel is still untuned** (milestone M3). Only a human can judge it. The
  hit windows have been widened twice (`judge.ts`) and are a feel knob, not a
  fixed truth — but they are **capped**: `good` may not exceed the smallest
  `minGapSec`, because `hitLane` matches the nearest note and a window wider
  than the tightest spacing can retire the note *after* the one the player aimed
  at. `engine.test.ts` asserts it. If fast passages still feel unfair, raise
  `minGapSec` and regenerate rather than widening further.

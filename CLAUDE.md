# CLAUDE.md

Working notes for agents on this repo. **Read `PLAN.md` too** — it holds the
architecture, the reasoning behind every non-obvious decision, and a progress
log. This file is the operational layer: how to run things, what must not be
broken, and the traps that have already cost time.

## What this is

A rhythm game, now shipped as a **serverless Capacitor Android app** (PLAN.md §6h).
You paste a YouTube link; a bundled yt-dlp downloads the audio on the device, the
analysis runs on-device, and note charts are generated at four difficulties
(easy/medium/hard/extreme). Songs are stored on the device; players play on
3/4/5 lanes. (A Node dev server still exists for browser UI development — see
Commands — but it is not part of the shipped app.)

**Personal/sideload only. Never publish it.** `yt-dlp` against YouTube breaks
their ToS, so this cannot go on the Play Store — that is a permanent constraint,
not a temporary one. On your own device for your own use it is a non-issue.

## Commands

```bash
npm run dev                    # dev-only backend :8787 + web :5173 — USE THIS for
                               #   UI work. Live reload. The shipped app is Android.
npm test                       # vitest, all workspaces
npx tsc -b                     # typecheck the project graph
npm run build                  # production web build — app, then the service worker
npm run build:android          # web build + cap sync (bundle into the Android app)
npm run android                # build:android, then open the project in Studio
npm run icons                  # regenerate PWA icons (only when the art changes)
npm run ingest -w server -- "<youtube-url>"   # author a song on the desktop (CLI)
```

The Browser pane tools (`preview_start`, then `navigate`/`computer`) are the way
to run and verify the **web UI**; the Android app is verified via the emulator/
device with `adb` (see "Building the Android app"). `.claude/launch.json` defines
the dev server.

**This is a mobile-only, serverless game (PLAN.md §6h).** The shipped artifact is
the Capacitor Android APK, which has no server — it stores its library on the
device and ingests YouTube links with a bundled yt-dlp. The Express server is now
a **dev-only** backend: it powers fast browser UI development (the `web/src/data`
layer dispatches to it when not running natively) and desktop content authoring
(`npm run ingest`). Docker, the pinggy tunnel and `serve:public` were removed
(MD1) — do not look for them.

**Develop the UI on :5173.** `npm run dev` runs Vite (with HMR) plus the dev
backend for `/api` + `/media`. For anything native — ingest, Filesystem storage,
the splash/icon — build and run the APK.

## Building the Android app (Capacitor)

The mobile target (PLAN.md §6h). Capacitor wraps the Vite build as a native APK;
`appId com.taptap.game`, `webDir: web/dist`, project in `android/`.

```bash
npm run build:android    # vite build + cap sync android (copies web/dist into the app)
npm run android          # build:android, then open the project in Android Studio
cd android && ./gradlew assembleDebug   # build the debug APK directly
```

- **The SDK is the gate, not the code.** On this machine Java 21 is present and
  `cap add android` + Gradle 8.14.3 configure and compile fine — the debug build
  reaches `:app:compileDebugJavaWithJavac` and fails only because the **Android
  SDK is not installed**: `%LOCALAPPDATA%\Android\Sdk` (the `sdk.dir`/`ANDROID_HOME`
  target) does not exist, and the stray `C:\Program Files (x86)\Android\android-sdk`
  has only `platforms/android-34`. The project needs **platform 36 + build-tools +
  platform-tools**. Install them via Android Studio's SDK Manager (accept
  licenses), which populates the canonical path; `local.properties` (gitignored)
  already points there. The tell for this is a Windows `java.io.IOException: The
  filename, directory name, or volume label syntax is incorrect` during dependency
  resolution — that is the missing SDK, not a bad path.
- **`local.properties` `sdk.dir` must use forward slashes** (`C:/Users/…/Sdk`),
  not `C:\Users\…`. It is a Java *properties* file, so `\U`, `\A`, `\L`, `\S` are
  read as escape sequences and silently stripped — the path becomes
  `C:UsersavihayAppData…` and AGP throws the very same "filename syntax
  incorrect" `IOException`, this time from `SdkLocator.validateSdkPath`, *after*
  the SDK is installed. Same symptom, different cause; forward slashes dodge both.
  Android Studio writes escaped backslashes itself, so this only bites a
  hand/CLI-written file (which is what `local.properties` is, and it is
  gitignored).
- **Running it in an emulator with the real library:** the bundled APK has no
  server, so point Capacitor at the host dev server for a live test — set
  `server: { url: 'http://10.0.2.2:5173', cleartext: true }` in
  `capacitor.config.ts` (10.0.2.2 is the emulator's alias for the host),
  `npm run dev` on the host, `cap sync`, rebuild, install. Revert `server` before
  shipping a real bundled build. Emulator GL is accelerated via WHPX but is still
  **not a valid 60fps reading** — only the physical S25 answers invariant 1.5.
- **`web/dist` is gitignored; the bundled copy under
  `android/app/src/main/assets/public` is regenerated by `cap sync`** — do not
  commit either. `android/` itself *is* committed (the native project), minus its
  own `.gitignore`d build dirs and `local.properties`.
- **The APK has no server.** Until MB2 (on-device storage) lands, the app loads
  and the highway renders but the song list is empty — `api/client.ts` still
  fetches `/api`, which does not exist in the APK. That is expected at MB1.

## Offline / PWA

**This is a web-context feature only.** The shipped APK stores its library on the
device Filesystem and has no server, so *its* offline guarantee comes from
storage, not from this worker — the service worker matters only when the game is
run as a PWA in a browser (dev, or a hosted web build). Everything below is about
that context.

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
causes here. **To exercise the worker, build (`npm run build` — app then worker),
then serve `web/dist` with `npm run preview -w web`; never `npm run dev`.**
(`serve:public`, which used to serve the built app and the dev API on one origin,
was removed in MD1 — so `vite preview` gives you the shell and the worker, but not
the dev `/api` + `/media` proxy, and a full offline-*playback* test now needs the
API served alongside `web/dist` by hand.)

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
  when it answers 404. That is what stops a worker registered by an earlier
  production-build preview from serving a stale cached app during `npm run dev`,
  where a 404 at a given root is *supposed* to happen.
- Ranged requests are passed straight through: a 206 cannot be `cache.put`.
  Nothing issues one today because audio is fetched whole for `decodeAudioData`,
  but a `<audio>` element added later would.
- The icons are hand-encoded PNGs (`zlib` + a CRC, no image dependency) and are
  committed. Re-run `npm run icons` only if the art changes.

## Layout

```
shared/src/     wire contract: beatmap, difficulty params, keymaps, themes
core/src/       PURE TS DSP — no Node/DOM/three. Imported by server AND web.
  analysis/     FFT, spectral-flux onsets, tempo, waveform  (+ synthetic-audio tests)
  charts/       lane assignment, difficulty filters, note selection
  util/         seeded RNG
  index.ts      barrel: analyze, computeWaveform, generateAllCharts, ANALYSIS_VERSION
server/src/
  ingest/       yt-dlp, ffmpeg, pipeline (decode is the only non-portable step)
  storage.ts    beatmaps, cached analysis, waveforms, custom themes
  index.ts      Express API on :8787
web/src/
  game/         PURE TS — clock, judge, engine, calibration, combo, run types (unit tested)
  editor/       PURE TS — timeline coordinate math (unit tested)
  render/       three.js highway + palette helpers
  components/   RetroBackdrop (the shared stage backdrop), toggles (haptics +
                UI sound), row menus, ThemePicker, ThemePreview (a live Highway)
  hooks/        useWakeLock, useOffline
  screens/      menu, play, results, calibration, admin, themes, editor
  uisfx.ts      hand-rolled WebAudio UI sounds (data-driven, unit tested) + mute
  accent.ts     accentVars — CSS var overrides that repaint a screen in a theme accent
  router.ts     hand-rolled typed router over the History API
  sw.ts         service worker — separate program, see the Offline section
  pwa.ts        registration + offline-cache queries
public/fonts/   space-grotesk-700.woff2 — the one bundled display face (--font-display)
scripts/
  make-icons.ts hand-rolled PNG encoder for the PWA/launcher icons
  make-logo.ts  hand-rolled PNG encoder for the brand mark (assets/logo*.png,
                the source art for `capacitor-assets generate`)
```

## Invariants — do not break these

- **`shared/` is the single source of truth** for anything crossing the wire.
  Never redeclare a beatmap type in `web/` or `server/`.
- **`web/src/game/` and `web/src/editor/` import no three.js, no React, no DOM.**
  That is what makes them testable. Rendering reads state; it never owns it.
- **`AudioContext.currentTime` is the master clock.** Never `setTimeout`,
  `setInterval`, or accumulated frame deltas for anything the player can hear or
  feel. `requestAnimationFrame` drives rendering only.
- **`laneCount` is a parameter, never a constant.** Anything that hardcodes a
  lane count is a bug. **Every shipped difficulty is currently 4** — the 3- and
  5-lane paths are supported (keymaps, lane ranges, `laneColor`, the tap-to-lane
  projection) and exercised by tests, but nothing in the library travels them,
  so a regression there will not show up in play. If you change a `laneCount`
  in `difficulty.ts`, that is the moment those paths get their first real
  exercise; expect to find something.
- **Lane *widths* are sized to the song, not fixed at `low[0] mid[1,2] high[3]`.**
  `laneRangesByPopulation` (charts/lanes.ts) gives each band a lane range
  proportional to how many onsets it carries, so a hat-dominated song does not
  stack ~85% of its taps on the single high lane (the "Bye Bye Bye" report). A
  balanced song still resolves to the old fixed split; the ordering (bass left,
  treble right) never moves. If you change band classification or add a band,
  keep this — the fixed split re-introduces the one-lane collapse. PLAN.md §2.1.
- **The server binds `TAP_TAP_SERVER_PORT`, not `PORT`.** It runs alongside Vite
  under one `npm run dev`; a generic `PORT` in the environment gets applied to
  both and one steals the other's port.
- **Analysis decodes `audio.m4a`** — the file the browser plays — not the
  original download. AAC priming delay means analysing the source times every
  note against audio nobody hears.
- **Snapping to the beat grid is conservative** (only when the grid already
  agrees, capped at 30ms) **and confidence-gated**: below `bpmConfidence` 0.5
  the grid gets no say at all — no snapping, no on-beat selection bonus, no
  chord gating. The onsets are ground truth; the grid is an estimate that
  drifts less than it used to — beats are now *tracked* through the song
  (DP, §2.8), not extrapolated from one constant tempo, so a human
  performance gets a grid that follows it. `bpmConfidence` is built from
  measurements of the tracked beats (contrast, hit rate, gap steadiness,
  onset alignment) precisely so a wrong grid lands under that line — and so
  a solid song scores high; the old autocorrelation z-score under-reported
  real music, only metronomes cleared it. Steadiness caps the blend: onsets
  align with tracked beats by construction, so alignment must never rescue
  an arrhythmic "pulse". See PLAN.md §2.2/§2.8/§2.9.
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
- **Score is normalised to `MAX_SCORE` (1,000,000), and the migration is the
  dangerous part.** The raw total scales with chart length — a flawless run earned
  292,875 on a 232-note easy chart and 1,387,875 on a 962-note extreme one, the
  same performance with no relationship between the numbers. `game/score.ts`
  divides by `idealScore(notes)`, the raw score a flawless run would earn.
  - **A raw record and a normalised one cannot be compared.** 1,387,875 beats any
    normalised ceiling, so comparing across scales would reject every future clean
    run on that chart *permanently* — one slot, no second copy, the same
    irreversible shape as assisted runs overwriting clean ones. `BestScore.normalized`
    marks the scale and `recordScore` **rescales** a legacy record using the
    incoming run's `scoreMax`, which is the current chart's measured ceiling.
  - **Precedence is assist rank → scale → score**, checked in that order, so a
    migration can never be the loophole that lets an assisted run take a clean slot.
  - `scoreMax` rides on the snapshot and the `RunResult` because it must come from
    the **played** chart: intro skip and start grace make it shorter than the stored
    one, so a divisor derived from `noteCounts` later would disagree.
  - `normalizeScore` clamps to the ceiling. `idealScore` models interleaved hold
    ticks approximately, so a genuinely flawless run can compute a hair over, and a
    score reading 1,000,240 looks like a bug.
  - Nothing yet compares scores *across* songs — no sort, no aggregate, no
    leaderboard — so this is a legibility fix and a foundation, not the repair of
    an active defect. Say so before treating it as urgent.
- **Assist rank outranks score in `recordScore`.** There is one best slot per
  chart and `scoreMultiplierFor` returns 1 for every modifier set, so a 0.75x
  run posts the same numbers as a full-speed one. Comparing on score alone let
  an assisted run overwrite a clean record — irreversibly, since nothing keeps a
  second copy. An assisted run may never displace a clean one and a clean run
  always displaces an assisted one, whatever the scores. `isAssisted` is
  deliberately **not** `!isDefaultModifiers`: most modifiers (fail, hidden,
  fadeout, speeds above 1) make the run *harder* and must keep their standing;
  only slower speeds and holds-off count. **Any new modifier has to be
  classified into one of those two groups** or it silently defaults to "not
  assisted", which is the direction that corrupts records.
- **Loudness is stored as a gain, never re-encoded.** `Beatmap.gainDb` carries a
  ReplayGain-style offset measured per ITU-R BS.1770 at ingest
  (`core/analysis/loudness.ts`), applied at playback by `AudioClock.setTrackGain`.
  Re-encoding the audio would destroy the original irreversibly, add a
  generation of lossy loss, and make re-tuning `TARGET_LUFS` later mean
  re-downloading the library; a number is reversible. **Absence means unity**, so
  a song ingested before this plays exactly as it did — `regenerateCharts`
  measures it best-effort on the decode it already does, which is the migration
  path for the existing library. Measured on the **mono downmix** (that is what
  `analyze` is handed); `DUAL_MONO_GAIN` puts it back on the stereo scale so the
  numbers compare with other tools. Real spread on this library is **9.6 LU**
  (−4.7 to −14.3 LUFS), which is why a fixed-level hit sound cannot be balanced
  until this exists — it blocks the rest of the audio work.
- **`trackGain` and the outro `gain` are separate nodes.** Sharing one would
  make the fade multiply a per-track offset, so a quiet song would fade from a
  different starting point than a loud one. The analyser sits *after*
  normalisation on purpose: the spectrum drives the scene's reactivity, and
  reading it pre-gain leaves a quiet track looking dead as well as sounding it.
- **The beat flare is rate-limited to `MAX_FLASH_HZ` (3/sec) and switchable.**
  Tempo comes from whatever the player pasted a link to, so at 240 BPM the
  backdrop flare fired four times a second — over the WCAG 2.3.1 threshold, and
  the safety of the effect was a property of the music rather than the code.
  `flashStride` thins fast songs onto every Nth beat (skipping beats keeps it
  musical; clamping to a fixed 3 Hz would drift against the song). Anything new
  that pulses on the grid must go through `beatPulse`, or it reintroduces the
  hazard next to a control that claims to have removed it. The player switch is
  separate from `prefers-reduced-motion` on purpose — plenty of people want
  motion and not flashing, and the reverse — and **its copy must never promise
  safety**; it says "Screen flash", not "epilepsy safe".

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
- **`margin: auto` guarantees the card's *top* is reachable, not its bottom.**
  Adding the timing histogram and section bars took the results card to 723px —
  past a 667px phone — and scrolled fully down the last pixel of RETRY sat off the
  edge. The fix is bottom padding on the **scroller** (`.results`, in the
  `max-width: 560px` block, which is the rule that actually wins on a phone): a
  bottom margin on the card is simply absorbed by the auto-centring. Anything added
  to this card needs re-measuring at **667px**, not just 812 — the media query's own
  comment claims it clears 812, and that is the height that lulls you.
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

**Play visuals (tiles, hit-zones, impact)**
- **Notes are wide flat tap-tiles, not pills** — a textured unit plane laid flat
  (`rotateX(-PI/2)`) and sized per-instance to `TILE_WIDTH × TILE_DEPTH`, tilted
  onto the slope with `atan(curveSlope(z))` and tapered by `curveWidth(z)`, the
  same treatment the glow quad gets. The shape and lit rim come from a canvas
  texture (`makeTileTexture`); the lane colour comes from `instanceColor`. A
  flat plane needs the slope tilt or it shears through the rising track.
- **Receptors are rectangular frames** (`makeFrameTexture`, `hitZones[]`), the
  same shape as a tile so a tile visibly drops *into* its target. The old rings
  are gone, and so is the **white hit-line bar** — the frames alone mark the
  target now (they sit at z=0, so the timing reference the old bar carried is
  preserved). `theme.hitLine` went unused for a while after that and **is used
  again**: it colours the electric hit bar's core (`buildHitBar`) and the
  receptor dash on the stage path.
- **Tile/frame textures are aspect-matched to the world footprint.** A tile is
  ~1:2 (tall), the frame ~1:2.5, so the texture canvases are 128×256 / 128×320 —
  match the canvas aspect to the world aspect or the rounded corners map to
  stretched ovals. `TILE_DEPTH`/`HIT_ZONE_DEPTH` are the "height" knob.
- **The sun pulses to the beat** (`uPulse` in the backdrop shader): it brightens
  past the bloom threshold and swells slightly on each downbeat. `uPulse` is
  `beatPulse(songTime)`, driven by `beatGrid`.
- **Never put a backtick in GLSL.** The shaders are JS template literals, so a
  stray `` ` `` (e.g. around an identifier in a comment) closes the string early
  and TypeScript then parses the GLSL as code — a wall of "',' expected" errors
  pointing *inside* the shader. Cost real time once.
- **The hit line is raised on portrait phones via `camera.setViewOffset`**, not
  by moving anything in the scene — it pans the projection up without touching
  the 3D framing or perspective, and is cleared on landscape. It must be set
  *after* `updateProjectionMatrix` (which resets the offset). The Y-only offset
  does not affect `laneAtScreenPoint` (X projection is unchanged).
- **Hit impact** = particle burst + an expanding `RingGeometry` shockwave from
  the receptor + a camera `shake` that scales with **combo** (passed into
  `burst(lane, tier, combo)`) and caps, with a squared falloff so the low end
  never leaves the lanes feeling permanently loose. Shader/material changes here
  are built in the `Highway` constructor, so **they need a full reload, not HMR**
  to show up.

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
- **Auto-calibration learns from real hits, live** (`autoCalibrationStep` in
  `calibration.ts`, wired in `PlayScreen`). Confident hits (perfect/great only)
  feed a rolling window; when it fills, the offset is nudged toward zeroing the
  **median** bias and the result is persisted, so the next song starts dialled
  in — the metronome screen is now optional. **The sign is the whole point and
  is unit-tested**: a *late* bias (positive median) raises the offset, because
  `hitLane` judges `songTime − calibration`. Steps are capped at 10ms so a live
  nudge never visibly jumps the notes, damped so it converges rather than rings,
  bounded by a per-run drift budget, and the persisted value is floored at
  `MIN_STORED_SEC` exactly as `resolveCalibration` floors on read. `bumpCalibration`
  is why `calibrationSec` is no longer `readonly`; the engine reads it fresh each
  frame so judgement and rendering shift together.
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

**Holds — ON**
- **`holdShare` is 0.1 / 0.14 / 0.18 / 0.2** (easy→extreme) in `difficulty.ts`.
  They were dark for a while — the shares were zeroed after L1–L4 because they
  did not play well enough — and were turned back on once tuned. If you read a
  doc or comment claiming the feature is off, it is out of date; check
  `difficulty.ts`, which is the only authority. `holds.test.ts` pins the shipped
  shares in `TUNED_SHARE` and has a `shipped configuration` case asserting the
  two agree, so changing one and not the other fails rather than drifts.
- A zero share still disables the feature cleanly (`applyHolds` returns
  immediately on a zero budget), so zeroing one difficulty is a valid move.
- **Changing a share only affects newly generated charts.** Beatmaps keep
  whatever they were built with, so the whole library needs regenerating to
  follow a change — and a song will look like holds "did not work" until it is.
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

**The gameplay audio graph, and what is deliberately not on it**
```
source → trackGain → gain(fade) → duck → outroFilter → analyser
                                                          ↓
ticks ─┐                                              musicVol
cheer ─┴→ sfxVol ───────────────────────────────────→ master → destination
```
- **The analyser's position is load-bearing, twice.** After normalisation *and*
  the filter, so the spectrum reflects what the track actually sounds like; but
  before `musicVol`, so a player turning the music down does not flatten the
  scene's reactivity with it.
- **Fade, duck and level are three separate nodes on purpose.** Sharing one would
  make the outro fade multiply a per-track offset, so a quiet song would fade from
  a different starting point than a loud one — the same reason `trackGain` was
  split out for loudness.
- **`fadeOut` sweeps the lowpass as well as the gain.** A gain fade alone just
  gets quieter; rolling the top off with it is what makes a track read as
  receding. Exponential, because pitch is perceived logarithmically — a linear
  sweep spends most of its time in the top octave where there is least to hear.
  `start` resets the filter and the duck, or a restart begins muffled.
- **Ducking is wired to the cheer, not to the note ticks — deliberately.** Web
  Audio has no sidechain, so it is scheduled gain automation, and it suits *sparse*
  events. Notes arrive 2–5 times a second, so an audible duck envelope would
  overlap its neighbours and leave the music permanently dipped and pumping. The
  balance problem ducking would have solved there was already solved by loudness
  normalisation (§17): with the music pinned to a fixed target, one absolute tick
  level works library-wide.
- **UI sounds are not on this graph and should stay off it.** `uisfx.ts` owns its
  own `AudioContext`, created lazily on the first menu noise and alive whether or
  not a song is loaded, while `AudioClock`'s context lives and dies with a run.
  "One audio graph" means one graph for the *game's* audio. UI sound keeps its own
  mute.
- Music can be turned down but never off; effects can go to zero. A rhythm game
  with no music is not quieter, it is broken — that is what the phone's own volume
  keys are for. What a mixer adds over hardware volume is the *balance*.

**Note ticks are a guide, not hit feedback — and cannot be made into feedback**
- A click on every note, scheduled ahead on the audio clock
  (`game/tickSchedule.ts` + `AudioClock.playTickAt`). Off by default; it adds a
  percussion layer to somebody's music.
- **Do not try to make it conditional on the player hitting the note.** This is
  the obvious ask and it is causally impossible, not merely hard. A note at T is
  judged missed only once `T + missWindow` has passed, and the tap reaches the app
  a full output latency after the finger moved — so at the instant the sound must
  be committed to the graph (before T), whether it was hit is *unknowable*.
  Anything conditional has to sound after the window closes, i.e. up to 190ms
  late, which is the exact defect prescheduling exists to remove. Reactive
  per-tap sounds are on PLAN's "explicitly not recommended" list for the same
  reason: ~280ms over Bluetooth.
- **Schedule against raw song time, never `judgementTime`.** The tick must
  coincide with the *music*; the calibration shift exists to align *visuals* with
  what the player hears. Using shifted time drags every tick off the beat by the
  player's own latency.
- **`AudioClock.tickBus` exists because `pause()` does not suspend the context.**
  It stops the music source only, so ticks already committed keep clicking into a
  paused, silent game. They are muted at the shared bus rather than tracked
  individually — and because they then elapse silently, the scheduler's cursor
  must be re-anchored with `cursorAt` on resume, since their context times no
  longer line up once the source restarts.
- The bus deliberately bypasses `trackGain` and the outro `gain`: the music being
  normalised to a fixed target is what makes one absolute tick level work across
  the library at all. This is the dependency that made loudness (§17) a blocker
  for audio feedback.
- `ticksInWindow` **drops** notes a stall skipped past rather than firing them in
  a burst — a cluster of clicks at one instant is worse than the gap. It also
  de-duplicates chord voices, which share a timestamp and would otherwise sound
  as one click at double amplitude.

**Scroll speed is the player's, not the chart's**
- `approachSec` in `difficulty.ts` is the *base*; the run uses
  `approachSecFor(base, getScrollSpeed())` (`web/src/scrollSpeed.ts`). Higher
  multiplier = faster = **less** approach time, so the multiplier divides.
- **It is deliberately not an assist**, and this is the one thing to get right
  before touching it. `isAssisted` must classify every new *modifier*, and the
  tempting reading is "more approach time is easier". It is not: judgement is
  untouched (note times and `hitWindowsFor` are identical), and the effect is not
  monotonic — a *low* speed crams more seconds of chart onto the same physical
  highway, so a dense passage arrives as an unreadable clump. That is why the
  genre shares records across scroll speeds and why this stays out of
  `Modifiers`.
- **Resolve it once per screen, never per frame.** `visibleNotes` runs in the
  render loop; `getScrollSpeed` caches, but calling it there would hide a
  storage read on the hottest path rather than remove it. Both play screens
  compute one `approachSec` const and feed it to the `Highway` constructor, to
  `visibleNotes`, and to the effect deps.
- Menu only, taking effect next song — same constraint as Graphics, because the
  value is baked into the `Highway` at construction. A pause-menu copy would
  need a live highway rebuild.

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

**Clear lamps**
- Four rungs — not cleared / cleared / full combo / all perfect — **derived** from
  the stored best (`game/lamps.ts`), not recorded as a verdict, so the ladder can
  gain a rung without a migration. One pip per difficulty on each song row, which
  is the point: the grade badge only ever speaks for the *selected* difficulty.
- **There is deliberately no "played" rung.** `recordScore` is skipped for a
  failed run, so a failed attempt leaves no trace whatsoever — the app cannot
  tell "tried and lost" from "never touched" and must not imply it can. It also
  means a stored best *is* a clear.
- **`BestScore.misses` exists because the played chart is not the stored chart.**
  `PlayScreen` drops notes ahead of an intro skip and inside the start grace
  window, so `maxCombo >= noteCounts[difficulty]` under-reports a real full combo
  on any song with a long quiet opening. Counting misses sidesteps the played
  length entirely. Absent on older records, where `lampFor` falls back to that
  comparison — which can only ever **under**-claim, since the played chart is a
  subset of the stored one. Under-claiming is the right direction for a badge.
- Perfect requires `accuracy >= 1` *and* no misses. The second half is redundant
  today and is there so a future tier whose score ties with `perfect` cannot
  silently start handing out gold.
- A song with nothing cleared renders no strip at all — an all-empty ladder on
  every untouched row is noise, and most of a fresh library is untouched rows.
- The perfect pip is `--gold`, from the fixed trim family rather than the song
  accent, because an all-perfect clear is an achievement tier and not a themed
  element. Assisted clears keep their pip but lose its glow, mirroring how
  `recordScore` lets an assisted run hold a slot without outranking a clean one.

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
- **A metric is not a quality floor, and `fullBoardLeapRate` is the cautionary
  tale.** Hard and extreme cross the whole board on 26–33% of transitions. That
  reads as alarming and is almost certainly fine: **every lane owns a finger**
  (A/S/D/F is one hand) or a thumb, so lane 0 → lane 3 is not a journey across
  the board, it is the other hand — kick-then-hat alternation scoring high there
  is the chart mirroring the kit, which is what the lane ordering exists to do.
  A whole change was built against the opposite assumption and reverted; see
  `LANE_STEP_GAP_FACTOR` for why clamping *within* a band can never move a
  *between*-band jump. Do not assert an upper bound on a movement metric without
  a playability model that says what the bound means.
- **Chart diagnostics are fixture-specific — say which fixture.** Three separate
  findings ("easy and medium are rhythmically identical", "hard/extreme never
  rest", a 35% leap rate) failed to reproduce on a second synthetic fixture that
  differed only in how its onsets were built. Numbers from a throwaway harness
  describe that harness until they are reproduced on another one. The corpus in
  `charts/testFixtures.ts` exists so that reproducing is the default rather than
  an afterthought — a claim about *generation* gets asserted across all four
  fixtures (see Testing conventions). Both surviving claims did: rhythm does
  escalate from easy to extreme, and density is monotonic, on every fixture.
- Regenerating charts invalidates stored scores. Mention it when you do.
- **Regenerate re-analyzes when `analysis.json` is stale.** The file carries an
  `analysisVersion` stamp; when it does not match `ANALYSIS_VERSION`, regenerate
  decodes `audio.m4a` and re-analyzes (best-effort — no audio still rebuilds
  charts from the cached pool). Bump the version when the *analysis* improves,
  not when chart generation does — chart changes reach the library through a
  plain regenerate for free, while a version bump costs one decode per song.
  This can change a song's bpm, grid and confidence, which is the point.
- **Existing songs have no holds until they are regenerated.** That is by
  design — `duration` is optional so old beatmaps stay valid — but it means a
  song will look like holds "did not work" until it is rebuilt.
- **Note spacing is beat-relative, and `minGapBeats` is the knob.** The gap
  governs how hard a chart feels far more than `targetNps` — the target is only
  an average, the gap is a hard ceiling on sustained streams — but it is no
  longer a wall-clock constant. `effectiveMinGapSec` converts `minGapBeats`
  through the song's tempo and floors the result at `minGapSec`, so:
  - **Tune the beats value, not the seconds one.** The two are calibrated so
    120 BPM resolves to exactly the old flat number, which is what keeps the
    existing library stable; `difficulty.test.ts` pins that calibration.
  - **The floor means nothing ever gets tighter than it used to.** Songs at or
    above 120 BPM are unchanged; slower songs get proportionally wider gaps.
    Removing the floor would let a 180 BPM extreme chart ask for ~10.7 notes/sec
    and push `hitWindowsFor` into windows nobody has played.
  - **An untrusted grid falls back to `minGapSec`.** Converting through a tempo
    below `MIN_GRID_CONFIDENCE` would scale every gap in the song by that
    tempo's own error — the same reasoning that already denies the grid any say
    in snapping, the on-beat bonus and chord gating.
  - **Charts record what they were built with** (`Chart.minGapSec`), and play
    passes *that* to the engine rather than the difficulty's nominal value.
    `hitWindowsFor` caps the miss window to the chart's own spacing so `hitLane`
    cannot retire a neighbouring same-lane note, and that guarantee only holds
    against the spacing the notes were actually placed at — a value re-derived
    at play time could disagree after a re-analysis moved the bpm. Absence means
    the nominal value, so pre-existing charts are unaffected.
  - **A harder tier is not always denser.** Where the onsets offer no spacing
    between two tiers' targets both land on the same figure: on a sixteenth-
    quantised 80 BPM song, hard (0.285s) and extreme (0.21s) both skip to
    eighths and generate identical density, differing only in lanes and
    approach speed. `corpus.test.ts` therefore asserts non-decreasing density,
    not strictly increasing.

## Testing conventions

- Pure logic gets real tests: judge/engine, chart generation, router, editor
  coordinate math, haptics.
- **DSP is tested against synthetic audio with known ground truth** — click
  tracks at a known BPM, alternating kick/hat for band classification. Do not
  test DSP by eyeballing a real song.
- **`Onset.percussive` is the harmonic/percussive split, and it works.** HPSS by
  median filtering (`analysis/hpss.ts`): a median along *time* keeps what is
  steady (harmonic), a median along *frequency* keeps what is broadband
  (percussive), and the two become soft masks. Measured on ground truth — a click
  track keeps 100% of its energy, a vibrato tone 0%. Per onset it reads 0.95+ on
  real hits and 0.015 on the false onsets a wobbling tone manufactures, and
  filtering on it takes precision from **37.9% to 100%** with recall unchanged, at
  any threshold from 0.10 to 0.75. That is the problem SuperFlux failed to solve.
  - **The mask lags by half its time window, and mis-indexing that is silent.**
    Its first output describes frame `lag`, not frame 0. Numbering the outputs
    from zero shifts every reading ~93ms later than the flux it divides, which
    compares each drum hit against the silence after it: every percussion track
    reads as harmonic and the *false* onsets outscore the real ones. It shipped
    that way for one test run. `analysis.test.ts` asserts the shape that catches it.
  - Frames 0..lag-1 get no mask and read 0. Deliberate — every song opens on
    silence or an intro `startOffsetFor` discards.
  - **It is measured but not yet consumed.** Generation ignores it, so no chart has
    changed. Spending it — easy charting the percussive layer, harder difficulties
    layering the melody in — is a separate change that moves every chart and needs
    the corpus re-recorded.
  - Costs ~3.3s per 4-minute song on desktop. `ANALYSIS_VERSION` is 4 because of
    it, so the library needs one re-analysis to gain the field; absent means
    "not measured" and generation must read that as *admit the onset*, never as
    zero, or an un-regenerated song would chart empty.
- **Score an onset change on precision *and* recall, never on a count.**
  SuperFlux (max-filtering across frequency before differencing) was built,
  measured and reverted: recall never moved off 97.5% while precision fell from
  37.9% to 16.1%. Onset *counts* alone said almost nothing — they were identical
  on a click track and a drum loop at every filter width, because the adaptive
  median threshold is **relative**, so uniformly scaling the ODF does not change
  which peaks clear it. Anything that flattens the ODF instead lowers the bar
  toward the noise floor and floods the result with false positives. The fixture
  is `vibratoTone` and the floors are pinned in `analysis.test.ts`; the full
  reasoning is on the note in `onsets.ts`.
- **A numerically-equivalent optimisation does not bump `ANALYSIS_VERSION`.**
  `RealFFT` halves the transform (measured 1.89x) and is asserted equal to the
  complex one bin for bin, so the analysis *output* is unchanged and forcing a
  decode per song would buy the player nothing. Bump the version when the output
  improves, not when the code gets faster.
- **Chart quality is measured, not listened to.** The diagnostic that matters:
  decode audio → per-second RMS → per-second note count → correlate. Near zero
  or negative means the charts are fighting the music. This caught two separate
  bugs. See PLAN.md §2.4.
- **Chart generation is gated by a recorded corpus** — `charts/corpus.test.ts`
  over the four fixtures in `charts/testFixtures.ts`, at `CORPUS_SEED`.
  Generation is deterministic, so the full `chartMetrics` scorecard is pinned per
  fixture per difficulty and compared to ~0.005. **A failure means "generation
  changed", not "generation broke"** — read which numbers moved, decide if that
  is the change you wanted, then re-record and say in the commit which moved.
  Never loosen a tolerance to make it pass; that throws away the only lasting
  evidence of what a change did to the charts.
  - **Use the corpus rather than hand-rolling a fixture.** Each of the four
    exists for a path the others cannot reach: `structured` is the only one with
    real silence and intensity variation (so the only one where rests and the
    density correlation mean anything); `hatHeavy` is ~94% high-band and is what
    holds `laneRangesByPopulation` honest; `rubato` is the only one below
    `MIN_GRID_CONFIDENCE`, i.e. the whole untrusted-grid branch; `fullKit` is the
    only one whose onsets carry a real *second* band, which is what
    `secondaryBand` needs before a chord is eligible at all — before it existed
    no test in the repo produced a single chord despite `chordChance` being
    0.05/0.15/0.32.
  - Assertions that only hold for one song shape belong in that fixture's block,
    not the shared one. Asserting rests on a continuously-playing fixture is the
    "a metric is not a quality floor" mistake wearing a different hat — such a
    song is *entitled* to a continuous chart.
- Write throwaway diagnostics as `dbg.ts` at the repo root and delete them after
  — relative imports do not resolve from a temp directory.

## Style

- TypeScript everywhere, `strict`, no plain `.js` source files.
- Comments explain **why**, not what. Most of the non-obvious code here exists
  because of a specific failure; say which one.
- Match the surrounding code. Prefer deleting a dependency over adding one —
  the DSP, the router and the crowd cheer are all hand-rolled for that reason.

## UI polish conventions (the AAA pass)

The player-facing screens (all but admin/themes/editor) share one vocabulary.
New screens and elements should reuse it rather than invent parallel systems:

- **Motion is four verbs, defined once in `styles.css`.** `.rise` (fade + slide
  for entrances), `.pop` (scale-in for small elements), `ui-slam` (the moment —
  grades, milestones), `ui-sheen` (idle shine). Stagger comes from an inline
  `--i` on the element (`animation-delay: calc(var(--i) * 55ms)`), so JSX owns
  order without new CSS. **Every decorative animation has a
  `prefers-reduced-motion` off-switch** — extend the existing blocks, do not
  ship motion without one.
- **Route changes animate via the keyed `.screen` wrapper in `App.tsx`.** Play
  is deliberately unwrapped — its canvas manages its own phases and must never
  fade.
- **`--font-display` (Space Grotesk Bold) is for signage only** — logo, titles,
  grades, the countdown, primary buttons. Only the **Bold** weight ships,
  declared over the `400 700` range in the `@font-face` so display rules can say
  `font-weight: 400` and still render it with no synthesis; never pair it with an
  even heavier bold. Numbers that tick every frame (HUD score/accuracy) stay on
  `--font` regardless, so their width does not wobble at 60fps. Body copy stays
  on the system stack.
- **UI sound is `uisfx.ts`, hand-rolled WebAudio like the crowd cheer** — the
  palette is data (`UI_SOUNDS`) so it is unit-tested without an AudioContext.
  `playUiSound(name)` never throws and no-ops when muted; the mute flag is
  cached exactly like `haptics.ts` caches its mode (no localStorage in a tap
  path). Positive cues rise in pitch, negative ones fall — a test enforces it.
- **New HUD feedback stays ref/CSS-driven from the render loop, never React
  state** (the 60fps trap below). Milestones, the combo-tier scale, the
  combo-break vignette and the judgement pop are all class toggles /`--var`
  writes on ref'd elements; the combo maths lives in the pure, tested
  `game/combo.ts`.
- **`accentVars(accent)` (`accent.ts`) is how a screen repaints in a song's
  theme colour.** The accent carries through the flow: menu detail panel →
  ready → play → results. The shared `RetroBackdrop` glow follows it **only on
  results** (the finished run's colour behind the card). The menu backdrop was
  tried and reverted: it lists every song, so tinting the whole screen to the
  current selection lurched between colours as you browsed and mixed badly with
  the gold stage — the menu's accent stays contained to the detail panel.
  `TIER_COLORS` / `TIMING_COLORS` are the one thing it must **not** touch — see
  the theming invariants.

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
  song in admin. **The shell follows the theme on results only** (AAA pass):
  `RetroBackdrop` takes an optional `accent` and `App.tsx` feeds it the finished
  run's accent so the glow behind the card matches it. The menu was tried and
  reverted — it lists every song, so tinting the whole screen to the current
  selection mixed badly with the gold stage; the menu keeps its accent contained
  to the detail panel. The remaining follow-up is whether a theme should change
  note *shape* as well as colour.
- **Editor:** E1 (read-only timeline) is built at `/edit/:songId/:difficulty`.
  E2 (global timing offset + save + `customChart`) and E3 (note editing with
  undo/redo) are designed in PLAN.md §6c but not built. E2 is the highest-value
  next piece: one slider fixing a whole chart's timing beats editing notes.
- **Chart feel is still untuned** (milestone M3). Only a human can judge it. The
  hit windows have been widened twice (`judge.ts`) and are a feel knob, not a
  fixed truth — but they are **capped per difficulty**: `good` may not exceed
  that chart's own `minGapSec`, because `hitLane` matches the nearest note and a
  window wider than the spacing can retire the note *after* the one the player
  aimed at. `hitWindowsFor(minGapSec)` enforces this — it scales the three tiers
  down together for any chart tighter than the 190ms base, and the engine takes
  it via `EngineOptions.minGapSec` (passed from `PlayScreen`). `engine.test.ts`
  asserts every difficulty's window stays within its gap. If a *single* fast
  passage feels unfair, raise that difficulty's `minGapSec` and regenerate.
- **Four difficulties: easy/medium/hard/extreme** (§2.3). Adding one is a
  `DifficultyName` union member, a `DIFFICULTY_NAMES` entry and a `DIFFICULTIES`
  row — everything downstream (menu picker, router, editor dropdown,
  `generateAllCharts`, CLI) iterates the list. TypeScript's exhaustiveness on
  `Record<DifficultyName, …>` catches any hand-written literal you miss.
  **Extreme spaces tighter than hard — on purpose.** That is only safe because
  the miss window is per difficulty (`hitWindowsFor`), so Extreme judges on a
  correspondingly tighter window while easy/medium/hard keep the base 190ms.
  Both spacings are now beat-relative (0.28 vs 0.38 beats, floored at 140ms and
  190ms) — see the spacing entry under Charts; the floors are what those window
  numbers refer to, and they bind at 120 BPM and above.
  It escalates further via `approachSec` (0.95s — faster scroll), `targetNps`
  and `chordChance`. Do not reintroduce a single global miss window; it was what
  capped Extreme's density. Existing songs get the new chart on regenerate/
  re-ingest, like any chart change.

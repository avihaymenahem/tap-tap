# Tap-Tap — Plan

A browser rhythm game. Music is ingested from YouTube links by an admin, analyzed
offline into beatmaps, and served locally. Players pick from a curated list.

**Personal / local-only project.** Do not deploy publicly — see [Legal](#8-legal).

---

## 1. Core architectural decisions

### 1.1 YouTube is an ingestion tool, not a runtime dependency

The backend downloads audio with `yt-dlp` in order to analyze it, so it **serves
that audio to the game** rather than embedding the YouTube iframe player.

This deletes the hardest problem in the project:

| With YT iframe at runtime | With self-hosted audio |
| --- | --- |
| `getCurrentTime()` ~250ms granularity | `audioCtx.currentTime` sample-accurate |
| Needs `performance.now()` interpolation | Not needed |
| Needs drift detection + resync | Not needed |
| No FFT access (cross-origin) | Full FFT every frame |
| Seek is slow and imprecise | Instant, exact |

There is no YouTube code in the frontend at all.

### 1.2 TypeScript everywhere, no Docker, no Python

The original plan used Python + `essentia` in Docker. That was dropped: `yt-dlp`
and `ffmpeg` are standalone binaries invoked over a CLI from any language, and
the analysis is written directly in TypeScript. Consequences:

- One language across the stack, and `shared/` is the **single source of truth**
  for the beatmap contract — the server cannot emit a shape the game rejects.
- Docker's only justification was that `essentia` is painful to build on Windows.
  With the DSP in TS, that reason disappeared; setup is `npm install`.
- The DSP is ours, so every parameter that affects chart feel is tunable in one
  place rather than behind a WASM wrapper.

`ffmpeg-static` and `youtube-dl-exec` vendor both binaries as npm dependencies.

### 1.3 Game state contains zero three.js

`web/src/game/` is pure TypeScript — clock, judge, scoring, chart playback. It
imports nothing from three.js and is unit-tested with no WebGL context.
`web/src/render/` reads that state each frame and draws it. The scene graph is a
*view*, never the source of truth.

### 1.4 `laneCount` is a parameter, never a constant

| Difficulty | Lanes | Keys |
| --- | --- | --- |
| Easy | 3 | `S D F` |
| Medium | 4 | `A S D F` |
| Hard | 5 | `A S D F G` |

Left hand only, scaling outward. Every module takes `laneCount` as input.

### 1.5 The clock is the audio, always

`audioCtx.currentTime` is the master clock. Never `setTimeout`, `setInterval`, or
frame deltas for game timing. `requestAnimationFrame` drives *rendering only*.

---

## 2. Ingestion pipeline

```
yt-dlp           audio stream + title / duration / thumbnail
ffmpeg           44.1kHz mono f32 PCM (analysis) + AAC/m4a (playback)
analysis/        FFT → spectral-flux onsets → autocorrelation tempo
charts/          one chart per difficulty
media/<songId>/  audio.m4a, thumb.jpg, beatmap.json, analysis.json
```

There is no database. Beatmaps are JSON blobs nothing queries inside, so a
directory per song is the whole storage layer. `analysis.json` caches the onset
pool, so regenerating charts never re-downloads or re-analyzes.

### 2.1 Lane assignment by frequency band

**The highest-leverage decision in the generator.** Onsets are assigned to lanes
by frequency band — low/kick left, mid/snare centre, high/hats right — so the
player's hands mirror the kit. Random lane assignment is the usual reason
auto-generated charts feel like noise.

**How the band is chosen matters more than the idea.** Three approaches were
tried; only the third survives contact with real music:

1. *Largest absolute band energy.* Fails badly. It answers "which band is
   loudest?", which is a property of the **mix**, not the moment — a bright,
   hat-forward master answers "high" on every single onset. This produced a
   real chart with a **0% / 0% / 100%** lane split: every note in one lane.
2. *Energy divided by a per-band baseline.* Better, but a band with no real
   signal divides numerical noise by numerical noise, an unbounded ratio, so a
   pure bass note could classify as "high" on float error alone. Summing raw
   magnitude also measures bandwidth rather than tone: the treble band spans
   ~650 bins against ~12 in the bass, so the widest band tends to win.
3. **Percentile rank within each band's own distribution across the track.**
   For every onset, rank its low/mid/high energy against every other onset in
   the song, and take the band where it ranks highest — "which band is this hit
   most exceptional in?". Scale-free: invariant to brightness, gain, and bin
   count alike, and *structurally incapable* of returning a constant answer,
   which is what makes the one-lane failure impossible rather than unlikely.

Measured lane spread on the starter library after the change (easy, 3 lanes):
every song uses every lane, worst case 47% in one lane, against several songs
that previously left a lane completely unused.

### 2.2 Timing fidelity: onsets are truth, the grid is a guess

Two bugs made early charts feel unrelated to the music. Both are now regression-tested.

**Frame-centre timing.** Onsets were reported at `frameIndex * hopSize`, the
*start* of the 2048-sample analysis window. A transient enters that window up to
46ms before the reported frame, so every onset landed ~20-25ms early. Onset times
and the beat grid now share a `frameSize/2` origin.

**Conservative snapping.** The beat grid is extrapolated from one constant tempo,
so it drifts on anything not machine-perfect — 0.5 BPM of error is over a full
beat across three minutes. Snapping every onset onto that grid dragged correctly
timed notes progressively further out of sync. Snapping now only applies when the
grid *already agrees*, within `min(25% of grid spacing, 30ms)`. Below 30ms is
imperceptible, so snapping can tidy jitter but can never itself cause drift.

### 2.3 Difficulty as a filter over one shared onset pool

| | Quantize | Min gap | Chords | Target notes/sec | Approach | Lanes |
| --- | --- | --- | --- | --- | --- | --- |
| Easy | 1/1 beat | 450ms | no | ~1.2 | 1.9s | 3 |
| Medium | 1/2 | 300ms | rare | ~2.0 | 1.6s | 4 |
| Hard | 1/4 | 190ms | yes | ~3.6 | 1.3s | 5 |
| Extreme | 1/4 | 190ms | often (~0.32) | ~4.6 | 1.0s | 5 |

Onsets are ranked by strength; each difficulty takes the strongest that satisfy
its spacing constraint. Generation is seeded and deterministic, and
`generateAllCharts` is driven off `DIFFICULTY_NAMES` — a difficulty added to the
shared list is generated with no second edit.

**Extreme shares hard's 190ms gap on purpose, and cannot go below it.** The
`good`/miss window equals the tightest `minGapSec` across every difficulty
(`judge.ts`, asserted in `engine.test.ts`), because `hitLane` matches a tap to
the *nearest* note — a window wider than the spacing lets a tap retire the wrong
note and the game eats inputs. So extreme takes its difficulty from everything
the gap does not cap: a 1.0s approach (notes cover the highway ~23% faster than
hard, the real reading wall), a higher average density that sits nearer the
shared ceiling, and roughly double the chords. On a saturating pool it can tie
hard's note count; on a real track the shorter approach and extra chords are
where it bites. `minGapSec` is still the lever if a mode ever needs to be
genuinely denser — but that means *raising* everyone's window is impossible
without raising the floor, so the answer is a wider highway or faster scroll,
not tighter spacing.

**`minGapSec` is the knob that governs how hard a chart feels, not `targetNps`.**
The target only sets the average across the whole song, while the gap sets a hard
ceiling on a sustained stream at `1 / minGapSec` notes per second. Set the target
generously against a tight gap and the generator fills to the cap and packs every
note onto the spacing floor — the result is a wall of evenly spaced notes rather
than a rhythm.

That is exactly how the first calibration failed: medium at a 200ms gap produced a
median gap of 238ms, which on a 126 BPM track is a note on every eighth note for
four minutes across four lanes. Measured on "Shiver", recalibration took medium
from 3.16 to 1.78 notes/sec average and, more importantly, its worst four-second
window from 4.50 to 2.25 notes/sec.

A useful sanity check against any song: quarter note = `60 / BPM` seconds, eighth
is half that. Medium's gap should fall *between* the two so it can place eighths
as accents without being able to place every one. Note this makes medium's
character tempo-dependent — at 126 BPM a 300ms gap forbids eighths entirely, so
medium is quarter-notes-only there. Lowering it toward 250ms buys eighth-note
variety back at the cost of difficulty.

Diagnosing a chart that feels wrong is easier from the numbers than from playing
it: compare average notes/sec, the worst four-second window, and the median gap.
If the median gap is sitting near `minGapSec`, the chart is saturated.

### 2.4 Note density must track musical intensity

The onset detector's threshold is `reference × thresholdMultiplier`, where the
reference blends the *local* median of the ODF with the track's *global* median,
weighted by `localAdaptivity`.

A purely local threshold (`localAdaptivity: 1`) sounds correct and behaves badly.
A dense, loud section raises its own bar: sustained distorted guitar keeps the
local median high, so almost nothing clears it, while a sparse verse gets a low
bar and passes everything. Measured on "Numb", the correlation between
per-second loudness and per-second onsets was **-0.036** — the choruses had the
*fewest* notes in the song, which is the exact opposite of what the music does.

Blending toward a global reference fixes the sign; lowering the multiplier
restores the density that blending costs. Tuned by sweeping both against that
track, the defaults now score about **+0.75** correlation with roughly 5 onsets
per second available to the generator.

This is worth re-checking whenever the detector changes, and it is a much better
signal than listening: decode the audio, take per-second RMS, take per-second
note counts, and correlate. Anything near zero or negative means the charts are
fighting the music.

**The threshold is clamped, not blended.** A linear blend toward the global
median fixes loud sections starving themselves and immediately causes the
opposite failure: a track with a quiet intro under a loud body detects *nothing*
for its first minute, because the intro is being measured against the chorus.
`minReferenceRatio` / `maxReferenceRatio` clamp the local median into a band
around the global one instead, so it stays locally adaptive without running away
in either direction. Swept against both failure cases at once — below 0.6 the
loudness correlation collapses, at 0.75 and above the quiet intro goes dead.

### 2.5 Analyze the file you actually play

Analysis decodes `audio.m4a`, the same file the browser loads — **not** the
original yt-dlp download.

Analyzing the source and playing the transcode means every note is timed against
audio nobody hears. AAC adds priming samples (~20-50ms of encoder delay) and
reproduces quiet passages differently, and the two disagreed by more than twenty
seconds about where a soft intro's first onset even was. Any future format change
must preserve this: analyse the artefact that ships.

### 2.6 Note budget is allocated per section, not globally

`selectNotes()` splits the song into 8-second windows and gives each a quota —
a floor, plus a share of the remaining budget proportional to that window's onset
energy.

Ranking every candidate globally by strength looks right and starves quiet
passages completely. The budget is `targetNps × duration` while the detector
offers roughly three times that many candidates, so the cap binds; and because
every onset in a quiet passage is weak in *absolute* terms, all of them lose to
the loud sections. A track with a soft intro got literally one note in its first
minute. Windowing keeps loud sections denser — dynamics survive — while
guaranteeing no section with audible content comes out empty.

Genuinely silent stretches still produce nothing: the floor is capped by how many
candidates a window actually has.

### 2.7 Beatless intros are skipped, not filled

Some tracks open with 30 seconds of atmosphere containing no percussive onsets at
all. The chart is correctly empty there, so playback starts near the point the
chart *gets going* — the first note with several others close behind, not merely
the first note, since an atmospheric intro can hold one isolated hit and then
nothing for another 20 seconds.

Notes before that offset are dropped from the run. Leaving them in would have the
engine retire every one as a miss the moment the clock starts past them, ruining
the score before the player touches a key.

### 2.8 Beats are tracked, not extrapolated — and confidence measures them

Two generations of failure led here, both regression-tested:

**Generation one: quantized constant grid.** Tempo was quantized to whole ODF
hops (~11.6ms of period — ~2.8 BPM steps at 120), and §2.2's rule of thumb is
that 0.5 BPM is a full beat of drift over three minutes. The conservative
snapping meant this never *corrupted* charts, but it silently disabled the
grid: past the first minute nothing agreed with it. Fixed by log-compressing
the tempo ODF (locally — the onset detector's swept thresholds still see the
raw ODF, §2.4), harmonic lag aggregation (a candidate scores its own
autocorrelation plus half the score at double its lag, which demotes the
classic double-time error), parabolic lag interpolation, and a joint
period+phase polish. Worst end-of-track drift on 90s click tracks: ~350ms →
3–8ms.

**Generation two: the constant grid itself.** A single (period, phase) is only
right for machine-quantized music. Anything played by humans drifts a few
percent, and against that a constant grid is wrong everywhere except one lucky
stretch — so honest confidence read low on real songs ("confidence is way too
low"), and dishonest confidence (the old autocorrelation z-score) read low for
a *different* reason: real music correlates at every harmonic of its tempo,
inflating the field the winner was judged against, so only metronomes scored
high. The fix for both is `trackBeats` — Ellis-style dynamic programming over
the compressed ODF. Each beat lands where the music actually put it, paying a
penalty for straying from the estimated period (`TIGHTNESS = 10`: halving the
gap onto the hats costs more than a hat is worth — the double-time regression,
measured at tightness 3 — while a human ramp's ~3% gap changes cost nearly
nothing). Beats are refined to sub-frame positions against local ODF peaks.
The wire format was already `beatGrid: number[]`, so nothing downstream
changed shape; `buildGrid` subdivides between consecutive beats and works
unmodified. Measured on a 118→126 BPM ramp: every beat within 5ms of the
clicks, where any constant grid is off by whole beats.

**Confidence is four direct measurements of the tracked beats**, each covering
another's blind spot; BPM is the interquartile mean of the tracked gaps:

- **Beat contrast** — energy per beat vs. the track average. Catches "no beat
  here"; blind on sparse audio, where beats overfitted onto a near-silent
  baseline tower over the average.
- **Beat hit rate** — fraction of beats on above-average energy. Catches the
  sparse-overfit case; blind on dense uniform activity, where contrast is
  honestly low.
- **Gap steadiness** — share of inter-beat gaps within ±12% of the typical
  gap, rescaled so chance-level regularity maps to 0. *The* discriminator now
  that beats are tracked: the tracker will faithfully follow arrhythmic hits
  (its job), and those beats pass every energy measure — their scattered gaps
  are what give them away. Caps the final blend outright, because onsets
  align with tracked beats *by construction*, so alignment must never rescue
  an unsteady pulse.
- **`gridAlignment`** — fraction of the stronger half of onsets within a tight
  tolerance of a beat or half-beat (nearest-beat search — the grid is no
  longer uniform), rescaled against chance; null (not a fake neutral) when
  there are too few onsets to judge.

`bpmConfidence = min(steadiness, 0.45 × min(contrast, hitRate, steadiness) +
0.55 × alignment)`. Measured: metronome, backbeat, jittered groove and
full-mix fixtures 0.85–1.0; the 118→126 ramp ~1.0 (a human performance is not
punished for being human); irregular aperiodic clicks 0.0–0.04.

`analysis.json` carries an `analysisVersion` stamp, and `regenerateCharts`
re-analyzes from `audio.m4a` when the stamp is stale (best-effort, one decode
per song per version) — so the existing library picks these fixes up through
the Regenerate button instead of being stranded on day-of-download grids.

### 2.9 Handcrafted feel: contour lanes, on-beat selection, on-beat chords

Play feedback: charts felt "drum machine" — locally defensible, never a phrase.
Three causes, all fixed in generation, all keyed off the (now meaningful)
`bpmConfidence` at `MIN_GRID_CONFIDENCE = 0.5`:

- **Lanes follow the melodic contour instead of dice.** `pickLane` chose
  randomly among non-repeat lanes in the band's range. `pickLaneContour` maps
  each note's spectral-centroid *rank within its own band* (§2.1 reasoning:
  relative brightness describes the phrase, absolute describes the mix) across
  the range — a riff that climbs in pitch walks left-to-right, a falling line
  walks back. Flat stretches step in the current sweep direction and bounce at
  the edges, so a same-pitch stream becomes a roll rather than a jackhammer or
  a zigzag. Easy is untouched by construction: its bands are single lanes.
- **On-beat onsets win crowded neighbourhoods.** Selection ranked purely by
  strength, so when a beat and a slightly-louder off-beat scuffle both could
  not fit inside `minGapSec`, the player got the scuffle. On a trusted grid,
  grid-aligned onsets get a 1.2× selection multiplier — strength still
  dominates, but ties inside a spacing conflict now resolve to the pulse.
- **Chords only land on the grid.** An off-beat two-hand hit is something a
  human charter essentially never writes; on the beat it reads as an accent,
  off it it reads as a mistake.

Below the confidence line all of it disarms — no snapping, no bonus, no chord
gate — and the chart is pure measured onsets, exactly as before.

---

## 3. Data contract: beatmap JSON

Defined once in `shared/src/beatmap.ts` and imported by both workspaces.

```jsonc
{
  "version": 1,
  "songId": "dQw4w9WgXcQ",        // YouTube video id, also the primary key
  "title": "...", "artist": "...",
  "duration": 213.4,
  "audioUrl": "/media/<id>/audio.m4a",
  "thumbnailUrl": "/media/<id>/thumb.jpg",
  "bpm": 128.0,
  "bpmConfidence": 0.87,          // < 0.5 → the admin UI warns
  "beatGrid": [0.52, 0.99],
  "charts": { "easy": { "laneCount": 3, "notes": [{ "t": 1.02, "lane": 0, "type": "tap" }] } }
}
```

Notes are sorted ascending by `t`. The judge relies on it.

---

## 4. Timing and judgement

A hit has **two independent properties**, and keeping them separate is the point:

- **tier** — how close, ignoring direction: `perfect` ±45ms, `great` ±90ms, `good` ±135ms
- **timing** — which side: `exact` (within ±22ms), `early`, or `late`

Tier drives the score (300/200/100), and an `exact` hit earns a **1.25× bonus**, so
landing dead-on beats landing early or late in the same tier. Early and late score
identically as each other — both are equally wrong — but are *counted* separately
and shown distinctly, because "you are consistently 40ms early" is actionable
feedback in a way that "GOOD" is not. The results screen surfaces the split and the
signed mean offset, and suggests calibration when a real bias shows up.

Accuracy deliberately excludes the exact bonus: it measures tier quality, so 100%
stays reachable and keeps meaning something.

**Lead-in.** Play begins with a 3-second countdown. `AudioClock.start()` schedules
playback at `ctx.currentTime + leadIn`, which makes `currentTime` negative during
the count — the countdown falls out of the same arithmetic instead of needing a
separate timer, and notes approach during it so the first note is readable.

**Calibration.** A metronome screen measures the player's median offset and stores
it; the engine subtracts it from input times. Bluetooth can add 150-300ms.

**Pause.** `Escape` or the on-screen button pauses; `Escape`/`Space` or Resume
continues after a 3-second countdown. Escape deliberately pauses rather than
quitting — losing a run to a stray keypress is worse than one extra click to
leave. Quit and Restart live in the pause menu.

Pausing records the position, stops the source, and leaves `currentTime`
reporting that frozen value, so the render loop keeps running and the engine
judges nothing while paused. Resume needs the *opposite* lead-in behaviour from
the opening countdown: on first start, time runs negative so notes approach
during the count, but on resume time must freeze at the pause point — otherwise
the countdown scrolls silently through notes that are still coming and the engine
marks every one of them missed. Hence the `freezeDuringLeadIn` flag on
`AudioClock.start()`.

---

## 5. Repo structure

```
tap-tap/
├─ shared/src/        beatmap + difficulty contract (single source of truth)
├─ server/src/
│  ├─ analysis/       fft, onsets, tempo  (+ synthetic-audio tests)
│  ├─ charts/         lane assignment, difficulty filters
│  ├─ ingest/         yt-dlp, ffmpeg, pipeline
│  ├─ cli/ingest.ts   URL in, beatmap out
│  └─ index.ts        Express API on :8787
└─ web/src/
   ├─ game/           PURE TS — clock, judge, engine (unit tested)
   ├─ render/         three.js highway, palette
   ├─ screens/        menu, play, results, calibration
   └─ admin/          ingest UI
```

The server binds `TAP_TAP_SERVER_PORT`, **not** `PORT`: it runs alongside Vite
under one `npm run dev`, and a generic `PORT` in the environment gets applied to
both, so whichever binds first steals the other's port.

### Routing

Every screen has a real URL: `/`, `/play/:songId/:difficulty`,
`/results/:songId/:difficulty`, `/calibrate`, `/admin`.

Hand-rolled over the History API rather than pulling in react-router — five flat
routes, no nesting, no loaders, no data layer. Doing it in `web/src/router.ts`
keeps the `Route` union as the single source of truth: `parseRoute` is a **total**
function returning that union, so the screen switch stays exhaustive and a
malformed URL cannot produce a route the app fails to handle. Anything
unrecognized resolves to the menu, and the address bar is then rewritten to match
so it never shows a path the app is not actually on.

**Results is the awkward one.** A score breakdown cannot live in a URL, but
`/results/...` still has to survive a reload — it is the screen a player is most
likely to sit on and refresh. The run is written to `sessionStorage` keyed by
song and difficulty; opening a results URL with nothing matching redirects to the
menu. Session scope is deliberate, so a stale result cannot resurface in a new
visit pretending to be current.

Navigating from a finished run to results uses `replace`, so Back from the
results screen returns to the song list rather than dropping the player into
another run of the same chart.

### Haptics

Vibration feedback, in `web/src/haptics.ts`. Three modes — **off**, **on hits**
(default), **on misses** — cycled from the menu.

The first version encoded a lot of detail and felt bad to play. Three reasons,
all worth remembering:

1. **Vibrating on a miss is confusing.** A miss is a note the player did *not*
   tap, so the buzz has no causal link to anything they did and reads as random.
   It is now opt-in rather than default.
2. **Detail was inverted.** Worse hits buzzed longer (perfect 8ms, good 22ms),
   so playing badly produced *more* feedback. All hits now feel identical.
3. **The hardware cannot render short pulses.** Phone vibration motors need
   roughly 20-30ms to spin up and down, so an 8ms request comes out as weak
   mush, and pulses closer than a couple hundred milliseconds smear together.
   Encoding finer distinctions than the motor can reproduce does not produce
   subtlety, it produces inconsistency. Hits are a single 18ms pulse.

Misses, when enabled, are throttled to one buzz per ~320ms: a dropped combo
retires several notes within a few frames, and untreated that is one long drone.

**No support on iOS Safari.** There is no web haptics API there at all, so this
is Android and desktop Chrome only. The control hides itself entirely where
`navigator.vibrate` is missing — an inert switch is worse than no switch.

### Lane feedback

Pressing a lane lights **the whole lane strip**, not a shape at the hit line.
The floor shader's flash term carries a constant component along the lane's full
length plus a stronger near-field component; with only the near-field term the
highlight collapses onto the hit line and reads as a separate object rather than
as "this lane". An earlier version used a vertical light column standing at the
receptor, which just looked like a beam shooting off the top of the screen.

### Rendering notes: core and glow are separate meshes

A note is drawn twice — an opaque pill, and a soft additive halo on the lane
beneath it. That separation is load-bearing.

Driving both from one brightness value means the ramp has to straddle the bloom
threshold, and it fails at both ends: distant notes fall under it and do not glow
at all, near ones blow well past it and clip to white, losing the silhouette
exactly when the player needs to read it. With the halo carrying the glow, the
core can sit *below* the bloom threshold permanently and stay crisp at every
distance, while the halo scales its intensity and size with proximity.

Notes are opaque and the halo is transparent, so three.js draws the core first
and depth-rejects the halo behind it — the glow reads as light spilling around
the pill rather than washing through it.

### Fitting the board to the screen

`PerspectiveCamera.fov` is *vertical*, so horizontal coverage shrinks with the
aspect ratio. At the desktop FOV a five-lane board runs off both sides of a
portrait phone. `fovFor()` widens the FOV only as far as the viewport requires —
desktop is untouched — clamped at 96°, past which the distortion is worse than
the crop.

### Playing on a phone

Both servers bind all interfaces, so open the Network URL Vite prints (something
like `http://10.0.0.25:5173`) on a device on the same Wi-Fi. Only that one URL is
needed — `/api` and `/media` are proxied server-side, so the phone never contacts
the backend port directly.

This exposes the game to your local network. Fine at home; don't do it on shared
or public Wi-Fi. If a phone cannot connect, it is almost always the Windows
firewall prompting for Node on a private network.

Touch works — the canvas is divided into `laneCount` vertical zones — but the
layout and hit windows are tuned desktop-first. Run the calibration screen on the
phone before judging the timing: mobile audio output, and Bluetooth especially,
adds latency that no amount of chart tuning will compensate for.

---

## 6. Milestones

- [x] **M1 — Ingest end-to-end.** URL in, beatmap JSON out. ~10s for a 130s track.
- [x] **M2 — Playable core.** 3 lanes, judge, score, combo, results.
- [ ] **M3 — Tune the generator.** Charts must *feel* good. **Requires a human.**
- [x] **M4 — three.js highway + juice.** Perspective lanes, bloom, particles, starfield.
- [x] **M5 — Admin panel.** Ingest by URL, job status, regenerate, delete.
- [x] **M6 — Medium/Hard.** 4 and 5 lanes generated and selectable.

M3 is the only step that cannot be automated: generated charts always feel wrong
at first, and fixing that is iterative human judgement against the onset filter.

### Tuning guide for M3

Everything that affects chart feel lives in two files:

- `server/src/analysis/onsets.ts` → `DEFAULT_ONSET_OPTIONS`
  - `thresholdMultiplier` — higher = fewer, more confident notes (start here)
  - `minSeparationSec`, `medianWindowFrames`
- `shared/src/difficulty.ts` → `DIFFICULTIES`
  - `targetNps`, `minGapSec`, `subdivision`, `chordChance`, `approachSec`

After editing difficulty params, hit **Regenerate** in the admin panel — it reuses
the cached onset pool and is instant. After editing onset options, delete
`server/media/<songId>/analysis.json` and re-run ingest.

If a song feels wrong everywhere, check `bpmConfidence` in the admin panel first.

---

## 6b. Starter library

Five Creative Commons (CC-BY) tracks, chosen to spread the analysis across very
different rhythmic profiles. Confidence tracks percussion clarity closely, which
is a useful sanity check that tempo estimation measures something real:

| Song | Style | BPM | Confidence |
| --- | --- | --- | --- |
| Digital Lemonade | electronic, steady kick | 120.19 | 0.79 |
| Volatile Reaction | driving rock / electronic | 156.61 | 0.69 |
| Funkorama | funk, syncopated | 101.33 | 0.67 |
| Monkeys Spinning Monkeys | ragtime / comedy | 143.55 | 0.53 |
| Ossuary 1 — A Beginning | dark ambient, no real percussion | 172.27 | 0.42 |

**Ossuary is deliberately a hard case, not a good chart.** With no percussion to
lock onto, tempo estimation has nothing to find — 172 BPM is almost certainly
spurious, and the low confidence correctly trips the UI warning. It is here to
exercise the degradation path: note density falls to 0.97/1.45/1.82 per second
because the generator emits only what it actually detected rather than inventing
notes to hit a density target. Useful for testing; not representative of feel.

## 6c. Level editor

Manual editing of auto-generated charts. **E1 is built** (`/edit/:songId/:difficulty`,
reachable from "Edit chart" in the admin panel); E2 and E3 are designed below.

### The core insight

This is not a blank-canvas editor, and building it as one would waste what we
already have. `analysis.json` holds **every onset the detector found**, including
the ones the generator rejected, each with strength and band content. The beat
grid is stored. The audio is local.

So the primary interaction is not "draw notes" — it is **promote and reject from
a candidate pool**. Every detected onset renders as a ghost; one click turns a
ghost into a note or a note back into a ghost. Fixing a section becomes a handful
of clicks on candidates the analysis already timed correctly, rather than hand-
placing notes and hoping they land on the beat.

Freehand placement still exists for the cases the detector missed entirely, but
it is the fallback, not the main path.

### Layout

Vertical timeline, lanes as columns, time flowing downward — the same mental
model as gameplay, so what is edited maps directly onto what is played. Canvas
2D rather than three.js: precision, crisp text and hairlines matter here, and
none of the 3D presentation does.

Alongside the lanes:

- **waveform** strip, so transients are visible as well as audible
- **beat grid** lines at a selectable subdivision (1/1, 1/2, 1/3, 1/4)
- **ghost onsets** — the unused candidate pool, dimmed
- **notes** — solid, per-lane colour, selected state

### Playback

`AudioClock` already does everything needed (start at offset, pause, fade), so
the editor reuses it rather than growing a second clock.

- `Space` play/pause from the cursor, drag to scrub
- **hit sounds on every note during playback** — non-negotiable. Alignment is
  verified by ear far more reliably than by eye, and a chart that looks right on
  a waveform can still feel wrong.
- optional metronome on the beat grid
- loop a selected region, for iterating on one section

### The highest-value tool is not note editing

A **global timing offset** slider for the whole chart. When a song feels
uniformly early or late — which the analysis can absolutely produce — one slider
fixes every note at once. It is a fraction of the work of editing notes and will
likely resolve more complaints than the rest of the editor combined. Build it
first.

### Persisting edits

`PUT /api/songs/:songId/charts/:difficulty`, and the saved chart is marked
`customChart: true`.

**Regenerate must not silently destroy hand edits.** This is the same class of
bug as a rename being reverted by re-ingest (§ `customName`), and it gets the
same treatment: Regenerate skips hand-edited charts unless explicitly forced,
and the admin UI says so rather than quietly discarding work.

### Architecture

- `web/src/editor/` — pure TypeScript: the chart document, edit operations,
  selection, and an undo stack. No DOM, no canvas, fully unit tested, exactly as
  `web/src/game/` is.
- `EditorScreen.tsx` — canvas rendering and input, reading that model.
- `GET /api/songs/:songId/waveform` — downsampled peaks, computed once and
  cached to disk next to the audio.

Keeping the document and operations pure is what makes undo/redo tractable and
testable; an editor whose state lives in the canvas is not something you can
write tests against.

### Milestones

- [x] **E1 — Read-only timeline.** Waveform, beat grid, notes, ghost onsets,
      playback, scrub, hit sounds. Seeing a chart against its audio is already
      most of the diagnostic value, before a single edit is possible.

      Implementation notes: coordinate math lives in `editor/view.ts` as pure
      functions with tests — a wrong time-to-pixel mapping reads as "the editor
      feels subtly off" and is miserable to chase through canvas code. Waveform
      peaks are cached at ingest (`waveform.json`, 20ms buckets) and built on
      demand for songs ingested before that existed. Hit sounds are scheduled
      ahead of the playhead through `AudioClock.contextTimeFor`, not fired when
      a frame notices a note — otherwise they inherit exactly the frame jitter
      the audio clock exists to avoid.
- [ ] **E2 — Global offset nudge.** One slider, applied to a whole chart. Save +
      `customChart` + Regenerate protection lands here.
- [ ] **E3 — Note editing.** Promote/reject ghosts, add, delete, move, snap,
      undo/redo, multi-select.
- [ ] **E4 — Comfort.** Copy/paste a section, mirror lanes, loop region,
      per-difficulty switching without leaving the editor.

Desktop-only: precise editing with a mouse is a different problem from playing
with thumbs, and trying to serve both would compromise the editor.

## 6d. Per-song themes

Chosen in admin, one theme per song, changing the lane colours, the receptor
rings, the ground grid and the sky. **Built** — T1–T4. The design below is as
written; see the progress log for the three places reality amended it (the sky
needed eight colours rather than three, palettes are authored in sRGB and
linearized at the shader boundary, and the ground grid reuses lanes 0 and 1).

### What a theme is, and where it lives

A theme is a **named palette in `shared/`**, referenced by id. The beatmap stores
`themeId: string`, never the colours themselves.

That indirection is the whole design decision. Storing resolved colours on each
beatmap would freeze every existing song against whatever the palette looked like the day
they were ingested — retuning a theme later would mean rewriting every beatmap
that used it, and a theme could never be fixed centrally. An id keeps the palette
editable in one place and makes a song's theme a two-word diff.

`shared/` is the right home because the id crosses the wire: the server persists
it, the admin panel lists the options, and the web app resolves it to colours.
Redeclaring the palette in `web/` would break the single-source-of-truth rule.

```ts
export interface Theme {
  id: string;
  name: string;             // shown in admin
  /** At least 5. `laneCount` is 3/4/5 and indexes straight into this. */
  lanes: readonly number[];
  hitLine: number;
  /** Sky gradient; without these a "warm" theme still sits under a violet sky. */
  skyTop: number;
  skyHorizon: number;
  skyGlow: number;
}
```

Five lane colours minimum is a hard requirement, not a convention — `laneColor`
indexes by lane and hard difficulty uses five. A four-colour theme silently wraps
and gives two lanes the same colour, which is unplayable rather than ugly.

### The awkward part: `laneColor` is a free function

Today `laneColor(lane)` reads a module-level constant, and eight call sites across
`highway.ts` and `editor/timeline.ts` depend on that. Themes make colour a
property of the *song*, so it has to become `theme.lanes[lane]`.

Two ways to thread it, and the choice matters:

- **Pass the theme in** — `Highway` takes it as a constructor option, the editor
  takes it as a prop. More call sites to touch, but rendering keeps reading state
  it was handed, which is the existing invariant.
- **A module-level "current theme"** — one line, and wrong. It is global mutable
  state that the play screen and the editor can disagree about, and it would make
  `laneColor` impure, so the editor's coordinate tests would start depending on
  load order.

**Take the first.** The extra plumbing is the point.

### Scope: lanes and rings are not enough

The ask is "lines and circles", but stopping there produces an incoherent result:
a warm-orange track under the hardcoded violet sky reads as a bug. The sky
gradient literals in the backdrop shader (`vec3(0.002, 0.001, 0.009)` and
friends) have to become uniforms driven by the theme.

That is the largest single piece of work here, and it is why this is not a
half-hour job. Everything else is plumbing.

Judgement colours (`TIER_COLORS`, `TIMING_COLORS`) stay **global and untouched**.
They mean perfect/great/good/early/late, and recolouring them per song would
destroy the one visual language the player learns once and relies on everywhere.

### Backward compatibility

Every existing beatmap lacks `themeId`. Resolution must be total:

```ts
themeFor(id: string | undefined): Theme   // unknown or missing -> DEFAULT_THEME
```

`DEFAULT_THEME` is the current five colours, so every pre-theme song renders exactly
as they do now and no migration is needed.

### Persistence, and the trap

`PATCH /api/songs/:songId` already handles rename; theme is another optional
field on the same route, validated against the known ids server-side — an
unrecognised id must be rejected rather than stored, or a typo becomes a song
that silently renders default forever.

**The trap is `regenerateCharts`.** It rebuilds a beatmap from `analysis.json`,
and it already has to preserve `customName`. Theme joins that list. Anything
hand-chosen in admin must survive a regenerate, or the feature quietly loses
work the same way a chart edit would.

### Milestones

- **T1 — palette + wire.** ✅ `Theme`, `THEMES`, `DEFAULT_THEME`, `themeFor` in
  `shared/`; `themeId` on `Beatmap` and `SongSummary`; PATCH validates against
  the known ids; both `regenerateCharts` *and* re-ingest preserve it. Tested:
  unknown id falls back, every theme carries >= 5 distinct lanes, regenerate
  keeps the id, absence stays absence.
- **T2 — render from the theme.** ✅ `Highway` takes a theme; `laneColor` takes
  one as its first argument; every sky literal and both ground-grid colours are
  uniforms. The `MAX_SHADER_LANES` padding was untouched — the lane *tints* are
  still padded to 8, and only their source changed.
- **T3 — admin picker.** ✅ Dropdown plus a five-swatch strip per row, since
  nobody recognises a colour scheme by the word "Arctic". Live preview would
  still be better but needs the play screen; deferred.
- **T4 — editor follows.** ✅ `TimelineData` carries the theme, so an edited
  chart looks like the song it belongs to.

Re-ingest preservation was not in the original milestone list and should have
been: `regenerateCharts` spreads the existing beatmap and kept `themeId` for
free, but the ingest pipeline builds a fresh one and silently dropped it — the
identical trap `customName` already documented, one line away from the comment
warning about it.

## 6e. The 80s theme outside the game

The play screen had a synthwave sunset while the menu, results, calibration and
admin were flat dark panels, so the game looked like one product and the shell
looked like another. `components/RetroBackdrop.tsx` closes that gap: sky, star
field, striped sun, lit horizon and a scrolling perspective grid, all pure CSS
and no assets.

**One fixed layer, rendered once in `App`, not per screen.** A per-screen
background would make the sun jump every time the player moved between the menu
and the results card. Play and edit are excluded — play draws its own sunset in
three.js, and two suns at different scales fight; the editor is a workspace
rather than a place.

Decisions worth keeping:

- **`--horizon` is the one knob.** The sky gradient, the sun, the horizon line
  and the grid all key off it. Moving it moves the scene together, which is the
  whole reason it exists as a token.
- **It sits at 78%, not the poster's 50%.** At poster height the sun lands
  squarely behind the song list and reads as a smudge. High up, the sky occupies
  the header strip where nothing competes with it and the grid gets the rest —
  the scene is legible exactly where the UI is empty.
- **The lit horizon line does more work than the sun.** A hard bright line
  survives being seen through a translucent card; a soft disc does not.
- **The sun is pink all the way up.** The poster's yellow core turns beige behind
  a translucent panel and reads as a rendering artefact.
- **Panels went translucent** so the scene shows through, which is what ties the
  screens together. That made every transparent form field a bug — the sunset
  showed *inside* the search box — so inputs are now dark and opaque.
- **Two escape hatches.** Admin passes `dim` (rows of small text and icon
  buttons at full strength put the sun in the middle of the toolbar), and under
  560px the sun is hidden outright: on a phone the content is edge to edge and
  the disc comes out as a nub poking above the first card.

This is presentation only — no logic, so nothing here is unit tested; it is
verified by screenshot. When per-song themes (§6d) land, this backdrop should
read its colours from the same tokens rather than growing a second palette.

### Meeting it in the game

The play screen was already synthwave but did not match: its sun had a yellow
crown that read as cream, and the track floated in black space while the menu
behind it had a full grid floor. Two changes closed the gap.

**The sun went pink all the way up**, the same call as the CSS one and for the
same reason.

**`buildGround()` puts the neon grid under the highway.** It is cut out beneath
the track, because the floor is translucent and grid lines would otherwise run
through the lanes and across the notes. It stops in front of the backdrop plane,
because that plane has `depthWrite: false` and cannot occlude anything — geometry
running past it draws over the sky. And it uses its own lift loop rather than
`bendToCurve`, which would apply the track's taper to the ground and leave the
sky showing through wedges either side of the horizon.

The first version was far too bright: linear 0.42 pink, which ACES and the sRGB
curve lift to near-white, and it buried the lanes it was supposed to sit behind.
It is 0.15 now. The rule from §4 holds — the notes are the subject and the
scenery loses.

## 6f. Long notes

Notes you press and **hold** through a duration, releasing at the end.
**Built, then switched off** — L1-L4 all landed and work, but they did not play
well enough to keep on. `holdShare` is 0 on every difficulty, which is the whole
off-switch: `applyHolds` returns immediately on a zero budget and no other part
of the feature ever fires.

Nothing was deleted. The engine state machine, the input handling, the renderer
and ~50 tests are all still here and still green — the generation tests enable
holds explicitly so the mechanism cannot rot while it is dark. Restoring the
tuned `holdShare` values recorded in `difficulty.ts` re-enables it with no other
change, and `holds.test.ts` has a test asserting the disabled state so turning
it back on has to be deliberate.

**What to look at before re-enabling.** The last thing observed was that the
generator stacked too many at once, which is now capped at 2 — but the feel
problem was reported as broader than that, and it was never diagnosed further.
The likely suspects, in order: whether the body reads as sitting *on* the curved
track or floating above it (never visually verified — screenshots were broken
in that session), whether `HOLD_RELEASE_WINDOW` is anywhere near right, and
whether sustain detection is picking musically meaningful spans or merely
flat-enough ones. The measurements in the L1 entry below are the starting point.

### Wire contract

```ts
export interface Note {
  t: number;
  lane: number;
  type: 'tap' | 'hold';
  /** Seconds. Present only on holds. The note ends at `t + duration`. */
  duration?: number;
}
```

Optional `duration` rather than a separate `HoldNote` type or a parallel array:
every existing beatmap stays valid unchanged, exactly as `themeId` did. A chart
without holds is simply one where no note has a duration, so nothing needs a
migration and `BEATMAP_VERSION` does not move. Songs gain holds when they are
next regenerated, one at a time, and a half-migrated library is not a broken one.

### Where sustains come from — the part that decides the milestone order

Holds must correspond to something actually sustained in the music: a held
vocal, a pad, a cymbal ring. The onset pool cannot answer this. It records
*attacks*, and a sustain is defined by what happens between them.

The obvious move is to add sustain spans to `AnalysisResult`. **It is the wrong
one**, and the reason is operational rather than aesthetic: `analysis.json` is
the cache that lets `regenerateCharts` skip decoding, so a new field would be
absent from every song already ingested, and holds would require re-analysing
the whole library.

**Use the cached `Waveform` instead.** It already exists per song, at
`PEAKS_PER_SECOND = 50` — 20ms resolution, ample for deciding whether energy is
sustained — and the server already rebuilds it on demand for songs ingested
before waveforms were cached. So hold generation works on the existing library
with no re-analysis and no re-download.

A sustain is then: a span after an onset where the envelope stays above a
fraction of that onset's peak, no new onset interrupts it, and the span lasts at
least `minHoldSec`. That is a handful of array arithmetic over data already on
disk.

### The engine is where the real work is

Today a note has one terminal judgement and `engine.ts` never looks at it again.
A hold has a lifecycle, and that is a genuine change of shape rather than an
extra field:

```
pending ──head hit──> held ──released in window──> complete
   │                    │
   │                    └──released early────────> broken
   └──head missed──────────────────────────────-> miss
```

New surface: `releaseLane(lane, songTime)`, and `update` must complete holds
whose tail passes while still held. Both take raw clock time and subtract
calibration themselves, matching `hitLane` — **do not pass `judgementTime` into
them or the offset is counted twice**, which is the bug §... the rendering rule
already documents.

This is all pure, so it is fully unit-testable, and it should be tested *before*
anything renders. Write the tests against `HIT_WINDOWS` relatively, never with
literal deltas.

### Input: the multi-touch part is not optional

Keyboard is easy — `keyup` next to the existing `keydown`. Touch is not. A
player holding two lanes and tapping a third generates interleaved pointer
events, so the screen must map `pointerId → lane` on `pointerdown` and consult
that map on `pointerup`, rather than recomputing the lane from the release
position. A finger drifts while held, and `laneAtScreenPoint` at release time
would then break a hold the player never let go of.

### Rendering

A hold is a body plus head and tail caps. Two existing traps apply directly and
both are already documented in CLAUDE.md:

- The body spans many z values, so it **must be segmented** — `PlaneGeometry(w, h)`
  is a single quad and stays flat however its vertices move. It also needs
  `curveLift` on Y and `curveWidth` on X per segment, or it floats off the track
  and hangs over the edge as the track narrows.
- `InstancedMesh` does not fit: bodies have per-note lengths. A small pool of
  meshes, checked out per visible hold, is the straightforward answer.

### Difficulty and the editor

`DifficultyParams` gains `holdShare` and `minHoldSec` — easy gets few and long,
hard gets more and shorter. The editor's `drawNotes` currently draws a fixed
`NOTE_HEIGHT` rect; holds draw from `t` to `t + duration`.

### Milestones

- **L1 — wire + generation.** ✅ `type: 'hold'` and optional `duration` in
  `shared/`, with `isHold`/`noteEnd` so nothing re-derives the rule;
  `analysis/sustain.ts` finding spans in the cached waveform;
  `holdShare`/`minHoldSec`/`maxHoldSec` per difficulty; promotion in
  `charts/generate.ts`. 19 tests across synthetic envelopes and generation.
- **L2 — engine.** ✅ The state machine above, `releaseLane`, `heldNoteId`,
  scoring and break rules. 22 tests. Done before any rendering on purpose — it
  is where the design could be wrong, and it was cheap to prove there.
- **L3 — input.** ✅ `keyup`, and a `pointerId → lane` map so a drifting finger
  cannot break a hold it never let go of. `pointerup`/`pointercancel` are bound
  on `window`, not the canvas: a finger sliding off the edge otherwise leaves
  the lane held forever. Pausing releases everything — alt-tab fires `blur` but
  not `keyup`, so without that the engine still believed the key was down and
  the hold auto-completed for free on resume.
- **L4 — rendering.** ✅ Segmented bodies bent to the track, drained at the hit
  line, brightest while held. The z-range decision is extracted as the pure
  `holdSpan` so it is testable without a WebGL context.
- **L5 — editor.** Timeline draws holds at their true length.

### Decisions (answered 2026-07-19)

1. **Single judgement at the head, plus a completion bonus.** No tick scoring.
   The head is judged exactly like a tap, so `counts` and the accuracy
   percentage keep meaning precisely what they mean today — a hold is one note
   in the tally, not a stream of fractional ones.
2. **Early release is forgiven.** There is a release window at the tail. It is
   capped at a fraction of the hold's own length, or a very short hold would be
   completable by tapping it, which would make short holds free.
3. **A broken hold costs points, not the combo.** It keeps its head score and
   forfeits the bonus. Combo survives.

Together these make a hold *strictly additive*: at worst it scores what the same
note would have scored as a tap. That is the right call for a game whose charts
are machine-generated — a false-positive sustain should not be able to end a run.
The cost is that holds cannot be the hard part of a chart; if they ever need to
be, tick scoring is the lever, and it is a change to `retire`, not to the shape
of the state machine.

### What the measurements changed (L1)

Two things were wrong in the design above, and only running it against the real
library showed either.

**Stopping a sustain at the next onset was wrong for polyphonic music.** The
reasoning — "past a new attack the energy belongs to the next sound" — holds for
a solo instrument and fails for every real mix, because a held vocal rings
straight through the drums and the onset stream is mostly percussion. Measured:
onsets fire every **80-130ms**, and only **0.5-2.2%** of gaps reach even 0.4s.
So the rule capped essentially every span below the minimum hold length and the
feature yielded 0.4% holds — technically working, practically absent.

The fix is the lesson §2.1 already learned: a *quiet* onset does not end a pad,
a loud one does, and "loud" has to be **a percentile of the song's own onset
strengths** rather than an absolute, because absolute energy describes the
master rather than the moment. Above p75 ends a sustain. Yield went from 0.4% to
10-18% on hard, ~9% on easy — and still tracks the music, which is the part that
matters: dense percussive tracks stay near 1%, sustained ones fill up.

**The discriminator that does work is flatness, not loudness.** A struck sound
stays above any sensible floor for a long time while decaying the whole way, so
"loud for a while" would turn every cymbal into a hold. Comparing late energy
against early energy separates them, with real margin either side: exponential
decays out to tau=5s are rejected, plateaus fading up to 20%/sec are accepted.

**11 of 28 songs had no cached waveform**, so they would have regenerated to
hold-free charts and looked like the feature had failed for them.
`regenerateCharts` now rebuilds a missing one — a one-off decode per song, saved,
so the next regenerate is instant again. It is best-effort: if the audio cannot
be decoded the charts still rebuild, without holds, since they come from
`analysis.json` and need nothing from the media file. A test covers that path,
and it is what caught the regression when the decode was not yet guarded.

## 6g. Favorites and menu sorting

Star songs from the menu; sort by favorites, title, artist or BPM; optionally
show favorites only.

**Stored per device in `localStorage`**, beside scores and calibration, rather
than as a flag on the beatmap. The trade was made deliberately: local keeps
starring instant and — the deciding factor — working offline, since the service
worker never fakes writes and a server-side flag would be the one library action
that failed with no connection. The cost is that favorites do not follow you
between desktop and phone. Moving them to the server later is a `favorite` field
on `Beatmap` plus the same re-ingest and regenerate preservation `themeId`
already has.

Sorting reuses `songSearch.ts`, already shared with the admin library, so the
two screens cannot drift apart on what a search matches. `sortSongs` takes the
favorites set as an argument rather than reading storage — pure, testable, and
the admin screen keeps calling it without one. The menu offers a subset of the
sorts: confidence is an authoring diagnostic and means nothing to someone
choosing a song.

Two small rules worth keeping: the star is *overlaid* on the song card rather
than nested in it, because the card is a `<button>` and nesting buttons is
invalid; and the favorites-only filter stays hidden until something is starred,
with `filterFavorites` acting as identity on an empty set — a filter whose only
possible effect is emptying the list is worse than no filter.

## 7. Known gaps

- **Chart feel is untuned** (M3). Defaults are sane and tested, not play-tested.
- **Calibration screen is unexercised** — built and typechecked, never run by a human.
- Hold notes are not implemented; `Note.type` is reserved for them.
- Touch input works (lane = x position) but layout is desktop-first.

---

## 8. Legal

`yt-dlp` against YouTube violates their Terms of Service. For a personal project
that never leaves `localhost` this is a non-issue in practice. It stops being one
the moment it is deployed publicly or shared. Do not deploy this.

---

## 9. Progress log

- **2026-07-19** — Plan written. Settled: self-hosted audio, desktop-first `ASDFG`,
  `laneCount` parameterized.
- **2026-07-19** — Pivoted off Python/Docker/essentia to all-TypeScript. DSP written
  from scratch (FFT, spectral flux, autocorrelation tempo) and validated against
  synthetic click tracks with known BPM.
- **2026-07-19** — M1 complete. First real ingest: 130s track in 9.8s, 143.55 BPM.
- **2026-07-19** — M2/M4/M5/M6 complete. 60 tests passing, clean typecheck and build.
  Fixed along the way: a render loop that cancelled itself via a `phase` effect
  dependency; notes rendering black from `vertexColors` on an InstancedMesh; notes
  invisible from scene fog; a shader uniform array shorter than its GLSL
  declaration silently killing the render loop; the backend stealing Vite's port.
- **2026-07-19** — Reworked scoring into tier + early/late/exact, and fixed the two
  timing bugs in §2.2 that made charts drift out of sync with the music.
- **2026-07-19** — Added four more CC-BY tracks (§6b) spanning electronic, rock,
  funk and ambient. Verified the low-confidence warning path end to end.
- **2026-07-19** — Fixed charts collapsing into a single lane (§2.1). Reworked band
  classification to percentile ranking within each band's own distribution.
  Steepened the camera and rebuilt the starfield as a flythrough with round
  sprites instead of static square points.
- **2026-07-19** — Recalibrated difficulty after play feedback that medium was
  unplayable (§2.3): the charts were saturating against `minGapSec`. Bound both
  servers to all interfaces for phone testing.
- **2026-07-19** — Built editor milestone E1 (§6c). Reworked haptics into three
  modes after play feedback that per-tier buzzes felt confusing and late; added
  a synthesized crowd cheer on completion. Wrote `CLAUDE.md` as the operational
  handoff for future agents.
- **2026-07-19** — Replaced in-memory screen state with real URL routing, and
  added search over title and artist to the song list. Added haptic feedback on
  hits, with a toggle in the menu header.
- **2026-07-19** — Fixed a track with a quiet intro getting one note in its first
  minute. Three separate causes, all documented above: the threshold blend
  (§2.4), analysing the download rather than the transcode (§2.5), and a global
  note budget starving quiet sections (§2.6). Beatless intros are now skipped
  (§2.7). Added a screen wake lock so the display does not sleep mid-song.
- **2026-07-19** — Added song rename in the admin panel, with a `customName` flag
  so re-ingesting cannot revert it. Songs now play a few seconds past the last
  note and fade out instead of cutting. Drafted the level editor design (§6c).
- **2026-07-19** — Split note rendering into core + halo so every note glows and
  none clip to white. Widened the FOV on narrow viewports so five lanes fit on a
  phone. Enlarged the receptors. Reworked the mobile menu into a bottom sheet.
- **2026-07-19** — Fixed choruses having the fewest notes (§2.4): the adaptive
  onset threshold was letting loud sections raise their own bar. Loudness/density
  correlation went from -0.04 to +0.75. Rounded the note pills and stopped them
  clipping to white at the hit line.
- **2026-07-19** — Added pause/resume/restart (§4). Fixed lane tints drawing under
  the wrong lanes: the floor mesh carried a `rotation.z = PI` intended to flip v,
  but rotating about Z mirrors both axes, so u was reversed and the floor was a
  mirror image of the receptors. Faded the far end of the highway and the note
  spawn point instead of cutting off at a hard edge.
- **2026-07-19** — Built read-only public mode (`--public` / `TAP_TAP_PUBLIC`) as a
  blanket non-GET reject ahead of every route, because ingest, rename, delete and
  regenerate have no auth at all. It fails closed. Added a production serving
  path (Express serves `web/dist`) with a `--no-web` flag for dev, after
  tunnelling the Vite dev server produced a blank page — hundreds of unbundled ES
  modules and the tunnel drops enough of them to break the app with no console
  error. Compared tunnel providers; see CLAUDE.md. Tailscale later made all of
  this the fallback rather than the answer.
- **2026-07-19** — Admin gained search, sort, pagination, lucide icons, per-row
  action menus and a clear-finished-jobs button. The list had grown past the
  point where a flat unsorted page was usable.
- **2026-07-19** — Fixed the end-of-song freeze. `AudioClock.currentTime` falls
  back to `startOffset` when not playing, so a finished song reported a time near
  the *start* and the play loop's `songTime >= duration` never fired — the board
  sat frozen on a finished run. `onended` now parks the playhead at
  `buffer.duration`. Covered by a faked-Web-Audio test, verified by reverting the
  fix and watching it fail.
- **2026-07-19** — Widened `HIT_WINDOWS` on play feedback (`EXACT_WINDOW`
  deliberately left alone). The tier tests broke because they hardcoded 0.07,
  which landed exactly on the new perfect boundary; rewritten relative to the
  windows. Auto-pause on blur and visibility change. Calibration made usable on
  a phone — a big `pointerdown` tap pad, not SPACE — plus a reset-to-0 that
  stores a deliberate zero rather than clearing the setting. Medium is now the
  default difficulty.
- **2026-07-19** — Built a barrel-distortion fisheye as a post-process, then
  removed it. A full-screen pass bends every pixel, so the sky and star field
  curved with the track and the top of the sky was cropped — which is what made
  the retro sun impossible to place across three attempts. The highway keeps its
  per-vertex curve and taper; the lens is gone. See CLAUDE.md for the rule.
- **2026-07-19** — Retro sunset on the play backdrop, finally cracked by
  measuring rather than deriving: striping the shader every 0.05 of `uv.y`,
  screenshotting, and reading the uv↔screen mapping off the picture. The track's
  far edge sits at `uv.y ≈ 0.414`, not eye level, because the highway geometry
  stops at z=-29; and nothing in the scene is large enough to occlude a sun, so
  it is clipped in the shader.
- **2026-07-19** — Extended the 80s theme from the play screen to the whole app
  (§6e). Shared `RetroBackdrop` behind menu, results, calibration and admin;
  panels went translucent so the scene shows through; neon treatment on the
  logo, screen titles and primary buttons. Then brought the game to meet it: a
  neon ground grid under the highway, the sun repainted pink to match the menu's,
  and a glow on the HUD. The grid's first pass was near-white and buried the
  lanes — the linear-colour warning in §4 catching a third victim.
- **2026-07-19** — Fixed calibration reporting a −200ms offset. Matching a tap to
  the nearest metronome click aliases at half a period, so at 120 BPM a genuine
  300ms-late tap — ordinary Bluetooth latency — was measured as 200ms *early*.
  `foldTapDelta` breaks the ambiguity asymmetrically, since latency cannot be
  negative, and the metronome dropped to 90 BPM to widen the unambiguous range
  from 380ms to ~547ms. Verified by reverting the fold and watching four tests
  fail. Widened `HIT_WINDOWS` again on play feedback, and capped `good` at the
  smallest `minGapSec` with a test: past that, nearest-note matching can retire
  the note *after* the one the player aimed at.
- **2026-07-19** — Chased the follow-on report that every tap on the phone was a
  miss. Cause: the bad −200ms from the aliasing bug had been saved, and
  `hitLane` subtracts the offset, so every tap was judged 200ms late — past the
  miss window, so nothing could be hit and there was no feedback of any kind.
  Nothing sanity-checked a *stored* value; `resolveCalibration` now floors at
  `MIN_STORED_SEC` and the screen says so when it is applying the floor. Large
  positive values are untouched, since Bluetooth genuinely runs to 300ms.
  Confirmed by reproducing the all-miss engine state and watching the floor fix
  it — and the first repro was wrong (it passed the offset positionally into an
  options parameter and silently measured nothing), which is the argument for
  running a repro rather than reasoning about one. Recalibrating on the phone
  afterwards read **+280ms**: the same physical latency the old code had
  reported as −200ms.
- **2026-07-19** — Third and final link in the same chain: with a *correct*
  +280ms calibration saved, a visually perfect tap still missed. Judgement ran
  in calibration-shifted time but the renderer drew in raw clock time, so the
  pill met the receptor one output latency before the beat was audible — and
  since 280ms exceeds `MISS_WINDOW`, `hitLane` matched nothing and the tap
  produced no feedback whatsoever. `engine.judgementTime` now converts once and
  everything positional draws through it, which aligns three things that had
  been drifting apart: what is seen, what is heard, and what is judged. The
  whole class of bug was invisible on a desktop, where the offset is ~10-20ms —
  a reminder that latency bugs need a real phone, not a fast machine.
- **2026-07-19** — Built per-song themes, T1–T4 (§6d). `Theme`/`THEMES`/
  `themeFor` live in `shared/`; a beatmap stores only `themeId`. Four palettes,
  picked per song in admin with swatches.

  The design held up, with three amendments worth recording. **The sky needed
  eight colours, not three.** Reproducing the existing backdrop exactly meant
  naming every stop the shader had baked in — two horizon stops for the treble
  shimmer, a below-eye-level colour, two for the sun, plus `haze` and `glow` for
  four additive atmosphere terms that were still hardcoded pink and would have
  clashed violently with a green or blue sky. Grouping them under `sky` kept
  `Theme` readable.

  **Themes are authored in sRGB hex and linearized on the way into the shader.**
  Storing linear values was the obvious alternative and is wrong twice: linear
  0.001 does not survive 8 bits per channel, and nobody can hand-tune a palette
  against tone-mapped linear numbers. `THREE.Color` already does this conversion
  for the lane tints, so the default theme's hexes were chosen by round-tripping
  the old literals through it — verified numerically before a single pixel
  changed, then confirmed by screenshot.

  **The ground grid takes its two colours from lanes 0 and 1** rather than
  carrying its own pair. For the default theme that lands exactly on the
  hardcoded pink and cyan, and for every other theme the scenery is visibly made
  of the same neon as the track, for free.

  Two things surfaced only by looking. The grid was the last hardcoded palette
  and looked fine until a green sky sat behind pink lines. And Arctic's first
  pass had five plausibly *cold* lane colours that were nearly indistinguishable
  at the receptors — a cold palette is the hardest to keep readable, because
  every hue that suits the name lives between cyan and violet. Lane colours are
  a playability constraint wearing an aesthetic costume; the sky carries a
  theme's identity, the lanes carry its readability.

  One bug caught while writing it: `PATCH /api/songs/:songId` set
  `customName: true` unconditionally, which was correct when rename was its only
  caller. A theme-only PATCH would have frozen the song's title against the next
  re-ingest — and the damage would only have surfaced much later, at re-ingest,
  looking nothing like the change that caused it.

- **2026-07-19** — Player report: "even after calibration I'm 80% early, I hit
  the moment the pill is inside the base circle." Not a calibration fault, and
  the phrasing was the whole diagnosis. The receptor ring's outer radius is
  0.552 world units against a note radius of 0.2, so the pill *overlaps* the
  ring 38ms (hard) to 55ms (easy) before it is centred on it — and
  `EXACT_WINDOW` is 22ms, so that cue reads EARLY every single time while still
  scoring `perfect` tier. The player was aiming at a cue the game drew ~40ms
  before the moment it judges.

  Looking for the cause turned up a worse one: the white hit line was at
  `z = 0.45`, in *front* of the receptor centres — 22–33ms late. So the two
  things a player would naturally aim at bracketed the truth and neither one
  marked it. Moved the bar to `z = 0`. `EXACT_WINDOW` was deliberately left
  alone: widening it would have hidden precisely the signal that made this
  findable, which is the job its comment says it has.

  Also added a fifth theme (Black & White). Greyscale is the worst case for the
  lane-readability rule, since lightness is the only axis left; the lanes
  alternate bright/dim rather than running a tidy monotonic ramp, because a ramp
  puts the two most similar greys *adjacent*, and adjacent lanes are exactly the
  pair that has to be told apart under pressure.

  Writing that theme needed a check that no sky colour crosses the bloom
  threshold, so it became a test — which immediately failed on **arctic and
  toxic**, both shipped hours earlier with `0xe8` in `sunCrown` (linear 0.807
  against a threshold of 0.8). Both suns had looked "bright" in the verification
  screenshots and neither had looked *wrong*. A constraint that only an eye
  enforces is a constraint that ships broken.

- **2026-07-19** — Theme editor in admin, at `/admin/themes`. Themes stopped
  being source code and became data, which is a bigger change than it sounds and
  turned on two decisions.

  **Built-ins stay in code, read-only; custom themes are a JSON file layered on
  top.** The alternative — migrate everything into the file and seed it on first
  run — is more uniform and quietly breaks two guarantees: `DEFAULT_THEME` is the
  fallback that `themeFor` promises never fails, and it cannot be allowed to
  depend on a file existing; and `synthwave` reproduces the pre-theme renderer
  exactly, which nobody would reconstruct after overwriting it. Duplicate covers
  the actual use case. The API returns 403 on editing or deleting a built-in, and
  `themeCatalog` refuses to let a custom theme shadow one even if the file is
  edited by hand.

  **The preview is a real `Highway`, not swatches.** This session had already
  demonstrated why: two built-in themes shipped with sun crowns over the bloom
  threshold, and they looked *fine* as hex. Colours are linearized, ACES
  tone-mapped and bloom-thresholded before anyone sees them, so a swatch is not a
  preview of a theme — it is a different number. `Highway` already took
  `{canvas, theme}`, so it reuses directly with a dummy chart and a synthetic
  clock. It debounces at 140ms and disposes on every rebuild, because shader
  materials are built in the constructor and each instance holds a WebGL context.

  **Validation moved from a test to a validator.** Every brightness and lane rule
  was previously enforced by `theme.test.ts`, which is worth nothing against a
  palette typed into a form. `validateTheme` now lives in `shared/` and runs
  server-side to reject writes and client-side for live feedback — one
  implementation, per the single-source-of-truth rule. Errors block saving;
  "these two lanes look similar" is a warning, because it depends on the chart
  and the player rather than being a fact about the palette.

  Deleting a theme deliberately does **not** cascade. Songs keep the dead id and
  resolve to the default, so delete is safe rather than a rewrite of every
  beatmap — but the endpoint reports `songsAffected` so the UI can say how many
  songs just changed appearance instead of doing it silently.

  One bug caught in passing: `PATCH /api/songs/:songId` validated `themeId`
  against the built-ins only, so a song could not be assigned a theme the admin
  had just created.

- **2026-07-19** — Made the app installable with offline play for tracks already
  loaded. The first thing worth recording is the constraint, because it decides
  whether any of this is reachable from a phone: **service workers need a secure
  context.** Measured both origins rather than assuming —
  `http://localhost:5173` is secure, `http://100.82.104.20:5173` is not, and on
  the tailnet IP `navigator.serviceWorker` is simply undefined. So this feature
  is gated behind exactly the two Tailscale console toggles Wake Lock already
  needed. Everything degrades to "no offline support" rather than throwing, so
  the game still runs on that origin today.

  **Cache-on-use, not precache.** The library is ~28 tracks of ~5MB; precaching
  is a 125MB first visit. Cache-on-use is also precisely the requested behaviour
  ("tracks I've loaded before"), so the simple thing and the right thing agree.

  Three caches, and the important detail is that **`tap-tap-media` is
  unversioned**. Shell and API caches carry `VERSION` and are purged on bump; the
  media cache is not, because shipping a JS change must not cost every player
  their offline library. It is also pinned in the `KEEP` set that `activate`
  cleans against. Both properties are asserted in `pwa.test.ts`, along with the
  cache name matching its duplicate in `pwa.ts` — the worker compiles as a
  separate program (WebWorker lib cannot share with DOM) so it can export
  nothing, and drift there fails in the nastiest way available: offline play
  keeps working while the UI reports every song as unavailable.

  Hand-rolled rather than Workbox, and the icons are hand-encoded PNGs via
  `zlib` rather than a native image dependency. The whole worker is four fetch
  rules and a cleanup pass; the icon is a gradient, a circle and some slits.

  **Verified by killing the server outright** rather than toggling a browser
  offline switch: with nothing listening on the port, a deep link to
  `/play/:id/:difficulty` loaded from cache and reached "Press SPACE to start".
  That also exposed the one rough edge — a cold offline start that has never
  loaded the menu shows the song list's fetch failure, since `/api/songs` was
  never cached. Reworded to say so plainly instead of surfacing "Failed to
  fetch".

  The menu now marks which songs are actually playable offline, and offers to
  clear the offline tracks with their size, since 100MB+ accumulates silently
  and the alternative is hunting through browser settings. Availability is shown
  by *dimming, not disabling*: `navigator.onLine` describes the link rather than
  reachability, and it is not a good enough authority to refuse a tap.

- **2026-07-20** — Beat and confidence overhaul (§2.8) plus "handcrafted feel"
  chart generation (§2.9), after feedback that charts read as drum-machine
  output. Tempo gained sub-hop precision — parabolic lag interpolation, then a
  joint period+phase polish against the ODF — taking worst end-of-track drift
  on 90s click tracks from ~350ms to 3–8ms. `bpmConfidence` is now discounted
  by measured onset/grid agreement, so a drifting grid reports itself; below
  0.5 generation ignores the grid entirely. On a trusted grid: on-beat onsets
  win spacing conflicts (1.2× selection bonus), chords may only land on the
  subdivision grid, and lanes follow each band's spectral-centroid contour —
  rising lines sweep right, flat streams roll — via `pickLaneContour`.
  `analysis.json` now carries `analysisVersion`; Regenerate re-analyzes stale
  files from `audio.m4a` (best-effort), so the library upgrades without
  re-downloading. Regenerating still invalidates stored scores.

- **2026-07-20** — Rebuilt tempo confidence after feedback that it read far too
  low on solid songs. Root cause: the z-score prominence judged the winning lag
  against a field inflated by the tempo's own harmonics, so only metronomes
  scored high. Confidence is now measured off the fitted grid itself — beat
  contrast, beat hit rate, onset alignment (§2.8) — and the tempo ODF is
  log-compressed with harmonic lag aggregation, so the estimate stops being
  dominated by the loudest section and stops falling into double-time. Same
  `ANALYSIS_VERSION` bump as the precision work; one Regenerate covers both.
- **2026-07-20** — Added a fourth difficulty, Extreme (§2.3): five lanes like
  hard, but a 1.0s approach, ~4.6 target NPS and ~0.32 chord chance. It shares
  hard's 190ms gap because that gap equals the miss window and dropping below
  it makes `hitLane` retire the wrong note — so extreme's difficulty is reading
  speed and chords, not tighter spacing. `generateAllCharts`, the menu picker,
  the router and the editor were already or are now driven off `DIFFICULTY_NAMES`,
  so the union addition plus one `DIFFICULTIES` entry was most of the change;
  TypeScript's exhaustiveness surfaced the three hand-written `Record<Difficulty
  Name>` literals in tests. Existing songs gain the chart on regenerate/re-ingest.
- **2026-07-20** — Replaced the constant beat grid with dynamic-programming
  beat tracking (§2.8), after the second round of "confidence is way too low":
  synthetic full mixes scored 0.85+, which pointed at the one thing they do
  not model — human timing. A constant grid is wrong everywhere on a drifting
  performance, so honest confidence had to read low; tracked beats follow the
  player (118→126 BPM ramp: every beat within 5ms) and confidence gains a gap-
  steadiness cap so arrhythmic audio cannot pass just because the tracker
  faithfully followed it (irregular clicks: 0.97 → 0.0). BPM is now the
  interquartile mean of tracked gaps. `beatGrid` was already `number[]` on the
  wire, so charts, editor and admin consume the non-uniform grid unchanged.

## 10. Open

- **Phone access is solved — via Tailscale, not the firewall.** The inbound block
  was real (both servers bind `0.0.0.0` and `netstat` confirmed LISTENING, but a
  phone on the same Wi-Fi could not connect), and no allow rule was ever created.
  Tailscale sidesteps it entirely: the connection arrives on the Tailscale
  interface. `http://100.82.104.20:8787` from any device on the tailnet. See
  CLAUDE.md for the HTTPS steps that Wake Lock needs.
- **Per-song themes (§6d) are built**, plus a theme editor at `/admin/themes`.
  Five built-in palettes (Synthwave, Inferno, Arctic, Toxic, Black & White),
  read-only, with Duplicate to make editable copies persisted in
  `media/themes.json`. Two things are still open:
  - **The shell does not follow the theme.** `RetroBackdrop` keys off CSS custom
    properties, so a theme could drive the menu and results screens by setting
    them — but the menu shows *all* songs, so there is no one theme to apply.
    The natural scope is the results screen and the play screen's own chrome.
  - Whether a theme should change note **shape** as well as colour. Still
    colour-only; shape interacts with the bloom tuning and the "close to round"
    decision in `buildNotes`.
- **Long notes** (§6f) are designed and **not built** — the next feature. L1–L5.
  Three design questions are open and are listed at the end of that section;
  they want answering before L2, because they decide the engine's shape.
- **PWA / offline is built**, and is **unreachable from the phone until HTTPS is
  on**: service workers need a secure context, and `http://100.82.104.20:5173`
  is not one (measured). Same two Tailscale console toggles Wake Lock needs.
- **Editor E2/E3** (§6c) not built. E2 — a global timing offset, saved behind
  `customChart` — is the highest-value next piece: one slider fixing a whole
  chart's timing beats editing notes one at a time.
- **Chart feel is still untuned** (M3). Only a human can judge it.
- **Unverified on a real device:** wake lock, haptics, intro-skip, the crowd
  cheer (unverified by ear at all), and the `laneAtScreenPoint` tap fix, which
  has only been checked synthetically.
- **Calibration is now verified on a real phone** — it reads ~+280ms over
  Bluetooth, which is the range this whole feature was built for. What is still
  unconfirmed is whether the game *feels* right with that offset applied; that
  is M3 territory and only a human can answer it.

/*
 * Usage:
 *   adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_$(adb -s <serial> shell pidof com.taptap.game)
 *   WS=$(curl -s http://127.0.0.1:9222/json/list | grep -oE 'ws://[^"]*' | head -1)
 *   node scripts/measure-frames.mjs "$WS" [minutes] [intervalSeconds]
 *
 * SERIAL and ADB are overridable by environment variable.
 *
 * Attach while the player is ALREADY playing, and ask first — this reads a live
 * device and a previous session force-stopped a run mid-song by being careless.
 * Remove the forward and the in-page probe afterwards.
 */
/**
 * Deliverable 08, properly this time: HWUI frame timing and the in-page rAF
 * cadence sampled over the SAME window, on the physical S25.
 *
 * The previous attempt ran the two instruments separately and they disagreed —
 * `dumpsys gfxinfo` showed p50 climbing 8ms → 23ms and fps falling to ~89 after
 * about four minutes, while an in-page rAF probe reported a flawless 120fps.
 * Both were believed at once, which is how "no meaningful thermal derate" got
 * said out loud. The windows never overlapped: the rAF probe covered the first
 * two minutes and the degradation started later.
 *
 * They measure genuinely different things and either can be the honest one:
 *   - gfxinfo is HWUI, the Android view layer compositing the WebView's surface.
 *     It can sit at a perfect 120fps while the WebGL loop inside the page
 *     stutters, because the compositor happily re-presents the last texture.
 *   - the rAF probe is what the game's render loop actually gets, and is blind
 *     to whether those frames ever reach the panel.
 *
 * So the only way to attribute a derate is to read both against one clock, next
 * to the thermal state and the panel's real vsync rate, with every row labelled
 * by what the app was doing. That last part is not decoration: a run, the
 * results card and the menu are wildly different GPU loads, and an unlabelled
 * table that mixes them looks exactly like throttling while being nothing of the
 * kind. That mistake has already been made once here.
 */
const WS = process.argv[2];
const MINUTES = Number(process.argv[3] ?? 6);
const INTERVAL_SEC = Number(process.argv[4] ?? 10);

const ADB = process.env.ADB ?? 'C:/Users/avihay/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const SERIAL = process.env.SERIAL ?? '10.0.0.7:5555';
const PKG = 'com.taptap.game';

const { execFile } = await import('node:child_process');

function adb(args) {
  return new Promise((resolve) => {
    execFile(ADB, ['-s', SERIAL, ...args], { maxBuffer: 1 << 26 }, (err, stdout) =>
      resolve(stdout ?? ''),
    );
  });
}

// ---------------------------------------------------------------- CDP plumbing
const ws = new WebSocket(WS);
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value ?? null;
};

const INSTALL = `(() => {
  if (window.__p) return 'already';
  const d = [];
  let last = performance.now();
  const tick = (now) => { d.push(now - last); last = now; window.__p.raf = requestAnimationFrame(tick); };
  window.__p = { d, raf: requestAnimationFrame(tick) };
  return 'ok';
})()`;

const READ = `(() => {
  const p = window.__p; if (!p) return null;
  const d = p.d.slice().sort((a,b)=>a-b); p.d.length = 0;
  if (!d.length) return null;
  const at = q => d[Math.min(d.length-1, Math.floor(d.length*q))];
  const total = d.reduce((a,b)=>a+b,0);
  return JSON.stringify({
    n: d.length, fps: +(d.length/(total/1000)).toFixed(1),
    p50:+at(0.5).toFixed(1), p95:+at(0.95).toFixed(1), p99:+at(0.99).toFixed(1), max:+at(1).toFixed(1),
    o33: d.filter(x=>x>33).length, o50: d.filter(x=>x>50).length,
    path: location.pathname,
  });
})()`;

// ------------------------------------------------------------- device sampling
async function thermal() {
  const out = await adb(['shell', 'dumpsys', 'thermalservice']);
  let inhal = false, skin = '-', ap = '-', status = '-';
  for (const line of out.split(/\r?\n/)) {
    if (/Current temperatures from HAL/.test(line)) { inhal = true; continue; }
    if (/Current cooling devices|static thresholds/.test(line)) inhal = false;
    if (inhal && /mName=SKIN/.test(line)) skin = (line.match(/mValue=([0-9.]+)/) ?? [])[1] ?? skin;
    if (inhal && /mName=AP\b/.test(line)) ap = (line.match(/mValue=([0-9.]+)/) ?? [])[1] ?? ap;
    if (/^Thermal Status:/.test(line)) status = line.split(/\s+/)[2] ?? status;
  }
  return { status, skin, ap };
}

async function gfx() {
  const out = await adb(['shell', 'dumpsys', 'gfxinfo', PKG]);
  const num = (re) => (out.match(re) ?? [])[1] ?? '-';
  return {
    total: num(/Total frames rendered:\s*(\d+)/),
    janky: num(/Janky frames:\s*(\d+)/),
    p50: num(/50th percentile:\s*(\d+)ms/),
    p95: num(/95th percentile:\s*(\d+)ms/),
    p99: num(/99th percentile:\s*(\d+)ms/),
  };
}

async function hz() {
  const out = await adb(['shell', 'dumpsys', 'SurfaceFlinger']);
  const m = out.match(/activeMode=\{id=\d+[^}]*vsyncRate=([0-9.]+)/);
  return m ? Number(m[1]).toFixed(0) : '-';
}

async function state() {
  const [power, acts, audio] = await Promise.all([
    adb(['shell', 'dumpsys', 'power']),
    adb(['shell', 'dumpsys', 'activity', 'activities']),
    adb(['shell', 'dumpsys', 'audio']),
  ]);
  if (!/mWakefulness=Awake/.test(power)) return 'OFF';
  if (!new RegExp(`topResumedActivity.*${PKG}`).test(acts)) return 'BG';
  const wake = /Wake Locks: size=[1-9]/.test(power) && power.includes(PKG);
  const playing = /state:started/.test(audio);
  return wake && playing ? 'PLAY' : wake ? 'READY' : 'MENU';
}

// ------------------------------------------------------------------------ main
ws.addEventListener('open', async () => {
  await send('Runtime.enable');
  console.log('probe:', await evaluate(INSTALL));

  await adb(['shell', 'dumpsys', 'gfxinfo', PKG, 'reset']);
  await evaluate('window.__p.d.length = 0');

  const head =
    'T+'.padEnd(6) + 'STATE'.padEnd(7) + 'HZ'.padEnd(5) +
    '| rAF: fps'.padEnd(11) + 'p50'.padEnd(7) + 'p95'.padEnd(7) + 'p99'.padEnd(7) + 'max'.padEnd(8) + '>33'.padEnd(5) + '>50'.padEnd(5) +
    '| HWUI: p50'.padEnd(12) + 'p95'.padEnd(6) + 'p99'.padEnd(6) + 'jank%'.padEnd(7) +
    '| TH'.padEnd(5) + 'SKIN'.padEnd(7) + 'AP';
  console.log(head);
  console.log('-'.repeat(head.length));

  const t0 = Date.now();
  const samples = [];
  const totalSamples = Math.floor((MINUTES * 60) / INTERVAL_SEC);

  for (let i = 0; i < totalSamples; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
    const [raw, g, t, rate, st] = await Promise.all([evaluate(READ), gfx(), thermal(), hz(), state()]);
    const r = raw ? JSON.parse(raw) : null;
    const el = Math.round((Date.now() - t0) / 1000);
    const jankPct = g.total !== '-' && Number(g.total) > 0
      ? ((Number(g.janky) / Number(g.total)) * 100).toFixed(1)
      : '-';
    samples.push({ el, st, rate, raf: r, hwui: g, therm: t });
    console.log(
      `${el}s`.padEnd(6) + st.padEnd(7) + rate.padEnd(5) +
      `| ${r ? r.fps : '-'}`.padEnd(11) +
      `${r ? r.p50 : '-'}`.padEnd(7) + `${r ? r.p95 : '-'}`.padEnd(7) +
      `${r ? r.p99 : '-'}`.padEnd(7) + `${r ? r.max : '-'}`.padEnd(8) +
      `${r ? r.o33 : '-'}`.padEnd(5) + `${r ? r.o50 : '-'}`.padEnd(5) +
      `| ${g.p50}`.padEnd(12) + `${g.p95}`.padEnd(6) + `${g.p99}`.padEnd(6) + `${jankPct}`.padEnd(7) +
      `| ${t.status}`.padEnd(5) + `${t.skin}`.padEnd(7) + `${t.ap}`,
    );
    await adb(['shell', 'dumpsys', 'gfxinfo', PKG, 'reset']);
  }

  // Summary over the PLAY rows only — the whole point of labelling them.
  const play = samples.filter((s) => s.st === 'PLAY' && s.raf);
  if (play.length >= 4) {
    const half = Math.floor(play.length / 2);
    const avg = (rows, pick) => (rows.reduce((a, s) => a + pick(s), 0) / rows.length).toFixed(1);
    const first = play.slice(0, half), last = play.slice(-half);
    console.log('\n--- PLAY rows only: first half vs last half ---');
    console.log(`rAF  fps   ${avg(first, (s) => s.raf.fps)}  ->  ${avg(last, (s) => s.raf.fps)}`);
    console.log(`rAF  p50   ${avg(first, (s) => s.raf.p50)}ms ->  ${avg(last, (s) => s.raf.p50)}ms`);
    console.log(`rAF  p95   ${avg(first, (s) => s.raf.p95)}ms ->  ${avg(last, (s) => s.raf.p95)}ms`);
    console.log(`HWUI p50   ${avg(first, (s) => Number(s.hwui.p50) || 0)}ms ->  ${avg(last, (s) => Number(s.hwui.p50) || 0)}ms`);
    console.log(`HWUI p95   ${avg(first, (s) => Number(s.hwui.p95) || 0)}ms ->  ${avg(last, (s) => Number(s.hwui.p95) || 0)}ms`);
    console.log(`thermal    ${first[0].therm.status} -> ${last[last.length - 1].therm.status}   skin ${first[0].therm.skin} -> ${last[last.length - 1].therm.skin}`);
  }

  console.log('\ncleanup:', await evaluate('(()=>{cancelAnimationFrame(window.__p.raf);delete window.__p;return "removed"})()'));
  ws.close();
  process.exit(0);
});

ws.addEventListener('error', (e) => {
  console.log('ws error:', e.message ?? e);
  process.exit(1);
});

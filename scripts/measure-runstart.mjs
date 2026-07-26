/*
 * Usage: forward devtools (see measure-frames.mjs), then
 *   node scripts/measure-runstart.mjs "$WS"
 *
 * Ask before running — it drives the live app with real taps, quitting whatever
 * run is in progress. It navigates itself from wherever it finds the app back to
 * the menu, then into a fresh run, sampling at 1s so the stall lands in its own
 * bucket rather than being averaged into 1200 healthy frames.
 *
 * Result at v0.16.0: 108.2ms / 116.5ms, vs a 124.8ms pre-warm-up baseline. The
 * stall is still there. See CLAUDE.md for what is ruled out.
 */
/**
 * Run-start stall, take four — resilient.
 *
 * Take three collected the right data and then threw it away: it aborted on a
 * failed PLAY-button lookup *before* printing rows it had already filled. So this
 * one prints in a `finally`, and stops depending on locating any particular
 * control — the song-card tap is enough to reach a run on this device.
 */
const WS = process.argv[2];
const ws = new WebSocket(WS);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value ?? null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tap(x, y) {
  const pt = [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function locate(selectors, textMatch) {
  const expr = `(() => {
    for (const s of ${JSON.stringify(selectors)}) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        ${textMatch ? `if (!/${textMatch}/i.test(el.textContent || '')) continue;` : ''}
        return JSON.stringify({ x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2),
                                text: (el.textContent||'').trim().slice(0,22) });
      }
    }
    return null;
  })()`;
  const raw = await evaluate(expr);
  return raw ? JSON.parse(raw) : null;
}

const READ = `(() => {
  const p = window.__rs; if (!p) return null;
  const d = p.d.slice(); p.d.length = 0;
  return JSON.stringify({
    n: d.length, max: d.length ? +Math.max(...d).toFixed(1) : 0,
    o33: d.filter(x=>x>33).length, o50: d.filter(x=>x>50).length, o100: d.filter(x=>x>100).length,
    path: location.pathname,
    ready: document.querySelector('[data-engine-ready]')?.getAttribute('data-engine-ready') ?? '-',
    vw: innerWidth, vh: innerHeight,
    fs: !!document.fullscreenElement,
    cw: document.querySelector('canvas')?.width ?? 0,
    ch: document.querySelector('canvas')?.height ?? 0,
  });
})()`;

const rows = [];
let label = '';

async function bucket(seconds) {
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    const raw = await evaluate(READ);
    rows.push(raw ? { label, ...JSON.parse(raw) } : { label, path: '(no probe)', n: 0, max: 0, o33: 0, o50: 0, o100: 0, ready: '-' });
    label = '';
  }
}

function report() {
  if (!rows.length) { console.log('\n(no rows collected)'); return; }
  console.log('\n  bucket            path                       frames  max      >33 >50 >100 ready');
  console.log('  ' + '-'.repeat(82));
  for (const r of rows) {
    const mark = r.max > 50 ? '  <== STALL' : r.max > 33 ? '  <- long frame' : '';
    console.log('  ' + (r.label || '').padEnd(18) + String(r.path).padEnd(27) +
      (r.max + 'ms').padEnd(9) + String(r.o50).padEnd(5) +
      `${r.vw ?? '-'}x${r.vh ?? '-'}`.padEnd(11) + String(r.fs ?? '-').padEnd(5) +
      `${r.cw ?? '-'}x${r.ch ?? '-'}` + mark);
  }
  const worst = rows.reduce((a, r) => (r.max > a.max ? r : a), { max: 0, label: '-' });
  const play = rows.filter((r) => r.path.startsWith('/play'));
  const worstPlay = play.reduce((a, r) => (r.max > a.max ? r : a), { max: 0 });
  console.log(`\nworst frame anywhere in window: ${worst.max}ms`);
  console.log(`worst frame once on /play:      ${worstPlay.max}ms`);
  console.log('baseline recorded before the fix: 124.8ms max, 3 frames >50ms');
}

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');

    // Get to the menu first, whatever screen we are on.
    let el = await locate(['.play__pause-btn']);
    if (el) { await tap(el.x, el.y); await sleep(900); }
    el = await locate(['button'], 'quit');
    if (el) { await tap(el.x, el.y); await sleep(1800); }
    el = await locate(['.song-hero__close']);
    if (el) { await tap(el.x, el.y); await sleep(1200); }
    // Results screen: its "Menu" action is the way back to the list.
    el = await locate(['button', 'a'], 'menu|songs|back');
    if (el) { await tap(el.x, el.y); await sleep(1800); }
    console.log('at menu:', await evaluate('location.pathname'));

    // Probe on, THEN navigate — so the mount is inside the window.
    await evaluate(`(() => {
      if (window.__rs) { cancelAnimationFrame(window.__rs.raf); delete window.__rs; }
      const d = []; let last = performance.now();
      const tick = (now) => { d.push(now - last); last = now; window.__rs.raf = requestAnimationFrame(tick); };
      window.__rs = { d, raf: requestAnimationFrame(tick) };
      return 'ok';
    })()`);
    label = 'menu, idle';
    await bucket(3);

    el = await locate(['.song-card']);
    if (!el) throw new Error('no song card on the menu');
    console.log('tap song:', el.text);
    label = '>> song tapped';
    await tap(el.x, el.y);
    await bucket(4);

    // If a hero opened, its PLAY is what starts the run.
    el = await locate(['.song-hero__play', '.menu__play'], 'play|start');
    if (el) {
      console.log('tap PLAY:', el.text);
      label = '>> PLAY tapped';
      await tap(el.x, el.y);
    } else {
      console.log('(no PLAY control found — song tap may already have started a run)');
    }
    await bucket(18);
  } catch (err) {
    console.log('flow error:', err.message);
  } finally {
    report();
    console.log('\ncleanup:', await evaluate('(()=>{if(!window.__rs)return"none";cancelAnimationFrame(window.__rs.raf);delete window.__rs;return"removed"})()'));
    ws.close();
    process.exit(0);
  }
});
ws.addEventListener('error', (e) => { console.log('ws error:', e.message ?? e); process.exit(1); });

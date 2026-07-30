/*
 * Throwaway pixel-measurement harness for the AAA composition loop.
 *
 * Decodes ANY image Chrome can (PNG and the reference JPEGs alike) by loading it
 * as a data URI in a headless page and reading `getImageData` back. Everything
 * downstream is numeric: HSL saturation of the deck and of a note face, track
 * width per row, cross-lane luminance falloff, weave contrast, receptor-row
 * scans, and a left/right mirror check.
 *
 *   node scripts/measure-frame.mjs <img> [<img> ...] --hit=0.76
 *
 * Not shipped; delete when the item lands.
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--')).map((p) => resolve(p));
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
const PORT = Number(flags.port ?? 9631);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome'); process.exit(2); }

const PROFILE = resolve(`${tmpdir()}/measure-profile-${PORT}`);
await rm(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=800,600', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
  } catch {}
  if (!wsUrl) await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value ?? null;
};
await send('Runtime.enable');

/* ---------------------------------------------------------------- analysis -- */
/** Runs IN THE PAGE. `data` is a Uint8ClampedArray RGBA, w/h the image size. */
const ANALYSIS = String.raw`
(function (data, W, H, hitFrac) {
  const idx = (x, y) => (y * W + x) * 4;
  const srgb = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const relLum = (r, g, b) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const px = (x, y) => { const i = idx(Math.round(x), Math.round(y)); return [data[i], data[i + 1], data[i + 2]]; };
  const lum = (x, y) => { const [r, g, b] = px(x, y); return relLum(r, g, b); };
  function hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d % 6) + 6) % 360;
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    const l = (mx + mn) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return { h, s, l };
  }
  /** Mean colour over a box, plus HSL of that mean. */
  function patch(x0, y0, x1, y1) {
    let r = 0, g = 0, b = 0, n = 0, lsum = 0, l2 = 0;
    for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++)
      for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) {
        const i = idx(x, y); r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        const L = relLum(data[i], data[i + 1], data[i + 2]); lsum += L; l2 += L * L;
      }
    if (!n) return null;
    r /= n; g /= n; b /= n;
    const mean = lsum / n, sd = Math.sqrt(Math.max(0, l2 / n - mean * mean));
    const c = hsl(r, g, b);
    return {
      hex: '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''),
      S: +(c.s * 100).toFixed(1), H: +c.h.toFixed(0), relLum: +mean.toFixed(4),
      sdOverMean: +(mean > 0 ? (sd / mean) * 100 : 0).toFixed(1),
    };
  }

  /* --- the deck's horizontal extent at a row -------------------------------
   * Threshold against the frame's own background floor: walk in from each edge
   * until luminance rises above it for a sustained run. */
  function deckSpan(y) {
    // The floor is sampled at the frame's own left/right margin, which is always
    // background. Deck = brighter than that AND near-neutral: the reference's
    // side waveform bars are as bright as the deck and would otherwise be
    // measured as part of the playfield (they are not — they flank it).
    // The background floor: the 15th percentile of the row's outer 12% either
    // side. Corner pixels alone stopped working the moment the spectrum wings
    // reached the frame edge — a bright sample there raises the threshold until
    // the deck itself falls under it and the span comes back null.
    const edgeSamples = [];
    for (let x = 0; x < Math.round(W * 0.12); x++) { edgeSamples.push(lum(x, y)); edgeSamples.push(lum(W - 1 - x, y)); }
    edgeSamples.sort((a, b) => a - b);
    const floorL = edgeSamples[Math.floor(edgeSamples.length * 0.15)] ?? 0;
    // The deck's own level, from the middle third of the row (always playfield).
    const mids = [];
    for (let x = Math.round(W * 0.36); x < Math.round(W * 0.64); x += 3) mids.push(lum(x, y));
    mids.sort((a, b) => a - b);
    const deckL = mids[Math.floor(mids.length / 2)] ?? 0;
    // Half the deck's own level, floored above the background: a fixed offset
    // from the background cannot separate them once the vignette lifts the
    // background, and a fixed fraction of the deck cannot when the deck is dim.
    const th = Math.max(floorL * 1.45, deckL * 0.45);
    const neutral = (x) => { const [r, g, b] = px(x, y); return hsl(r, g, b).s < 0.30; };
    const on = (x) => lum(x, y) > th && neutral(x);
    const run = 8;
    let L = -1, R = -1;
    for (let x = 0; x < W - run; x++) { let ok = true; for (let k = 0; k < run; k++) if (!on(x + k)) { ok = false; break; } if (ok) { L = x; break; } }
    for (let x = W - 1; x >= run; x--) { let ok = true; for (let k = 0; k < run; k++) if (!on(x - k)) { ok = false; break; } if (ok) { R = x; break; } }
    if (L < 0 || R < 0 || R <= L) return null;
    return { y, L, R, width: R - L, frac: +((R - L) / W).toFixed(3) };
  }

  /* --- bright runs along a row (notes, dashes, rims) ----------------------- */
  function runs(y, th) {
    const out = []; let start = -1;
    for (let x = 0; x < W; x++) {
      const on = lum(x, y) > th;
      if (on && start < 0) start = x;
      if ((!on || x === W - 1) && start >= 0) { if (x - start >= 4) out.push([start, x]); start = -1; }
    }
    return out;
  }

  /* --- connected bright+saturated blobs = notes ---------------------------- */
  function blobs(minLum, minSat, minArea) {
    const seen = new Uint8Array(W * H);
    const found = [];
    const step = 1;
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      const p = y * W + x; if (seen[p]) continue;
      const i = idx(x, y);
      const c = hsl(data[i], data[i + 1], data[i + 2]);
      if (relLum(data[i], data[i + 1], data[i + 2]) < minLum || c.s < minSat) { seen[p] = 1; continue; }
      // flood
      const stack = [p]; seen[p] = 1;
      let n = 0, x0 = x, x1 = x, y0 = y, y1 = y, rs = 0, gs = 0, bs = 0;
      while (stack.length) {
        const q = stack.pop(); const qx = q % W, qy = (q / W) | 0;
        n++; if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        const j = idx(qx, qy); rs += data[j]; gs += data[j + 1]; bs += data[j + 2];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = qx + dx, ny = qy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const np = ny * W + nx; if (seen[np]) continue; seen[np] = 1;
          const k = idx(nx, ny);
          const cc = hsl(data[k], data[k + 1], data[k + 2]);
          if (relLum(data[k], data[k + 1], data[k + 2]) >= minLum && cc.s >= minSat) stack.push(np);
        }
      }
      if (n >= minArea) {
        const c2 = hsl(rs / n, gs / n, bs / n);
        found.push({ x: [x0, x1], y: [y0, y1], yf: [+(y0 / H).toFixed(3), +(y1 / H).toFixed(3)],
          w: x1 - x0 + 1, h: y1 - y0 + 1, area: n,
          H: +c2.h.toFixed(1), S: +(c2.s * 100).toFixed(1), L: +(c2.l * 100).toFixed(1),
          relLum: +relLum(rs / n, gs / n, bs / n).toFixed(3),
          hex: '#' + [rs / n, gs / n, bs / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') });
      }
    }
    return found.sort((a, b) => b.area - a.area).slice(0, 8);
  }

  const rows = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.72, 0.80, 0.88, 0.95];
  const spans = rows.map((f) => { const s = deckSpan(Math.round(f * H)); return s ? { at: f, ...s } : { at: f, none: true }; });

  /* --- the track's edges as two fitted lines -------------------------------
   * A note lying on the deck occludes its own row's edge (it is saturated, so
   * deckSpan walks past it), which shows up as L too big / R too small. The
   * edges are straight in screen space, so fit a line and refit against the
   * ENVELOPE — points on the wrong side of the fit are occlusions, points on
   * the right side are the real edge.
   */
  function fitEdge(pts, side) {
    let keep = pts;
    let a = 0, b = 0;
    for (let pass = 0; pass < 3; pass++) {
      let n = keep.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
      if (n < 3) break;
      for (const [y, v] of keep) { sx += y; sy += v; sxy += y * v; sxx += y * y; }
      const d = n * sxx - sx * sx;
      a = d === 0 ? 0 : (n * sxy - sx * sy) / d;
      b = (sy - a * sx) / n;
      keep = pts.filter(([y, v]) => (side < 0 ? v - (a * y + b) < 14 : (a * y + b) - v < 14));
    }
    return { a, b };
  }
  const edgePts = [];
  // Below the album disc / HUD band and above the very bottom, where the deck
  // is the only large neutral object and the fit is honest.
  for (let f = 0.34; f <= 0.86; f += 0.005) {
    const s = deckSpan(Math.round(f * H));
    if (s && s.frac > 0.30) edgePts.push([f, s.L, s.R]);
  }
  const fitL = fitEdge(edgePts.map(([y, l]) => [y, l]), -1);
  const fitR = fitEdge(edgePts.map(([y, , r]) => [y, r]), 1);
  const trackWidth = rows.map((f) => {
    const l = fitL.a * f + fitL.b, r = fitR.a * f + fitR.b;
    return { at: f, L: Math.round(l), R: Math.round(r), frac: +((r - l) / W).toFixed(3) };
  });

  // Deck patches: mid-track, one per lane, using the span at 50% height.
  const mid = deckSpan(Math.round(0.50 * H));
  const lanes = [];
  if (mid) {
    for (let i = 0; i < 4; i++) {
      const cx = mid.L + ((i + 0.5) / 4) * mid.width;
      const y = Math.round(0.50 * H);
      lanes.push({ lane: i, ...patch(cx - 14, y - 14, cx + 14, y + 14) });
    }
  }
  const mid40 = deckSpan(Math.round(0.40 * H));
  const lanes40 = [];
  if (mid40) for (let i = 0; i < 4; i++) {
    const cx = mid40.L + ((i + 0.5) / 4) * mid40.width, y = Math.round(0.40 * H);
    lanes40.push({ lane: i, ...patch(cx - 12, y - 12, cx + 12, y + 12) });
  }

  // Background: outside the deck, mid-frame.
  const bg = mid ? patch(Math.max(2, mid.L - 150), 0.48 * H, Math.max(12, mid.L - 90), 0.52 * H) : null;
  const bgR = mid ? patch(Math.min(W - 12, mid.R + 90), 0.48 * H, Math.min(W - 2, mid.R + 150), 0.52 * H) : null;

  // The accent rail: the brightest pixel within a band straddling the track edge.
  function railPeak(yf) {
    const y = Math.round(yf * H);
    const s2 = deckSpan(y);
    if (!s2) return null;
    const scan = (cx) => {
      let best = 0, bx = cx, bc = [0, 0, 0];
      for (let x = cx - 30; x <= cx + 30; x++) {
        if (x < 0 || x >= W) continue;
        const L = lum(x, y);
        if (L > best) { best = L; bx = x; bc = px(x, y); }
      }
      const c = hsl(bc[0], bc[1], bc[2]);
      return { x: bx, relLum: +best.toFixed(3), S: +(c.s * 100).toFixed(1), H: +c.h.toFixed(0),
        hex: '#' + bc.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') };
    };
    return { yf, left: scan(s2.L), right: scan(s2.R) };
  }

  // Mirror symmetry outside the track.
  const mirror = [];
  for (const yf of [0.18, 0.22, 0.26, 0.30, 0.34, 0.40]) {
    const y = Math.round(yf * H);
    const s = deckSpan(y);
    if (!s) continue;
    for (const off of [20, 45, 80]) {
      const xl = s.L - off, xr = s.R + off;
      if (xl < 2 || xr > W - 3) continue;
      const a = lum(xl, y), b = lum(xr, y);
      mirror.push({ yf, off, l: +a.toFixed(4), r: +b.toFixed(4), ratio: +(a / Math.max(b, 1e-5)).toFixed(2) });
    }
  }

  // Whole-frame energy.
  let bright = 0, tot = 0, lsum = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const L = lum(x, y); lsum += L; tot++; if (L > 0.15) bright++;
  }

  // Receptor row scan: the row the caller says the hit line is on.
  const hy = Math.round(hitFrac * H);
  const rowScan = { y: hy, runs: runs(hy, 0.25).map(([a, b]) => [a, b, b - a]) };
  // A LANE CENTRE, not the board centre — the board centre is a lane groove on an
  // even lane count, so a column there measures the darkest line in the frame and
  // reads as "the near field is empty" when it is not.
  const colX = mid ? Math.round(mid.L + mid.width * 0.375) : Math.round(W / 2);
  const column = [];
  for (let y = Math.round(0.60 * H); y < Math.min(H, Math.round(0.99 * H)); y += Math.round(H / 100))
    column.push([+(y / H).toFixed(3), +lum(colX, y).toFixed(3)]);

  return {
    size: [W, H],
    spans, trackWidth,
    laneDeckAt50: lanes,
    laneDeckAt40: lanes40,
    bgLeft: bg, bgRight: bgR,
    mirror,
    meanLum: +(lsum / tot).toFixed(4),
    pctAbove015: +((bright / tot) * 100).toFixed(2),
    notes: blobs(0.12, 0.28, 900),
    twill: [[0.42, 0.50], [0.58, 0.40], [0.28, 0.62], [0.75, 0.68]].map(([xf, yf]) =>
      ({ at: [xf, yf], ...patch(xf * W - 20, yf * H - 20, xf * W + 20, yf * H + 20) })),
    rowScan,
    // Bright runs across each row through the receptor band: the four timing
    // dashes show up here as four runs, and their absence is what "the tap
    // instant is drawn by absence" measured.
    dashRows: [0.70, 0.72, 0.73, 0.74, 0.745, 0.75, 0.755, 0.76, 0.77, 0.78, 0.80].map((f) => {
      const y = Math.round(f * H);
      let peak = 0;
      for (let x = 0; x < W; x++) peak = Math.max(peak, lum(x, y));
      return { at: f, peak: +peak.toFixed(3), runs: runs(y, 0.30).map(([a2, b2]) => [a2, b2 - a2]) };
    }),
    columnCentre: column,
    rails: [0.30, 0.45, 0.60, 0.70].map(railPeak),
    // Vertical profile down the centre of lane 2, from mid-track to the bottom:
    // where the pad starts, its face, its dash, its near lip, then the deck.
    // Fine column down the centre of pad 1 (leftmost), which is the pad least
    // likely to have a note standing on it in any given capture.
    pad1Column: (function () {
      const s2 = deckSpan(hy) || mid;
      if (!s2) return [];
      const x = Math.round(s2.L + s2.width * 0.125);
      const o = [];
      for (let y = Math.round(0.66 * H); y < Math.round(0.90 * H); y += 3)
        o.push([+(y / H).toFixed(4), +lum(x, y).toFixed(3)]);
      return o;
    })(),
    padColumn: (function () {
      // The column has to be pad 2's centre AT THE RECEPTOR ROW, not at
      // mid-track: the lanes splay, so a column placed from the mid-track span
      // wanders off the pad and reads the groove beside it.
      const s2 = deckSpan(hy) || mid;
      if (!s2) return [];
      const x = Math.round(s2.L + s2.width * 0.625);
      const o = [];
      for (let y = Math.round(0.62 * H); y < H - 1; y += Math.max(2, Math.round(H / 260)))
        o.push([+(y / H).toFixed(3), +lum(x, y).toFixed(3)]);
      return o;
    })(),
    // Raw luminance profile across a row, every 10px — the only way to see the
    // SHAPE of an asymmetry rather than the fact of one.
    rowProfile: (function () {
      const y = Math.round(0.30 * H), o = [];
      for (let x = 0; x < W; x += 10) o.push(+lum(x, y).toFixed(4));
      return o;
    })(),
  };
})(D, WW, HH, HITF)
`;

const out = {};
for (const f of files) {
  const buf = await readFile(f);
  const ext = extname(f).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const uri = `data:${mime};base64,${buf.toString('base64')}`;
  await evaluate(`window.__u = ${JSON.stringify(uri)}; 1`);
  const res = await evaluate(`(async () => {
    try {
      const img = new Image();
      await new Promise((ok, err) => { img.onload = ok; img.onerror = () => err(new Error('decode')); img.src = window.__u; });
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const D = ctx.getImageData(0, 0, c.width, c.height).data;
      const WW = c.width, HH = c.height, HITF = ${Number(flags.hit ?? 0.76)};
      return JSON.stringify(${ANALYSIS});
    } catch (e) { return JSON.stringify({ error: String(e && e.stack || e) }); }
  })()`);
  out[basename(f)] = res ? JSON.parse(res) : { error: 'no value' };
}
console.log(JSON.stringify(out, null, 1));
try { chrome.kill('SIGKILL'); } catch {}
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
process.exit(0);

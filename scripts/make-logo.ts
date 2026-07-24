/**
 * Generates the app's brand-mark source image — the two neon gem tap-tiles from
 * the menu logo (`.logo__mark`) — for `@capacitor/assets` to fan out into the
 * Android launcher icon and splash.
 *
 *   npm run logo        # writes assets/logo.png + assets/logo-dark.png
 *   npx @capacitor/assets generate --android \
 *     --iconBackgroundColor '#0a0a18' --iconBackgroundColorDark '#0a0a18' \
 *     --splashBackgroundColor '#0a0a18' --splashBackgroundColorDark '#0a0a18'
 *
 * Hand-rolled PNG encoding rather than pulling in sharp/canvas — the mark is two
 * rounded tiles with a gem gradient and a soft glow, and `zlib` is in the
 * standard library. Same reasoning as `make-icons.ts`, whose encoder this
 * mirrors. The output is committed; only re-run when the brand mark changes.
 *
 * The neon-arcade redesign recoloured the tiles from gold metal to a cyan→violet
 * gem with a pink glow, matching the `.logo__tile` mark and the play scene's
 * gems.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');

type Rgb = [number, number, number];

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size: number, pixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h: string): Rgb => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** The gem face gradient: lit cyan edge → cyan → deep violet base — matches
    `.logo__tile`. */
const G0 = hex('#9be8ff');
const G1 = hex('#35e0ff');
const G2 = hex('#4a2ba0');
function tileColor(t: number): Rgb {
  return t < 0.4 ? mix(G0, G1, t / 0.4) : mix(G1, G2, (t - 0.4) / 0.6);
}
/** The pink glow the mark casts (the logo's accent drop-shadow). */
const GLOW: Rgb = hex('#ff3fa4');

interface Tile {
  cx: number;
  cy: number;
  /** Rotation in radians. */
  rot: number;
}

/**
 * Signed distance to a rounded square centred at the origin, evaluated in the
 * tile's own (un-rotated) frame. Negative inside. Standard rounded-box SDF.
 */
function roundedBoxSdf(lx: number, ly: number, half: number, r: number): number {
  const qx = Math.abs(lx) - half + r;
  const qy = Math.abs(ly) - half + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function draw(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);

  // Two tiles, tilted apart and offset like the CSS mark, filling ~63% of the
  // canvas so `@capacitor/assets` keeps a comfortable launcher safe zone.
  const S = size * 0.293; // tile side
  const half = S / 2;
  const radius = S * 0.17;
  const gap = size * 0.047;
  const off = S * 0.073; // the ±0.04em vertical stagger
  const dx = (S + gap) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const tiles: Tile[] = [
    { cx: cx - dx, cy: cy + off, rot: (-10 * Math.PI) / 180 },
    { cx: cx + dx, cy: cy - off, rot: (10 * Math.PI) / 180 },
  ];
  const aa = size / 1024 + 0.75; // edge softening, ~1.5px at 1024

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      let bestCov = 0;
      let faceCol: Rgb = G1;
      let minSdf = Infinity;

      for (const tile of tiles) {
        const sx = x - tile.cx;
        const sy = y - tile.cy;
        const cos = Math.cos(-tile.rot);
        const sin = Math.sin(-tile.rot);
        const lx = sx * cos - sy * sin;
        const ly = sx * sin + sy * cos;

        const d = roundedBoxSdf(lx, ly, half, radius);
        if (d < minSdf) minSdf = d;

        const cov = Math.min(1, Math.max(0, 0.5 - d / aa));
        if (cov <= bestCov) continue;
        bestCov = cov;

        // Vertical metal gradient with a slight diagonal, a lit top rim and a
        // shaded foot — the tile's inset highlight/shadow, flattened to a face.
        let t = (ly * 0.85 + lx * 0.15 + half) / S;
        t = Math.min(1, Math.max(0, t));
        let col = tileColor(t);
        const rim = (ly + half) / S; // 0 at top, 1 at bottom
        if (rim < 0.14) col = mix(col, [255, 255, 255], (0.14 - rim) / 0.14 * 0.5);
        if (rim > 0.9) col = mix(col, [30, 12, 70], (rim - 0.9) / 0.1 * 0.4);
        faceCol = col;
      }

      // Soft outer glow, falling off from the nearest tile edge.
      const glowA = bestCov >= 1 ? 0 : Math.exp(-Math.max(minSdf, 0) / (size * 0.06)) * 0.5;

      // Composite: tile face over glow over transparent.
      const ta = bestCov;
      const ga = glowA * (1 - ta);
      const a = ta + ga;
      if (a <= 0) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
        continue;
      }
      px[i] = Math.round((faceCol[0] * ta + GLOW[0] * ga) / a);
      px[i + 1] = Math.round((faceCol[1] * ta + GLOW[1] * ga) / a);
      px[i + 2] = Math.round((faceCol[2] * ta + GLOW[2] * ga) / a);
      px[i + 3] = Math.round(a * 255);
    }
  }

  return px;
}

const SIZE = 1024;
const image = encodePng(SIZE, draw(SIZE));
for (const name of ['logo.png', 'logo-dark.png']) {
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, image);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

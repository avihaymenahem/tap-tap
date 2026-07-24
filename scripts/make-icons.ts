/**
 * Generates the PWA icons.
 *
 * Hand-rolled PNG encoding rather than pulling in sharp or canvas: the icon is
 * a gradient, a circle and some horizontal slits, and `zlib` is in the standard
 * library. That is a smaller ask than a native image dependency for two files
 * that change approximately never — the same reasoning that keeps the DSP and
 * the router hand-written.
 *
 *   npm run icons
 *
 * The output is committed, so this only needs re-running when the art changes.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public');

type Rgb = [number, number, number];

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** A PNG chunk: length, type, data, CRC of type+data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type. 0 (None) throughout — the
  // image compresses well enough on flat colour that per-line filters are not
  // worth the code.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Signed distance to a rounded rectangle centred at the origin, half-extents
 * `hx`/`hy`, corner radius `r`. Negative inside. Used to draw the gem tiles.
 */
function roundedRectSdf(lx: number, ly: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(lx) - (hx - r);
  const qy = Math.abs(ly) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * The neon-arcade brand mark on a navy night: a city skyline along the bottom
 * and the two gem tap-tiles (cyan→violet, the same mark as the `.logo__tile`
 * wordmark) glowing over it. Matches `RetroBackdrop` and the play scene so the
 * home-screen icon reads as this game.
 *
 * `padding` insets the art. Maskable icons get a generous inset because Android
 * crops them to whatever shape the launcher uses, and anything in the outer
 * ~10% on each side can be cut off.
 */
function drawIcon(size: number, padding: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);

  const bgTop: Rgb = [0x0c, 0x0c, 0x22];
  const bgBottom: Rgb = [0x06, 0x06, 0x12];
  const building: Rgb = [0x1a, 0x11, 0x40];
  const gemTop: Rgb = [0x9b, 0xe8, 0xff]; // lit cyan edge
  const gemMid: Rgb = [0x35, 0xe0, 0xff];
  const gemBottom: Rgb = [0x4a, 0x2b, 0xa0]; // deep violet base
  const glow: Rgb = [0xff, 0x3f, 0xa4]; // pink halo

  const art = size - padding * 2;
  const cx = size / 2;
  const cy = size / 2;
  const skylineY = padding + art * 0.72;

  // Two tiles, tilted toward each other and offset — the brand mark.
  const th = art * 0.2; // tile half-size
  const radius = th * 0.28;
  const tiles = [
    { tx: cx - art * 0.17, ty: cy + art * 0.06, rot: (-10 * Math.PI) / 180 },
    { tx: cx + art * 0.17, ty: cy - art * 0.06, rot: (10 * Math.PI) / 180 },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      const inset = x < padding || x >= size - padding || y < padding || y >= size - padding;
      if (inset) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
        continue;
      }

      // Navy sky, deepening toward the bottom.
      const t = Math.min(1, Math.max(0, (y - padding) / art));
      let [r, g, b] = mix(bgTop, bgBottom, t);

      // City skyline: blocky towers hashed by column, standing on the base band.
      if (y > skylineY) {
        const col = Math.floor(((x - padding) / art) * 12);
        const h = 0.4 + 0.6 * (((col * 2654435761) >>> 8) / 0xffffff % 1);
        const roofY = skylineY - art * 0.14 * h;
        if (y > roofY) [r, g, b] = mix([r, g, b], building, 0.9);
      }

      // Pink glow pooled behind the tiles.
      const gd = Math.hypot(x - cx, y - cy) / (art * 0.5);
      const halo = Math.max(0, 1 - gd) ** 2 * 0.5;
      [r, g, b] = mix([r, g, b], glow, halo);

      // The two gem tiles.
      for (const { tx, ty, rot } of tiles) {
        const dx = x - tx;
        const dy = y - ty;
        const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
        const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
        const d = roundedRectSdf(lx, ly, th, th, radius);
        if (d <= 0) {
          const v = (ly + th) / (2 * th); // 0 top → 1 bottom
          const base = v < 0.5 ? mix(gemTop, gemMid, v * 2) : mix(gemMid, gemBottom, (v - 0.5) * 2);
          [r, g, b] = base;
        } else if (d < art * 0.02) {
          // A soft pink rim just outside the tile edge.
          [r, g, b] = mix([r, g, b], glow, 1 - d / (art * 0.02));
        }
      }

      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }

  return px;
}

mkdirSync(OUT_DIR, { recursive: true });

for (const { name, size, padding } of [
  { name: 'icon-192.png', size: 192, padding: 0 },
  { name: 'icon-512.png', size: 512, padding: 0 },
  // Safe-zone inset: launchers crop maskable icons to a circle or squircle.
  { name: 'icon-maskable-512.png', size: 512, padding: 54 },
]) {
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, encodePng(size, size, drawIcon(size, padding)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

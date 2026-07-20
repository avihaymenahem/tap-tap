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
 * The retro sun on the app's night sky — the same motif as `RetroBackdrop` and
 * the play screen's backdrop, so the home-screen icon reads as this game.
 *
 * `padding` insets the art. Maskable icons get a generous inset because Android
 * crops them to whatever shape the launcher uses, and anything in the outer
 * ~10% on each side can be cut off.
 */
function drawIcon(size: number, padding: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);

  const skyTop: Rgb = [0x12, 0x03, 0x30];
  const skyHorizon: Rgb = [0x4a, 0x0d, 0x3a];
  const sunTop: Rgb = [0xff, 0xd9, 0xe8];
  const sunBottom: Rgb = [0xff, 0x2e, 0x88];
  const grid: Rgb = [0xff, 0x2e, 0x88];

  const art = size - padding * 2;
  const cx = size / 2;
  // Sun sits above the horizon line, half-set, as on the menu backdrop.
  const horizonY = padding + art * 0.66;
  const sunR = art * 0.30;
  const sunCy = horizonY - sunR * 0.18;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      const inset = x < padding || x >= size - padding || y < padding || y >= size - padding;
      if (inset) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
        continue;
      }

      // Sky gradient, deepening toward the top.
      const t = Math.min(1, Math.max(0, (y - padding) / (horizonY - padding)));
      let [r, g, b] = mix(skyTop, skyHorizon, t * t);

      if (y > horizonY) {
        // Ground: near-black with perspective grid lines converging on the
        // horizon. Spacing widens with distance from it, which is what sells
        // the perspective at this size.
        r = 0x0a;
        g = 0x02;
        b = 0x18;
        const depth = (y - horizonY) / (size - padding - horizonY);
        const rung = Math.abs(((depth * depth * 7) % 1) - 0.5) < 0.06;
        const spread = (x - cx) / (art * 0.5);
        const column = Math.abs(((spread / Math.max(depth, 0.05)) % 1) - 0.5) < 0.09;
        if (rung || column) {
          const fade = 0.35 + depth * 0.5;
          [r, g, b] = mix([r, g, b], grid, fade);
        }
      } else {
        // Sun, clipped flat at the horizon and cut by horizontal slits.
        const dx = (x - cx) / sunR;
        const dy = (y - sunCy) / sunR;
        if (dx * dx + dy * dy <= 1) {
          const depth = (y - (sunCy - sunR)) / (sunR * 2);
          const slitPhase = ((y - padding) / Math.max(2, art * 0.035)) % 1;
          const gap = 0.12 + depth * 0.5;
          const solid = depth < 0.25 || slitPhase > gap;
          if (solid) [r, g, b] = mix(sunTop, sunBottom, Math.min(1, depth * 1.25));
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

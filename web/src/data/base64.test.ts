import { describe, expect, it } from 'vitest';
import { arrayBufferToBase64 } from './base64.js';

/**
 * The seed path base64-encodes binary files (a ~4MB audio buffer) for Filesystem
 * writes. The chunking exists to avoid a stack overflow on large inputs, so the
 * test includes a buffer past one chunk (0x8000) to exercise the seam.
 */
describe('arrayBufferToBase64', () => {
  it('round-trips through atob', () => {
    const bytes = Uint8Array.from([0, 1, 2, 254, 255, 65, 66, 67]);
    const decoded = atob(arrayBufferToBase64(bytes.buffer));
    expect([...decoded].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
  });

  it('handles an empty buffer', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
  });

  it('encodes a buffer larger than one chunk without overflowing', () => {
    const size = 0x8000 * 2 + 123; // spans three chunks
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 256;
    const decoded = atob(arrayBufferToBase64(bytes.buffer));
    expect(decoded.length).toBe(size);
    expect(decoded.charCodeAt(size - 1)).toBe((size - 1) % 256);
  });
});

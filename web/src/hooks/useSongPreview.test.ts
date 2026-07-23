import { describe, expect, it } from 'vitest';
import { PREVIEW_SEC, previewStartSec } from './useSongPreview.js';

describe('previewStartSec', () => {
  it('starts about a quarter of the way into a normal song', () => {
    expect(previewStartSec(200)).toBeCloseTo(56, 5); // 200 * 0.28
  });

  it('clamps so a short song still gets a full clip', () => {
    // 20s track: 28% is 5.6s, but only 5s of runway leaves room for a 15s clip.
    expect(previewStartSec(20)).toBe(5);
  });

  it('is 0 for a missing or nonsense duration', () => {
    expect(previewStartSec(0)).toBe(0);
    expect(previewStartSec(-3)).toBe(0);
  });

  it('never starts so late the clip would run off the end', () => {
    for (const d of [16, 30, 90, 240]) {
      expect(previewStartSec(d)).toBeLessThanOrEqual(Math.max(0, d - PREVIEW_SEC));
    }
  });
});

import type { SongSummary } from '@tap-tap/shared';
import { describe, expect, it } from 'vitest';
import { filterFavorites, filterSongs, paginate, sortSongs } from './songSearch.js';

function song(partial: Partial<SongSummary> & { title: string }): SongSummary {
  return {
    songId: partial.title.toLowerCase().replace(/\s+/g, '-'),
    artist: '',
    duration: 200,
    bpm: 120,
    bpmConfidence: 0.8,
    thumbnailUrl: null,
    noteCounts: { easy: 100, medium: 200, hard: 300 },
    audioUrl: '/media/x/audio.m4a',
    ...partial,
  };
}

const library = [
  song({ title: 'Lose Yourself', artist: 'Eminem', bpm: 171, bpmConfidence: 0.9 }),
  song({ title: 'Titanium', artist: 'David Guetta', bpm: 126, bpmConfidence: 0.3 }),
  song({ title: 'Hey Ya!', artist: 'Outkast', bpm: 79, bpmConfidence: 0.62 }),
];

describe('filterSongs', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(filterSongs(library, '')).toHaveLength(3);
    expect(filterSongs(library, '   ')).toHaveLength(3);
  });

  it('matches across title and artist together', () => {
    // The whole point of requiring every term: neither word alone is unique to
    // one field, but together they identify one track.
    const found = filterSongs(library, 'eminem lose');
    expect(found.map((s) => s.title)).toEqual(['Lose Yourself']);
  });

  it('ignores case and extra whitespace', () => {
    expect(filterSongs(library, '  TITANIUM  ')).toHaveLength(1);
  });

  it('matches substrings, not just word starts', () => {
    expect(filterSongs(library, 'tani')).toHaveLength(1);
  });

  it('returns nothing when one term of several fails', () => {
    expect(filterSongs(library, 'eminem titanium')).toHaveLength(0);
  });

  it('does not mutate the input', () => {
    const before = [...library];
    filterSongs(library, 'hey');
    expect(library).toEqual(before);
  });
});

describe('sortSongs', () => {
  it('sorts by title', () => {
    expect(sortSongs(library, 'title').map((s) => s.title)).toEqual([
      'Hey Ya!',
      'Lose Yourself',
      'Titanium',
    ]);
  });

  it('sorts by ascending bpm', () => {
    expect(sortSongs(library, 'bpm').map((s) => s.bpm)).toEqual([79, 126, 171]);
  });

  it('puts the worst tempo confidence first', () => {
    // The admin workflow is finding broken detections to regenerate, so the
    // least trustworthy has to surface rather than sink.
    expect(sortSongs(library, 'confidence').map((s) => s.bpmConfidence)).toEqual([0.3, 0.62, 0.9]);
  });

  it('breaks ties on title so equal keys do not shuffle', () => {
    const tied = [
      song({ title: 'Beta', bpm: 100 }),
      song({ title: 'Alpha', bpm: 100 }),
    ];
    expect(sortSongs(tied, 'bpm').map((s) => s.title)).toEqual(['Alpha', 'Beta']);
  });

  it('does not mutate the input', () => {
    const before = [...library];
    sortSongs(library, 'bpm');
    expect(library).toEqual(before);
  });
});

describe('paginate', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('slices a page and reports its span', () => {
    const p = paginate(items, 2, 4);
    expect(p.items).toEqual([5, 6, 7, 8]);
    expect(p).toMatchObject({ page: 2, pageCount: 3, from: 5, to: 8 });
  });

  it('handles a partial last page', () => {
    const p = paginate(items, 3, 4);
    expect(p.items).toEqual([9, 10]);
    expect(p).toMatchObject({ from: 9, to: 10 });
  });

  it('handles an exact multiple without an empty trailing page', () => {
    expect(paginate(items, 1, 5).pageCount).toBe(2);
  });

  it('clamps a page past the end', () => {
    // The case that matters: deleting the last song on the last page. Without
    // clamping the view sits on a page that no longer exists and shows nothing.
    const p = paginate(items, 99, 4);
    expect(p.page).toBe(3);
    expect(p.items).toEqual([9, 10]);
  });

  it('clamps nonsense page numbers', () => {
    expect(paginate(items, 0, 4).page).toBe(1);
    expect(paginate(items, -5, 4).page).toBe(1);
    expect(paginate(items, Number.NaN, 4).page).toBe(1);
  });

  it('survives an empty list', () => {
    const p = paginate([], 1, 10);
    expect(p).toMatchObject({ items: [], page: 1, pageCount: 1, from: 0, to: 0 });
  });

  it('never divides by a zero page size', () => {
    expect(paginate(items, 1, 0).items).toHaveLength(1);
  });

  it('does not mutate the input', () => {
    const before = [...items];
    paginate(items, 2, 3);
    expect(items).toEqual(before);
  });
});

describe('favorites', () => {
  const ids = (songs: SongSummary[]): string[] => songs.map((s) => s.title);
  const starred = new Set(['titanium']);

  describe('filterFavorites', () => {
    it('is identity when the filter is off', () => {
      expect(ids(filterFavorites(library, starred, false))).toEqual(ids(library));
    });

    it('keeps only starred songs when on', () => {
      expect(ids(filterFavorites(library, starred, true))).toEqual(['Titanium']);
    });

    it('is identity when nothing is starred, rather than emptying the library', () => {
      // A filter that can only ever hide everything is worse than no filter —
      // the UI hides the control too, and this is the belt to that braces.
      expect(ids(filterFavorites(library, new Set(), true))).toEqual(ids(library));
    });

    it('does not mutate the input', () => {
      const before = [...library];
      filterFavorites(library, starred, true);
      expect(library).toEqual(before);
    });
  });

  describe("sortSongs('favorite')", () => {
    it('floats starred songs to the top', () => {
      expect(ids(sortSongs(library, 'favorite', starred))[0]).toBe('Titanium');
    });

    it('sorts alphabetically within each group', () => {
      // Predictability matters more than recency here: a list that reorders
      // itself on every visit is harder to use than one that never does.
      const two = new Set(['titanium', 'lose-yourself']);
      expect(ids(sortSongs(library, 'favorite', two))).toEqual([
        'Lose Yourself',
        'Titanium',
        'Hey Ya!',
      ]);
    });

    it('falls back to alphabetical when nothing is starred', () => {
      expect(ids(sortSongs(library, 'favorite', new Set()))).toEqual([
        'Hey Ya!',
        'Lose Yourself',
        'Titanium',
      ]);
    });

    it('does not need a favorites argument at all', () => {
      // Every other caller — the admin screen — passes no favourites.
      expect(() => sortSongs(library, 'favorite')).not.toThrow();
      expect(ids(sortSongs(library, 'title'))).toEqual(ids(sortSongs(library, 'title', starred)));
    });
  });
});

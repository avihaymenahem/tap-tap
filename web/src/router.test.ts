import { describe, expect, it } from 'vitest';
import { parseRoute, routeToPath, type Route } from './router.js';

describe('parseRoute', () => {
  it('maps the flat routes', () => {
    expect(parseRoute('/')).toEqual({ name: 'menu' });
    expect(parseRoute('/admin')).toEqual({ name: 'admin' });
    expect(parseRoute('/admin/themes')).toEqual({ name: 'themes' });
    // An unknown admin sub-path is the library, not a dead end.
    expect(parseRoute('/admin/nonsense')).toEqual({ name: 'admin' });
    expect(parseRoute('/calibrate')).toEqual({ name: 'calibrate' });
  });

  it('parses play and results with a difficulty', () => {
    expect(parseRoute('/play/abc123/hard')).toEqual({
      name: 'play',
      songId: 'abc123',
      difficulty: 'hard',
    });
    expect(parseRoute('/results/abc123/easy')).toEqual({
      name: 'results',
      songId: 'abc123',
      difficulty: 'easy',
    });
  });

  it('tolerates surrounding and repeated slashes', () => {
    expect(parseRoute('')).toEqual({ name: 'menu' });
    expect(parseRoute('//admin//')).toEqual({ name: 'admin' });
    expect(parseRoute('/play/abc/medium/')).toEqual({
      name: 'play',
      songId: 'abc',
      difficulty: 'medium',
    });
  });

  it('decodes ids that needed escaping', () => {
    expect(parseRoute('/play/a%2Fb/easy')).toEqual({
      name: 'play',
      songId: 'a/b',
      difficulty: 'easy',
    });
  });

  it('falls back to the menu for anything unrecognized', () => {
    // Parsing must be total: a bad URL should never produce an unhandled route.
    expect(parseRoute('/nonsense')).toEqual({ name: 'menu' });
    expect(parseRoute('/play')).toEqual({ name: 'menu' });
    expect(parseRoute('/play/abc')).toEqual({ name: 'menu' });
    expect(parseRoute('/play/abc/impossible')).toEqual({ name: 'menu' });
    expect(parseRoute('/results/abc/expert')).toEqual({ name: 'menu' });
  });
});

describe('routeToPath', () => {
  it('builds the expected paths', () => {
    expect(routeToPath({ name: 'menu' })).toBe('/');
    expect(routeToPath({ name: 'admin' })).toBe('/admin');
    expect(routeToPath({ name: 'calibrate' })).toBe('/calibrate');
    expect(routeToPath({ name: 'play', songId: 'abc', difficulty: 'hard' })).toBe(
      '/play/abc/hard',
    );
  });

  it('escapes ids that contain path characters', () => {
    expect(routeToPath({ name: 'play', songId: 'a/b', difficulty: 'easy' })).toBe(
      '/play/a%2Fb/easy',
    );
  });
});

describe('round trip', () => {
  const routes: Route[] = [
    { name: 'menu' },
    { name: 'admin' },
    { name: 'themes' },
    { name: 'calibrate' },
    { name: 'play', songId: 'dQw4w9WgXcQ', difficulty: 'easy' },
    { name: 'play', songId: '_Yhyp-_hX2s', difficulty: 'medium' },
    { name: 'results', songId: 'abc123', difficulty: 'hard' },
    { name: 'results', songId: 'a/b c', difficulty: 'easy' },
  ];

  it.each(routes)('survives serialize then parse: $name', (route) => {
    expect(parseRoute(routeToPath(route))).toEqual(route);
  });
});

describe('authoring disabled (read-only server)', () => {
  const options = { authoring: false };

  it('sends the authoring routes to the menu', () => {
    expect(parseRoute('/admin', options)).toEqual({ name: 'menu' });
    expect(parseRoute('/edit/abc/hard', options)).toEqual({ name: 'menu' });
  });

  it('gates the theme editor too', () => {
    // It is nested under /admin precisely so this needs no separate rule —
    // this test is what stops that nesting being "simplified" apart later.
    expect(parseRoute('/admin/themes', options)).toEqual({ name: 'menu' });
  });

  it('leaves the player routes alone', () => {
    expect(parseRoute('/play/abc/hard', options)).toEqual({
      name: 'play',
      songId: 'abc',
      difficulty: 'hard',
    });
    expect(parseRoute('/results/abc/easy', options)).toEqual({
      name: 'results',
      songId: 'abc',
      difficulty: 'easy',
    });
    expect(parseRoute('/calibrate', options)).toEqual({ name: 'calibrate' });
  });

  it('defaults to allowing authoring when no option is passed', () => {
    expect(parseRoute('/admin')).toEqual({ name: 'admin' });
  });
});

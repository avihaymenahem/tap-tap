import { describe, expect, it } from 'vitest';
import { cleanTrackMeta } from './clean-title.js';

describe('cleanTrackMeta', () => {
  it('strips a trailing "(Official Music Video)" tag', () => {
    const { title } = cleanTrackMeta('Blinding Lights (Official Music Video)', 'The Weeknd');
    expect(title).toBe('Blinding Lights');
  });

  it('removes multiple bracket tags of different kinds', () => {
    const { title } = cleanTrackMeta('Levitating [Official Audio] (Lyrics) [HD]', 'Dua Lipa');
    expect(title).toBe('Levitating');
  });

  it('drops a pipe-separated promo segment', () => {
    const { title } = cleanTrackMeta('Song Name | Official Lyric Video', 'Someone');
    expect(title).toBe('Song Name');
  });

  it('drops a dash-separated promo segment without stealing it as the artist', () => {
    const { title, artist } = cleanTrackMeta('Song Name - Official Video', 'Band');
    expect(title).toBe('Song Name');
    expect(artist).toBe('Band');
  });

  it('splits "Artist - Title" into fields', () => {
    const { title, artist } = cleanTrackMeta('Daft Punk - Get Lucky (Official Audio)', 'DaftPunkVEVO');
    expect(artist).toBe('Daft Punk');
    expect(title).toBe('Get Lucky');
  });

  it('prefers the title split over the uploader for the artist', () => {
    const { artist } = cleanTrackMeta('Rick Astley - Never Gonna Give You Up', 'RickAstleyVEVO');
    expect(artist).toBe('Rick Astley');
  });

  it('keeps meaningful parentheticals', () => {
    expect(cleanTrackMeta('Song (Remix)', 'X').title).toBe('Song (Remix)');
    expect(cleanTrackMeta('Song (Live at Wembley)', 'X').title).toBe('Song (Live at Wembley)');
    expect(cleanTrackMeta('Song (feat. Someone)', 'X').title).toBe('Song (feat. Someone)');
  });

  it('removes resolution and framerate junk', () => {
    expect(cleanTrackMeta('Track [4K] (60fps)', 'X').title).toBe('Track');
    expect(cleanTrackMeta('Track (1080p HD)', 'X').title).toBe('Track');
  });

  it('cleans VEVO / "- Topic" / "Official" out of the uploader fallback', () => {
    expect(cleanTrackMeta('Just A Song', 'BandVEVO').artist).toBe('Band');
    expect(cleanTrackMeta('Just A Song', 'Some Artist - Topic').artist).toBe('Some Artist');
    expect(cleanTrackMeta('Just A Song', 'Official Band').artist).toBe('Band');
  });

  it('joins a multi-dash title after taking the artist', () => {
    const { artist, title } = cleanTrackMeta('Artist - Song - Acoustic Version', 'up');
    expect(artist).toBe('Artist');
    expect(title).toBe('Song - Acoustic Version');
  });

  it('never returns an empty title even if everything reads as junk', () => {
    const { title } = cleanTrackMeta('(Official Video)', 'X');
    expect(title.length).toBeGreaterThan(0);
  });

  it('strips surrounding quotes', () => {
    expect(cleanTrackMeta('"Song Title" (Audio)', 'X').title).toBe('Song Title');
  });

  it('leaves an already-clean title untouched', () => {
    const { title, artist } = cleanTrackMeta('Clair de Lune', 'Claude Debussy');
    expect(title).toBe('Clair de Lune');
    expect(artist).toBe('Claude Debussy');
  });
});

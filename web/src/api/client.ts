import type { AnalysisResult, Beatmap, Job, SongSummary, Theme, Waveform } from '@tap-tap/shared';

/** Typed wrappers over the ingest server. Vite proxies /api and /media in dev. */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      body && typeof body === 'object' && 'error' in body ? String(body.error) : response.statusText;
    throw new Error(detail || `Request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

/** Server capabilities. Read once at boot; see `serverConfig.ts`. */
export function getConfig(): Promise<{ readOnly: boolean }> {
  return request<{ readOnly: boolean }>('/api/config');
}

export function listSongs(): Promise<SongSummary[]> {
  return request<SongSummary[]>('/api/songs');
}

export function getBeatmap(songId: string): Promise<Beatmap> {
  return request<Beatmap>(`/api/songs/${encodeURIComponent(songId)}`);
}

/** The full onset pool, including candidates the chart generator rejected. */
export function getAnalysis(songId: string): Promise<AnalysisResult> {
  return request<AnalysisResult>(`/api/songs/${encodeURIComponent(songId)}/analysis`);
}

export function getWaveform(songId: string): Promise<Waveform> {
  return request<Waveform>(`/api/songs/${encodeURIComponent(songId)}/waveform`);
}

export function renameSong(
  songId: string,
  title: string,
  artist: string,
): Promise<SongSummary> {
  return request<SongSummary>(`/api/songs/${encodeURIComponent(songId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title, artist }),
  });
}

/**
 * Sends only `themeId`. The PATCH route treats an absent title as "not renamed"
 * and leaves `customName` alone — passing the current title back would flag the
 * song as hand-named and freeze it against the next re-ingest.
 */
export function setSongTheme(songId: string, themeId: string): Promise<SongSummary> {
  return request<SongSummary>(`/api/songs/${encodeURIComponent(songId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ themeId }),
  });
}

// --- themes ----------------------------------------------------------------

/**
 * Custom themes only — the built-ins are compiled in. Wrap with `themeCatalog`
 * to get the full list; do not use this result as a catalogue on its own or
 * every song will resolve to the default.
 */
export function listCustomThemes(): Promise<Theme[]> {
  return request<Theme[]>('/api/themes');
}

export function createTheme(theme: Theme): Promise<Theme> {
  return request<Theme>('/api/themes', { method: 'POST', body: JSON.stringify(theme) });
}

export function updateTheme(theme: Theme): Promise<Theme> {
  return request<Theme>(`/api/themes/${encodeURIComponent(theme.id)}`, {
    method: 'PUT',
    body: JSON.stringify(theme),
  });
}

export function deleteTheme(themeId: string): Promise<{ removed: boolean; songsAffected: number }> {
  return request(`/api/themes/${encodeURIComponent(themeId)}`, { method: 'DELETE' });
}

export function deleteSong(songId: string): Promise<{ removed: boolean }> {
  return request(`/api/songs/${encodeURIComponent(songId)}`, { method: 'DELETE' });
}

export function regenerateCharts(songId: string): Promise<SongSummary> {
  return request(`/api/songs/${encodeURIComponent(songId)}/regenerate`, { method: 'POST' });
}

export function startIngest(url: string): Promise<Job> {
  return request<Job>('/api/ingest', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export function getJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function listJobs(): Promise<Job[]> {
  return request<Job[]>('/api/jobs');
}

/** Drops finished jobs only; anything still running is left alone. */
export function clearFinishedJobs(): Promise<{ removed: number }> {
  return request<{ removed: number }>('/api/jobs/finished', { method: 'DELETE' });
}

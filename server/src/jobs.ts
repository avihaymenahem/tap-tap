import type { Job, JobStatus } from '@tap-tap/shared';
import { isJobFinished } from '@tap-tap/shared';
import { randomUUID } from 'node:crypto';

/**
 * In-memory job registry.
 *
 * Jobs are progress indicators for the admin UI, not durable records — the
 * durable output is the beatmap on disk. Losing them on restart is fine.
 */
const jobs = new Map<string, Job>();

const MAX_JOBS = 100;

export function createJob(url: string): Job {
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    url,
    songId: null,
    status: 'queued',
    message: 'Queued',
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);

  // Trim oldest once the map grows past the cap.
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const stale of oldest.slice(0, jobs.size - MAX_JOBS)) jobs.delete(stale.id);
  }

  return job;
}

export function updateJob(id: string, patch: Partial<Omit<Job, 'id'>>): Job | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  const next: Job = { ...job, ...patch, updatedAt: Date.now() };
  jobs.set(id, next);
  return next;
}

export function setJobStatus(id: string, status: JobStatus, message: string): void {
  updateJob(id, { status, message });
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Drop finished jobs, keeping anything still running.
 *
 * Deliberately never clears an in-flight job: the ingest would carry on in the
 * background with nothing left to report progress against, so the admin would
 * watch an idle screen while the machine downloads and analyses a track.
 *
 * @returns how many were removed.
 */
export function clearFinishedJobs(): number {
  let removed = 0;
  for (const job of jobs.values()) {
    if (!isJobFinished(job.status)) continue;
    jobs.delete(job.id);
    removed++;
  }
  return removed;
}

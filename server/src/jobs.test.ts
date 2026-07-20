import { describe, expect, it, vi } from 'vitest';

/**
 * The registry is module-level state, so each test imports a fresh copy rather
 * than trying to unwind the previous one.
 */
async function freshJobs() {
  vi.resetModules();
  return import('./jobs.js');
}

describe('clearFinishedJobs', () => {
  it('removes done and error jobs', async () => {
    const jobs = await freshJobs();

    const done = jobs.createJob('https://youtu.be/a');
    const failed = jobs.createJob('https://youtu.be/b');
    jobs.setJobStatus(done.id, 'done', 'Ready');
    jobs.setJobStatus(failed.id, 'error', 'Failed');

    expect(jobs.clearFinishedJobs()).toBe(2);
    expect(jobs.listJobs()).toHaveLength(0);
  });

  it('keeps jobs that are still running', async () => {
    const jobs = await freshJobs();

    const done = jobs.createJob('https://youtu.be/a');
    const running = jobs.createJob('https://youtu.be/b');
    jobs.setJobStatus(done.id, 'done', 'Ready');
    jobs.setJobStatus(running.id, 'analyzing', 'Analyzing');

    // The ingest carries on regardless of the registry, so dropping its job
    // would leave the machine working with nothing reporting progress.
    expect(jobs.clearFinishedJobs()).toBe(1);
    expect(jobs.listJobs().map((j) => j.id)).toEqual([running.id]);
  });

  it.each(['queued', 'downloading', 'transcoding', 'analyzing', 'generating'] as const)(
    'treats %s as still running',
    async (status) => {
      const jobs = await freshJobs();
      const job = jobs.createJob('https://youtu.be/a');
      jobs.setJobStatus(job.id, status, status);

      expect(jobs.clearFinishedJobs()).toBe(0);
      expect(jobs.listJobs()).toHaveLength(1);
    },
  );

  it('reports zero on an empty registry', async () => {
    const jobs = await freshJobs();
    expect(jobs.clearFinishedJobs()).toBe(0);
  });

  it('leaves the registry usable afterwards', async () => {
    const jobs = await freshJobs();
    const first = jobs.createJob('https://youtu.be/a');
    jobs.setJobStatus(first.id, 'done', 'Ready');
    jobs.clearFinishedJobs();

    const next = jobs.createJob('https://youtu.be/c');
    expect(jobs.getJob(next.id)).toBeDefined();
    expect(jobs.listJobs()).toHaveLength(1);
  });
});

/**
 * postcardUploadQueue — uploads that belong to the APP, not to the screen that
 * started them (Media spec §37 "Background upload").
 *
 * Before this, `uploadMedia` and the postcard composer ran the whole upload
 * inside the composer's own handler: close the screen, background the app, or
 * lose the process, and the upload — and every byte already sent — was gone.
 *
 * Here a job is written to storage BEFORE its first request and after every
 * stage (postcardUploadPipeline), and a single serial runner drives the jobs:
 *   • the composer can close; the job keeps running (the runner is module-level);
 *   • the app can be backgrounded; each part is an OS background transfer
 *     (backgroundTransfer.ts) and the next foreground resumes the queue;
 *   • the process can die; the next launch resumes each unfinished job at the
 *     stage it reached, and the bytes stage asks the server what already landed.
 *
 * ACCOUNT-SCOPED, fail-closed: jobs are stored under the account that made them
 * and only ever run while that account is signed in. With no resolvable account
 * nothing is enqueued and nothing runs — a job is never executed under another
 * person's session.
 *
 * Gated by uploadTransportFlag (ships OFF). Every effect is injected through
 * QueueRuntime, so this module runs under node:test.
 */
import {
  newPostcardUploadJob,
  runPostcardUpload,
  TERMINAL_STAGES,
  type PipelineDeps,
  type PostcardUploadInput,
  type PostcardUploadJob,
} from './postcardUploadPipeline.ts';

export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface QueueRuntime {
  storage: QueueStorage;
  accountId(): Promise<string | null>;
  newId(): string;
  now(): number;
  /** The pipeline's effects, minus persistence (the queue owns that). */
  deps(): Promise<Omit<PipelineDeps, 'persist'>>;
}

export interface QueueEvent {
  job: PostcardUploadJob;
  /** Fraction of the file's bytes that have landed, while the bytes stage runs. */
  progress?: number;
}

const KEY_PREFIX = 'media_upload_queue_v1:';
/** Finished jobs kept for the UI to report on; older ones are dropped. */
const KEEP_TERMINAL = 10;
/** A job that has paused this many times is failed rather than retried forever. */
export const MAX_RUNS = 25;

export function queueKey(accountId: string): string {
  return `${KEY_PREFIX}${accountId}`;
}

export class PostcardUploadQueue {
  private readonly rt: QueueRuntime;
  private readonly listeners = new Set<(e: QueueEvent) => void>();
  private readonly cancelled = new Set<string>();
  private draining: Promise<void> | null = null;
  /** Serialises every read-modify-write of the stored list. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(rt: QueueRuntime) {
    this.rt = rt;
  }

  subscribe(listener: (e: QueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: QueueEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch { /* a listener must not break the runner */ }
    }
  }

  private async load(accountId: string): Promise<PostcardUploadJob[]> {
    try {
      const raw = await this.rt.storage.getItem(queueKey(accountId));
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as PostcardUploadJob[]).filter((j) => j && j.accountId === accountId) : [];
    } catch {
      return [];
    }
  }

  private upsert(accountId: string, job: PostcardUploadJob): Promise<void> {
    const next = this.writeChain.then(async () => {
      const jobs = await this.load(accountId);
      const i = jobs.findIndex((j) => j.id === job.id);
      if (i >= 0) jobs[i] = job; else jobs.push(job);
      const live = jobs.filter((j) => !TERMINAL_STAGES.has(j.stage));
      const done = jobs.filter((j) => TERMINAL_STAGES.has(j.stage)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, KEEP_TERMINAL);
      await this.rt.storage.setItem(queueKey(accountId), JSON.stringify([...live, ...done]));
    });
    this.writeChain = next.catch(() => {});
    return next;
  }

  /** The signed-in account's jobs, newest first. */
  async list(): Promise<PostcardUploadJob[]> {
    const accountId = await this.rt.accountId();
    if (!accountId) return [];
    return (await this.load(accountId)).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Record the job, then start (or join) the runner. Resolves once the job is
   * DURABLE — not when it finishes. Null when no account is signed in.
   */
  async enqueue(input: PostcardUploadInput): Promise<PostcardUploadJob | null> {
    const accountId = await this.rt.accountId();
    if (!accountId) return null;
    const job = newPostcardUploadJob(this.rt.newId(), accountId, input, this.rt.now());
    await this.upsert(accountId, job);
    this.emit({ job });
    void this.resumePending();
    return job;
  }

  /** Ask for a job to stop. Takes effect at the next stage boundary or retry wait. */
  cancel(jobId: string): void {
    this.cancelled.add(jobId);
  }

  /**
   * Run every unfinished job of the signed-in account, oldest first, one at a
   * time. Concurrent callers share one run. Resolves when the run ends.
   */
  resumePending(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    const accountId = await this.rt.accountId();
    if (!accountId) return;
    const pending = (await this.load(accountId))
      .filter((j) => !TERMINAL_STAGES.has(j.stage))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return;
    const deps = await this.rt.deps();
    for (const stored of pending) {
      // The account may have changed while an earlier job ran.
      if ((await this.rt.accountId()) !== accountId) return;
      let job = stored;
      if (job.runs >= MAX_RUNS) {
        if (job.postId) await deps.discardShell(job.postId).catch(() => {});
        job = { ...job, stage: 'failed', retryable: false, lastError: 'Upload gave up after repeated failures', updatedAt: this.rt.now() };
        await this.upsert(accountId, job);
        this.emit({ job });
        continue;
      }
      let latest = job;
      job = await runPostcardUpload(
        job,
        {
          ...deps,
          persist: (j) => this.upsert(accountId, j),
        },
        {
          onStage: (j) => {
            latest = j;
            this.emit({ job: j });
          },
          onProgress: (progress) => this.emit({ job: latest, progress }),
          isCancelled: () => this.cancelled.has(stored.id),
        },
      );
      this.cancelled.delete(stored.id);
      // A paused job stays paused for this run; the next trigger resumes it.
    }
  }
}

// ── The device queue (lazily assembled; nothing here runs while the flag is off) ──

let _queue: PostcardUploadQueue | null = null;

/** Test seam: replace the device queue (or clear it with null). */
export function _setPostcardUploadQueue(queue: PostcardUploadQueue | null): void {
  _queue = queue;
}

export async function getPostcardUploadQueue(): Promise<PostcardUploadQueue> {
  if (_queue) return _queue;
  const { deviceQueueRuntime } = await import('./postcardUploadDevice.ts');
  _queue = new PostcardUploadQueue(deviceQueueRuntime());
  return _queue;
}

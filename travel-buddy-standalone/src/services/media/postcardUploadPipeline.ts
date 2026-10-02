/**
 * postcardUploadPipeline — the postcard upload as a RESUMABLE sequence of
 * stages, each recorded before the next begins (Media spec §37 "Upload
 * resume / retry" and "Background upload").
 *
 *   queued → shell → slot → bytes → poster → done
 *     shell   POST /postcards                       (the post row)
 *     slot    POST /postcards/:id/media/upload-url  (the reserved post_media slot)
 *     bytes   resumable parts (resumableUpload.ts), or ONE signed PUT when the
 *             server cannot run a session — each retried by uploadRetry.ts
 *     poster  a device-extracted frame for a video (fail-soft)
 *     done    POST .../complete                     (server verifies, scrubs, probes)
 *
 * Every stage that succeeds is PERSISTED (deps.persist) before the next one
 * starts, so a job interrupted anywhere — screen closed, app backgrounded, app
 * killed — is re-entered at the stage it reached, holding the ids it already
 * has. Re-entry at `bytes` is where resumability pays: the slot IS the resume
 * token, and the session lists what Storage already holds.
 *
 * A RETRYABLE failure (the network, a 5xx, a 429) leaves the job at its stage
 * with `retryable: true` — paused, not failed — for the next run. A REFUSAL
 * fails the job and discards the post shell, exactly as the composer always
 * has: an empty postcard is never left on the author's profile.
 *
 * Pure orchestration; every effect is injected. No react-native import.
 */
import type { NormalizedAsset } from './mediaProcessing.ts';
import type { FileLike, ResumableEnv, ResumableTransport } from './resumableUpload.ts';
import { abandonSlotSession, uploadSlotResumable } from './resumableUpload.ts';
import { DEFAULT_RETRY, withRetry } from './uploadRetry.ts';

export type PostcardUploadStage =
  | 'queued'
  | 'shell'
  | 'slot'
  | 'bytes'
  | 'poster'
  | 'done'
  | 'failed'
  | 'cancelled';

export const TERMINAL_STAGES: ReadonlySet<PostcardUploadStage> = new Set(['done', 'failed', 'cancelled']);

export interface StampOverlayPayload {
  stampDefinitionId: string;
  style?: 'original' | 'white' | 'dark' | 'watermark';
  x: number;
  y: number;
  scale: number;
  rotation?: number;
  opacity?: number;
}

export interface PostcardUploadInput {
  asset: NormalizedAsset;
  caption?: string;
  visibility: 'public' | 'private' | 'trip_only';
  /** Output of placeToLocationFields — coarse strings, place-level coordinates, ids. */
  location: Record<string, unknown>;
  addToPassport: boolean;
  stampOverlay?: StampOverlayPayload;
}

export interface PostcardUploadJob {
  id: string;
  /** The account that created the job. A job never runs under another account's session. */
  accountId: string | null;
  createdAt: number;
  updatedAt: number;
  input: PostcardUploadInput;
  stage: PostcardUploadStage;
  postId?: string;
  mediaId?: string;
  uploadUrl?: string;
  fileSizeBytes?: number;
  thumbnailPath?: string | null;
  transport?: 'resumable' | 'single';
  lastError?: string | null;
  /** True while paused on a transient failure; the next run resumes the same stage. */
  retryable?: boolean;
  runs: number;
  result?: { stampOverlayApplied?: boolean; stampOverlayError?: string };
}

/**
 * `retryable` marks a failure that got NO answer, or a 5xx/408/429 — the job
 * pauses at its stage. Absent/false is a refusal — the job fails. Creating the
 * shell and reserving the slot are safe to repeat (an orphaned pending slot is
 * swept server-side); `/complete` is idempotent by the server's own contract.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string; retryable?: boolean };

export interface PipelineDeps {
  createShell(input: PostcardUploadInput): Promise<ApiResult<{ id: string }>>;
  reserveSlot(postId: string, params: { mimeType: string; fileSizeBytes: number }): Promise<ApiResult<{ mediaId: string; uploadUrl: string }>>;
  readFile(uri: string): Promise<FileLike>;
  resumable: { enabled: boolean; transport: ResumableTransport };
  /** The single signed-URL PUT. Resolves {ok:false, status?} rather than throwing. */
  putWhole(uploadUrl: string, file: FileLike, mimeType: string, onProgress: (f: number) => void): Promise<{ ok: boolean; status?: number | null; message?: string }>;
  extractPoster(videoUri: string): Promise<string | null>;
  uploadPoster(postId: string, mediaId: string, posterUri: string): Promise<string | null>;
  complete(
    postId: string,
    mediaId: string,
    params: {
      mimeType: string;
      fileSizeBytes: number;
      durationSeconds?: number;
      width?: number;
      height?: number;
      thumbnailPath?: string;
      stampOverlay?: StampOverlayPayload;
    },
  ): Promise<ApiResult<{ stampOverlayApplied?: boolean; stampOverlayError?: string }>>;
  discardShell(postId: string): Promise<void>;
  persist(job: PostcardUploadJob): Promise<void>;
  now(): number;
  env: ResumableEnv;
}

export interface PipelineHooks {
  onProgress?: (fraction: number) => void;
  onStage?: (job: PostcardUploadJob) => void;
  isCancelled?: () => boolean;
}

export function newPostcardUploadJob(
  id: string,
  accountId: string | null,
  input: PostcardUploadInput,
  nowMs: number,
): PostcardUploadJob {
  return { id, accountId, createdAt: nowMs, updatedAt: nowMs, input, stage: 'queued', runs: 0 };
}

/**
 * Advance a job as far as it will go in this run. Returns the job in its new
 * state; the caller persists nothing itself (deps.persist has been called at
 * every transition).
 */
export async function runPostcardUpload(
  start: PostcardUploadJob,
  deps: PipelineDeps,
  hooks: PipelineHooks = {},
): Promise<PostcardUploadJob> {
  let job: PostcardUploadJob = { ...start, runs: start.runs + 1, retryable: false, lastError: null };
  const save = async (patch: Partial<PostcardUploadJob>) => {
    job = { ...job, ...patch, updatedAt: deps.now() };
    await deps.persist(job);
    hooks.onStage?.(job);
  };
  const cancelled = () => hooks.isCancelled?.() === true;
  const pause = (message: string) => save({ retryable: true, lastError: message });
  const fail = async (message: string) => {
    if (job.postId) await deps.discardShell(job.postId).catch(() => {});
    await save({ stage: 'failed', retryable: false, lastError: message });
  };
  const cancel = async () => {
    if (job.postId && job.mediaId && job.transport === 'resumable') {
      await abandonSlotSession({ postId: job.postId, mediaId: job.mediaId }, deps.resumable.transport);
    }
    if (job.postId) await deps.discardShell(job.postId).catch(() => {});
    await save({ stage: 'cancelled', retryable: false, lastError: 'Upload cancelled' });
  };

  if (TERMINAL_STAGES.has(job.stage)) return job;
  const { asset } = job.input;

  // ── shell ──────────────────────────────────────────────────────────────────
  if (job.stage === 'queued') {
    if (cancelled()) { await cancel(); return job; }
    const shell = await deps.createShell(job.input);
    if (!shell.ok) { await (shell.retryable ? pause(shell.message) : fail(shell.message)); return job; }
    await save({ stage: 'shell', postId: shell.data.id });
  }

  // ── slot ───────────────────────────────────────────────────────────────────
  if (job.stage === 'shell') {
    if (cancelled()) { await cancel(); return job; }
    // The slot is reserved for an EXACT size — the resume protocol checks every
    // part against it — so an unreported picker size is resolved from the bytes.
    let size = job.fileSizeBytes ?? asset.fileSizeBytes ?? null;
    if (size == null) {
      try {
        size = (await deps.readFile(asset.uri)).size;
      } catch {
        await fail('The file could not be read.');
        return job;
      }
    }
    const slot = await deps.reserveSlot(job.postId!, { mimeType: asset.mimeType, fileSizeBytes: size });
    if (!slot.ok) { await (slot.retryable ? pause(slot.message) : fail(slot.message)); return job; }
    await save({ stage: 'slot', mediaId: slot.data.mediaId, uploadUrl: slot.data.uploadUrl, fileSizeBytes: size });
  }

  // ── bytes ──────────────────────────────────────────────────────────────────
  if (job.stage === 'slot') {
    if (cancelled()) { await cancel(); return job; }
    let file: FileLike;
    try {
      file = await deps.readFile(asset.uri);
    } catch {
      // The local file is gone (the OS reclaimed the picker's cache copy). No
      // retry can bring it back; this is a refusal, not a pause.
      await fail('The original file is no longer on this device.');
      return job;
    }
    const slot = { postId: job.postId!, mediaId: job.mediaId! };
    let landed = false;
    if (deps.resumable.enabled && job.transport !== 'single') {
      if (job.transport !== 'resumable') await save({ transport: 'resumable' });
      const r = await uploadSlotResumable(
        slot, file, asset.mimeType, deps.resumable.transport,
        { ...deps.env, isCancelled: hooks.isCancelled },
        hooks.onProgress,
      );
      if (r.ok) landed = true;
      else if ('unsupported' in r && r.unsupported) await save({ transport: 'single' });
      else if (r.cancelled) { await cancel(); return job; }
      else if (r.retryable) { await pause(r.reason); return job; }
      else { await fail(r.reason); return job; }
    }
    if (!landed) {
      if (!job.uploadUrl) { await fail('No upload URL for this media slot.'); return job; }
      const put = await withRetry<true>(async () => {
        const r = await deps.putWhole(job.uploadUrl!, file, asset.mimeType, (f) => hooks.onProgress?.(f));
        if (r.ok) return { kind: 'done', value: true };
        // A signed-URL PUT that got NO answer, or a 5xx/408/429, is worth another try.
        const s = r.status ?? null;
        if (s == null || s === 408 || s === 429 || (s >= 500 && s <= 599)) return { kind: 'retry', reason: r.message ?? 'upload failed' };
        return { kind: 'fail', reason: r.message ?? `upload failed (HTTP ${s})`, status: s };
      }, { ...DEFAULT_RETRY, ...deps.env.retry, sleep: deps.env.sleep, random: deps.env.random, isCancelled: hooks.isCancelled });
      if (!put.ok) {
        if (put.cancelled) { await cancel(); return job; }
        // One PUT has no resume token: on the single transport a paused upload
        // restarts from byte 0 next run, which is exactly why the resumable
        // transport exists.
        if (put.retryable) { await pause(put.reason); return job; }
        await fail(put.reason);
        return job;
      }
    }
    hooks.onProgress?.(1);
    await save({ stage: 'bytes' });
  }

  // ── poster (video only; fail-soft) ─────────────────────────────────────────
  if (job.stage === 'bytes') {
    let thumbnailPath: string | null = null;
    if (asset.isVideo) {
      const frame = await deps.extractPoster(asset.uri).catch(() => null);
      if (frame) thumbnailPath = await deps.uploadPoster(job.postId!, job.mediaId!, frame).catch(() => null);
    }
    await save({ stage: 'poster', thumbnailPath });
  }

  // ── complete ───────────────────────────────────────────────────────────────
  if (job.stage === 'poster') {
    if (cancelled()) { await cancel(); return job; }
    const done = await deps.complete(job.postId!, job.mediaId!, {
      mimeType: asset.mimeType,
      fileSizeBytes: job.fileSizeBytes ?? asset.fileSizeBytes ?? 1,
      durationSeconds: asset.durationSeconds ?? undefined,
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
      thumbnailPath: job.thumbnailPath ?? undefined,
      stampOverlay: asset.isVideo ? undefined : job.input.stampOverlay,
    });
    if (!done.ok) { await (done.retryable ? pause(done.message) : fail(done.message)); return job; }
    await save({ stage: 'done', result: done.data });
  }
  return job;
}

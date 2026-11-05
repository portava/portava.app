/**
 * postcardUploadDevice — the real effects behind the postcard upload queue:
 * the API, storage, native file access and the OS background transfer.
 *
 * Loaded only by getPostcardUploadQueue(), which is only reached while
 * uploadTransportFlag is on. Everything that DECIDES anything lives in the
 * node-tested modules; this file wires them to the device and nothing more.
 */
import type { QueueRuntime } from './postcardUploadQueue.ts';
import type { ApiResult, PipelineDeps, PostcardUploadInput } from './postcardUploadPipeline.ts';
import type { FileLike } from './resumableUpload.ts';
import { apiCall, deviceResumableTransport, putPart, readFileBlob, uploadPoster } from './uploadHttp.ts';
import { backgroundFile, backgroundPartTransport, loadExpoFs, sweepStagedParts, type FsLike, type PartDescriptor, type StagedSweepResult } from './backgroundTransfer.ts';
import { extractVideoPoster } from './mediaProcessing.ts';
import { isResumableMediaUploadEnabled } from './uploadTransportFlag.ts';
import { captureObservedOwnerSnapshot } from '../observedOwnerSnapshot.ts';
import { onDiscoveryScopeChange } from '../discoveryViewerScope.ts';
import { createUploadLifetime, type UploadLifetime } from './uploadLifetime.ts';

function messageOf(body: unknown, status: number): string {
  const b = body as { message?: unknown; error?: unknown } | null;
  if (typeof b?.message === 'string' && b.message && b.message !== b.error) return b.message;
  if (typeof b?.error === 'string') return b.error;
  return `Something went wrong (HTTP ${status}). Please try again.`;
}

/** 2xx → data; no answer / 5xx / 408 / 429 → retryable; anything else → a refusal. */
async function call<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown,
  map: (b: Record<string, unknown>) => T | null,
  lifetime?: UploadLifetime,
): Promise<ApiResult<T>> {
  let r: Awaited<ReturnType<typeof apiCall>>;
  try {
    r = await apiCall(method, path, body, lifetime);
  } catch (e) {
    return { ok: false, retryable: true, message: e instanceof Error ? e.message : 'Network error' };
  }
  if (r.status >= 200 && r.status < 300) {
    const data = map((r.body ?? {}) as Record<string, unknown>);
    return data ? { ok: true, data } : { ok: false, message: 'Unexpected response from the server.' };
  }
  const retryable = r.status === 408 || r.status === 429 || r.status >= 500;
  return { ok: false, retryable, message: messageOf(r.body, r.status) };
}

function createShellBody(input: PostcardUploadInput): Record<string, unknown> {
  return {
    caption: input.caption,
    visibility: input.visibility,
    ...input.location,
    addToPassport: input.addToPassport,
  };
}

/** Whole-file PUT for the single-transport path: a background transfer when the OS can take it. */
async function putWholeFile(
  fs: FsLike | null,
  uploadUrl: string,
  file: FileLike,
  mimeType: string,
  onProgress: (f: number) => void,
  lifetime?: UploadLifetime,
): Promise<{ ok: boolean; status?: number | null; message?: string }> {
  try {
    if (fs) {
      const whole = file.slice(0, file.size) as PartDescriptor;
      const task = fs.createUploadTask(
        uploadUrl,
        whole.uri,
        { httpMethod: 'PUT', uploadType: fs.uploadBinary, sessionType: fs.sessionBackground, headers: { 'Content-Type': mimeType } },
        (p) => onProgress(p.totalBytesExpectedToSend > 0 ? p.totalBytesSent / p.totalBytesExpectedToSend : 0),
      );
      const res = await task.uploadAsync();
      if (!res) return { ok: false, status: null, message: 'Upload interrupted' };
      return { ok: res.status >= 200 && res.status < 300, status: res.status, message: `Upload failed (HTTP ${res.status})` };
    }
    const r = await putPart(uploadUrl, file.slice(0, file.size), mimeType, (bytes) => onProgress(bytes / file.size), lifetime);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, message: `Upload failed (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, status: null, message: e instanceof Error ? e.message : 'Network error during upload' };
  }
}

async function deviceDeps(accountId?: string, jobId?: string): Promise<Omit<PipelineDeps, 'persist'>> {
  // Capture before any lazy import. Never let a refresh attach a new account.
  const owner = captureObservedOwnerSnapshot();
  if (!owner || owner.ownerId !== accountId) throw new Error('Upload session unavailable');
  const lifetime = createUploadLifetime(owner, onDiscoveryScopeChange, jobId);
  const { supabase } = await import('../../lib/supabase.ts');
  const { data } = supabase.auth.onAuthStateChange(() => { if (!owner.isCurrent()) lifetime.cancel(); });
  let fs: FsLike | null;
  try { fs = await loadExpoFs(lifetime); }
  catch (error) { data.subscription.unsubscribe(); lifetime.dispose(); throw error; }
  // A cancelled user's pending shell may be removed under its ORIGINAL session.
  const cleanupLifetime = { ...lifetime, signal: new AbortController().signal };
  const transport = fs ? backgroundPartTransport((m, p, b) => apiCall(m, p, b, m === 'DELETE' ? cleanupLifetime : lifetime), fs) : deviceResumableTransport(lifetime);
  const slotPath = (postId: string, mediaId: string) =>
    `/api/postcards/${encodeURIComponent(postId)}/media/${encodeURIComponent(mediaId)}`;
  return {
    isCurrent: lifetime.isCurrent,
    isCancelled: () => lifetime.signal.aborted && lifetime.isCurrent(),
    cancel: lifetime.cancel,
    dispose: () => { data.subscription.unsubscribe(); lifetime.dispose(); },
    createShell: (input) =>
      call('POST', '/api/postcards', createShellBody(input), (b) => (typeof b.id === 'string' ? { id: b.id } : null), lifetime),
    reserveSlot: (postId, params) =>
      call('POST', `/api/postcards/${encodeURIComponent(postId)}/media/upload-url`, params, (b) =>
        typeof b.mediaId === 'string' && typeof b.uploadUrl === 'string' ? { mediaId: b.mediaId, uploadUrl: b.uploadUrl } : null, lifetime,
      ),
    readFile: async (uri) => (fs ? backgroundFile(uri, fs) : ((await readFileBlob(uri)) as unknown as FileLike)),
    resumable: { enabled: isResumableMediaUploadEnabled(), transport },
    putWhole: (url, file, mime, onProgress) => putWholeFile(fs, url, file, mime, onProgress, lifetime),
    extractPoster: extractVideoPoster,
    uploadPoster: (postId, mediaId, uri) => uploadPoster(postId, mediaId, uri, lifetime),
    complete: (postId, mediaId, params) =>
      call('POST', `${slotPath(postId, mediaId)}/complete`, params, (b) => ({
        stampOverlayApplied: typeof b.stampOverlayApplied === 'boolean' ? b.stampOverlayApplied : undefined,
        stampOverlayError: typeof b.stampOverlayError === 'string' ? b.stampOverlayError : undefined,
      }), lifetime),
    discardShell: async (postId) => {
      await apiCall('DELETE', `/api/posts/${encodeURIComponent(postId)}`, undefined, cleanupLifetime);
    },
    now: () => Date.now(),
    env: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random },
  };
}

export function deviceQueueRuntime(): QueueRuntime {
  const storage = async () => (await import('@react-native-async-storage/async-storage')).default;
  return {
    storage: {
      getItem: async (key) => (await storage()).getItem(key),
      setItem: async (key, value) => (await storage()).setItem(key, value), allKeys: async () => (await storage()).getAllKeys(), // §37.8: every account's jobs, for the staged-part sweep
    },
    accountId: async () => {
      const { getCurrentAccountId } = await import('../accountId.ts');
      return getCurrentAccountId();
    },
    newId: () => `pu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    now: () => Date.now(),
    deps: deviceDeps,
  };
}

/**
 * Resume the queue at launch and on every return to the foreground. No-op
 * while the transport flag is off: production keeps the composer's own upload.
 * Returns an unsubscribe.
 */
export function installPostcardUploadResume(appState: {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}): () => void {
  if (!isResumableMediaUploadEnabled()) return () => {};
  const kick = () => {
    void import('./postcardUploadQueue.ts').then(async ({ getPostcardUploadQueue }) => {
      const q = await getPostcardUploadQueue(); await sweepOrphanedStagedParts(); // §37.8: bounded, never throws, never deletes a resumable job's copy
      await q.resumePending();
    }).catch(() => {});
  };
  kick();
  const sub = appState.addEventListener('change', (state) => {
    if (state === 'active') kick();
  });
  return () => sub.remove();
}

/**
 * census-media §37.8 — at launch and on every foreground, before the queue
 * resumes: delete staged part copies that belong to no resumable upload
 * (backgroundTransfer.sweepStagedParts, which lists the cache first and reads
 * every account's live jobs second). Null when there is no native file system.
 * Never throws.
 */
export async function sweepOrphanedStagedParts(): Promise<StagedSweepResult | null> {
  try {
    const fs = await loadExpoFs();
    if (!fs) return null;
    const { storage } = deviceQueueRuntime();
    const { liveUploadOwners } = await import('./postcardUploadQueue.ts');
    return await sweepStagedParts(fs, () => liveUploadOwners(storage), Date.now());
  } catch {
    return null;
  }
}

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
import { backgroundFile, backgroundPartTransport, loadExpoFs, type FsLike, type PartDescriptor } from './backgroundTransfer.ts';
import { extractVideoPoster } from './mediaProcessing.ts';
import { isResumableMediaUploadEnabled } from './uploadTransportFlag.ts';

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
): Promise<ApiResult<T>> {
  let r: Awaited<ReturnType<typeof apiCall>>;
  try {
    r = await apiCall(method, path, body);
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
    const r = await putPart(uploadUrl, file.slice(0, file.size), mimeType, (bytes) => onProgress(bytes / file.size));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, message: `Upload failed (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, status: null, message: e instanceof Error ? e.message : 'Network error during upload' };
  }
}

async function deviceDeps(): Promise<Omit<PipelineDeps, 'persist'>> {
  const fs = await loadExpoFs();
  const transport = fs ? backgroundPartTransport((m, p, b) => apiCall(m, p, b), fs) : deviceResumableTransport();
  const slotPath = (postId: string, mediaId: string) =>
    `/api/postcards/${encodeURIComponent(postId)}/media/${encodeURIComponent(mediaId)}`;
  return {
    createShell: (input) =>
      call('POST', '/api/postcards', createShellBody(input), (b) => (typeof b.id === 'string' ? { id: b.id } : null)),
    reserveSlot: (postId, params) =>
      call('POST', `/api/postcards/${encodeURIComponent(postId)}/media/upload-url`, params, (b) =>
        typeof b.mediaId === 'string' && typeof b.uploadUrl === 'string' ? { mediaId: b.mediaId, uploadUrl: b.uploadUrl } : null,
      ),
    readFile: async (uri) => (fs ? backgroundFile(uri, fs) : ((await readFileBlob(uri)) as unknown as FileLike)),
    resumable: { enabled: isResumableMediaUploadEnabled(), transport },
    putWhole: (url, file, mime, onProgress) => putWholeFile(fs, url, file, mime, onProgress),
    extractPoster: extractVideoPoster,
    uploadPoster,
    complete: (postId, mediaId, params) =>
      call('POST', `${slotPath(postId, mediaId)}/complete`, params, (b) => ({
        stampOverlayApplied: typeof b.stampOverlayApplied === 'boolean' ? b.stampOverlayApplied : undefined,
        stampOverlayError: typeof b.stampOverlayError === 'string' ? b.stampOverlayError : undefined,
      })),
    discardShell: async (postId) => {
      const { discardPostcardShell } = await import('../postcards.ts');
      await discardPostcardShell(postId);
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
      setItem: async (key, value) => (await storage()).setItem(key, value),
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
      const q = await getPostcardUploadQueue();
      await q.resumePending();
    }).catch(() => {});
  };
  kick();
  const sub = appState.addEventListener('change', (state) => {
    if (state === 'active') kick();
  });
  return () => sub.remove();
}

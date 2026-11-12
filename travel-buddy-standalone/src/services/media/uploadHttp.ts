/**
 * uploadHttp — the device side of the postcard media transport: authenticated
 * API calls, part PUTs to signed Storage URLs (with byte progress), and the
 * video poster upload. Thin by design: every decision is made in the pure
 * modules (resumableUpload, postcardUploadPipeline, uploadRetry), which is
 * where the tests are. This file only moves bytes.
 *
 * Contract shared with ResumableTransport: an HTTP error STATUS is a value, not
 * an exception. Only "no answer at all" (network failure, abort) throws, so the
 * retry policy can tell a refusal from a dropped connection.
 */
import type { ResumableTransport } from './resumableUpload.ts';
import { extractVideoPoster } from './mediaProcessing.ts';
import { captureObservedOwnerSnapshot } from '../observedOwnerSnapshot.ts';
import { messagingOwnerToken } from '../messagingOwnerRequest.ts';
import type { UploadLifetime } from './uploadLifetime.ts';

function uploadApiUrl(path: string): string {
  const raw = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!raw || /[\s\\?#@]/.test(raw)) throw new Error('A secure upload API origin is required');
  const base = new URL(raw);
  if (base.protocol !== 'https:' || base.pathname !== '/' || !path.startsWith('/api/')) throw new Error('Invalid upload API endpoint');
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.hash || /[\\]/.test(path)) throw new Error('Invalid upload API endpoint');
  return url.href;
}

async function deadline<T>(work: () => Promise<T>, signal?: AbortSignal, ms = 30_000): Promise<T> {
  if (signal?.aborted) throw new Error('Upload interrupted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new Error('Upload interrupted'));
      signal?.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => reject(new Error('Upload timed out')), ms);
    });
    return await Promise.race([cancelled, work()]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

async function ownedToken(lifetime?: UploadLifetime) {
  const owner = lifetime?.owner ?? captureObservedOwnerSnapshot();
  if (!owner?.isCurrent()) throw new Error('Upload session changed');
  const token = await deadline(() => messagingOwnerToken(owner), lifetime?.signal);
  if (!token || !owner.isCurrent()) throw new Error('Upload session changed');
  return { token, owner };
}

async function boundedFetch(url: string, options: RequestInit, lifetime?: UploadLifetime, milliseconds = 30_000): Promise<{ status: number; ok: boolean; headers: Headers; body: unknown }> {
  if (lifetime && (!lifetime.isCurrent() || lifetime.signal.aborted)) throw new Error('Upload interrupted');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, milliseconds);
  lifetime?.signal.addEventListener('abort', abort);
  try {
    const response = await deadline(() => fetch(url, { ...options, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal }), controller.signal, milliseconds);
    if (response.redirected || response.url && response.url !== url) throw new Error('Upload API redirected');
    const body: unknown = await deadline(() => response.json(), controller.signal, milliseconds).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof Error && /interrupted|timed out/.test(error.message)) throw error;
      return null;
    });
    if (controller.signal.aborted) throw new Error('Upload request interrupted');
    return { status: response.status, ok: response.ok, headers: response.headers, body };
  }
  finally { clearTimeout(timer); lifetime?.signal.removeEventListener('abort', abort); }
}

/** An authenticated JSON call to the API. Throws only when no response arrived. */
export async function apiCall(
  method: 'POST' | 'DELETE' | 'GET',
  path: string,
  body?: unknown,
  lifetime?: UploadLifetime,
): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const endpoint = uploadApiUrl(path);
  const { token, owner } = await ownedToken(lifetime);
  if (!owner.isCurrent()) throw new Error('Upload session changed');
  const res = await boundedFetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, lifetime);
  if (!owner.isCurrent()) throw new Error('Upload session changed');
  return { status: res.status, body: res.body, retryAfter: res.headers.get('retry-after') };
}

/** PUT one part (a Blob slice) to a signed Storage URL, reporting bytes sent. */
export function putPart(
  url: string,
  part: unknown,
  contentType: string,
  onSent?: (bytes: number) => void,
  lifetime?: UploadLifetime,
): Promise<{ status: number; retryAfter: string | null }> {
  return new Promise((resolve, reject) => {
    if (lifetime && (!lifetime.isCurrent() || lifetime.signal.aborted)) { reject(new Error('Upload interrupted')); return; }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.addEventListener('loadend', () => lifetime?.signal.removeEventListener('abort', abort));
    lifetime?.signal.addEventListener('abort', abort);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onSent?.(e.loaded);
    });
    xhr.onload = () => resolve({ status: xhr.status, retryAfter: xhr.getResponseHeader('retry-after') });
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.open('PUT', url);
    xhr.timeout = 15 * 60_000;
    xhr.setRequestHeader('Content-Type', contentType);
    // x-upsert: a re-sent part REPLACES a partial one (the session signs with upsert too).
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.send(part as Blob);
  });
}

/** The device's ResumableTransport. */
export function deviceResumableTransport(lifetime?: UploadLifetime): ResumableTransport {
  return {
    api: (method, path, body) => apiCall(method, path, body, lifetime),
    putPart: (url, part, type, progress) => putPart(url, part, type, progress, lifetime),
  };
}

/** Read a local file uri into a Blob (size known; slices are native, not JS-heap copies). */
export async function readFileBlob(uri: string): Promise<Blob> {
  const res = await fetch(uri);
  return res.blob();
}

/**
 * Upload a device-extracted poster frame for a reserved VIDEO slot. The server
 * re-encodes it (no EXIF), stores it at a path it derives from the slot, and
 * returns that path — the only thumbnailPath /complete will accept.
 * Returns null on any failure: a missing poster never blocks the post.
 */
export async function uploadPoster(postId: string, mediaId: string, posterUri: string, lifetime?: UploadLifetime): Promise<string | null> {
  try {
    const endpoint = uploadApiUrl(`/api/postcards/${encodeURIComponent(postId)}/media/${encodeURIComponent(mediaId)}/poster`);
    const { token, owner } = await ownedToken(lifetime);
    const blob = await readFileBlob(posterUri);
    if (!owner.isCurrent()) return null;
    const res = await boundedFetch(
      endpoint,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: blob }, lifetime, 120_000,
    );
    if (!res.ok || !owner.isCurrent()) return null;
    const body = res.body as { thumbnailPath?: unknown } | null;
    return typeof body?.thumbnailPath === 'string' ? body.thumbnailPath : null;
  } catch {
    return null;
  }
}

/**
 * §37 "Thumbnail generation" for a video postcard, in one call: extract a frame
 * on the device, upload it for the reserved slot, and return the path the
 * server derived — the value to hand /complete as `thumbnailPath`. Null on any
 * failure; a video without a poster still posts, as every video did before.
 */
export async function uploadVideoPoster(postId: string, mediaId: string, videoUri: string): Promise<string | null> {
  const frame = await extractVideoPoster(videoUri);
  if (!frame) return null;
  return uploadPoster(postId, mediaId, frame);
}

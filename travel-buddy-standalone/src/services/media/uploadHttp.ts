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

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function bearer(): Promise<string | null> {
  const { freshToken } = await import('../apiToken.ts');
  return freshToken();
}

/** An authenticated JSON call to the API. Throws only when no response arrived. */
export async function apiCall(
  method: 'POST' | 'DELETE' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const token = await bearer();
  if (!token) return { status: 401, body: { error: 'unauthenticated' }, retryAfter: null };
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, retryAfter: res.headers.get('retry-after') };
}

/** PUT one part (a Blob slice) to a signed Storage URL, reporting bytes sent. */
export function putPart(
  url: string,
  part: unknown,
  contentType: string,
  onSent?: (bytes: number) => void,
): Promise<{ status: number; retryAfter: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onSent?.(e.loaded);
    });
    xhr.onload = () => resolve({ status: xhr.status, retryAfter: xhr.getResponseHeader('retry-after') });
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    // x-upsert: a re-sent part REPLACES a partial one (the session signs with upsert too).
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.send(part as Blob);
  });
}

/** The device's ResumableTransport. */
export function deviceResumableTransport(): ResumableTransport {
  return {
    api: (method, path, body) => apiCall(method, path, body),
    putPart,
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
export async function uploadPoster(postId: string, mediaId: string, posterUri: string): Promise<string | null> {
  try {
    const token = await bearer();
    if (!token) return null;
    const blob = await readFileBlob(posterUri);
    const res = await fetch(
      `${apiBase()}/api/postcards/${encodeURIComponent(postId)}/media/${encodeURIComponent(mediaId)}/poster`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: blob },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { thumbnailPath?: unknown } | null;
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

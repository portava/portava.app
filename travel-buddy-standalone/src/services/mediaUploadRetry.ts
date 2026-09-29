/**
 * mediaUploadRetry — find an owner's failed uploads and retry them
 * (testing-mode WP-17, flow MED-F25).
 *
 *   GET  /api/media/me/failed-uploads  the caller's own assets whose processing failed
 *   POST /api/media/:assetId/retry     re-queue one of them (a `media_assets.id`)
 *
 * A failed read is `{ ok: false }` — never an empty list, which would tell the
 * owner none of their uploads failed. `retryAvailable` is the server's word on
 * whether a retry can be queued now (the processing worker is on); when it is
 * false the client says so instead of offering a button that is refused.
 */
import { freshToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export interface FailedUpload {
  id: string;
  mediaType: 'image' | 'video';
  thumbnailUrl: string | null;
  createdAt: string | null;
}

export type UploadRetryError = 'not_configured' | 'unauthenticated' | 'network' | 'server' | 'not_retryable' | 'unavailable' | 'not_found' | 'rate_limited';

export type UploadRetryResult<T> = { ok: true; data: T } | { ok: false; error: UploadRetryError; message?: string };

async function call(method: 'GET' | 'POST', path: string): Promise<{ ok: true; status: number; json: Record<string, unknown> } | { ok: false; error: UploadRetryError; message?: string }> {
  if (!apiBase()) return { ok: false, error: 'not_configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return { ok: false, error: 'network' };
  }
  const json = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (res.ok) return { ok: true, status: res.status, json };
  const code = typeof json.error === 'string' ? json.error : '';
  const message = typeof json.message === 'string' ? json.message : undefined;
  const error: UploadRetryError =
    res.status === 401 ? 'unauthenticated'
      : code === 'invalid_state_transition' ? 'not_retryable'
        : code === 'feature_disabled' ? 'unavailable'
          : code === 'not_found' ? 'not_found'
            : code === 'rate_limited' ? 'rate_limited'
              : 'server';
  return { ok: false, error, message };
}

export async function fetchFailedUploads(): Promise<UploadRetryResult<{ items: FailedUpload[]; retryAvailable: boolean }>> {
  const r = await call('GET', '/api/media/me/failed-uploads');
  if (!r.ok) return r;
  if (!Array.isArray(r.json.items)) return { ok: false, error: 'server', message: 'The server sent an unreadable answer.' };
  const items: FailedUpload[] = [];
  for (const raw of r.json.items as unknown[]) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    items.push({
      id: o.id,
      mediaType: o.mediaType === 'video' ? 'video' : 'image',
      thumbnailUrl: typeof o.thumbnailUrl === 'string' ? o.thumbnailUrl : null,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : null,
    });
  }
  return { ok: true, data: { items, retryAvailable: r.json.retryAvailable === true } };
}

export async function retryFailedUpload(assetId: string): Promise<UploadRetryResult<{ alreadyQueued: boolean }>> {
  const r = await call('POST', `/api/media/${encodeURIComponent(assetId)}/retry`);
  if (!r.ok) return r;
  return { ok: true, data: { alreadyQueued: r.json.alreadyQueued === true } };
}

/** Owner-facing copy for a refused or failed retry. */
export function retryErrorCopy(error: UploadRetryError): string {
  switch (error) {
    case 'network': return 'Check your connection and try again.';
    case 'not_retryable': return 'This upload is no longer in a failed state, so there is nothing to retry.';
    case 'unavailable': return 'Retrying uploads is not available right now.';
    case 'not_found': return 'This upload could not be found.';
    case 'rate_limited': return 'Too many retries — wait a minute and try again.';
    case 'unauthenticated': return 'Sign in again to retry.';
    default: return 'Portava could not retry this upload right now. Please try again.';
  }
}

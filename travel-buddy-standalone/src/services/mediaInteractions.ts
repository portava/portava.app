/**
 * mediaInteractions — API calls for media like, save, share, report, and
 * owner controls (visibility change, delete).
 *
 * All mutations go through the API server (bearer token auth).
 * Never calls Supabase directly.
 */
import { freshToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('err_address_unreachable') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

export interface MediaActionResult {
  ok: boolean;
  data?: Record<string, unknown>;
  message?: string;
  errorKind?: string;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: object,
): Promise<MediaActionResult> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated', errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: (json as any)?.message ?? `HTTP ${res.status}`, errorKind: (json as any)?.error };
    }
    return { ok: true, data: json };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, message: 'Network error', errorKind: 'network' };
    return { ok: false, message: e instanceof Error ? e.message : 'Unknown error', errorKind: 'unknown' };
  }
}

// ── Like ─────────────────────────────────────────────────────────────────────

export async function likeMedia(mediaId: string): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/like`);
}

export async function unlikeMedia(mediaId: string): Promise<MediaActionResult> {
  return call('DELETE', `/api/media/${encodeURIComponent(mediaId)}/like`);
}

// ── Save ─────────────────────────────────────────────────────────────────────

export async function saveMedia(mediaId: string): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/save`);
}

export async function unsaveMedia(mediaId: string): Promise<MediaActionResult> {
  return call('DELETE', `/api/media/${encodeURIComponent(mediaId)}/save`);
}

// ── Share ─────────────────────────────────────────────────────────────────────

export async function recordMediaShare(
  mediaId: string,
  target: 'native' | 'copy_link' | 'telegraph',
): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/share`, { target });
}

// ── Report ────────────────────────────────────────────────────────────────────

export async function reportMedia(
  mediaId: string,
  reason: string,
  notes?: string,
): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/report`, { reason, notes });
}

// ── Owner: visibility change ──────────────────────────────────────────────────

/**
 * Owner-only visibility change.
 *
 * The accepted set mirrors the server schema, which mirrors the column: only
 * labels of the `post_visibility` enum can be written. 'friends' is not one —
 * it was accepted here and by the route, and rejected by Postgres every single
 * time (22P02 → db_error).
 */
export async function updateMediaVisibility(
  mediaId: string,
  visibility: 'public' | 'private',
): Promise<MediaActionResult> {
  return call('PATCH', `/api/media/${encodeURIComponent(mediaId)}`, { visibility });
}

// ── Owner: delete ─────────────────────────────────────────────────────────────

export async function deleteMedia(mediaId: string): Promise<MediaActionResult> {
  return call('DELETE', `/api/media/${encodeURIComponent(mediaId)}`);
}

// ── Not Interested / Hide ─────────────────────────────────────────────────────

export async function hideMedia(mediaId: string): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/report`, {
    reason: 'not_interested',
  });
}

// ── Stamp It reaction ─────────────────────────────────────────────────────────

/**
 * Record a "Stamp It" long-press reaction on a Watch feed media item.
 *
 * Uses the dedicated POST /api/media/:id/react endpoint which writes to
 * media_stamp_reactions — separate from the post_reactions ❤️ like row so the
 * two gestures never conflict. Idempotent server-side.
 *
 * Fail-soft: returns { ok: false } on any network or auth error so the caller
 * can safely ignore the result without crashing.
 */
export async function reactToMediaStampIt(mediaId: string): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/react`);
}
